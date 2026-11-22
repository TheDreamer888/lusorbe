import assert from 'node:assert/strict'
import test from 'node:test'
import { isStripeUrl } from '../src/lib/stripeUrl.ts'

test('só segue endereços https da Stripe', () => {
  assert.equal(isStripeUrl('https://checkout.stripe.com/c/pay/cs_test_1'), true)
  assert.equal(isStripeUrl('https://billing.stripe.com/p/session/test_1'), true)
  for (const bad of [
    'http://checkout.stripe.com/c/pay/cs_test_1',
    'https://checkout.stripe.com.evil.example/x',
    'https://evil.example/?u=https://checkout.stripe.com',
    'https://user:pass@checkout.stripe.com/x',
    'javascript:alert(1)',
    'not a url',
  ]) assert.equal(isStripeUrl(bad), false, bad)
})