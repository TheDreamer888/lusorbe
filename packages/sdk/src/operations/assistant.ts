import type { AssistantReply, AssistantSkillId, AssistantStatus, ChatMessage } from '../models.ts'
import { ConnectionError, ServerError } from '../errors.ts'
import type { HttpPipeline, OperationOptions } from '../pipeline.ts'

/** Um evento da resposta em streaming. */
export type AssistantStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; refused: boolean; truncated: boolean; replacement?: string }

export interface SendAssistantMessage {
  /** Conversa completa, a começar e acabar numa mensagem do utilizador (máx. 20). */
  messages: ChatMessage[]
  /** Tem de ser `true`: a pessoa aceitou que o texto é enviado à Anthropic. */
  consent: true
  /** Habilidade (ex.: `'matematica'` liga o raciocínio passo a passo). Por omissão, `'geral'`. */
  skill?: AssistantSkillId
  /** Língua da resposta, em BCP 47 (ex.: `'en'`, `'pt-BR'`). Sem ela, responde na língua da pessoa. */
  language?: string
}

/**
 * Assistente opcional (exige sessão). A conversa vive no cliente: o servidor não a guarda.
 *
 * Erros comuns: `AuthenticationError` (sem sessão), `RateLimitError` (limite diário
 * ou por minuto; vê `retryAfter`), `ApiError` com estado 503 (assistente desligado).
 */
export class AssistantOperations {
  private readonly http: HttpPipeline

  constructor(http: HttpPipeline) {
    this.http = http
  }

  /** Se o assistente está ligado, o limite diário e o aviso de dados a mostrar. */
  status(options?: OperationOptions): Promise<AssistantStatus> {
    return this.http.send({ method: 'GET', path: '/api/assistant/status', options })
  }

  /**
   * Envia a conversa e devolve a resposta. Nunca é repetido automaticamente
   * depois de chegar ao servidor (é um POST que gasta quota).
   */
  send(body: SendAssistantMessage, options?: OperationOptions): Promise<AssistantReply> {
    return this.http.send({
      method: 'POST',
      path: '/api/assistant/messages',
      body: { messages: body.messages, consent: body.consent, skill: body.skill, language: body.language },
      options,
    })
  }

  /**
   * Como `send()`, mas devolve os pedaços da resposta à medida que chegam.
   *
   * ```ts
   * for await (const ev of lusorbe.assistant.stream({ messages, consent: true })) {
   *   if (ev.type === 'delta') ui.append(ev.text)
   * }
   * ```
   * Cancelar o `abortSignal` fecha o pedido ao modelo. Uma falha a meio lança
   * `ServerError` (os pedaços já recebidos ficam com quem os mostrou).
   * O tempo limite por omissão é 5 minutos (respostas longas e matemática).
   */
  async *stream(body: SendAssistantMessage, options?: OperationOptions): AsyncGenerator<AssistantStreamEvent> {
    const res = await this.http.send<Response>({
      method: 'POST',
      path: '/api/assistant/messages/stream',
      body: { messages: body.messages, consent: body.consent, skill: body.skill, language: body.language },
      responseType: 'stream',
      options: { timeoutMs: 300_000, ...options },
    })
    if (!res.body) throw new ConnectionError('A resposta não trouxe dados.')
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let finished = false
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<string>
        try {
          chunk = await reader.read()
        } catch (cause) {
          throw new ConnectionError('A ligação caiu a meio da resposta.', { cause })
        }
        if (chunk.done) break
        buffer += chunk.value
        let cut: number
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const ev = parseSse(block)
          if (!ev) continue
          if (ev.event === 'delta') yield { type: 'delta', text: String(ev.data.text ?? '') }
          else if (ev.event === 'done') {
            finished = true
            const done: AssistantStreamEvent = { type: 'done', refused: Boolean(ev.data.refused), truncated: Boolean(ev.data.truncated) }
            if (typeof ev.data.replacement === 'string') done.replacement = ev.data.replacement
            yield done
          } else if (ev.event === 'error') {
            throw new ServerError(String(ev.data.detail ?? 'O assistente não conseguiu responder.'), { status: 502, operation: 'POST /api/assistant/messages/stream', body: ev.data })
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (!finished) throw new ConnectionError('A resposta terminou antes do fim.')
  }
}

/** Lê um bloco Server-Sent Events (`event:` + `data:` JSON). */
function parseSse(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) as Record<string, unknown> }
  } catch {
    return null
  }
}