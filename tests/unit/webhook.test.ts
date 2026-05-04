/**
 * Unit tests for webhook idempotency (Card 1.1)
 * Covers:
 *   - registerStripeEvent deduplication (P2002 handling)
 *   - Controller: duplicate event returns 200 without side effects
 *   - Controller: real errors propagate (500 for Stripe retry)
 *   - Handler: handleCheckoutCompleted atomic token creation
 *   - Handler: existing token for same user+subscription is not duplicated
 *   - Handler: errors throw instead of being swallowed
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

// Import after mocks
import {
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
} from '../../src/modules/billing/webhook.handler'
import { stripeWebhook } from '../../src/http/controllers/webhook.controller'
import { constructWebhookEvent } from '../../src/modules/billing/stripe.service'
import {
  sendTokenEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} from '../../src/lib/email'
import { AuditAction } from '../../src/lib/audit/audit.types'

// --- vi.hoisted: shared mock state ---
const { prismaMock } = vi.hoisted(() => {
  function createModelMock() {
    return {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
    }
  }

  const prismaMock = {
    user: createModelMock(),
    session: createModelMock(),
    token: createModelMock(),
    usage: createModelMock(),
    job: createModelMock(),
    stripeEvent: createModelMock(),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }

  return { prismaMock }
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
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/lib/token-generator', () => ({
  generateProToken: vi.fn(() => 'tbx_pro_test_token_12345678901234567890'),
}))

vi.mock('../../src/lib/email', () => ({
  sendTokenEmail: vi.fn(),
  sendCancellationEmail: vi.fn(),
  sendPaymentFailedEmail: vi.fn(),
}))

vi.mock('../../src/modules/billing/stripe.service', () => ({
  constructWebhookEvent: vi.fn(),
}))

// Mock do audit service — capturamos `emitAuditEvent` nos smoke tests de
// observabilidade (Card 2.4). Comportamento real testado em audit-service.test.ts.
const emitAuditEventMock = vi.fn()
vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: (...args: unknown[]) => emitAuditEventMock(...args),
}))

// Mock do circuit breaker — por default NÃO está banido e recordFailure é no-op.
// Os testes que querem exercer o caminho de ban sobrescrevem via mockResolvedValue.
const isWebhookSignatureBannedMock = vi.fn().mockResolvedValue(false)
const recordWebhookSignatureFailureMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/lib/security/webhook-circuit-breaker', () => ({
  isWebhookSignatureBanned: (...args: unknown[]) =>
    isWebhookSignatureBannedMock(...args),
  recordWebhookSignatureFailure: (...args: unknown[]) =>
    recordWebhookSignatureFailureMock(...args),
}))

// --- Helpers ---

function makeStripeEvent(
  overrides: Partial<{
    id: string
    type: string
    data: unknown
  }> = {},
) {
  return {
    id: overrides.id ?? 'evt_test_123',
    type: overrides.type ?? 'checkout.session.completed',
    data: overrides.data ?? {
      object: makeCheckoutSession(),
    },
  }
}

function makeCheckoutSession(
  overrides: Partial<{
    id: string
    customer_email: string
    customer: string
    subscription: string
  }> = {},
) {
  return {
    id: overrides.id ?? 'cs_test_123',
    customer_email: overrides.customer_email ?? 'user@test.com',
    customer_details: { email: 'user@test.com' },
    customer: overrides.customer ?? 'cus_test_123',
    subscription: overrides.subscription ?? 'sub_test_123',
  }
}

function makeFastifyRequest(signature = 'sig_test') {
  return {
    headers: { 'stripe-signature': signature },
    body: Buffer.from('{}'),
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as Parameters<typeof stripeWebhook>[0]
}

function makeFastifyReply() {
  const reply = {
    send: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  }
  return reply as unknown as Parameters<typeof stripeWebhook>[1]
}

function makeP2002Error() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.0.0',
  })
}

// --- Tests ---

describe('Webhook Idempotency (Card 1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ===========================================
  // Controller: registerStripeEvent deduplication
  // ===========================================
  describe('stripeWebhook controller', () => {
    it('should process new event and return { received: true }', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })

      // Mock handler dependencies
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({
        id: 'token-1',
      })

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(prismaMock.stripeEvent.create).toHaveBeenCalledWith({
        data: { id: 'evt_test_123', type: 'checkout.session.completed' },
      })
      expect(reply.send).toHaveBeenCalledWith({
        received: true,
      })
    })

    it('should return { received: true, duplicate: true } for duplicate event', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockRejectedValue(makeP2002Error())

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(reply.send).toHaveBeenCalledWith({
        received: true,
        duplicate: true,
      })
      // No handler should have been called
      expect(prismaMock.user.upsert).not.toHaveBeenCalled()
      expect(prismaMock.token.create).not.toHaveBeenCalled()
    })

    it('should propagate non-P2002 errors from stripeEvent.create', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      const dbError = new Error('Connection lost')
      prismaMock.stripeEvent.create.mockRejectedValue(dbError)

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await expect(stripeWebhook(request, reply)).rejects.toThrow(
        'Connection lost',
      )
    })

    it('should propagate handler errors (500 for Stripe retry)', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })

      // Handler will fail
      prismaMock.user.upsert.mockRejectedValue(new Error('DB down'))

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await expect(stripeWebhook(request, reply)).rejects.toThrow('DB down')
    })

    it('should throw when stripe-signature header is missing', async () => {
      const request = {
        headers: {},
        body: Buffer.from('{}'),
        log: { info: vi.fn(), error: vi.fn() },
      } as unknown as Parameters<typeof stripeWebhook>[0]
      const reply = makeFastifyReply()

      await expect(stripeWebhook(request, reply)).rejects.toThrow()
    })

    it('should log and rethrow when constructWebhookEvent throws (invalid signature)', async () => {
      const sigError = new Error(
        'No signatures found matching the expected signature for payload',
      )
      vi.mocked(constructWebhookEvent).mockImplementation(() => {
        throw sigError
      })

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await expect(stripeWebhook(request, reply)).rejects.toThrow(
        'No signatures found',
      )
      expect(request.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: sigError }),
        '[Webhook] Erro de validacao de assinatura',
      )
    })

    it('should route customer.subscription.updated event to handler', async () => {
      const event = makeStripeEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_123',
            customer: 'cus_test_123',
            status: 'active',
          },
        },
      })
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })

    it('should route customer.subscription.deleted event to handler', async () => {
      const event = makeStripeEvent({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_123',
            customer: 'cus_test_123',
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
          },
        },
      })
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      )
      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })

    it('should route invoice.payment_failed event to handler', async () => {
      const event = makeStripeEvent({
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_test_123',
            customer: 'cus_test_123',
          },
        },
      })
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(sendPaymentFailedEmail).toHaveBeenCalledWith({
        to: 'user@test.com',
      })
      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })

    it('should log and return received:true for unhandled event type', async () => {
      const event = makeStripeEvent({ type: 'customer.created' })
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(request.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'customer.created' }),
        '[Webhook] Evento nao tratado',
      )
      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })
  })

  // ===========================================
  // Handler: handleCheckoutCompleted atomicity
  // ===========================================
  describe('handleCheckoutCompleted', () => {
    it('should create user and token on first event', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({
        id: 'token-1',
      })

      await handleCheckoutCompleted(session as never)

      expect(prismaMock.user.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'user@test.com' },
          create: expect.objectContaining({
            email: 'user@test.com',
            stripeCustomerId: 'cus_test_123',
            role: 'PRO',
          }),
        }),
      )
      expect(prismaMock.token.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            stripeSubscriptionId: 'sub_test_123',
            plan: 'PRO',
            status: 'ACTIVE',
          }),
        }),
      )
      expect(sendTokenEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
        }),
      )
    })

    it('should not create duplicate token for same user+subscription', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'existing-token',
        userId: 'user-1',
        stripeSubscriptionId: 'sub_test_123',
        status: 'ACTIVE',
      })

      await handleCheckoutCompleted(session as never)

      expect(prismaMock.token.create).not.toHaveBeenCalled()
      expect(sendTokenEmail).not.toHaveBeenCalled()
    })

    it('should reactivate cancelled token for same user+subscription', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'existing-token',
        userId: 'user-1',
        stripeSubscriptionId: 'sub_test_123',
        status: 'CANCELLED',
      })
      prismaMock.token.update.mockResolvedValue({
        id: 'existing-token',
        status: 'ACTIVE',
      })

      await handleCheckoutCompleted(session as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith({
        where: { id: 'existing-token' },
        data: { status: 'ACTIVE', expiresAt: null },
      })
      expect(prismaMock.token.create).not.toHaveBeenCalled()
    })

    it('should throw when session has no email', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: null,
        customer_details: { email: null },
        customer: 'cus_test_123',
        subscription: 'sub_test_123',
      }

      await expect(handleCheckoutCompleted(session as never)).rejects.toThrow(
        'Erro ao processar webhook',
      )
    })

    it('should throw when session has no customer', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: 'user@test.com',
        customer: null,
        subscription: 'sub_test_123',
      }

      await expect(handleCheckoutCompleted(session as never)).rejects.toThrow(
        'Erro ao processar webhook',
      )
    })

    it('should not block on email failure (fire-and-forget)', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({
        id: 'token-1',
      })
      vi.mocked(sendTokenEmail).mockRejectedValue(new Error('Resend down'))

      // Should not throw despite email failure
      await expect(
        handleCheckoutCompleted(session as never),
      ).resolves.toBeUndefined()
    })

    it('should handle P2002 race condition on token.create (defense-in-depth)', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      // findFirst returns null (no existing token), but create hits P2002
      // because another request created the token between findFirst and create
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockRejectedValue(makeP2002Error())

      // Should NOT throw — P2002 is treated as safe duplicate
      await expect(
        handleCheckoutCompleted(session as never),
      ).resolves.toBeUndefined()
      // Email should NOT be sent (early return on race condition)
      expect(sendTokenEmail).not.toHaveBeenCalled()
    })

    it('should propagate non-P2002 errors from token.create', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockRejectedValue(new Error('DB connection lost'))

      await expect(handleCheckoutCompleted(session as never)).rejects.toThrow(
        'DB connection lost',
      )
    })
  })

  // ===========================================
  // Handler: handleSubscriptionUpdated
  // ===========================================
  describe('handleSubscriptionUpdated', () => {
    it('should throw when customer not found', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_unknown',
        status: 'active',
      }
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(
        handleSubscriptionUpdated(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('should update token and user role in transaction', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'active',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      // Verify $transaction received an array (batch transaction)
      const callArgs = prismaMock.$transaction.mock.calls[0]![0]
      expect(Array.isArray(callArgs)).toBe(true)
      expect(callArgs).toHaveLength(2)
    })

    it('should throw when token not found for user', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'active',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      await expect(
        handleSubscriptionUpdated(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('should set status CANCELLED and keep PRO role for canceled subscription', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'canceled',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      const txArgs = prismaMock.$transaction.mock.calls[0]![0] as Array<unknown>
      // token.update call is first element — check it was called with status CANCELLED
      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: 'PRO' },
        }),
      )
      expect(txArgs).toHaveLength(2)
    })

    it('should set status ACTIVE and expiresAt for past_due subscription', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'past_due',
        current_period_end: periodEnd,
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: new Date(periodEnd * 1000),
          }),
        }),
      )
    })

    it('should set status EXPIRED and FREE role for incomplete_expired subscription', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'incomplete_expired',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'EXPIRED' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: 'FREE' },
        }),
      )
    })

    it('should set status ACTIVE and PRO role for trialing subscription', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'trialing',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: 'PRO' },
        }),
      )
    })

    it('should set status ACTIVE for unpaid subscription (same branch as past_due)', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'unpaid',
        current_period_end: periodEnd,
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: new Date(periodEnd * 1000),
          }),
        }),
      )
    })

    it('should set null expiresAt for past_due subscription without current_period_end', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'past_due',
        // no current_period_end
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: null,
          }),
        }),
      )
    })
  })

  // ===========================================
  // Handler: handleSubscriptionDeleted
  // ===========================================
  describe('handleSubscriptionDeleted', () => {
    it('should mark token as cancelled and send email', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'canceled',
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({
        id: 'token-1',
        status: 'CANCELLED',
      })

      await handleSubscriptionDeleted(subscription as never)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'token-1' },
          data: expect.objectContaining({
            status: 'CANCELLED',
          }),
        }),
      )
      expect(sendCancellationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
        }),
      )
    })

    it('should not block on email failure', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        current_period_end: Math.floor(Date.now() / 1000),
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      vi.mocked(sendCancellationEmail).mockRejectedValue(
        new Error('Resend down'),
      )

      await expect(
        handleSubscriptionDeleted(subscription as never),
      ).resolves.toBeUndefined()
    })

    it('should throw when user not found for customer', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_unknown',
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
      }
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(
        handleSubscriptionDeleted(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('should throw when token not found for user', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      await expect(
        handleSubscriptionDeleted(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('should use current date as gracePeriodEnd when current_period_end is absent', async () => {
      // subscription without current_period_end — gracePeriodEnd falls back to new Date()
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        // intentionally omitting current_period_end
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})

      await handleSubscriptionDeleted(subscription as never)

      // expiresAt must be a real Date (not null, not undefined)
      const updateCall = prismaMock.token.update.mock.calls[0]![0] as {
        data: { expiresAt: unknown }
      }
      expect(updateCall.data.expiresAt).toBeInstanceOf(Date)
    })
  })

  // ===========================================
  // Handler: handlePaymentFailed
  // ===========================================
  describe('handlePaymentFailed', () => {
    it('should send payment failed email', async () => {
      const invoice = {
        id: 'in_test_123',
        customer: 'cus_test_123',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      await handlePaymentFailed(invoice as never)

      expect(sendPaymentFailedEmail).toHaveBeenCalledWith({
        to: 'user@test.com',
      })
    })

    it('should throw when customer not found', async () => {
      const invoice = {
        id: 'in_test_123',
        customer: 'cus_unknown',
      }
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(handlePaymentFailed(invoice as never)).rejects.toThrow(
        'Erro ao processar webhook',
      )
    })

    it('should not block on email failure', async () => {
      const invoice = {
        id: 'in_test_123',
        customer: 'cus_test_123',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      vi.mocked(sendPaymentFailedEmail).mockRejectedValue(
        new Error('Resend down'),
      )

      await expect(
        handlePaymentFailed(invoice as never),
      ).resolves.toBeUndefined()
    })

    it('should resolve customerId when customer is an object with id', async () => {
      // Stripe sometimes expands the customer field to an object
      const invoice = {
        id: 'in_test_123',
        customer: { id: 'cus_test_123' },
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      await handlePaymentFailed(invoice as never)

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
      expect(sendPaymentFailedEmail).toHaveBeenCalledWith({
        to: 'user@test.com',
      })
    })

    it('should throw when customer is null (no customerId extractable)', async () => {
      const invoice = {
        id: 'in_test_123',
        customer: null,
      }

      await expect(handlePaymentFailed(invoice as never)).rejects.toThrow(
        'Erro ao processar webhook',
      )
    })
  })

  // ===========================================
  // Handler: object-shape customer edge cases
  // ===========================================
  describe('handleSubscriptionUpdated — object customer', () => {
    it('should resolve customerId when customer is an object with id', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: { id: 'cus_test_123' },
        status: 'active',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated(subscription as never)

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
    })

    it('should throw when customer object has no id (null customer)', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: null,
        status: 'active',
      }

      await expect(
        handleSubscriptionUpdated(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })
  })

  describe('handleSubscriptionDeleted — object customer', () => {
    it('should resolve customerId when customer is an object with id', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: { id: 'cus_test_123' },
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})

      await handleSubscriptionDeleted(subscription as never)

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
    })

    it('should throw when customer object has no id (null customer)', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: null,
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
      }

      await expect(
        handleSubscriptionDeleted(subscription as never),
      ).rejects.toThrow('Erro ao processar webhook')
    })
  })

  // =============================================
  // Smoke tests — pontos de emissão de audit (Card 2.4)
  // =============================================
  // Garantia de contrato: os caminhos críticos de webhook emitem o evento
  // forense correto. Não validamos payload completo (escopo do
  // audit-service.test.ts); só que o evento disparou com a AuditAction certa.
  describe('audit emissions', () => {
    function emittedActions(): string[] {
      return emitAuditEventMock.mock.calls.map(
        (c) => (c[0] as { action: string }).action,
      )
    }

    it('emite WEBHOOK_SIGNATURE_FAILED quando assinatura é inválida', async () => {
      vi.mocked(constructWebhookEvent).mockImplementation(() => {
        throw new Error('invalid signature')
      })

      await expect(
        stripeWebhook(makeFastifyRequest(), makeFastifyReply()),
      ).rejects.toThrow()

      expect(emittedActions()).toContain(AuditAction.WEBHOOK_SIGNATURE_FAILED)
    })

    it('emite WEBHOOK_DUPLICATE quando stripeEvent.create dispara P2002', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockRejectedValue(makeP2002Error())

      await stripeWebhook(makeFastifyRequest(), makeFastifyReply())

      expect(emittedActions()).toContain(AuditAction.WEBHOOK_DUPLICATE)
    })

    it('emite WEBHOOK_PROCESSED após processar evento novo com sucesso', async () => {
      const event = makeStripeEvent({ type: 'customer.created' }) // rota default (sem handler de negócio)
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      prismaMock.stripeEvent.create.mockResolvedValue({
        id: event.id,
        type: event.type,
        processedAt: new Date(),
      })

      await stripeWebhook(makeFastifyRequest(), makeFastifyReply())

      expect(emittedActions()).toContain(AuditAction.WEBHOOK_PROCESSED)
    })

    it('emite ACCOUNT_CREATED quando handleCheckoutCompleted vê user novo', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null) // user não existe
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-new',
        email: 'newuser@test.com',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'tok-1' })

      await handleCheckoutCompleted({
        customer_email: 'newuser@test.com',
        customer: 'cus_new',
        subscription: 'sub_new',
      } as never)

      expect(emittedActions()).toContain(AuditAction.ACCOUNT_CREATED)
    })

    it('emite ROLE_CHANGED quando handleCheckoutCompleted promove user FREE→PRO', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-existing',
        role: 'FREE',
      })
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-existing',
        email: 'existing@test.com',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'tok-1' })

      await handleCheckoutCompleted({
        customer_email: 'existing@test.com',
        customer: 'cus_existing',
        subscription: 'sub_existing',
      } as never)

      const actions = emittedActions()
      expect(actions).toContain(AuditAction.ROLE_CHANGED)
      // Idempotência: se user já era PRO, NÃO emite ACCOUNT_CREATED.
      expect(actions).not.toContain(AuditAction.ACCOUNT_CREATED)
    })

    it('NÃO emite ROLE_CHANGED quando user existente já é PRO (idempotência)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-pro',
        role: 'PRO',
      })
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-pro',
        email: 'pro@test.com',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'tok-1' })

      await handleCheckoutCompleted({
        customer_email: 'pro@test.com',
        customer: 'cus_pro',
        subscription: 'sub_pro',
      } as never)

      const actions = emittedActions()
      expect(actions).not.toContain(AuditAction.ROLE_CHANGED)
      expect(actions).not.toContain(AuditAction.ACCOUNT_CREATED)
    })

    it('emite ROLE_CHANGED em handleSubscriptionUpdated quando role muda', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      // status incomplete_expired força userRole='FREE' → downgrade vs user.role='PRO'
      await handleSubscriptionUpdated({
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'incomplete_expired',
      } as never)

      const roleChanged = emitAuditEventMock.mock.calls.find(
        (c) => (c[0] as { action: string }).action === AuditAction.ROLE_CHANGED,
      )
      expect(roleChanged).toBeDefined()
      const input = roleChanged![0] as { metadata?: Record<string, unknown> }
      expect(input.metadata).toMatchObject({
        from: 'PRO',
        to: 'FREE',
      })
    })

    it('NÃO emite ROLE_CHANGED em handleSubscriptionUpdated quando role não muda (webhook retry)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.$transaction.mockResolvedValue([])

      await handleSubscriptionUpdated({
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'active', // user já é PRO, role='PRO' igual
      } as never)

      expect(emittedActions()).not.toContain(AuditAction.ROLE_CHANGED)
    })

    it('emite PAYMENT_FAILED em handlePaymentFailed com invoiceId nos metadados', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      await handlePaymentFailed({
        id: 'in_test_123',
        customer: 'cus_test_123',
      } as never)

      const call = emitAuditEventMock.mock.calls.find(
        (c) =>
          (c[0] as { action: string }).action === AuditAction.PAYMENT_FAILED,
      )
      expect(call).toBeDefined()
      const input = call![0] as {
        metadata?: Record<string, unknown>
        success: boolean
      }
      expect(input.success).toBe(false)
      expect(input.metadata?.invoiceId).toBe('in_test_123')
      expect(input.metadata?.customerId).toBe('cus_test_123')
    })
  })
})
