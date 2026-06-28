/**
 * Unit tests — webhook handlers + controller border (Card #189).
 *
 * ARQUITETURA PÓS-#189 (o que mudou e por que estes testes mudaram):
 *   - Os 4 handlers (`handle*`) viraram UNIT-OF-WORK PURAS: recebem
 *     `(obj, tx)`, fazem só DB-writes via `tx`, e RETORNAM os side-effects
 *     (`{ emails?, audits? }`). NÃO emitem audit nem enviam email inline.
 *     => Os asserts deixaram de checar "sendTokenEmail foi chamado" e passaram
 *        a checar o VALOR RETORNADO (`result.emails`, `result.audits`).
 *   - `handleSubscriptionUpdated` não usa mais `prisma.$transaction([...])`:
 *     escreve sequencialmente via `tx.token.update` + `tx.user.update`.
 *     => Removidos os asserts de `$transaction toHaveBeenCalled`.
 *   - `handleCheckoutCompleted` cria token via `tx.token.create` SEM catch
 *     P2002: dentro da tx do orquestrador, um conflito aborta a transação e o
 *     retry do Stripe reprocessa. => o teste de P2002 agora PROPAGA o erro.
 *   - O controller virou fino: signature + circuit-breaker + delega a
 *     `processStripeEvent`. A dedup/lock/post-commit é testada em
 *     `webhook-idempotency.test.ts`. Aqui o orquestrador é MOCKADO para isolar
 *     a responsabilidade de BORDA do controller.
 *
 * Como os handlers só tocam `tx.*`, passamos o próprio `prismaMock` como `tx`
 * (`prismaMock as unknown as Prisma.TransactionClient`) — todos os setups
 * `prismaMock.user.upsert.mockResolvedValue(...)` continuam válidos.
 *
 * @owner: @tester
 * @card: #189
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

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
    $queryRaw: vi.fn(),
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

// Controller é fino: delega ao orquestrador. Mockamos `processStripeEvent`
// para isolar a BORDA (assinatura, circuit breaker, forgery audit, delegação).
// A lógica de dedup/lock/post-commit é coberta em webhook-idempotency.test.ts.
const processStripeEventMock = vi.fn().mockResolvedValue('processed')
vi.mock('../../src/modules/billing/webhook-idempotency', () => ({
  processStripeEvent: (...args: unknown[]) => processStripeEventMock(...args),
}))

// Mock do audit service — o controller ainda emite WEBHOOK_SIGNATURE_FAILED
// inline na borda. Demais audits saem do orquestrador (mockado aqui).
const emitAuditEventMock = vi.fn()
vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: (...args: unknown[]) => emitAuditEventMock(...args),
}))

// Circuit breaker — por default NÃO banido e recordFailure é no-op.
const isWebhookSignatureBannedMock = vi.fn().mockResolvedValue(false)
const recordWebhookSignatureFailureMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/lib/security/webhook-circuit-breaker', () => ({
  isWebhookSignatureBanned: (...args: unknown[]) =>
    isWebhookSignatureBannedMock(...args),
  recordWebhookSignatureFailure: (...args: unknown[]) =>
    recordWebhookSignatureFailureMock(...args),
}))

// --- Helpers ---

// O handler só toca `tx.*`. Passar o prismaMock como tx mantém todos os
// setups `prismaMock.<model>.<method>.mockResolvedValue(...)` funcionando.
const tx = prismaMock as unknown as Prisma.TransactionClient

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

function makeFastifyRequest(signature: string | undefined = 'sig_test') {
  return {
    ip: '203.0.113.7',
    headers: {
      'stripe-signature': signature,
      'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
    },
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

/** Executa todas as closures de email retornadas por um handler. */
async function runEmails(effects: { emails?: Array<() => Promise<void>> }) {
  for (const send of effects.emails ?? []) {
    await send()
  }
}

/** Extrai as AuditAction declaradas nos side-effects retornados. */
function auditActions(effects: { audits?: Array<{ action: string }> }) {
  return (effects.audits ?? []).map((a) => a.action)
}

// --- Tests ---

describe('Webhook (Card #189)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebhookSignatureBannedMock.mockResolvedValue(false)
    recordWebhookSignatureFailureMock.mockResolvedValue(undefined)
    processStripeEventMock.mockResolvedValue('processed')
  })

  // ===========================================
  // Controller (borda): signature + circuit breaker + delegação
  // ===========================================
  describe('stripeWebhook controller (borda)', () => {
    it('delega ao processStripeEvent e responde { received: true }', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(processStripeEventMock).toHaveBeenCalledTimes(1)
      const [passedEvent, ctx] = processStripeEventMock.mock.calls[0]!
      expect(passedEvent).toBe(event)
      expect(ctx).toMatchObject({
        ip: '203.0.113.7',
        userAgent: 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      })
      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })

    it('responde { received: true } também quando o orquestrador reporta duplicate', async () => {
      // Contrato: o response shape NÃO discrimina duplicate (webhookResponseSchema
      // só declara `received`). 200 idempotente em ambos os casos.
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      processStripeEventMock.mockResolvedValue('duplicate')

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await stripeWebhook(request, reply)

      expect(reply.send).toHaveBeenCalledWith({ received: true })
    })

    it('propaga erro do orquestrador (500 → Stripe redelivera)', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      processStripeEventMock.mockRejectedValue(new Error('DB down'))

      await expect(
        stripeWebhook(makeFastifyRequest(), makeFastifyReply()),
      ).rejects.toThrow('DB down')
    })

    it('header ausente: 400 WEBHOOK_SIGNATURE_INVALID + simetria forense F1 (record failure + audit signaturePresent:false), sem orquestrador', async () => {
      const request = {
        ip: '203.0.113.7',
        headers: { 'user-agent': 'Stripe/1.0' },
        body: Buffer.from('{}'),
        log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as Parameters<typeof stripeWebhook>[0]
      const reply = makeFastifyReply()

      // Card #215: header ausente é erro de CLIENTE → AppError 400 (não 500),
      // code estável WEBHOOK_SIGNATURE_INVALID (o branch AppError do handler
      // global serializa e NÃO dispara Sentry). Asserta o TIPO do erro, não só
      // "rejeitou" — uma mutação trocando 400→500 ou o code seria pega aqui.
      await expect(stripeWebhook(request, reply)).rejects.toMatchObject({
        statusCode: 400,
        code: 'WEBHOOK_SIGNATURE_INVALID',
      })

      // @security F1 (gate 7.5): simetria com o caminho de sig inválida — header
      // ausente também é probe/forgery e DEVE alimentar o circuit breaker +
      // audit_log A09. Sem estes asserts, apagar o record/audit do branch de
      // header ausente passaria verde (mutation-survivable). signaturePresent:false
      // é o discriminator que distingue dos dois caminhos forenses.
      expect(recordWebhookSignatureFailureMock).toHaveBeenCalledWith(
        '203.0.113.7',
      )
      const audited = emitAuditEventMock.mock.calls.map(
        (c) =>
          c[0] as {
            action: string
            metadata?: { signaturePresent?: boolean }
          },
      )
      const sigFailed = audited.find(
        (a) => a.action === AuditAction.WEBHOOK_SIGNATURE_FAILED,
      )
      expect(sigFailed).toBeDefined()
      expect(sigFailed?.metadata?.signaturePresent).toBe(false)

      // constructWebhookEvent nunca é chamado sem header; orquestrador idem.
      expect(processStripeEventMock).not.toHaveBeenCalled()
      expect(constructWebhookEvent).not.toHaveBeenCalled()
    })

    it('assinatura inválida: emite WEBHOOK_SIGNATURE_FAILED, registra no circuit breaker e propaga', async () => {
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
      expect(recordWebhookSignatureFailureMock).toHaveBeenCalledWith(
        '203.0.113.7',
      )
      const emitted = emitAuditEventMock.mock.calls.map(
        (c) => (c[0] as { action: string }).action,
      )
      expect(emitted).toContain(AuditAction.WEBHOOK_SIGNATURE_FAILED)
      // Nunca processa um evento com assinatura inválida.
      expect(processStripeEventMock).not.toHaveBeenCalled()
    })

    it('IP banido pelo circuit breaker: lança rateLimited antes de qualquer parsing', async () => {
      isWebhookSignatureBannedMock.mockResolvedValue(true)

      const request = makeFastifyRequest()
      const reply = makeFastifyReply()

      await expect(stripeWebhook(request, reply)).rejects.toMatchObject({
        statusCode: 429,
      })
      expect(constructWebhookEvent).not.toHaveBeenCalled()
      expect(processStripeEventMock).not.toHaveBeenCalled()
    })

    it('user-agent ausente → ctx.userAgent é null (fallback)', async () => {
      const event = makeStripeEvent()
      vi.mocked(constructWebhookEvent).mockReturnValue(event as never)
      const request = {
        ip: '203.0.113.7',
        headers: { 'stripe-signature': 'sig_test' }, // sem user-agent
        body: Buffer.from('{}'),
        log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      } as unknown as Parameters<typeof stripeWebhook>[0]

      await stripeWebhook(request, makeFastifyReply())

      const [, ctx] = processStripeEventMock.mock.calls[0]!
      expect(ctx).toMatchObject({ userAgent: null })
    })

    it('assinatura inválida: falha do circuit breaker é fire-and-forget (catch não vaza)', async () => {
      // Cobre o `.catch(() => {})` do recordWebhookSignatureFailure: mesmo que
      // o registro de falha rejeite, o handler propaga o erro de assinatura
      // original — nunca o erro do circuit breaker.
      vi.mocked(constructWebhookEvent).mockImplementation(() => {
        throw new Error('Invalid signature')
      })
      recordWebhookSignatureFailureMock.mockRejectedValue(
        new Error('redis down'),
      )

      const request = makeFastifyRequest()

      await expect(stripeWebhook(request, makeFastifyReply())).rejects.toThrow(
        'Invalid signature',
      )
      // Deixa o microtask do .catch(() => {}) drenar.
      await new Promise((resolve) => setImmediate(resolve))
      expect(recordWebhookSignatureFailureMock).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================
  // handleCheckoutCompleted — retorna side-effects
  // ===========================================
  describe('handleCheckoutCompleted', () => {
    it('cria user + token e RETORNA o email de token como side-effect', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.findUnique.mockResolvedValue(null)
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'token-1' })

      const result = await handleCheckoutCompleted(session as never, tx)

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
      // Side-effect declarado, NÃO executado pelo handler.
      expect(result.emails).toHaveLength(1)
      expect(sendTokenEmail).not.toHaveBeenCalled()
      // A closure, quando invocada, manda o email com o token gerado.
      await runEmails(result)
      expect(sendTokenEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@test.com' }),
      )
    })

    it('não cria token duplicado para mesmo user+subscription (sem email)', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
      })
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

      const result = await handleCheckoutCompleted(session as never, tx)

      expect(prismaMock.token.create).not.toHaveBeenCalled()
      expect(result.emails).toBeUndefined()
    })

    it('reativa token CANCELLED do mesmo user+subscription (sem novo email)', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
      })
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

      const result = await handleCheckoutCompleted(session as never, tx)

      expect(prismaMock.token.update).toHaveBeenCalledWith({
        where: { id: 'existing-token' },
        data: { status: 'ACTIVE', expiresAt: null },
      })
      expect(prismaMock.token.create).not.toHaveBeenCalled()
      expect(result.emails).toBeUndefined()
    })

    it('lança quando a session não tem email', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: null,
        customer_details: { email: null },
        customer: 'cus_test_123',
        subscription: 'sub_test_123',
      }

      await expect(
        handleCheckoutCompleted(session as never, tx),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('lança quando a session não tem customer', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: 'user@test.com',
        customer: null,
        subscription: 'sub_test_123',
      }

      await expect(
        handleCheckoutCompleted(session as never, tx),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('lança quando a session não tem subscription', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: 'user@test.com',
        customer: 'cus_test_123',
        subscription: null,
      }

      await expect(
        handleCheckoutCompleted(session as never, tx),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('PROPAGA P2002 em token.create (sem catch — rollback+retry converge)', async () => {
      // Mudança #189: o handler não engole mais P2002. Dentro da tx do
      // orquestrador, o conflito aborta a transação → status fica RECEIVED →
      // o retry do Stripe reprocessa e encontra o token já existente.
      const session = makeCheckoutSession()
      prismaMock.user.findUnique.mockResolvedValue(null)
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockRejectedValue(makeP2002Error())

      await expect(
        handleCheckoutCompleted(session as never, tx),
      ).rejects.toMatchObject({ code: 'P2002' })
    })

    it('propaga erro não-P2002 de token.create', async () => {
      const session = makeCheckoutSession()
      prismaMock.user.findUnique.mockResolvedValue(null)
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockRejectedValue(new Error('DB connection lost'))

      await expect(
        handleCheckoutCompleted(session as never, tx),
      ).rejects.toThrow('DB connection lost')
    })

    it('resolve customer/subscription quando vêm como objeto expandido', async () => {
      const session = {
        id: 'cs_test_123',
        customer_email: 'user@test.com',
        customer_details: { email: 'user@test.com' },
        customer: { id: 'cus_obj_123' },
        subscription: { id: 'sub_obj_123' },
      }
      prismaMock.user.findUnique.mockResolvedValue(null)
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'token-1' })

      await handleCheckoutCompleted(session as never, tx)

      expect(prismaMock.token.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stripeSubscriptionId: 'sub_obj_123',
          }),
        }),
      )
    })

    it('RETORNA audit ACCOUNT_CREATED quando o user é novo', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null)
      prismaMock.user.upsert.mockResolvedValue({
        id: 'user-new',
        email: 'newuser@test.com',
        role: 'PRO',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.token.create.mockResolvedValue({ id: 'tok-1' })

      const result = await handleCheckoutCompleted(
        {
          customer_email: 'newuser@test.com',
          customer: 'cus_new',
          subscription: 'sub_new',
        } as never,
        tx,
      )

      expect(auditActions(result)).toContain(AuditAction.ACCOUNT_CREATED)
    })

    it('RETORNA audit ROLE_CHANGED ao promover user FREE→PRO (sem ACCOUNT_CREATED)', async () => {
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

      const result = await handleCheckoutCompleted(
        {
          customer_email: 'existing@test.com',
          customer: 'cus_existing',
          subscription: 'sub_existing',
        } as never,
        tx,
      )

      const actions = auditActions(result)
      expect(actions).toContain(AuditAction.ROLE_CHANGED)
      expect(actions).not.toContain(AuditAction.ACCOUNT_CREATED)
    })

    it('NÃO retorna audit de privilégio quando user já era PRO (idempotência)', async () => {
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

      const result = await handleCheckoutCompleted(
        {
          customer_email: 'pro@test.com',
          customer: 'cus_pro',
          subscription: 'sub_pro',
        } as never,
        tx,
      )

      const actions = auditActions(result)
      expect(actions).not.toContain(AuditAction.ROLE_CHANGED)
      expect(actions).not.toContain(AuditAction.ACCOUNT_CREATED)
    })
  })

  // ===========================================
  // handleSubscriptionUpdated — writes sequenciais via tx
  // ===========================================
  describe('handleSubscriptionUpdated', () => {
    it('atualiza token e role via tx.token.update + tx.user.update (sem $transaction interno)', async () => {
      const subscription = {
        id: 'sub_test_123',
        customer: 'cus_test_123',
        status: 'active',
      }
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(subscription as never, tx)

      // Writes sequenciais — NÃO mais batch $transaction.
      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.token.update).toHaveBeenCalledTimes(1)
      expect(prismaMock.user.update).toHaveBeenCalledTimes(1)
    })

    it('lança quando o customer não é encontrado', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(
        handleSubscriptionUpdated(
          {
            id: 'sub_test_123',
            customer: 'cus_unknown',
            status: 'active',
          } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('lança quando o token não é encontrado para o user', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      await expect(
        handleSubscriptionUpdated(
          {
            id: 'sub_test_123',
            customer: 'cus_test_123',
            status: 'active',
          } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('status canceled → token CANCELLED mantendo role PRO (período de graça)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'canceled',
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { role: 'PRO' } }),
      )
    })

    it('status past_due → ACTIVE com expiresAt = current_period_end', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'past_due',
          current_period_end: periodEnd,
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: new Date(periodEnd * 1000),
          }),
        }),
      )
    })

    it('status unpaid → mesma lógica de past_due (ACTIVE + expiresAt)', async () => {
      const periodEnd = Math.floor(Date.now() / 1000) + 86400
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'unpaid',
          current_period_end: periodEnd,
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: new Date(periodEnd * 1000),
          }),
        }),
      )
    })

    it('status past_due sem current_period_end → expiresAt null', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'past_due',
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE', expiresAt: null }),
        }),
      )
    })

    it('status trialing → ACTIVE + role PRO', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'trialing',
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { role: 'PRO' } }),
      )
    })

    it('status incomplete_expired → EXPIRED + role FREE', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'incomplete_expired',
        } as never,
        tx,
      )

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'EXPIRED' }),
        }),
      )
      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { role: 'FREE' } }),
      )
    })

    it('RETORNA audit ROLE_CHANGED com from/to quando o role muda (downgrade)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      const result = await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'incomplete_expired',
        } as never,
        tx,
      )

      const roleChanged = (result.audits ?? []).find(
        (a) => a.action === AuditAction.ROLE_CHANGED,
      )
      expect(roleChanged).toBeDefined()
      expect(roleChanged?.metadata).toMatchObject({ from: 'PRO', to: 'FREE' })
    })

    it('NÃO retorna ROLE_CHANGED quando o role não muda (retry idempotente)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      const result = await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: 'cus_test_123',
          status: 'active',
        } as never,
        tx,
      )

      expect(auditActions(result)).not.toContain(AuditAction.ROLE_CHANGED)
    })

    it('resolve customerId quando customer vem como objeto', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'PRO',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue({
        id: 'token-1',
        userId: 'user-1',
      })
      prismaMock.token.update.mockResolvedValue({})
      prismaMock.user.update.mockResolvedValue({})

      await handleSubscriptionUpdated(
        {
          id: 'sub_test_123',
          customer: { id: 'cus_test_123' },
          status: 'active',
        } as never,
        tx,
      )

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
    })

    it('lança quando customer é null (sem customerId extraível)', async () => {
      await expect(
        handleSubscriptionUpdated(
          { id: 'sub_test_123', customer: null, status: 'active' } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })
  })

  // ===========================================
  // handleSubscriptionDeleted — retorna email de cancelamento
  // ===========================================
  describe('handleSubscriptionDeleted', () => {
    it('marca token CANCELLED e RETORNA email de cancelamento', async () => {
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

      const result = await handleSubscriptionDeleted(subscription as never, tx)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'token-1' },
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      )
      expect(result.emails).toHaveLength(1)
      expect(sendCancellationEmail).not.toHaveBeenCalled()
      await runEmails(result)
      expect(sendCancellationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'user@test.com' }),
      )
    })

    it('lança quando user não encontrado', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(
        handleSubscriptionDeleted(
          {
            id: 'sub_test_123',
            customer: 'cus_unknown',
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
          } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('lança quando token não encontrado', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      await expect(
        handleSubscriptionDeleted(
          {
            id: 'sub_test_123',
            customer: 'cus_test_123',
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
          } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('usa data atual como gracePeriodEnd quando current_period_end ausente', async () => {
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

      await handleSubscriptionDeleted(
        { id: 'sub_test_123', customer: 'cus_test_123' } as never,
        tx,
      )

      const updateCall = prismaMock.token.update.mock.calls[0]![0] as {
        data: { expiresAt: unknown }
      }
      expect(updateCall.data.expiresAt).toBeInstanceOf(Date)
    })

    it('resolve customerId quando customer vem como objeto', async () => {
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

      await handleSubscriptionDeleted(
        {
          id: 'sub_test_123',
          customer: { id: 'cus_test_123' },
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        } as never,
        tx,
      )

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
    })

    it('lança quando customer é null', async () => {
      await expect(
        handleSubscriptionDeleted(
          {
            id: 'sub_test_123',
            customer: null,
            current_period_end: Math.floor(Date.now() / 1000) + 86400,
          } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })
  })

  // ===========================================
  // handlePaymentFailed — retorna audit + email
  // ===========================================
  describe('handlePaymentFailed', () => {
    it('RETORNA audit PAYMENT_FAILED (success:false) + email de cobrança recusada', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      const result = await handlePaymentFailed(
        { id: 'in_test_123', customer: 'cus_test_123' } as never,
        tx,
      )

      const audit = (result.audits ?? []).find(
        (a) => a.action === AuditAction.PAYMENT_FAILED,
      )
      expect(audit).toBeDefined()
      expect(audit?.success).toBe(false)
      expect(audit?.metadata).toMatchObject({
        invoiceId: 'in_test_123',
        customerId: 'cus_test_123',
      })

      expect(result.emails).toHaveLength(1)
      expect(sendPaymentFailedEmail).not.toHaveBeenCalled()
      await runEmails(result)
      expect(sendPaymentFailedEmail).toHaveBeenCalledWith({
        to: 'user@test.com',
      })
    })

    it('lança quando customer não encontrado', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(
        handlePaymentFailed(
          { id: 'in_test_123', customer: 'cus_unknown' } as never,
          tx,
        ),
      ).rejects.toThrow('Erro ao processar webhook')
    })

    it('resolve customerId quando customer vem como objeto', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'user@test.com',
        stripeCustomerId: 'cus_test_123',
      })

      await handlePaymentFailed(
        { id: 'in_test_123', customer: { id: 'cus_test_123' } } as never,
        tx,
      )

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { stripeCustomerId: 'cus_test_123' },
      })
    })

    it('lança quando customer é null', async () => {
      await expect(
        handlePaymentFailed({ id: 'in_test_123', customer: null } as never, tx),
      ).rejects.toThrow('Erro ao processar webhook')
    })
  })
})
