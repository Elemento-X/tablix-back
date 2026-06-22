/**
 * Unit tests — processAsync controller (Card 6.3,
 * src/http/controllers/process-async.controller).
 *
 * Orquestra Idempotency-Key (Card #74) + coleta multipart (helper real) +
 * hash de payload + chamada ao service. Prova:
 *   - 401 sem user; 428 sem Idempotency-Key; 400 key inválida (>255)
 *   - Idempotency-Key como array usa o 1º valor
 *   - 400 sem arquivos / outputFormat inválido (não chega a adquirir lock)
 *   - begin: conflict→422, in_progress→409+Retry-After, hit→re-serve 202
 *     (sem reexecutar), miss→executa + completa + 202
 *   - falha do service → libera a key (releaseIdempotencyKey) + propaga
 *   - degraded → header Idempotency-Degraded
 *   - hash de payload: mesma entrada→mesmo bodyHash; bytes/colunas/ordem
 *     diferentes→bodyHash diferente (conflito de idempotência real)
 *   - 202 + Location + Cache-Control no-store
 *
 * collectSpreadsheetMultipart é REAL (exercita o helper extraído via o
 * controller). createAsyncJob e idempotency.service são mockados.
 *
 * @owner: @tester
 * @card: 6.3
 */
/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'
const RESULT = {
  jobId: JOB_ID,
  status: 'PENDING' as const,
  createdAt: '2026-06-21T10:00:00.000Z',
  expiresAt: '2026-06-22T10:00:00.000Z',
}

const { createAsyncJobMock, beginMock, completeMock, releaseMock } = vi.hoisted(
  () => ({
    createAsyncJobMock: vi.fn(),
    beginMock: vi.fn(),
    completeMock: vi.fn(),
    releaseMock: vi.fn(),
  }),
)

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return {
    env: {
      ...testEnv,
      ASYNC_PROCESSING_ENABLED: true,
      ASYNC_JOB_TTL_HOURS: 24,
    },
  }
})
vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../src/modules/process/process-async.service', () => ({
  createAsyncJob: createAsyncJobMock,
}))
vi.mock('../../src/lib/idempotency/idempotency.service', () => ({
  beginIdempotentOperation: beginMock,
  completeIdempotentOperation: completeMock,
  releaseIdempotencyKey: releaseMock,
}))

import { processAsync } from '../../src/http/controllers/process-async.controller'
import { Errors } from '../../src/errors/app-error'

const DEFAULT_USER = {
  sub: 'session-1',
  userId: '550e8400-e29b-41d4-a716-446655440000',
  email: 'pro@test.com',
  role: 'PRO' as const,
}

interface FilePart {
  filename: string
  content: string
  truncated?: boolean
}

function makeRequest(
  opts: {
    user?: typeof DEFAULT_USER | undefined
    headers?: Record<string, string | string[]>
    files?: FilePart[]
    fields?: Record<string, string | undefined>
  } = {},
) {
  const {
    headers = { 'idempotency-key': 'idem-key-123' },
    files = [{ filename: 'a.csv', content: 'Name\nAlice' }],
    fields = { selectedColumns: '["Name"]', outputFormat: 'xlsx' },
  } = opts
  // 'user' in opts honra um undefined explícito (testa 401) — default
  // por destructuring substituiria undefined por DEFAULT_USER (falso negativo).
  const user = 'user' in opts ? opts.user : DEFAULT_USER

  async function* parts() {
    for (const f of files) {
      yield {
        type: 'file' as const,
        filename: f.filename,
        file: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(f.content)
          },
          truncated: f.truncated ?? false,
        },
      }
    }
    for (const [fieldname, value] of Object.entries(fields)) {
      if (value !== undefined) {
        yield { type: 'field' as const, fieldname, value }
      }
    }
  }

  return {
    user,
    headers,
    parts: () => parts(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

function makeReply() {
  const headers: Record<string, string> = {}
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      reply.statusCode = code
      return reply
    }),
    header: vi.fn((k: string, v: string) => {
      headers[k] = v
      return reply
    }),
    send: vi.fn((b: unknown) => {
      reply.body = b
      return reply
    }),
    _headers: headers,
  }
  return reply
}

beforeEach(() => {
  vi.clearAllMocks()
  beginMock.mockResolvedValue({ status: 'miss' })
  completeMock.mockResolvedValue(undefined)
  releaseMock.mockResolvedValue(undefined)
  createAsyncJobMock.mockResolvedValue(RESULT)
})

// ===========================================================================
// AUTH + Idempotency-Key (borda)
// ===========================================================================
describe('processAsync — auth e Idempotency-Key', () => {
  it('401 quando não há request.user', async () => {
    const req = makeRequest({ user: undefined })
    await expect(
      processAsync(req as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    })
    expect(beginMock).not.toHaveBeenCalled()
  })

  it('428 quando Idempotency-Key ausente', async () => {
    const req = makeRequest({ headers: {} })
    await expect(
      processAsync(req as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      statusCode: 428,
    })
    expect(createAsyncJobMock).not.toHaveBeenCalled()
  })

  it('400 quando Idempotency-Key excede 255 chars', async () => {
    const req = makeRequest({ headers: { 'idempotency-key': 'x'.repeat(256) } })
    await expect(
      processAsync(req as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    })
    expect(beginMock).not.toHaveBeenCalled()
  })

  it('Idempotency-Key como array usa o primeiro valor', async () => {
    const req = makeRequest({
      headers: { 'idempotency-key': ['first-key', 'second-key'] },
    })
    await processAsync(req as never, makeReply() as never)
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'first-key' }),
    )
  })
})

// ===========================================================================
// MULTIPART / VALIDAÇÃO DO CORPO (antes de adquirir o lock)
// ===========================================================================
describe('processAsync — coleta e validação', () => {
  it('400 quando nenhum arquivo enviado (não adquire lock)', async () => {
    const req = makeRequest({ files: [] })
    await expect(
      processAsync(req as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    expect(beginMock).not.toHaveBeenCalled()
  })

  it('400 quando outputFormat é inválido (fora do enum)', async () => {
    const req = makeRequest({
      fields: { selectedColumns: '["Name"]', outputFormat: 'pdf' },
    })
    await expect(
      processAsync(req as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    expect(beginMock).not.toHaveBeenCalled()
  })

  it('passa scope/identifier/bodyHash corretos ao adquirir o lock', async () => {
    const req = makeRequest()
    await processAsync(req as never, makeReply() as never)
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'idem-key-123',
        scope: 'process-async',
        identifier: DEFAULT_USER.userId,
        bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    )
  })
})

// ===========================================================================
// IDEMPOTÊNCIA — estados do begin
// ===========================================================================
describe('processAsync — estados de idempotência', () => {
  it('conflict (mesma key, payload diferente) → 422 sem executar', async () => {
    beginMock.mockResolvedValue({ status: 'conflict' })
    await expect(
      processAsync(makeRequest() as never, makeReply() as never),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      statusCode: 422,
    })
    expect(createAsyncJobMock).not.toHaveBeenCalled()
  })

  it('in_progress → 409 + header Retry-After: 5', async () => {
    beginMock.mockResolvedValue({ status: 'in_progress' })
    const reply = makeReply()
    await expect(
      processAsync(makeRequest() as never, reply as never),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      statusCode: 409,
    })
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5')
    expect(createAsyncJobMock).not.toHaveBeenCalled()
  })

  it('hit (retry legítimo) → re-serve 202 mesmo jobId SEM reexecutar nem recompletar', async () => {
    beginMock.mockResolvedValue({ status: 'hit', cached: RESULT })
    const reply = makeReply()
    await processAsync(makeRequest() as never, reply as never)

    expect(reply.status).toHaveBeenCalledWith(202)
    expect(reply.header).toHaveBeenCalledWith(
      'Location',
      `/process/status/${JOB_ID}`,
    )
    expect(reply.send).toHaveBeenCalledWith(RESULT)
    expect(createAsyncJobMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('miss → executa service, completa a operação e responde 202', async () => {
    const reply = makeReply()
    await processAsync(makeRequest() as never, reply as never)

    expect(createAsyncJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: DEFAULT_USER.userId,
        plan: 'PRO',
        files: [{ buffer: expect.any(Buffer), fileName: 'a.csv' }],
        input: { selectedColumns: ['Name'], outputFormat: 'xlsx' },
      }),
    )
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'idem-key-123',
        scope: 'process-async',
        identifier: DEFAULT_USER.userId,
        data: RESULT,
      }),
    )
    expect(reply.status).toHaveBeenCalledWith(202)
    expect(reply._headers.Location).toBe(`/process/status/${JOB_ID}`)
    expect(reply._headers['Cache-Control']).toBe('no-store')
    expect(reply.send).toHaveBeenCalledWith(RESULT)
  })

  it('miss com begin degraded → header Idempotency-Degraded: true', async () => {
    beginMock.mockResolvedValue({ status: 'miss', degraded: true })
    const reply = makeReply()
    await processAsync(makeRequest() as never, reply as never)
    expect(reply._headers['Idempotency-Degraded']).toBe('true')
  })

  it('falha do service → libera a key pra retry e propaga o erro', async () => {
    createAsyncJobMock.mockRejectedValue(
      Object.assign(new Error('queue down'), {
        code: 'QUEUE_UNAVAILABLE',
        statusCode: 503,
      }),
    )
    await expect(
      processAsync(makeRequest() as never, makeReply() as never),
    ).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(releaseMock).toHaveBeenCalledWith({
      key: 'idem-key-123',
      scope: 'process-async',
      identifier: DEFAULT_USER.userId,
    })
    // Não grava resultado de operação que falhou.
    expect(completeMock).not.toHaveBeenCalled()
  })

  // D-2 (@devops): 503 de fila DEVE carregar Retry-After (api-contract.md exige
  // em 429/503) — senão o cliente retenta sem backoff → thundering herd contra
  // um Redis em recuperação. O header é setado ANTES do throw e persiste no
  // error handler global. Só dispara quando o erro é AppError QUEUE_UNAVAILABLE.
  it('503 QUEUE_UNAVAILABLE (AppError) → seta Retry-After: 5 + libera a key', async () => {
    createAsyncJobMock.mockRejectedValue(Errors.queueUnavailable())
    const reply = makeReply()

    await expect(
      processAsync(makeRequest() as never, reply as never),
    ).rejects.toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
      statusCode: 503,
    })

    expect(reply.header).toHaveBeenCalledWith('Retry-After', '5')
    expect(reply._headers['Retry-After']).toBe('5')
    expect(releaseMock).toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('falha NÃO-QUEUE_UNAVAILABLE (ex: AppError 500) → NÃO seta Retry-After', async () => {
    // Defesa contra over-setar o header: só o 503 de fila carrega Retry-After.
    createAsyncJobMock.mockRejectedValue(Errors.processingFailed('boom'))
    const reply = makeReply()

    await expect(
      processAsync(makeRequest() as never, reply as never),
    ).rejects.toMatchObject({ statusCode: 500 })

    expect(reply._headers['Retry-After']).toBeUndefined()
    expect(releaseMock).toHaveBeenCalled()
  })
})

// ===========================================================================
// HASH DO PAYLOAD — detecção de conflito de idempotência por bytes + metadata
// ===========================================================================
describe('processAsync — hash de payload (conflito de idempotência)', () => {
  async function hashOf(
    opts: Parameters<typeof makeRequest>[0],
  ): Promise<string> {
    beginMock.mockResolvedValue({ status: 'miss' })
    await processAsync(makeRequest(opts) as never, makeReply() as never)
    const call = beginMock.mock.calls[beginMock.mock.calls.length - 1][0]
    return call.bodyHash as string
  }

  it('mesma entrada (bytes + colunas + formato) → mesmo bodyHash (idempotente)', async () => {
    const a = await hashOf({})
    const b = await hashOf({})
    expect(a).toBe(b)
  })

  it('bytes de arquivo diferentes (mesmo nome) → bodyHash diferente', async () => {
    const a = await hashOf({
      files: [{ filename: 'a.csv', content: 'Name\nAlice' }],
    })
    const b = await hashOf({
      files: [{ filename: 'a.csv', content: 'Name\nBob' }],
    })
    expect(a).not.toBe(b)
  })

  it('colunas selecionadas diferentes → bodyHash diferente', async () => {
    const a = await hashOf({
      fields: { selectedColumns: '["Name"]', outputFormat: 'xlsx' },
    })
    const b = await hashOf({
      fields: { selectedColumns: '["Email"]', outputFormat: 'xlsx' },
    })
    expect(a).not.toBe(b)
  })

  it('outputFormat diferente → bodyHash diferente', async () => {
    const a = await hashOf({
      fields: { selectedColumns: '["Name"]', outputFormat: 'xlsx' },
    })
    const b = await hashOf({
      fields: { selectedColumns: '["Name"]', outputFormat: 'csv' },
    })
    expect(a).not.toBe(b)
  })

  it('ORDEM dos arquivos faz parte do contrato → reordenar muda o bodyHash', async () => {
    const files1: FilePart[] = [
      { filename: 'a.csv', content: 'AAA' },
      { filename: 'b.csv', content: 'BBB' },
    ]
    const files2: FilePart[] = [
      { filename: 'b.csv', content: 'BBB' },
      { filename: 'a.csv', content: 'AAA' },
    ]
    const a = await hashOf({ files: files1 })
    const b = await hashOf({ files: files2 })
    expect(a).not.toBe(b)
  })
})
