/**
 * Card 2.3 — Schemas Zod das rotas /health/*.
 *
 * Schemas são SSOT do contrato (alimentam Swagger via fastify-type-provider-zod).
 * Mudar shape sem deprecação = breaking change (api-contract.md).
 *
 * Convenções aplicadas:
 *   - camelCase em todos os fields (api-contract.md)
 *   - Envelope `{ data: ... }` no top-level (nunca objeto solto)
 *   - `code` enum estável; `message` é texto livre, NÃO contrato
 *   - Discriminator-friendly: `status` é enum fechado em todos os níveis
 *
 * @owner: @reviewer (api-contract gate)
 */
import { z } from 'zod'

const checkStatusSchema = z.enum(['up', 'down', 'skipped'])

const checkCodeSchema = z.enum([
  'DB_TIMEOUT',
  'DB_ERROR',
  'REDIS_TIMEOUT',
  'REDIS_ERROR',
  'REDIS_NOT_CONFIGURED',
])

const checkResultSchema = z.object({
  status: checkStatusSchema,
  latencyMs: z.number().int().nonnegative(),
  code: checkCodeSchema.optional(),
})

const overallStatusSchema = z.enum(['ok', 'degraded'])

const snapshotSchema = z.object({
  status: overallStatusSchema,
  checks: z.object({
    db: checkResultSchema,
    redis: checkResultSchema,
  }),
  generatedAt: z.string().datetime(),
  cached: z.boolean(),
})

/**
 * `/health/live` — liveness probe.
 * Retorna SEMPRE `{data:{status:'ok'}}` se o processo conseguiu responder.
 * Sem checks externos, sem cache. Status code é único contrato relevante.
 */
export const liveResponseSchema = z.object({
  data: z.object({
    status: z.literal('ok'),
  }),
})

/**
 * `/health/ready` — readiness probe.
 * `200` = pronto pra tráfego; `503` = degraded.
 * Body shape é IDÊNTICO em ambos os status codes (orquestrador olha
 * primariamente o status code; humanos/dashboards olham o body).
 */
export const readyResponseSchema = z.object({
  data: snapshotSchema,
})

/**
 * Card #146 fix-pack ciclo 1 (@devops ALTO #1): scheduler watchdog.
 *
 * `lastCronRun` é snapshot de "quando cada cron rodou pela última vez".
 * Permite operador detectar via dashboard que cron está silenciado há > N horas
 * SEM precisar de external healthcheck. Combina com `cron.purge.pending_overdue`
 * (alerta Sentry quando gauge cresce) pra defesa em camadas.
 *
 * NÃO é alerta automático em si — é dado pro dashboard / external watchdog
 * decidir. Sentry Cron Monitoring é roadmap (Card #174 já no Backlog).
 *
 * `null` = nunca rodou (boot recente ou job nunca registrado).
 */
const lastCronRunSchema = z.object({
  jobName: z.string().min(1).max(80),
  /** ISO 8601 UTC OU null se nunca rodou desde boot atual. */
  lastRunStartedAt: z.string().datetime({ offset: true }).nullable(),
  /** Status terminal do último run; null durante run em andamento. */
  lastRunStatus: z
    .enum(['running', 'success', 'failure', 'skipped', 'expired'])
    .nullable(),
})

/**
 * `GET /health` — verbose para debug humano e dashboard.
 * Estende readiness com metadata: uptime do processo + scheduler watchdog.
 * `version` removido por segurança (reconnaissance — @security finding a7f3c2e1b9d4).
 * NÃO é probe — não usar em Fly.io health check config.
 */
export const healthVerboseResponseSchema = z.object({
  data: snapshotSchema.extend({
    uptimeSeconds: z.number().int().nonnegative(),
    /**
     * Card #146 fix-pack ciclo 1: watchdog scheduler in-memory.
     * Array vazio = nenhum cron registrado (cenário test ou bootstrap falhou).
     * Reflete histórico in-memory (não cron_runs DB) — mais rápido que query.
     */
    scheduler: z.object({
      jobsRegistered: z.number().int().nonnegative(),
      lastRuns: z.array(lastCronRunSchema),
    }),
  }),
})

/**
 * Erro genérico (rate limited 429). Reusa contrato padrão `{error:{code,message}}`.
 * Não importamos do auth.schema pra evitar acoplamento entre módulos.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})
