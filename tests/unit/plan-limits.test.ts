/**
 * Unit tests for src/config/plan-limits.ts (Card 1.11)
 *
 * Cobre:
 *   - Valores canônicos de FREE_LIMITS e PRO_LIMITS (regression guards D.1)
 *   - getLimitsForPlan(null|undefined) → FREE fallback
 *   - getLimitsForPlan('PRO') → PRO_LIMITS
 *   - getLimitsForPlan(<plano não mapeado>) → FREE fallback defensivo
 *   - PLAN_LIMITS contém entrada para cada enum do Prisma Plan
 *   - Invariantes estruturais: FREE colapsa maxFileSize==maxTotalSize
 *   - Invariantes estruturais: PRO maxInputFiles * maxFileSize == maxTotalSize
 *   - Mutação: trocar 30 → 40, 1 → 5, 500 → 1000 seria pego
 *
 * @owner: @tester
 */
import { describe, it, expect, vi } from 'vitest'
import {
  FREE_LIMITS,
  PRO_LIMITS,
  PLAN_LIMITS,
  getLimitsForPlan,
  type PlanLimits,
} from '../../src/config/plan-limits'
import { logger } from '../../src/lib/logger'

// ===========================================
// Valores canônicos — regression guards D.1
// ===========================================
describe('plan-limits — FREE_LIMITS canonical values', () => {
  it('unificationsPerMonth = 1', () => {
    // Regression guard: antes era 5 no auth.service, spec real FREE = 1/mês
    expect(FREE_LIMITS.unificationsPerMonth).toBe(1)
  })

  it('maxInputFiles = 3', () => {
    expect(FREE_LIMITS.maxInputFiles).toBe(3)
  })

  it('maxRows = 500', () => {
    expect(FREE_LIMITS.maxRows).toBe(500)
  })

  it('maxTotalRows = 500 (colapsa com maxRows)', () => {
    expect(FREE_LIMITS.maxTotalRows).toBe(500)
  })

  it('maxColumns = 3', () => {
    expect(FREE_LIMITS.maxColumns).toBe(3)
  })

  it('maxFileSize = 1 MB', () => {
    expect(FREE_LIMITS.maxFileSize).toBe(1 * 1024 * 1024)
  })

  it('maxTotalSize = 1 MB (colapsa com maxFileSize — soma total, não por arquivo)', () => {
    expect(FREE_LIMITS.maxTotalSize).toBe(1 * 1024 * 1024)
  })

  it('FREE_LIMITS satisfaz interface PlanLimits (todos os campos presentes)', () => {
    const keys: Array<keyof PlanLimits> = [
      'unificationsPerMonth',
      'maxInputFiles',
      'maxRows',
      'maxTotalRows',
      'maxColumns',
      'maxFileSize',
      'maxTotalSize',
    ]
    for (const k of keys) {
      expect(FREE_LIMITS[k]).toBeDefined()
      expect(typeof FREE_LIMITS[k]).toBe('number')
      expect(FREE_LIMITS[k]).toBeGreaterThan(0)
    }
  })
})

describe('plan-limits — PRO_LIMITS canonical values (D.1)', () => {
  it('unificationsPerMonth = 30 (regression guard 40→30)', () => {
    // Bug histórico: auth.service tinha 40 hardcoded, spreadsheet/types também.
    // D.1 fechou em 30. Esse guard é literal anti-regressão do Card 1.11.
    expect(PRO_LIMITS.unificationsPerMonth).toBe(30)
    expect(PRO_LIMITS.unificationsPerMonth).not.toBe(40)
  })

  it('maxInputFiles = 15', () => {
    expect(PRO_LIMITS.maxInputFiles).toBe(15)
  })

  it('maxRows = 5.000', () => {
    expect(PRO_LIMITS.maxRows).toBe(5_000)
  })

  it('maxTotalRows = 75.000', () => {
    expect(PRO_LIMITS.maxTotalRows).toBe(75_000)
  })

  it('maxColumns = 10', () => {
    expect(PRO_LIMITS.maxColumns).toBe(10)
  })

  it('maxFileSize = 2 MB', () => {
    expect(PRO_LIMITS.maxFileSize).toBe(2 * 1024 * 1024)
  })

  it('maxTotalSize = 30 MB', () => {
    expect(PRO_LIMITS.maxTotalSize).toBe(30 * 1024 * 1024)
  })
})

// ===========================================
// Invariantes estruturais
// ===========================================
describe('plan-limits — invariantes estruturais', () => {
  it('PRO: maxRows <= maxTotalRows', () => {
    expect(PRO_LIMITS.maxRows).toBeLessThanOrEqual(PRO_LIMITS.maxTotalRows)
  })

  it('PRO: maxFileSize <= maxTotalSize', () => {
    expect(PRO_LIMITS.maxFileSize).toBeLessThanOrEqual(PRO_LIMITS.maxTotalSize)
  })

  it('PRO: maxInputFiles * maxFileSize == maxTotalSize (alinhamento D.1)', () => {
    expect(PRO_LIMITS.maxInputFiles * PRO_LIMITS.maxFileSize).toBe(
      PRO_LIMITS.maxTotalSize,
    )
  })

  it('FREE: maxRows == maxTotalRows (colapso intencional)', () => {
    expect(FREE_LIMITS.maxRows).toBe(FREE_LIMITS.maxTotalRows)
  })

  it('FREE: maxFileSize == maxTotalSize (colapso intencional — soma total)', () => {
    expect(FREE_LIMITS.maxFileSize).toBe(FREE_LIMITS.maxTotalSize)
  })

  it('FREE é estritamente mais restritivo que PRO em todos os campos', () => {
    expect(FREE_LIMITS.unificationsPerMonth).toBeLessThan(
      PRO_LIMITS.unificationsPerMonth,
    )
    expect(FREE_LIMITS.maxInputFiles).toBeLessThan(PRO_LIMITS.maxInputFiles)
    expect(FREE_LIMITS.maxRows).toBeLessThan(PRO_LIMITS.maxRows)
    expect(FREE_LIMITS.maxTotalRows).toBeLessThan(PRO_LIMITS.maxTotalRows)
    expect(FREE_LIMITS.maxColumns).toBeLessThan(PRO_LIMITS.maxColumns)
    expect(FREE_LIMITS.maxFileSize).toBeLessThan(PRO_LIMITS.maxFileSize)
    expect(FREE_LIMITS.maxTotalSize).toBeLessThan(PRO_LIMITS.maxTotalSize)
  })
})

// ===========================================
// PLAN_LIMITS map
// ===========================================
describe('plan-limits — PLAN_LIMITS map', () => {
  it('contém entrada PRO', () => {
    expect(PLAN_LIMITS.PRO).toBeDefined()
    expect(PLAN_LIMITS.PRO).toBe(PRO_LIMITS)
  })

  it('PRO no map é a mesma referência de PRO_LIMITS (fonte única)', () => {
    expect(PLAN_LIMITS.PRO).toStrictEqual(PRO_LIMITS)
  })
})

// ===========================================
// getLimitsForPlan — fallback e resolução
// ===========================================
describe('getLimitsForPlan', () => {
  it('retorna FREE_LIMITS quando plan é null', () => {
    const limits = getLimitsForPlan(null)
    expect(limits).toStrictEqual(FREE_LIMITS)
    // Guard: NÃO pode cair no PRO silenciosamente
    expect(limits.unificationsPerMonth).toBe(1)
    expect(limits.unificationsPerMonth).not.toBe(30)
  })

  it('retorna FREE_LIMITS quando plan é undefined', () => {
    const limits = getLimitsForPlan(undefined)
    expect(limits).toStrictEqual(FREE_LIMITS)
  })

  it('retorna PRO_LIMITS quando plan é "PRO"', () => {
    const limits = getLimitsForPlan('PRO')
    expect(limits).toStrictEqual(PRO_LIMITS)
    expect(limits.unificationsPerMonth).toBe(30)
  })

  it('retorna referência (não cópia) — callers não devem mutar', () => {
    // Invariante de performance: retornar ref é OK porque objetos são
    // tratados como readonly por convenção. Esse teste documenta a decisão.
    const a = getLimitsForPlan('PRO')
    const b = getLimitsForPlan('PRO')
    expect(a).toBe(b)
  })

  it('retorna FREE_LIMITS (fallback defensivo) para plano não mapeado', () => {
    // Cenário futuro: enum Plan ganha ENTERPRISE no schema antes de entrar
    // em PLAN_LIMITS. O fallback deve ser FREE, nunca crashar nem virar PRO.
    // TypeScript protege em compile time, mas runtime pode receber valor
    // inesperado via raw query / migration pendente.
    const limits = getLimitsForPlan('ENTERPRISE' as unknown as 'PRO')
    expect(limits).toStrictEqual(FREE_LIMITS)
  })

  it('fallback defensivo: string arbitrária também cai em FREE', () => {
    const limits = getLimitsForPlan('INVALID_PLAN' as unknown as 'PRO')
    expect(limits).toStrictEqual(FREE_LIMITS)
  })

  it('nunca retorna undefined (sempre há fallback)', () => {
    expect(getLimitsForPlan(null)).toBeDefined()
    expect(getLimitsForPlan(undefined)).toBeDefined()
    expect(getLimitsForPlan('PRO')).toBeDefined()
    expect(getLimitsForPlan('FOO' as unknown as 'PRO')).toBeDefined()
  })

  it('emite logger.warn estruturado quando cai no fallback defensivo (drift detection)', () => {
    // MED #3 pós-@security: silent fallback mascara drift entre enum Plan.
    // BAIXO run #2: pino estruturado em vez de console.warn (respeita level).
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    getLimitsForPlan('GHOST_PLAN' as unknown as 'PRO')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'GHOST_PLAN', module: 'plan-limits' }),
      expect.stringContaining('[plan-limits]'),
    )

    warnSpy.mockRestore()
  })

  it('não emite warn no caminho feliz (PRO mapeado)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    getLimitsForPlan('PRO')
    getLimitsForPlan(null)
    getLimitsForPlan(undefined)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
