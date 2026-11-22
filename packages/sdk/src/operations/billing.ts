import type { MyPlan, PlansResponse, RedirectUrl } from '../models.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

/**
 * Planos Grátis e Pro. O pagamento e a gestão da subscrição acontecem nas
 * páginas da Stripe: estas operações só devolvem o endereço para onde ir.
 *
 * Erros comuns: `AuthenticationError` (sem sessão), `ConflictError` (já é Pro),
 * `NotFoundError` (ainda sem subscrição para gerir), `ServerError` com 503
 * (pagamentos ainda não configurados no servidor).
 */
export class BillingOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Planos disponíveis, com o preço do Pro tal como está na Stripe. Não exige sessão. */
  plans(options?: OperationOptions): Promise<PlansResponse> {
    return this.http.send({ method: 'GET', path: '/api/billing/plans', options })
  }

  /** O plano da conta com sessão iniciada e o limite diário do assistente. */
  me(options?: OperationOptions): Promise<MyPlan> {
    return this.http.send({ method: 'GET', path: '/api/billing/me', options })
  }

  /** Cria um checkout da Stripe para o Pro e devolve o endereço da página de pagamento. */
  checkout(options?: OperationOptions): Promise<RedirectUrl> {
    return this.http.send({ method: 'POST', path: '/api/billing/checkout', options })
  }

  /** Abre o portal da Stripe para mudar o cartão, ver faturas ou cancelar. */
  portal(options?: OperationOptions): Promise<RedirectUrl> {
    return this.http.send({ method: 'POST', path: '/api/billing/portal', options })
  }
}
