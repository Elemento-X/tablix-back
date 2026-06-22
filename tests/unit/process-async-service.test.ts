/**
 * Unit tests — createAsyncJob (Card 6.3, src/modules/process/process-async.service).
 *
 * Coração do caminho LRO. Prova as DECISÕES FECHADAS por COMPORTAMENTO
 * (mutation-resistant), não só linha coberta:
 *   - A-QUOTA/D-3: quota reservada ATÔMICA ANTES de criar Job/upload/enqueue
 *     (ordem verificada via invocationCallOrder — anti-bypass).
 *   - Saga de compensação: falha de INFRA (create/upload/enqueue) estorna a
 *     quota (decrementUsage) + remove os inputs subidos + marca Job FAILED.
 *   - A-REFUND: o worker (6.4) está FORA deste card — não testado.
 *   - A-LIMITS: 30MB por arquivo + total PRO_LIMITS.maxTotalSize.
 *   - Timeout enqueue: Redis pendurado → QueueUnavailableError → 503 (Promise.race).
 *   - Mapeamento de erros: QueueUnavailableError→503, AppError preservado,
 *     desconhecido→processingFailed (500) sem vazar interno.
 *
 * Mocks: prisma, logger, storage (getStorageAdapter), usage.service
 * (validateAndIncrementUsage/decrementUsage), queue (enqueueProcessJob +
 * QueueUnavailableError). NÃO mocka key-builder nem storage/types (reais —
 * exercitam path real e validação de UUID).
 *
 * @owner: @tester
 * @card: 6.3
 */
/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UUID v4 estritos — buildJobInputPath (real) valida userId/jobId via regex.
const USER_ID = '550e8400-e29b-41d4-a716-446655440000'
const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'
const CREATED_AT = new Date('2026-06-21T10:00:00.000Z')

const {
  prismaMock,
  storageMock,
  getStorageAdapterMock,
  validateAndIncrementUsageMock,
  decrementUsageMock,
  enqueueMock,
  loggerMock,
  QueueUnavailableErrorMock,
} = vi.hoisted(() => {
  // Réplica mínima da QueueUnavailableError real — mesma classe usada pelo
  // service (via mock do módulo) e pelo teste, então instanceof é consistente.
  class QueueUnavailableError extends Error {
    code = 'QUEUE_UNAVAILABLE'
    constructor() {
      super('Process queue not configured')
      this.name = 'QueueUnavailableError'
    }
  }
  return {
    prismaMock: { job: { create: vi.fn(), update: vi.fn() } },
    storageMock: { uploadJobInput: vi.fn(), removeByPath: vi.fn() },
    getStorageAdapterMock: vi.fn(),
    validateAndIncrementUsageMock: vi.fn(),
    decrementUsageMock: vi.fn(),
    enqueueMock: vi.fn(),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    QueueUnavailableErrorMock: QueueUnavailableError,
  }
})

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return {
    env: {
      ...testEnv,
      ASYNC_JOB_TTL_HOURS: 24,
      ASYNC_PROCESSING_ENABLED: true,
    },
  }
})
vi.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('../../src/lib/logger', () => ({ logger: loggerMock }))
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: getStorageAdapterMock,
}))
vi.mock('../../src/modules/usage/usage.service', () => ({
  validateAndIncrementUsage: validateAndIncrementUsageMock,
  decrementUsage: decrementUsageMock,
}))
vi.mock('../../src/lib/queue/process-queue', () => ({
  enqueueProcessJob: enqueueMock,
  QueueUnavailableError: QueueUnavailableErrorMock,
}))

import { createAsyncJob } from '../../src/modules/process/process-async.service'
import { QueueUnavailableError } from '../../src/lib/queue/process-queue'
import { AppError, Errors } from '../../src/errors/app-error'
import { PRO_LIMITS } from '../../src/config/plan-limits'

function baseParams(
  overrides: Partial<Parameters<typeof createAsyncJob>[0]> = {},
) {
  return {
    userId: USER_ID,
    plan: 'PRO' as const,
    files: [{ buffer: Buffer.from('Name\nAlice'), fileName: 'a.csv' }],
    input: { selectedColumns: ['Name'], outputFormat: 'xlsx' as const },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getStorageAdapterMock.mockReturnValue(storageMock)
  validateAndIncrementUsageMock.mockResolvedValue({
    unificationsCount: 1,
    limit: 30,
  })
  prismaMock.job.create.mockResolvedValue({ id: JOB_ID, createdAt: CREATED_AT })
  prismaMock.job.update.mockResolvedValue({})
  storageMock.uploadJobInput.mockResolvedValue({ path: 'scoped/path' })
  storageMock.removeByPath.mockResolvedValue({ deleted: true, notFound: false })
  enqueueMock.mockResolvedValue({ enqueuedJobId: JOB_ID })
  decrementUsageMock.mockResolvedValue(true)
})

// ===========================================================================
// HAPPY PATH + invariante de ordem (anti-bypass A-QUOTA/D-3)
// ===========================================================================
describe('createAsyncJob — happy path', () => {
  it('retorna DTO 202 (jobId, PENDING, createdAt/expiresAt ISO UTC) sem compensar', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'))
    try {
      const result = await createAsyncJob(baseParams())

      expect(result).toEqual({
        jobId: JOB_ID,
        status: 'PENDING',
        createdAt: '2026-06-21T10:00:00.000Z',
        // Date.now() + 24h (ASYNC_JOB_TTL_HOURS=24) — determinístico via fake clock.
        expiresAt: '2026-06-22T10:00:00.000Z',
      })
      // NUNCA compensa no happy path.
      expect(decrementUsageMock).not.toHaveBeenCalled()
      expect(storageMock.removeByPath).not.toHaveBeenCalled()
      expect(prismaMock.job.update).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserva quota ATÔMICA ANTES de criar Job/upload/enqueue (anti-bypass)', async () => {
    await createAsyncJob(baseParams())

    const quotaOrder = validateAndIncrementUsageMock.mock.invocationCallOrder[0]
    const createOrder = prismaMock.job.create.mock.invocationCallOrder[0]
    const uploadOrder = storageMock.uploadJobInput.mock.invocationCallOrder[0]
    const enqueueOrder = enqueueMock.mock.invocationCallOrder[0]

    expect(quotaOrder).toBeLessThan(createOrder)
    expect(createOrder).toBeLessThan(uploadOrder)
    expect(uploadOrder).toBeLessThan(enqueueOrder)
    expect(validateAndIncrementUsageMock).toHaveBeenCalledWith(USER_ID, 'PRO')
  })

  it('persiste Job PENDING com inputFiles (metadados, sem bytes) + outputFormat + expiresAt', async () => {
    await createAsyncJob(baseParams())

    const arg = prismaMock.job.create.mock.calls[0][0]
    expect(arg.data).toMatchObject({
      userId: USER_ID,
      status: 'PENDING',
      outputFormat: 'xlsx',
    })
    expect(arg.data.inputFiles).toEqual({
      files: [
        {
          index: 0,
          fileName: 'a.csv',
          ext: 'csv',
          size: Buffer.from('Name\nAlice').length,
        },
      ],
      selectedColumns: ['Name'],
    })
    expect(arg.data.expiresAt).toBeInstanceOf(Date)
  })

  it('sobe cada input com path interno + contentType derivado da extensão', async () => {
    await createAsyncJob(
      baseParams({
        files: [
          { buffer: Buffer.from('a'), fileName: 'one.csv' },
          { buffer: Buffer.from('bb'), fileName: 'two.xlsx' },
        ],
      }),
    )

    expect(storageMock.uploadJobInput).toHaveBeenCalledTimes(2)
    expect(storageMock.uploadJobInput).toHaveBeenNthCalledWith(1, {
      userId: USER_ID,
      jobId: JOB_ID,
      index: 0,
      ext: 'csv',
      buffer: Buffer.from('a'),
      contentType: 'text/csv',
      // F-2: âncora temporal = Job.createdAt (SSOT), nunca o relógio do upload.
      createdAt: CREATED_AT,
    })
    expect(storageMock.uploadJobInput).toHaveBeenNthCalledWith(2, {
      userId: USER_ID,
      jobId: JOB_ID,
      index: 1,
      ext: 'xlsx',
      buffer: Buffer.from('bb'),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      createdAt: CREATED_AT,
    })
  })

  it('enfileira usando o Job.id criado como jobId estável', async () => {
    await createAsyncJob(baseParams())
    expect(enqueueMock).toHaveBeenCalledWith({ jobId: JOB_ID })
  })
})

// ===========================================================================
// VALIDAÇÃO ESTRUTURAL (pré-quota — NUNCA reserva, NUNCA compensa)
// ===========================================================================
describe('createAsyncJob — validação estrutural (antes da reserva de quota)', () => {
  it('rejeita lista de arquivos vazia (400) sem tocar quota', async () => {
    await expect(
      createAsyncJob(baseParams({ files: [] })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita mais que PRO_LIMITS.maxInputFiles (limitExceeded) sem tocar quota', async () => {
    const files = Array.from(
      { length: PRO_LIMITS.maxInputFiles + 1 },
      (_, i) => ({
        buffer: Buffer.from('x'),
        fileName: `f${i}.csv`,
      }),
    )
    await expect(createAsyncJob(baseParams({ files }))).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      statusCode: 400,
    })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita arquivo individual acima de 30MB (A-LIMITS) sem tocar quota', async () => {
    const big = {
      buffer: Buffer.alloc(30 * 1024 * 1024 + 1),
      fileName: 'big.csv',
    }
    await expect(
      createAsyncJob(baseParams({ files: [big] })),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita soma total acima de PRO_LIMITS.maxTotalSize mesmo com arquivos < 30MB cada', async () => {
    const half = { buffer: Buffer.alloc(16 * 1024 * 1024), fileName: 'h.csv' }
    await expect(
      createAsyncJob(
        baseParams({
          files: [
            { ...half, fileName: 'a.csv' },
            { ...half, fileName: 'b.csv' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita extensão fora da whitelist (defense in depth no service) sem tocar quota', async () => {
    await expect(
      createAsyncJob(
        baseParams({
          files: [{ buffer: Buffer.from('x'), fileName: 'doc.pdf' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita arquivo sem extensão (sem ponto no nome) sem tocar quota', async () => {
    await expect(
      createAsyncJob(
        baseParams({
          files: [{ buffer: Buffer.from('x'), fileName: 'noextfile' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })

  it('rejeita com 500 quando storage indisponível, ANTES de reservar quota', async () => {
    getStorageAdapterMock.mockReturnValue(null)
    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    })
    expect(validateAndIncrementUsageMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// QUOTA — limite atingido (400) NÃO compensa (nada foi reservado)
// ===========================================================================
describe('createAsyncJob — quota esgotada', () => {
  it('propaga limitExceeded (400) sem criar Job nem compensar', async () => {
    validateAndIncrementUsageMock.mockRejectedValue(
      Errors.limitExceeded('30 unificações/mês', '30 utilizadas'),
    )
    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      statusCode: 400,
    })
    expect(prismaMock.job.create).not.toHaveBeenCalled()
    // Reserva falhou → NADA a estornar (catch da saga não roda).
    expect(decrementUsageMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// SAGA DE COMPENSAÇÃO — falha de infra pós-reserva
// ===========================================================================
describe('createAsyncJob — saga de compensação', () => {
  it('enqueue falha (erro genérico) → estorna quota + remove input + marca FAILED + 500', async () => {
    enqueueMock.mockRejectedValue(new Error('redis boom'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
      statusCode: 500,
    })

    // 1. estorna quota
    expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
    // 2. remove o input já subido (1 arquivo)
    expect(storageMock.removeByPath).toHaveBeenCalledTimes(1)
    // 3. marca Job FAILED com inputsPurgedAt (uploadedCount > 0)
    const updateArg = prismaMock.job.update.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: JOB_ID })
    expect(updateArg.data).toMatchObject({
      status: 'FAILED',
      errorMessage: expect.any(String),
    })
    expect(updateArg.data.completedAt).toBeInstanceOf(Date)
    expect(updateArg.data.inputsPurgedAt).toBeInstanceOf(Date)
  })

  it('compensa na ordem: estorna quota → remove inputs → marca FAILED', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    await expect(createAsyncJob(baseParams())).rejects.toBeInstanceOf(AppError)

    const decOrder = decrementUsageMock.mock.invocationCallOrder[0]
    const rmOrder = storageMock.removeByPath.mock.invocationCallOrder[0]
    const updOrder = prismaMock.job.update.mock.invocationCallOrder[0]
    expect(decOrder).toBeLessThan(rmOrder)
    expect(rmOrder).toBeLessThan(updOrder)
  })

  it('enqueue lança QueueUnavailableError → 503 + compensação completa', async () => {
    enqueueMock.mockRejectedValue(new QueueUnavailableError())

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
      statusCode: 503,
    })
    expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
    expect(prismaMock.job.update).toHaveBeenCalled()
  })

  it('upload do 2º de 2 inputs falha → remove APENAS o 1 já subido (uploadedCount)', async () => {
    storageMock.uploadJobInput
      .mockResolvedValueOnce({ path: 'p0' })
      .mockRejectedValueOnce(new Error('upload boom'))

    await expect(
      createAsyncJob(
        baseParams({
          files: [
            { buffer: Buffer.from('a'), fileName: 'a.csv' },
            { buffer: Buffer.from('b'), fileName: 'b.csv' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_FAILED' })

    // Só 1 input chegou a subir → só 1 cleanup.
    expect(storageMock.removeByPath).toHaveBeenCalledTimes(1)
    expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
  })

  it('job.create falha → jobId null: estorna quota mas NÃO remove input nem faz update', async () => {
    prismaMock.job.create.mockRejectedValue(new Error('db down'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })
    expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
    // jobId é null → nada pra remover/atualizar.
    expect(storageMock.removeByPath).not.toHaveBeenCalled()
    expect(prismaMock.job.update).not.toHaveBeenCalled()
  })

  it('AppError do storage é PRESERVADO (não vira processingFailed genérico)', async () => {
    const appErr = Errors.validationError('Formato de arquivo não suportado')
    storageMock.uploadJobInput.mockRejectedValue(appErr)

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    })
    // Mesmo preservando o erro, a compensação roda.
    expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
  })
})

// ===========================================================================
// COMPENSAÇÃO BEST-EFFORT — nunca mascara o erro original
// ===========================================================================
describe('createAsyncJob — compensação best-effort', () => {
  it('decrementUsage rejeitando NÃO mascara o erro original (loga error)', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    decrementUsageMock.mockRejectedValue(new Error('decrement falhou'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })
    expect(loggerMock.error).toHaveBeenCalled()
    // Mesmo com estorno falho, prossegue pro cleanup + FAILED.
    expect(storageMock.removeByPath).toHaveBeenCalledTimes(1)
    expect(prismaMock.job.update).toHaveBeenCalled()
  })

  it('decrementUsage retornando false loga warn de noop mas prossegue', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    decrementUsageMock.mockResolvedValue(false)

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'async.refund.noop' }),
      expect.any(String),
    )
    expect(prismaMock.job.update).toHaveBeenCalled()
  })

  it('rejeições não-Error em toda a saga são serializadas via String(err) sem crash', async () => {
    // Cobre os ramos defensivos `err instanceof Error ? err.message : String(err)`
    // (lado não-Error) em todos os catches da compensação + erro final.
    enqueueMock.mockRejectedValue('queue exploded as string')
    decrementUsageMock.mockRejectedValue('decrement string')
    storageMock.removeByPath.mockRejectedValue('remove string')
    prismaMock.job.update.mockRejectedValue('update string')

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
      statusCode: 500,
    })
    // Erro original não-Error chega ao logger.error final sem quebrar.
    expect(loggerMock.error).toHaveBeenCalled()
  })

  it('removeByPath rejeitando é engolido — segue marcando FAILED', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    storageMock.removeByPath.mockRejectedValue(new Error('storage gone'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })
    expect(loggerMock.warn).toHaveBeenCalled()
    expect(prismaMock.job.update).toHaveBeenCalled()
  })

  it('job.update (FAILED) rejeitando é engolido — erro original ainda propaga', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    prismaMock.job.update.mockRejectedValue(new Error('update falhou'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })
    expect(loggerMock.error).toHaveBeenCalled()
  })
})

// ===========================================================================
// TIMEOUT DO ENQUEUE — Promise.race converte Redis pendurado em 503
// ===========================================================================
describe('createAsyncJob — timeout de enqueue', () => {
  it('enqueue pendurado por 5s → QueueUnavailableError → 503 + compensação', async () => {
    vi.useFakeTimers()
    try {
      // Promise que nunca resolve simula Redis inalcançável com lazyConnect.
      enqueueMock.mockReturnValue(new Promise(() => {}))

      const promise = createAsyncJob(baseParams())
      const expectation = expect(promise).rejects.toMatchObject({
        code: 'QUEUE_UNAVAILABLE',
        statusCode: 503,
      })
      // Avança o relógio até disparar o setTimeout do race (ENQUEUE_TIMEOUT_MS).
      await vi.advanceTimersByTimeAsync(5_000)
      await expectation

      expect(decrementUsageMock).toHaveBeenCalledWith(USER_ID)
      expect(prismaMock.job.update).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('enqueue rápido NÃO dispara o timeout (sem 503 espúrio)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'))
    try {
      enqueueMock.mockResolvedValue({ enqueuedJobId: JOB_ID })
      const result = await createAsyncJob(baseParams())
      expect(result.status).toBe('PENDING')
      // Avançar o relógio depois de concluído não deve causar efeito (timer limpo).
      await vi.advanceTimersByTimeAsync(10_000)
      expect(prismaMock.job.update).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ===========================================================================
// F-2 (@security/@reviewer): DETERMINISMO do path — ancorado em Job.createdAt,
// NUNCA no relógio do upload/cleanup. Se a data fosse derivada de `new Date()`
// a cada chamada, o cleanup/worker num dia UTC diferente reconstruiria um path
// distinto → input não encontrado + órfão de PII (LGPD).
// ===========================================================================
describe('createAsyncJob — determinismo temporal do path (@security F-2)', () => {
  it('upload usa Job.createdAt como âncora mesmo com o relógio em outro dia UTC', async () => {
    vi.useFakeTimers()
    // Relógio "agora" no dia SEGUINTE ao createdAt do Job (CREATED_AT = 06-21).
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'))
    try {
      await createAsyncJob(baseParams())
      // O upload é ancorado em Job.createdAt (06-21), não no wall clock (06-22).
      expect(storageMock.uploadJobInput).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: CREATED_AT }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('saga reconstrói o MESMO path do upload (data = createdAt), independente do relógio', async () => {
    vi.useFakeTimers()
    // createdAt = 2026-06-21; wall clock avançado pra 2026-06-22.
    vi.setSystemTime(new Date('2026-06-22T08:00:00.000Z'))
    try {
      // Falha de enqueue dispara a saga → removeByPath com path REAL (key-builder
      // não é mockado): a data embutida tem que vir de createdAt, não de "agora".
      enqueueMock.mockRejectedValue(new Error('boom'))

      await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
        code: 'PROCESSING_FAILED',
      })

      expect(storageMock.removeByPath).toHaveBeenCalledTimes(1)
      const reconstructedPath = storageMock.removeByPath.mock.calls[0][0]
      // Path real: {userId}/{YYYY-MM-DD createdAt}/{jobKey}/input-00.csv
      expect(reconstructedPath).toContain('/2026-06-21/')
      expect(reconstructedPath).not.toContain('/2026-06-22/')
      // E é o mesmo prefixo de data que o upload recebeu via createdAt.
      expect(storageMock.uploadJobInput).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: CREATED_AT }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ===========================================================================
// M-03: inputsPurgedAt só é setado quando TODOS os inputs subidos foram
// removidos (removedCount === uploadedCount). Purge parcial → NULL, pro cron
// 6.7 reprocessar (senão `WHERE inputs_purged_at IS NULL` pularia o órfão).
// ===========================================================================
describe('createAsyncJob — purge parcial na compensação (M-03)', () => {
  function twoFilesParams() {
    return baseParams({
      files: [
        { buffer: Buffer.from('a'), fileName: 'a.csv' },
        { buffer: Buffer.from('b'), fileName: 'b.csv' },
      ],
    })
  }

  it('TODOS os inputs removidos → inputsPurgedAt é setado (Date)', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    storageMock.removeByPath.mockResolvedValue({
      deleted: true,
      notFound: false,
    })

    await expect(createAsyncJob(twoFilesParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })

    expect(storageMock.removeByPath).toHaveBeenCalledTimes(2)
    const updateArg = prismaMock.job.update.mock.calls[0][0]
    expect(updateArg.data.inputsPurgedAt).toBeInstanceOf(Date)
  })

  it('um remove FALHA (1 de 2) → inputsPurgedAt fica NULL (cron 6.7 reprocessa)', async () => {
    enqueueMock.mockRejectedValue(new Error('boom'))
    // 1º remove OK, 2º rejeita → removedCount(1) !== uploadedCount(2).
    storageMock.removeByPath
      .mockResolvedValueOnce({ deleted: true, notFound: false })
      .mockRejectedValueOnce(new Error('storage flaky'))

    await expect(createAsyncJob(twoFilesParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })

    expect(storageMock.removeByPath).toHaveBeenCalledTimes(2)
    const updateArg = prismaMock.job.update.mock.calls[0][0]
    // NÃO marca purgado — deixa NULL pro cron recuperar o órfão restante.
    expect(updateArg.data.inputsPurgedAt).toBeNull()
    expect(updateArg.data.status).toBe('FAILED')
  })

  it('nenhum input subido (job.create ok mas 1º upload falha) → inputsPurgedAt NULL', async () => {
    // uploadedCount = 0 → allInputsPurged exige uploadedCount>0 → NULL.
    storageMock.uploadJobInput.mockRejectedValueOnce(new Error('upload boom'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })

    expect(storageMock.removeByPath).not.toHaveBeenCalled()
    const updateArg = prismaMock.job.update.mock.calls[0][0]
    expect(updateArg.data.inputsPurgedAt).toBeNull()
  })
})

// ===========================================================================
// D-1 (@devops): observabilidade do caminho de FALHA — métricas simétricas ao
// sucesso (async.job.created). Sem elas, um outage de fila fica silencioso e
// só vira ticket de usuário.
// ===========================================================================
describe('createAsyncJob — métricas de falha (@devops D-1)', () => {
  it('fila indisponível → logger.error metric async.enqueue.failed (reason queue_unavailable)', async () => {
    enqueueMock.mockRejectedValue(new QueueUnavailableError())

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
    })

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: 'async.enqueue.failed',
        reason: 'queue_unavailable',
        userId: USER_ID,
      }),
      expect.any(String),
    )
  })

  it('falha genérica (não-AppError) → logger.error metric async.job.failed', async () => {
    enqueueMock.mockRejectedValue(new Error('redis boom'))

    await expect(createAsyncJob(baseParams())).rejects.toMatchObject({
      code: 'PROCESSING_FAILED',
    })

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: 'async.job.failed',
        userId: USER_ID,
      }),
      expect.any(String),
    )
  })

  it('sucesso → logger.info metric async.job.created (simétrico ao caminho de falha)', async () => {
    await createAsyncJob(baseParams())
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'async.job.created', userId: USER_ID }),
      expect.any(String),
    )
  })
})

afterEach(() => {
  vi.useRealTimers()
})
