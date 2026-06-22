/**
 * Integration test dos crons de cleanup async (Card 6.7 + #197) — Postgres REAL.
 *
 * O unit test mocka o prisma e prova os branches de decisão. Aqui provamos as
 * INVARIANTES que só são reais contra um banco de verdade:
 *
 *   - **Refund no período do `createdAt`** (não o corrente): um PENDING órfão
 *     criado em mês anterior é estornado no período certo — `decrementUsageForPeriod`
 *     real contra a tabela usage.
 *   - **Anti-race sweeper × worker (R-3):** sweeper (PENDING→FAILED) e worker
 *     (PENDING→PROCESSING) concorrentes → EXATAMENTE um vence o lock de linha;
 *     refund ocorre SE E SÓ SE o sweeper venceu (sem double-refund, sem
 *     refund-sem-transição).
 *   - **M-03 (purga parcial):** input que falha ao remover deixa `inputs_purged_at`
 *     NULL pro próximo run; só seta quando TODOS saíram.
 *   - **Tombstone de output expirado:** `output_file_url` vira NULL pós-purga.
 *
 * Storage é in-memory (Map); queue é mockada (getProcessJobState). O foco é a
 * contabilidade de quota + transições de status contra Postgres efêmero.
 *
 * @owner: @tester
 * @card: 6.7 (+ #197)
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

const storeMock = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  throwOn: new Set<string>(),
}))
const queueMock = vi.hoisted(() => ({
  getProcessJobState: vi.fn(),
  enqueueProcessJob: vi.fn(),
  isProcessQueueConfigured: vi.fn(() => true),
}))

// Mock SÍNCRONO (não async com import dinâmico) — o factory async resolvia
// lazy e o 1º handler lia env.ASYNC_PENDING_SWEEP_MINUTES undefined (cutoff
// Invalid Date). O handler só lê estes 3 campos; logger tolera env mínimo
// (NODE_ENV/LOG_LEVEL undefined → defaults do pino), provado nos unit tests.
vi.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: undefined,
    CRON_DRY_RUN: false,
    ASYNC_PENDING_SWEEP_MINUTES: 10,
    ASYNC_STUCK_PROCESSING_MINUTES: 60,
  },
}))

vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: () => ({
    removeByPath: async (path: string) => {
      if (storeMock.throwOn.has(path)) {
        throw new Error('storage 500 (simulado)')
      }
      const had = storeMock.store.delete(path)
      return { deleted: had, notFound: !had }
    },
  }),
}))

vi.mock('../../src/lib/queue/process-queue', () => ({
  getProcessJobState: queueMock.getProcessJobState,
  enqueueProcessJob: queueMock.enqueueProcessJob,
  isProcessQueueConfigured: queueMock.isProcessQueueConfigured,
}))

vi.mock('../../src/scheduler/metrics', () => ({
  setAsyncCleanupCount: vi.fn(),
}))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: vi.fn(),
}))
vi.mock('../../src/config/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}))

// prisma do handler E da usage.service real apontam pro Testcontainer.
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
import {
  sweepOrphanJobs,
  purgeAsyncJobStorage,
} from '../../src/jobs/async-cleanup.job'
import {
  buildJobInputPath,
  buildJobOutputPath,
} from '../../src/lib/storage/key-builder'
import type { LockHandle } from '../../src/scheduler/types'

function makeLock(): LockHandle {
  return {
    token: 'tok',
    jobName: 'test',
    acquiredAt: new Date(),
    heartbeat: async () => true,
    release: async () => {},
  }
}

async function seedUser(email: string): Promise<string> {
  const user = await getTestPrisma().user.create({
    data: { email, role: 'PRO' },
  })
  return user.id
}

const INPUT_FILES = {
  files: [
    { index: 0, fileName: 'a.csv', ext: 'csv', size: 10 },
    { index: 1, fileName: 'b.xlsx', ext: 'xlsx', size: 20 },
  ],
  selectedColumns: ['nome'],
}

beforeAll(() => {
  getTestPrisma()
})
afterAll(async () => {
  await disconnectTestPrisma()
})
beforeEach(async () => {
  await truncateAll()
  storeMock.store.clear()
  storeMock.throwOn.clear()
  queueMock.getProcessJobState.mockReset()
  queueMock.getProcessJobState.mockResolvedValue({ present: false })
  queueMock.isProcessQueueConfigured.mockReturnValue(true)
})

describe('sweepOrphanJobs — refund no período do createdAt (#197)', () => {
  it('PENDING órfão expirado → FAILED + estorno SÓ no período do createdAt', async () => {
    const userId = await seedUser('sweep-period@tablix.test')
    // Job criado em maio (período 2026-05), já expirado.
    const createdAt = new Date('2026-05-15T12:00:00.000Z')
    const job = await getTestPrisma().job.create({
      data: {
        userId,
        status: 'PENDING',
        inputFiles: INPUT_FILES,
        outputFormat: 'xlsx',
        createdAt,
        expiresAt: new Date('2026-05-16T12:00:00.000Z'), // expirado
      },
      select: { id: true },
    })
    // Quota reservada em 2026-05 E uso corrente em 2026-06.
    await getTestPrisma().usage.createMany({
      data: [
        { userId, period: '2026-05', unificationsCount: 1 },
        { userId, period: '2026-06', unificationsCount: 1 },
      ],
    })

    await sweepOrphanJobs(makeLock())

    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true },
    })
    expect(after.status).toBe('FAILED')

    const may = await getTestPrisma().usage.findUniqueOrThrow({
      where: { userId_period: { userId, period: '2026-05' } },
    })
    const jun = await getTestPrisma().usage.findUniqueOrThrow({
      where: { userId_period: { userId, period: '2026-06' } },
    })
    // Estornou maio (1→0), junho intacto (1).
    expect(may.unificationsCount).toBe(0)
    expect(jun.unificationsCount).toBe(1)
  })

  it('idempotência #197: sweeper rodado 2× no mesmo órfão → refund EXATAMENTE 1×', async () => {
    // O coração de #197: "estorna no máximo 1× por órfão". A 1ª passada marca
    // FAILED + estorna (1→0); a 2ª NÃO acha mais o job em PENDING (status guard)
    // → não re-estorna. Prova que o invariante sobrevive a re-execução do cron
    // (reentry após crash/lockLost / cadência 5min). Mata mutação que remova o
    // gate `WHERE status='PENDING'` (count===1) — sem ele, a 2ª passada zeraria
    // pra -1 (ou o guard `> 0` do decrement seguraria em 0 mascarando o bug; por
    // isso a asserção é status FAILED imutável + count exatamente 0).
    const userId = await seedUser('sweep-twice@tablix.test')
    const createdAt = new Date('2026-05-15T12:00:00.000Z')
    const job = await getTestPrisma().job.create({
      data: {
        userId,
        status: 'PENDING',
        inputFiles: INPUT_FILES,
        outputFormat: 'xlsx',
        createdAt,
        expiresAt: new Date('2026-05-16T12:00:00.000Z'), // expirado
      },
      select: { id: true },
    })
    await getTestPrisma().usage.create({
      data: { userId, period: '2026-05', unificationsCount: 1 },
    })

    await sweepOrphanJobs(makeLock())
    const afterFirst = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, completedAt: true },
    })
    expect(afterFirst.status).toBe('FAILED')

    // 2ª passada: não há mais PENDING → nenhuma transição, nenhum estorno.
    await sweepOrphanJobs(makeLock())
    const afterSecond = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, completedAt: true },
    })
    // completedAt não pode ter sido reescrito pela 2ª passada (idempotência).
    expect(afterSecond.completedAt?.getTime()).toBe(
      afterFirst.completedAt?.getTime(),
    )

    const usage = await getTestPrisma().usage.findUniqueOrThrow({
      where: { userId_period: { userId, period: '2026-05' } },
    })
    expect(usage.unificationsCount).toBe(0) // estornou só 1×, não foi a -1/duplo
  })

  it('anti-race: sweeper × worker no mesmo PENDING → 1 vencedor, refund iff sweeper', async () => {
    const userId = await seedUser('sweep-race@tablix.test')
    const createdAt = new Date(Date.now() - 60 * 60 * 1000) // 1h atrás
    const period = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`
    const job = await getTestPrisma().job.create({
      data: {
        userId,
        status: 'PENDING',
        inputFiles: INPUT_FILES,
        outputFormat: 'xlsx',
        createdAt,
        expiresAt: new Date(Date.now() - 60 * 1000), // expirado → FAILED+refund
      },
      select: { id: true },
    })
    await getTestPrisma().usage.create({
      data: { userId, period, unificationsCount: 1 },
    })

    // Worker claim concorrente: PENDING/PROCESSING → PROCESSING.
    const workerClaim = getTestPrisma().job.updateMany({
      where: { id: job.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PROCESSING', startedAt: new Date() },
    })

    await Promise.allSettled([sweepOrphanJobs(makeLock()), workerClaim])

    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true },
    })
    const usage = await getTestPrisma().usage.findUniqueOrThrow({
      where: { userId_period: { userId, period } },
    })

    // Exatamente um venceu: FAILED (sweeper) XOR PROCESSING (worker).
    expect(['FAILED', 'PROCESSING']).toContain(after.status)
    if (after.status === 'FAILED') {
      // Sweeper venceu → estornou exatamente 1×.
      expect(usage.unificationsCount).toBe(0)
    } else {
      // Worker venceu → NÃO estornou (sem refund-sem-transição).
      expect(usage.unificationsCount).toBe(1)
    }
  })
})

describe('purgeAsyncJobStorage — M-03 e tombstone (Postgres real)', () => {
  async function seedTerminalWithInputs(
    userId: string,
    status: 'COMPLETED' | 'FAILED',
  ): Promise<{ jobId: string; createdAt: Date; paths: string[] }> {
    const job = await getTestPrisma().job.create({
      data: {
        userId,
        status,
        inputFiles: INPUT_FILES,
        outputFormat: 'xlsx',
        completedAt: new Date(),
        inputsPurgedAt: null,
      },
      select: { id: true, createdAt: true },
    })
    const paths = INPUT_FILES.files.map((f) =>
      buildJobInputPath({
        userId,
        jobId: job.id,
        index: f.index,
        ext: f.ext as 'csv' | 'xlsx',
        now: job.createdAt,
      }),
    )
    paths.forEach((p) => storeMock.store.set(p, Buffer.from('x')))
    return { jobId: job.id, createdAt: job.createdAt, paths }
  }

  it('inputs: remove TODOS → seta inputs_purged_at', async () => {
    const userId = await seedUser('purge-all@tablix.test')
    const { jobId, paths } = await seedTerminalWithInputs(userId, 'COMPLETED')

    await purgeAsyncJobStorage(makeLock())

    paths.forEach((p) => expect(storeMock.store.has(p)).toBe(false))
    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { inputsPurgedAt: true },
    })
    expect(after.inputsPurgedAt).not.toBeNull()
  })

  it('inputs: purga PARCIAL (1 falha) → inputs_purged_at fica NULL (M-03)', async () => {
    const userId = await seedUser('purge-partial@tablix.test')
    const { jobId, paths } = await seedTerminalWithInputs(userId, 'FAILED')
    // Força falha no 2º input.
    storeMock.throwOn.add(paths[1])

    await purgeAsyncJobStorage(makeLock())

    // 1º saiu, 2º permanece; inputs_purged_at NULL pro próximo run.
    expect(storeMock.store.has(paths[0])).toBe(false)
    expect(storeMock.store.has(paths[1])).toBe(true)
    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: jobId },
      select: { inputsPurgedAt: true },
    })
    expect(after.inputsPurgedAt).toBeNull()
  })

  it('output expirado não baixado → remove + tombstone (output_file_url NULL)', async () => {
    const userId = await seedUser('purge-output@tablix.test')
    const job = await getTestPrisma().job.create({
      data: {
        userId,
        status: 'COMPLETED',
        inputFiles: INPUT_FILES,
        outputFormat: 'xlsx',
        outputFileUrl: 'out/placeholder.xlsx',
        completedAt: new Date(),
        inputsPurgedAt: new Date(), // inputs já purgados (foca no output)
        downloadedAt: null,
        expiresAt: new Date(Date.now() - 60 * 1000), // expirado
      },
      select: { id: true, createdAt: true },
    })
    const outPath = buildJobOutputPath({
      userId,
      jobId: job.id,
      ext: 'xlsx',
      now: job.createdAt,
    })
    storeMock.store.set(outPath, Buffer.from('out'))

    await purgeAsyncJobStorage(makeLock())

    expect(storeMock.store.has(outPath)).toBe(false)
    const after = await getTestPrisma().job.findUniqueOrThrow({
      where: { id: job.id },
      select: { outputFileUrl: true },
    })
    expect(after.outputFileUrl).toBeNull()
  })
})
