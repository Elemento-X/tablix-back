/**
 * Integration test do GET /process/download/:jobId (Card 6.6) — Postgres REAL.
 *
 * O unit test mocka o prisma e prova o SHAPE do claim (`updateMany WHERE
 * {id,userId,status,downloadedAt:null}`). Isso NÃO prova a invariante central
 * do 6.6 — ENTREGA ÚNICA — que só é real contra um banco de verdade, onde o
 * row-lock do Postgres serializa updates concorrentes. Aqui provamos contra
 * Postgres efêmero (Testcontainers via globalSetup):
 *
 *   - entrega única: 1ª chamada entrega o buffer + remove o output + seta
 *     downloaded_at; 2ª chamada → 410 (claim não casa mais);
 *   - concorrência (R-5): 2 downloads simultâneos do MESMO job → EXATAMENTE 1
 *     entrega (200) e 1 rejeição 410 — o claim atômico elege 1 winner;
 *   - ownership (anti-IDOR/anti-enum): não-dono → 404 idêntico ao inexistente,
 *     SEM consumir a entrega (downloaded_at intacto, output ainda no Storage);
 *   - não-pronto: job não-COMPLETED → 409, sem consumir.
 *
 * O Storage é um Map em memória (mesmo padrão do worker bullmq integration); o
 * foco é o claim/DB/entrega única real, não o Supabase. O prisma do controller
 * é remapeado pro client do Testcontainer (getter lazy — só resolve após o
 * globalSetup setar TABLIX_TEST_MODE). `emitAuditEvent` vira spy: fire-and-
 * forget contra DB real geraria insert assíncrono não-determinístico no
 * audit_log — espionar mantém o teste hermético e permite assertir success/fail.
 *
 * @owner: @tester
 * @card: 6.6
 */
/* eslint-disable import/first */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const storeMock = vi.hoisted(() => ({ store: new Map<string, Buffer>() }))
const auditMock = vi.hoisted(() => ({ emit: vi.fn() }))

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

// Storage in-memory: download lê do Map; remove deleta do Map. Path montado
// pelo controller via buildJobOutputPath — o teste usa o MESMO builder pra
// semear/assertir, garantindo paridade de chave.
vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: () => ({
    downloadByPath: async (path: string) => {
      const buffer = storeMock.store.get(path)
      if (!buffer) {
        const err = new Error('object not found') as Error & {
          storageError: unknown
        }
        err.storageError = { code: 'OBJECT_NOT_FOUND' }
        throw err
      }
      return { buffer, contentType: 'text/csv' }
    },
    removeByPath: async (path: string) => {
      const had = storeMock.store.delete(path)
      return { deleted: had, notFound: !had }
    },
  }),
}))

vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: auditMock.emit,
}))

// Remapeia o prisma do controller pro client do Testcontainer (getter lazy).
vi.mock('../../src/lib/prisma', async () => {
  const { getTestPrisma } = await import('../helpers/prisma')
  return {
    get prisma() {
      return getTestPrisma()
    },
  }
})

import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'
import { processDownload } from '../../src/http/controllers/process-download.controller'
import { buildJobOutputPath } from '../../src/lib/storage/key-builder'
import { ErrorCodes } from '../../src/errors/app-error'

interface ReplyStub {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  status: (c: number) => ReplyStub
  send: (b: unknown) => ReplyStub
  header: (k: string, v: string) => ReplyStub
}
function makeReply(): ReplyStub {
  const reply: ReplyStub = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(c) {
      reply.statusCode = c
      return reply
    },
    send(b) {
      reply.body = b
      return reply
    },
    header(k, v) {
      reply.headers[k] = v
      return reply
    },
  }
  return reply
}
function makeRequest(userId: string, jobId: string) {
  return {
    user: { userId, role: 'PRO' },
    params: { jobId },
    ip: '203.0.113.7',
    headers: { 'user-agent': 'integration' },
  } as never
}

async function seedUser(email: string): Promise<string> {
  const user = await getTestPrisma().user.create({
    data: { email, role: 'PRO' },
  })
  return user.id
}

/**
 * Semeia um job COMPLETED com output materializado no Storage in-memory.
 * Retorna o jobId + o outputPath (chave do Map) pra assertir remoção.
 */
async function seedCompletedJob(
  userId: string,
  ext: 'csv' | 'xlsx' = 'csv',
): Promise<{ jobId: string; outputPath: string }> {
  const job = await getTestPrisma().job.create({
    data: {
      userId,
      status: 'COMPLETED',
      inputFiles: { files: [], selectedColumns: ['name'] },
      outputFormat: ext,
      outputFileUrl: `out/placeholder.${ext}`,
      outputSize: BigInt(13),
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 3_600 * 1000),
    },
    select: { id: true, createdAt: true },
  })
  const outputPath = buildJobOutputPath({
    userId,
    jobId: job.id,
    ext,
    now: job.createdAt,
  })
  storeMock.store.set(outputPath, Buffer.from('name,age\nAlice,30\n'))
  return { jobId: job.id, outputPath }
}

beforeAll(() => {
  getTestPrisma() // garante Postgres up
})
afterAll(async () => {
  await disconnectTestPrisma()
})
beforeEach(async () => {
  await truncateAll()
  storeMock.store.clear()
  auditMock.emit.mockClear()
})

describe('GET /process/download/:jobId — entrega única (claim real)', () => {
  it('1ª chamada entrega + remove output + seta downloaded_at; 2ª → 410', async () => {
    const userId = await seedUser('dl-once@tablix.test')
    const { jobId, outputPath } = await seedCompletedJob(userId)

    const reply1 = makeReply()
    await processDownload(makeRequest(userId, jobId), reply1 as never)

    // entrega: 200 + buffer + headers de entrega única
    expect(reply1.statusCode).toBe(200)
    expect(Buffer.isBuffer(reply1.body)).toBe(true)
    expect(reply1.headers['Cache-Control']).toBe('no-store')
    expect(reply1.headers['Content-Type']).toBe('text/csv')
    expect(reply1.headers['Content-Disposition']).toContain("filename*=UTF-8''")
    // output removido do Storage pós-entrega (entrega única)
    expect(storeMock.store.has(outputPath)).toBe(false)
    // downloaded_at gravado no banco (claim consumido)
    const consumed = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { downloadedAt: true },
    })
    expect(consumed.downloadedAt).not.toBeNull()
    // audit success com bytes
    expect(auditMock.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PROCESS_DOWNLOAD',
        actor: userId,
        success: true,
        metadata: expect.objectContaining({ jobId }),
      }),
    )

    // 2ª chamada: claim não casa mais (downloaded_at != null) → 410 Gone
    await expect(
      processDownload(makeRequest(userId, jobId), makeReply() as never),
    ).rejects.toMatchObject({
      code: ErrorCodes.JOB_ALREADY_DOWNLOADED,
      statusCode: 410,
    })
  })

  it('concorrência (R-5): 2 downloads simultâneos → EXATAMENTE 1 entrega + 1 (410)', async () => {
    const userId = await seedUser('dl-race@tablix.test')
    const { jobId, outputPath } = await seedCompletedJob(userId)

    const replyA = makeReply()
    const replyB = makeReply()
    const results = await Promise.allSettled([
      processDownload(makeRequest(userId, jobId), replyA as never),
      processDownload(makeRequest(userId, jobId), replyB as never),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    // O claim atômico do Postgres elege exatamente 1 winner.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCodes.JOB_ALREADY_DOWNLOADED,
      statusCode: 410,
    })

    // Exatamente 1 reply recebeu 200 com buffer.
    const delivered = [replyA, replyB].filter((r) => r.statusCode === 200)
    expect(delivered).toHaveLength(1)
    expect(Buffer.isBuffer(delivered[0].body)).toBe(true)

    // Output consumido uma única vez; downloaded_at gravado.
    expect(storeMock.store.has(outputPath)).toBe(false)
    const consumed = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { downloadedAt: true },
    })
    expect(consumed.downloadedAt).not.toBeNull()
  })

  it('ownership: não-dono → 404 e NÃO consome a entrega (anti-IDOR/anti-enum)', async () => {
    const userA = await seedUser('dl-owner@tablix.test')
    const userB = await seedUser('dl-intruder@tablix.test')
    const { jobId, outputPath } = await seedCompletedJob(userA)

    // B tenta baixar job de A → 404 idêntico ao inexistente (nunca 403/410).
    await expect(
      processDownload(makeRequest(userB, jobId), makeReply() as never),
    ).rejects.toMatchObject({
      code: ErrorCodes.JOB_NOT_FOUND,
      statusCode: 404,
    })

    // A entrega NÃO foi consumida pela tentativa do intruso.
    expect(storeMock.store.has(outputPath)).toBe(true)
    const stillFresh = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { downloadedAt: true },
    })
    expect(stillFresh.downloadedAt).toBeNull()

    // E o dono A continua conseguindo baixar normalmente (entrega preservada).
    const replyA = makeReply()
    await processDownload(makeRequest(userA, jobId), replyA as never)
    expect(replyA.statusCode).toBe(200)
    expect(storeMock.store.has(outputPath)).toBe(false)
  })

  it('jobId inexistente → 404 idêntico (atacante não distingue de alheio)', async () => {
    const userA = await seedUser('dl-ghost@tablix.test')
    const ghost = '00000000-0000-4000-8000-000000000000'
    await expect(
      processDownload(makeRequest(userA, ghost), makeReply() as never),
    ).rejects.toMatchObject({
      code: ErrorCodes.JOB_NOT_FOUND,
      statusCode: 404,
    })
  })

  it('job não-COMPLETED (PROCESSING) → 409 e NÃO consome a entrega', async () => {
    const userA = await seedUser('dl-notready@tablix.test')
    const job = await getTestPrisma().job.create({
      data: {
        userId: userA,
        status: 'PROCESSING',
        inputFiles: { files: [], selectedColumns: ['name'] },
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3_600 * 1000),
      },
      select: { id: true },
    })
    const err = await processDownload(
      makeRequest(userA, job.id),
      makeReply() as never,
    ).catch((e) => e)
    expect(err.code).toBe(ErrorCodes.JOB_NOT_READY)
    expect(err.statusCode).toBe(409)
    expect(err.details).toMatchObject({ status: 'PROCESSING' })

    // claim não tocou downloaded_at (WHERE exige status COMPLETED).
    const job2 = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { downloadedAt: true, status: true },
    })
    expect(job2.downloadedAt).toBeNull()
    expect(job2.status).toBe('PROCESSING')
  })
})
