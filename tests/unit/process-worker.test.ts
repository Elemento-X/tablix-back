/**
 * Unit tests do handler do worker async (Card 6.4 — núcleo).
 *
 * Mocka as fronteiras (prisma, storage, parse-thread, Sentry) e exercita o
 * merge/generate REAIS (lib pura). Prova comportamento, não implementação:
 * claim idempotente, classificação permanente/transiente, FAILED sanitizado,
 * purge condicional (M-03) e a invariante de que transiente com retry NÃO
 * marca FAILED nem purga (preserva inputs).
 *
 * @owner: @tester
 * @card: 6.4
 */
/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnrecoverableError } from 'bullmq'
import { Errors } from '../../src/errors/app-error'
import { ParseTimeoutError } from '../../src/lib/spreadsheet/parse-in-thread'
import { ASYNC_FILE_SIZE_LIMIT } from '../../src/modules/process/process-async.service'

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  getStorageAdapter: vi.fn(),
  parseInWorkerThread: vi.fn(),
  captureException: vi.fn(),
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    job: {
      updateMany: mocks.updateMany,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      update: mocks.update,
    },
  },
}))
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: mocks.getStorageAdapter,
}))
vi.mock('../../src/lib/spreadsheet/parse-in-thread', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/lib/spreadsheet/parse-in-thread')
    >()
  return { ...actual, parseInWorkerThread: mocks.parseInWorkerThread }
})
vi.mock('../../src/config/sentry', () => ({
  Sentry: { captureException: mocks.captureException },
}))

import { processJob } from '../../src/lib/queue/process-worker'

const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'
const USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
const CREATED_AT = new Date('2026-06-21T10:00:00.000Z')

interface StorageStub {
  downloadByPath: ReturnType<typeof vi.fn>
  uploadJobOutput: ReturnType<typeof vi.fn>
  removeByPath: ReturnType<typeof vi.fn>
}
let storage: StorageStub

function baseArgs(over: Partial<Parameters<typeof processJob>[0]> = {}) {
  return { jobId: JOB_ID, attempt: 1, maxAttempts: 3, timeoutMs: 5000, ...over }
}

/** Configura o caminho feliz (claim ok, 1 input csv, parse válido). */
function setupHappy() {
  mocks.updateMany.mockResolvedValue({ count: 1 })
  mocks.findUniqueOrThrow.mockResolvedValue({
    userId: USER_ID,
    createdAt: CREATED_AT,
    inputFiles: {
      files: [{ index: 0, fileName: 'people.csv', ext: 'csv', size: 20 }],
      selectedColumns: ['name'],
    },
    outputFormat: 'csv',
  })
  mocks.update.mockResolvedValue({})
  storage.downloadByPath.mockResolvedValue({
    buffer: Buffer.from('name\nAlice\n'),
    contentType: 'text/csv',
  })
  storage.uploadJobOutput.mockResolvedValue({
    path: `${USER_ID}/2026-06-21/8c7e123456784abc89def01234567890/output.csv`,
  })
  storage.removeByPath.mockResolvedValue({ deleted: true, notFound: false })
  mocks.parseInWorkerThread.mockResolvedValue({
    fileName: 'input-00.csv',
    format: 'csv',
    headers: ['name'],
    rows: [{ name: 'Alice' }],
    rowCount: 1,
    fileSize: 20,
  })
}

beforeEach(() => {
  storage = {
    downloadByPath: vi.fn(),
    uploadJobOutput: vi.fn(),
    removeByPath: vi.fn(),
  }
  mocks.getStorageAdapter.mockReturnValue(storage)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('processJob — caminho feliz', () => {
  it('processa, sobe output, marca COMPLETED e purga inputs', async () => {
    setupHappy()
    const outcome = await processJob(baseArgs())

    expect(outcome).toEqual({ status: 'completed', jobId: JOB_ID })

    // COMPLETED com outputSize BigInt + outputFileUrl (path).
    const completedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'COMPLETED',
    )
    expect(completedCall).toBeDefined()
    expect(typeof completedCall![0].data.outputSize).toBe('bigint')
    expect(completedCall![0].data.outputFileUrl).toContain('/output.csv')

    // Purge de 1 input + inputsPurgedAt setado (todos removidos).
    expect(storage.removeByPath).toHaveBeenCalledTimes(1)
    const purgedCall = mocks.update.mock.calls.find(
      (c) => c[0].data.inputsPurgedAt instanceof Date,
    )
    expect(purgedCall).toBeDefined()
  })

  it('parseia em thread com fileName SINTÉTICO dirigido pela ext (anti-spoofing)', async () => {
    setupHappy()
    await processJob(baseArgs())
    expect(mocks.parseInWorkerThread).toHaveBeenCalledWith(
      expect.any(Buffer),
      'input-00.csv',
      5000,
    )
  })
})

describe('processJob — claim idempotente (B-6.4.2)', () => {
  it('claim count 0 (terminal/inexistente) → skipped, sem processar', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const outcome = await processJob(baseArgs())
    expect(outcome).toEqual({ status: 'skipped', jobId: JOB_ID })
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(storage.downloadByPath).not.toHaveBeenCalled()
  })
})

describe('processJob — erro PERMANENTE', () => {
  it('validação (AppError) → FAILED sanitizado + UnrecoverableError', async () => {
    setupHappy()
    mocks.parseInWorkerThread.mockRejectedValue(
      Errors.validationError('Colunas nao encontradas no arquivo secreto.csv'),
    )

    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )

    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
    // Mensagem genérica — NÃO vaza o nome do arquivo / detalhe interno.
    expect(failedCall![0].data.errorMessage).not.toContain('secreto.csv')
    expect(mocks.captureException).toHaveBeenCalled()
  })

  it('ParseTimeoutError → permanente → UnrecoverableError', async () => {
    setupHappy()
    mocks.parseInWorkerThread.mockRejectedValue(new ParseTimeoutError(5000))
    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall![0].data.errorMessage).toContain('tempo limite')
  })

  it('inputFiles com shape inválido → permanente, purge no-op (files desconhecidos)', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: USER_ID,
      createdAt: CREATED_AT,
      inputFiles: { garbage: true },
      outputFormat: 'csv',
    })
    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(storage.removeByPath).not.toHaveBeenCalled()
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall![0].data.inputsPurgedAt).toBeNull()
  })
})

describe('processJob — erro TRANSIENTE', () => {
  it('não-última tentativa → relança SEM marcar FAILED nem purgar (preserva inputs)', async () => {
    setupHappy()
    storage.downloadByPath.mockRejectedValue(new Error('storage 503'))

    await expect(
      processJob(baseArgs({ attempt: 1, maxAttempts: 3 })),
    ).rejects.toThrow('storage 503')

    // NÃO marcou FAILED, NÃO purgou — status fica PROCESSING pro retry.
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeUndefined()
    expect(storage.removeByPath).not.toHaveBeenCalled()
  })

  it('última tentativa → marca FAILED + relança erro original (não UnrecoverableError)', async () => {
    setupHappy()
    storage.downloadByPath.mockRejectedValue(new Error('storage 503'))

    const err = await processJob(
      baseArgs({ attempt: 3, maxAttempts: 3 }),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(UnrecoverableError)

    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
  })
})

describe('processJob — caminho feliz multi-input (merge real de N planilhas)', () => {
  it('2 inputs → merge real, COMPLETED, outputSize > 0 e purga ambos', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: USER_ID,
      createdAt: CREATED_AT,
      inputFiles: {
        files: [
          { index: 0, fileName: 'a.csv', ext: 'csv', size: 20 },
          { index: 1, fileName: 'b.csv', ext: 'csv', size: 20 },
        ],
        selectedColumns: ['name'],
      },
      outputFormat: 'csv',
    })
    storage.downloadByPath.mockResolvedValue({
      buffer: Buffer.from('name\nAlice\n'),
      contentType: 'text/csv',
    })
    storage.uploadJobOutput.mockResolvedValue({
      path: `${USER_ID}/2026-06-21/job/output.csv`,
    })
    storage.removeByPath.mockResolvedValue({ deleted: true, notFound: false })
    mocks.parseInWorkerThread
      .mockResolvedValueOnce({
        fileName: 'input-00.csv',
        format: 'csv',
        headers: ['name'],
        rows: [{ name: 'Alice' }],
        rowCount: 1,
        fileSize: 20,
      })
      .mockResolvedValueOnce({
        fileName: 'input-01.csv',
        format: 'csv',
        headers: ['name'],
        rows: [{ name: 'Bob' }],
        rowCount: 1,
        fileSize: 20,
      })

    const outcome = await processJob(baseArgs())
    expect(outcome).toEqual({ status: 'completed', jobId: JOB_ID })

    // Parse chamado 1x por input, com fileName sintético sequencial.
    expect(mocks.parseInWorkerThread).toHaveBeenCalledTimes(2)
    expect(mocks.parseInWorkerThread).toHaveBeenNthCalledWith(
      1,
      expect.any(Buffer),
      'input-00.csv',
      5000,
    )
    expect(mocks.parseInWorkerThread).toHaveBeenNthCalledWith(
      2,
      expect.any(Buffer),
      'input-01.csv',
      5000,
    )

    const completedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'COMPLETED',
    )
    expect(completedCall).toBeDefined()
    expect(completedCall![0].data.outputSize).toBeGreaterThan(0n)

    // Ambos os inputs purgados + inputsPurgedAt setado (2/2).
    expect(storage.removeByPath).toHaveBeenCalledTimes(2)
    const purgedCall = mocks.update.mock.calls.find(
      (c) => c[0].data.inputsPurgedAt instanceof Date,
    )
    expect(purgedCall).toBeDefined()
  })
})

describe('processJob — outputFormat inválido (validação permanente)', () => {
  it('outputFormat fora de csv|xlsx → permanente, FAILED, UnrecoverableError', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: USER_ID,
      createdAt: CREATED_AT,
      inputFiles: {
        files: [{ index: 0, fileName: 'a.csv', ext: 'csv', size: 20 }],
        selectedColumns: ['name'],
      },
      outputFormat: 'pdf', // não suportado
    })

    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    // Falha ANTES de baixar/parsear (validação de shape do output).
    expect(storage.downloadByPath).not.toHaveBeenCalled()
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
  })
})

describe('processJob — storage indisponível (misconfig — permanente)', () => {
  it('getStorageAdapter() null → FAILED sanitizado, purge no-op, UnrecoverableError', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: USER_ID,
      createdAt: CREATED_AT,
      inputFiles: {
        files: [{ index: 0, fileName: 'a.csv', ext: 'csv', size: 20 }],
        selectedColumns: ['name'],
      },
      outputFormat: 'csv',
    })
    mocks.getStorageAdapter.mockReturnValue(null)

    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
    // Sem storage → purge no-op (0/0) → inputsPurgedAt null.
    expect(failedCall![0].data.inputsPurgedAt).toBeNull()
    // Mensagem genérica (R-6) — não vaza "Storage indisponível".
    expect(failedCall![0].data.errorMessage).not.toContain('Storage')
    expect(mocks.captureException).toHaveBeenCalled()
  })
})

describe('processJob — read-back falha após claim (race job deletado)', () => {
  it('findUniqueOrThrow lança → propaga sem marcar FAILED (fora do try; retry transiente)', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.update.mockResolvedValue({})
    mocks.findUniqueOrThrow.mockRejectedValue(new Error('No Job found (P2025)'))

    await expect(processJob(baseArgs())).rejects.toThrow(/No Job found/)
    // Read-back está ANTES do try → não há FAILED nem purge; status fica
    // PROCESSING e o BullMQ retenta (claim aceita PROCESSING — B-6.4.2).
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeUndefined()
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(mocks.captureException).not.toHaveBeenCalled()
  })
})

describe('processJob — purge parcial (M-03)', () => {
  it('um removeByPath falha → inputsPurgedAt NÃO setado', async () => {
    setupHappy()
    // 2 inputs; o 2º falha ao remover.
    mocks.findUniqueOrThrow.mockResolvedValue({
      userId: USER_ID,
      createdAt: CREATED_AT,
      inputFiles: {
        files: [
          { index: 0, fileName: 'a.csv', ext: 'csv', size: 10 },
          { index: 1, fileName: 'b.csv', ext: 'csv', size: 10 },
        ],
        selectedColumns: ['name'],
      },
      outputFormat: 'csv',
    })
    storage.removeByPath
      .mockResolvedValueOnce({ deleted: true, notFound: false })
      .mockRejectedValueOnce(new Error('remove falhou'))

    await processJob(baseArgs())

    // Nenhum update setou inputsPurgedAt (remove parcial).
    const purgedCall = mocks.update.mock.calls.find(
      (c) => c[0].data.inputsPurgedAt instanceof Date,
    )
    expect(purgedCall).toBeUndefined()
  })
})

describe('processJob — write terminal GUARDADO por status (@dba ALTO)', () => {
  it('COMPLETED updateMany count 0 (outro executor já finalizou) → skipped, sem purge nem throw', async () => {
    setupHappy()
    // Claim vence (count 1), mas o write de COMPLETED perde a corrida (count 0):
    // outro executor concorrente (stalled re-delivery) já escreveu o terminal.
    mocks.updateMany.mockReset()
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 0 }) // COMPLETED perde a corrida

    const outcome = await processJob(baseArgs())

    // No-op idempotente: não sobrescreve nem relança; aborta ANTES do purge.
    expect(outcome).toEqual({ status: 'skipped', jobId: JOB_ID })
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it('FAILED updateMany count 0 (terminal já escrito) → skipped, sem relançar nem reportar', async () => {
    setupHappy()
    // Erro permanente (validação), mas o write de FAILED perde a corrida — o
    // job já está terminal no DB. Não regride o estado, não relança, não Sentry.
    mocks.parseInWorkerThread.mockRejectedValue(
      Errors.validationError('coluna ausente'),
    )
    mocks.updateMany.mockReset()
    mocks.updateMany
      .mockResolvedValueOnce({ count: 1 }) // claim
      .mockResolvedValueOnce({ count: 0 }) // FAILED perde a corrida

    const outcome = await processJob(baseArgs())

    expect(outcome).toEqual({ status: 'skipped', jobId: JOB_ID })
    // Ack idempotente: NÃO reporta ao Sentry (o trabalho já está resolvido).
    expect(mocks.captureException).not.toHaveBeenCalled()
  })
})

describe('processJob — OOM do worker_thread é PERMANENTE (@security/@devops ALTO)', () => {
  it('parse rejeita com code ERR_WORKER_OUT_OF_MEMORY → UnrecoverableError (sem retry)', async () => {
    setupHappy()
    const oom = Object.assign(new Error('Worker terminated due to OOM'), {
      code: 'ERR_WORKER_OUT_OF_MEMORY',
    })
    mocks.parseInWorkerThread.mockRejectedValue(oom)

    // OOM é determinístico no input (xlsx crafted) — retry só re-OOMa. Permanente.
    await expect(
      processJob(baseArgs({ attempt: 1, maxAttempts: 3 })),
    ).rejects.toBeInstanceOf(UnrecoverableError)

    // FAILED gravado (não fica preso em PROCESSING) + reportado ao Sentry.
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
    // Mensagem genérica — erro não-AppError não vaza detalhe interno.
    expect(failedCall![0].data.errorMessage).not.toContain('OOM')
    expect(mocks.captureException).toHaveBeenCalled()
  })
})

describe('processJob — revalidação de tamanho do buffer baixado (@security)', () => {
  it('downloadByPath retorna buffer > 30MB → validação permanente, NÃO parseia', async () => {
    setupHappy()
    // Não confia que o enqueue/bucket respeitaram o cap: revalida o conteúdo
    // baixado. Buffer acima do limite → AppError permanente antes de parsear.
    storage.downloadByPath.mockResolvedValue({
      buffer: { length: ASYNC_FILE_SIZE_LIMIT + 1 },
      contentType: 'text/csv',
    })

    await expect(processJob(baseArgs())).rejects.toBeInstanceOf(
      UnrecoverableError,
    )

    // Aborta ANTES do parse (não gasta thread com conteúdo oversize).
    expect(mocks.parseInWorkerThread).not.toHaveBeenCalled()
    const failedCall = mocks.updateMany.mock.calls.find(
      (c) => c[0].data.status === 'FAILED',
    )
    expect(failedCall).toBeDefined()
    // Mensagem genérica — não vaza o limite/detalhe interno.
    expect(failedCall![0].data.errorMessage).not.toContain('limite permitido')
  })
})
