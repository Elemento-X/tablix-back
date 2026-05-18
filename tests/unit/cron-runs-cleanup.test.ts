/**
 * Unit tests for cron-runs-cleanup job (Card #146 F4.5).
 *
 * Cobre:
 *   - Retenção 30d: DELETE rows com created_at < cutoff
 *   - Orphan recovery: UPDATE status='expired' em running > 2h
 *   - Emit cron.run.expired ALERTABLE quando orphan recovered > 0
 *   - Heartbeat lost: abort graceful sem throw
 *
 * @owner: @tester
 * @card: #146 F4.5
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock, emitMock } = vi.hoisted(() => ({
  prismaMock: {
    cronRun: {
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  emitMock: vi.fn(),
}))

vi.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: emitMock,
}))

/* eslint-disable import/first */
import {
  __testing,
  cronRunsCleanup,
} from '../../src/jobs/cron-runs-cleanup.job'
import type { LockHandle } from '../../src/scheduler/types'
/* eslint-enable import/first */

const { JOB_NAME, RETENTION_DAYS } = __testing

function makeLock(overrides: Partial<LockHandle> = {}): LockHandle {
  return {
    token: 'mock',
    jobName: JOB_NAME,
    acquiredAt: new Date(),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.cronRun.deleteMany.mockResolvedValue({ count: 0 })
  prismaMock.cronRun.updateMany.mockResolvedValue({ count: 0 })
})

describe('cron-runs-cleanup — constants', () => {
  it('retention é 30 dias', () => {
    expect(RETENTION_DAYS).toBe(30)
  })

  it('JOB_NAME é cron-runs-cleanup', () => {
    expect(JOB_NAME).toBe('cron-runs-cleanup')
  })
})

describe('cron-runs-cleanup — retenção 30d', () => {
  it('chama deleteMany com createdAt < (NOW - 30d)', async () => {
    prismaMock.cronRun.deleteMany.mockResolvedValue({ count: 42 })

    await cronRunsCleanup(makeLock())

    expect(prismaMock.cronRun.deleteMany).toHaveBeenCalledTimes(1)
    const call = prismaMock.cronRun.deleteMany.mock.calls[0][0]
    expect(call.where.createdAt.lt).toBeInstanceOf(Date)
    // Cutoff deve ser ~30d atrás (tolerância 1min pra latência do test)
    const cutoff = call.where.createdAt.lt as Date
    const expectedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(60_000)
  })

  it('retorna sem erro quando deleteMany retorna count=0', async () => {
    await expect(cronRunsCleanup(makeLock())).resolves.not.toThrow()
  })
})

describe('cron-runs-cleanup — orphan running recovery', () => {
  it('UPDATE status=expired em rows running > 2h', async () => {
    prismaMock.cronRun.updateMany.mockResolvedValue({ count: 3 })

    await cronRunsCleanup(makeLock())

    expect(prismaMock.cronRun.updateMany).toHaveBeenCalledTimes(1)
    const call = prismaMock.cronRun.updateMany.mock.calls[0][0]
    expect(call.where.status).toBe('running')
    expect(call.where.startedAt.lt).toBeInstanceOf(Date)
    expect(call.data.status).toBe('expired')
    expect(call.data.errorCode).toBe('STALE_RUNNING_INFERRED')
    expect(call.data.finishedAt).toBeInstanceOf(Date)
  })

  it('emit cron.run.expired ALERTABLE quando orphan recovered > 0', async () => {
    prismaMock.cronRun.updateMany.mockResolvedValue({ count: 5 })

    await cronRunsCleanup(makeLock())

    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        event: 'cron.run.expired',
        jobName: JOB_NAME,
        context: expect.objectContaining({
          recoveredCount: 5,
          reason: 'stale_running_inferred',
        }),
      }),
    )
  })

  it('NÃO emit quando orphan recovered = 0', async () => {
    prismaMock.cronRun.updateMany.mockResolvedValue({ count: 0 })

    await cronRunsCleanup(makeLock())

    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('cron-runs-cleanup — heartbeat lost', () => {
  it('lock.heartbeat false → abort sem operações', async () => {
    const lock = makeLock({
      heartbeat: vi.fn().mockResolvedValue(false),
    })

    await expect(cronRunsCleanup(lock)).resolves.not.toThrow()

    expect(prismaMock.cronRun.deleteMany).not.toHaveBeenCalled()
    expect(prismaMock.cronRun.updateMany).not.toHaveBeenCalled()
  })
})
