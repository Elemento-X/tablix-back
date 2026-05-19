/**
 * Integration test FLOW completo do retention job — Card #146 (5.2b) F5 fix-pack.
 *
 * Cobre cenários CRÍTICOS LGPD identificados em pipeline ciclo 1:
 *   - @tester ALTO #1 (fingerprint integration-test-missing)
 *   - @security ALTO #2 (R-1 invariante não-overshoot LGPD)
 *
 * 4 cenários convergentes contra Postgres real (Testcontainers):
 *   (a) Happy path: 3 expired + 3 non-expired → SÓ as 3 expired tocadas
 *       (invariante R-1 LGPD overshoot)
 *   (b) Crash mid-handler entre Fase A (audit + soft-delete) e Fase B
 *       (Storage delete) → reconciliação Fase C cobre em re-run
 *   (c) Storage 5xx forçado → purge_attempts++ verificado no DB
 *   (d) Dead-letter move (purge_attempts=5) → INSERT file_history_dead_letter
 *       + DELETE origem + audit purge_failed
 *
 * **Storage adapter mockado**: integration de DB real + Storage mock é
 * o pattern correto pra testar handler isoladamente. Integration FULL
 * (DB + Storage real) requer Supabase Storage de teste — Card 9.x futuro.
 *
 * @owner: @tester + @security
 * @card: #146 F5 fix-pack ciclo 1
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  disconnectTestPrisma,
  getTestPrisma,
  truncateAll,
} from '../helpers/prisma'

// Mock do storage adapter — DB real, Storage simulado.
const adapterMock = {
  removeByPath: vi.fn(),
  uploadForUser: vi.fn(),
  getSignedUrlForUser: vi.fn(),
  deleteForUser: vi.fn(),
  listForUser: vi.fn(),
  getTotalSize: vi.fn(),
}

vi.mock('../../src/lib/storage', () => ({
  getStorageAdapter: () => adapterMock,
}))

// Mock observability/metrics — não queremos efeitos colaterais (Sentry, etc).
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: vi.fn(),
}))
vi.mock('../../src/scheduler/metrics', () => ({
  setPurgePendingCount: vi.fn(),
}))
vi.mock('../../src/config/sentry', () => ({
  Sentry: { captureException: vi.fn() },
  // scrubObject usado por modules importados transitivamente (audit-legal.service
  // → logger → observability.ts). Identity pass-through é suficiente em test —
  // não-PII contexts passam direto, no scrubbing real necessário.
  scrubObject: vi.fn((obj: unknown) => obj),
}))

// Mock prisma client — apontar pro DB real do test.
vi.mock('../../src/lib/prisma', async () => {
  const { getTestPrisma: getReal } = await import('../helpers/prisma')
  return { prisma: getReal() }
})

vi.mock('../../src/config/env', () => ({
  env: { CRON_DRY_RUN: false, PRO_RETENTION_DAYS: 30 },
}))

/* eslint-disable import/first */
import { purgeExpiredFiles } from '../../src/jobs/retention.job'
import type { LockHandle } from '../../src/scheduler/types'
/* eslint-enable import/first */

const prisma = getTestPrisma()

function makeLock(): LockHandle {
  return {
    token: 'integration-test-token',
    jobName: 'history-purge',
    acquiredAt: new Date(),
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  }
}

interface FileHistorySeed {
  id?: string
  userId: string
  storagePath: string
  originalFilename: string
  mimeType?: string
  fileSize?: number
  expiresAt: Date
  deletedAt?: Date | null
  purgeAttempts?: number
}

async function seedUser(userId: string) {
  await prisma.user.create({
    data: { id: userId, email: `${userId}@test.local` },
  })
}

async function seedFileHistory(seed: FileHistorySeed) {
  // Card #146 fix (descoberto em primeira execução integration local):
  // CHECK constraint file_history_expires_at_after_created_check exige
  // `expires_at >= created_at`. Para seedar rows expiradas (expiresAt
  // no passado), createdAt precisa ser ANTERIOR ao expiresAt. Defaults
  // pra `expiresAt - 1ms` (cobre cenários "expired*" do test) — caller
  // pode override se precisar de createdAt explícito.
  return prisma.fileHistory.create({
    data: {
      userId: seed.userId,
      storagePath: seed.storagePath,
      originalFilename: seed.originalFilename,
      mimeType: seed.mimeType ?? 'text/csv',
      fileSize: seed.fileSize ?? 1024,
      createdAt: new Date(seed.expiresAt.getTime() - 1),
      expiresAt: seed.expiresAt,
      deletedAt: seed.deletedAt ?? null,
      purgeAttempts: seed.purgeAttempts ?? 0,
    },
  })
}

function makeStoragePath(userId: string, jobId: string): string {
  return `${userId}/2026-05-10/${jobId}.csv`
}

beforeEach(async () => {
  vi.clearAllMocks()
  adapterMock.removeByPath.mockResolvedValue({ deleted: true, notFound: false })
  await truncateAll()
})

afterAll(async () => {
  await disconnectTestPrisma()
})

describe('retention.job — Cenário A: invariante R-1 LGPD (não-overshoot)', () => {
  it('3 rows expired + 3 rows non-expired → SÓ as 3 expired são hard-deleted', async () => {
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await seedUser(userId)

    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1d atrás
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7d futuro

    const expired1 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'expired1'),
      originalFilename: 'old1.csv',
      expiresAt: expiredDate,
    })
    const expired2 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'expired2'),
      originalFilename: 'old2.csv',
      expiresAt: expiredDate,
    })
    const expired3 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'expired3'),
      originalFilename: 'old3.csv',
      expiresAt: expiredDate,
    })
    const future1 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'future1'),
      originalFilename: 'new1.csv',
      expiresAt: futureDate,
    })
    const future2 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'future2'),
      originalFilename: 'new2.csv',
      expiresAt: futureDate,
    })
    const future3 = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'future3'),
      originalFilename: 'new3.csv',
      expiresAt: futureDate,
    })

    await purgeExpiredFiles(makeLock())

    // INVARIANTE LGPD: as 3 futures continuam intactas
    const futuresAfter = await prisma.fileHistory.findMany({
      where: { id: { in: [future1.id, future2.id, future3.id] } },
    })
    expect(futuresAfter).toHaveLength(3)
    futuresAfter.forEach((row) => {
      expect(row.deletedAt).toBeNull()
      expect(row.purgeAttempts).toBe(0)
    })

    // As 3 expired foram hard-deletadas (DELETE da tabela)
    const expiredAfter = await prisma.fileHistory.findMany({
      where: { id: { in: [expired1.id, expired2.id, expired3.id] } },
    })
    expect(expiredAfter).toHaveLength(0)

    // audit_log_legal recebeu 6 eventos (3 purge_pending + 3 purge_completed)
    const auditEvents = await prisma.auditLogLegal.findMany({
      where: {
        userId,
        eventType: { in: ['purge_pending', 'purge_completed'] },
      },
    })
    expect(auditEvents).toHaveLength(6)
  })
})

describe('retention.job — Cenário B: crash mid-handler + reconciliação Fase C', () => {
  it('Storage delete falha em todas as rows → 1ª execução soft-delete + 2ª execução reconcilia', async () => {
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await seedUser(userId)

    const expired = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'crashtest1'),
      originalFilename: 'crash.csv',
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    // 1ª execução: Storage falha → soft-delete persiste, INCR purge_attempts.
    adapterMock.removeByPath.mockRejectedValueOnce(
      new Error('Storage 5xx — transient'),
    )
    await purgeExpiredFiles(makeLock())

    const afterFirstRun = await prisma.fileHistory.findUnique({
      where: { id: expired.id },
    })
    expect(afterFirstRun?.deletedAt).not.toBeNull()
    expect(afterFirstRun?.purgeAttempts).toBe(1)

    // 1 audit purge_pending committed (Fase A commit) — PROVA LGPD
    let auditEvents = await prisma.auditLogLegal.findMany({
      where: { userId, eventType: 'purge_pending' },
    })
    expect(auditEvents).toHaveLength(1)

    // Simular passagem de 1h+ pra Fase C reconciliação pegar
    await prisma.fileHistory.update({
      where: { id: expired.id },
      data: { deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })

    // 2ª execução: Storage agora OK
    adapterMock.removeByPath.mockResolvedValue({
      deleted: true,
      notFound: false,
    })
    await purgeExpiredFiles(makeLock())

    // Row finalmente hard-deletada (reconciliação Fase C funcionou)
    const afterSecondRun = await prisma.fileHistory.findUnique({
      where: { id: expired.id },
    })
    expect(afterSecondRun).toBeNull()

    // audit_log_legal tem agora purge_completed também (prova LGPD da purga)
    auditEvents = await prisma.auditLogLegal.findMany({
      where: { userId, eventType: 'purge_completed' },
    })
    expect(auditEvents).toHaveLength(1)
  })
})

describe('retention.job — Cenário C: Storage 5xx → purge_attempts++', () => {
  it('Storage falha consistentemente → purge_attempts incrementa a cada run', async () => {
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await seedUser(userId)

    const expired = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'retrying'),
      originalFilename: 'retry.csv',
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })

    adapterMock.removeByPath.mockRejectedValue(new Error('Storage 503'))

    // Execução 1: soft-delete + INCR pra 1
    await purgeExpiredFiles(makeLock())
    let afterRun = await prisma.fileHistory.findUnique({
      where: { id: expired.id },
    })
    expect(afterRun?.purgeAttempts).toBe(1)
    expect(afterRun?.deletedAt).not.toBeNull()

    // Simular tempo + executar de novo (reconciliação Fase C)
    await prisma.fileHistory.update({
      where: { id: expired.id },
      data: { deletedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    })
    await purgeExpiredFiles(makeLock())
    afterRun = await prisma.fileHistory.findUnique({
      where: { id: expired.id },
    })
    expect(afterRun?.purgeAttempts).toBe(2)
  })
})

describe('retention.job — Cenário D: dead-letter move (purge_attempts >= 5)', () => {
  it('row com purge_attempts=5 → INSERT file_history_dead_letter + DELETE origem + audit purge_failed', async () => {
    const userId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await seedUser(userId)

    // Seed: row pré-condicionada com purge_attempts=5 (atingiu threshold)
    const stuck = await seedFileHistory({
      userId,
      storagePath: makeStoragePath(userId, 'stuckone'),
      originalFilename: 'stuck.csv',
      expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      deletedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      purgeAttempts: 5,
    })

    await purgeExpiredFiles(makeLock())

    // Row foi DELETED da file_history
    const afterRun = await prisma.fileHistory.findUnique({
      where: { id: stuck.id },
    })
    expect(afterRun).toBeNull()

    // Row foi INSERIDA em file_history_dead_letter
    const deadLetterRows = await prisma.fileHistoryDeadLetter.findMany({
      where: { originalFileHistoryId: stuck.id },
    })
    expect(deadLetterRows).toHaveLength(1)
    expect(deadLetterRows[0]?.purgeAttempts).toBe(5)
    expect(deadLetterRows[0]?.lastErrorCode).toBe(
      'STORAGE_DELETE_THRESHOLD_REACHED',
    )
    expect(deadLetterRows[0]?.resolvedAt).toBeNull()

    // audit_log_legal recebeu purge_failed (prova LGPD da quarentena)
    const failedEvents = await prisma.auditLogLegal.findMany({
      where: { userId, eventType: 'purge_failed' },
    })
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]?.errorCode).toBe('STORAGE_DELETE_THRESHOLD_REACHED')
  })
})
