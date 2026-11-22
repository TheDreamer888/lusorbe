"""Planos e pagamentos: a Stripe decide o plano, só por webhooks assinados."""
import os

os.environ["ENV"] = "development"
os.environ.setdefault("SESSION_JWT_SECRET", "x" * 40)
os.environ["PUBLIC_FRONTEND_URL"] = "http://localhost:5173"

import json
import time
from types import SimpleNamespace

import pytest
import stripe
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("SESSION_ENC_KEY", Fernet.generate_key().decode())

from src.app import assistant, billing
from src.app.auth import routes as auth_routes
from src.app.auth.store import store
from src.app.auth.tokens import SESSION_COOKIE_NAME, issue_session_token

app = FastAPI()
app.include_router(billing.router)
app.include_router(assistant.router)
ORIGIN = {"Origin": "http://localhost:5173"}
SECRET = "whsec_test_not_real"


class FakeStripe:
    """Imita só o que a Lusorbe usa. A verificação da assinatura é a verdadeira da Stripe."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.subscriptions: dict[str, SimpleNamespace] = {}
        self.error: Exception | None = None
        ns = SimpleNamespace
        self.v1 = ns(
            prices=ns(retrieve=self._price),
            checkout=ns(sessions=ns(create=self._checkout)),
            billing_portal=ns(sessions=ns(create=self._portal)),
            subscriptions=ns(retrieve=self._subscription),
        )

    def _price(self, price_id):
        self.calls.append(("price", price_id))
        return SimpleNamespace(unit_amount=499, currency="eur", recurring=SimpleNamespace(interval="month"))

    def _checkout(self, params):
        self.calls.append(("checkout", params))
        if self.error:
            raise self.error
        return SimpleNamespace(url="https://checkout.stripe.com/c/pay/cs_test_1")

    def _portal(self, params):
        self.calls.append(("portal", params))
        return SimpleNamespace(url="https://billing.stripe.com/p/session/test_1")

    def _subscription(self, sub_id):
        self.calls.append(("subscription", sub_id))
        return self.subscriptions[sub_id]

    def construct_event(self, payload, sig_header, secret):
        return stripe.Webhook.construct_event(payload, sig_header, secret)


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_not_real")
    monkeypatch.setenv("STRIPE_PRICE_PRO", "price_test_pro")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", SECRET)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    monkeypatch.setenv("ASSISTANT_DAILY_LIMIT", "2")
    monkeypatch.setenv("ASSISTANT_PRO_DAILY_LIMIT", "5")
    client = FakeStripe()
    billing.set_client(client)
    store.clear()
    auth_routes.limiter.clear()
    yield client
    billing.set_client(None)


def _login(email="ana@example.com"):
    user = store.get_or_create_oauth_user("google", f"sub-{email}", email, "Ana", True)
    c = TestClient(app)
    c.cookies.set(SESSION_COOKIE_NAME, issue_session_token(user.id, ["oauth"]))
    return c, user


def _signed(event: dict, secret: str = SECRET) -> tuple[str, dict]:
    payload = json.dumps(event)
    t = int(time.time())
    sig = stripe.WebhookSignature._compute_signature(f"{t}.{payload}", secret)
    return payload, {"stripe-signature": f"t={t},v1={sig}", "content-type": "application/json"}


def _event(kind: str, obj: dict) -> dict:
    return {"id": "evt_test", "object": "event", "type": kind, "data": {"object": obj}}


def _sub(sub_id="sub_1", status="active", customer="cus_1"):
    return SimpleNamespace(id=sub_id, status=status, customer=customer)


def test_planos_publicos_com_preco_da_stripe(fake):
    r = TestClient(app).get("/api/billing/plans")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is True
    pro = next(p for p in body["plans"] if p["id"] == "pro")
    assert pro["price"] == {"amount": 499, "currency": "eur", "interval": "month"}
    assert pro["assistant_daily_limit"] == 5
    # O preço fica em cache: a segunda leitura não volta à Stripe.
    TestClient(app).get("/api/billing/plans")
    assert [c for c in fake.calls if c[0] == "price"] == [("price", "price_test_pro")]


def test_sem_chaves_pro_indisponivel(fake, monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY")
    body = TestClient(app).get("/api/billing/plans").json()
    assert body["enabled"] is False
    assert next(p for p in body["plans"] if p["id"] == "pro")["available"] is False
    c, _ = _login()
    assert c.post("/api/billing/checkout", headers=ORIGIN).status_code == 503


def test_checkout_exige_sessao_e_origem(fake):
    assert TestClient(app).post("/api/billing/checkout", headers=ORIGIN).status_code == 401
    c, _ = _login()
    assert c.post("/api/billing/checkout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert fake.calls == []


def test_checkout_cria_sessao_ligada_a_conta(fake):
    c, user = _login()
    r = c.post("/api/billing/checkout", headers=ORIGIN)
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://checkout.stripe.com/c/pay/cs_test_1"}
    params = fake.calls[-1][1]
    assert params["mode"] == "subscription"
    assert params["client_reference_id"] == user.id
    assert params["subscription_data"] == {"metadata": {"user_id": user.id}}
    assert params["customer_email"] == "ana@example.com"
    assert params["success_url"].startswith("http://localhost:5173/#plans")


def test_erro_da_stripe_nao_vaza_detalhes(fake):
    fake.error = stripe.APIConnectionError("ligação recusada a api.stripe.com com sk_test_secreto")
    c, _ = _login()
    r = c.post("/api/billing/checkout", headers=ORIGIN)
    assert r.status_code == 502
    assert "sk_test" not in r.text and "stripe.com" not in r.text


def test_webhook_sem_assinatura_valida_e_rejeitado(fake):
    _, user = _login()
    payload, headers = _signed(_event("checkout.session.completed", {"id": "cs_1", "object": "checkout.session", "client_reference_id": user.id, "subscription": "sub_1"}), secret="whsec_outro")
    fake.subscriptions["sub_1"] = _sub()
    r = TestClient(app).post("/api/billing/webhook", content=payload, headers=headers)
    assert r.status_code == 400
    assert store.get_user(user.id).plan == "free"


def test_checkout_concluido_ativa_pro_e_aumenta_o_limite(fake):
    c, user = _login()
    fake.subscriptions["sub_1"] = _sub()
    payload, headers = _signed(_event("checkout.session.completed", {"id": "cs_1", "object": "checkout.session", "client_reference_id": user.id, "subscription": "sub_1"}))
    r = TestClient(app).post("/api/billing/webhook", content=payload, headers=headers)
    assert r.status_code == 200, r.text
    saved = store.get_user(user.id)
    assert saved.plan == "pro"
    assert saved.billing["customer_id"] == "cus_1"
    me = c.get("/api/billing/me").json()
    assert me == {"plan": "pro", "status": "active", "can_manage": True, "assistant_daily_limit": 5}
    assert c.get("/api/assistant/status").json()["daily_limit"] == 5
    # Já é Pro: não abre outro checkout.
    assert c.post("/api/billing/checkout", headers=ORIGIN).status_code == 409


def test_cancelamento_volta_a_gratis_mesmo_com_evento_antigo(fake):
    _, user = _login()
    fake.subscriptions["sub_1"] = _sub()
    for kind in ("customer.subscription.created",):
        payload, headers = _signed(_event(kind, {"id": "sub_1", "object": "subscription", "metadata": {"user_id": user.id}}))
        TestClient(app).post("/api/billing/webhook", content=payload, headers=headers)
    assert store.get_user(user.id).plan == "pro"
    # A subscrição foi cancelada na Stripe; chega depois um "updated" antigo: vale o estado atual.
    fake.subscriptions["sub_1"] = _sub(status="canceled")
    payload, headers = _signed(_event("customer.subscription.updated", {"id": "sub_1", "object": "subscription", "status": "active", "metadata": {"user_id": user.id}}))
    assert TestClient(app).post("/api/billing/webhook", content=payload, headers=headers).status_code == 200
    assert store.get_user(user.id).plan == "free"


def test_portal_so_com_subscricao(fake):
    c, user = _login()
    assert c.post("/api/billing/portal", headers=ORIGIN).status_code == 404
    user = store.get_user(user.id)
    user.billing = {"customer_id": "cus_1"}
    store.save(user)
    r = c.post("/api/billing/portal", headers=ORIGIN)
    assert r.status_code == 200
    assert fake.calls[-1] == ("portal", {"customer": "cus_1", "return_url": "http://localhost:5173/#plans"})


def test_conta_gratis_mantem_limite_gratis(fake):
    c, _ = _login()
    assert c.get("/api/billing/me").json()["plan"] == "free"
    assert c.get("/api/assistant/status").json()["daily_limit"] == 2
