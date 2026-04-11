/**
 * Environment stub for tests.
 * Provides deterministic env values that pass Zod validation.
 *
 * @owner: @tester
 */
import { vi } from 'vitest'

// Fake key — NOT a real secret, only used in hermetic unit tests
const TEST_JWT_FAKE_KEY = 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc'

export const testEnv = {
  PORT: 3333,
  NODE_ENV: 'test' as const,
  API_URL: undefined,
  DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
  DIRECT_URL: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_PRO_MONTHLY_PRICE_ID: undefined,
  STRIPE_PRO_YEARLY_PRICE_ID: undefined,
  EMAIL_PROVIDER: 'resend' as const,
  RESEND_API_KEY: undefined,
  FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
  JWT_SECRET: TEST_JWT_FAKE_KEY,
  JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
  JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
  FRONTEND_URL: 'http://localhost:3000',
}

/**
 * Mocks src/config/env so all modules that import { env } get deterministic values.
 */
export function mockEnvModule() {
  vi.mock('../../src/config/env', () => ({
    env: { ...testEnv },
  }))
}

export { TEST_JWT_FAKE_KEY }
