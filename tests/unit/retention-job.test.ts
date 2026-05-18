/**
 * Unit tests for retention job (Card #146 F3).
 *
 * Cobre os 7 comportamentos críticos do handler purgeExpiredFiles:
 *   1. Dry-run mode (CRON_DRY_RUN=true → log + NÃO toca DB)
 *   2. Lifecycle cron_runs (recordRunStart + recordRunEnd)
 *   3. Sanitize error message
 *   4. Dead-letter trigger threshold (>=5 attempts)
 *   5. Gauge update + alert overdue
 *   6. Heartbeat-aware loop (lock.heartbeat false → graceful abort)
 *   7. Storage 404 idempotência (notFound:true → hard-delete + audit)
 *
 * Integration tests do flow completo (3 phases + crash recovery + lock
 * concurrency) ficam em tests/integration/retention-job.flow.test.ts (F4).
 *
 * @owner: @tester
 * @card: #146 F3
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  prismaMock,
  recordLegalEventMock,
  adapterMock,
  emitMock,
  setGaugeMock,
  sentryMock,
  envMock,
} = vi.hoisted(() => ({
  prismaMock: {
    cronRun: {
      create: vi.fn(),
      update: vi.fn(),
    },
    fileHistory: {
      delete: vi.fn(),
      update: vi.fn(),
    },
    fileHistoryDeadLetter: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $queryRaw: vi.fn(),
  },
  recordLegalEventMock: vi.fn(),
  adapterMock: {
    removeByPath: vi.fn(),
  },
  emitMock: vi.fn(),
  setGaugeMock: vi.fn(),
  sentryMock: {
    captureException: vi.fn(),
  },
  // Objeto mutável — testes que precisam dry-run setam envMock.CRON_DRY_RUN=true
  // no beforeEach E resetam no afterEach. Default false.
  envMock: { CRON_DRY_RUN: false },
}))

vi.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('../../src/modules/audit-legal/audit-legal.service', () => ({
  recordLegalEvent: recordLegalEventMock,
}))
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: () => adapterMock,
}))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: emitMock,
}))
vi.mock('../../src/scheduler/metrics', () => ({
  setPurgePendingCount: setGaugeMock,
}))
vi.mock('../../src/config/sentry', () => ({
  Sentry: sentryMock,
}))
vi.mock('../../src/config/env', () => ({
  env: envMock,
}))

/* eslint-disable import/first */
import { __testing, purgeExpiredFiles } from '../../src/jobs/retention.job'
import type { LockHandle } from '../../src/scheduler/types'
/* eslint-enable import/first */

const { sanitizeErrorMessage, DEAD_LETTER_THRESHOLD } = __testing

function makeLock(overrides: Partial<LockHandle> = {}): LockHandle {
  return {
    token: 'mock-token',
    jobName: 'history-purge',
    acquiredAt: new Date(),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    userId: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd',
    storagePath: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd/2026-05-18/abc1234.csv',
    originalFilename: 'planilha.csv',
    mimeType: 'text/csv',
    fileSize: 1024,
    expiresAt: new Date('2026-04-01'),
    purgeAttempts: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset env mock — default CRON_DRY_RUN=false. Describes que precisam
  // dry-run setam true no próprio beforeEach (após este global reset).
  envMock.CRON_DRY_RUN = false
  // Default cron_runs mocks succeed silently.
  prismaMock.cronRun.create.mockResolvedValue({})
  prismaMock.cronRun.update.mockResolvedValue({})
  // Default heartbeat true.
  // $queryRaw default empty (loops exit on first iter).
  prismaMock.$queryRaw.mockResolvedValue([])
  // $transaction passa o tx mock pro callback.
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => {
    if (typeof cb === 'function') {
      return cb(prismaMock)
    }
    return cb
  })
})

describe('sanitizeErrorMessage', () => {
  it('remove CR/LF/TAB', () => {
    const err = new Error('line1\nline2\rline3\tend')
    expect(sanitizeErrorMessage(err)).toBe('line1 line2 line3 end')
  })

  it('trunca em 200 chars', () => {
    const err = new Error('a'.repeat(500))
    expect(sanitizeErrorMessage(err).length).toBe(200)
  })

  it('non-Error retorna "unknown error"', () => {
    expect(sanitizeErrorMessage('string')).toBe('unknown error')
    expect(sanitizeErrorMessage(null)).toBe('unknown error')
    expect(sanitizeErrorMessage({ msg: 'x' })).toBe('unknown error')
  })
})

describe('DEAD_LETTER_THRESHOLD invariante', () => {
  it('threshold é 5 (bate com CHECK fhdl_purge_attempts_threshold_check)', () => {
    expect(DEAD_LETTER_THRESHOLD).toBe(5)
  })
})

describe('purgeExpiredFiles — dry-run mode', () => {
  beforeEach(() => {
    envMock.CRON_DRY_RUN = true
  })

  it('CRON_DRY_RUN=true: emite dry_run.start + NÃO chama processStorageDeletes', async () => {
    // Mock counts retornados pelos 3 SELECTs do dry-run.
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ count: 10n }])
      .mockResolvedValueOnce([{ count: 5n }])
      .mockResolvedValueOnce([{ count: 1n }])

    const lock = makeLock()
    await purgeExpiredFiles(lock)

    // Emit do dry_run.start
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.purge.dry_run.start',
        jobName: 'history-purge',
      }),
    )

    // recordLegalEvent NÃO chamado (dry-run)
    expect(recordLegalEventMock).not.toHaveBeenCalled()
    // adapter NÃO chamado
    expect(adapterMock.removeByPath).not.toHaveBeenCalled()
    // fileHistory NÃO mutado
    expect(prismaMock.fileHistory.delete).not.toHaveBeenCalled()
    expect(prismaMock.fileHistory.update).not.toHaveBeenCalled()

    // cron_runs lifecycle ainda OK (start + end success)
    expect(prismaMock.cronRun.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.cronRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success' }),
      }),
    )
  })
})

describe('purgeExpiredFiles — happy path', () => {
  it('processa 1 batch e atualiza gauge', async () => {
    const row = makeRow()
    // Iter 1: 1 row; iter 2: vazio (sai do loop Fase A)
    // Iter 3 (Fase C reconciliação): vazio
    // Iter 4 (Fase D dead-letter SELECT): vazio
    // Iter 5 (Fase E gauge SELECT COUNT): retorna 0
    prismaMock.$queryRaw
      .mockResolvedValueOnce([row]) // Fase A batch 1
      .mockResolvedValueOnce([]) // Fase A batch 2 (vazio → sai)
      .mockResolvedValueOnce([]) // Fase C reconciliação (vazio)
      .mockResolvedValueOnce([]) // Fase D dead-letter (vazio)
      .mockResolvedValueOnce([{ count: 0n }]) // Fase E gauge

    adapterMock.removeByPath.mockResolvedValue({
      deleted: true,
      notFound: false,
    })

    const lock = makeLock()
    await purgeExpiredFiles(lock)

    // adapter foi chamado com o storage_path da row
    expect(adapterMock.removeByPath).toHaveBeenCalledWith(row.storagePath)
    // gauge atualizado com count=0
    expect(setGaugeMock).toHaveBeenCalledWith('history-purge', 0)
    // cron_runs success
    expect(prismaMock.cronRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success' }),
      }),
    )
  })
})

describe('purgeExpiredFiles — heartbeat lost graceful abort', () => {
  it('lock.heartbeat retorna false → break loop sem throw', async () => {
    const lock = makeLock({
      heartbeat: vi.fn().mockResolvedValue(false), // sempre false
    })
    // Gauge ainda é chamado mesmo após abort (Fase E roda)
    prismaMock.$queryRaw.mockResolvedValueOnce([{ count: 0n }])

    await expect(purgeExpiredFiles(lock)).resolves.not.toThrow()

    // Heartbeat foi chamado (pelo menos 1x — no início do loop Fase A)
    expect(lock.heartbeat).toHaveBeenCalled()
    // Nenhum batch processado (saiu antes do SELECT)
    expect(adapterMock.removeByPath).not.toHaveBeenCalled()
  })
})

describe('purgeExpiredFiles — storage 404 idempotência', () => {
  it('removeByPath retorna notFound:true → hard-delete + audit purge_completed', async () => {
    const row = makeRow()
    prismaMock.$queryRaw
      .mockResolvedValueOnce([row]) // Fase A
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])

    adapterMock.removeByPath.mockResolvedValue({
      deleted: false,
      notFound: true, // idempotente
    })

    await purgeExpiredFiles(makeLock())

    // Hard-delete aconteceu
    expect(prismaMock.fileHistory.delete).toHaveBeenCalledWith({
      where: { id: row.id },
    })
    // Audit purge_completed com metadata.storageNotFound=true
    expect(recordLegalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'purge_completed',
        metadata: expect.objectContaining({ storageNotFound: true }),
      }),
    )
    // NÃO incrementou purge_attempts
    expect(prismaMock.fileHistory.update).not.toHaveBeenCalled()
  })
})

describe('purgeExpiredFiles — storage error → retry', () => {
  it('removeByPath throw → INCR purge_attempts (não hard-delete)', async () => {
    const row = makeRow({ purgeAttempts: 2 })
    prismaMock.$queryRaw
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])

    adapterMock.removeByPath.mockRejectedValue(new Error('Storage 500'))

    await purgeExpiredFiles(makeLock())

    // NÃO hard-delete
    expect(prismaMock.fileHistory.delete).not.toHaveBeenCalled()
    // INCR purge_attempts
    expect(prismaMock.fileHistory.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { purgeAttempts: { increment: 1 } },
    })
    // Audit purge_completed NÃO chamado (era purge_pending na Fase A apenas)
    const completedCalls = recordLegalEventMock.mock.calls.filter(
      (c) => c[0]?.eventType === 'purge_completed',
    )
    expect(completedCalls).toHaveLength(0)
  })
})

describe('purgeExpiredFiles — dead-letter move', () => {
  it('rows com purge_attempts >= 5 movidas pra file_history_dead_letter + emit alerta', async () => {
    const deadRow = makeRow({ purgeAttempts: 7 })
    prismaMock.$queryRaw
      .mockResolvedValueOnce([]) // Fase A vazia
      .mockResolvedValueOnce([]) // Fase C vazia
      .mockResolvedValueOnce([deadRow]) // Fase D 1 row
      .mockResolvedValueOnce([{ count: 0n }]) // Fase E gauge

    await purgeExpiredFiles(makeLock())

    // INSERT dead-letter
    expect(prismaMock.fileHistoryDeadLetter.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        originalFileHistoryId: deadRow.id,
        purgeAttempts: 7,
        lastErrorCode: 'STORAGE_DELETE_THRESHOLD_REACHED',
      }),
    })
    // DELETE origin
    expect(prismaMock.fileHistory.delete).toHaveBeenCalledWith({
      where: { id: deadRow.id },
    })
    // Audit purge_failed com expirado original
    expect(recordLegalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'purge_failed',
        outcome: 'failure',
        errorCode: 'STORAGE_DELETE_THRESHOLD_REACHED',
      }),
    )
    // Emit cron.purge.dead_letter ALERTABLE
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        event: 'cron.purge.dead_letter',
        context: expect.objectContaining({ movedCount: 1 }),
      }),
    )
  })
})

describe('purgeExpiredFiles — gauge overdue alert', () => {
  it('gauge > 1000 → emit cron.purge.pending_overdue warning', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([]) // Fase A
      .mockResolvedValueOnce([]) // Fase C
      .mockResolvedValueOnce([]) // Fase D
      .mockResolvedValueOnce([{ count: 1500n }]) // Fase E gauge

    await purgeExpiredFiles(makeLock())

    expect(setGaugeMock).toHaveBeenCalledWith('history-purge', 1500)
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warning',
        event: 'cron.purge.pending_overdue',
        context: expect.objectContaining({ pendingCount: 1500 }),
      }),
    )
  })

  it('gauge <= 1000 → NÃO emit pending_overdue', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 500n }])

    await purgeExpiredFiles(makeLock())

    expect(setGaugeMock).toHaveBeenCalledWith('history-purge', 500)
    const overdueCalls = emitMock.mock.calls.filter(
      (c) => c[0]?.event === 'cron.purge.pending_overdue',
    )
    expect(overdueCalls).toHaveLength(0)
  })
})

describe('purgeExpiredFiles — cron_runs lifecycle', () => {
  it('start + end success em happy path', async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])

    await purgeExpiredFiles(makeLock())

    // create com status='running'
    expect(prismaMock.cronRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: 'history-purge',
        status: 'running',
        attempts: 1,
      }),
    })
    // update com status='success'
    expect(prismaMock.cronRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success',
          rowsProcessed: 0,
        }),
      }),
    )
  })

  it('cron_runs.create falha → handler NÃO trava (degraded mode)', async () => {
    prismaMock.cronRun.create.mockRejectedValue(new Error('cron_runs full'))
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ count: 0n }])

    await expect(purgeExpiredFiles(makeLock())).resolves.not.toThrow()
    // Gauge ainda atualizou (degraded mas funcional)
    expect(setGaugeMock).toHaveBeenCalled()
  })
})
