/* eslint-disable import/first */
/**
 * Scheduler health adapter tests — Card #145 (5.2a) F4.
 *
 * Cobre `getCronHealthSnapshot` — adapter público pra /admin/jobs/list.
 * Whitelist explícita (NÃO expõe LockHandle.token, handler refs, etc).
 *
 * @owner: @tester
 * @card: #145 (5.2a) F4
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/scheduler/cron', () => ({
  getSchedulerHealth: vi.fn(),
}))

import { getSchedulerHealth } from '../../../src/scheduler/cron'
import {
  cronHealthResponseSchema,
  getCronHealthSnapshot,
} from '../../../src/scheduler/health'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getCronHealthSnapshot', () => {
  it('retorna estrutura vazia quando sem jobs registrados', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({ jobs: [] })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.totalJobs).toBe(0)
    expect(snapshot.data.jobs).toEqual([])
    // Bate com Zod schema (api-contract)
    expect(cronHealthResponseSchema.safeParse(snapshot).success).toBe(true)
  })

  it('serializa Date → ISO 8601 UTC', () => {
    const startedAt = new Date('2026-05-04T12:00:00.000Z')
    const finishedAt = new Date('2026-05-04T12:00:05.000Z')
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'history-purge',
          enabled: true,
          schedule: '0 3 * * *',
          successRate: 1,
          lastRun: {
            jobName: 'history-purge',
            runId: '550e8400-e29b-41d4-a716-446655440000',
            startedAt,
            finishedAt,
            status: 'success',
            durationMs: 5000,
          },
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.jobs[0].lastRun?.startedAt).toBe(
      '2026-05-04T12:00:00.000Z',
    )
    expect(snapshot.data.jobs[0].lastRun?.finishedAt).toBe(
      '2026-05-04T12:00:05.000Z',
    )
  })

  it('NÃO expõe token do LockHandle nem refs internas', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'test-job',
          enabled: true,
          schedule: '* * * * *',
          successRate: 0.8,
          lastRun: {
            jobName: 'test-job',
            runId: '550e8400-e29b-41d4-a716-446655440000',
            startedAt: new Date(),
            finishedAt: new Date(),
            status: 'success',
            durationMs: 100,
          },
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    const job = snapshot.data.jobs[0]
    // Asserts negativos: campos secretos NÃO devem aparecer
    expect(job).not.toHaveProperty('token')
    expect(job).not.toHaveProperty('handler')
    expect(job.lastRun).not.toHaveProperty('token')
  })

  it('lastRun null quando nenhuma run executou', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'never-ran',
          enabled: false,
          schedule: '0 * * * *',
          successRate: 0,
          lastRun: null,
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.jobs[0].lastRun).toBeNull()
  })

  it('finishedAt null durante run em curso (status running)', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'running-job',
          enabled: true,
          schedule: '*/5 * * * *',
          successRate: 1,
          lastRun: {
            jobName: 'running-job',
            runId: '550e8400-e29b-41d4-a716-446655440000',
            startedAt: new Date('2026-05-04T12:00:00Z'),
            finishedAt: null,
            status: 'running',
          },
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.jobs[0].lastRun?.finishedAt).toBeNull()
    expect(snapshot.data.jobs[0].lastRun?.durationMs).toBeNull()
  })

  it('skipReason mapeado quando status=skipped', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'skipped-job',
          enabled: false,
          schedule: '0 * * * *',
          successRate: 0,
          lastRun: {
            jobName: 'skipped-job',
            runId: '550e8400-e29b-41d4-a716-446655440000',
            startedAt: new Date(),
            finishedAt: new Date(),
            status: 'skipped',
            skipReason: 'feature_disabled',
            durationMs: 0,
          },
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.jobs[0].lastRun?.skipReason).toBe('feature_disabled')
  })

  it('error null quando status=success', () => {
    vi.mocked(getSchedulerHealth).mockReturnValue({
      jobs: [
        {
          jobName: 'happy-job',
          enabled: true,
          schedule: '0 * * * *',
          successRate: 1,
          lastRun: {
            jobName: 'happy-job',
            runId: '550e8400-e29b-41d4-a716-446655440000',
            startedAt: new Date(),
            finishedAt: new Date(),
            status: 'success',
            durationMs: 100,
          },
        },
      ],
    })
    const snapshot = getCronHealthSnapshot()
    expect(snapshot.data.jobs[0].lastRun?.error).toBeNull()
  })
})
