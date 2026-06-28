/**
 * Integration tests — Webhook Stripe (Card 3.3 #32 — checklist Billing 2).
 *
 * Valida `/webhooks/stripe` com signature válida/inválida, idempotência via
 * StripeEvent unique, e handlers de eventos (checkout.session.completed,
 * customer.subscription.updated, etc.).
 *
 * Stripe mockado via `vi.mock('stripe')`. Resend mockado pra não tentar
 * enviar email real em handleCheckoutCompleted.
 *
 * @owner: @tester
 * @card: 3.3
 */
/* eslint-disable import/first */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest'
import request from 'supertest'

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test' as const,
    API_URL: undefined,
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    DIRECT_URL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    STRIPE_SECRET_KEY: 'sk_test_fake_webhook',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_webhook_secret',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_test_brl_monthly',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_test_brl_yearly',
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
    EMAIL_PROVIDER: 'resend' as const,
    RESEND_API_KEY: 're_fake_webhook_test',
    FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    HEALTH_TIMEOUT_DB_MS: 1000,
    HEALTH_TIMEOUT_REDIS_MS: 500,
    HEALTH_CACHE_TTL_MS: 2000,
    LOG_LEVEL: undefined,
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: 'development' as const,
    SENTRY_RELEASE: undefined,
    SENTRY_TRACES_SAMPLE_RATE: 0,
    SENTRY_PROFILES_SAMPLE_RATE: 0,
    SENTRY_AUTH_TOKEN: undefined,
    SENTRY_ORG: undefined,
    SENTRY_PROJECT: undefined,
  },
}))

// Stripe mock com classe de erro customizada pra simular signature failure.
const { constructEventMock, sessionCreateMock, sendEmailMock } = vi.hoisted(
  () => ({
    constructEventMock: vi.fn(),
    sessionCreateMock: vi.fn(),
    sendEmailMock: vi.fn().mockResolvedValue({ data: { id: 'em_x' } }),
  }),
)
vi.mock('stripe', () => {
  class StripeError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'StripeError'
    }
  }
  class StripeSignatureVerificationError extends StripeError {
    constructor(msg = 'Invalid signature') {
      super(msg)
      this.name = 'StripeSignatureVerificationError'
    }
  }
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: sessionCreateMock } },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: constructEventMock },
    subscriptions: { retrieve: vi.fn() },
  }))
  ;(Stripe as unknown as { errors: unknown }).errors = {
    StripeError,
    StripeSignatureVerificationError,
  }
  return { default: Stripe }
})

// Resend mock pra não lançar em handleCheckoutCompleted
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendEmailMock },
  })),
}))

// Resolve para o mock de `vi.mock('stripe')` acima — usado pra lançar a CLASSE
// real StripeSignatureVerificationError nos testes (instanceof fiel ao prod).
import Stripe from 'stripe'
import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'
import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'

let app: TestApp

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await closeTestApp(app)
  await disconnectTestPrisma()
})

beforeEach(async () => {
  await truncateAll()
  constructEventMock.mockReset()
  sendEmailMock.mockClear()
})

const VALID_PAYLOAD = Buffer.from('{"fake":"raw-body"}')
const VALID_SIG = 't=1234,v1=abc,v0=def'

function makeCheckoutSessionEvent(
  overrides: {
    id?: string
    email?: string
    customerId?: string
    subscriptionId?: string
  } = {},
) {
  return {
    id: overrides.id ?? 'evt_test_checkout_' + Date.now(),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_session_abc',
        customer_email: overrides.email ?? 'buyer@tablix.test',
        customer: overrides.customerId ?? 'cus_test_abc',
        subscription: overrides.subscriptionId ?? 'sub_test_abc',
      },
    },
  }
}

describe('POST /webhooks/stripe — signature verification (integration)', () => {
  it('400 sem header stripe-signature (Card #215: erro de cliente, não 500)', async () => {
    const res = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(VALID_PAYLOAD.toString())

    // Card #215 (gate 7.5): ausência de header é erro de CLIENTE → 400 (era 500).
    // api-contract.md: validação = 400. NÃO dispara Sentry (AppError 400).
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('WEBHOOK_SIGNATURE_INVALID')
    expect(constructEventMock).not.toHaveBeenCalled()
  })

  it('400 com signature inválida e registra falha no circuit breaker', async () => {
    // Simula erro de verificação. O controller captura QUALQUER erro de
    // constructWebhookEvent e re-lança como Errors.webhookSignatureInvalid()
    // (400) — Card #215: forgery numa rota pública é erro de cliente, não 500,
    // e não deve disparar Sentry (o branch AppError do handler não captura).
    constructEventMock.mockImplementationOnce(() => {
      // Lança a CLASSE mockada (instanceof fiel ao prod) → constructWebhookEvent
      // mapeia pra webhookSignatureInvalid (400). Um Error genérico cairia no
      // re-throw de "erro inesperado" → 500, não refletindo o path de assinatura.
      throw new (
        Stripe as unknown as {
          errors: {
            StripeSignatureVerificationError: new (msg: string) => Error
          }
        }
      ).errors.StripeSignatureVerificationError('Invalid stripe signature')
    })

    const res = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 'invalid-signature')
      .send(VALID_PAYLOAD.toString())

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('WEBHOOK_SIGNATURE_INVALID')
    expect(constructEventMock).toHaveBeenCalledTimes(1)
  })

  it('200 com signature válida — constructEvent chamado com payload + signature + secret', async () => {
    const event = makeCheckoutSessionEvent({ id: 'evt_sig_ok_1' })
    constructEventMock.mockReturnValueOnce(event)

    const res = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())

    expect(res.status).toBe(200)
    expect(constructEventMock).toHaveBeenCalledTimes(1)
    const args = constructEventMock.mock.calls[0]
    expect(args[1]).toBe(VALID_SIG)
    expect(args[2]).toBe('whsec_fake_webhook_secret')
  })
})

describe('POST /webhooks/stripe — idempotência (integration)', () => {
  it('200 com event.id novo cria StripeEvent no DB', async () => {
    const event = makeCheckoutSessionEvent({ id: 'evt_idem_new_1' })
    constructEventMock.mockReturnValueOnce(event)

    await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
      .expect(200)

    const prisma = getTestPrisma()
    const stripeEvent = await prisma.stripeEvent.findUnique({
      where: { id: 'evt_idem_new_1' },
    })
    expect(stripeEvent).not.toBeNull()
    expect(stripeEvent?.type).toBe('checkout.session.completed')
  })

  it('mesmo event.id enviado 2x: 2º retorna 200 duplicate e não cria novo Token', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_dup_1',
      email: 'dup@tablix.test',
    })
    // Precisa mockar duas vezes (cada chamada ao endpoint chama constructEvent)
    constructEventMock.mockReturnValueOnce(event).mockReturnValueOnce(event)

    const first = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
    expect(first.status).toBe(200)

    const second = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
    expect(second.status).toBe(200)
    // NOTA: webhookResponseSchema só declara `received`; campo `duplicate`
    // é stripped pelo Fastify. Idempotência é validada via DB abaixo (1
    // StripeEvent registrado, 1 Token — sem duplicação).

    const prisma = getTestPrisma()
    const events = await prisma.stripeEvent.findMany({
      where: { id: 'evt_dup_1' },
    })
    expect(events).toHaveLength(1)

    // Só criou 1 Token (sem duplicar no replay)
    const tokens = await prisma.token.findMany({
      where: { user: { email: 'dup@tablix.test' } },
    })
    expect(tokens).toHaveLength(1)
  })
})

describe('POST /webhooks/stripe — checkout.session.completed (integration)', () => {
  it('200 cria User + Token Pro ativos', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_checkout_1',
      email: 'newuser@tablix.test',
      customerId: 'cus_newuser_123',
      subscriptionId: 'sub_newuser_123',
    })
    constructEventMock.mockReturnValueOnce(event)

    const res = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())

    expect(res.status).toBe(200)

    const prisma = getTestPrisma()
    const user = await prisma.user.findUnique({
      where: { email: 'newuser@tablix.test' },
    })
    expect(user).not.toBeNull()
    expect(user?.role).toBe('PRO')
    expect(user?.stripeCustomerId).toBe('cus_newuser_123')

    const token = await prisma.token.findFirst({
      where: { userId: user!.id },
    })
    expect(token).not.toBeNull()
    expect(token?.status).toBe('ACTIVE')
    expect(token?.stripeSubscriptionId).toBe('sub_newuser_123')
    expect(token?.token).toMatch(/^tbx_pro_/)
  })

  it('envia email com token via Resend (fire-and-forget)', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_email_1',
      email: 'emailme@tablix.test',
    })
    constructEventMock.mockReturnValueOnce(event)

    await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
      .expect(200)

    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const emailArgs = sendEmailMock.mock.calls[0][0]
    expect(emailArgs.to).toBe('emailme@tablix.test')
    expect(emailArgs.subject).toContain('token')
  })

  it('user existente: upsert atualiza para PRO sem duplicar', async () => {
    const prisma = getTestPrisma()
    await prisma.user.create({
      data: { email: 'existing@tablix.test', role: 'FREE' },
    })

    const event = makeCheckoutSessionEvent({
      id: 'evt_upgrade_1',
      email: 'existing@tablix.test',
      customerId: 'cus_upgrade_1',
      subscriptionId: 'sub_upgrade_1',
    })
    constructEventMock.mockReturnValueOnce(event)

    await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
      .expect(200)

    const users = await prisma.user.findMany({
      where: { email: 'existing@tablix.test' },
    })
    expect(users).toHaveLength(1)
    expect(users[0].role).toBe('PRO')
  })

  it('event.type desconhecido: 200 mas sem side effects', async () => {
    const unknownEvent = {
      id: 'evt_unknown_type_1',
      type: 'customer.created',
      data: { object: { id: 'cus_random' } },
    }
    constructEventMock.mockReturnValueOnce(unknownEvent)

    const res = await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())

    expect(res.status).toBe(200)

    const prisma = getTestPrisma()
    const stripeEvent = await prisma.stripeEvent.findUnique({
      where: { id: 'evt_unknown_type_1' },
    })
    expect(stripeEvent).not.toBeNull() // ainda registra pra dedup
    // Zero users criados
    const users = await prisma.user.findMany()
    expect(users).toHaveLength(0)
  })
})

describe('POST /webhooks/stripe — customer.subscription.updated (integration)', () => {
  it('atualiza status do Token baseado em subscription.status', async () => {
    // Seed: user + token existente
    const prisma = getTestPrisma()
    const user = await prisma.user.create({
      data: {
        email: 'subupd@tablix.test',
        role: 'PRO',
        stripeCustomerId: 'cus_subupd_1',
      },
    })
    await prisma.token.create({
      data: {
        userId: user.id,
        token: 'tbx_pro_subupd_' + Date.now(),
        stripeSubscriptionId: 'sub_subupd_1',
        status: 'ACTIVE',
      },
    })

    const event = {
      id: 'evt_subupd_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_subupd_1',
          customer: 'cus_subupd_1',
          status: 'canceled',
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
        },
      },
    }
    constructEventMock.mockReturnValueOnce(event)

    await request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(VALID_PAYLOAD.toString())
      .expect(200)

    const updated = await prisma.token.findFirst({
      where: { stripeSubscriptionId: 'sub_subupd_1' },
    })
    expect(updated?.status).toBe('CANCELLED')
  })
})

// ===========================================================================
// Card #189 — idempotent receiver RECEIVED → PROCESSED (DB real)
//
// O bug original: o controller gravava o event.id (autocommit) ANTES de
// processar. Uma falha transitória no handler deixava a row gravada mas o
// efeito (token+email) nunca acontecia; no retry, o INSERT batia o unique e o
// controller respondia "duplicate" sem reprocessar → cliente pagava e nunca
// recebia o token. Estes testes provam a correção contra Postgres real.
// ===========================================================================
describe('POST /webhooks/stripe — Card #189 idempotent receiver (integration)', () => {
  function deliver(payload = VALID_PAYLOAD) {
    return request(app.server)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', VALID_SIG)
      .send(payload.toString())
  }

  it('(a) evento novo: status PROCESSED + 1 token + 1 email', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_189_new',
      email: 'a189@tablix.test',
      customerId: 'cus_189_a',
      subscriptionId: 'sub_189_a',
    })
    constructEventMock.mockReturnValueOnce(event)

    await deliver().expect(200)

    const prisma = getTestPrisma()
    const stripeEvent = await prisma.stripeEvent.findUnique({
      where: { id: 'evt_189_new' },
    })
    expect(stripeEvent?.status).toBe('PROCESSED')
    expect(stripeEvent?.processedAt).not.toBeNull()

    const tokens = await prisma.token.findMany({
      where: { user: { email: 'a189@tablix.test' } },
    })
    expect(tokens).toHaveLength(1)
    expect(tokens[0].status).toBe('ACTIVE')
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('(b) PROVA DO FIX: stripe_event RECEIVED órfão sem token → reenvio reprocessa e CRIA o token', async () => {
    const prisma = getTestPrisma()
    // Simula a tentativa anterior que FALHOU pós-registro: a row existe com
    // status RECEIVED mas nenhum user/token foi criado. No código antigo, o
    // retry responderia "duplicate" e o cliente ficaria PARA SEMPRE sem token.
    await prisma.stripeEvent.create({
      data: {
        id: 'evt_189_orphan',
        type: 'checkout.session.completed',
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    })

    // Nenhum token existe ainda.
    const before = await prisma.token.findMany({
      where: { user: { email: 'orphan189@tablix.test' } },
    })
    expect(before).toHaveLength(0)

    // Stripe redelivera o MESMO event.id.
    const event = makeCheckoutSessionEvent({
      id: 'evt_189_orphan',
      email: 'orphan189@tablix.test',
      customerId: 'cus_189_orphan',
      subscriptionId: 'sub_189_orphan',
    })
    constructEventMock.mockReturnValueOnce(event)

    await deliver().expect(200)

    // O reenvio REPROCESSOU: token criado e evento agora PROCESSED.
    const after = await prisma.token.findMany({
      where: { user: { email: 'orphan189@tablix.test' } },
    })
    expect(after).toHaveLength(1)
    expect(after[0].status).toBe('ACTIVE')

    const stripeEvent = await prisma.stripeEvent.findUnique({
      where: { id: 'evt_189_orphan' },
    })
    expect(stripeEvent?.status).toBe('PROCESSED')
  })

  it('(c) evento já PROCESSED reenviado: 200 sem novo token nem novo email', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_189_dup',
      email: 'dup189@tablix.test',
      customerId: 'cus_189_dup',
      subscriptionId: 'sub_189_dup',
    })
    constructEventMock.mockReturnValueOnce(event).mockReturnValueOnce(event)

    await deliver().expect(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)

    // Segundo delivery do mesmo event.id (já PROCESSED).
    await deliver().expect(200)

    const prisma = getTestPrisma()
    const tokens = await prisma.token.findMany({
      where: { user: { email: 'dup189@tablix.test' } },
    })
    expect(tokens).toHaveLength(1)
    // Nenhum email adicional no replay.
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })

  it('(d) atomicidade: handler que falha → status permanece RECEIVED, sem efeito parcial', async () => {
    // customer.subscription.updated para um customer inexistente: o handler
    // lança DENTRO da tx → rollback → o flip para PROCESSED nunca acontece.
    // A row foi inserida (RECEIVED) ANTES da tx (gate de dedup) e persiste.
    const event = {
      id: 'evt_189_atomic',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_189_ghost',
          customer: 'cus_189_ghost', // não existe no DB
          status: 'active',
        },
      },
    }
    constructEventMock.mockReturnValueOnce(event)

    const res = await deliver()
    expect(res.status).toBe(500) // Stripe redelivera

    const prisma = getTestPrisma()
    const stripeEvent = await prisma.stripeEvent.findUnique({
      where: { id: 'evt_189_atomic' },
    })
    // Permanece RECEIVED — o retry vai reprocessar.
    expect(stripeEvent?.status).toBe('RECEIVED')
    expect(stripeEvent?.processedAt).toBeNull()

    // Nenhum efeito parcial.
    const tokens = await prisma.token.findMany()
    expect(tokens).toHaveLength(0)
  })

  it('(e) concorrência: 2 deliveries simultâneos do mesmo event.id → EXATAMENTE 1 token', async () => {
    const event = makeCheckoutSessionEvent({
      id: 'evt_189_race',
      email: 'race189@tablix.test',
      customerId: 'cus_189_race',
      subscriptionId: 'sub_189_race',
    })
    // Ambos os deliveries chamam constructEvent — retorna o mesmo evento.
    constructEventMock.mockReturnValue(event)

    const [r1, r2] = await Promise.all([deliver(), deliver()])

    // Pelo menos um concluiu com 200; o perdedor do advisory lock pode ter
    // recebido 500 (RECEIVED ainda não confirmado) OU 200 (já PROCESSED).
    // O invariante que importa: NUNCA mais de 1 token.
    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toContain(200)
    for (const s of statuses) {
      expect([200, 500]).toContain(s)
    }

    const prisma = getTestPrisma()
    const tokens = await prisma.token.findMany({
      where: { user: { email: 'race189@tablix.test' } },
    })
    expect(tokens).toHaveLength(1)

    // Exatamente 1 row de evento (PK colapsa os deliveries).
    const events = await prisma.stripeEvent.findMany({
      where: { id: 'evt_189_race' },
    })
    expect(events).toHaveLength(1)
  })
})
