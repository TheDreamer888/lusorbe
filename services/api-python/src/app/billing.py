"""Planos Grátis e Pro, pagos com a Stripe.

Regras que este módulo garante:

* **A Stripe é a fonte da verdade.** O plano de uma conta só muda por um
  webhook assinado pela Stripe (``STRIPE_WEBHOOK_SECRET``). Em cada evento de
  subscrição, a API volta a ler a subscrição na Stripe e aplica o estado atual,
  por isso eventos repetidos ou fora de ordem não estragam nada.
* **Nada de dados de cartão aqui.** O pagamento acontece na página da Stripe
  (Checkout) e a gestão no Portal do Cliente da Stripe. A Lusorbe guarda só o
  identificador do cliente, o da subscrição, o estado e o plano.
* **Só com conta.** Criar um checkout ou abrir o portal exige sessão e Origin
  da própria app. Os planos (``GET /plans``) são públicos, para a landing.
* **Desligado sem chaves.** Sem ``STRIPE_SECRET_KEY`` e ``STRIPE_PRICE_PRO`` o
  Pro aparece como indisponível e as rotas de pagamento respondem 503.
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from src.app.auth import routes as auth_routes
from src.app.auth.store import ConcurrentUpdate, UserRecord, store
from src.pylibrary.logging import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/billing", tags=["billing"])

# Estados da Stripe em que a pessoa mantém o Pro. Em "past_due" a Stripe ainda
# está a tentar cobrar; se falhar de vez, a subscrição passa a "canceled" ou
# "unpaid" e o plano volta a Grátis.
PRO_STATUSES = {"active", "trialing", "past_due"}


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def enabled() -> bool:
    return bool(_env("STRIPE_SECRET_KEY") and _env("STRIPE_PRICE_PRO"))


def free_daily_limit() -> int:
    return max(1, int(os.getenv("ASSISTANT_DAILY_LIMIT", "30")))


def pro_daily_limit() -> int:
    return max(1, int(os.getenv("ASSISTANT_PRO_DAILY_LIMIT", "300")))


def plan_of(user: UserRecord) -> Literal["free", "pro"]:
    return "pro" if user.plan == "pro" else "free"


def assistant_daily_limit(user: UserRecord) -> int:
    return pro_daily_limit() if plan_of(user) == "pro" else free_daily_limit()


_client: Any = None


def get_client() -> Any:
    """Cliente Stripe partilhado (os testes substituem-no com `set_client`)."""
    global _client
    if _client is None:
        _client = stripe.StripeClient(_env("STRIPE_SECRET_KEY"), max_network_retries=2)
    return _client


def set_client(client: Any) -> None:
    global _client, _price_cache
    _client = client
    _price_cache = None


def _frontend_url(fragment: str) -> str:
    base = os.getenv("PUBLIC_FRONTEND_URL", "http://localhost:5173").rstrip("/")
    return f"{base}/#{fragment}"


# ---------- Esquemas ----------


class PlanPrice(BaseModel):
    amount: int = Field(description="Valor em cêntimos.")
    currency: str
    interval: str | None = None


class Plan(BaseModel):
    id: Literal["free", "pro"]
    assistant_daily_limit: int
    price: PlanPrice | None = None
    available: bool


class PlansResponse(BaseModel):
    enabled: bool
    plans: list[Plan]


class MyPlan(BaseModel):
    plan: Literal["free", "pro"]
    status: str | None = None
    can_manage: bool
    assistant_daily_limit: int


class RedirectUrl(BaseModel):
    url: str


# ---------- Preço (lido da Stripe, com cache) ----------

_price_cache: tuple[float, PlanPrice | None] | None = None
_price_lock = threading.Lock()


def _pro_price() -> PlanPrice | None:
    """Preço do Pro tal como está na Stripe. Uma hora em cache; `None` se falhar."""
    global _price_cache
    if not enabled():
        return None
    with _price_lock:
        if _price_cache and _price_cache[0] > time.time():
            return _price_cache[1]
        try:
            p = get_client().v1.prices.retrieve(_env("STRIPE_PRICE_PRO"))
            recurring = getattr(p, "recurring", None)
            price = PlanPrice(
                amount=int(p.unit_amount),
                currency=str(p.currency),
                interval=getattr(recurring, "interval", None) if recurring else None,
            )
        except stripe.StripeError as exc:
            logger.error(f"billing: não foi possível ler o preço ({type(exc).__name__})")
            price = None
        _price_cache = (time.time() + 3600, price)
        return price


# ---------- Aplicar o estado da subscrição ----------


def _apply_subscription(user_id: str, subscription: Any) -> None:
    """Grava na conta o estado atual da subscrição (com nova tentativa se houver conflito)."""
    status = str(getattr(subscription, "status", "") or "")
    customer = getattr(subscription, "customer", None)
    customer_id = customer if isinstance(customer, str) else getattr(customer, "id", None)
    for _ in range(3):
        user = store.get_user(user_id)
        if user is None:
            logger.warning("billing: evento para uma conta que já não existe")
            return
        user.plan = "pro" if status in PRO_STATUSES else "free"
        user.billing = {
            "customer_id": customer_id or (user.billing or {}).get("customer_id"),
            "subscription_id": getattr(subscription, "id", None),
            "status": status,
            "updated_at": time.time(),
        }
        try:
            store.save(user)
            logger.info(f"billing: plano atualizado para {user.plan} ({status})")
            return
        except ConcurrentUpdate:
            continue
    raise HTTPException(503, "Conflito ao atualizar o plano. A Stripe vai tentar de novo.")


def _metadata_user(obj: Any) -> str | None:
    """`metadata.user_id` de um objeto da Stripe (um StripeObject não tem `.get`)."""
    metadata = getattr(obj, "metadata", None)
    if not metadata:
        return None
    try:
        value = metadata["user_id"]
    except (KeyError, TypeError):
        return None
    return value if isinstance(value, str) and value else None


# ---------- Rotas ----------


@router.get("/plans", response_model=PlansResponse)
def plans() -> PlansResponse:
    on = enabled()
    return PlansResponse(
        enabled=on,
        plans=[
            Plan(id="free", assistant_daily_limit=free_daily_limit(), price=PlanPrice(amount=0, currency="eur"), available=True),
            Plan(id="pro", assistant_daily_limit=pro_daily_limit(), price=_pro_price(), available=on),
        ],
    )


@router.get("/me", response_model=MyPlan)
def my_plan(user: UserRecord = Depends(auth_routes._require_user)) -> MyPlan:
    billing = user.billing or {}
    return MyPlan(
        plan=plan_of(user),
        status=billing.get("status"),
        can_manage=enabled() and bool(billing.get("customer_id")),
        assistant_daily_limit=assistant_daily_limit(user),
    )


@router.post("/checkout", response_model=RedirectUrl, dependencies=[Depends(auth_routes._require_same_origin)])
def checkout(user: UserRecord = Depends(auth_routes._require_user)) -> RedirectUrl:
    if not enabled():
        raise HTTPException(503, "Os pagamentos ainda não estão disponíveis.")
    if plan_of(user) == "pro":
        raise HTTPException(409, "Esta conta já tem o plano Pro.")
    retry = auth_routes.limiter.hit(f"billing:checkout:{user.id}", limit=10, window_seconds=3600)
    if retry is not None:
        raise HTTPException(429, "Demasiadas tentativas. Tenta mais tarde.", headers={"Retry-After": str(retry)})

    customer_id = (user.billing or {}).get("customer_id")
    params: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": _env("STRIPE_PRICE_PRO"), "quantity": 1}],
        "client_reference_id": user.id,
        "metadata": {"user_id": user.id},
        "subscription_data": {"metadata": {"user_id": user.id}},
        "success_url": _frontend_url("plans?checkout=success"),
        "cancel_url": _frontend_url("plans?checkout=cancel"),
        "allow_promotion_codes": True,
    }
    if customer_id:
        params["customer"] = customer_id
    elif user.email:
        params["customer_email"] = user.email
    try:
        session = get_client().v1.checkout.sessions.create(params=params)
    except stripe.StripeError as exc:
        logger.error(f"billing: falha ao criar checkout ({type(exc).__name__})")
        raise HTTPException(502, "Não foi possível abrir o pagamento. Tenta de novo.")
    return RedirectUrl(url=session.url)


@router.post("/portal", response_model=RedirectUrl, dependencies=[Depends(auth_routes._require_same_origin)])
def portal(user: UserRecord = Depends(auth_routes._require_user)) -> RedirectUrl:
    if not enabled():
        raise HTTPException(503, "Os pagamentos ainda não estão disponíveis.")
    customer_id = (user.billing or {}).get("customer_id")
    if not customer_id:
        raise HTTPException(404, "Esta conta ainda não tem uma subscrição para gerir.")
    try:
        session = get_client().v1.billing_portal.sessions.create(
            params={"customer": customer_id, "return_url": _frontend_url("plans")}
        )
    except stripe.StripeError as exc:
        logger.error(f"billing: falha ao abrir o portal ({type(exc).__name__})")
        raise HTTPException(502, "Não foi possível abrir a gestão da subscrição. Tenta de novo.")
    return RedirectUrl(url=session.url)


@router.post("/webhook", include_in_schema=False)
async def webhook(request: Request) -> dict[str, bool]:
    secret = _env("STRIPE_WEBHOOK_SECRET")
    if not enabled() or not secret:
        raise HTTPException(503, "Webhook desligado.")
    payload = await request.body()
    if len(payload) > 1_000_000:
        raise HTTPException(413, "Pedido demasiado grande.")
    try:
        event = get_client().construct_event(payload, request.headers.get("stripe-signature"), secret)
    except (ValueError, stripe.SignatureVerificationError):
        raise HTTPException(400, "Assinatura inválida.")

    obj = event.data.object
    kind = event.type
    if kind == "checkout.session.completed":
        user_id = getattr(obj, "client_reference_id", None) or _metadata_user(obj)
        sub_id = getattr(obj, "subscription", None)
        sub_id = sub_id if isinstance(sub_id, str) else getattr(sub_id, "id", None)
        if user_id and sub_id:
            _apply_subscription(user_id, get_client().v1.subscriptions.retrieve(sub_id))
    elif kind in {"customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"}:
        user_id = _metadata_user(obj)
        if user_id:
            # Lê o estado atual na Stripe: um evento antigo que chegue tarde não anula um mais recente.
            _apply_subscription(user_id, get_client().v1.subscriptions.retrieve(obj.id))
    return {"received": True}
