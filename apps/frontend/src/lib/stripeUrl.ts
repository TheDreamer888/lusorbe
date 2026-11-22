const STRIPE_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com'])

/**
 * Só aceita endereços https das páginas de pagamento e de gestão da Stripe,
 * para um servidor comprometido não poder mandar a pessoa para outro sítio.
 */
export function isStripeUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && STRIPE_HOSTS.has(u.hostname) && !u.username && !u.password
  } catch {
    return false
  }
}