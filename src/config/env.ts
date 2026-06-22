import 'dotenv/config'
import { z } from 'zod'
import { redisHostsCollide } from './redis-host-guard'

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

    // Redis TCP DEDICADO ao BullMQ (Card 6.2 — Fase 6 Fila Assíncrona).
    // DB separado do rate-limit (políticas noeviction vs TTL incompatíveis +
    // isolamento de budget de comandos). Conexão real configurada em
    // src/config/redis-tcp.ts. A obrigatoriedade em produção é introduzida
    // junto com a flag ASYNC_PROCESSING_ENABLED no Card 6.3 — aqui só
    // validamos o FORMATO: se presente, DEVE ser rediss:// (TLS). redis://
    // sem TLS expõe credenciais e payload de inputs do usuário em trânsito.
    REDIS_URL: z
      .string()
      .url()
      .startsWith(
        'rediss://',
        'REDIS_URL deve usar TLS (rediss://, com dois "s") — redis:// sem ' +
          'TLS é rejeitado (credenciais e payload em texto claro no Upstash).',
      )
      .optional(),

    // Processamento assíncrono (Card 6.3 — Fase 6 Fila Assíncrona).
    // ASYNC_PROCESSING_ENABLED: flag de dark launch. Default false em todos os
    // ambientes — a rota POST /process/async NÃO é registrada enquanto off
    // (a feature nem existe publicamente). Enum estrito (não z.coerce.boolean,
    // que trata "false" como truthy — mesma armadilha do HISTORY_FEATURE_ENABLED).
    ASYNC_PROCESSING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // ASYNC_JOB_TTL_HOURS: janela até o cleanup (6.7) purgar output+inputs do
    // job async. Range 1h..168h (7d); default 24h. Tunável sem rebuild conforme
    // padrão do projeto (HEALTH_TIMEOUT_*, PRO_RETENTION_DAYS).
    ASYNC_JOB_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    // PROCESS_WORKER_TIMEOUT_MS: timeout DURO do parse por arquivo no worker
    // (Card 6.4). Excedido → o worker_thread é terminado (mata ReDoS/hang) e o
    // job vira FAILED permanente. Range 5s..600s; default 300s (5min). Tunável
    // sem rebuild. O timeout cobre o parse de UM arquivo, não o job inteiro.
    PROCESS_WORKER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(600_000)
      .default(300_000),
    // Crons de cleanup async (Card 6.7 + sweeper #197). Kill-switch DEDICADO
    // (não acoplado a HISTORY_FEATURE_ENABLED como os crons LGPD): gate efetivo
    // = ASYNC_PROCESSING_ENABLED && CRON_JOBS_CLEANUP_ENABLED. Default false em
    // todos os ambientes (cron não dispara sem ativação explícita). Enum estrito
    // (não z.coerce.boolean — "false" seria truthy).
    CRON_JOBS_CLEANUP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // ASYNC_PENDING_SWEEP_MINUTES: idade mínima de um Job PENDING pra ser
    // considerado órfão da fila pelo sweeper (#197). A SEGURANÇA vem deste
    // limiar (não da cadência do cron): um job recém-criado leva segundos pra
    // entrar na fila; só varremos bem depois disso. Range 5..1440min; default
    // 10min. Tunável sem rebuild.
    ASYNC_PENDING_SWEEP_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(1_440)
      .default(10),
    // ASYNC_STUCK_PROCESSING_MINUTES: idade mínima de um Job PROCESSING (por
    // started_at) pra ser candidato a force-fail (6.7b). Calibrar ACIMA do pior
    // caso de 1 tentativa do worker (15 arquivos × PROCESS_WORKER_TIMEOUT_MS).
    // O gate primário é o cross-check da fila (só falha se ausente/terminal nela);
    // este limiar é a 2ª barreira. Range 15..1440min; default 60min.
    ASYNC_STUCK_PROCESSING_MINUTES: z.coerce
      .number()
      .int()
      .min(15)
      .max(1_440)
      .default(60),

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
    // CRON_DRY_RUN (Card #146 F2): kill-switch suave do cron de purga. Quando
    // `true`, o handler em src/jobs/retention.job.ts loga "[DRY_RUN] would
    // purge N rows" mas NÃO toca DB nem Storage. Usado pra primeira execução
    // em prod pós-deploy (validar query SQL + path validation antes de purga
    // real). Documentado em docs/runbooks/purge-overshoot.md.
    //
    // Pattern enum estrito (não z.coerce.boolean) — mesma armadilha do
    // F2 fix-pack @security BAIXO em HISTORY_FEATURE_ENABLED.
    CRON_DRY_RUN: z
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

    // Card 6.2 fix-pack @dba MÉDIO — DB dedicado do BullMQ (D-1). No Upstash,
    // REST (rate-limit) e TCP (BullMQ) são apenas dois PROTOCOLOS do MESMO
    // database. Se REDIS_URL apontar pro mesmo host de UPSTASH_REDIS_REST_URL,
    // o "DB dedicado" quebra silenciosamente: as políticas noeviction (fila,
    // não pode perder job) e TTL/evicção (rate-limit) passam a compartilhar o
    // mesmo database — jobs em voo podem ser despejados (cliente paga e não
    // recebe output). Boot-fail barato contra essa misconfig, em qualquer
    // ambiente onde ambas as vars existam. Predicado puro testável em
    // `redis-host-guard.ts` (rede de regressão do guard — @reviewer F2).
    if (redisHostsCollide(data.REDIS_URL, data.UPSTASH_REDIS_REST_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message:
          'REDIS_URL (BullMQ/TCP) aponta para o MESMO host de ' +
          'UPSTASH_REDIS_REST_URL (rate-limit). O BullMQ exige um database ' +
          'Upstash DEDICADO (política noeviction) separado do rate-limit ' +
          '(TTL/evicção) — Card 6.2 D-1. Provisione um segundo database no ' +
          'Upstash para a fila.',
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

      // REDIS_URL (TCP/BullMQ) obrigatória em prod QUANDO o async está ligado
      // (Card 6.3). Sem a fila, /process/async não tem como enfileirar — boot
      // fail é melhor que 503 em runtime. O 6.2 deixou este gancho explícito.
      if (data.ASYNC_PROCESSING_ENABLED && !data.REDIS_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['REDIS_URL'],
          message:
            'REDIS_URL é obrigatória em produção quando ASYNC_PROCESSING_ENABLED=true ' +
            '(a fila BullMQ do /process/async exige Redis TCP dedicado — Card 6.3).',
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

// Card #146 fix-pack ciclo 1 (@devops MÉDIO): warning não-fatal no boot
// quando NODE_ENV=production && CRON_DRY_RUN=true. NÃO fail (dry-run em
// prod pode ser intencional pra validar primeira execução), mas STDERR
// dispara alerta visual nos logs do Fly.io. Combinado com emit ALERTABLE
// de cron.purge.dry_run.start em prod (src/scheduler/observability.ts),
// dry-run "esquecido" gera 2 sinais distintos.
if (_env.data.NODE_ENV === 'production' && _env.data.CRON_DRY_RUN) {
  console.warn(
    '[WARNING] CRON_DRY_RUN=true em NODE_ENV=production. ' +
      'O cron de purga LGPD vai LOGAR mas NÃO PURGAR. ' +
      'Confirme intencionalidade via runbook docs/runbooks/purge-overshoot.md. ' +
      'Card #146 fix-pack ciclo 1 (@devops).',
  )
}

export const env = {
  ..._env.data,
  SENTRY_TRACES_SAMPLE_RATE:
    _env.data.SENTRY_TRACES_SAMPLE_RATE ?? _sentryDefaults.traces,
  SENTRY_PROFILES_SAMPLE_RATE:
    _env.data.SENTRY_PROFILES_SAMPLE_RATE ?? _sentryDefaults.profiles,
}
