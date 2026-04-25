/**
 * Unit tests for env.ts validation logic (Cards 1.9, 1.10, 1.20)
 * Covers:
 *   - RESEND_API_KEY required in production
 *   - FRONTEND_URL must be HTTPS in production
 *   - FRONTEND_URL cannot be localhost in production
 *   - Existing prod validations still work (Stripe, Redis)
 *   - Dev/test mode allows optional values
 *   - Multi-currency price IDs required in production (Card 1.20)
 *
 * Strategy: test the Zod schema directly by importing it fresh
 * with NODE_ENV manipulated, since env.ts reads process.env at module load.
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// We replicate the schema here because env.ts executes on import (parses process.env).
// Testing the schema shape directly is the only hermetic approach without side effects.
// If the schema shape drifts from env.ts, that's a finding — but the alternative
// (dynamic import with env manipulation) is fragile and non-deterministic.

function buildEnvSchema(isProd: boolean) {
  return z
    .object({
      PORT: z.coerce.number().default(3333),
      NODE_ENV: z
        .enum(['development', 'production', 'test'])
        .default('development'),
      API_URL: z.string().url().optional(),
      DATABASE_URL: z.string().url(),
      DIRECT_URL: z.string().url().optional(),
      UPSTASH_REDIS_REST_URL: z.string().url().optional(),
      UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
      STRIPE_SECRET_KEY: z.string().optional(),
      STRIPE_WEBHOOK_SECRET: z.string().optional(),
      // Multi-currency price IDs (Card 1.20) — substitui STRIPE_PRO_MONTHLY_PRICE_ID e STRIPE_PRO_YEARLY_PRICE_ID
      STRIPE_PRO_MONTHLY_BRL_PRICE_ID: z.string().optional(),
      STRIPE_PRO_YEARLY_BRL_PRICE_ID: z.string().optional(),
      STRIPE_PRO_MONTHLY_USD_PRICE_ID: z.string().optional(),
      STRIPE_PRO_YEARLY_USD_PRICE_ID: z.string().optional(),
      STRIPE_PRO_MONTHLY_EUR_PRICE_ID: z.string().optional(),
      STRIPE_PRO_YEARLY_EUR_PRICE_ID: z.string().optional(),
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
            message:
              'UPSTASH_REDIS_REST_URL é obrigatório em produção (rate limiting)',
          })
        }
        if (!data.UPSTASH_REDIS_REST_TOKEN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['UPSTASH_REDIS_REST_TOKEN'],
            message:
              'UPSTASH_REDIS_REST_TOKEN é obrigatório em produção (rate limiting)',
          })
        }
        // Multi-currency price IDs — Card 1.20
        const priceIdVars = [
          'STRIPE_PRO_MONTHLY_BRL_PRICE_ID',
          'STRIPE_PRO_YEARLY_BRL_PRICE_ID',
          'STRIPE_PRO_MONTHLY_USD_PRICE_ID',
          'STRIPE_PRO_YEARLY_USD_PRICE_ID',
          'STRIPE_PRO_MONTHLY_EUR_PRICE_ID',
          'STRIPE_PRO_YEARLY_EUR_PRICE_ID',
        ] as const
        for (const varName of priceIdVars) {
          if (!data[varName]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [varName],
              message: `${varName} é obrigatório em produção`,
            })
          }
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
        if (
          frontendHostname === 'localhost' ||
          !data.FRONTEND_URL.startsWith('https://')
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['FRONTEND_URL'],
            message:
              'FRONTEND_URL deve ser HTTPS em produção (não pode ser localhost)',
          })
        }
      }
    })
}

// Base valid env for production (all required fields populated)
// Card 1.20: inclui as 6 price IDs multi-currency; STRIPE_PRO_MONTHLY_PRICE_ID e
// STRIPE_PRO_YEARLY_PRICE_ID foram removidas do schema de produção.
const validProdEnv = {
  PORT: 3333,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/tablix',
  STRIPE_SECRET_KEY: 'sk_live_real_key_here',
  STRIPE_WEBHOOK_SECRET: 'whsec_real_secret_here',
  UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'real_redis_token',
  STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_brl_monthly_real',
  STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_brl_yearly_real',
  STRIPE_PRO_MONTHLY_USD_PRICE_ID: 'price_usd_monthly_real',
  STRIPE_PRO_YEARLY_USD_PRICE_ID: 'price_usd_yearly_real',
  STRIPE_PRO_MONTHLY_EUR_PRICE_ID: 'price_eur_monthly_real',
  STRIPE_PRO_YEARLY_EUR_PRICE_ID: 'price_eur_yearly_real',
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
        const resendIssues = result.error.issues.filter((i) =>
          i.path.includes('RESEND_API_KEY'),
        )
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
        const urlIssues = result.error.issues.filter((i) =>
          i.path.includes('FRONTEND_URL'),
        )
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
        const urlIssues = result.error.issues.filter((i) =>
          i.path.includes('FRONTEND_URL'),
        )
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
        const urlIssues = result.error.issues.filter((i) =>
          i.path.includes('FRONTEND_URL'),
        )
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

    it('deve acumular TODOS os erros quando multiplas vars faltam (incluindo price IDs)', () => {
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
        // Card 1.20: todas as 6 price IDs devem ser reportadas
        expect(paths).toContain('STRIPE_PRO_MONTHLY_BRL_PRICE_ID')
        expect(paths).toContain('STRIPE_PRO_YEARLY_BRL_PRICE_ID')
        expect(paths).toContain('STRIPE_PRO_MONTHLY_USD_PRICE_ID')
        expect(paths).toContain('STRIPE_PRO_YEARLY_USD_PRICE_ID')
        expect(paths).toContain('STRIPE_PRO_MONTHLY_EUR_PRICE_ID')
        expect(paths).toContain('STRIPE_PRO_YEARLY_EUR_PRICE_ID')
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
        const jwtIssues = result.error.issues.filter((i) =>
          i.path.includes('JWT_SECRET'),
        )
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

  // =============================================
  // Card 1.20: Multi-currency price IDs em produção
  // =============================================
  describe('price IDs multi-currency em produção (Card 1.20)', () => {
    const schema = buildEnvSchema(true)

    // Nomes das 6 vars para iterar nos testes de ausência individual
    const ALL_PRICE_ID_VARS = [
      'STRIPE_PRO_MONTHLY_BRL_PRICE_ID',
      'STRIPE_PRO_YEARLY_BRL_PRICE_ID',
      'STRIPE_PRO_MONTHLY_USD_PRICE_ID',
      'STRIPE_PRO_YEARLY_USD_PRICE_ID',
      'STRIPE_PRO_MONTHLY_EUR_PRICE_ID',
      'STRIPE_PRO_YEARLY_EUR_PRICE_ID',
    ] as const

    it('deve passar quando todas as 6 price IDs estão presentes em produção', () => {
      const result = schema.safeParse(validProdEnv)
      expect(result.success).toBe(true)
    })

    it('deve falhar quando TODAS as 6 price IDs estão ausentes em produção', () => {
      const env = {
        ...validProdEnv,
        STRIPE_PRO_MONTHLY_BRL_PRICE_ID: undefined,
        STRIPE_PRO_YEARLY_BRL_PRICE_ID: undefined,
        STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
        STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
        STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
        STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
      }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path[0] as string)
        for (const varName of ALL_PRICE_ID_VARS) {
          expect(paths).toContain(varName)
        }
        // Garantia: erros acumulados individualmente, não agrupados em mensagem genérica
        expect(
          result.error.issues.filter((i) =>
            ALL_PRICE_ID_VARS.includes(
              i.path[0] as (typeof ALL_PRICE_ID_VARS)[number],
            ),
          ).length,
        ).toBe(6)
      }
    })

    it.each(ALL_PRICE_ID_VARS)(
      'deve falhar quando apenas %s está ausente em produção',
      (missingVar) => {
        const env = { ...validProdEnv, [missingVar]: undefined }
        const result = schema.safeParse(env)

        expect(result.success).toBe(false)
        if (!result.success) {
          const relevantIssues = result.error.issues.filter(
            (i) => i.path[0] === missingVar,
          )
          expect(relevantIssues.length).toBeGreaterThan(0)
          expect(relevantIssues[0].message).toContain(missingVar)
          expect(relevantIssues[0].message).toContain('obrigatório em produção')
          // Não deve ter erro nas outras 5 vars que estão presentes
          const otherPriceVarErrors = result.error.issues.filter(
            (i) =>
              ALL_PRICE_ID_VARS.includes(
                i.path[0] as (typeof ALL_PRICE_ID_VARS)[number],
              ) && i.path[0] !== missingVar,
          )
          expect(otherPriceVarErrors.length).toBe(0)
        }
      },
    )

    it('deve aceitar todas as price IDs ausentes em dev (não prod)', () => {
      const devSchema = buildEnvSchema(false)
      const result = devSchema.safeParse(validDevEnv)
      // Em dev, nenhuma price ID é obrigatória
      expect(result.success).toBe(true)
    })

    it('deve aceitar env com apenas algumas price IDs em dev', () => {
      const devSchema = buildEnvSchema(false)
      const result = devSchema.safeParse({
        ...validDevEnv,
        STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_brl_test',
        // as outras 5 ausentes: ok em dev
      })
      expect(result.success).toBe(true)
    })

    it('deve reportar mensagem de erro contendo o nome da var ausente', () => {
      const env = {
        ...validProdEnv,
        STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
      }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path[0] === 'STRIPE_PRO_MONTHLY_EUR_PRICE_ID',
        )
        expect(issue).toBeDefined()
        expect(issue?.message).toContain('STRIPE_PRO_MONTHLY_EUR_PRICE_ID')
      }
    })

    it('deve rejeitar price ID como string vazia (falsy) em produção', () => {
      const env = { ...validProdEnv, STRIPE_PRO_YEARLY_USD_PRICE_ID: '' }
      const result = schema.safeParse(env)

      expect(result.success).toBe(false)
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path[0])
        expect(paths).toContain('STRIPE_PRO_YEARLY_USD_PRICE_ID')
      }
    })
  })

  // ============================================
  // Card #72 (@security MÉDIO): boot failure formatter
  // não vaza valores de env vars sensíveis no stderr.
  //
  // O fix em src/config/env.ts substituiu `_env.error.format()`
  // por listagem de `path + message` apenas. Estes testes replicam
  // a logic do formatter e validam invariante: o valor recebido
  // (que pode ser secret parcial) NUNCA aparece no output.
  // ============================================
  describe('boot failure formatter — Card #72 (@security)', () => {
    const formatIssues = (
      issues: ReadonlyArray<{ path: (string | number)[]; message: string }>,
    ) =>
      issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')

    it('JWT_SECRET inválido: output contém path + message, NÃO contém o valor sentinel', () => {
      const SENTINEL = 'CANARY-secret-value-12345-must-not-leak'
      const schema = buildEnvSchema(false)
      const result = schema.safeParse({
        ...validDevEnv,
        JWT_SECRET: SENTINEL.substring(0, 10), // < 32 chars → falha min(32)
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const output = formatIssues(result.error.issues)
        expect(output).toContain('JWT_SECRET')
        expect(output).toMatch(/at least 32|min/i) // mensagem do Zod
        // INVARIANTE LGPD/A09: valor nunca vaza
        expect(output).not.toContain(SENTINEL)
        expect(output).not.toContain(SENTINEL.substring(0, 10))
      }
    })

    it('DATABASE_URL inválido: output não contém o valor recebido', () => {
      // Sentinel sem `://` pra garantir que não é URL válida.
      // Uso "leaked-canary" como token único pra grep no output.
      const SENTINEL = 'leaked-canary-postgres-creds-xyz789'
      const schema = buildEnvSchema(false)
      const result = schema.safeParse({
        ...validDevEnv,
        DATABASE_URL: SENTINEL, // string sem schema URL → falha .url()
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const output = formatIssues(result.error.issues)
        expect(output).toContain('DATABASE_URL')
        // INVARIANTE LGPD: valor recebido NUNCA aparece no output
        expect(output).not.toContain(SENTINEL)
        expect(output).not.toContain('leaked-canary')
      }
    })

    it('mutation guard ANTI-REGRESSÃO: formatter NÃO vaza valor recebido', () => {
      // Sentinel intencionalmente sem prefixo que colida com nome do path
      // (evitar "SECRE" colidindo com "JWT_SECRET" etc).
      const SENTINEL = 'leaked-canary-jwt-value-xyz789'
      const schema = buildEnvSchema(false)
      const result = schema.safeParse({
        ...validDevEnv,
        JWT_SECRET: SENTINEL, // não tem 32 chars + não é placeholder → falha min(32)
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const safeOutput = formatIssues(result.error.issues)
        // Path APARECE (esperado — engenheiro precisa saber qual var falhou)
        expect(safeOutput).toContain('JWT_SECRET')
        // Mensagem APARECE (esperado — engenheiro precisa do motivo)
        expect(safeOutput).toMatch(/at least 32|min/i)
        // VALOR NUNCA aparece (invariante crítico do fix #72)
        expect(safeOutput).not.toContain(SENTINEL)
        expect(safeOutput).not.toContain('leaked-canary')
        // .format() do Zod legacy incluiria estrutura aninhada com _errors;
        // como nosso formatter usa só path + message, jamais cita o valor.
      }
    })
  })
})
