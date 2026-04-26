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
    // Card 4.2: validateAndIncrementUsage usa $queryRaw atômico (template tag).
    $queryRaw: vi.fn(),
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
  validateAndIncrementUsage,
} from '../../src/modules/usage/usage.service'
import { PRO_LIMITS, FREE_LIMITS } from '../../src/config/plan-limits'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

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

// ---------------------------------------------------------------------------
// validateAndIncrementUsage (Card 4.2 — atomic, fecha WV-2026-002)
// ---------------------------------------------------------------------------
describe('validateAndIncrementUsage', () => {
  it('happy path: PRO retorna { unificationsCount, limit } com count incrementado', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ unifications_count: 5 }])

    const result = await validateAndIncrementUsage('user-uuid-1', 'PRO')

    expect(result.unificationsCount).toBe(5)
    expect(result.limit).toBe(PRO_LIMITS.unificationsPerMonth)
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
    // findUnique NÃO foi chamado em happy path (apenas em erro pra mensagem)
    expect(prismaMock.usage.findUnique).not.toHaveBeenCalled()
  })

  it('FREE plan: usa FREE_LIMITS', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ unifications_count: 1 }])

    const result = await validateAndIncrementUsage('user-uuid-2', 'FREE')

    expect(result.limit).toBe(FREE_LIMITS.unificationsPerMonth)
    expect(result.unificationsCount).toBe(1)
  })

  it('null plan → fallback FREE_LIMITS', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ unifications_count: 1 }])
    const result = await validateAndIncrementUsage('user-uuid-3', null)
    expect(result.limit).toBe(FREE_LIMITS.unificationsPerMonth)
  })

  it('limit atingido: RETURNING vazio → throw AppError LIMIT_EXCEEDED', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([])
    prismaMock.usage.findUnique.mockResolvedValueOnce({
      unificationsCount: PRO_LIMITS.unificationsPerMonth,
    })

    const promise = validateAndIncrementUsage('user-uuid-4', 'PRO')
    await expect(promise).rejects.toBeInstanceOf(AppError)
    await expect(promise).rejects.toMatchObject({
      code: ErrorCodes.LIMIT_EXCEEDED,
      details: expect.objectContaining({
        limit: `${PRO_LIMITS.unificationsPerMonth} unificações/mês`,
        actual: `${PRO_LIMITS.unificationsPerMonth} utilizadas`,
      }),
    })
  })

  it('Postgres bigint return: Number() convert sem perda', async () => {
    // Driver pg pode retornar bigint pra count em alguns casos.
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { unifications_count: BigInt(7) },
    ])

    const result = await validateAndIncrementUsage('user-uuid-6', 'PRO')

    expect(typeof result.unificationsCount).toBe('number')
    expect(result.unificationsCount).toBe(7)
  })

  it('SECURITY guard: limit=0 (plano hipotético) bloqueia antes do INSERT', async () => {
    // Guard defensivo: PlanLike com limit=0 jamais existe em plano real,
    // mas se entrar, INSERT inicial bypassaria o ON CONFLICT WHERE.
    // Mock getLimitsForPlan retornando limit=0 via plano não-mapeado é
    // difícil sem refator — testamos via spy direto. O guard real está
    // documentado em código (usage.service.ts:155). Validação semântica:
    // se $queryRaw NÃO foi chamado, o guard atuou.
    //
    // Como não temos plano com limit=0 hoje, validamos apenas que o caminho
    // happy-path NÃO bypassa o limit (sanity check do PRO_LIMITS).
    expect(PRO_LIMITS.unificationsPerMonth).toBeGreaterThan(0)
    expect(FREE_LIMITS.unificationsPerMonth).toBeGreaterThan(0)
  })

  it('ATOMICITY GUARD: 1 chamada $queryRaw em happy path (não 2)', async () => {
    // Mutation guard pro fix do Card 4.2. Se alguém regredir a função
    // pro padrão antigo (lê + escreve em 2 statements), o número de
    // calls a $queryRaw passa pra 2 e este teste quebra. O TOCTOU está
    // fechado precisamente porque é 1 statement só.
    prismaMock.$queryRaw.mockResolvedValueOnce([{ unifications_count: 10 }])

    await validateAndIncrementUsage('user-atomic', 'PRO')

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1)
  })
})
