/**
 * Integration test do worker async (Card 6.4) — BullMQ + Postgres REAIS.
 *
 * Sobe um Redis efêmero (Testcontainers) + usa o Postgres efêmero do
 * globalSetup. Constrói o Worker via `createProcessWorker` apontado direto pro
 * container (a `REDIS_URL` da env exige TLS — inviável local). O Storage é
 * mockado por um Map em memória; o parse roda DE VERDADE (worker_thread real)
 * + merge/generate reais. Prova o elo ponta-a-ponta enqueue → worker → DB:
 *   - feliz: Job PENDING → COMPLETED com outputSize + output no storage
 *   - veneno: input inválido → FAILED permanente com errorMessage sanitizado
 *
 * @owner: @tester
 * @card: 6.4
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
import { Redis as IORedis } from 'ioredis'
import { Queue } from 'bullmq'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'

const storeMock = vi.hoisted(() => ({ store: new Map<string, Buffer>() }))

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

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
    uploadJobOutput: async (args: {
      jobId: string
      ext: string
      buffer: Buffer
    }) => {
      storeMock.store.set(`out:${args.jobId}`, args.buffer)
      return { path: `out/${args.jobId}.${args.ext}` }
    },
    removeByPath: async (path: string) => {
      const had = storeMock.store.delete(path)
      return { deleted: had, notFound: !had }
    },
  }),
}))

import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'
import { PROCESS_QUEUE_NAME } from '../../src/lib/queue/process-queue'
import { createProcessWorker } from '../../src/lib/queue/process-worker'
import { buildJobInputPath } from '../../src/lib/storage/key-builder'
import type { Worker } from 'bullmq'

let redisContainer: StartedTestContainer
let workerConn: IORedis
let queueConn: IORedis
let queue: Queue
let worker: Worker

beforeAll(async () => {
  getTestPrisma() // garante Postgres up

  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
    .withStartupTimeout(60_000)
    .start()

  const url = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`
  workerConn = new IORedis(url, { maxRetriesPerRequest: null })
  queueConn = new IORedis(url, { maxRetriesPerRequest: null })

  queue = new Queue(PROCESS_QUEUE_NAME, { connection: queueConn })
  worker = createProcessWorker(workerConn)
  await worker.waitUntilReady()
}, 90_000)

afterAll(async () => {
  await worker?.close()
  await queue?.close()
  workerConn?.disconnect()
  queueConn?.disconnect()
  await redisContainer?.stop()
  await disconnectTestPrisma()
})

beforeEach(async () => {
  await truncateAll()
  storeMock.store.clear()
})

async function seedUser(email: string): Promise<string> {
  const user = await getTestPrisma().user.create({
    data: { email, role: 'PRO' },
  })
  return user.id
}

async function seedJob(
  userId: string,
  ext: 'csv' | 'xlsx',
): Promise<{ jobId: string; inputPath: string }> {
  const job = await getTestPrisma().job.create({
    data: {
      userId,
      status: 'PENDING',
      inputFiles: {
        files: [{ index: 0, fileName: `data.${ext}`, ext, size: 20 }],
        selectedColumns: ['name'],
      },
      outputFormat: 'csv',
      expiresAt: new Date(Date.now() + 24 * 3_600 * 1000),
    },
    select: { id: true, createdAt: true },
  })
  const inputPath = buildJobInputPath({
    userId,
    jobId: job.id,
    index: 0,
    ext,
    now: job.createdAt,
  })
  return { jobId: job.id, inputPath }
}

async function waitForStatus(
  jobId: string,
  statuses: string[],
  timeoutMs = 25_000,
): Promise<string> {
  const start = Date.now()
  for (;;) {
    const job = await getTestPrisma().job.findUnique({
      where: { id: jobId },
      select: { status: true },
    })
    if (job && statuses.includes(job.status)) return job.status
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timeout esperando job ${jobId} virar ${statuses.join('|')} (status atual: ${job?.status})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

describe('worker async (BullMQ + Postgres reais)', () => {
  it('feliz: enqueue → COMPLETED com outputSize e output no storage', async () => {
    const userId = await seedUser('worker-happy@tablix.test')
    const { jobId, inputPath } = await seedJob(userId, 'csv')
    storeMock.store.set(
      inputPath,
      Buffer.from('name,age\nAlice,30\nBob,25\n', 'utf-8'),
    )

    await queue.add('process', { jobId }, { jobId })

    const status = await waitForStatus(jobId, ['COMPLETED', 'FAILED'])
    expect(status).toBe('COMPLETED')

    const job = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { outputSize: true, outputFileUrl: true, inputsPurgedAt: true },
    })
    expect(job.outputSize).not.toBeNull()
    expect(Number(job.outputSize)).toBeGreaterThan(0)
    expect(job.outputFileUrl).toContain(jobId)
    // Output gravado + input purgado (1/1).
    expect(storeMock.store.has(`out:${jobId}`)).toBe(true)
    expect(job.inputsPurgedAt).not.toBeNull()
    expect(storeMock.store.has(inputPath)).toBe(false)
  })

  it('veneno: input inválido (não-xlsx) → FAILED com errorMessage genérico', async () => {
    const userId = await seedUser('worker-poison@tablix.test')
    const { jobId, inputPath } = await seedJob(userId, 'xlsx')
    // Buffer que NÃO é um zip/xlsx → parseExcel falha magic bytes (permanente).
    storeMock.store.set(inputPath, Buffer.from('definitely not a real xlsx'))

    await queue.add('process', { jobId }, { jobId })

    const status = await waitForStatus(jobId, ['COMPLETED', 'FAILED'])
    expect(status).toBe('FAILED')

    const job = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { errorMessage: true },
    })
    expect(job.errorMessage).toBeTruthy()
    // Mensagem genérica — não vaza path/stack interno.
    expect(job.errorMessage).not.toContain(inputPath)
  })

  it('idempotência: re-enqueue de job já COMPLETED é no-op (claim rejeita terminal)', async () => {
    const userId = await seedUser('worker-idem@tablix.test')
    const { jobId, inputPath } = await seedJob(userId, 'csv')
    storeMock.store.set(inputPath, Buffer.from('name,age\nAlice,30\n', 'utf-8'))

    await queue.add('process', { jobId }, { jobId })
    await waitForStatus(jobId, ['COMPLETED'])

    const before = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { completedAt: true },
    })

    // Re-enfileira o MESMO jobId com outro BullMQ job id (simula late-enqueue).
    await queue.add('process', { jobId }, { jobId: `${jobId}-replay` })
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { status: true, completedAt: true },
    })
    expect(after.status).toBe('COMPLETED')
    // completedAt inalterado → não reprocessou.
    expect(after.completedAt?.getTime()).toBe(before.completedAt?.getTime())
  })
})
