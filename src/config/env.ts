import 'dotenv/config'
import { z } from 'zod'

const isProd = process.env.NODE_ENV === 'production'

const envSchema = z
  .object({
    // Server
    PORT: z.coerce.number().default(3333),
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    API_URL: z.string().url().optional(),

    // Database
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),

    // Redis (Upstash)
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

    // Stripe
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Price IDs por moeda (psychological pricing por mercado)
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: z.string().optional(),
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: z.string().optional(),
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: z.string().optional(),
    STRIPE_PRO_YEARLY_USD_PRICE_ID: z.string().optional(),
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: z.string().optional(),
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: z.string().optional(),

    // Email
    EMAIL_PROVIDER: z.enum(['resend', 'sendgrid']).default('resend'),
    RESEND_API_KEY: z.string().optional(),
    FROM_EMAIL: z.string().default('Tablix <noreply@tablix.com.br>'),

    // JWT
    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_TOKEN_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_TOKEN_EXPIRES_IN: z.string().default('30d'),

    // Frontend
    FRONTEND_URL: z.string().url().default('http://localhost:3000'),

    // Logging (Card 2.1) — override opcional do nível default por NODE_ENV
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .optional(),

    // Sentry (Card 2.2) — error tracking + performance
    SENTRY_DSN: z
      .string()
      .url()
      .regex(
        /^https:\/\/[a-f0-9]+@[a-z0-9.-]+\.ingest\.(us|de)\.sentry\.io\/\d+$/,
        'SENTRY_DSN deve seguir o formato padrão https://<key>@<host>.ingest.<region>.sentry.io/<project_id>',
      )
      .optional()
      .or(z.literal('')),
    SENTRY_ENVIRONMENT: z
      .enum(['development', 'staging', 'production'])
      .default('development'),
    SENTRY_RELEASE: z.string().optional().or(z.literal('')),
    // F2 (@security): sample rates sem default fixo. Defaults seguros por
    // NODE_ENV são aplicados na superRefine abaixo (prod=0.1 traces / 0.05
    // profiles, staging=0.5 / 0.1, dev=1.0 / 1.0). 100% em prod = denial-of-
    // wallet + superfície amplificada de PII em profiling stacks.
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    SENTRY_AUTH_TOKEN: z.string().optional().or(z.literal('')),
    SENTRY_ORG: z.string().optional(),
    SENTRY_PROJECT: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // JWT_SECRET: rejeitar placeholders conhecidos
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
      // Stripe obrigatório em produção
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

      // Redis obrigatório em produção (rate limiting + concurrency guard)
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

      // Price IDs obrigatórios em produção (multi-currency)
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

      // Email obrigatório em produção
      if (!data.RESEND_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['RESEND_API_KEY'],
          message: 'RESEND_API_KEY é obrigatório em produção',
        })
      }

      // Sentry obrigatório em produção (error tracking + alerting)
      if (!data.SENTRY_DSN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SENTRY_DSN'],
          message:
            'SENTRY_DSN é obrigatório em produção (error tracking + LGPD)',
        })
      }

      // FRONTEND_URL deve ser HTTPS em produção (CORS seguro, sem localhost)
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

const _env = envSchema.safeParse(process.env)

if (_env.success === false) {
  console.error('Invalid environment variables!', _env.error.format())
  throw new Error('Invalid environment variables!')
}

// F2 (@security): aplica defaults prod-safe de sample rate por NODE_ENV.
// Zod superRefine não pode mutar data; resolvemos pós-parse. Prod é
// conservador (0.1 traces / 0.05 profiles) pra evitar denial-of-wallet e
// reduzir superfície de PII em profiling stacks.
function resolveSentryDefaults(nodeEnv: 'development' | 'production' | 'test') {
  switch (nodeEnv) {
    case 'production':
      return { traces: 0.1, profiles: 0.05 }
    case 'test':
      return { traces: 0, profiles: 0 }
    case 'development':
      return { traces: 1.0, profiles: 1.0 }
  }
}

const _sentryDefaults = resolveSentryDefaults(_env.data.NODE_ENV)

export const env = {
  ..._env.data,
  SENTRY_TRACES_SAMPLE_RATE:
    _env.data.SENTRY_TRACES_SAMPLE_RATE ?? _sentryDefaults.traces,
  SENTRY_PROFILES_SAMPLE_RATE:
    _env.data.SENTRY_PROFILES_SAMPLE_RATE ?? _sentryDefaults.profiles,
}
