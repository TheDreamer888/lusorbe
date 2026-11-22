/**
 * Planos Grátis e Pro.
 *
 * - Os planos e o preço vêm da API (que os lê da Stripe); nada de preços fixos aqui.
 * - Subscrever e gerir abrem as páginas da Stripe. Só seguimos endereços da
 *   própria Stripe, para um servidor comprometido não poder mandar a pessoa
 *   para outro sítio.
 * - O plano só muda quando a Stripe confirma (webhook): ao voltar do pagamento,
 *   a página volta a perguntar o plano durante alguns segundos.
 */
import { useCallback, useEffect, useState } from 'react'
import { AuthenticationError, ConflictError } from '@lusorbe/sdk'
import type { MyPlan, PlansResponse } from '@lusorbe/sdk'

import { lusorbe } from '../lusorbe'
import { useI18n } from '../i18n/context'
import { isStripeUrl } from '../lib/stripeUrl'
import './Plans.css'


export default function Plans({ onSignIn }: { onSignIn: () => void }) {
  const { m, locale } = useI18n()
  const p = m.plans
  const [plans, setPlans] = useState<PlansResponse | null>(null)
  const [me, setMe] = useState<MyPlan | null>(null)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  // Guarda o tipo de erro, não o texto: muda de língua sem voltar a pedir nada.
  const [error, setError] = useState<'' | 'loadError' | 'signInFirst' | 'alreadyPro' | 'payError'>('')
  const returned = /[?&]checkout=(success|cancel)/.exec(location.hash)?.[1] ?? null

  const loadMe = useCallback((signal?: AbortSignal) =>
    lusorbe.billing.me(signal ? { abortSignal: signal } : undefined)
      .then(r => { setMe(r); setSignedIn(true) })
      .catch((err: unknown) => { if (err instanceof AuthenticationError) setSignedIn(false) }), [])

  useEffect(() => {
    const ctrl = new AbortController()
    lusorbe.billing.plans({ abortSignal: ctrl.signal }).then(setPlans).catch(() => { if (!ctrl.signal.aborted) setError('loadError') })
    void loadMe(ctrl.signal)
    return () => ctrl.abort()
  }, [loadMe])

  // Depois do pagamento, a Stripe avisa a API por webhook; esperamos alguns segundos por isso.
  useEffect(() => {
    if (returned !== 'success' || me?.plan === 'pro') return
    let tries = 0
    const id = window.setInterval(() => { tries += 1; void loadMe(); if (tries >= 10) window.clearInterval(id) }, 2000)
    return () => window.clearInterval(id)
  }, [returned, me?.plan, loadMe])

  const go = async (action: 'checkout' | 'portal') => {
    setBusy(true)
    setError('')
    try {
      const { url } = action === 'checkout' ? await lusorbe.billing.checkout() : await lusorbe.billing.portal()
      if (!isStripeUrl(url)) throw new Error('unexpected redirect')
      window.location.assign(url)
    } catch (err) {
      if (err instanceof AuthenticationError) { setSignedIn(false); setError('signInFirst') }
      else setError(err instanceof ConflictError ? 'alreadyPro' : 'payError')
      setBusy(false)
    }
  }

  const free = plans?.plans.find(x => x.id === 'free')
  const pro = plans?.plans.find(x => x.id === 'pro')
  const money = (amount: number, currency: string) => (amount / 100).toLocaleString(locale, { style: 'currency', currency: currency.toUpperCase() })
  const proPrice = pro?.price ? `${money(pro.price.amount, pro.price.currency)}${pro.price.interval ? ` / ${p.interval[pro.price.interval as 'month'] ?? pro.price.interval}` : ''}` : p.priceSoon
  const isPro = me?.plan === 'pro'

  return (
    <div className="plans">
      {returned === 'success' && <p role="status" className="plans-banner ok">{isPro ? p.welcomePro : p.confirming}</p>}
      {returned === 'cancel' && <p role="status" className="plans-banner">{p.canceled}</p>}
      <div className="plans-grid">
        <section className={`aegis-panel plan-card ${!isPro && signedIn ? 'current' : ''}`}>
          <p className="eyebrow">{p.freeName}</p>
          <h2>{money(0, 'eur')}</h2>
          <ul className="plan-list">
            <li>{p.freeTools}</li>
            <li>{p.assistantPerDay(free?.assistant_daily_limit ?? 30)}</li>
            <li>{p.languages}</li>
          </ul>
          {!isPro && signedIn && <span className="subtle-tag">{p.current}</span>}
        </section>
        <section className={`aegis-panel plan-card pro ${isPro ? 'current' : ''}`}>
          <p className="eyebrow">{p.proName}</p>
          <h2>{proPrice}</h2>
          <ul className="plan-list">
            <li>{p.everythingFree}</li>
            <li>{p.assistantPerDay(pro?.assistant_daily_limit ?? 300)}</li>
            <li>{p.supports}</li>
            <li>{p.cancelAnytime}</li>
          </ul>
          {isPro && <span className="subtle-tag">{p.current}</span>}
          {!plans?.enabled || !pro?.available ? (
            <button className="button button-outline" disabled>{p.soon}</button>
          ) : signedIn === false ? (
            <button className="button button-dark" onClick={onSignIn}>{p.signInToSubscribe}</button>
          ) : isPro ? (
            <button className="button button-outline" disabled={busy || !me?.can_manage} onClick={() => void go('portal')}>{busy ? p.opening : p.manage}</button>
          ) : (
            <button className="button button-dark" disabled={busy || signedIn === null} onClick={() => void go('checkout')}>{busy ? p.opening : p.subscribe}</button>
          )}
        </section>
      </div>
      {error && <p role="alert" className="error-text">{p[error]}</p>}
      <p className="caption">{p.legal} <a href="/legal/terms.html#preco">{m.shell.terms}</a></p>
    </div>
  )
}
