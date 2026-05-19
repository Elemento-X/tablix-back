/**
 * Cron runner — Card #145 (5.2a) F4.
 *
 * Skeleton de scheduler com node-cron + Redis lock distribuído. Registra
 * jobs no boot, dispara handlers conforme schedule UTC, mantém histórico
 * de execução in-memory (limit 10 runs por job) pra `/health` admin.
 *
 * Skeleton-only em F4 — handlers reais vêm em #146 (5.2b purge) e #147
 * (5.2c quota alert). Esta fase entrega:
 *  - registerCronJob (boot-time registration)
 *  - runJobOnce (manual run via admin endpoint F5/F6)
 *  - getJobRunHistory (snapshot pra /health)
 *  - shutdown (cancela schedules, espera batch, libera locks)
 *
 * **Decisões fechadas (Card 5.2 + plano @planner v2.2):**
 *  - D-1: node-cron + Redis lock (não BullMQ — over-eng pra 5.2)
 *  - D-E: 1 lock POR JOB (não global) — jobs independentes não bloqueiam
 *  - R-5: skip se NODE_ENV==='test' — cron NÃO dispara em test runs
 *
 * **Hard requirements:**
 *  - Lock acquired ANTES do handler. Falha = skipReason='lock_not_acquired'
 *  - Heartbeat 60s durante handler. Lock perdido = abort + skipReason='expired'
 *  - Release no finally (idempotente)
 *  - Errors loggadas + Sentry breadcrumb (não derrubam o processo)
 *
 * @owner: @devops + @planner
 * @card: #145 (5.2a) F4
 */
import cron from 'node-cron'
import { randomUUID } from 'node:crypto'

import { env } from '../config/env'
import { logger } from '../lib/logger'
import { acquireLock } from './lock'
import { incLockContention, incRunsTotal, setLastDurationMs } from './metrics'
import { emitSchedulerEvent } from './observability'
import type {
  CronJobDefinition,
  JobRunMeta,
  LockHandle,
  SchedulerHealth,
} from './types'

// ============================================
// CONSTANTES
// ============================================

/**
 * Limit de runs por job mantido em memória pro /health. Jobs reais
 * rodam no máximo a cada 1h em prod (#146/#147 são daily). 10 runs
 * cobrem 10 dias de histórico — suficiente pra forensics ad-hoc.
 * Histórico longo vai pro Sentry/observability layer (F5).
 */
const RUN_HISTORY_PER_JOB_LIMIT = 10

/**
 * Heartbeat interval. 60s é suficientemente rápido pra detectar split-brain
 * (TTL default 15min permite ~15 batidas antes de expirar — folga 15x).
 */
const HEARTBEAT_INTERVAL_MS = 60 * 1000

/**
 * Cap defensive em inFlightRuns Set (F4 fix-pack @security F-BAIXO-01).
 * Cenário normal: 5 jobs × <2 runs concorrentes = ~10. Cap em 100 é
 * folga 10x — exceder = bug (cron disparando mais rápido que executa).
 * Logger emite alerta Sentry via observability layer (F5).
 */
const INFLIGHT_RUNS_CAP = 100

/**
 * Throttle do alerta `cron.run.inflight_cap_exceeded` — F5 fix-pack
 * @devops MÉDIO. Sem throttle, cron disparando a cada 5s com cap excedido
 * gera 12+ captureMessages/min no Sentry (mesma issue mas N events).
 * 5min de throttle preserva o sinal (primeiro alert é completo) e elimina
 * o flood. Estado in-memory por process; restart zera (aceitável — pior
 * caso é mais 1 alert pós-restart).
 */
const INFLIGHT_CAP_ALERT_THROTTLE_MS = 5 * 60 * 1000
const lastInflightCapAlertByJob = new Map<string, number>()

// ============================================
// STATE (in-memory, scoped por process)
// ============================================

/**
 * Registry de jobs ativos. Map<jobName, definition>. Escrita única no boot;
 * leitura via getJobRunHistory + admin endpoint.
 */
const jobs = new Map<string, CronJobDefinition>()

/**
 * node-cron tasks ativas (handle pra cancelar no shutdown). Map<jobName, task>.
 */
const tasks = new Map<string, cron.ScheduledTask>()

/**
 * Histórico de runs por job. Ring buffer manual com limit
 * RUN_HISTORY_PER_JOB_LIMIT. Map<jobName, runs[]>.
 */
const runHistory = new Map<string, JobRunMeta[]>()

/**
 * Promises de runs em andamento. Permite shutdown esperar batch in-flight
 * antes de derrubar processo. Set de Promise<void>.
 */
const inFlightRuns = new Set<Promise<void>>()

// ============================================
// HELPERS internos
// ============================================

/**
 * Adiciona run ao histórico in-memory respeitando o cap.
 */
function recordRun(jobName: string, meta: JobRunMeta): void {
  const list = runHistory.get(jobName) ?? []
  list.push(meta)
  if (list.length > RUN_HISTORY_PER_JOB_LIMIT) {
    list.shift()
  }
  runHistory.set(jobName, list)
}

/**
 * Sanitiza error message pra log/JobRunMeta. Remove stack trace, mantém
 * só `err.message`. Defesa contra leak de PII em mensagens de erro Postgres
 * (ex: "duplicate key violates unique constraint" pode incluir valor).
 *
 * Pattern Card #150 + audit-legal — log err.code, NUNCA err.message cru.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Limita a 200 chars + remove control chars básicos
    const msg = err.message.slice(0, 200).replace(/[\r\n\t]/g, ' ')
    return msg
  }
  return 'unknown error'
}

// ============================================
// JOB RUNNER (acquire → heartbeat → handler → release)
// ============================================

/**
 * Executa um job uma vez. Lifecycle completo:
 *  1. Verifica kill-switch (job.enabled) e NODE_ENV (R-5)
 *  2. Tenta acquireLock — skip se outro worker detém
 *  3. Inicia heartbeat 60s
 *  4. Executa handler com lock como param
 *  5. No finally: para heartbeat + release lock
 *  6. Registra JobRunMeta com status terminal
 *
 * **Errors NUNCA escalam pro caller** — runner é fire-and-forget pro
 * scheduler. Errors logadas + Sentry breadcrumb. Caller (admin endpoint)
 * recebe boolean success/skipped pra UX.
 *
 * @returns JobRunMeta com status terminal (success/failure/skipped/expired)
 */
async function runJob(job: CronJobDefinition): Promise<JobRunMeta> {
  const runId = randomUUID()
  const startedAt = new Date()
  const meta: JobRunMeta = {
    jobName: job.name,
    runId,
    startedAt,
    finishedAt: null,
    status: 'running',
  }

  // (1) Kill-switch check
  if (!job.enabled) {
    const finalMeta: JobRunMeta = {
      ...meta,
      finishedAt: new Date(),
      status: 'skipped',
      skipReason: 'feature_disabled',
      durationMs: 0,
    }
    recordRun(job.name, finalMeta)
    incRunsTotal(job.name, 'skipped')
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.run.skipped.feature_disabled',
      jobName: job.name,
      context: { runId },
    })
    return finalMeta
  }

  // (2) NODE_ENV gate (R-5: cron NÃO dispara em test runs)
  if (env.NODE_ENV === 'test') {
    const finalMeta: JobRunMeta = {
      ...meta,
      finishedAt: new Date(),
      status: 'skipped',
      skipReason: 'test_env',
      durationMs: 0,
    }
    recordRun(job.name, finalMeta)
    // Sem emit (test env não polui Sentry — beforeSend já dropa, mas
    // counter local também não tem valor analítico).
    return finalMeta
  }

  // (3) Acquire lock
  const lock = await acquireLock(job.name, job.lockTtlMs)
  if (!lock) {
    const finalMeta: JobRunMeta = {
      ...meta,
      finishedAt: new Date(),
      status: 'skipped',
      skipReason: 'lock_not_acquired',
      durationMs: 0,
    }
    recordRun(job.name, finalMeta)
    incRunsTotal(job.name, 'skipped')
    incLockContention(job.name)
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.run.skipped.lock_not_acquired',
      jobName: job.name,
      context: { runId },
    })
    return finalMeta
  }

  // (4) Heartbeat ticker — renova TTL durante handler longo
  let heartbeatTimer: NodeJS.Timeout | null = null
  let lockLost = false

  const startHeartbeat = (handle: LockHandle) => {
    heartbeatTimer = setInterval(() => {
      // Async IIFE com .catch — eslint no-void rejeita `void Promise`.
      // Defensive catch garante que heartbeat falho não derruba o ticker
      // (lockLost=true já é o sinal de abort pro handler).
      ;(async () => {
        const renewed = await handle.heartbeat()
        if (!renewed) {
          lockLost = true
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
        }
      })().catch((err) => {
        emitSchedulerEvent({
          level: 'error',
          event: 'cron.heartbeat.unexpected_error',
          jobName: handle.jobName,
          context: {
            errCode: err instanceof Error ? err.name : 'unknown',
            errMessage: sanitizeErrorMessage(err),
          },
        })
        lockLost = true
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  startHeartbeat(lock)

  // (5) Handler com lifecycle completo
  try {
    await job.handler(lock)

    if (lockLost) {
      // Heartbeat perdeu o lock durante execução (split-brain).
      // Handler pode ter feito write parcial — log warning + expired.
      const finalMeta: JobRunMeta = {
        ...meta,
        finishedAt: new Date(),
        status: 'expired',
        error: 'lock expired during handler execution',
        durationMs: Date.now() - startedAt.getTime(),
      }
      recordRun(job.name, finalMeta)
      incRunsTotal(job.name, 'expired')
      // Token omitido do context (secret operacional — fencing UUID).
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.run.expired',
        jobName: job.name,
        context: { runId, durationMs: finalMeta.durationMs },
      })
      return finalMeta
    }

    const finalMeta: JobRunMeta = {
      ...meta,
      finishedAt: new Date(),
      status: 'success',
      durationMs: Date.now() - startedAt.getTime(),
    }
    recordRun(job.name, finalMeta)
    incRunsTotal(job.name, 'success')
    // Gauge atualiza APENAS em success — failure/expired têm duration
    // truncada (handler abortou cedo), distorceria o gauge de saúde.
    setLastDurationMs(job.name, finalMeta.durationMs ?? 0)
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.run.success',
      jobName: job.name,
      context: { runId, durationMs: finalMeta.durationMs },
    })
    return finalMeta
  } catch (err) {
    const finalMeta: JobRunMeta = {
      ...meta,
      finishedAt: new Date(),
      status: 'failure',
      error: sanitizeErrorMessage(err),
      durationMs: Date.now() - startedAt.getTime(),
    }
    recordRun(job.name, finalMeta)
    incRunsTotal(job.name, 'failure')
    // F4 fix-pack @security F-MED-03: NUNCA passar `err` cru pro logger.
    // err.message Postgres pode incluir valores de UNIQUE violations
    // (ex: "duplicate key ... value (email='vitima@x.com')"). REDACT_PATHS
    // do Card 2.2 cobre paths conhecidos, NÃO err.message arbitrário.
    // Pattern Card #150: log err.code/name + sanitized message only.
    emitSchedulerEvent({
      level: 'error',
      event: 'cron.run.failure',
      jobName: job.name,
      context: {
        runId,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage: sanitizeErrorMessage(err),
        durationMs: finalMeta.durationMs,
      },
    })
    return finalMeta
  } finally {
    // (6) Cleanup — sempre: para heartbeat + libera lock
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
    }
    await lock.release()
  }
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Registra um cron job. Idempotente — re-registrar com mesmo nome
 * substitui a definição (e cancela o task antigo). Boot-time only;
 * não chamar em runtime.
 *
 * No-op se NODE_ENV==='test' (R-5: jobs nem são registrados em testes,
 * evita flake por cron disparando durante suite).
 */
export function registerCronJob(definition: CronJobDefinition): void {
  if (env.NODE_ENV === 'test') {
    logger.debug({ jobName: definition.name }, 'cron.register.skipped.test_env')
    return
  }

  // Cancel old task se existir (idempotência)
  const oldTask = tasks.get(definition.name)
  if (oldTask) {
    oldTask.stop()
    logger.info(
      { jobName: definition.name },
      'cron.register.replacing_old_task',
    )
  }

  jobs.set(definition.name, definition)

  // Schedule via node-cron. Timezone UTC.
  const task = cron.schedule(
    definition.schedule,
    () => {
      const promise = runJob(definition)
        .then(() => {
          /* swallow — runJob nunca throws */
        })
        .catch((err) => {
          // Defensive — runJob não deveria throw. F4 fix-pack @security
          // F-MED-03: log err.code/name + sanitized, NUNCA err raw.
          logger.error(
            {
              jobName: definition.name,
              errCode: err instanceof Error ? err.name : 'unknown',
              errMessage: sanitizeErrorMessage(err),
            },
            'cron.run.unexpected_throw',
          )
        })
        .finally(() => {
          inFlightRuns.delete(wrappedPromise)
        })
      const wrappedPromise = promise as Promise<void>
      // F4 fix-pack @security F-BAIXO-01: cap pra evitar Set unbounded.
      // 100 é folga 10x sobre cenário esperado (5 jobs × ~20 runs concorrentes
      // em pior caso). Excedê-lo é bug — alerta + drop pra evitar OOM.
      if (inFlightRuns.size >= INFLIGHT_RUNS_CAP) {
        // F5 fix-pack @devops MÉDIO: throttle 5min/job impede flood Sentry
        // quando cap permanece estourado por minutos (cron disparando 12+
        // vezes em 1min, todos hit no cap → 12+ captureMessages duplicados).
        const now = Date.now()
        const lastAlert = lastInflightCapAlertByJob.get(definition.name) ?? 0
        if (now - lastAlert >= INFLIGHT_CAP_ALERT_THROTTLE_MS) {
          lastInflightCapAlertByJob.set(definition.name, now)
          emitSchedulerEvent({
            level: 'error',
            event: 'cron.run.inflight_cap_exceeded',
            jobName: definition.name,
            context: {
              inFlightSize: inFlightRuns.size,
              cap: INFLIGHT_RUNS_CAP,
            },
          })
        }
        // Não rejeita o run em curso (já pegou o lock); apenas para de
        // acumular novos pra observability detectar. Sentry alerta via
        // captureMessage do emitSchedulerEvent (ALERTABLE_EVENTS).
      }
      inFlightRuns.add(wrappedPromise)
    },
    {
      scheduled: true,
      timezone: 'UTC',
    },
  )

  tasks.set(definition.name, task)

  logger.info(
    {
      jobName: definition.name,
      schedule: definition.schedule,
      enabled: definition.enabled,
    },
    'cron.register',
  )
}

/**
 * Executa um job manualmente (admin endpoint). Bypassa schedule mas
 * respeita kill-switch + lock. Útil pra debug/recovery.
 */
export async function runJobOnce(jobName: string): Promise<JobRunMeta> {
  const job = jobs.get(jobName)
  if (!job) {
    throw new Error(`Cron job not registered: ${jobName}`)
  }

  const promise = runJob(job)
  const wrapped = promise.then(() => undefined) as Promise<void>
  inFlightRuns.add(wrapped)
  try {
    return await promise
  } finally {
    inFlightRuns.delete(wrapped)
  }
}

/**
 * Snapshot dos jobs registrados + último run. Pro admin endpoint
 * GET /admin/jobs/list (card #159 discovery).
 */
export function getSchedulerHealth(): SchedulerHealth {
  return {
    jobs: Array.from(jobs.values()).map((job) => {
      const history = runHistory.get(job.name) ?? []
      const lastRun = history.length > 0 ? history[history.length - 1] : null
      const successCount = history.filter((r) => r.status === 'success').length
      const successRate = history.length > 0 ? successCount / history.length : 0
      return {
        jobName: job.name,
        enabled: job.enabled,
        schedule: job.schedule,
        lastRun,
        successRate,
      }
    }),
  }
}

/**
 * Lista de nomes de jobs registrados. Útil pro admin endpoint validar
 * `:name` antes de chamar runJobOnce.
 */
export function listJobNames(): string[] {
  return Array.from(jobs.keys())
}

/**
 * Graceful shutdown. Para todos os schedulers e espera runs in-flight
 * terminarem (até `gracefulTimeoutMs`). Após timeout, abandona — locks
 * expiram naturalmente pelo TTL.
 *
 * Chamado por SIGTERM handler em app.ts (T4.7).
 */
export async function shutdownScheduler(
  gracefulTimeoutMs = 30_000,
): Promise<void> {
  logger.info(
    {
      jobsCount: jobs.size,
      inFlight: inFlightRuns.size,
    },
    'cron.shutdown.starting',
  )

  // (1) Para todos os schedules — não inicia novos runs
  for (const [jobName, task] of tasks.entries()) {
    task.stop()
    logger.debug({ jobName }, 'cron.shutdown.task_stopped')
  }
  tasks.clear()

  // (2) Espera runs in-flight terminarem (até timeout)
  if (inFlightRuns.size > 0) {
    logger.info(
      { inFlight: inFlightRuns.size, timeoutMs: gracefulTimeoutMs },
      'cron.shutdown.awaiting_in_flight',
    )

    const allRuns = Promise.all(Array.from(inFlightRuns))
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, gracefulTimeoutMs)
    })

    await Promise.race([allRuns, timeout])

    if (inFlightRuns.size > 0) {
      logger.warn(
        { remaining: inFlightRuns.size },
        'cron.shutdown.timeout_with_remaining_runs',
      )
    }
  }

  logger.info('cron.shutdown.complete')
}

/**
 * Internals expostos APENAS pra testes. Não usar em produção.
 */
export const __testing = {
  RUN_HISTORY_PER_JOB_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  jobs,
  tasks,
  runHistory,
  inFlightRuns,
  runJob,
  recordRun,
  sanitizeErrorMessage,
  resetForTests: () => {
    for (const task of tasks.values()) {
      task.stop()
    }
    jobs.clear()
    tasks.clear()
    runHistory.clear()
    inFlightRuns.clear()
  },
}
