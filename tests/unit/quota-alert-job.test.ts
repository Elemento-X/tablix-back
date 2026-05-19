/**
 * Unit tests do handler do cron quota-alert — Card #147 (5.2c) F3.
 *
 * Cobre 9 cenários do plano §9.1:
 *   1. 3 users 65/75/95% → 0/1/1 emails
 *   2. Rerun mesmo período → 0 emails (dedupe P2002)
 *   3. Cross-month → emails novos (mock period change)
 *   4. Resend down → INSERT MESMO ASSIM (A-8), warn capturado, job não trava
 *   5. Dry-run → 0 INSERT, 0 emails, emit events com flag
 *   6. User cruza 75% → 95% mesmo mês → 1 critical (warning já dedupado)
 *   7. User a 95% no novo mês → 2 emails novos (period mudou)
 *   8. (integration test cobre concorrência — aqui mockamos)
 *   9. (integration test cobre time-travel — aqui mockamos getCurrentPeriod)
 *
 * + extras:
 *   - heartbeat false → aborta gracefully sem tocar DB
 *   - logs sem PII (assert userId UUID + threshold + period; NÃO email/count cru)
 *   - dedupe P2002 emite event mas não trava
 *   - DB error NÃO-P2002 propaga + recordRunEnd(failure)
 *
 * @owner: @tester
 * @card: #147 F3 — T-3.7
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => {
  return {
    mocks: {
      prismaCronRunCreate: vi.fn(),
      prismaCronRunUpdate: vi.fn(),
      prismaUserFindMany: vi.fn(),
      prismaQuotaAlertCreate: vi.fn(),
      prismaExecuteRawUnsafe: vi.fn(),
      getCurrentUsage: vi.fn(),
      getCurrentPeriod: vi.fn(),
      getNextResetAt: vi.fn(),
      sendQuotaWarningEmail: vi.fn(),
      sendQuotaCriticalEmail: vi.fn(),
      emitSchedulerEvent: vi.fn(),
      setUsersAboveThreshold: vi.fn(),
      loggerInfo: vi.fn(),
      loggerWarn: vi.fn(),
      loggerError: vi.fn(),
      envMock: {
        CRON_DRY_RUN: false,
      },
    },
  }
})

vi.mock('../../src/lib/prisma', () => {
  // tx-like object passed to $transaction callback. Reusa os MESMOS mocks do
  // root prisma client — handler chama tx.user.findMany e tx.$executeRawUnsafe
  // dentro do $transaction de selectActiveProUsers (Card #147 fix-pack ciclo 1
  // @dba MÉDIO).
  const tx = {
    user: { findMany: mocks.prismaUserFindMany },
    $executeRawUnsafe: mocks.prismaExecuteRawUnsafe,
  }
  return {
    prisma: {
      cronRun: {
        create: mocks.prismaCronRunCreate,
        update: mocks.prismaCronRunUpdate,
      },
      user: {
        findMany: mocks.prismaUserFindMany,
      },
      quotaAlertSent: {
        create: mocks.prismaQuotaAlertCreate,
      },
      $transaction: vi.fn(
        async <T>(cb: (txArg: typeof tx) => Promise<T>): Promise<T> => cb(tx),
      ),
    },
  }
})
vi.mock('../../src/lib/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}))
vi.mock('../../src/config/env', () => ({ env: mocks.envMock }))
vi.mock('../../src/config/plan-limits', () => ({
  PRO_LIMITS: { unificationsPerMonth: 30 },
}))
vi.mock('../../src/modules/usage/usage.service', () => ({
  getCurrentUsage: mocks.getCurrentUsage,
  getCurrentPeriod: mocks.getCurrentPeriod,
  getNextResetAt: mocks.getNextResetAt,
}))
vi.mock('../../src/lib/email', () => ({
  sendQuotaWarningEmail: mocks.sendQuotaWarningEmail,
  sendQuotaCriticalEmail: mocks.sendQuotaCriticalEmail,
}))
vi.mock('../../src/scheduler/metrics', () => ({
  setUsersAboveThreshold: mocks.setUsersAboveThreshold,
}))
vi.mock('../../src/scheduler/observability', () => ({
  emitSchedulerEvent: mocks.emitSchedulerEvent,
}))
// Card #147 fix-pack ciclo 1 (@tester ALTO F2): mock sleep pra resolver
// imediatamente em testes. Sem isso, cada email enviado aguarda 100ms wall-
// clock real (RESEND_SLEEP_MS), tornando testes lentos e não-determinísticos
// sob CI shard com workers paralelos.
vi.mock('../../src/lib/sleep', () => ({
  sleep: vi.fn(async () => undefined),
}))

// Mock Prisma error class — P2002 unique violation
// Construtor aceita opts compatíveis com KnownErrorParams real (code +
// clientVersion no mínimo) pra TS narrowing funcionar igual em prod.
vi.mock('@prisma/client', () => {
  class PrismaClientKnownRequestError extends Error {
    code: string
    clientVersion: string
    constructor(
      message: string,
      opts: { code: string; clientVersion?: string },
    ) {
      super(message)
      this.code = opts.code
      this.clientVersion = opts.clientVersion ?? '0.0.0-test'
      this.name = 'PrismaClientKnownRequestError'
    }
  }
  return {
    Prisma: {
      PrismaClientKnownRequestError,
    },
  }
})

/* eslint-disable import/first */
import { Prisma } from '@prisma/client'

import { __testing, scanUsageAndAlert } from '../../src/jobs/quota-alert.job'
import type { LockHandle } from '../../src/scheduler/types'
/* eslint-enable import/first */

// ============================================
// FIXTURES
// ============================================

const USER_65 = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'low@example.com',
}
const USER_75 = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'warning@example.com',
}
const USER_95 = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'critical@example.com',
}

const PERIOD = '2026-05'
const RESET_DATE = new Date('2026-06-01T00:00:00Z')

// Refs separadas pros Mocks (preserva tipo Mock pra .mockResolvedValue);
// LockHandle real recebe via cast (handler só chama heartbeat — release é no-op).
// Card #147 fix-pack ciclo 2.5 (@tester ALTO 9f3a7b2c8e41): import movido
// pra dentro do bloco /* eslint-disable import/first */ acima.

const lockOkHeartbeat = vi.fn(async () => true)
const lockLostHeartbeat = vi.fn(async () => false)
const noopRelease = vi.fn(async () => undefined)

const lockOk: LockHandle = {
  token: 'fake-token-ok',
  jobName: 'quota-alert',
  acquiredAt: new Date(),
  heartbeat: lockOkHeartbeat,
  release: noopRelease,
}

const lockLost: LockHandle = {
  token: 'fake-token-lost',
  jobName: 'quota-alert',
  acquiredAt: new Date(),
  heartbeat: lockLostHeartbeat,
  release: noopRelease,
}

// ============================================
// SETUP
// ============================================

beforeEach(() => {
  // resetAllMocks limpa implementations (mockResolvedValue/mockRejectedValue
  // de testes anteriores). clearAllMocks só limpa .mock.calls — implementações
  // persistiam e causavam cross-test contamination.
  vi.resetAllMocks()
  mocks.envMock.CRON_DRY_RUN = false
  mocks.getCurrentPeriod.mockReturnValue(PERIOD)
  mocks.getNextResetAt.mockReturnValue(RESET_DATE)
  lockOkHeartbeat.mockResolvedValue(true)
  lockLostHeartbeat.mockResolvedValue(false)
  mocks.prismaCronRunCreate.mockResolvedValue(undefined)
  mocks.prismaCronRunUpdate.mockResolvedValue(undefined)
  mocks.prismaUserFindMany.mockResolvedValue([])
  mocks.prismaQuotaAlertCreate.mockResolvedValue(undefined)
  mocks.prismaExecuteRawUnsafe.mockResolvedValue(0)
  mocks.sendQuotaWarningEmail.mockResolvedValue(undefined)
  mocks.sendQuotaCriticalEmail.mockResolvedValue(undefined)
  mocks.getCurrentUsage.mockResolvedValue(0)
})

// ============================================
// CENÁRIOS DO PLANO
// ============================================

describe('Cenário 1 — 3 users 65/75/95% → 0/1/1 emails', () => {
  it('user a 65% NAO recebe email NEM INSERT', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_65])
    mocks.getCurrentUsage.mockResolvedValue(19) // 19/30 = 63.33% < 70%

    await scanUsageAndAlert(lockOk)

    expect(mocks.prismaQuotaAlertCreate).not.toHaveBeenCalled()
    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled()
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
  })

  it('user a 75% (22/30) recebe APENAS email warning', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22) // 22/30 = 73.33% (>=70, <90)

    await scanUsageAndAlert(lockOk)

    expect(mocks.prismaQuotaAlertCreate).toHaveBeenCalledTimes(1)
    expect(mocks.prismaQuotaAlertCreate).toHaveBeenCalledWith({
      data: { userId: USER_75.id, threshold: 70, period: PERIOD },
    })
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
  })

  it('user a 95% (29/30) recebe AMBOS emails (critical e warning, sem dedupe ainda)', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_95])
    mocks.getCurrentUsage.mockResolvedValue(29) // 29/30 = 96.66%

    await scanUsageAndAlert(lockOk)

    // Ambos thresholds disparam: critical (90) E warning (70).
    expect(mocks.prismaQuotaAlertCreate).toHaveBeenCalledTimes(2)
    expect(mocks.sendQuotaCriticalEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
  })

  it('3 users juntos: 0 / 1 warning / 2 emails (critical+warning) = 3 emails total', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_65, USER_75, USER_95])
    mocks.getCurrentUsage.mockImplementation(async (userId: string) => {
      if (userId === USER_65.id) return 19
      if (userId === USER_75.id) return 22
      if (userId === USER_95.id) return 29
      return 0
    })

    await scanUsageAndAlert(lockOk)

    // Total emails: 0 + 1 (warning) + 2 (critical+warning) = 3
    const totalSent =
      mocks.sendQuotaWarningEmail.mock.calls.length +
      mocks.sendQuotaCriticalEmail.mock.calls.length
    expect(totalSent).toBe(3)
  })
})

describe('Cenário 2 — Rerun mesmo período → 0 emails (dedupe P2002)', () => {
  it('P2002 absorve dedupe sem disparar email', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)
    mocks.prismaQuotaAlertCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '0.0.0-test',
      }),
    )

    await scanUsageAndAlert(lockOk)

    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled()
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
    // Emite dedupe_skip event
    expect(mocks.emitSchedulerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.quota_alert.dedupe_skip',
      }),
    )
  })
})

describe('Cenário 3 — Cross-month → emails novos', () => {
  it('period diferente permite reenvio', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)
    mocks.getCurrentPeriod.mockReturnValue('2026-06') // mês novo

    await scanUsageAndAlert(lockOk)

    expect(mocks.prismaQuotaAlertCreate).toHaveBeenCalledWith({
      data: { userId: USER_75.id, threshold: 70, period: '2026-06' },
    })
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
  })
})

describe('Cenário 4 — Resend down → INSERT MESMO ASSIM (A-8)', () => {
  it('Resend lança erro mas INSERT já aconteceu + warn capturado', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)
    mocks.sendQuotaWarningEmail.mockRejectedValue(
      new Error('Resend 503 unavailable'),
    )

    // Job NÃO deve lançar (swallowed)
    await expect(scanUsageAndAlert(lockOk)).resolves.toBeUndefined()

    expect(mocks.prismaQuotaAlertCreate).toHaveBeenCalledTimes(1) // INSERT mesmo assim
    expect(mocks.emitSchedulerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.quota_alert.email_failed',
        level: 'warning',
      }),
    )
  })
})

describe('Cenário 5 — Dry-run → 0 INSERT, 0 emails', () => {
  it('CRON_DRY_RUN=true skip INSERT + email + emit dry_run.start', async () => {
    mocks.envMock.CRON_DRY_RUN = true
    mocks.prismaUserFindMany.mockResolvedValue([USER_75, USER_95])
    mocks.getCurrentUsage.mockImplementation(async (userId: string) => {
      return userId === USER_75.id ? 22 : 29
    })

    await scanUsageAndAlert(lockOk)

    expect(mocks.prismaQuotaAlertCreate).not.toHaveBeenCalled()
    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled()
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
    expect(mocks.emitSchedulerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cron.quota_alert.dry_run.start',
      }),
    )
  })
})

describe('Cenário 6 — Warning dedupado + Critical novo no mesmo mês', () => {
  it('user cruza 75→95% — warning dedupado, critical NOVO', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_95])
    mocks.getCurrentUsage.mockResolvedValue(29)
    // Card #147 fix-pack ciclo 1 (@tester MÉDIO F7): mock baseado em INPUT
    // (data.threshold), não call order. Tests resilientes a refactor de
    // ordem dos THRESHOLDS no handler. Pattern testa estado final, não impl.
    mocks.prismaQuotaAlertCreate.mockImplementation(
      async ({ data }: { data: { threshold: number } }) => {
        if (data.threshold === 70) {
          throw new Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: '0.0.0-test',
          })
        }
        return undefined
      },
    )

    await scanUsageAndAlert(lockOk)

    expect(mocks.sendQuotaCriticalEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled() // dedupado
  })
})

// ============================================
// Card #147 fix-pack ciclo 1 — fixes adicionais
// ============================================

describe('Boundary tests — fronteira exata thresholds (F6 fix-pack)', () => {
  // @tester MÉDIO: fronteiras 70%/90% exatas não testadas anteriormente.
  // Mutação `usagePercent < threshold` → `<= threshold` (off-by-one) NÃO
  // era capturada. Estes tests materializam boundaries.

  it('count=21 (=70.00% exatos via Math.floor) → DISPARA warning', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(21) // floor(21/30*100)=70
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
  })

  it('count=20 (=66% via Math.floor) → NAO dispara nada', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(20) // floor(20/30*100)=66
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled()
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
  })

  it('count=27 (=90.00% exatos via Math.floor) → DISPARA AMBOS', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_95])
    mocks.getCurrentUsage.mockResolvedValue(27) // floor(27/30*100)=90
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaCriticalEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
  })

  it('count=26 (=86% via Math.floor) → apenas warning', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(26) // floor(26/30*100)=86
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1)
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
  })

  it('count > limit (=35, >100%) → DISPARA AMBOS + remaining=0', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_95])
    mocks.getCurrentUsage.mockResolvedValue(35) // floor(35/30*100)=116
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaCriticalEmail).toHaveBeenCalledTimes(1)
    // Email recebe remaining=0 (Math.max(0, 30-35))
    const criticalCall = mocks.sendQuotaCriticalEmail.mock.calls[0][0]
    expect(criticalCall.remaining).toBe(0)
  })

  it('count=0 (user PRO sem usage) → NAO dispara nada (silencioso)', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_65])
    mocks.getCurrentUsage.mockResolvedValue(0)
    await scanUsageAndAlert(lockOk)
    expect(mocks.sendQuotaWarningEmail).not.toHaveBeenCalled()
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled()
    expect(mocks.prismaQuotaAlertCreate).not.toHaveBeenCalled()
  })
})

describe('Heartbeat per-iteration — split-brain defense (fix-pack @security MÉDIO)', () => {
  // @security MÉDIO: heartbeat por iteração espelha pattern retention.job.
  // Sem isso, loop grande podia exceder TTL lock sem detecção em escala.

  it('heartbeat retorna false mid-loop → break gracefully + log warn', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75, USER_95])
    mocks.getCurrentUsage.mockImplementation(async (userId: string) =>
      userId === USER_75.id ? 22 : 29,
    )
    // Heartbeat OK no início (linha 391) + 1ª iteração OK, 2ª iteração false
    let hbCount = 0
    lockOkHeartbeat.mockImplementation(async () => {
      hbCount += 1
      return hbCount < 3 // 1st (entry) + 2nd (1st user) ok; 3rd (2nd user) false
    })

    await scanUsageAndAlert(lockOk)

    // USER_75 (1ª iter) processado; USER_95 (2ª iter) abortado
    expect(mocks.sendQuotaWarningEmail).toHaveBeenCalledTimes(1) // user 75
    expect(mocks.sendQuotaCriticalEmail).not.toHaveBeenCalled() // user 95 NAO chegou
    // Card #147 fix-pack ciclo 2 (@security BAIXO 7a3b9f2d4e81): asserta
    // valor exato de usersProcessedSoFar + usersRemaining. Fórmula anterior
    // sempre retornava users.length (bug observability mascarava count parcial).
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'quota-alert',
        runId: expect.any(String),
        usersProcessedSoFar: 1,
        usersRemaining: 1,
      }),
      'quota-alert.heartbeat_lost_mid_loop_aborting',
    )
  })
})

describe('Cenário 8 (light) — Heartbeat lost → aborta gracefully', () => {
  it('lock.heartbeat=false faz handler retornar sem tocar DB', async () => {
    await scanUsageAndAlert(lockLost)

    expect(mocks.prismaUserFindMany).not.toHaveBeenCalled()
    expect(mocks.prismaCronRunCreate).not.toHaveBeenCalled()
    expect(mocks.prismaQuotaAlertCreate).not.toHaveBeenCalled()
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'quota-alert' }),
      'quota-alert.heartbeat_lost_aborting',
    )
  })
})

// ============================================
// EXTRAS — observability, logs LGPD, DB error
// ============================================

describe('LGPD — logs sem PII', () => {
  it('logger.info contem userId UUID + period mas NAO email cru', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)

    await scanUsageAndAlert(lockOk)

    const infoCall = mocks.loggerInfo.mock.calls.find(
      (c) => c[1] === 'quota-alert.completed',
    )
    expect(infoCall).toBeDefined()
    const ctx = infoCall![0]
    expect(ctx.jobName).toBe('quota-alert')
    expect(ctx.usersScanned).toBe(1)
    expect(ctx.emailsSent).toBe(1)
    // NÃO contem email do user no log de conclusão
    expect(JSON.stringify(ctx)).not.toContain(USER_75.email)
  })

  it('emitSchedulerEvent context contem userId+threshold+period mas NAO email', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)

    await scanUsageAndAlert(lockOk)

    const userAboveCall = mocks.emitSchedulerEvent.mock.calls.find(
      (c) => c[0].event === 'cron.quota_alert.user_above_threshold',
    )
    expect(userAboveCall).toBeDefined()
    const ctx = userAboveCall![0].context
    expect(ctx.userId).toBe(USER_75.id)
    expect(ctx.threshold).toBe(70)
    expect(ctx.period).toBe(PERIOD)
    expect(ctx.usagePercent).toBe(73)
    expect(JSON.stringify(ctx)).not.toContain(USER_75.email)
  })
})

describe('DB error NAO-P2002 → propaga + recordRunEnd(failure)', () => {
  it('erro inesperado faz throw + status=failure', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75])
    mocks.getCurrentUsage.mockResolvedValue(22)
    mocks.prismaQuotaAlertCreate.mockRejectedValue(
      new Error('connection refused'),
    )

    await expect(scanUsageAndAlert(lockOk)).rejects.toThrow(
      'connection refused',
    )

    expect(mocks.prismaCronRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failure' }),
      }),
    )
  })
})

describe('Métricas — gauges atualizados ao fim', () => {
  it('setUsersAboveThreshold(70, count) + (90, count) chamados', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([USER_75, USER_95])
    mocks.getCurrentUsage.mockImplementation(async (userId: string) => {
      return userId === USER_75.id ? 22 : 29
    })

    await scanUsageAndAlert(lockOk)

    // USER_75: hit warning (70%); USER_95: hit warning E critical
    expect(mocks.setUsersAboveThreshold).toHaveBeenCalledWith(70, 2)
    expect(mocks.setUsersAboveThreshold).toHaveBeenCalledWith(90, 1)
  })

  it('gauges atualizados MESMO em dry-run (reflete "agora")', async () => {
    mocks.envMock.CRON_DRY_RUN = true
    mocks.prismaUserFindMany.mockResolvedValue([USER_95])
    mocks.getCurrentUsage.mockResolvedValue(29)

    await scanUsageAndAlert(lockOk)

    expect(mocks.setUsersAboveThreshold).toHaveBeenCalledWith(70, 1)
    expect(mocks.setUsersAboveThreshold).toHaveBeenCalledWith(90, 1)
  })
})

describe('cron_runs lifecycle — recordRunStart/End sempre disparam', () => {
  it('happy path cria run + finaliza com status=success', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([])

    await scanUsageAndAlert(lockOk)

    expect(mocks.prismaCronRunCreate).toHaveBeenCalledTimes(1)
    expect(mocks.prismaCronRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success',
          rowsProcessed: 0,
        }),
      }),
    )
  })

  it('falha de INSERT cron_runs não derruba (degraded)', async () => {
    mocks.prismaCronRunCreate.mockRejectedValue(new Error('redis offline'))
    mocks.prismaUserFindMany.mockResolvedValue([])

    await expect(scanUsageAndAlert(lockOk)).resolves.toBeUndefined()

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.any(Object),
      'quota-alert.cron_runs.insert_failed_degraded',
    )
  })

  // Card #147 fix-pack ciclo 2.5 (@tester BAIXO c1b5e7a93d28):
  // Cobre catch path do recordRunEnd (UPDATE cron_runs falhou). Simétrico
  // ao test acima do INSERT. Sem isso, branch 81.81% ficava abaixo de 85%.
  it('falha de UPDATE cron_runs no terminal não derruba (degraded)', async () => {
    mocks.prismaUserFindMany.mockResolvedValue([])
    mocks.prismaCronRunUpdate.mockRejectedValue(
      new Error('connection terminated'),
    )

    await expect(scanUsageAndAlert(lockOk)).resolves.toBeUndefined()

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.any(Object),
      'quota-alert.cron_runs.update_failed_degraded',
    )
  })
})

describe('sanitizeErrorMessage helper', () => {
  it('cap 100 chars + split em `:` defende contra Prisma SQL leak', () => {
    const longPrismaErr = new Error(
      'Invalid `prisma.quotaAlertSent.create()` invocation: SELECT * FROM users WHERE id="abc-uuid-with-pii-data-very-long-string-that-would-leak"',
    )
    const sanitized = __testing.sanitizeErrorMessage(longPrismaErr)
    expect(sanitized.length).toBeLessThanOrEqual(100)
    expect(sanitized).not.toContain('abc-uuid')
    expect(sanitized).toContain('Invalid')
  })

  it('replace CR/LF/TAB (defesa log injection)', () => {
    const evilErr = new Error('attack\r\nFAKE_LOG_LINE\tinjection')
    const sanitized = __testing.sanitizeErrorMessage(evilErr)
    expect(sanitized).not.toContain('\r')
    expect(sanitized).not.toContain('\n')
    expect(sanitized).not.toContain('\t')
  })

  it('non-Error retorna "unknown error"', () => {
    expect(__testing.sanitizeErrorMessage('string')).toBe('unknown error')
    expect(__testing.sanitizeErrorMessage(null)).toBe('unknown error')
    expect(__testing.sanitizeErrorMessage(undefined)).toBe('unknown error')
  })
})
