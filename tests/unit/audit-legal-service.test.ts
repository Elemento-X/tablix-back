/**
 * Card #150 — Unit tests para src/modules/audit-legal/audit-legal.service.ts
 *
 * Cobre:
 *  - Validacao Zod (todos os campos rejeitados)
 *  - superRefine (errorCode obrigatorio se outcome=failure; proibido se success)
 *  - Persist sucesso retorna AuditLogLegal completo
 *  - P2002 (UNIQUE eventId) → lookup findUnique retorna evento existente (idempotente)
 *  - P2002 race teorica (findUnique retorna null) → throw
 *  - Outros DB errors → throw AppError(LEGAL_AUDIT_PERSIST_FAILED)
 *  - scrubObject aplicado em metadata (SSOT do REDACT_PATHS)
 *  - Cap 1024 bytes em metadata serializado → placeholder
 *  - Truncate defensivo em resourceType/resourceId/legalBasis/errorCode
 *  - stripCrlf em strings (anti log-injection)
 *  - Pino log SEMPRE (com legal:true, SEM userId/resourceId — PII)
 *  - Sentry breadcrumb sempre (level info ou warning)
 *  - Sentry breadcrumb em try/catch (sem DSN nao explode)
 *  - Todos os 7 eventTypes aceitos
 *  - Todos os 3 actors aceitos
 *  - resourceHashAlgo sempre 'sha256v1'
 *  - resourceHash Uint8Array → Buffer pra Prisma
 *
 * @owner: @tester
 * @card: #150
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

// Mock env (ANTES de importar modulos que dependem)
vi.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SENTRY_DSN: '',
    SENTRY_ENVIRONMENT: 'test',
    SENTRY_RELEASE: '',
    SENTRY_TRACES_SAMPLE_RATE: 0,
    SENTRY_PROFILES_SAMPLE_RATE: 0,
    LOG_LEVEL: 'silent',
  },
}))

// Mock Sentry SDK
const addBreadcrumbMock = vi.fn()
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args),
}))
vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({ name: 'ProfilingIntegration' }),
}))

// Mock Prisma
const auditLogLegalCreateMock = vi.fn()
const auditLogLegalFindUniqueMock = vi.fn()
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    auditLogLegal: {
      create: (...args: unknown[]) => auditLogLegalCreateMock(...args),
      findUnique: (...args: unknown[]) => auditLogLegalFindUniqueMock(...args),
    },
  },
}))

// Mock logger
const loggerInfoMock = vi.fn()
const loggerErrorMock = vi.fn()
vi.mock('../../src/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

// SUT (importado depois dos mocks). vi.mock eh auto-hoistado pelo Vitest.
/* eslint-disable import/first */
import { Prisma as PrismaNs } from '@prisma/client'

import { AppError, ErrorCodes } from '../../src/errors/app-error'
import {
  __testing,
  recordLegalEvent,
} from '../../src/modules/audit-legal/audit-legal.service'
import {
  LegalActor,
  LegalEventType,
  LegalOutcome,
  RESOURCE_HASH_ALGO_V1,
  type LegalEventInput,
} from '../../src/modules/audit-legal/audit-legal.types'
/* eslint-enable import/first */

const { prepareMetadata, stripCrlf } = __testing

// Helper: input válido base — clonado por cada teste com overrides.
function validInput(overrides: Partial<LegalEventInput> = {}): LegalEventInput {
  return {
    eventId: '11111111-1111-4111-8111-111111111111',
    eventType: LegalEventType.PURGE_COMPLETED,
    userId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'file_history',
    resourceId: 'res_abc_123',
    legalBasis: 'retention_expired',
    actor: LegalActor.CRON_PURGE_WORKER,
    outcome: LegalOutcome.SUCCESS,
    ...overrides,
  } as LegalEventInput
}

// Resposta padrão de mock de create (estrutura mínima)
function persistedRow(input: LegalEventInput) {
  return {
    id: 'cuid-mock',
    eventId: input.eventId,
    eventType: input.eventType,
    timestamp: new Date('2026-04-28T00:00:00Z'),
    userId: input.userId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    legalBasis: input.legalBasis,
    actor: input.actor,
    expiresAtOriginal: input.expiresAtOriginal ?? null,
    resourceHash: input.resourceHash ? Buffer.from(input.resourceHash) : null,
    resourceHashAlgo: RESOURCE_HASH_ALGO_V1,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? null,
  }
}

beforeEach(() => {
  addBreadcrumbMock.mockReset()
  auditLogLegalCreateMock.mockReset()
  auditLogLegalFindUniqueMock.mockReset()
  loggerInfoMock.mockReset()
  loggerErrorMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// HELPERS internos
// ============================================================================

describe('helpers internos (__testing)', () => {
  it('stripCrlf remove CR, LF, NUL', () => {
    expect(stripCrlf('a\rb\nc\0d')).toBe('abcd')
  })

  it('prepareMetadata retorna undefined quando raw eh undefined', () => {
    expect(prepareMetadata(undefined)).toBeUndefined()
  })

  it('prepareMetadata retorna placeholder quando excede 1024 bytes', () => {
    const huge = { big: 'x'.repeat(2000) }
    const result = prepareMetadata(huge) as Record<string, unknown>
    expect(result._truncated).toBe(true)
    expect(result._limitBytes).toBe(1024)
    expect(typeof result._originalBytes).toBe('number')
    expect(result._originalBytes).toBeGreaterThan(1024)
  })

  it('prepareMetadata aplica scrubObject em campos sensiveis', () => {
    const result = prepareMetadata({
      cpf: '12345678900',
      authorization: 'Bearer xyz',
      keep: 'visible',
    }) as Record<string, unknown>
    // scrubObject SSOT: campos com nomes sensiveis viram [REDACTED]
    expect(result.keep).toBe('visible')
    // 'cpf' eh PII LGPD — deve estar mascarado
    expect(result.cpf).not.toBe('12345678900')
    expect(result.authorization).not.toBe('Bearer xyz')
  })
})

// ============================================================================
// ZOD VALIDATION (rejeicao de input invalido)
// ============================================================================

describe('recordLegalEvent — validacao Zod', () => {
  it('rejeita eventId nao-UUID', async () => {
    await expect(
      recordLegalEvent(validInput({ eventId: 'nao-eh-uuid' })),
    ).rejects.toBeInstanceOf(ZodError)
    expect(auditLogLegalCreateMock).not.toHaveBeenCalled()
  })

  it('rejeita eventType fora da whitelist', async () => {
    await expect(
      recordLegalEvent(validInput({ eventType: 'invalid_event' as never })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita actor fora da whitelist', async () => {
    await expect(
      recordLegalEvent(validInput({ actor: 'hacker' as never })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita outcome fora da whitelist', async () => {
    await expect(
      recordLegalEvent(validInput({ outcome: 'unknown' as never })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita userId nao-UUID', async () => {
    await expect(
      recordLegalEvent(validInput({ userId: 'nope' })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita resourceType muito curto', async () => {
    await expect(
      recordLegalEvent(validInput({ resourceType: 'ab' })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita resourceId vazio', async () => {
    await expect(
      recordLegalEvent(validInput({ resourceId: '' })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita legalBasis com letra maiuscula (regex)', async () => {
    await expect(
      recordLegalEvent(validInput({ legalBasis: 'RetentionExpired' })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita legalBasis com numero', async () => {
    await expect(
      recordLegalEvent(validInput({ legalBasis: 'art_18_lgpd' })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('rejeita resourceHash com tamanho diferente de 32 bytes', async () => {
    await expect(
      recordLegalEvent(validInput({ resourceHash: new Uint8Array(16) })),
    ).rejects.toBeInstanceOf(ZodError)

    await expect(
      recordLegalEvent(validInput({ resourceHash: new Uint8Array(64) })),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('aceita resourceHash de exatamente 32 bytes', async () => {
    const input = validInput({ resourceHash: new Uint8Array(32) })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))
    await expect(recordLegalEvent(input)).resolves.toBeDefined()
  })

  it('superRefine: errorCode obrigatorio quando outcome=failure', async () => {
    await expect(
      recordLegalEvent(
        validInput({
          outcome: LegalOutcome.FAILURE,
          // errorCode ausente
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('superRefine: errorCode proibido quando outcome=success', async () => {
    await expect(
      recordLegalEvent(
        validInput({
          outcome: LegalOutcome.SUCCESS,
          errorCode: 'ERR_X',
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('aceita outcome=failure com errorCode', async () => {
    const input = validInput({
      outcome: LegalOutcome.FAILURE,
      errorCode: 'ERR_STORAGE_TIMEOUT',
    })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))
    await expect(recordLegalEvent(input)).resolves.toBeDefined()
  })
})

// ============================================================================
// PERSISTENCIA (sucesso, idempotencia, falhas)
// ============================================================================

describe('recordLegalEvent — persistencia', () => {
  it('persist sucesso retorna AuditLogLegal completo', async () => {
    const input = validInput()
    const row = persistedRow(input)
    auditLogLegalCreateMock.mockResolvedValueOnce(row)

    const result = await recordLegalEvent(input)

    expect(result).toBe(row)
    expect(auditLogLegalCreateMock).toHaveBeenCalledTimes(1)

    // Verifica que os campos foram passados corretamente
    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(createArgs.data.eventId).toBe(input.eventId)
    expect(createArgs.data.eventType).toBe(input.eventType)
    expect(createArgs.data.resourceHashAlgo).toBe(RESOURCE_HASH_ALGO_V1)
  })

  it('passa resourceHash como Buffer pra Prisma', async () => {
    const hash = new Uint8Array(32).fill(7)
    const input = validInput({ resourceHash: hash })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(Buffer.isBuffer(createArgs.data.resourceHash)).toBe(true)
    expect((createArgs.data.resourceHash as Buffer).byteLength).toBe(32)
  })

  it('resourceHash null se nao fornecido', async () => {
    const input = validInput()
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(createArgs.data.resourceHash).toBeNull()
  })

  it('idempotency: P2002 dispara findUnique e retorna evento existente', async () => {
    const input = validInput()
    const existing = persistedRow(input)

    const p2002 = new PrismaNs.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '6.x', meta: { target: ['event_id'] } },
    )
    auditLogLegalCreateMock.mockRejectedValueOnce(p2002)
    auditLogLegalFindUniqueMock.mockResolvedValueOnce(existing)

    const result = await recordLegalEvent(input)

    expect(result).toBe(existing)
    expect(auditLogLegalFindUniqueMock).toHaveBeenCalledWith({
      where: { eventId: input.eventId },
    })
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotent: true }),
      'audit_legal_event.idempotent_hit',
    )
  })

  it('P2002 + findUnique null → AppError com details.raceCondition=true (Card #150 fix-pack F-ALTO-02)', async () => {
    const input = validInput()
    const p2002 = new PrismaNs.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: '6.x' },
    )
    auditLogLegalCreateMock.mockRejectedValueOnce(p2002)
    auditLogLegalFindUniqueMock.mockResolvedValueOnce(null)

    let caught: unknown
    try {
      await recordLegalEvent(input)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    const err = caught as AppError
    expect(err.code).toBe(ErrorCodes.LEGAL_AUDIT_PERSIST_FAILED)
    // Discriminator: caller (cron) deve retentar IMEDIATAMENTE (sem backoff exponencial)
    expect(err.details?.raceCondition).toBe(true)
    expect(err.message).toMatch(/race condition/i)
  })

  it('DB error genérico → AppError com details.raceCondition=false', async () => {
    const input = validInput()
    const dbError = new Error('connection refused')
    auditLogLegalCreateMock.mockRejectedValueOnce(dbError)

    let caught: unknown
    try {
      await recordLegalEvent(input)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    const err = caught as AppError
    expect(err.code).toBe(ErrorCodes.LEGAL_AUDIT_PERSIST_FAILED)
    expect(err.statusCode).toBe(500)
    // Discriminator: caller deve aplicar backoff exponencial (não é race)
    expect(err.details?.raceCondition).toBe(false)
    expect(err.message).not.toMatch(/race condition/i)
  })

  it('falha de DB loga error com legal:true + raceCondition (uma única vez)', async () => {
    const input = validInput()
    auditLogLegalCreateMock.mockRejectedValueOnce(new Error('boom'))

    await recordLegalEvent(input).catch(() => {
      /* expected */
    })

    // toHaveBeenCalledTimes garante que não há logs duplicados (F-MED toHaveBeenCalledTimes)
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        legal: true,
        eventId: input.eventId,
        eventType: input.eventType,
        raceCondition: false,
      }),
      'audit_legal.persist_failed',
    )
  })

  it('falha de DB emite Sentry breadcrumb level=error com message audit_legal.persist_failed (F-MED-ERROR-PATH)', async () => {
    const input = validInput()
    auditLogLegalCreateMock.mockRejectedValueOnce(new Error('boom'))

    await recordLegalEvent(input).catch(() => {
      /* expected */
    })

    // Pelo menos 2 breadcrumbs: 1 inicial (info) + 1 no catch (error)
    expect(addBreadcrumbMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const errorBreadcrumb = addBreadcrumbMock.mock.calls.find(
      (call) =>
        (call[0] as { message?: string }).message ===
        'audit_legal.persist_failed',
    )
    expect(errorBreadcrumb).toBeDefined()
    expect((errorBreadcrumb![0] as { level: string }).level).toBe('error')
    expect((errorBreadcrumb![0] as { category: string }).category).toBe(
      'audit-legal',
    )
    expect(
      (errorBreadcrumb![0] as { data: { raceCondition: boolean } }).data
        .raceCondition,
    ).toBe(false)
  })
})

// ============================================================================
// LOG / BREADCRUMB / METADATA
// ============================================================================

describe('recordLegalEvent — observabilidade', () => {
  it('loga audit_legal_event com legal:true SEM PII (userId/resourceId)', async () => {
    const input = validInput()
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        legal: true,
        eventId: input.eventId,
        eventType: input.eventType,
        actor: input.actor,
        outcome: input.outcome,
      }),
      'audit_legal_event',
    )

    const logArg = loggerInfoMock.mock.calls[0][0] as Record<string, unknown>
    // PII NAO deve aparecer no log
    expect(logArg.userId).toBeUndefined()
    expect(logArg.resourceId).toBeUndefined()
    expect(logArg.metadata).toBeUndefined()
  })

  it('emite Sentry breadcrumb level=info quando outcome=success', async () => {
    const input = validInput({ outcome: LegalOutcome.SUCCESS })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'audit-legal',
        level: 'info',
        message: `legal_event:${input.eventType}`,
      }),
    )
  })

  it('emite Sentry breadcrumb level=warning quando outcome=failure', async () => {
    const input = validInput({
      outcome: LegalOutcome.FAILURE,
      errorCode: 'ERR_X',
    })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    expect(addBreadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'audit-legal',
        level: 'warning',
      }),
    )
  })

  it('Sentry.addBreadcrumb falhando NAO interrompe o fluxo', async () => {
    addBreadcrumbMock.mockImplementationOnce(() => {
      throw new Error('Sentry not initialized')
    })
    const input = validInput()
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await expect(recordLegalEvent(input)).resolves.toBeDefined()
  })

  it('metadata grande gera placeholder com cap', async () => {
    const huge = { big: 'x'.repeat(2000) }
    const input = validInput({ metadata: huge })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(
      (createArgs.data.metadata as Record<string, unknown>)._truncated,
    ).toBe(true)
  })

  it('metadata com PII passa por scrubObject antes do persist', async () => {
    const input = validInput({
      metadata: { cpf: '12345678900', keep: 'safe' },
    })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const persistedMeta = auditLogLegalCreateMock.mock.calls[0][0].data
      .metadata as Record<string, unknown>
    expect(persistedMeta.keep).toBe('safe')
    expect(persistedMeta.cpf).not.toBe('12345678900')
  })
})

// ============================================================================
// SANITIZACAO defensiva
// ============================================================================

describe('recordLegalEvent — sanitizacao', () => {
  it('rejeita resourceType acima de 40 chars (Zod)', async () => {
    await expect(
      recordLegalEvent(validInput({ resourceType: 'a'.repeat(50) })),
    ).rejects.toBeInstanceOf(ZodError)
    expect(auditLogLegalCreateMock).not.toHaveBeenCalled()
  })

  it('rejeita resourceId acima de 64 chars (Zod)', async () => {
    await expect(
      recordLegalEvent(validInput({ resourceId: 'a'.repeat(80) })),
    ).rejects.toBeInstanceOf(ZodError)
    expect(auditLogLegalCreateMock).not.toHaveBeenCalled()
  })

  it('strip CRLF do resourceId (anti log-injection)', async () => {
    const input = validInput({ resourceId: 'evil\r\n0\0attack' })
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(createArgs.data.resourceId).toBe('evil0attack')
  })

  it('errorCode null se nao fornecido', async () => {
    const input = validInput()
    auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

    await recordLegalEvent(input)

    const createArgs = auditLogLegalCreateMock.mock.calls[0][0]
    expect(createArgs.data.errorCode).toBeNull()
  })

  it('rejeita errorCode acima de 80 chars (Zod)', async () => {
    await expect(
      recordLegalEvent(
        validInput({
          outcome: LegalOutcome.FAILURE,
          errorCode: 'X'.repeat(150),
        }),
      ),
    ).rejects.toBeInstanceOf(ZodError)
    expect(auditLogLegalCreateMock).not.toHaveBeenCalled()
  })
})

// ============================================================================
// COVERAGE — todos os tipos/actors aceitos
// ============================================================================

describe('recordLegalEvent — todos os event_types aceitos', () => {
  const allEventTypes = Object.values(LegalEventType)

  for (const eventType of allEventTypes) {
    it(`aceita eventType=${eventType} e propaga corretamente pro create`, async () => {
      const isFailureType = eventType === LegalEventType.PURGE_FAILED
      const input = validInput({
        eventType,
        outcome: isFailureType ? LegalOutcome.FAILURE : LegalOutcome.SUCCESS,
        errorCode: isFailureType ? 'ERR' : undefined,
      })
      auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

      await expect(recordLegalEvent(input)).resolves.toBeDefined()
      // F-LOW-eventType-no-loop: garantir que valor chegou EXATAMENTE no create
      const createArgs = auditLogLegalCreateMock.mock.calls[0][0] as {
        data: { eventType: string }
      }
      expect(createArgs.data.eventType).toBe(eventType)
    })
  }
})

describe('recordLegalEvent — todos os actors aceitos', () => {
  const allActors = Object.values(LegalActor)

  for (const actor of allActors) {
    it(`aceita actor=${actor} e propaga corretamente pro create`, async () => {
      const input = validInput({ actor })
      auditLogLegalCreateMock.mockResolvedValueOnce(persistedRow(input))

      await expect(recordLegalEvent(input)).resolves.toBeDefined()
      const createArgs = auditLogLegalCreateMock.mock.calls[0][0] as {
        data: { actor: string }
      }
      expect(createArgs.data.actor).toBe(actor)
    })
  }
})
