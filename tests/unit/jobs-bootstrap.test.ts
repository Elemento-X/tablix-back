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

/* eslint-disable import/first */
import { bootstrapCronJobs } from '../../src/scheduler/jobs.bootstrap'
/* eslint-enable import/first */

beforeEach(() => {
  vi.clearAllMocks()
  envMock.HISTORY_FEATURE_ENABLED = false
  envMock.CRON_PURGE_ENABLED = false
})

describe('bootstrapCronJobs — registra 4 jobs', () => {
  it('chama registerCronJob 4 vezes', () => {
    bootstrapCronJobs()
    expect(registerCronJobMock).toHaveBeenCalledTimes(4)
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
})

describe('bootstrapCronJobs — kill-switch gate', () => {
  it('enabled=false quando HISTORY_FEATURE_ENABLED=false', () => {
    envMock.HISTORY_FEATURE_ENABLED = false
    envMock.CRON_PURGE_ENABLED = true
    bootstrapCronJobs()
    const enabledStates = registerCronJobMock.mock.calls.map(
      (c) => c[0].enabled,
    )
    expect(enabledStates).toEqual([false, false, false, false])
  })

  it('enabled=false quando CRON_PURGE_ENABLED=false', () => {
    envMock.HISTORY_FEATURE_ENABLED = true
    envMock.CRON_PURGE_ENABLED = false
    bootstrapCronJobs()
    const enabledStates = registerCronJobMock.mock.calls.map(
      (c) => c[0].enabled,
    )
    expect(enabledStates).toEqual([false, false, false, false])
  })

  it('enabled=true quando AMBOS HISTORY_FEATURE_ENABLED+CRON_PURGE_ENABLED=true', () => {
    envMock.HISTORY_FEATURE_ENABLED = true
    envMock.CRON_PURGE_ENABLED = true
    bootstrapCronJobs()
    const enabledStates = registerCronJobMock.mock.calls.map(
      (c) => c[0].enabled,
    )
    expect(enabledStates).toEqual([true, true, true, true])
  })
})

describe('bootstrapCronJobs — handlers ligados corretamente', () => {
  it('cada job tem handler function ligado (não undefined)', () => {
    bootstrapCronJobs()
    const handlers = registerCronJobMock.mock.calls.map((c) => c[0].handler)
    expect(handlers).toHaveLength(4)
    handlers.forEach((h) => {
      expect(typeof h).toBe('function')
    })
  })
})
