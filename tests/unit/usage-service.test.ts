/**
 * Unit tests — src/modules/usage/usage.service (Card 4.1 #33).
 *
 * Cobre:
 *  - getCurrentPeriod: cálculo UTC determinístico (não vaza com timezone local)
 *  - getNextResetAt: rollover correto de dezembro → janeiro do próximo ano
 *  - getCurrentUsage: lê DB, retorna 0 se não existe registro
 *  - getUserUsage: compose com remaining nunca negativo (saturated)
 *  - getLimitsForPlanResponse: mapeia PRO_LIMITS/FREE_LIMITS → DTO
 *    (hasWatermark derivado do plan: FREE=true, PRO=false)
 *  - PlanLike: aceita 'FREE' | 'PRO' | null e mapeia 'FREE' → null
 *
 * @owner: @tester
 * @card: 4.1 (#33)
 */
/* eslint-disable import/first */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    usage: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

import {
  getCurrentPeriod,
  getNextResetAt,
  getCurrentUsage,
  getUserUsage,
  getLimitsForPlanResponse,
} from '../../src/modules/usage/usage.service'
import { PRO_LIMITS, FREE_LIMITS } from '../../src/config/plan-limits'

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// getCurrentPeriod
// ---------------------------------------------------------------------------
describe('getCurrentPeriod', () => {
  it('retorna formato YYYY-MM em UTC', () => {
    const date = new Date('2026-04-25T20:00:00Z')
    expect(getCurrentPeriod(date)).toBe('2026-04')
  })

  it('zero-pad em mês de 1 dígito (jan, fev, ...)', () => {
    const jan = new Date('2026-01-15T12:00:00Z')
    const sep = new Date('2026-09-15T12:00:00Z')
    expect(getCurrentPeriod(jan)).toBe('2026-01')
    expect(getCurrentPeriod(sep)).toBe('2026-09')
  })

  it('NÃO vaza com timezone local — usa UTC explicitamente', () => {
    // 23h do dia 31 em UTC-3 (Brasília) = 02h do dia 1 do próximo mês UTC.
    // Se a função usasse `getMonth()` (local), retornaria mês errado em
    // ambientes com TZ ajustado. UTC garante invariância.
    const lateNightBrasilia = new Date('2026-04-30T23:00:00-03:00')
    // Em UTC: 2026-05-01 02:00 → período = 2026-05
    expect(getCurrentPeriod(lateNightBrasilia)).toBe('2026-05')
  })

  it('default usa Date.now() — smoke test sem crash', () => {
    const period = getCurrentPeriod()
    expect(period).toMatch(/^\d{4}-\d{2}$/)
  })

  it('último ms do mês mantém período do mês corrente (boundary)', () => {
    // Edge case @tester BAIXO: data exatamente no último ms do mês deve
    // retornar o mês corrente, não o próximo. Pega mutação `month + 1` em
    // vez de `month + 0`. Bonus: garante que `getUTCMonth()` é zero-indexed
    // e padStart funciona em mês 12.
    const lastMs = new Date('2026-12-31T23:59:59.999Z')
    expect(getCurrentPeriod(lastMs)).toBe('2026-12')

    // Primeiro ms do mês também tem que retornar o próprio mês
    const firstMs = new Date('2026-12-01T00:00:00.000Z')
    expect(getCurrentPeriod(firstMs)).toBe('2026-12')
  })
})

// ---------------------------------------------------------------------------
// getNextResetAt
// ---------------------------------------------------------------------------
describe('getNextResetAt', () => {
  it('retorna primeiro dia do próximo mês em UTC', () => {
    const date = new Date('2026-04-25T20:00:00Z')
    const reset = getNextResetAt(date)
    expect(reset.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('rollover de dezembro → janeiro do ano seguinte', () => {
    const dec = new Date('2026-12-15T12:00:00Z')
    const reset = getNextResetAt(dec)
    expect(reset.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('é determinístico — mesmo input, mesmo output', () => {
    const date = new Date('2026-06-10T15:30:00Z')
    expect(getNextResetAt(date).toISOString()).toBe(
      getNextResetAt(date).toISOString(),
    )
  })
})

// ---------------------------------------------------------------------------
// getCurrentUsage
// ---------------------------------------------------------------------------
describe('getCurrentUsage', () => {
  it('retorna unificationsCount do registro existente', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({
      unificationsCount: 7,
    })
    const count = await getCurrentUsage('user-uuid-1')
    expect(count).toBe(7)
    expect(prismaMock.usage.findUnique).toHaveBeenCalledWith({
      where: {
        userId_period: { userId: 'user-uuid-1', period: getCurrentPeriod() },
      },
    })
  })

  it('retorna 0 se registro não existe (primeiro acesso do mês)', async () => {
    prismaMock.usage.findUnique.mockResolvedValue(null)
    const count = await getCurrentUsage('user-uuid-2')
    expect(count).toBe(0)
  })

  it('NÃO cria registro — leitura pura', async () => {
    prismaMock.usage.findUnique.mockResolvedValue(null)
    await getCurrentUsage('user-uuid-3')
    // findUnique é a única chamada — sem upsert/create
    expect(prismaMock.usage.findUnique).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// getUserUsage
// ---------------------------------------------------------------------------
describe('getUserUsage', () => {
  it('compõe DTO completo: count + limit + remaining + period + resetAt', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 3 })
    const result = await getUserUsage('user-uuid-1', 'PRO')

    expect(result.current).toBe(3)
    expect(result.limit).toBe(PRO_LIMITS.unificationsPerMonth)
    expect(result.remaining).toBe(PRO_LIMITS.unificationsPerMonth - 3)
    expect(result.period).toMatch(/^\d{4}-\d{2}$/)
    expect(result.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  })

  it('FREE plan: usa FREE_LIMITS', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 })
    const result = await getUserUsage('user-uuid-2', 'FREE')

    expect(result.limit).toBe(FREE_LIMITS.unificationsPerMonth)
    expect(result.remaining).toBe(FREE_LIMITS.unificationsPerMonth)
  })

  it('null plan → fallback FREE_LIMITS', async () => {
    prismaMock.usage.findUnique.mockResolvedValue({ unificationsCount: 0 })
    const result = await getUserUsage('user-uuid-3', null)
    expect(result.limit).toBe(FREE_LIMITS.unificationsPerMonth)
  })

  it('SATURATED: remaining nunca negativo (proteção contra TOCTOU pré-Card 4.2)', async () => {
    // Cenário: usuário ultrapassou via race condition pré-fix do Card 4.2.
    // UI ainda renderiza sem quebrar.
    prismaMock.usage.findUnique.mockResolvedValue({
      unificationsCount: PRO_LIMITS.unificationsPerMonth + 5,
    })
    const result = await getUserUsage('user-uuid-4', 'PRO')

    expect(result.current).toBe(PRO_LIMITS.unificationsPerMonth + 5)
    expect(result.remaining).toBe(0) // saturated em zero, nunca -5
  })
})

// ---------------------------------------------------------------------------
// getLimitsForPlanResponse
// ---------------------------------------------------------------------------
describe('getLimitsForPlanResponse', () => {
  it('PRO: retorna PRO_LIMITS mapeado + hasWatermark=false', () => {
    const result = getLimitsForPlanResponse('PRO')
    expect(result.plan).toBe('PRO')
    expect(result.limits.unificationsPerMonth).toBe(
      PRO_LIMITS.unificationsPerMonth,
    )
    expect(result.limits.maxInputFiles).toBe(PRO_LIMITS.maxInputFiles)
    expect(result.limits.maxFileSize).toBe(PRO_LIMITS.maxFileSize)
    expect(result.limits.maxTotalSize).toBe(PRO_LIMITS.maxTotalSize)
    expect(result.limits.maxRowsPerFile).toBe(PRO_LIMITS.maxRows)
    expect(result.limits.maxTotalRows).toBe(PRO_LIMITS.maxTotalRows)
    expect(result.limits.maxColumns).toBe(PRO_LIMITS.maxColumns)
    expect(result.limits.hasWatermark).toBe(false)
  })

  it('FREE: retorna FREE_LIMITS mapeado + hasWatermark=true', () => {
    const result = getLimitsForPlanResponse('FREE')
    expect(result.plan).toBe('FREE')
    expect(result.limits.unificationsPerMonth).toBe(
      FREE_LIMITS.unificationsPerMonth,
    )
    expect(result.limits.hasWatermark).toBe(true)
  })

  it('null plan → trata como FREE', () => {
    const result = getLimitsForPlanResponse(null)
    expect(result.plan).toBe('FREE')
    expect(result.limits.hasWatermark).toBe(true)
    expect(result.limits.unificationsPerMonth).toBe(
      FREE_LIMITS.unificationsPerMonth,
    )
  })

  it('SECURITY: hasWatermark é decidido server-side (cliente não controla)', () => {
    // Guard: garante que mesmo se schema mudar pra incluir hasWatermark
    // como input opcional, a derivação a partir do plan permanece autoritativa.
    expect(getLimitsForPlanResponse('PRO').limits.hasWatermark).toBe(false)
    expect(getLimitsForPlanResponse('FREE').limits.hasWatermark).toBe(true)
    expect(getLimitsForPlanResponse(null).limits.hasWatermark).toBe(true)
  })
})
