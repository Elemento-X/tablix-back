/**
 * Unit tests for scheduler bootstrap (Card #146 F4.2 + Card #147 F3).
 *
 * Cobre:
 *   - bootstrapCronJobs registra os 4 jobs (history-purge,
 *     cron-runs-cleanup, dead-letter-reprocess, quota-alert)
 *   - Schedule UTC esperado por job
 *   - `enabled` derivado de HISTORY_FEATURE_ENABLED && CRON_PURGE_ENABLED
 *   - lockTtlMs apropriado por job (5/10/30 min)
 *   - idempotent: true em todos
 *
 * @owner: @tester
 * @card: #146 F4.2, #147 F3
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { registerCronJobMock, envMock } = vi.hoisted(() => ({
  registerCronJobMock: vi.fn(),
  envMock: {
    HISTORY_FEATURE_ENABLED: false,
    CRON_PURGE_ENABLED: false,
    // Card 6.7: gate dedicado dos crons de cleanup async.
    ASYNC_PROCESSING_ENABLED: false,
    CRON_JOBS_CLEANUP_ENABLED: false,
  },
}))

vi.mock('../../src/scheduler/cron', () => ({
  registerCronJob: registerCronJobMock,
}))
vi.mock('../../src/config/env', () => ({ env: envMock }))
vi.mock('../../src/jobs/retention.job', () => ({
  purgeExpiredFiles: vi.fn(),
}))
vi.mock('../../src/jobs/cron-runs-cleanup.job', () => ({
  cronRunsCleanup: vi.fn(),
}))
vi.mock('../../src/jobs/dead-letter-reprocess.job', () => ({
  deadLetterReprocess: vi.fn(),
}))
vi.mock('../../src/jobs/quota-alert.job', () => ({
  scanUsageAndAlert: vi.fn(),
}))
vi.mock('../../src/jobs/async-cleanup.job', () => ({
  sweepOrphanJobs: vi.fn(),
  purgeAsyncJobStorage: vi.fn(),
}))

/* eslint-disable import/first */
import { bootstrapCronJobs } from '../../src/scheduler/jobs.bootstrap'
/* eslint-enable import/first */

beforeEach(() => {
  vi.clearAllMocks()
  envMock.HISTORY_FEATURE_ENABLED = false
  envMock.CRON_PURGE_ENABLED = false
  envMock.ASYNC_PROCESSING_ENABLED = false
  envMock.CRON_JOBS_CLEANUP_ENABLED = false
})

describe('bootstrapCronJobs — registra 6 jobs', () => {
  it('chama registerCronJob 6 vezes', () => {
    bootstrapCronJobs()
    expect(registerCronJobMock).toHaveBeenCalledTimes(6)
  })

  it('registra history-purge com schedule 06:00 UTC (= 03:00 BRT) + TTL 30min', () => {
    // Card #146 fix-pack ciclo 1 (@dba ALTO #4): TTL bumped 15min→30min
    // pra cobrir worst-case 100k rows/dia (~17min estimado pelo plano §6 D-G).
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const historyPurge = calls.find((c) => c.name === 'history-purge')
    expect(historyPurge).toBeDefined()
    expect(historyPurge.schedule).toBe('0 6 * * *')
    expect(historyPurge.lockTtlMs).toBe(30 * 60 * 1000)
    expect(historyPurge.idempotent).toBe(true)
  })

  it('registra cron-runs-cleanup com schedule 07:00 UTC (= 04:00 BRT daily) + TTL 5min', () => {
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const cleanup = calls.find((c) => c.name === 'cron-runs-cleanup')
    expect(cleanup).toBeDefined()
    expect(cleanup.schedule).toBe('0 7 * * *')
    expect(cleanup.lockTtlMs).toBe(5 * 60 * 1000)
    expect(cleanup.idempotent).toBe(true)
  })

  it('registra dead-letter-reprocess com schedule weekly Sunday 07:00 UTC + TTL 10min', () => {
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const dlr = calls.find((c) => c.name === 'dead-letter-reprocess')
    expect(dlr).toBeDefined()
    expect(dlr.schedule).toBe('0 7 * * 0')
    expect(dlr.lockTtlMs).toBe(10 * 60 * 1000)
    expect(dlr.idempotent).toBe(true)
  })

  it('registra quota-alert com schedule 11:00 UTC (= 08:00 BRT daily) + TTL 10min', () => {
    // Card #147 F3 (T-3.6): 08:00 BRT = janela manhã (UX vs ops; contrast com 03:00 BRT do purge)
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const quota = calls.find((c) => c.name === 'quota-alert')
    expect(quota).toBeDefined()
    expect(quota.schedule).toBe('0 11 * * *')
    expect(quota.lockTtlMs).toBe(10 * 60 * 1000)
    expect(quota.idempotent).toBe(true)
  })

  it('registra async-job-sweeper a cada 5min + TTL 4min (Card 6.7 / #197)', () => {
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const sweeper = calls.find((c) => c.name === 'async-job-sweeper')
    expect(sweeper).toBeDefined()
    expect(sweeper.schedule).toBe('*/5 * * * *')
    expect(sweeper.lockTtlMs).toBe(4 * 60 * 1000)
    expect(sweeper.idempotent).toBe(true)
  })

  it('registra async-storage-cleanup 12:00 UTC (= 09:00 BRT daily) + TTL 15min (Card 6.7)', () => {
    // 12:00 UTC (não 11:00) pra escalonar vs quota-alert (11:00) — @devops BAIXO.
    bootstrapCronJobs()
    const calls = registerCronJobMock.mock.calls.map((c) => c[0])
    const storage = calls.find((c) => c.name === 'async-storage-cleanup')
    expect(storage).toBeDefined()
    expect(storage.schedule).toBe('0 12 * * *')
    expect(storage.lockTtlMs).toBe(15 * 60 * 1000)
    expect(storage.idempotent).toBe(true)
  })
})

describe('bootstrapCronJobs — kill-switch gate', () => {
  /** Helper: mapa name→enabled das chamadas. */
  function enabledByName(): Record<string, boolean> {
    return Object.fromEntries(
      registerCronJobMock.mock.calls.map((c) => [c[0].name, c[0].enabled]),
    )
  }
  const LGPD_JOBS = [
    'history-purge',
    'cron-runs-cleanup',
    'dead-letter-reprocess',
    'quota-alert',
  ]
  const ASYNC_JOBS = ['async-job-sweeper', 'async-storage-cleanup']

  it('jobs LGPD: enabled=false quando HISTORY_FEATURE_ENABLED=false', () => {
    envMock.HISTORY_FEATURE_ENABLED = false
    envMock.CRON_PURGE_ENABLED = true
    bootstrapCronJobs()
    const map = enabledByName()
    LGPD_JOBS.forEach((j) => expect(map[j]).toBe(false))
  })

  it('jobs LGPD: enabled=false quando CRON_PURGE_ENABLED=false', () => {
    envMock.HISTORY_FEATURE_ENABLED = true
    envMock.CRON_PURGE_ENABLED = false
    bootstrapCronJobs()
    const map = enabledByName()
    LGPD_JOBS.forEach((j) => expect(map[j]).toBe(false))
  })

  it('jobs LGPD: enabled=true quando AMBOS HISTORY+CRON_PURGE=true', () => {
    envMock.HISTORY_FEATURE_ENABLED = true
    envMock.CRON_PURGE_ENABLED = true
    bootstrapCronJobs()
    const map = enabledByName()
    LGPD_JOBS.forEach((j) => expect(map[j]).toBe(true))
  })

  it('jobs async: gate DEDICADO (ASYNC_PROCESSING_ENABLED && CRON_JOBS_CLEANUP_ENABLED), independente do gate LGPD', () => {
    // LGPD on, async off → async jobs ficam false (gates desacoplados).
    envMock.HISTORY_FEATURE_ENABLED = true
    envMock.CRON_PURGE_ENABLED = true
    envMock.ASYNC_PROCESSING_ENABLED = true
    envMock.CRON_JOBS_CLEANUP_ENABLED = false
    bootstrapCronJobs()
    let map = enabledByName()
    ASYNC_JOBS.forEach((j) => expect(map[j]).toBe(false))

    // AMBOS async on → async jobs true.
    vi.clearAllMocks()
    envMock.ASYNC_PROCESSING_ENABLED = true
    envMock.CRON_JOBS_CLEANUP_ENABLED = true
    bootstrapCronJobs()
    map = enabledByName()
    ASYNC_JOBS.forEach((j) => expect(map[j]).toBe(true))
  })
})

describe('bootstrapCronJobs — handlers ligados corretamente', () => {
  it('cada job tem handler function ligado (não undefined)', () => {
    bootstrapCronJobs()
    const handlers = registerCronJobMock.mock.calls.map((c) => c[0].handler)
    expect(handlers).toHaveLength(6)
    handlers.forEach((h) => {
      expect(typeof h).toBe('function')
    })
  })
})
