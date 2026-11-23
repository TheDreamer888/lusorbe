# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões: [SemVer](https://semver.org/lang/pt-BR/).

## [Por lançar]

### Adicionado
- `assistant.status()` e `assistant.send()`: assistente opcional (exige sessão, limite diário por conta).
  Modelos `ChatMessage`, `AssistantReply` e `AssistantStatus`.
- `assistant.send()` aceita `skill` (habilidade, ex.: `'matematica'`) e `language` (BCP 47).
  `AssistantStatus` traz `skills` e `languages`; novos tipos `AssistantSkill`, `AssistantLanguage` e `AssistantSkillId`.

- `billing.plans()`, `billing.me()`, `billing.checkout()` e `billing.portal()`: planos Grátis e Pro com a Stripe.
  Modelos `Plan`, `PlanPrice`, `PlansResponse`, `MyPlan` e `RedirectUrl`.

- `assistant.stream()`: a resposta do assistente chega aos bocados (`for await`), com `AssistantStreamEvent`;
  cancelar o `abortSignal` fecha o pedido ao modelo. Pipeline aceita `responseType: 'stream'`.

## [0.1.0] — 2026-11-17

### Adicionado
- `LusorbeClient` com as áreas `auth`, `waitlist` e `admin` (32 operações).
- Tipos gerados a partir do contrato OpenAPI da API.
- Erros tipados: `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`,
  `ValidationError` (com `fields`), `RateLimitError` (com `retryAfterSeconds`), `ServerError`,
  `ConnectionError`, `TimeoutError` e `AbortError`.
- Novas tentativas com espera exponencial e `Retry-After`; nunca repete POST após falha a meio.
- Tempo limite por tentativa e cancelamento com `AbortSignal`.
- Paginação `for await` e `byPage()` para `admin.users.list()`.
- Downloads CSV como `Blob` (`admin.audit.export()`, `admin.waitlist.export()`).
- Hooks `onRequest`/`onResponse` e `logger` sem dados pessoais.
