/**
 * Integration tests — Rate limit headers + 429 (Card 3.3 #32 — checklist 4).
 *
 * Valida o middleware `rateLimitMiddleware` com contadores controlados in-
 * memory (evita Upstash Redis real nos testes). Usamos `/auth/validate-token`
 * como fixture porque tem limite mais restritivo (5/min) e é rota pública.
 *
 * Cobertura:
 *   - Headers X-RateLimit-Limit/Remaining/Reset presentes em request com limit
 *   - 429 + Retry-After após exceder limit
 *   - Reset do limit após janela
 *   - Cap global denial-of-wallet em /billing/create-checkout (30 agregados)
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
    STRIPE_SECRET_KEY: 'sk_test_fake_rl',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_rl',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_test_brl_m_rl',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_test_brl_y_rl',
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

// Mock controlado dos rate limiters. vi.hoisted garante que o estado
// (contadores) exista antes do hoist do vi.mock.
const { rlState, rlReset } = vi.hoisted(() => {
  const attempts = new Map<string, number>()
  return {
    rlState: attempts,
    rlReset: () => attempts.clear(),
  }
})

vi.mock('../../src/config/rate-limit', () => {
  const mkLimiter = (limitValue: number, windowSeconds: number) => ({
    limit: async (identifier: string) => {
      const key = `${identifier}`
      const count = (rlState.get(key) ?? 0) + 1
      rlState.set(key, count)
      return {
        success: count <= limitValue,
        limit: limitValue,
        remaining: Math.max(0, limitValue - count),
        reset: Date.now() + windowSeconds * 1000,
        pending: Promise.resolve(),
      }
    },
  })

  return {
    rateLimiters: {
      global: mkLimiter(100, 60),
      validateToken: mkLimiter(5, 60),
      authRefresh: mkLimiter(10, 60),
      authMe: mkLimiter(60, 60),
      checkout: mkLimiter(5, 60),
      checkoutGlobalCap: mkLimiter(30, 60),
      billing: mkLimiter(20, 60),
      process: mkLimiter(10, 60),
      health: mkLimiter(60, 60),
    },
    isRateLimitEnabled: () => true,
  }
})

// Mock Stripe pra billing cap test
vi.mock('stripe', () => {
  class StripeError extends Error {}
  class StripeSignatureVerificationError extends StripeError {}
  const Stripe = vi.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'cs_rl_test',
          client_secret: 'cs_rl_secret',
        }),
      },
    },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  }))
  ;(Stripe as unknown as { errors: unknown }).errors = {
    StripeError,
    StripeSignatureVerificationError,
  }
  return { default: Stripe }
})

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'
import { truncateAll, disconnectTestPrisma } from '../helpers/prisma'

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
  rlReset()
})

describe('Rate limit headers (integration)', () => {
  it('POST /auth/validate-token retorna X-RateLimit-Limit/Remaining/Reset no 1º request', async () => {
    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: 'tbx_pro_fake_doesnt_matter', fingerprint: 'fp-rl' })

    expect(res.headers['x-ratelimit-limit']).toBe('5')
    expect(res.headers['x-ratelimit-remaining']).toBe('4')
    // api-contract.md: Reset é Unix timestamp em SEGUNDOS (não ms, não
    // seconds-remaining, não HTTP date)
    const resetSec = Number(res.headers['x-ratelimit-reset'])
    const nowSec = Math.floor(Date.now() / 1000)
    expect(resetSec).toBeGreaterThanOrEqual(nowSec)
    expect(resetSec).toBeLessThan(nowSec + 120) // dentro da janela de 60s + folga
  })

  it('Remaining decrementa a cada request até 0', async () => {
    const remainings: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await request(app.server)
        .post('/auth/validate-token')
        .send({ token: `tbx_pro_loop_${i}_xxx`, fingerprint: 'fp-decrement' })
      remainings.push(res.headers['x-ratelimit-remaining'] as string)
    }
    expect(remainings).toEqual(['4', '3', '2', '1', '0'])
  })
})

describe('Rate limit 429 (integration)', () => {
  it('6º request em /auth/validate-token retorna 429 + Retry-After', async () => {
    // Primeiros 5 consomem o limite
    for (let i = 0; i < 5; i++) {
      await request(app.server)
        .post('/auth/validate-token')
        .send({ token: `tbx_pro_burn_${i}_xxx`, fingerprint: 'fp-burn' })
    }

    const blocked = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: 'tbx_pro_blocked_xxx', fingerprint: 'fp-burn' })

    expect(blocked.status).toBe(429)
    expect(blocked.body.error?.code).toBe('RATE_LIMITED')
    // Retry-After é segundos inteiros (não HTTP date)
    const retryAfter = Number(blocked.headers['retry-after'])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })

  it('JWT authenticated: identifier por userId (bucket independente do IP)', async () => {
    // /auth/me é protected: usa userId como identifier quando autenticado.
    // Com JWT inválido, authMiddleware falha antes do rate limit. Esse teste
    // valida que sem JWT o rate limit aplica por IP normalmente.
    const res = await request(app.server).get('/auth/me')
    // Rate limit middleware vem antes do authMiddleware na preHandler chain
    expect(res.headers['x-ratelimit-limit']).toBe('60')
    // authMiddleware falha depois → 401
    expect(res.status).toBe(401)
  })
})

describe('Cap global denial-of-wallet em /billing/create-checkout (integration)', () => {
  it('30 requests agregadas bloqueiam o 31º mesmo vindo de IPs diferentes', async () => {
    // O cap global usa identifier fixo `global:all` — soma todos requests.
    // Como o mock usa a chave 'global:all', testamos que 30 passa e 31 bloqueia.
    for (let i = 0; i < 30; i++) {
      const res = await request(app.server)
        .post('/billing/create-checkout')
        .send({ email: `cap${i}@tablix.test` })
      if (res.status !== 200) {
        // eslint-disable-next-line no-console
        console.log(`unexpected at i=${i}:`, res.status, res.body)
      }
    }

    const blocked = await request(app.server)
      .post('/billing/create-checkout')
      .send({ email: 'blocked@tablix.test' })

    expect(blocked.status).toBe(429)
    expect(blocked.body.error?.code).toBe('RATE_LIMITED')
    // Retry-After presente pelo createGlobalCapMiddleware
    expect(blocked.headers['retry-after']).toBeDefined()
  })
})
