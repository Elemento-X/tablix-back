/**
 * Integration test do GET /process/status/:jobId (Card 6.5) — Postgres REAL.
 *
 * O unit test mocka o prisma e só prova o SHAPE do `where` ({id, userId}). Isso
 * NÃO prova que o filtro realmente isola dados entre usuários no banco — a
 * garantia anti-IDOR/anti-enumeração (decisão central do 6.5) só é real contra
 * Postgres de verdade. Aqui:
 *   - user A vê o próprio job (200, DTO por fase persistida);
 *   - user B pede o job de A → 404 idêntico ao inexistente (nunca 403);
 *   - jobId inexistente → 404 (mesmo erro — não dá pra distinguir).
 *
 * O controller importa `prisma` de src/lib/prisma; aqui o módulo é remapeado pro
 * PrismaClient do Testcontainer (getter lazy — só resolve após o globalSetup).
 *
 * @owner: @tester
 * @card: 6.5
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

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

// Remapeia o prisma do controller pro client do Testcontainer. Getter lazy:
// getTestPrisma() só pode rodar depois que o globalSetup setou TABLIX_TEST_MODE.
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
import { processStatus } from '../../src/http/controllers/process-status.controller'
import { processStatusResponseSchema } from '../../src/modules/process/process-status.schema'
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
  return { user: { userId, role: 'PRO' }, params: { jobId } } as never
}

async function seedUser(email: string): Promise<string> {
  const user = await getTestPrisma().user.create({
    data: { email, role: 'PRO' },
  })
  return user.id
}

async function seedJob(
  userId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const job = await getTestPrisma().job.create({
    data: {
      userId,
      status: 'PENDING',
      inputFiles: { files: [], selectedColumns: ['name'] },
      expiresAt: new Date(Date.now() + 24 * 3_600 * 1000),
      ...over,
    },
    select: { id: true },
  })
  return job.id
}

beforeAll(() => {
  getTestPrisma() // garante Postgres up
})
afterAll(async () => {
  await disconnectTestPrisma()
})
beforeEach(async () => {
  await truncateAll()
})

describe('GET /process/status/:jobId — ownership real (anti-IDOR/enumeração)', () => {
  it('user A vê o próprio job (200)', async () => {
    const userA = await seedUser('owner-a@tablix.test')
    const jobId = await seedJob(userA)
    const reply = makeReply()
    await processStatus(makeRequest(userA, jobId), reply as never)
    expect(reply.statusCode).toBe(200)
    expect((reply.body as { jobId: string }).jobId).toBe(jobId)
  })

  it('user B pede job de A → 404 (não 403; não vaza existência)', async () => {
    const userA = await seedUser('owner-a2@tablix.test')
    const userB = await seedUser('intruder-b@tablix.test')
    const jobId = await seedJob(userA)
    await expect(
      processStatus(makeRequest(userB, jobId), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_NOT_FOUND, statusCode: 404 })
  })

  it('jobId inexistente → 404 idêntico (atacante não distingue de alheio)', async () => {
    const userA = await seedUser('owner-a3@tablix.test')
    const ghost = '00000000-0000-4000-8000-000000000000'
    await expect(
      processStatus(makeRequest(userA, ghost), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_NOT_FOUND, statusCode: 404 })
  })

  it('mesmo jobId: dono recebe 200 e não-dono recebe 404 (isolamento por linha)', async () => {
    const userA = await seedUser('owner-a4@tablix.test')
    const userB = await seedUser('intruder-b4@tablix.test')
    const jobId = await seedJob(userA)

    const replyA = makeReply()
    await processStatus(makeRequest(userA, jobId), replyA as never)
    expect(replyA.statusCode).toBe(200)

    await expect(
      processStatus(makeRequest(userB, jobId), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_NOT_FOUND })
  })
})

describe('GET /process/status/:jobId — DTO por fase (persistência real)', () => {
  it('PENDING: condicionais null + Cache-Control private', async () => {
    const userA = await seedUser('phase-pending@tablix.test')
    const jobId = await seedJob(userA, { status: 'PENDING' })
    const reply = makeReply()
    await processStatus(makeRequest(userA, jobId), reply as never)
    expect(reply.headers['Cache-Control']).toBe('private, no-cache')
    const body = reply.body
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      status: 'PENDING',
      completedAt: null,
      errorMessage: null,
      downloadUrl: null,
      outputSize: null,
    })
  })

  it('PROCESSING: condicionais null (worker em execução)', async () => {
    const userA = await seedUser('phase-processing@tablix.test')
    const jobId = await seedJob(userA, {
      status: 'PROCESSING',
      startedAt: new Date(),
    })
    const reply = makeReply()
    await processStatus(makeRequest(userA, jobId), reply as never)
    const body = reply.body as { status: string; downloadUrl: unknown }
    expect(body.status).toBe('PROCESSING')
    expect(body.downloadUrl).toBeNull()
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  it('COMPLETED: BIGINT real do Postgres vira string decimal exata (B-6.5.1)', async () => {
    const userA = await seedUser('phase-completed@tablix.test')
    // Valor acima de 2^53 pra provar que o round-trip Prisma(BigInt)→DTO(string)
    // preserva a precisão que um JSON number perderia.
    const jobId = await seedJob(userA, {
      status: 'COMPLETED',
      completedAt: new Date(),
      outputFileUrl: 'out/some.csv',
      outputFormat: 'csv',
      outputSize: BigInt('9007199254740993'),
    })
    const reply = makeReply()
    await processStatus(makeRequest(userA, jobId), reply as never)
    const body = reply.body as {
      status: string
      downloadUrl: string
      outputSize: string
    }
    expect(body.status).toBe('COMPLETED')
    expect(body.downloadUrl).toBe(`/process/download/${jobId}`)
    expect(body.outputSize).toBe('9007199254740993')
    expect(typeof body.outputSize).toBe('string')
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  it('FAILED: errorMessage persistido aparece; downloadUrl/outputSize null', async () => {
    const userA = await seedUser('phase-failed@tablix.test')
    const jobId = await seedJob(userA, {
      status: 'FAILED',
      completedAt: new Date(),
      errorMessage: 'Falha no processamento. Tente novamente mais tarde.',
    })
    const reply = makeReply()
    await processStatus(makeRequest(userA, jobId), reply as never)
    const body = reply.body as {
      status: string
      errorMessage: string
      downloadUrl: unknown
      outputSize: unknown
    }
    expect(body.status).toBe('FAILED')
    expect(body.errorMessage).toContain('Falha no processamento')
    expect(body.downloadUrl).toBeNull()
    expect(body.outputSize).toBeNull()
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })
})
