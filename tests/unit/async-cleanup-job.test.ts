/**
 * Unit tests dos crons de cleanup async (Card 6.7 + sweeper #197).
 *
 * Mocka prisma / queue / usage / storage / metrics / observability / sentry e
 * prova os branches de decisão dos 2 handlers:
 *  - sweepOrphanJobs: re-enqueue vs FAILED+refund (TTL/meta), skip-in-queue,
 *    lost-to-worker (claim count 0), queue-null inconclusivo, force-fail de
 *    PROCESSING (ausente/terminal) vs skip (ativo), refund no período do createdAt.
 *  - purgeAsyncJobStorage: purga total→setInputsPurgedAt, parcial→NULL (M-03),
 *    inputFiles ilegível→skip+alert, output expirado→tombstone, bad-format→tombstone.
 *
 * O key-builder é REAL (paths determinísticos validados); usa UUID v4 válido.
 *
 * @owner: @tester
 * @card: 6.7 (+ #197)
 */
/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  getProcessJobState: vi.fn(),
  enqueueProcessJob: vi.fn(),
  isProcessQueueConfigured: vi.fn(),
  decrementUsageForPeriod: vi.fn(),
  getStorageAdapter: vi.fn(),
  setAsyncCleanupCount: vi.fn(),
  emitSchedulerEvent: vi.fn(),
  captureException: vi.fn(),
  // env mutável por teste
  env: {
    CRON_DRY_RUN: false,
    ASYNC_PENDING_SWEEP_MINUTES: 10,
    ASYNC_STUCK_PROCESSING_MINUTES: 60,
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    job: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
      update: mocks.update,
      count: mocks.count,
    },
    // $transaction (fix-pack: failAndRefundPending roda claim+refund atômico).
    // Invoca o callback com um tx que reusa os mesmos mocks de job.
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
      cb({ job: { updateMany: mocks.updateMany } }),
    ),
  },
}))
vi.mock('../../src/lib/queue/process-queue', () => ({
  getProcessJobState: mocks.getProcessJobState,
  enqueueProcessJob: mocks.enqueueProcessJob,
  isProcessQueueConfigured: mocks.isProcessQueueConfigured,
}))
vi.mock('../../src/modules/usage/usage.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/modules/usage/usage.service')
  >('../../src/modules/usage/usage.service')
  return {
    // getCurrentPeriod real (pura, UTC) — prova que o estorno usa o período
    // do createdAt, não o corrente.
    getCurrentPeriod: actual.getCurrentPeriod,
    decrementUsageForPeriod: mocks.decrementUsageForPeriod,
  }
})
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: mocks.getStorageAdapter,
}))
vi.mock('../../src/scheduler/metrics', () => ({
  setAsyncCleanupCount: mocks.setAsyncCleanupCount,
}))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: mocks.emitSchedulerEvent,
}))
vi.mock('../../src/config/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}))
vi.mock('../../src/config/env', () => ({ env: mocks.env }))

import {
  sweepOrphanJobs,
  purgeAsyncJobStorage,
} from '../../src/jobs/async-cleanup.job'
import type { LockHandle } from '../../src/scheduler/types'

const USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'

function makeLock(): LockHandle {
  return {
    token: 'tok',
    jobName: 'test',
    acquiredAt: new Date(),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  }
}

/** findMany retorna `rows` na 1ª chamada e [] depois (seenIds + break). */
function findManyOnce(rows: unknown[]) {
  mocks.findMany.mockResolvedValueOnce(rows).mockResolvedValue([])
}

const validInputFiles = {
  files: [
    { index: 0, fileName: 'a.csv', ext: 'csv', size: 10 },
    { index: 1, fileName: 'b.xlsx', ext: 'xlsx', size: 20 },
  ],
  selectedColumns: ['nome'],
}

beforeEach(() => {
  mocks.env.CRON_DRY_RUN = false
  mocks.env.ASYNC_PENDING_SWEEP_MINUTES = 10
  mocks.env.ASYNC_STUCK_PROCESSING_MINUTES = 60
  mocks.isProcessQueueConfigured.mockReturnValue(true)
  mocks.enqueueProcessJob.mockResolvedValue({ enqueuedJobId: JOB_ID })
  mocks.decrementUsageForPeriod.mockResolvedValue(true)
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.update.mockResolvedValue({})
  mocks.count.mockResolvedValue(0)
})
afterEach(() => vi.clearAllMocks())

// ============================================
// SWEEPER — PENDING órfão (#197)
// ============================================

describe('sweepOrphanJobs — PENDING órfão (#197)', () => {
  function pendingRow(over: Record<string, unknown> = {}) {
    return {
      id: JOB_ID,
      userId: USER_ID,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      // expira bem no futuro → dentro do TTL pro re-enqueue
      expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
      inputFiles: validInputFiles,
      ...over,
    }
  }

  it('órfão ausente da fila, dentro do TTL + meta válido → re-enfileira (sem mudar status)', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    await sweepOrphanJobs(makeLock())
    expect(mocks.enqueueProcessJob).toHaveBeenCalledWith({ jobId: JOB_ID })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.decrementUsageForPeriod).not.toHaveBeenCalled()
  })

  it('órfão ainda na fila (present) → skip (não é órfão)', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue({
      present: true,
      state: 'waiting',
    })
    await sweepOrphanJobs(makeLock())
    expect(mocks.enqueueProcessJob).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('fila não configurada (state null) → inconclusivo, não marca órfão', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue(null)
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.enqueueProcessJob).not.toHaveBeenCalled()
  })

  it('órfão expirado (fora do TTL) → FAILED + refund no período do createdAt', async () => {
    findManyOnce([
      pendingRow({ expiresAt: new Date(Date.now() + 60 * 1000) }), // < margem 1h
    ])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    await sweepOrphanJobs(makeLock())
    expect(mocks.enqueueProcessJob).not.toHaveBeenCalled()
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID, status: 'PENDING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    // período do createdAt (2026-06), não o corrente; 3º arg = tx client
    expect(mocks.decrementUsageForPeriod).toHaveBeenCalledWith(
      USER_ID,
      '2026-06',
      expect.anything(),
    )
  })

  it('órfão com inputFiles inválido → FAILED + refund (não re-enfileira lixo)', async () => {
    findManyOnce([pendingRow({ inputFiles: { garbage: true } })])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    await sweepOrphanJobs(makeLock())
    expect(mocks.enqueueProcessJob).not.toHaveBeenCalled()
    expect(mocks.decrementUsageForPeriod).toHaveBeenCalled()
  })

  it('claim perde a corrida pro worker (count 0) → NÃO estorna', async () => {
    findManyOnce([pendingRow({ expiresAt: new Date(Date.now() + 60 * 1000) })])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    mocks.updateMany.mockResolvedValue({ count: 0 })
    await sweepOrphanJobs(makeLock())
    expect(mocks.decrementUsageForPeriod).not.toHaveBeenCalled()
  })

  it('re-enqueue falha → cai pro FAILED + refund', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    mocks.enqueueProcessJob.mockRejectedValue(new Error('queue down'))
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).toHaveBeenCalled()
    expect(mocks.decrementUsageForPeriod).toHaveBeenCalled()
  })
})

// ============================================
// SWEEPER — PROCESSING travado (6.7b)
// ============================================

describe('sweepOrphanJobs — PROCESSING travado (6.7b)', () => {
  function stuckRow() {
    return {
      id: JOB_ID,
      userId: USER_ID,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    }
  }

  it('ausente da fila → force FAILED (sem refund, D-2b)', async () => {
    // 1ª fase (pending) vazia, 2ª fase (stuck) com 1 row.
    mocks.findMany
      .mockResolvedValueOnce([]) // pending sweep
      .mockResolvedValueOnce([stuckRow()]) // stuck sweep
      .mockResolvedValue([])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID, status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
    expect(mocks.decrementUsageForPeriod).not.toHaveBeenCalled()
  })

  it('terminal na fila (failed) → force FAILED', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stuckRow()])
      .mockResolvedValue([])
    mocks.getProcessJobState.mockResolvedValue({
      present: true,
      state: 'failed',
    })
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).toHaveBeenCalled()
  })

  it('ainda ativo na fila → NÃO força (anti R-1)', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stuckRow()])
      .mockResolvedValue([])
    mocks.getProcessJobState.mockResolvedValue({
      present: true,
      state: 'active',
    })
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('fila não configurada (state null) → skip', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stuckRow()])
      .mockResolvedValue([])
    mocks.getProcessJobState.mockResolvedValue(null)
    await sweepOrphanJobs(makeLock())
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})

// ============================================
// SWEEPER — dry-run + gauges
// ============================================

describe('sweepOrphanJobs — dry-run e gauges', () => {
  it('dry-run conta candidatos e NÃO muta', async () => {
    mocks.env.CRON_DRY_RUN = true
    mocks.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2)
    await sweepOrphanJobs(makeLock())
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.setAsyncCleanupCount).not.toHaveBeenCalled()
  })

  it('seta gauges orphan/stuck ao fim (reenqueued + failed-refunded separados)', async () => {
    mocks.findMany.mockResolvedValue([])
    await sweepOrphanJobs(makeLock())
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'orphan-reenqueued',
      0,
    )
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'orphan-failed-refunded',
      0,
    )
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'stuck-processing',
      0,
    )
  })
})

// ============================================
// STORAGE CLEANUP (6.7a)
// ============================================

describe('purgeAsyncJobStorage — inputs de terminais (M-03)', () => {
  let storage: { removeByPath: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    storage = {
      removeByPath: vi
        .fn()
        .mockResolvedValue({ deleted: true, notFound: false }),
    }
    mocks.getStorageAdapter.mockReturnValue(storage)
  })

  function terminalRow() {
    return {
      id: JOB_ID,
      userId: USER_ID,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      inputFiles: validInputFiles,
    }
  }

  it('remove TODOS os inputs → seta inputs_purged_at', async () => {
    mocks.findMany
      .mockResolvedValueOnce([terminalRow()]) // inputs phase
      .mockResolvedValue([]) // outputs phase + breaks
    await purgeAsyncJobStorage(makeLock())
    expect(storage.removeByPath).toHaveBeenCalledTimes(2) // 2 inputs
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID },
        data: { inputsPurgedAt: expect.any(Date) },
      }),
    )
  })

  it('remove PARCIAL (1 falha) → NÃO seta inputs_purged_at (M-03)', async () => {
    mocks.findMany.mockResolvedValueOnce([terminalRow()]).mockResolvedValue([])
    storage.removeByPath
      .mockResolvedValueOnce({ deleted: true, notFound: false })
      .mockRejectedValueOnce(new Error('storage 500'))
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('inputFiles ilegível → skip + alerta, não toca Storage', async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ ...terminalRow(), inputFiles: { x: 1 } }])
      .mockResolvedValue([])
    await purgeAsyncJobStorage(makeLock())
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.emitSchedulerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.async_cleanup.inputfiles_unparseable',
      }),
    )
  })

  it('storage indisponível → return sem erro', async () => {
    mocks.getStorageAdapter.mockReturnValue(null)
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('heartbeat perdido aborta o storage cleanup sem ler/mutar (ambas as fases)', async () => {
    // Cobre o break por heartbeat lost em purgeTerminalInputs E purgeExpiredOutputs:
    // com heartbeat false desde o início, nenhuma fase chega ao findMany/Storage,
    // mas o handler ainda fecha setando o gauge final (não aborta o processo todo).
    const lock = makeLock()
    ;(lock.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    await purgeAsyncJobStorage(lock)
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'storage-purge-pending',
      0,
    )
  })
})

describe('purgeAsyncJobStorage — outputs expirados (A-4)', () => {
  let storage: { removeByPath: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    storage = {
      removeByPath: vi
        .fn()
        .mockResolvedValue({ deleted: true, notFound: false }),
    }
    mocks.getStorageAdapter.mockReturnValue(storage)
  })

  function outputRow(outputFormat: string | null = 'xlsx') {
    return {
      id: JOB_ID,
      userId: USER_ID,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      outputFormat,
    }
  }

  it('output expirado → remove + tombstone (outputFileUrl=null)', async () => {
    mocks.findMany
      .mockResolvedValueOnce([]) // inputs phase
      .mockResolvedValueOnce([outputRow('xlsx')]) // outputs phase
      .mockResolvedValue([])
    await purgeAsyncJobStorage(makeLock())
    expect(storage.removeByPath).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID },
        data: { outputFileUrl: null },
      }),
    )
  })

  it('output com formato inválido → tombstone sem tocar Storage', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([outputRow('pdf')])
      .mockResolvedValue([])
    await purgeAsyncJobStorage(makeLock())
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { outputFileUrl: null } }),
    )
  })

  it('remove de output falha (5xx) → NÃO tombstona (retoma próximo run)', async () => {
    mocks.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([outputRow('csv')])
      .mockResolvedValue([])
    storage.removeByPath.mockRejectedValue(new Error('storage 500'))
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('dry-run conta e não muta', async () => {
    mocks.env.CRON_DRY_RUN = true
    mocks.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2)
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.getStorageAdapter).not.toHaveBeenCalled()
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('seta gauge storage-purge-pending ao fim', async () => {
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(0)
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'storage-purge-pending',
      0,
    )
  })

  it('gauge pending > 1000 → emite purge_pending_overdue', async () => {
    mocks.getStorageAdapter.mockReturnValue({
      removeByPath: vi
        .fn()
        .mockResolvedValue({ deleted: true, notFound: false }),
    })
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(1500)
    await purgeAsyncJobStorage(makeLock())
    expect(mocks.emitSchedulerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.async_cleanup.purge_pending_overdue',
      }),
    )
  })
})

// ============================================
// BRANCHES ADICIONAIS — refund edge, heartbeat, catch, batch cheio
// ============================================

describe('async-cleanup — branches de robustez', () => {
  function pendingRow() {
    return {
      id: JOB_ID,
      userId: USER_ID,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      expiresAt: new Date(Date.now() + 60 * 1000), // fora do TTL → FAILED+refund
      inputFiles: validInputFiles,
    }
  }

  it('refund noop (decrement → false) não derruba o run', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    mocks.decrementUsageForPeriod.mockResolvedValue(false)
    await expect(sweepOrphanJobs(makeLock())).resolves.toBeUndefined()
  })

  it('refund lança erro → captura e segue (best-effort)', async () => {
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockResolvedValue({ present: false })
    mocks.decrementUsageForPeriod.mockRejectedValue(new Error('db down'))
    await expect(sweepOrphanJobs(makeLock())).resolves.toBeUndefined()
  })

  it('heartbeat perdido aborta o sweep sem mutar', async () => {
    findManyOnce([pendingRow()])
    const lock = makeLock()
    ;(lock.heartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    await sweepOrphanJobs(lock)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it('erro inesperado no sweep → Sentry.captureException + rethrow', async () => {
    mocks.findMany.mockRejectedValue(new Error('pg exploded'))
    await expect(sweepOrphanJobs(makeLock())).rejects.toThrow('pg exploded')
    expect(mocks.captureException).toHaveBeenCalled()
  })

  it('blip de Redis na inspeção da fila → pula a linha, NÃO aborta o batch', async () => {
    // safeGetJobState captura o erro do getProcessJobState → null (inconclusivo)
    // → a linha é pulada e o run completa normalmente (resiliência por-linha).
    findManyOnce([pendingRow()])
    mocks.getProcessJobState.mockRejectedValue(new Error('redis ECONNRESET'))
    await expect(sweepOrphanJobs(makeLock())).resolves.toBeUndefined()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it('erro inesperado no storage cleanup → Sentry.captureException + rethrow', async () => {
    mocks.getStorageAdapter.mockReturnValue({
      removeByPath: vi.fn(),
    })
    mocks.findMany.mockRejectedValue(new Error('pg exploded'))
    await expect(purgeAsyncJobStorage(makeLock())).rejects.toThrow(
      'pg exploded',
    )
    expect(mocks.captureException).toHaveBeenCalled()
  })

  it('batch cheio (500) → pagina com sleep e drena no 2º SELECT', async () => {
    // 500 rows todos "na fila" (present) → sem mutação, exercita o
    // `fresh.length === BATCH_SIZE` (paginação + sleep) e o break no 2º batch.
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: JOB_ID,
      userId: USER_ID,
      createdAt: new Date('2026-06-22T10:00:00.000Z'),
      expiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000),
      inputFiles: validInputFiles,
      _k: i, // diferencia (mesmo id, mas o seenIds usa id → 2º batch drena)
    }))
    mocks.findMany.mockResolvedValueOnce(full).mockResolvedValue([])
    mocks.getProcessJobState.mockResolvedValue({
      present: true,
      state: 'waiting',
    })
    await sweepOrphanJobs(makeLock())
    expect(mocks.setAsyncCleanupCount).toHaveBeenCalledWith(
      'orphan-reenqueued',
      0,
    )
  })
})
