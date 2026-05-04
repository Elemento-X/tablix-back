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

    // Health checks (Card 2.3) — timeouts e cache tunable sem rebuild
    // Defaults seguros; override em prod via env var se Supabase/Upstash
    // em região distante ou com cold start atípico.
    HEALTH_TIMEOUT_DB_MS: z.coerce.number().int().positive().default(1000),
    HEALTH_TIMEOUT_REDIS_MS: z.coerce.number().int().positive().default(500),
    HEALTH_CACHE_TTL_MS: z.coerce.number().int().positive().default(2000),

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

    // Supabase Storage (Card 5.1 — Fase 5)
    // Auth dedicada ao Storage (NÃO reusar service_role do Prisma DB).
    // Decisão @planner D4 + @security hard-req #9: isolamento de uso reduz
    // blast radius operacional + permite rotação independente.
    //
    // SUPABASE_URL: regex anchor previne SSRF via config drift (atacante
    // interno troca pra https://attacker.com e adapter manda secret key
    // pro host). Mesmo padrão de SENTRY_DSN. Suporta domínios `.supabase.co`
    // (default) e `.supabase.in` (regiões alternativas).
    SUPABASE_URL: z
      .string()
      .url()
      .regex(
        /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i,
        'SUPABASE_URL deve seguir https://<project-ref>.supabase.(co|in)',
      )
      .optional(),
    SUPABASE_STORAGE_KEY: z.string().optional(),
    SUPABASE_STORAGE_BUCKET: z.string().optional(),

    // History opt-in feature (Card #145 — 5.2a — Fase 5 Storage).
    // 4 envs alinhadas com o plano fechado em 2026-05-02.
    //
    // HISTORY_FEATURE_ENABLED: kill-switch global. Default `false` em todos
    //   os ambientes (feature OFF até user ativar opt-in E env=true). Test
    //   também default false pra não disparar cron em test runs (R-5).
    //
    // CRON_PURGE_ENABLED: kill-switch específico do cron #146 (5.2b).
    //   Default false. Só ativa em prod quando 5.2b for implementado.
    //
    // PRO_RETENTION_DAYS: SSOT de retenção (D#2 fechada 2026-05-02).
    //   Range 1-365: < 1 quebra purge-on-disable (expira no passado);
    //   > 365 é risco LGPD (retenção excessiva sem justificativa legal).
    //   Default 30. Service via env.PRO_RETENTION_DAYS — NUNCA process.env.
    //
    // ADMIN_USER_IDS: allowlist de admin endpoints (Card #145 D#3 + WV-2026-006).
    //   CSV de UUIDs (mitigations 1+2 do D#3): Zod boot fail-fast em prod com
    //   UUID inválido, max 5 admins. Em dev/test pode ser vazio.
    //   Em prod, fail-fast se vazio (superRefine abaixo).
    //   Workaround temporário até enum UserRole separado (card #157).
    // F2 fix-pack @security BAIXO: `z.coerce.boolean("false")` retorna `true`
    // (qualquer string não-vazia é truthy em JS). Operador escrevendo
    // `HISTORY_FEATURE_ENABLED="false"` no .env LIGARIA a feature — kill-switch
    // quebrado. Solução: enum estrito com transform explícito.
    HISTORY_FEATURE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    CRON_PURGE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    PRO_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // Card #145 F4 fix-pack @security F-ALTO-02: secret separada do JWT_SECRET
    // pra step-up reauth (Mit 8 D#3). Comprometer JWT_SECRET NÃO deve
    // comprometer step-up MFA (defesa em profundidade — chave única por
    // propósito). Min 32 chars (mesma força do JWT_SECRET). Obrigatório em
    // prod quando HISTORY_FEATURE_ENABLED=true (admin endpoints expostos).
    ADMIN_STEPUP_SECRET: z.string().min(32).optional(),

    // Card #145 F4 fix-pack @devops: sleep grace antes de app.close em
    // SIGTERM. Fly.io HC interval ~10-15s; default 2s anterior era subdim.
    // Configurável pra ajustar quando fly.toml chegar (Fase 7).
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(15_000),
    ADMIN_USER_IDS: z
      .string()
      .optional()
      .default('')
      .transform((val, ctx) => {
        if (!val.trim()) return [] as string[]
        const parts = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const result: string[] = []
        // F2 fix-pack @security BAIXO: enforcing UUID lowercase strict.
        // Postgres gen_random_uuid() emite lowercase; operador colando UUID
        // uppercase passaria z.string().uuid() (case-insensitive) mas falharia
        // comparação no admin middleware → admin bypass silencioso.
        const lowercaseUuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        for (const p of parts) {
          if (!lowercaseUuidRegex.test(p)) {
            // Mensagem genérica — NUNCA incluir o valor parcial recebido
            // (segue mesmo pattern de redaction do JWT_SECRET, evita leak
            // do allowlist em logs de boot failure).
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                'ADMIN_USER_IDS contém valor que não é UUID v4 lowercase válido. Use CSV de UUIDs v4 (RFC 4122, lowercase) separados por vírgula.',
            })
            return z.NEVER
          }
          result.push(p)
        }
        if (result.length > 5) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ADMIN_USER_IDS aceita no máximo 5 admins (recebido ${result.length}). Esta é a mitigation 2 do WV-2026-006.`,
          })
          return z.NEVER
        }
        return result
      }),
  })
  .superRefine((data, ctx) => {
    // JWT_SECRET: rejeitar placeholders conhecidos
    const jwtPlaceholders = [
      'your-super-secret',
      'change-in-production',
      'CHANGE_ME',
      'GENERATE_ME',
      // Marcador de test-only usado em helpers (ex: tests/helpers/jwt-mock).
      // Vazar esse valor pra prod = JWT forjável por qualquer um com acesso
      // ao repo. Rejeita no boot independente de NODE_ENV.
      'FAKE_TEST_KEY',
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

      // Supabase Storage obrigatório em produção (Card 5.1 — Fase 5)
      if (!data.SUPABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_URL'],
          message: 'SUPABASE_URL é obrigatório em produção (Storage Card 5.1)',
        })
      }
      if (!data.SUPABASE_STORAGE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_STORAGE_KEY'],
          message:
            'SUPABASE_STORAGE_KEY é obrigatório em produção (Storage Card 5.1)',
        })
      }
      if (!data.SUPABASE_STORAGE_BUCKET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SUPABASE_STORAGE_BUCKET'],
          message:
            'SUPABASE_STORAGE_BUCKET é obrigatório em produção (Storage Card 5.1)',
        })
      }

      // ADMIN_USER_IDS obrigatório em produção quando HISTORY_FEATURE_ENABLED
      // (Card #145 D#3 mitigation 1 + WV-2026-006). Sem isso, admin endpoints
      // ficariam acessíveis a NINGUÉM em prod — mas pior, defense em
      // profundidade falha se um dia trocar pra "empty allowlist = wildcard".
      // Fail-fast no boot.
      if (data.HISTORY_FEATURE_ENABLED && data.ADMIN_USER_IDS.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_USER_IDS'],
          message:
            'ADMIN_USER_IDS é obrigatório em produção quando HISTORY_FEATURE_ENABLED=true (Card #145 D#3 + WV-2026-006). CSV de UUIDs separados por vírgula, mínimo 1, máximo 5.',
        })
      }

      // ADMIN_STEPUP_SECRET obrigatório em prod quando feature ativa (F4
      // @security F-ALTO-02). Sem secret separada, step-up reauth colapsa
      // junto com JWT_SECRET em comprometimento.
      if (data.HISTORY_FEATURE_ENABLED && !data.ADMIN_STEPUP_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_STEPUP_SECRET'],
          message:
            'ADMIN_STEPUP_SECRET é obrigatório em produção quando HISTORY_FEATURE_ENABLED=true (Card #145 F4 @security F-ALTO-02). Min 32 chars, separada do JWT_SECRET.',
        })
      }

      // Defense em profundidade: ADMIN_STEPUP_SECRET nunca pode ser igual ao
      // JWT_SECRET (operador acidentalmente reutilizando). Detecta drift cedo.
      if (
        data.ADMIN_STEPUP_SECRET &&
        data.ADMIN_STEPUP_SECRET === data.JWT_SECRET
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_STEPUP_SECRET'],
          message:
            "ADMIN_STEPUP_SECRET NÃO pode ser igual ao JWT_SECRET (CWE-321 secret reuse cross-purpose). Gere secret nova: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
        })
      }
    }
  })

const _env = envSchema.safeParse(process.env)

if (_env.success === false) {
  // Card #72 (@security MÉDIO): nunca emitir `_env.error.format()` —
  // inclui o VALOR recebido de cada campo. Se uma env var sensível
  // (JWT_SECRET, STRIPE_SECRET_KEY, DATABASE_URL) falhar a validação
  // com valor parcial preenchido, o stderr → log aggregator (CloudWatch,
  // Datadog, Logtail) vaza o secret. Lista apenas path + mensagem.
  const issues = _env.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  console.error(`Invalid environment variables:\n${issues}`)
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
