/**
 * Unit tests for stripe.service.ts PRICE_MAP with partial env (Card 1.20)
 * Covers:
 *   - getAllPrices() with only BRL configured (USD/EUR absent)
 *   - getPriceId() returns undefined for unconfigured currency
 *
 * Separated from stripe-service.test.ts because PRICE_MAP is built
 * at module load from env vars — different env mock requires separate file.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi } from 'vitest'

import {
  getPriceId,
  getAllPrices,
} from '../../src/modules/billing/stripe.service'

// Mock env with only BRL configured (USD/EUR absent)
vi.mock('../../src/config/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_fake_key',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_secret',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_brl_monthly_test',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_brl_yearly_test',
    // USD and EUR intentionally undefined
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
  },
}))

vi.mock('stripe', () => {
  const StripeMock = Object.assign(
    vi.fn(() => ({})),
    {
      errors: {
        StripeError: class StripeError extends Error {},
        StripeSignatureVerificationError: class StripeSignatureVerificationError extends Error {},
      },
    },
  )
  return { default: StripeMock, Stripe: StripeMock }
})

describe('stripe.service.ts — PRICE_MAP com env parcial (Card 1.20)', () => {
  describe('getPriceId com env parcial', () => {
    it('deve retornar priceId para BRL (configurado)', () => {
      expect(getPriceId('BRL', 'monthly')).toBe('price_brl_monthly_test')
      expect(getPriceId('BRL', 'yearly')).toBe('price_brl_yearly_test')
    })

    it('deve retornar undefined para USD (não configurado)', () => {
      expect(getPriceId('USD', 'monthly')).toBeUndefined()
      expect(getPriceId('USD', 'yearly')).toBeUndefined()
    })

    it('deve retornar undefined para EUR (não configurado)', () => {
      expect(getPriceId('EUR', 'monthly')).toBeUndefined()
      expect(getPriceId('EUR', 'yearly')).toBeUndefined()
    })
  })

  describe('getAllPrices com env parcial', () => {
    it('deve retornar apenas currencies com pelo menos 1 price configurado', () => {
      const result = getAllPrices()
      // Só BRL está configurado — USD e EUR filtrados
      expect(result).toHaveLength(1)
    })

    it('deve retornar available:true para BRL', () => {
      const result = getAllPrices()
      const brl = result.find((r) => r.currency === 'BRL')
      expect(brl).toBeDefined()
      expect(brl?.monthly.available).toBe(true)
      expect(brl?.yearly.available).toBe(true)
    })

    it('não deve expor USD (não configurado)', () => {
      const result = getAllPrices()
      const usd = result.find((r) => r.currency === 'USD')
      expect(usd).toBeUndefined()
    })

    it('não deve expor EUR (não configurado)', () => {
      const result = getAllPrices()
      const eur = result.find((r) => r.currency === 'EUR')
      expect(eur).toBeUndefined()
    })
  })
})
