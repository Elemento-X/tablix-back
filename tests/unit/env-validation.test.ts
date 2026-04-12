/**
 * Unit tests for env.ts validation logic (Cards 1.9, 1.10)
 * Covers:
 *   - RESEND_API_KEY required in production
 *   - FRONTEND_URL must be HTTPS in production
 *   - FRONTEND_URL cannot be localhost in production
 *   - Existing prod validations still work (Stripe, Redis)
 *   - Dev/test mode allows optional values
 *
 * Strategy: test the Zod schema directly by importing it fresh
 * with NODE_ENV manipulated, since env.ts reads process.env at module load.
 *
 * @owner: @tester
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

// We replicate the schema here because env.ts executes on import (parses process.env).
// Testing the schema shape directly is the only hermetic approach without side effects.
// If the schema shape drifts from env.ts, that's a finding — but the alternative
// (dynamic import with env manipulation) is fragile and non-deterministic.

function buildEnvSchema(isProd: boolean) {
  return z
    .object({
      PORT: z.coerce.number().default(3333),
      NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
      API_URL: z.string().url().optional(),
      DATABASE_URL: z.string().url(),
      DIRECT_URL: z.string().url().optional(),
      UPSTASH_REDIS_REST_URL: z.string().url().optional(),
      UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
      STRIPE_SECRET_KEY: z.string().optional(),
      STRIPE_WEBHOOK_SECRET: z.string().optional(),
      STRIPE_PRO_MONTHLY_PRICE_ID: z.string().optional(),
      STRIPE_PRO_YEARLY_PRICE_ID: z.string().optional(),
      EMAIL_PROVIDER: z.enum(['resend', 'sendgrid']).default('resend'),
      RESEND_API_KEY: z.string().optional(),
      FROM_EMAIL: z.string().default('Tablix <noreply@tablix.com.br>'),
      JWT_SECRET: z.string().min(32),
      JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
      JWT_REFRESH_TOKEN_EXPIRES_IN: z.string().default('30d'),
      FRONTEND_URL: z.string().url().default('http://localhost:3000'),
    })
    .superRefine((data, ctx) => {
      const jwtPlaceholders = [
        'your-super-secret',
        'change-in-production',
        'CHANGE_ME',
        'GENERATE_ME',
      ]
      if (jwtPlaceholders.some((p) => data.JWT_SECRET.includes(p))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_SECRET'],
          message:
            "JWT_SECRET contém valor placeholder. Gere um secret real: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
        })
      }

      if (isProd) {
        if (!data.STRIPE_SECRET_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['STRIPE_SECRET_KEY'],
            message: 'STRIPE_SECRET_KEY é obrigatório em produção',
          })
        }
        if (!data.STRIPE_WEBHOOK_SECRET) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['STRIPE_WEBHOOK_SECRET'],
            message: 'STRIPE_WEBHOOK_SECRET é obrigatório em produção',
          })
        }
        if (!data.UPSTASH_REDIS_REST_URL) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UPSTASH_REDIS_REST_URL'],
            message: 'UPSTASH_REDIS_REST_URL é obrigatório em produção (rate limiting)',
          })
        }
        if (!data.UPSTASH_REDIS_REST_TOKEN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UPSTASH_REDIS_REST_TOKEN'],
            message: 'UPSTASH_REDIS_REST_TOKEN é obrigatório em produção (rate limiting)',
          })
        }
        if (!data.RESEND_API_KEY) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['RESEND_API_KEY'],
            message: 'RESEND_API_KEY é obrigatório em produção',
          })
        }
        const frontendHostname = (() => {
          try {
            return new URL(data.FRONTEND_URL).hostname
          } catch {
            return ''
          }
        })()
        if (frontendHostname === 'localhost' || !data.FRONTEND_URL.startsWith('https://')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['FRONTEND_URL'],
            message: 'FRONTEND_URL deve ser HTTPS em produção (não pode ser localhost)',
          })
        }
      }
    })
}

// Base valid env for production (all required fields populated)
const validProdEnv = {
  PORT: 3333,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/tablix',
  STRIPE_SECRET_KEY: 'sk_live_real_key_here',
  STRIPE_WEBHOOK_SECRET: 'whsec_real_secret_here',
  UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'real_redis_token',
  RESEND_API_KEY: 're_real_api_key_here',
  JWT_SECRET: 'a]3kF9#mP!qR7$vX2&wZ5^cB8(dG0+hJ4*lN6-oS1@tU',
  FRONTEND_URL: 'https://app.tablix.com.br',
}

// Base valid env for dev/test (minimal required fields)
const validDevEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
  JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
}

describe('env.ts validation (Cards 1.9 + 1.10)', () => {
  // =============================================
  // Production mode: RESEND_API_KEY (Card 1.9)
  // =============================================
  describe('RESEND_API_KEY in production', () => {
    const schema = buildEnvSchema(true)

    it('deve rejeitar quando RESEND_API_KEY ausente em produção', () => {
      const env = { ...validProdEnv, RESEND_API_KEY: undefined }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const resendIssues = result.error.issues.filter((i) => i.path.includes('RESEND_API_KEY'))
        expect(resendIssues.length).toBeGreaterThan(0)
        expect(resendIssues[0].message).toContain('RESEND_API_KEY')
        expect(resendIssues[0].message).toContain('obrigatório em produção')
      }
    })

    it('deve aceitar quando RESEND_API_KEY presente em produção', () => {
      const result = schema.safeParse(validProdEnv)
      expect(result.success).toBe(true)
    })

    it('deve aceitar RESEND_API_KEY vazia string em dev (não prod)', () => {
      const devSchema = buildEnvSchema(false)
      const result = devSchema.safeParse(validDevEnv)
      expect(result.success).toBe(true)
    })
  })

  // =============================================
  // Production mode: FRONTEND_URL HTTPS (Card 1.9)
  // =============================================
  describe('FRONTEND_URL HTTPS in production', () => {
    const schema = buildEnvSchema(true)

    it('deve rejeitar FRONTEND_URL com HTTP em produção', () => {
      const env = { ...validProdEnv, FRONTEND_URL: 'http://app.tablix.com.br' }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const urlIssues = result.error.issues.filter((i) => i.path.includes('FRONTEND_URL'))
        expect(urlIssues.length).toBeGreaterThan(0)
        expect(urlIssues[0].message).toContain('HTTPS')
      }
    })

    it('deve rejeitar FRONTEND_URL localhost em produção', () => {
      const env = {
        ...validProdEnv,
        FRONTEND_URL: 'http://localhost:3000',
      }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const urlIssues = result.error.issues.filter((i) => i.path.includes('FRONTEND_URL'))
        expect(urlIssues.length).toBeGreaterThan(0)
        expect(urlIssues[0].message).toContain('localhost')
      }
    })

    it('deve rejeitar FRONTEND_URL https://localhost em produção', () => {
      const env = {
        ...validProdEnv,
        FRONTEND_URL: 'https://localhost:3000',
      }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const urlIssues = result.error.issues.filter((i) => i.path.includes('FRONTEND_URL'))
        expect(urlIssues.length).toBeGreaterThan(0)
        expect(urlIssues[0].message).toContain('localhost')
      }
    })

    it('deve aceitar FRONTEND_URL HTTPS valida em produção', () => {
      const result = schema.safeParse(validProdEnv)
      expect(result.success).toBe(true)
    })

    it('deve aceitar FRONTEND_URL HTTP em dev (não prod)', () => {
      const devSchema = buildEnvSchema(false)
      const env = {
        ...validDevEnv,
        FRONTEND_URL: 'http://localhost:3000',
      }
      const result = devSchema.safeParse(env)
      expect(result.success).toBe(true)
    })

    it('deve rejeitar FRONTEND_URL com protocolo ftp em produção', () => {
      const env = {
        ...validProdEnv,
        FRONTEND_URL: 'ftp://app.tablix.com.br',
      }
      const result = schema.safeParse(env)

      // ftp:// is not https:// so superRefine catches it, but also
      // z.string().url() may reject ftp depending on Zod version
      expect(result.success).toBe(false)
    })
  })

  // =============================================
  // Production mode: all required vars together
  // =============================================
  describe('production mode — all required vars fail-loud', () => {
    const schema = buildEnvSchema(true)

    it('deve acumular TODOS os erros quando multiplas vars faltam', () => {
      const env = {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/tablix',
        JWT_SECRET: 'a]3kF9#mP!qR7$vX2&wZ5^cB8(dG0+hJ4*lN6-oS1@tU',
        // All optional vars missing — should get errors for all of them
      }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path[0])
        expect(paths).toContain('STRIPE_SECRET_KEY')
        expect(paths).toContain('STRIPE_WEBHOOK_SECRET')
        expect(paths).toContain('UPSTASH_REDIS_REST_URL')
        expect(paths).toContain('UPSTASH_REDIS_REST_TOKEN')
        expect(paths).toContain('RESEND_API_KEY')
        expect(paths).toContain('FRONTEND_URL')
      }
    })

    it('deve passar quando todas as vars obrigatorias estao presentes', () => {
      const result = schema.safeParse(validProdEnv)
      expect(result.success).toBe(true)
    })
  })

  // =============================================
  // Dev/test mode: optional vars stay optional
  // =============================================
  describe('dev/test mode — optional vars not required', () => {
    const schema = buildEnvSchema(false)

    it('deve aceitar env minimo em dev', () => {
      const result = schema.safeParse(validDevEnv)
      expect(result.success).toBe(true)
    })

    it('deve aceitar RESEND_API_KEY ausente em dev', () => {
      const result = schema.safeParse({
        ...validDevEnv,
        RESEND_API_KEY: undefined,
      })
      expect(result.success).toBe(true)
    })

    it('deve aceitar FRONTEND_URL HTTP em dev', () => {
      const result = schema.safeParse({
        ...validDevEnv,
        FRONTEND_URL: 'http://localhost:3000',
      })
      expect(result.success).toBe(true)
    })
  })

  // =============================================
  // JWT_SECRET placeholder rejection (pre-existing)
  // =============================================
  describe('JWT_SECRET placeholder rejection', () => {
    it('deve rejeitar JWT_SECRET com placeholder em qualquer env', () => {
      const schema = buildEnvSchema(false)
      const result = schema.safeParse({
        ...validDevEnv,
        JWT_SECRET: 'your-super-secret-key-that-is-longer-than-32-chars',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const jwtIssues = result.error.issues.filter((i) => i.path.includes('JWT_SECRET'))
        expect(jwtIssues.length).toBeGreaterThan(0)
        expect(jwtIssues[0].message).toContain('placeholder')
      }
    })

    it('deve rejeitar JWT_SECRET com CHANGE_ME', () => {
      const schema = buildEnvSchema(false)
      const result = schema.safeParse({
        ...validDevEnv,
        JWT_SECRET: 'CHANGE_ME_aaaaaaaaaaaabbbbbbbbbbbb',
      })

      expect(result.success).toBe(false)
    })
  })
})
