/**
 * Scheduler health snapshot — Card #145 (5.2a) F4.
 *
 * Adapta `SchedulerHealth` interno (cron.ts) → DTO público pro endpoint
 * admin GET /admin/jobs/list (card #159 discovery; rota completa em F5/F6).
 *
 * Whitelist explícita: response NÃO contém:
 *  - LockHandle.token (UUID v4 fencing — secret operacional)
 *  - JobRunMeta.error stack trace (sanitizado pra mensagem; controller corta)
 *  - Caminho interno do CronJobDefinition.handler (function reference)
 *
 * Padrão Tablix `api-contract.md`: envelope `{ data }`, camelCase, ISO 8601 UTC,
 * shapes EXPLÍCITOS (z.object, sem z.record).
 *
 * @owner: @planner + @reviewer
 * @card: #145 (5.2a) F4
 */
import { z } from 'zod'

import { getSchedulerHealth } from './cron'
import { getSchedulerMetrics } from './metrics'

// ============================================
// SCHEMAS (DTO público)
// ============================================

const jobRunSummarySchema = z.object({
  runId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  status: z.enum(['running', 'success', 'failure', 'skipped', 'expired']),
  /**
   * Mensagem de erro sanitizada (sem stack trace, max 200 chars). `null`
   * em runs success/skipped.
   */
  error: z.string().max(200).nullable(),
  /** Duração em ms. `null` durante execução em curso. */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Razão do skip (whitelist), `null` se status !== 'skipped'. */
  // F5 fix-pack @security BAIXO: removido 'redis_unavailable' — dead enum
  // value (lock.ts emite cron.lock.redis_unavailable como event, mas o
  // runner sempre seta skipReason='lock_not_acquired' independente da
  // causa). Se distinção for necessária no futuro, expor via campo
  // separado, não via enum stretching.
  skipReason: z
    .enum(['feature_disabled', 'test_env', 'lock_not_acquired'])
    .nullable(),
})

export const jobHealthSchema = z.object({
  jobName: z.string().min(1).max(80),
  enabled: z.boolean(),
  schedule: z.string().min(1).max(100),
  lastRun: jobRunSummarySchema.nullable(),
  /** Taxa de sucesso nas últimas 10 runs (0..1). 0 se nenhuma run. */
  successRate: z.number().min(0).max(1),
})

// Métricas in-memory expostas no DTO admin (Card #145 F5 — T5.1).
// Shapes ESPELHAM `SchedulerMetricsSnapshot` (metrics.ts) — mudança lá
// é breaking aqui também.
const runStatusEnum = z.enum(['success', 'failure', 'skipped', 'expired'])

const metricsSchema = z.object({
  /** Counter de runs por (jobName, status). Status whitelist. */
  runsTotal: z.array(
    z.object({
      jobName: z.string().min(1).max(80),
      status: runStatusEnum,
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Counter de skips por `lock_not_acquired` por jobName. */
  lockContentionTotal: z.array(
    z.object({
      jobName: z.string().min(1).max(80),
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Counter de releases pós-TTL (R-8) por jobName. */
  lockExpiredTotal: z.array(
    z.object({
      jobName: z.string().min(1).max(80),
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Última duração com sucesso (ms) por jobName. */
  lastDurationMs: z.array(
    z.object({
      jobName: z.string().min(1).max(80),
      durationMs: z.number().int().nonnegative(),
    }),
  ),
  /** Gauge fixo derivado de env.PRO_RETENTION_DAYS. */
  retentionDaysCurrent: z.number().int().positive().max(365),
})

export const cronHealthResponseSchema = z.object({
  data: z.object({
    jobs: z.array(jobHealthSchema),
    /** Quantidade total de jobs registrados. */
    totalJobs: z.number().int().nonnegative(),
    /** Snapshot in-memory de counters/gauges (F5 observability). */
    metrics: metricsSchema,
  }),
})

export type CronHealthResponse = z.infer<typeof cronHealthResponseSchema>
export type JobHealth = z.infer<typeof jobHealthSchema>

// ============================================
// ADAPTER
// ============================================

/**
 * Snapshot dos jobs registrados pra admin endpoint. Sanitiza datas
 * (ISO 8601 UTC) e omite secrets (token de lock, function refs).
 *
 * NÃO chamar em hot path — itera sobre todos jobs registrados.
 */
export function getCronHealthSnapshot(): CronHealthResponse {
  const internal = getSchedulerHealth()
  const metrics = getSchedulerMetrics()

  return {
    data: {
      jobs: internal.jobs.map((j) => ({
        jobName: j.jobName,
        enabled: j.enabled,
        schedule: j.schedule,
        lastRun:
          j.lastRun != null
            ? {
                runId: j.lastRun.runId,
                startedAt: j.lastRun.startedAt.toISOString(),
                finishedAt: j.lastRun.finishedAt?.toISOString() ?? null,
                status: j.lastRun.status,
                error: j.lastRun.error ?? null,
                durationMs: j.lastRun.durationMs ?? null,
                skipReason: j.lastRun.skipReason ?? null,
              }
            : null,
        successRate: j.successRate,
      })),
      totalJobs: internal.jobs.length,
      metrics: {
        runsTotal: metrics.runsTotal,
        lockContentionTotal: metrics.lockContentionTotal,
        lockExpiredTotal: metrics.lockExpiredTotal,
        lastDurationMs: metrics.lastDurationMs,
        retentionDaysCurrent: metrics.retentionDaysCurrent,
      },
    },
  }
}
