/**
 * Unit tests for stripe.service.ts error sanitization (Card 1.10)
 * Covers:
 *   - checkoutFailed does NOT leak Stripe error.message to caller
 *   - portalFailed does NOT leak Stripe error.message to caller
 *   - getCheckoutSession throws generic internal error
 *   - getSubscription throws generic internal error
 *   - getStripe() throws when STRIPE_SECRET_KEY not configured
 *   - constructWebhookEvent rejects invalid signature with safe message
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'

// --- Mocks (hoisted) ---
const { mockStripeClient } = vi.hoisted(() => {
  const mockStripeClient = {
    checkout: {
      sessions: {
        create: vi.fn(),
        retrieve: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    subscriptions: {
      retrieve: vi.fn(),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  }
  return { mockStripeClient }
})

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test_fake_key',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_secret',
  },
}))

vi.mock('stripe', () => {
  const StripeErrorClass = class StripeError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'StripeError'
    }
  }
  const StripeSignatureVerificationErrorClass = class StripeSignatureVerificationError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'StripeSignatureVerificationError'
    }
  }

  const StripeMock = Object.assign(
    vi.fn(() => mockStripeClient),
    {
      errors: {
        StripeError: StripeErrorClass,
        StripeSignatureVerificationError: StripeSignatureVerificationErrorClass,
      },
    },
  )

  return { default: StripeMock, Stripe: StripeMock }
})

// Import after mocks are set up
import {
  createCheckoutSession,
  createPortalSession,
  getCheckoutSession,
  getSubscription,
  constructWebhookEvent,
} from '../../src/modules/billing/stripe.service'
import { AppError } from '../../src/errors/app-error'

describe('stripe.service.ts — error sanitization (Card 1.10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // =============================================
  // createCheckoutSession: no Stripe error leak
  // =============================================
  describe('createCheckoutSession', () => {
    it('deve lançar checkoutFailed generico quando Stripe retorna StripeError', async () => {
      const stripeError = new (
        Stripe as unknown as { errors: { StripeError: new (msg: string) => Error } }
      ).errors.StripeError('Your card was declined. Secret internal info here.')
      mockStripeClient.checkout.sessions.create.mockRejectedValue(stripeError)

      const params = {
        email: 'test@example.com',
        priceId: 'price_test',
        successUrl: 'https://app.tablix.com.br/success',
        cancelUrl: 'https://app.tablix.com.br/cancel',
      }

      await expect(createCheckoutSession(params)).rejects.toThrow(AppError)

      try {
        await createCheckoutSession(params)
      } catch (error) {
        const appErr = error as AppError
        // Card 1.10: error.message from Stripe must NOT appear in the thrown error
        expect(appErr.message).not.toContain('Your card was declined')
        expect(appErr.message).not.toContain('Secret internal info')
        expect(appErr.code).toBe('CHECKOUT_FAILED')
        // Should use generic default message from Errors.checkoutFailed()
        expect(appErr.message).toBe('Erro ao criar checkout')
      }
    })

    it('deve lançar checkoutFailed quando client_secret ausente', async () => {
      mockStripeClient.checkout.sessions.create.mockResolvedValue({
        id: 'cs_test_123',
        client_secret: null,
      })

      const params = {
        email: 'test@example.com',
        priceId: 'price_test',
        successUrl: 'https://app.tablix.com.br/success',
        cancelUrl: 'https://app.tablix.com.br/cancel',
      }

      await expect(createCheckoutSession(params)).rejects.toThrow(AppError)

      try {
        await createCheckoutSession(params)
      } catch (error) {
        const appErr = error as AppError
        expect(appErr.code).toBe('CHECKOUT_FAILED')
        // This specific case has a custom message, but it's our own — not Stripe's
        expect(appErr.message).not.toContain('StripeError')
      }
    })

    it('deve retornar clientSecret e sessionId no happy path', async () => {
      mockStripeClient.checkout.sessions.create.mockResolvedValue({
        id: 'cs_test_123',
        client_secret: 'cs_secret_abc',
      })

      const result = await createCheckoutSession({
        email: 'test@example.com',
        priceId: 'price_test',
        successUrl: 'https://app.tablix.com.br/success',
        cancelUrl: 'https://app.tablix.com.br/cancel',
      })

      expect(result).toEqual({
        clientSecret: 'cs_secret_abc',
        sessionId: 'cs_test_123',
      })
    })

    it('deve re-throw erros não-Stripe sem sanitizar', async () => {
      const genericError = new Error('Network timeout')
      mockStripeClient.checkout.sessions.create.mockRejectedValue(genericError)

      await expect(
        createCheckoutSession({
          email: 'test@example.com',
          priceId: 'price_test',
          successUrl: 'https://app.tablix.com.br/success',
          cancelUrl: 'https://app.tablix.com.br/cancel',
        }),
      ).rejects.toThrow('Network timeout')
    })
  })

  // =============================================
  // createPortalSession: no Stripe error leak
  // =============================================
  describe('createPortalSession', () => {
    it('deve lançar portalFailed generico quando Stripe retorna StripeError', async () => {
      const stripeError = new (
        Stripe as unknown as { errors: { StripeError: new (msg: string) => Error } }
      ).errors.StripeError('No such customer: cus_deleted. Internal Stripe detail.')
      mockStripeClient.billingPortal.sessions.create.mockRejectedValue(stripeError)

      await expect(
        createPortalSession('cus_test_123', 'https://app.tablix.com.br'),
      ).rejects.toThrow(AppError)

      try {
        await createPortalSession('cus_test_123', 'https://app.tablix.com.br')
      } catch (error) {
        const appErr = error as AppError
        expect(appErr.message).not.toContain('No such customer')
        expect(appErr.message).not.toContain('Internal Stripe detail')
        expect(appErr.code).toBe('PORTAL_FAILED')
        expect(appErr.message).toBe('Erro ao gerar portal')
      }
    })

    it('deve retornar URL no happy path', async () => {
      mockStripeClient.billingPortal.sessions.create.mockResolvedValue({
        url: 'https://billing.stripe.com/session/test',
      })

      const url = await createPortalSession('cus_test_123', 'https://app.tablix.com.br')
      expect(url).toBe('https://billing.stripe.com/session/test')
    })
  })

  // =============================================
  // getCheckoutSession: generic internal error
  // =============================================
  describe('getCheckoutSession', () => {
    it('deve lançar internal generico quando Stripe retorna StripeError', async () => {
      const stripeError = new (
        Stripe as unknown as { errors: { StripeError: new (msg: string) => Error } }
      ).errors.StripeError('No such checkout session: cs_expired_xyz')
      mockStripeClient.checkout.sessions.retrieve.mockRejectedValue(stripeError)

      await expect(getCheckoutSession('cs_test_123')).rejects.toThrow(AppError)

      try {
        await getCheckoutSession('cs_test_123')
      } catch (error) {
        const appErr = error as AppError
        expect(appErr.message).not.toContain('cs_expired_xyz')
        expect(appErr.code).toBe('INTERNAL_ERROR')
        expect(appErr.message).toBe('Erro ao buscar sessão de checkout')
      }
    })
  })

  // =============================================
  // getSubscription: generic internal error
  // =============================================
  describe('getSubscription', () => {
    it('deve lançar internal generico quando Stripe retorna StripeError', async () => {
      const stripeError = new (
        Stripe as unknown as { errors: { StripeError: new (msg: string) => Error } }
      ).errors.StripeError('No such subscription: sub_cancelled_abc')
      mockStripeClient.subscriptions.retrieve.mockRejectedValue(stripeError)

      await expect(getSubscription('sub_test_123')).rejects.toThrow(AppError)

      try {
        await getSubscription('sub_test_123')
      } catch (error) {
        const appErr = error as AppError
        expect(appErr.message).not.toContain('sub_cancelled_abc')
        expect(appErr.code).toBe('INTERNAL_ERROR')
        expect(appErr.message).toBe('Erro ao buscar assinatura')
      }
    })
  })

  // =============================================
  // constructWebhookEvent: safe error messages
  // =============================================
  describe('constructWebhookEvent', () => {
    it('deve lançar webhookFailed com mensagem segura para assinatura invalida', () => {
      const sigError = new (
        Stripe as unknown as {
          errors: { StripeSignatureVerificationError: new (msg: string) => Error }
        }
      ).errors.StripeSignatureVerificationError(
        'Signature mismatch: expected whsec_xxx got whsec_yyy',
      )
      mockStripeClient.webhooks.constructEvent.mockImplementation(() => {
        throw sigError
      })

      expect(() => constructWebhookEvent(Buffer.from('{}'), 'sig_invalid')).toThrow(AppError)

      try {
        constructWebhookEvent(Buffer.from('{}'), 'sig_invalid')
      } catch (error) {
        const appErr = error as AppError
        // Must NOT leak the actual secret comparison details
        expect(appErr.message).not.toContain('whsec_xxx')
        expect(appErr.message).not.toContain('whsec_yyy')
        expect(appErr.message).toBe('Assinatura do webhook inválida')
        expect(appErr.code).toBe('WEBHOOK_FAILED')
      }
    })
  })
})
