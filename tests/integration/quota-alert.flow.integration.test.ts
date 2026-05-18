/**
 * Integration tests para quota_alerts_sent — Card #147 (5.2c) F3.
 *
 * Cobre cenários que SÓ podem ser provados com Postgres real:
 *
 *   1. **UNIQUE constraint atomicamente absorve concorrência** — Promise.all
 *      com 10x INSERT mesmos (user, threshold, period) → EXATAMENTE 1 row
 *      criada, 9 rejeitadas com P2002. Prova que o pattern `INSERT...ON
 *      CONFLICT DO NOTHING` (usado no handler) é à prova de race
 *      (espelha Card 4.2).
 *
 *   2. **CHECK threshold IN (70, 90)** — INSERT com threshold=80 rejeita.
 *
 *   3. **CHECK period regex YYYY-MM** — INSERT com period='2026-13' rejeita
 *      (mês inválido), '2026/05' rejeita (formato errado).
 *
 *   4. **FK ON DELETE CASCADE** — DELETE user purga quota_alerts_sent
 *      relacionado (LGPD compliance).
 *
 *   5. **Cross-month permite reenvio** — INSERT mesmo (user, threshold) com
 *      period='2026-05' e depois '2026-06' → AMBOS sucesso.
 *
 * Execução: requer Docker (Testcontainers Postgres). NÃO mocka Resend nem
 * service business logic — esses estão em quota-alert-job.test.ts (unit).
 *
 * @owner: @tester + @dba
 * @card: #147 F3 — T-3.8
 */
import fc from 'fast-check'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __testing as quotaAlertTesting,
  scanUsageAndAlert,
} from '../../src/jobs/quota-alert.job'
import {
  disconnectTestPrisma,
  getTestPrisma,
  truncateAll,
} from '../helpers/prisma'

const prisma = getTestPrisma()

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await disconnectTestPrisma()
})

// ============================================
// FIXTURES
// ============================================

/**
 * Cria user de teste e retorna ID. Email único por timestamp pra
 * evitar conflito entre testes (truncateAll cobre, mas defesa em profundidade).
 */
async function createTestUser(emailSuffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `quota-test-${emailSuffix}-${Date.now()}@example.com`,
      role: 'PRO',
    },
    select: { id: true },
  })
  return user.id
}

// ============================================
// 1. UNIQUE constraint absorve concorrência (Promise.all)
// ============================================

describe('quota_alerts_sent UNIQUE constraint sob concorrência', () => {
  it('Promise.all 10x INSERT mesmos (user, threshold, period) → EXATAMENTE 1 cria, 9 P2002', async () => {
    const userId = await createTestUser('concurrent')

    // Cria 10 promises simultâneas tentando INSERT atomically
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        prisma.quotaAlertSent.create({
          data: { userId, threshold: 70, period: '2026-05' },
        }),
      ),
    )

    // Conta fulfilled vs rejected
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(9)

    // Confirma row única no DB
    const rows = await prisma.quotaAlertSent.findMany({
      where: { userId, threshold: 70, period: '2026-05' },
    })
    expect(rows).toHaveLength(1)
  })

  it('INSERT...ON CONFLICT DO NOTHING (via $queryRaw) é completamente atomic', async () => {
    // Caminho alternativo: simula o pattern SQL bruto que poderia ser usado
    // no futuro pra evitar try/catch P2002 no handler.
    const userId = await createTestUser('on-conflict')

    const results = await Promise.allSettled(
      Array.from(
        { length: 5 },
        () =>
          prisma.$executeRaw`
          INSERT INTO quota_alerts_sent (user_id, threshold, period)
          VALUES (${userId}::uuid, 90, '2026-05')
          ON CONFLICT (user_id, threshold, period) DO NOTHING
        `,
      ),
    )

    // Todos os 5 sucedem (ON CONFLICT DO NOTHING não throws), mas só 1 cria row
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)

    const rows = await prisma.quotaAlertSent.findMany({
      where: { userId, threshold: 90, period: '2026-05' },
    })
    expect(rows).toHaveLength(1)
  })
})

// ============================================
// 2. CHECK constraints
// ============================================

describe('quota_alerts_sent CHECK constraints', () => {
  it('threshold IN (70, 90) — rejeita 80', async () => {
    const userId = await createTestUser('check-threshold')

    await expect(
      prisma.$executeRaw`
        INSERT INTO quota_alerts_sent (user_id, threshold, period)
        VALUES (${userId}::uuid, 80, '2026-05')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('threshold IN (70, 90) — rejeita 100', async () => {
    const userId = await createTestUser('check-threshold-100')

    await expect(
      prisma.$executeRaw`
        INSERT INTO quota_alerts_sent (user_id, threshold, period)
        VALUES (${userId}::uuid, 100, '2026-05')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('threshold IN (70, 90) — aceita 70', async () => {
    const userId = await createTestUser('check-threshold-70')

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 70, period: '2026-05' },
      }),
    ).resolves.toBeDefined()
  })

  it('threshold IN (70, 90) — aceita 90', async () => {
    const userId = await createTestUser('check-threshold-90')

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 90, period: '2026-05' },
      }),
    ).resolves.toBeDefined()
  })

  it('period format — rejeita "2026-13" (mês inválido)', async () => {
    const userId = await createTestUser('check-period-invalid-month')

    await expect(
      prisma.$executeRaw`
        INSERT INTO quota_alerts_sent (user_id, threshold, period)
        VALUES (${userId}::uuid, 70, '2026-13')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('period format — rejeita "2026-00" (mês zero)', async () => {
    const userId = await createTestUser('check-period-zero')

    await expect(
      prisma.$executeRaw`
        INSERT INTO quota_alerts_sent (user_id, threshold, period)
        VALUES (${userId}::uuid, 70, '2026-00')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('period format — rejeita "2026/05" (separador errado)', async () => {
    const userId = await createTestUser('check-period-separator')

    await expect(
      prisma.$executeRaw`
        INSERT INTO quota_alerts_sent (user_id, threshold, period)
        VALUES (${userId}::uuid, 70, '2026/05')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('period format — aceita "2026-01" (extremo inferior)', async () => {
    const userId = await createTestUser('check-period-jan')

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 70, period: '2026-01' },
      }),
    ).resolves.toBeDefined()
  })

  it('period format — aceita "2026-12" (extremo superior)', async () => {
    const userId = await createTestUser('check-period-dec')

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 70, period: '2026-12' },
      }),
    ).resolves.toBeDefined()
  })
})

// ============================================
// 3. FK ON DELETE CASCADE (LGPD)
// ============================================

describe('quota_alerts_sent FK ON DELETE CASCADE', () => {
  it('DELETE user → quota_alerts_sent relacionado é purgado', async () => {
    const userId = await createTestUser('cascade')

    // Cria 3 alertas pro user
    await prisma.quotaAlertSent.createMany({
      data: [
        { userId, threshold: 70, period: '2026-05' },
        { userId, threshold: 90, period: '2026-05' },
        { userId, threshold: 70, period: '2026-06' },
      ],
    })

    expect(await prisma.quotaAlertSent.count({ where: { userId } })).toBe(3)

    // DELETE user → CASCADE
    await prisma.user.delete({ where: { id: userId } })

    expect(await prisma.quotaAlertSent.count({ where: { userId } })).toBe(0)
  })
})

// ============================================
// 4. Cross-month permite reenvio
// ============================================

describe('quota_alerts_sent cross-month', () => {
  it('mesmo (user, threshold) com periods diferentes → AMBOS aceitos', async () => {
    const userId = await createTestUser('cross-month')

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 70, period: '2026-05' },
      }),
    ).resolves.toBeDefined()

    await expect(
      prisma.quotaAlertSent.create({
        data: { userId, threshold: 70, period: '2026-06' },
      }),
    ).resolves.toBeDefined()

    const count = await prisma.quotaAlertSent.count({
      where: { userId, threshold: 70 },
    })
    expect(count).toBe(2)
  })

  it('mesmo (user, period) com thresholds diferentes (70+90) → AMBOS aceitos', async () => {
    const userId = await createTestUser('two-thresholds')

    await prisma.quotaAlertSent.createMany({
      data: [
        { userId, threshold: 70, period: '2026-05' },
        { userId, threshold: 90, period: '2026-05' },
      ],
    })

    const count = await prisma.quotaAlertSent.count({
      where: { userId, period: '2026-05' },
    })
    expect(count).toBe(2)
  })
})

// ============================================
// 5. selectActiveProUsers — filtro Token (Card #147 fix-pack @tester ALTO F3)
// ============================================

/**
 * Cria user PRO com token customizado. tokenSpec define `status` + opcional
 * `expiresAt` (Date | null). Retorna userId.
 */
async function createUserWithToken(
  suffix: string,
  tokenSpec: {
    status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED'
    expiresAt: Date | null
  },
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `select-pro-${suffix}-${Date.now()}@example.com`,
      role: 'PRO',
      tokens: {
        create: {
          token: `tok-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          status: tokenSpec.status,
          expiresAt: tokenSpec.expiresAt,
        },
      },
    },
    select: { id: true },
  })
  return user.id
}

async function createUserFree(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `free-${suffix}-${Date.now()}@example.com`,
      role: 'FREE',
      // sem token
    },
    select: { id: true },
  })
  return user.id
}

describe('selectActiveProUsers — filtro Token (LGPD-safe audiência)', () => {
  it('retorna APENAS users PRO com token ACTIVE + expiresAt válido', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // +30d
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000) // -1d

    const idFree = await createUserFree('a')
    const idPROActiveFuture = await createUserWithToken('b', {
      status: 'ACTIVE',
      expiresAt: future,
    })
    const idPROActiveNull = await createUserWithToken('c', {
      status: 'ACTIVE',
      expiresAt: null,
    })
    const idPROExpired = await createUserWithToken('d', {
      status: 'ACTIVE',
      expiresAt: past,
    })
    const idPROCancelled = await createUserWithToken('e', {
      status: 'CANCELLED',
      expiresAt: future,
    })

    const result = await quotaAlertTesting.selectActiveProUsers()
    const returnedIds = result.map((u) => u.id).sort()
    const expectedIds = [idPROActiveFuture, idPROActiveNull].sort()

    expect(returnedIds).toEqual(expectedIds)
    // Garante que FREE, expirado e cancelado NÃO aparecem
    expect(returnedIds).not.toContain(idFree)
    expect(returnedIds).not.toContain(idPROExpired)
    expect(returnedIds).not.toContain(idPROCancelled)
  })

  it('user PRO com 2 tokens (1 ACTIVE + 1 EXPIRED) aparece 1× só', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const userId = await createUserWithToken('multi', {
      status: 'ACTIVE',
      expiresAt: future,
    })
    // Add 2º token EXPIRED no mesmo user
    await prisma.token.create({
      data: {
        userId,
        token: `tok-expired-${Date.now()}`,
        status: 'EXPIRED',
        expiresAt: past,
      },
    })

    const result = await quotaAlertTesting.selectActiveProUsers()
    const matches = result.filter((u) => u.id === userId)
    expect(matches).toHaveLength(1) // distinct
  })
})

// ============================================
// 6. scanUsageAndAlert handler end-to-end (Card #147 fix-pack @tester ALTO F4)
// ============================================

/**
 * LockHandle fake pra integration test. heartbeat sempre true; release no-op.
 */
function createFakeLock() {
  return {
    token: `fake-${Date.now()}`,
    jobName: 'quota-alert',
    acquiredAt: new Date(),
    heartbeat: async () => true,
    release: async () => undefined,
  }
}

describe('scanUsageAndAlert handler end-to-end (Postgres real)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('3 users PRO com 65%/75%/95% → 0/1/2 INSERTs em quota_alerts_sent', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const u65 = await createUserWithToken('low', {
      status: 'ACTIVE',
      expiresAt: future,
    })
    const u75 = await createUserWithToken('warn', {
      status: 'ACTIVE',
      expiresAt: future,
    })
    const u95 = await createUserWithToken('crit', {
      status: 'ACTIVE',
      expiresAt: future,
    })

    // Popula usage table (period UTC atual)
    const period = `${new Date().getUTCFullYear()}-${String(
      new Date().getUTCMonth() + 1,
    ).padStart(2, '0')}`
    await prisma.usage.createMany({
      data: [
        { userId: u65, period, unificationsCount: 19 }, // 63%
        { userId: u75, period, unificationsCount: 22 }, // 73%
        { userId: u95, period, unificationsCount: 29 }, // 96%
      ],
    })

    // Stub email senders pra não chamar Resend real
    const emailModule = await import('../../src/lib/email')
    vi.spyOn(emailModule, 'sendQuotaWarningEmail').mockResolvedValue(undefined)
    vi.spyOn(emailModule, 'sendQuotaCriticalEmail').mockResolvedValue(undefined)

    await scanUsageAndAlert(createFakeLock())

    // u65: 0 rows; u75: 1 row (threshold=70); u95: 2 rows (70+90)
    expect(await prisma.quotaAlertSent.count({ where: { userId: u65 } })).toBe(
      0,
    )
    expect(await prisma.quotaAlertSent.count({ where: { userId: u75 } })).toBe(
      1,
    )
    expect(await prisma.quotaAlertSent.count({ where: { userId: u95 } })).toBe(
      2,
    )
  })

  it('rerun mesmo período → dedupe (count não cresce)', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const u = await createUserWithToken('rerun', {
      status: 'ACTIVE',
      expiresAt: future,
    })
    const period = `${new Date().getUTCFullYear()}-${String(
      new Date().getUTCMonth() + 1,
    ).padStart(2, '0')}`
    await prisma.usage.create({
      data: { userId: u, period, unificationsCount: 22 }, // 73%
    })

    const emailModule = await import('../../src/lib/email')
    vi.spyOn(emailModule, 'sendQuotaWarningEmail').mockResolvedValue(undefined)

    await scanUsageAndAlert(createFakeLock())
    const countAfter1st = await prisma.quotaAlertSent.count({
      where: { userId: u },
    })
    await scanUsageAndAlert(createFakeLock())
    const countAfter2nd = await prisma.quotaAlertSent.count({
      where: { userId: u },
    })

    expect(countAfter1st).toBe(1)
    expect(countAfter2nd).toBe(1) // dedupe absorveu
  })
})

// ============================================
// 7. Property-based — INSERT...ON CONFLICT idempotency (F8 fix-pack @tester MÉDIO)
// ============================================

describe('INSERT...ON CONFLICT DO NOTHING — property-based (100 rounds)', () => {
  it('forAll N inserts mesmos (user, threshold, period) → EXATAMENTE 1 row', async () => {
    const userId = await createTestUser('property-based')

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // N inserts entre 1 e 20
        fc.constantFrom(70, 90), // threshold válido
        async (n, threshold) => {
          // Reset entre rounds — purga só do user-period-threshold corrente
          await prisma.quotaAlertSent.deleteMany({
            where: { userId, threshold, period: '2026-05' },
          })

          // Tenta N inserts sequenciais com INSERT...ON CONFLICT DO NOTHING
          for (let i = 0; i < n; i++) {
            await prisma.$executeRaw`
              INSERT INTO quota_alerts_sent (user_id, threshold, period)
              VALUES (${userId}::uuid, ${threshold}, '2026-05')
              ON CONFLICT (user_id, threshold, period) DO NOTHING
            `
          }

          // Invariante: EXATAMENTE 1 row criada (não importa N)
          const count = await prisma.quotaAlertSent.count({
            where: { userId, threshold, period: '2026-05' },
          })
          return count === 1
        },
      ),
      { numRuns: 100, seed: 42 },
    )
  })
})
