/**
 * Unit tests do GET /process/download/:jobId (Card 6.6, entrega única).
 *
 * Mocka prisma/storage/audit e prova a ordem corrigida pós-@dba ALTO:
 * read scoped (findFirst {id,userId}) → discriminação 404/409/410 → fetch do
 * buffer ANTES do claim → claim atômico (updateMany WHERE status COMPLETED +
 * downloaded_at IS NULL) → delete best-effort → audit → send. Cobre também:
 * Content-Disposition RFC 5987, Cache-Control no-store, perda de concorrência
 * (count 0 → 410), output purgado (OBJECT_NOT_FOUND → 410) vs falha transiente
 * (5xx → 500 com downloaded_at intacto), e que o cleanup best-effort não
 * derruba a entrega.
 *
 * @owner: @tester
 * @card: 6.6
 */
/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../src/errors/app-error'

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  getStorageAdapter: vi.fn(),
  emitAuditEvent: vi.fn(),
}))
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    job: {
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
    },
  },
}))
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: mocks.getStorageAdapter,
}))
vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: mocks.emitAuditEvent,
}))

import { processDownload } from '../../src/http/controllers/process-download.controller'

const USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'
const CREATED_AT = new Date('2026-06-21T10:00:00.000Z')

interface ReplyStub {
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  header: ReturnType<typeof vi.fn>
}
function makeReply(): ReplyStub {
  const reply: ReplyStub = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
    header: vi.fn(() => reply),
  }
  return reply
}
function makeRequest(over: Record<string, unknown> = {}) {
  return {
    user: { userId: USER_ID, role: 'PRO' },
    params: { jobId: JOB_ID },
    ip: '203.0.113.7',
    headers: { 'user-agent': 'jest' },
    ...over,
  } as never
}

let storage: {
  downloadByPath: ReturnType<typeof vi.fn>
  removeByPath: ReturnType<typeof vi.fn>
}

/** Job COMPLETED válido e ainda não baixado (caminho feliz). */
function jobCompleted(outputFormat: 'csv' | 'xlsx' = 'xlsx') {
  return {
    status: 'COMPLETED',
    downloadedAt: null,
    createdAt: CREATED_AT,
    outputFormat,
  }
}

function setupHappy(outputFormat: 'csv' | 'xlsx' = 'xlsx') {
  mocks.findFirst.mockResolvedValue(jobCompleted(outputFormat))
  mocks.updateMany.mockResolvedValue({ count: 1 })
  storage.downloadByPath.mockResolvedValue({
    buffer: Buffer.from(
      outputFormat === 'xlsx' ? 'PKxlsx-output' : 'a,b\n1,2\n',
    ),
    contentType:
      outputFormat === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
  })
  storage.removeByPath.mockResolvedValue({ deleted: true, notFound: false })
}

beforeEach(() => {
  storage = { downloadByPath: vi.fn(), removeByPath: vi.fn() }
  mocks.getStorageAdapter.mockReturnValue(storage)
})
afterEach(() => vi.clearAllMocks())

describe('processDownload — auth & validação', () => {
  it('401 sem usuário', async () => {
    await expect(
      processDownload(makeRequest({ user: undefined }), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHORIZED })
  })
  it('400 jobId não-UUID (não toca o DB)', async () => {
    await expect(
      processDownload(
        makeRequest({ params: { jobId: 'nope' } }),
        makeReply() as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})

describe('processDownload — discriminação pré-claim (read scoped)', () => {
  it('read usa WHERE {id, userId} (ownership anti-enumeração)', async () => {
    setupHappy()
    await processDownload(makeRequest(), makeReply() as never)
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID, userId: USER_ID },
      }),
    )
  })

  it('não-dono OU inexistente (findFirst null) → 404 e NÃO claima', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await expect(
      processDownload(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_NOT_FOUND })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(storage.downloadByPath).not.toHaveBeenCalled()
  })

  it('já baixado (downloadedAt setado) → 410 Gone e NÃO claima', async () => {
    mocks.findFirst.mockResolvedValue({
      status: 'COMPLETED',
      downloadedAt: new Date(),
      createdAt: CREATED_AT,
      outputFormat: 'xlsx',
    })
    await expect(
      processDownload(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_ALREADY_DOWNLOADED })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(storage.downloadByPath).not.toHaveBeenCalled()
  })

  it('ainda não concluído (PROCESSING) → 409 com status nos details', async () => {
    mocks.findFirst.mockResolvedValue({
      status: 'PROCESSING',
      downloadedAt: null,
      createdAt: CREATED_AT,
      outputFormat: 'xlsx',
    })
    const err = await processDownload(
      makeRequest(),
      makeReply() as never,
    ).catch((e) => e)
    expect(err.code).toBe(ErrorCodes.JOB_NOT_READY)
    expect(err.statusCode).toBe(409)
    expect(err.details).toMatchObject({ status: 'PROCESSING' })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(storage.downloadByPath).not.toHaveBeenCalled()
  })
})

describe('processDownload — fetch antes do claim (@dba ALTO)', () => {
  it('happy: read → baixa buffer → claim → delete → audita SUCCESS → envia binário com headers', async () => {
    setupHappy()
    const order: string[] = []
    storage.downloadByPath.mockImplementation(async () => {
      order.push('download')
      return {
        buffer: Buffer.from('PKxlsx-output'),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }
    })
    mocks.updateMany.mockImplementation(async () => {
      order.push('claim')
      return { count: 1 }
    })
    storage.removeByPath.mockImplementation(async () => {
      order.push('remove')
      return { deleted: true, notFound: false }
    })
    const reply = makeReply()
    await processDownload(makeRequest(), reply as never)

    // invariante @dba: o buffer é baixado ANTES do claim consumir downloaded_at
    expect(order).toEqual(['download', 'claim', 'remove'])

    // claim atômico de entrega única
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: JOB_ID,
          userId: USER_ID,
          status: 'COMPLETED',
          downloadedAt: null,
        },
        data: { downloadedAt: expect.any(Date) },
      }),
    )

    expect(reply.status).toHaveBeenCalledWith(200)
    expect(reply.send).toHaveBeenCalledWith(expect.any(Buffer))

    // headers
    const headers = Object.fromEntries(reply.header.mock.calls)
    expect(headers['Content-Type']).toContain('spreadsheetml')
    expect(headers['Cache-Control']).toBe('no-store')
    // RFC 5987: filename + filename* (nome gerado, data de createdAt)
    expect(headers['Content-Disposition']).toContain('attachment; filename="')
    expect(headers['Content-Disposition']).toContain("filename*=UTF-8''")
    expect(headers['Content-Disposition']).toContain(
      'tablix-unificado-2026-06-21.xlsx',
    )

    // audit LGPD success
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PROCESS_DOWNLOAD',
        actor: USER_ID,
        success: true,
        metadata: expect.objectContaining({ jobId: JOB_ID }),
      }),
    )
  })

  it('cleanup do output falho NÃO derruba a entrega (best-effort)', async () => {
    setupHappy()
    storage.removeByPath.mockRejectedValue(new Error('storage 500'))
    const reply = makeReply()
    await processDownload(makeRequest(), reply as never)
    expect(reply.send).toHaveBeenCalledWith(expect.any(Buffer))
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    )
  })

  it('happy CSV: Content-Type text/csv + filename .csv (paralelo ao xlsx)', async () => {
    setupHappy('csv')
    const reply = makeReply()
    await processDownload(makeRequest(), reply as never)
    const headers = Object.fromEntries(reply.header.mock.calls)
    expect(headers['Content-Type']).toBe('text/csv')
    expect(headers['Content-Disposition']).toContain(
      'tablix-unificado-2026-06-21.csv',
    )
  })
})

describe('processDownload — perda de concorrência no claim (count 0)', () => {
  it('outra request venceu o claim entre read e claim → 410 e descarta buffer', async () => {
    // read vê COMPLETED+null, baixa o buffer, mas o claim perde a corrida
    // (count 0): a concorrente já marcou downloaded_at. Não entrega 2×.
    setupHappy()
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const reply = makeReply()
    await expect(
      processDownload(makeRequest(), reply as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_ALREADY_DOWNLOADED })
    // baixou o buffer (antes do claim) mas NÃO entregou nem removeu
    expect(storage.downloadByPath).toHaveBeenCalled()
    expect(storage.removeByPath).not.toHaveBeenCalled()
    expect(reply.send).not.toHaveBeenCalledWith(expect.any(Buffer))
  })
})

describe('processDownload — falhas de fetch e infra auditam FAILURE', () => {
  it('storage indisponível (adapter null) → 500 + audit failure, ANTES do claim', async () => {
    mocks.findFirst.mockResolvedValue(jobCompleted('csv'))
    mocks.getStorageAdapter.mockReturnValue(null)
    await expect(
      processDownload(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        metadata: expect.objectContaining({ reason: 'storage_unavailable' }),
      }),
    )
  })

  it('falha transiente no fetch (5xx) → 500 + audit fetch_failed, SEM claim (downloaded_at intacto)', async () => {
    setupHappy()
    storage.downloadByPath.mockRejectedValue(new Error('connection reset'))
    await expect(
      processDownload(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
    // invariante @dba: a entrega paga NÃO é queimada por falha de infra
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        metadata: expect.objectContaining({ reason: 'fetch_failed' }),
      }),
    )
  })

  it('output purgado/expirado (OBJECT_NOT_FOUND) → 410 Gone + audit output_gone', async () => {
    setupHappy()
    storage.downloadByPath.mockRejectedValue({
      storageError: { code: 'OBJECT_NOT_FOUND' },
    })
    await expect(
      processDownload(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_ALREADY_DOWNLOADED })
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        metadata: expect.objectContaining({ reason: 'output_gone' }),
      }),
    )
  })

  it('job COMPLETED com outputFormat inválido (inconsistência) → 500 + audit + NÃO toca o Storage/claim', async () => {
    // COMPLETED mas com outputFormat fora da whitelist (csv/xlsx). É
    // inconsistência interna: aborta ANTES de pedir o Storage e o claim,
    // audita reason 'bad_output_format'. headers sem user-agent exercita
    // o ramo `?? null` do userAgent.
    mocks.findFirst.mockResolvedValue({
      status: 'COMPLETED',
      downloadedAt: null,
      createdAt: CREATED_AT,
      outputFormat: 'pdf',
    })
    await expect(
      processDownload(makeRequest({ headers: {} }), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR })
    expect(mocks.getStorageAdapter).not.toHaveBeenCalled()
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PROCESS_DOWNLOAD',
        success: false,
        metadata: expect.objectContaining({ reason: 'bad_output_format' }),
      }),
    )
  })
})
