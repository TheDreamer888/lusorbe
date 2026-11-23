/**
 * Assistente opcional (Claude, via API da Lusorbe).
 *
 * - Só com sessão; a API aplica os limites por conta.
 * - Antes da primeira mensagem, a pessoa vê e aceita o aviso de dados.
 * - A conversa vive só nesta página (memória). Não vai para localStorage nem
 *   para o servidor da Lusorbe; "Nova conversa" apaga-a.
 * - As respostas são desenhadas por `RichText` (parágrafos, código e fórmulas),
 *   sem nunca injetar o HTML do modelo; só o KaTeX gera HTML, sem `trust`.
 * - A pessoa escolhe a habilidade (matemática, segurança, …) e a língua da resposta.
 * - Os textos da interface vêm de `i18n`. Em "Automático", o assistente responde
 *   na língua em que a pessoa escreve.
 */
import { useEffect, useRef, useState } from 'react'
import { AuthenticationError, LusorbeError, RateLimitError, ValidationError } from '@lusorbe/sdk'
import type { AssistantSkillId, AssistantStatus, ChatMessage } from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'
import RichText from './RichText'
import { useI18n } from '../i18n/context'
import type { Messages } from '../i18n/pt-PT'
import './Assistant.css'

const MAX_CHARS = 4000
const MAX_TURNS = 20

type Phase = 'loading' | 'signed-out' | 'disabled' | 'ready' | 'error'

/** Mantém a conversa dentro do limite da API, sem a fazer começar numa resposta. */
function trim(history: ChatMessage[]): ChatMessage[] {
  let h = history.slice(-MAX_TURNS)
  while (h.length && h[0]!.role !== 'user') h = h.slice(1)
  return h
}

/** Mensagem de erro na língua da interface. Em pt-PT usa o texto do servidor, que é mais preciso. */
function friendly(err: unknown, m: Messages, isPt: boolean): string {
  const e = m.assistant.errors
  if (err instanceof RateLimitError) {
    const s = err.retryAfterSeconds
    const wait = s === undefined ? '' : s >= 3600 ? e.backInHours(Math.ceil(s / 3600)) : e.tryInMinutes(Math.max(1, Math.ceil(s / 60)))
    return `${isPt && err.message ? err.message : e.rateLimited} ${wait}`.trim()
  }
  if (err instanceof AuthenticationError) return e.session
  if (err instanceof ValidationError) return e.invalid
  if (err instanceof LusorbeError) return (isPt && err.message) || e.failed
  return e.offline
}

export default function Assistant({ onSignIn }: { onSignIn: () => void }) {
  const { m, lang, locale } = useI18n()
  const a = m.assistant
  const isPt = lang === 'pt-PT'
  const [phase, setPhase] = useState<Phase>('loading')
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [consent, setConsent] = useState(false)
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [skill, setSkill] = useState<AssistantSkillId>('geral')
  const [language, setLanguage] = useState('')
  // Texto da resposta que está a chegar (null quando não há nenhuma em curso).
  const [live, setLive] = useState<string | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    lusorbe.assistant
      .status({ abortSignal: ctrl.signal })
      .then(s => { setStatus(s); setPhase(s.enabled ? 'ready' : 'disabled') })
      .catch(err => { if (!ctrl.signal.aborted) setPhase(err instanceof AuthenticationError ? 'signed-out' : 'error') })
    return () => { ctrl.abort(); abortRef.current?.abort() }
  }, [])

  // Desloca só a conversa (não a página), para a caixa de texto continuar visível.
  useEffect(() => { const log = logRef.current; if (log) log.scrollTop = log.scrollHeight }, [history, busy])

  /** Pede a resposta em streaming para a conversa `next` (que acaba numa mensagem da pessoa). */
  const run = async (next: ChatMessage[], restoreDraft: string | null) => {
    setHistory(next)
    setError('')
    setBusy(true)
    setLive('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let text = ''
    try {
      for await (const ev of lusorbe.assistant.stream({ messages: next, consent: true, skill, ...(language ? { language } : {}) }, { abortSignal: ctrl.signal })) {
        if (ev.type === 'delta') { text += ev.text; setLive(text) }
        else {
          const final = ev.refused ? (ev.replacement ?? a.errors.failed) : ev.truncated ? `${text}\n\n${a.truncated}` : text
          setHistory(h => [...h, { role: 'assistant', content: final }])
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        // A pessoa parou: o que já chegou fica na conversa.
        if (text.trim()) setHistory(h => [...h, { role: 'assistant', content: `${text}\n\n${a.stopped}` }])
        else { setHistory(h => h.slice(0, -1)); if (restoreDraft !== null) setDraft(restoreDraft) }
        return
      }
      setError(friendly(err, m, isPt))
      if (err instanceof AuthenticationError) setPhase('signed-out')
      if (text.trim()) {
        // Falhou a meio: guarda o que chegou, para não se perder.
        setHistory(h => [...h, { role: 'assistant', content: `${text}\n\n${a.interrupted}` }])
      } else {
        // Sem resposta: a mensagem volta para a caixa.
        setHistory(h => h.slice(0, -1))
        if (restoreDraft !== null) setDraft(restoreDraft)
      }
    } finally {
      setLive(null)
      setBusy(false)
      if (abortRef.current === ctrl) abortRef.current = null
    }
  }

  const send = (text: string) => {
    const content = text.trim()
    if (!content || busy || !consent) return
    setDraft('')
    void run(trim([...history, { role: 'user', content }]), content)
  }

  /** Volta a pedir a última resposta, com a mesma pergunta. */
  const regenerate = () => {
    if (busy) return
    const lastUser = history.map(x => x.role).lastIndexOf('user')
    if (lastUser < 0) return
    void run(history.slice(0, lastUser + 1), null)
  }

  const stop = () => abortRef.current?.abort()

  const copy = async (i: number, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(i)
      window.setTimeout(() => setCopied(c => (c === i ? null : c)), 2000)
    } catch { /* sem acesso à área de transferência: não faz nada */ }
  }

  const reset = () => { abortRef.current?.abort(); setHistory([]); setDraft(''); setError(''); setBusy(false); setLive(null) }

  if (phase === 'loading') return <section className="aegis-panel assistant"><p role="status">{a.checking}</p></section>
  if (phase === 'signed-out') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">{a.gateKicker}</p>
      <h2>{a.gateTitle}</h2>
      <p className="muted">{a.gateText}</p>
      <button className="button button-dark" onClick={onSignIn}>{a.signIn}</button>
    </section>
  )
  if (phase === 'disabled' || phase === 'error') return (
    <section className="aegis-panel assistant assistant-gate">
      <p className="eyebrow">{a.kicker}</p>
      <h2>{phase === 'disabled' ? a.unavailable : a.cantConnect}</h2>
      <p className="muted">{phase === 'disabled' ? a.disabledText : a.errorText}</p>
    </section>
  )

  return (
    <section className="aegis-panel assistant" aria-label={a.regionLabel}>
      <div className="panel-top">
        <div><p className="eyebrow">{a.kicker} · CLAUDE</p><h2>{a.title}</h2></div>
        <span className="subtle-tag">{a.perDay(status?.daily_limit ?? 0)}</span>
      </div>

      {!consent ? (
        <div className="assistant-consent">
          <p>{isPt ? status?.data_notice : a.dataNotice}</p>
          <ul className="plain-list">
            <li><b>{a.whatFor}</b><span>{a.whatForText}</span></li>
            <li><b>{a.canErr}</b><span>{a.canErrText}</span></li>
          </ul>
          <label className="switch-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>{a.accept}</label>
        </div>
      ) : (
        <>
          <div className="assistant-tools">
            <div className="skill-chips" role="radiogroup" aria-label={a.skillsLabel}>
              {(status?.skills ?? []).map(s => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={skill === s.id}
                  className={skill === s.id ? 'chip active' : 'chip'}
                  title={s.description}
                  onClick={() => setSkill(s.id as AssistantSkillId)}
                >{a.skills[s.id] ?? s.name}</button>
              ))}
            </div>
            <label className="lang-select">
              <span>{a.replyIn}</span>
              <select value={language} onChange={e => setLanguage(e.target.value)}>
                <option value="">{a.auto}</option>
                {(status?.languages ?? []).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </label>
          </div>
          <div className="assistant-log" aria-live="polite" aria-busy={busy} ref={logRef}>
            {history.length === 0 && (
              <div className="assistant-suggestions">
                {(a.suggestions[skill] ?? a.suggestions['geral'] ?? []).map(s => <button key={s} onClick={() => s.endsWith('…') ? setDraft(s.slice(0, -1)) : send(s)}>{s}</button>)}
              </div>
            )}
            {history.map((msg, i) => (
              <div key={i} className={`bubble ${msg.role}`}>
                <span className="sr-only">{msg.role === 'user' ? a.youSaid : a.replied}</span>
                {msg.role === 'assistant' ? <RichText text={msg.content}/> : msg.content}
                {msg.role === 'assistant' && !busy && (
                  <div className="bubble-actions">
                    <button type="button" onClick={() => void copy(i, msg.content)}>{copied === i ? a.copied : a.copy}</button>
                    {i === history.length - 1 && <button type="button" onClick={regenerate}>{a.regenerate}</button>}
                  </div>
                )}
              </div>
            ))}
            {live !== null && (live
              ? <div className="bubble assistant streaming"><RichText text={live}/></div>
              : <div className="bubble assistant typing" role="status">{skill === 'matematica' ? a.solving : a.thinking}</div>)}
          </div>
          {error && <p role="alert" className="error-text">{error}</p>}
          <form className="assistant-form" onSubmit={e => { e.preventDefault(); send(draft) }}>
            <label className="sr-only" htmlFor="assistant-input">{a.inputLabel}</label>
            <textarea
              id="assistant-input"
              rows={3}
              maxLength={MAX_CHARS}
              value={draft}
              placeholder={a.placeholder}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(draft) } }}
            />
            <div className="input-meta">
              <span>{draft.length.toLocaleString(locale)} / {MAX_CHARS.toLocaleString(locale)}</span>
              <div className="button-row">
                <button type="button" className="button button-quiet" onClick={reset} disabled={!history.length && !draft}>{a.newChat}</button>
                {busy
                  ? <button type="button" className="button button-outline" onClick={stop}>{a.stop}</button>
                  : <button type="submit" className="button button-dark" disabled={!draft.trim()}>{a.send}</button>}
              </div>
            </div>
          </form>
          <p className="caption">{a.caption}</p>
        </>
      )}
    </section>
  )
}
