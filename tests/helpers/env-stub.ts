/**
 * Environment stub for tests.
 * Provides deterministic env values that mirror src/config/env.ts shape
 * (post-superRefine + resolveSentryDefaults), so `vi.mock('src/config/env')`
 * via `mockEnvModule()` hands modules a fully-typed `env` object.
 *
 * Covers: Server, DB, Redis, Stripe (incl. multi-currency price IDs),
 * Email, JWT, Frontend, Health tunables (Card 2.3), Logger (Card 2.1),
 * Sentry (Card 2.2).
 *
 * @owner: @tester
 */
import { vi } from 'vitest'

// Fake key — NOT a real secret, only used in hermetic unit tests.
// Comprimento >= 32 para passar o .min(32) do Zod em env.ts.
const TEST_JWT_FAKE_KEY = 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc'

export const testEnv = {
  // Server
  PORT: 3333,
  NODE_ENV: 'test' as const,
  API_URL: undefined,

  // Database
  DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
  DIRECT_URL: undefined,

  // Redis (Upstash) — optional em test/dev, obrigatório em prod
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,

  // Stripe core
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,

  // Stripe price IDs (multi-currency — política fechada em 2026-04-20,
  // ver CLAUDE.md "Multi-currency billing"). Todos optional em test;
  // superRefine só exige em production.
  STRIPE_PRO_MONTHLY_BRL_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_BRL_PRICE_ID: undefined,
  STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
  STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,

  // Email
  EMAIL_PROVIDER: 'resend' as const,
  RESEND_API_KEY: undefined,
  FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',

  // JWT
  JWT_SECRET: TEST_JWT_FAKE_KEY,
  JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
  JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',

  // Frontend
  FRONTEND_URL: 'http://localhost:3000',

  // Health checks (Card 2.3)
  HEALTH_TIMEOUT_DB_MS: 1000,
  HEALTH_TIMEOUT_REDIS_MS: 500,
  HEALTH_CACHE_TTL_MS: 2000,

  // Logger (Card 2.1) — undefined = usa default por NODE_ENV
  LOG_LEVEL: undefined,

  // Sentry (Card 2.2) — sample rates resolvidos pós-parse em env.ts
  // Em NODE_ENV=test: traces=0 e profiles=0 (ver resolveSentryDefaults).
  SENTRY_DSN: undefined,
  SENTRY_ENVIRONMENT: 'development' as const,
  SENTRY_RELEASE: undefined,
  SENTRY_TRACES_SAMPLE_RATE: 0,
  SENTRY_PROFILES_SAMPLE_RATE: 0,
  SENTRY_AUTH_TOKEN: undefined,
  SENTRY_ORG: undefined,
  SENTRY_PROJECT: undefined,
}

/**
 * Mocks src/config/env so all modules that import { env } get deterministic values.
 * Chame no topo do teste (antes dos imports) via `vi.mock` hoisting, ou invoque
 * explicitamente em setup global.
 */
export function mockEnvModule() {
  vi.mock('../../src/config/env', () => ({
    env: { ...testEnv },
  }))
}

/**
 * Builder opcional para cenários que precisam override pontual (ex: testar
 * caminho de produção, Redis ativo, Sentry configurado). Sempre derive do
 * `testEnv` base pra manter campos obrigatórios.
 */
export function makeTestEnv(overrides: Partial<typeof testEnv> = {}) {
  return { ...testEnv, ...overrides }
}

export { TEST_JWT_FAKE_KEY }
