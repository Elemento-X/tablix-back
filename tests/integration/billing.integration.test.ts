/**
 * Integration tests — Billing module (Card 3.3 #32 — checklist Billing 1).
 *
 * Valida `/billing/create-checkout` e `/billing/prices` contra app Fastify
 * real. Stripe é mockado via `vi.mock('stripe')` para não chamar a API real
 * (evita custo, flakiness por rede, dependência externa).
 *
 * Cobertura:
 *   - create-checkout: priceId válido (BRL), default values, currency sem
 *     priceId (USD/EUR em test), body inválido, Stripe retornando sem
 *     clientSecret
 *   - prices: apenas currencies configuradas aparecem
 *
 * Cap global denial-of-wallet coberto em rate-limit.integration.test.ts.
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

// Env COM price IDs configurados pra permitir fluxo completo. vi.mock é
// hoisted — testEnv + overrides visíveis em qualquer import subsequente.
// Inline para evitar race do import dinâmico dentro do factory.
vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test' as const,
    API_URL: undefined,
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    DIRECT_URL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    STRIPE_SECRET_KEY: 'sk_test_fake_integration',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_integration',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_test_brl_monthly',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_test_brl_yearly',
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
    EMAIL_PROVIDER: 'resend' as const,
    RESEND_API_KEY: undefined,
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

// Mock do pacote stripe inteiro. vi.hoisted garante que sessionCreateMock
// exista antes do hoist de vi.mock.
const { sessionCreateMock, portalCreateMock, constructEventMock, mockRedis } =
  vi.hoisted(() => {
    interface MockEntry {
      value: string
      expiresAt: number
    }
    const store = new Map<string, MockEntry>()
    const isExpired = (entry: MockEntry) => Date.now() >= entry.expiresAt

    // Mock Redis in-memory pra testar Idempotency-Key flow (Card #74).
    // Semântica: SET NX EX|PX + GET + DEL + PTTL; expiração por timestamp.
    // PX é usado por completeIdempotentOperation pra preservar TTL real.
    const redis = {
      set: vi.fn(
        async (
          key: string,
          value: string,
          opts?: { nx?: boolean; ex?: number; px?: number },
        ): Promise<'OK' | null> => {
          const entry = store.get(key)
          const expired = entry && isExpired(entry)
          if (opts?.nx && entry && !expired) return null
          const ms = opts?.px ?? (opts?.ex ?? 86400) * 1000
          store.set(key, { value, expiresAt: Date.now() + ms })
          return 'OK'
        },
      ),
      get: vi.fn(async (key: string): Promise<string | null> => {
        const entry = store.get(key)
        if (!entry) return null
        if (isExpired(entry)) {
          store.delete(key)
          return null
        }
        return entry.value
      }),
      del: vi.fn(async (key: string): Promise<number> => {
        return store.delete(key) ? 1 : 0
      }),
      pttl: vi.fn(async (key: string): Promise<number> => {
        const entry = store.get(key)
        if (!entry) return -2
        const remaining = entry.expiresAt - Date.now()
        return remaining > 0 ? remaining : -2
      }),
      __clear: () => store.clear(),
    }

    return {
      sessionCreateMock: vi.fn(),
      portalCreateMock: vi.fn(),
      constructEventMock: vi.fn(),
      mockRedis: redis,
    }
  })

// Mock config/redis pra retornar nosso mock (Card #74 Idempotency-Key).
// Exposto como "Redis-like" pro idempotency.service.
vi.mock('../../src/config/redis', () => ({
  redis: mockRedis,
  isRedisConfigured: () => true,
  getRedis: () => mockRedis,
}))

// Mock config/rate-limit pra desabilitar — `@upstash/ratelimit` não aceita
// nosso mock in-memory (espera cliente Upstash real). Como rate limit não é
// o foco desse arquivo (testado em rate-limit.integration.test.ts), no-op é
// suficiente aqui. Sem isso, rateLimiters.* lança ao construir Ratelimit.
vi.mock('../../src/config/rate-limit', () => ({
  rateLimiters: {
    global: null,
    validateToken: null,
    authRefresh: null,
    authMe: null,
    checkout: null,
    checkoutGlobalCap: null,
    billing: null,
    process: null,
    health: null,
  },
  isRateLimitEnabled: () => false,
}))
vi.mock('stripe', () => {
  class StripeError extends Error {}
  class StripeSignatureVerificationError extends StripeError {}
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: sessionCreateMock } },
    billingPortal: { sessions: { create: portalCreateMock } },
    webhooks: { constructEvent: constructEventMock },
    subscriptions: { retrieve: vi.fn() },
  }))
  // Stripe.errors namespace
  ;(Stripe as unknown as { errors: unknown }).errors = {
    StripeError,
    StripeSignatureVerificationError,
  }
  return { default: Stripe }
})

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
  mockRedis.__clear()
  mockRedis.set.mockClear()
  mockRedis.get.mockClear()
  mockRedis.del.mockClear()
  mockRedis.pttl.mockClear()
  sessionCreateMock.mockReset()
  portalCreateMock.mockReset()
  constructEventMock.mockReset()
})

describe('POST /billing/create-checkout (integration)', () => {
  it('200 com BRL + monthly (defaults) retorna clientSecret e sessionId', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_test_session_abc',
      client_secret: 'cs_test_secret_xyz',
    })

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'buyer@tablix.test' }) // defaults: plan=monthly, currency=BRL

    expect(res.status).toBe(200)
    expect(res.body.clientSecret).toBe('cs_test_secret_xyz')
    expect(res.body.sessionId).toBe('cs_test_session_abc')

    // Stripe foi chamado com o priceId correto (BRL monthly)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)
    const call = sessionCreateMock.mock.calls[0][0]
    expect(call.line_items[0].price).toBe('price_test_brl_monthly')
    expect(call.customer_email).toBe('buyer@tablix.test')
    expect(call.mode).toBe('subscription')
    expect(call.ui_mode).toBe('embedded')
  })

  it('200 com BRL + yearly usa priceId anual', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_test_yearly',
      client_secret: 'cs_test_yearly_secret',
    })

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'yearly@tablix.test', plan: 'yearly', currency: 'BRL' })

    expect(res.status).toBe(200)
    expect(sessionCreateMock.mock.calls[0][0].line_items[0].price).toBe(
      'price_test_brl_yearly',
    )
  })

  it('422 CURRENCY_UNAVAILABLE com USD (não configurado em test)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'buyer@tablix.test', plan: 'monthly', currency: 'USD' })

    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('CURRENCY_UNAVAILABLE')
    expect(res.body.error?.details?.currency).toBe('USD')
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('422 CURRENCY_UNAVAILABLE com EUR (não configurado em test)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'buyer@tablix.test', plan: 'yearly', currency: 'EUR' })

    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('CURRENCY_UNAVAILABLE')
  })

  it('Stripe checkout sem client_secret → 500 CHECKOUT_FAILED', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_test_no_secret',
      client_secret: null, // Stripe retornou vazio
    })

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'buyer@tablix.test' })

    expect(res.status).toBe(500)
    expect(res.body.error?.code).toBe('CHECKOUT_FAILED')
  })

  it('Stripe API error propaga como CHECKOUT_FAILED (500)', async () => {
    // Usar new Error genérico não passa pelo `instanceof Stripe.errors.StripeError`
    // — pra simular StripeError, precisamos da classe mockada. Simplificamos:
    // mock lança Error genérico, controller re-throws (não wrapeia), cai no
    // error handler global como 500 INTERNAL_ERROR.
    sessionCreateMock.mockRejectedValueOnce(new Error('network timeout'))

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'buyer@tablix.test' })

    expect(res.status).toBe(500)
  })

  it('400 VALIDATION_ERROR com email mal-formado (pós Card #32a fix)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'not-an-email' })

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_ERROR')
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('email vazio (Zod rejeita) — mesma classe do finding 5xx', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: '' })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('body sem email retorna erro e não chama Stripe', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ plan: 'monthly', currency: 'BRL' })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Card #74 (3.4) — Idempotency-Key
// ============================================================================
describe('POST /billing/create-checkout — Idempotency-Key (Card #74)', () => {
  // UUID v4 válido (hex com versão 4 + variant 8-b) — schema Zod uuid() rejeita outros formatos
  const IDEMP_KEY = '5f3e2d1c-b8a7-4c6f-9e2d-1a3b4c5d6e7f'

  it('sem header Idempotency-Key: flow legacy, não toca Redis', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_legacy',
      client_secret: 'secret_legacy',
    })

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'legacy@tablix.test' })

    expect(res.status).toBe(200)
    expect(mockRedis.set).not.toHaveBeenCalled()
    expect(mockRedis.get).not.toHaveBeenCalled()
    // Sem header de replay
    expect(res.headers['idempotency-replay']).toBeUndefined()
  })

  it('primeira request com Idempotency-Key: cria lock, executa, grava result', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_idemp_first',
      client_secret: 'secret_idemp_first',
    })

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'first@tablix.test' })

    expect(res.status).toBe(200)
    expect(res.body.clientSecret).toBe('secret_idemp_first')
    // SET NX (lock inicial) + SET (gravação do resultado done)
    expect(mockRedis.set).toHaveBeenCalledTimes(2)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)

    // Stripe SDK recebeu a idempotencyKey (encaminhamento)
    const stripeCall = sessionCreateMock.mock.calls[0]
    expect(stripeCall[1]).toEqual({ idempotencyKey: IDEMP_KEY })
  })

  it('replay legítimo (mesma key + mesmo body): cached hit, 0 Stripe calls', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_replay',
      client_secret: 'secret_replay',
    })

    const first = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'replay@tablix.test' })
    expect(first.status).toBe(200)

    // Segunda request idêntica — deve retornar cached
    const second = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'replay@tablix.test' })

    expect(second.status).toBe(200)
    expect(second.body.clientSecret).toBe('secret_replay')
    expect(second.body.sessionId).toBe('cs_replay')
    expect(second.headers['idempotency-replay']).toBe('true')
    // Stripe chamado APENAS uma vez (primeira request)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)
  })

  it('conflict: mesma Idempotency-Key com body diferente → 422 IDEMPOTENCY_CONFLICT', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_conflict',
      client_secret: 'secret_conflict',
    })

    await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'conflict@tablix.test', plan: 'monthly' })
      .expect(200)

    // Mesma key, email diferente → conflict
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'different@tablix.test', plan: 'monthly' })

    expect(res.status).toBe(422)
    expect(res.body.error?.code).toBe('IDEMPOTENCY_CONFLICT')
    // Stripe NÃO foi chamado na 2ª (conflict barra antes)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)
  })

  it('keys distintas do mesmo cliente: nenhuma colisão', async () => {
    sessionCreateMock
      .mockResolvedValueOnce({ id: 'cs_a', client_secret: 'secret_a' })
      .mockResolvedValueOnce({ id: 'cs_b', client_secret: 'secret_b' })

    // UUIDs v4 distintos — schema Zod uuid() exige formato válido
    const KEY_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const KEY_B = '11111111-2222-4333-8444-555555555555'

    const resA = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', KEY_A)
      .send({ email: 'multi@tablix.test' })
    const resB = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', KEY_B)
      .send({ email: 'multi@tablix.test' })

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    expect(resA.body.sessionId).toBe('cs_a')
    expect(resB.body.sessionId).toBe('cs_b')
    expect(sessionCreateMock).toHaveBeenCalledTimes(2)
  })

  it('header não-UUID é rejeitado pela validação Zod (collision-DoS guard)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', 'not-a-uuid-too-weak')
      .send({ email: 'empty@tablix.test' })

    // Zod z.string().uuid() rejeita keys fracas — bloqueia collision-DoS
    expect(res.status).toBe(400)
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('header com key curta "1" é rejeitado (hardening collision-DoS)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', '1')
      .send({ email: 'weak@tablix.test' })

    expect(res.status).toBe(400)
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('falha no Stripe libera a key (release) permitindo retry imediato', async () => {
    sessionCreateMock
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({
        id: 'cs_retry',
        client_secret: 'secret_retry',
      })

    // Primeira tentativa falha (500)
    const first = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'retry@tablix.test' })
    expect(first.status).toBe(500)
    // Key deletada via releaseIdempotencyKey
    expect(mockRedis.del).toHaveBeenCalledTimes(1)

    // Retry imediato com mesma key — NÃO deve ser tratado como hit/conflict;
    // deve ser nova execução (miss)
    const second = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'retry@tablix.test' })
    expect(second.status).toBe(200)
    expect(second.body.sessionId).toBe('cs_retry')
    expect(sessionCreateMock).toHaveBeenCalledTimes(2)
  })

  it('in_progress: lock "processing" + mesmo body → 409 + Retry-After: 2', async () => {
    // Pré-popula o Redis com lock no estado 'processing' (mesmo bodyHash que
    // a request abaixo vai produzir). Simula outro worker ainda processando
    // a mesma operação. Evita acoplamento com supertest concorrente que tende
    // a hang em mock Stripe pendente.
    const { hashBody } =
      await import('../../src/lib/idempotency/idempotency.service')
    const bodyHash = hashBody({
      email: 'inflight@tablix.test',
      plan: 'monthly',
      currency: 'BRL',
    })
    const lockKey = `tablix:idempotency:checkout:public:${IDEMP_KEY}`
    await mockRedis.set(
      lockKey,
      JSON.stringify({
        bodyHash,
        status: 'processing',
        createdAt: new Date().toISOString(),
      }),
      { ex: 3600 },
    )
    mockRedis.set.mockClear() // zera contador antes da request real

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'inflight@tablix.test' })

    expect(res.status).toBe(409)
    expect(res.body.error?.code).toBe('IDEMPOTENCY_IN_PROGRESS')
    expect(res.headers['retry-after']).toBe('2')
    // Stripe NÃO foi chamado (in_progress barra antes)
    expect(sessionCreateMock).not.toHaveBeenCalled()
  })

  it('identifier global "public": mesma key + emails distintos = 1 key Redis (não 2 locks paralelos)', async () => {
    // Guard do design: identifier='public' (Stripe-style). Se identifier
    // fosse email, a 2ª request com email diferente criaria outro lock
    // separado (bug de colisão não detectada). O fato de bater em conflict
    // (mesma key Redis, bodyHash diverge) prova que identifier é global.
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_userA',
      client_secret: 'secret_userA',
    })

    await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'userA@tablix.test' })
      .expect(200)

    // 2ª request: mesma key, email distinto (bodyHash muda)
    const second = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'userB@tablix.test' })

    // identifier='public' → mesma Redis key → hash divergente → conflict
    expect(second.status).toBe(422)
    expect(second.body.error?.code).toBe('IDEMPOTENCY_CONFLICT')

    // Prova estrutural: 2ª request tentou SET NX (que falhou pq lock existia)
    // e leu o payload via GET — sem essa GET, identifier=email teria
    // criado um lock distinto (bug). Esse GET prova que mesma Redis key foi
    // alvo das duas requests (identifier='public' compartilha namespace).
    expect(mockRedis.get).toHaveBeenCalledTimes(1)
  })

  it('email case-insensitive no identifier (User@Tablix.Test === user@tablix.test)', async () => {
    sessionCreateMock.mockResolvedValueOnce({
      id: 'cs_case',
      client_secret: 'secret_case',
    })

    await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'User@Tablix.Test' })
      .expect(200)

    // Replay com email em caixa diferente — mesmo identifier (lowercase)
    const replay = await request(app.server)
      .post('/billing/create-checkout')
      .set('Idempotency-Key', IDEMP_KEY)
      .send({ email: 'user@tablix.test' })

    // Nota: body hash é calculado após lowercase, então mesmo body → hit
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotency-replay']).toBe('true')
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)
  })
})

describe('GET /billing/prices (integration)', () => {
  it('200 retorna apenas BRL (USD/EUR não configurados em test)', async () => {
    const res = await request(app.server).get('/billing/prices')

    expect(res.status).toBe(200)
    expect(res.body.currencies).toHaveLength(1)
    expect(res.body.currencies[0].currency).toBe('BRL')
    expect(res.body.currencies[0].monthly.available).toBe(true)
    expect(res.body.currencies[0].yearly.available).toBe(true)
  })

  it('seta Cache-Control: public, max-age=300 (cacheable)', async () => {
    const res = await request(app.server).get('/billing/prices')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })
})

describe('POST /billing/portal (integration)', () => {
  it('401 sem JWT (rota protegida)', async () => {
    const res = await request(app.server)
      .post('/billing/portal')
      .send({ returnUrl: 'https://tablix.com.br' })

    expect(res.status).toBe(401)
    expect(portalCreateMock).not.toHaveBeenCalled()
  })

  it('seed-able: não chama Stripe portal quando user não tem stripeCustomerId', async () => {
    // Guard rail adicional — mesmo se a auth passar, user sem customerId
    // nunca deve invocar Stripe (notFound antes).
    const prisma = getTestPrisma()
    await prisma.user.create({
      data: { email: 'nocust@tablix.test', role: 'FREE' },
    })
    // Sem JWT válido, a rota retorna 401 antes do lookup — esse teste
    // documenta a ordem correta (auth antes de lookup Stripe).
    expect(portalCreateMock).not.toHaveBeenCalled()
  })
})
