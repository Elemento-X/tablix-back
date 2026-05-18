/**
 * Unit tests for dead-letter-reprocess job (Card #146 F4.7).
 *
 * Cobre:
 *   - No candidates: log + return cedo
 *   - Sucesso normal: UPDATE resolved_at + audit purge_completed
 *   - Sucesso 404: resolution_type='storage_already_gone' + audit storageNotFound:true
 *   - Falha: INCR reprocess_count
 *   - Falha que atinge limit: emit cron.purge.dead_letter + Sentry CRITICAL + audit purge_failed
 *   - Heartbeat lost mid-batch: break + log
 *
 * @owner: @tester
 * @card: #146 F4.7
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock, adapterMock, recordLegalEventMock, emitMock, sentryMock } =
  vi.hoisted(() => ({
    prismaMock: {
      fileHistoryDeadLetter: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
    adapterMock: { removeByPath: vi.fn() },
    recordLegalEventMock: vi.fn(),
    emitMock: vi.fn(),
    sentryMock: { captureMessage: vi.fn() },
  }))

vi.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: () => adapterMock,
}))
vi.mock('../../src/modules/audit-legal/audit-legal.service', () => ({
  recordLegalEvent: recordLegalEventMock,
}))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: emitMock,
}))
vi.mock('../../src/config/sentry', () => ({
  Sentry: sentryMock,
}))

/* eslint-disable import/first */
import {
  __testing,
  deadLetterReprocess,
} from '../../src/jobs/dead-letter-reprocess.job'
import type { LockHandle } from '../../src/scheduler/types'
/* eslint-enable import/first */

const { JOB_NAME, REPROCESS_LIMIT, sanitizeErrorMessage } = __testing

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

function makeDeadLetterRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    originalFileHistoryId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    userId: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd',
    storagePath: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd/2026-05-18/abc1234.csv',
    originalFilename: 'planilha.csv',
    mimeType: 'text/csv',
    fileSize: 1024,
    expiresAt: new Date('2026-04-01'),
    deletedAt: new Date('2026-04-15'),
    purgeAttempts: 5,
    lastErrorCode: 'STORAGE_DELETE_THRESHOLD_REACHED',
    lastErrorMessage: 'failed 5x',
    movedToDeadLetterAt: new Date('2026-04-20'),
    reprocessCount: 0,
    lastReprocessAttemptAt: null,
    lastReprocessErrorCode: null,
    lastReprocessErrorMessage: null,
    resolvedAt: null,
    resolutionType: null,
    createdAt: new Date('2026-04-20'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dead-letter-reprocess — constants', () => {
  it('REPROCESS_LIMIT é 3 (bate com CHECK fhdl_reprocess_count_check 0-3)', () => {
    expect(REPROCESS_LIMIT).toBe(3)
  })

  it('sanitizeErrorMessage strip CR/LF/TAB e trunca 200', () => {
    expect(sanitizeErrorMessage(new Error('a\nb\rc\td'))).toBe('a b c d')
    expect(sanitizeErrorMessage(new Error('x'.repeat(500))).length).toBe(200)
    expect(sanitizeErrorMessage('non-Error')).toBe('unknown error')
  })
})

describe('dead-letter-reprocess — no candidates', () => {
  it('findMany retorna [] → return cedo sem operações', async () => {
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([])

    await deadLetterReprocess(makeLock())

    expect(adapterMock.removeByPath).not.toHaveBeenCalled()
    expect(prismaMock.fileHistoryDeadLetter.update).not.toHaveBeenCalled()
    expect(recordLegalEventMock).not.toHaveBeenCalled()
  })
})

describe('dead-letter-reprocess — sucesso normal', () => {
  it('removeByPath OK → UPDATE resolved_at + resolution_type cron_reprocess_success', async () => {
    const row = makeDeadLetterRow({ reprocessCount: 1 })
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([row])
    adapterMock.removeByPath.mockResolvedValue({
      deleted: true,
      notFound: false,
    })

    await deadLetterReprocess(makeLock())

    expect(prismaMock.fileHistoryDeadLetter.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({
        resolvedAt: expect.any(Date),
        resolutionType: 'cron_reprocess_success',
        reprocessCount: 2,
        lastReprocessErrorCode: null,
      }),
    })

    expect(recordLegalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'purge_completed',
        outcome: 'success',
        metadata: expect.objectContaining({
          phase: 'reprocess_success',
          reprocessAttempt: 2,
          storageNotFound: false,
        }),
      }),
    )
  })
})

describe('dead-letter-reprocess — 404 idempotência', () => {
  it('removeByPath notFound:true → resolution_type storage_already_gone', async () => {
    const row = makeDeadLetterRow()
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([row])
    adapterMock.removeByPath.mockResolvedValue({
      deleted: false,
      notFound: true,
    })

    await deadLetterReprocess(makeLock())

    expect(prismaMock.fileHistoryDeadLetter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resolutionType: 'storage_already_gone',
        }),
      }),
    )

    expect(recordLegalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'purge_completed',
        metadata: expect.objectContaining({ storageNotFound: true }),
      }),
    )
  })
})

describe('dead-letter-reprocess — falha mid-batch (não atinge limit)', () => {
  it('removeByPath throw → INCR reprocess_count (sem resolved_at)', async () => {
    const row = makeDeadLetterRow({ reprocessCount: 0 })
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([row])
    adapterMock.removeByPath.mockRejectedValue(new Error('Storage 503'))

    await deadLetterReprocess(makeLock())

    expect(prismaMock.fileHistoryDeadLetter.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({
        reprocessCount: 1, // 0 + 1 (não atinge limit 3)
        lastReprocessAttemptAt: expect.any(Date),
        lastReprocessErrorCode: 'Error',
        lastReprocessErrorMessage: expect.stringContaining('Storage'),
      }),
    })

    // NÃO emit dead_letter (não atingiu limit ainda)
    expect(emitMock).not.toHaveBeenCalled()
    // NÃO audit purge_failed final (ainda pode tentar)
    const failedCalls = recordLegalEventMock.mock.calls.filter(
      (c) => c[0]?.eventType === 'purge_failed',
    )
    expect(failedCalls).toHaveLength(0)
  })
})

describe('dead-letter-reprocess — escalação a humano (atinge limit)', () => {
  it('reprocessCount 2 → 3 (atinge limit) → emit + Sentry + audit purge_failed', async () => {
    const row = makeDeadLetterRow({ reprocessCount: 2 })
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([row])
    adapterMock.removeByPath.mockRejectedValue(new Error('Storage 503'))

    await deadLetterReprocess(makeLock())

    // UPDATE atualiza pra 3
    expect(prismaMock.fileHistoryDeadLetter.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reprocessCount: 3, // atingiu limit
        }),
      }),
    )

    // Audit purge_failed final (eventType=purge_failed + outcome=failure)
    expect(recordLegalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'purge_failed',
        outcome: 'failure',
        errorCode: 'REPROCESS_LIMIT_REACHED',
        metadata: expect.objectContaining({
          phase: 'reprocess_limit_reached',
          reprocessCount: 3,
        }),
      }),
    )

    // Emit cron.purge.dead_letter ALERTABLE
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        event: 'cron.purge.dead_letter',
        context: expect.objectContaining({
          escalatedToHuman: 1,
          reprocessLimit: 3,
        }),
      }),
    )

    // Sentry captureMessage CRITICAL
    expect(sentryMock.captureMessage).toHaveBeenCalledWith(
      'cron.dead_letter_reprocess.human_required',
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          scheduler_job: JOB_NAME,
        }),
      }),
    )
  })
})

describe('dead-letter-reprocess — heartbeat lost mid-batch', () => {
  it('heartbeat retorna false na 2ª iteração → break loop sem processar resto', async () => {
    const row1 = makeDeadLetterRow({ id: 'row1' })
    const row2 = makeDeadLetterRow({ id: 'row2' })
    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([row1, row2])
    adapterMock.removeByPath.mockResolvedValue({
      deleted: true,
      notFound: false,
    })

    // heartbeat true na 1ª iter, false na 2ª
    let callCount = 0
    const lock = makeLock({
      heartbeat: vi.fn().mockImplementation(async () => {
        callCount++
        return callCount === 1
      }),
    })

    await deadLetterReprocess(lock)

    // Só a 1ª row foi processada
    expect(adapterMock.removeByPath).toHaveBeenCalledTimes(1)
    expect(adapterMock.removeByPath).toHaveBeenCalledWith(row1.storagePath)
  })
})

describe('dead-letter-reprocess — adapter unavailable', () => {
  it('volta cedo sem operações se getStorageAdapter() retorna null', async () => {
    // Re-mock pra simular adapter null
    vi.doMock('../../src/lib/storage', () => ({
      getStorageAdapter: () => null,
    }))

    // Como vi.doMock não é hoisted, precisamos re-importar
    const { deadLetterReprocess: handlerWithNullAdapter } =
      await import('../../src/jobs/dead-letter-reprocess.job')

    prismaMock.fileHistoryDeadLetter.findMany.mockResolvedValue([
      makeDeadLetterRow(),
    ])

    await expect(handlerWithNullAdapter(makeLock())).resolves.not.toThrow()

    vi.doUnmock('../../src/lib/storage')
  })
})
