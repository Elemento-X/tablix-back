/**
 * Integration tests — validateAndIncrementUsage ATOMIC (Card 4.2).
 *
 * Prova que o INSERT...ON CONFLICT DO UPDATE WHERE atômico fecha o TOCTOU
 * do waiver WV-2026-002. Roda contra Postgres real (Testcontainers) com
 * Promise.all([validate, validate, validate, ...]) — N requests paralelas
 * pelo MESMO (user, period). Asserto: número de sucessos === slots
 * disponíveis até o limit (não mais, não menos).
 *
 * Sem o fix do Card 4.2, este teste falharia em ~50% das execuções (race
 * window real entre SELECT e UPDATE no padrão antigo).
 *
 * @owner: @dba + @security
 * @card: 4.2 — fecha WV-2026-002
 */
/* eslint-disable import/first */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest'

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'
import {
  validateAndIncrementUsage,
  getCurrentPeriod,
} from '../../src/modules/usage/usage.service'
import { PRO_LIMITS, FREE_LIMITS } from '../../src/config/plan-limits'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

beforeAll(() => {
  // Smoke: garante que o Prisma de teste está pronto (Testcontainer up).
  getTestPrisma()
})

afterAll(async () => {
  await disconnectTestPrisma()
})

beforeEach(async () => {
  await truncateAll()
})

async function seedUser(email: string): Promise<string> {
  const user = await getTestPrisma().user.create({
    data: { email, role: 'PRO' },
  })
  return user.id
}

async function readUsageCount(userId: string): Promise<number> {
  const usage = await getTestPrisma().usage.findUnique({
    where: {
      userId_period: { userId, period: getCurrentPeriod() },
    },
  })
  return usage?.unificationsCount ?? 0
}

// ============================================
// Happy path
// ============================================
describe('validateAndIncrementUsage — happy path (DB real)', () => {
  it('primeira chamada cria registro com count=1', async () => {
    const userId = await seedUser('first@tablix.test')

    const result = await validateAndIncrementUsage(userId, 'PRO')

    expect(result.unificationsCount).toBe(1)
    expect(result.limit).toBe(PRO_LIMITS.unificationsPerMonth)
    expect(await readUsageCount(userId)).toBe(1)
  })

  it('chamadas sequenciais incrementam contador', async () => {
    const userId = await seedUser('seq@tablix.test')

    const r1 = await validateAndIncrementUsage(userId, 'PRO')
    const r2 = await validateAndIncrementUsage(userId, 'PRO')
    const r3 = await validateAndIncrementUsage(userId, 'PRO')

    expect(r1.unificationsCount).toBe(1)
    expect(r2.unificationsCount).toBe(2)
    expect(r3.unificationsCount).toBe(3)
    expect(await readUsageCount(userId)).toBe(3)
  })

  it('atinge limit e a próxima chamada throw LIMIT_EXCEEDED', async () => {
    const userId = await seedUser('limit@tablix.test')

    // Pré-popula até o limit
    await getTestPrisma().usage.create({
      data: {
        userId,
        period: getCurrentPeriod(),
        unificationsCount: PRO_LIMITS.unificationsPerMonth,
      },
    })

    const promise = validateAndIncrementUsage(userId, 'PRO')
    await expect(promise).rejects.toBeInstanceOf(AppError)
    await expect(promise).rejects.toMatchObject({
      code: ErrorCodes.LIMIT_EXCEEDED,
    })
    // Contador NÃO foi incrementado (atomicidade)
    expect(await readUsageCount(userId)).toBe(PRO_LIMITS.unificationsPerMonth)
  })
})

// ============================================
// ATOMICITY (Card 4.2 — fecha WV-2026-002)
// ============================================
describe('validateAndIncrementUsage — atomicity (TOCTOU fechado)', () => {
  it('Promise.all com N=10 paralelas: usuário sem registro → exatamente N sucessos (count=10)', async () => {
    const userId = await seedUser('parallel-fresh@tablix.test')

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        validateAndIncrementUsage(userId, 'PRO'),
      ),
    )

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    // PRO_LIMITS.unificationsPerMonth = 30, então 10 paralelas devem
    // todas passar — testa que o INSERT inicial + UPDATE em concorrência
    // não duplicam registro (índice unique garante).
    expect(successes).toHaveLength(10)
    expect(failures).toHaveLength(0)
    expect(await readUsageCount(userId)).toBe(10)
  })

  it('Promise.all atinge exatamente o limit: N sucessos, M falhas (CRÍTICO — fecha TOCTOU)', async () => {
    const userId = await seedUser('parallel-saturate@tablix.test')

    // Pré-popula até limit-2 → temos 2 slots disponíveis
    const initialCount = PRO_LIMITS.unificationsPerMonth - 2
    await getTestPrisma().usage.create({
      data: {
        userId,
        period: getCurrentPeriod(),
        unificationsCount: initialCount,
      },
    })

    // Dispara 10 paralelas — só 2 podem ter sucesso (slots disponíveis)
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        validateAndIncrementUsage(userId, 'PRO'),
      ),
    )

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    // EXATAMENTE 2 sucessos (slots) e 8 falhas (limit) — garantia atômica.
    // Sem o fix do Card 4.2, este número seria não-determinístico:
    // até 10 podiam passar e o usuário ultrapassaria 28 unificações.
    expect(successes).toHaveLength(2)
    expect(failures).toHaveLength(8)
    expect(await readUsageCount(userId)).toBe(PRO_LIMITS.unificationsPerMonth)

    // Todas as falhas são LIMIT_EXCEEDED (não outro tipo de erro)
    failures.forEach((failure) => {
      expect(failure.status).toBe('rejected')
      if (failure.status === 'rejected') {
        expect(failure.reason).toBeInstanceOf(AppError)
        expect(failure.reason.code).toBe(ErrorCodes.LIMIT_EXCEEDED)
      }
    })
  })

  it('isolation: race em user A NÃO afeta user B (índice unique por user_id+period)', async () => {
    const userA = await seedUser('parallel-isolation-a@tablix.test')
    const userB = await seedUser('parallel-isolation-b@tablix.test')

    // 5 paralelas pra cada user, intercaladas
    const operations = []
    for (let i = 0; i < 5; i++) {
      operations.push(validateAndIncrementUsage(userA, 'PRO'))
      operations.push(validateAndIncrementUsage(userB, 'PRO'))
    }

    const results = await Promise.allSettled(operations)
    const allSucceeded = results.every((r) => r.status === 'fulfilled')

    expect(allSucceeded).toBe(true)
    expect(await readUsageCount(userA)).toBe(5)
    expect(await readUsageCount(userB)).toBe(5)
  })

  it('FREE plan (limit=1): paralelas → exatamente 1 sucesso', async () => {
    const userId = await seedUser('parallel-free@tablix.test')

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        validateAndIncrementUsage(userId, 'FREE'),
      ),
    )

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    expect(successes).toHaveLength(FREE_LIMITS.unificationsPerMonth) // 1
    expect(failures).toHaveLength(5 - FREE_LIMITS.unificationsPerMonth) // 4
    expect(await readUsageCount(userId)).toBe(FREE_LIMITS.unificationsPerMonth)
  })
})
