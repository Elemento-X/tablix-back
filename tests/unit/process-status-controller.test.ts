/**
 * Unit tests do GET /process/status/:jobId (Card 6.5).
 *
 * Mocka o prisma e prova: ownership embutido no WHERE (404 anti-enumeração),
 * DTO por fase (PENDING/COMPLETED/FAILED), outputSize como string (BigInt),
 * downloadUrl como path da rota 6.6 (não signed-URL), Cache-Control private.
 *
 * @owner: @tester
 * @card: 6.5
 */
/* eslint-disable import/first */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../src/errors/app-error'

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock('../../src/lib/prisma', () => ({
  prisma: { job: { findFirst: mocks.findFirst } },
}))

import { processStatus } from '../../src/http/controllers/process-status.controller'
import { processStatusResponseSchema } from '../../src/modules/process/process-status.schema'

const USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
const JOB_ID = '8c7e1234-5678-4abc-89de-f01234567890'
const CREATED_AT = new Date('2026-06-21T10:00:00.000Z')

interface ReplyStub {
  status: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  header: ReturnType<typeof vi.fn>
}
function makeReply(): ReplyStub {
  const reply: ReplyStub = {
    status: vi.fn(() => reply),
    send: vi.fn(() => reply),
    header: vi.fn(() => reply),
  }
  return reply
}
function makeRequest(over: Record<string, unknown> = {}) {
  return {
    user: { userId: USER_ID, role: 'PRO' },
    params: { jobId: JOB_ID },
    ...over,
  } as never
}

function baseJob(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    status: 'PENDING',
    createdAt: CREATED_AT,
    completedAt: null,
    expiresAt: new Date('2026-06-22T10:00:00.000Z'),
    errorMessage: null,
    outputSize: null,
    ...over,
  }
}

beforeEach(() => {
  mocks.findFirst.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('processStatus — auth & validação', () => {
  it('401 sem usuário autenticado', async () => {
    await expect(
      processStatus(makeRequest({ user: undefined }), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHORIZED })
  })

  it('400 jobId não-UUID (não toca o DB)', async () => {
    await expect(
      processStatus(
        makeRequest({ params: { jobId: 'not-a-uuid' } }),
        makeReply() as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR })
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})

describe('processStatus — ownership (404 anti-enumeração)', () => {
  it('busca filtrando por id E userId do JWT', async () => {
    mocks.findFirst.mockResolvedValue(baseJob())
    await processStatus(makeRequest(), makeReply() as never)
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_ID, userId: USER_ID },
      }),
    )
  })

  it('job de outro usuário OU inexistente → 404 (findFirst null)', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await expect(
      processStatus(makeRequest(), makeReply() as never),
    ).rejects.toMatchObject({ code: ErrorCodes.JOB_NOT_FOUND })
  })
})

describe('processStatus — DTO por fase', () => {
  it('PENDING: conditionais null + Cache-Control private', async () => {
    mocks.findFirst.mockResolvedValue(baseJob({ status: 'PENDING' }))
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)

    expect(reply.header).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-cache',
    )
    expect(reply.status).toHaveBeenCalledWith(200)
    const body = reply.send.mock.calls[0][0]
    expect(body).toMatchObject({
      jobId: JOB_ID,
      status: 'PENDING',
      createdAt: CREATED_AT.toISOString(),
      completedAt: null,
      errorMessage: null,
      downloadUrl: null,
      outputSize: null,
    })
  })

  it('COMPLETED: downloadUrl = path da rota 6.6 + outputSize STRING (BigInt)', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'COMPLETED',
        completedAt: new Date('2026-06-21T10:05:00.000Z'),
        outputSize: BigInt(123456),
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body.downloadUrl).toBe(`/process/download/${JOB_ID}`)
    expect(body.outputSize).toBe('123456')
    expect(typeof body.outputSize).toBe('string')
    expect(body.errorMessage).toBeNull()
  })

  it('FAILED: errorMessage preenchido, downloadUrl/outputSize null', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'FAILED',
        completedAt: new Date('2026-06-21T10:02:00.000Z'),
        errorMessage: 'Falha no processamento. Tente novamente mais tarde.',
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body.status).toBe('FAILED')
    expect(body.errorMessage).toContain('Falha no processamento')
    expect(body.downloadUrl).toBeNull()
    expect(body.outputSize).toBeNull()
  })
})

// ============================================================================
// GAPS 6.5 (augment @tester) — fase PROCESSING, mapeamentos null (branches
// descobertos 67/69), precisão BigInt real e conformidade de shape ao schema.
// ============================================================================
describe('processStatus — gaps de fase, shape estável & precisão', () => {
  /**
   * O card pede "status em cada fase". O teste original cobria
   * PENDING/COMPLETED/FAILED mas PROCESSING (estado intermediário do worker,
   * 6.4) ficava de fora. Comportamento esperado: idêntico a PENDING — todos os
   * condicionais `null` (job ainda em execução, sem output nem erro).
   */
  it('PROCESSING: todos os condicionais null (job em execução)', async () => {
    mocks.findFirst.mockResolvedValue(baseJob({ status: 'PROCESSING' }))
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body.status).toBe('PROCESSING')
    expect(body.completedAt).toBeNull()
    expect(body.errorMessage).toBeNull()
    expect(body.downloadUrl).toBeNull()
    expect(body.outputSize).toBeNull()
    // Shape estável: condicionais são null, NUNCA omitidos (api-contract).
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  /**
   * Branch descoberto (controller:67 `expiresAt?.toISOString() ?? null`). O
   * baseJob sempre tinha expiresAt setado, então o ramo null nunca rodava.
   * Um job sem expiresAt definido (ainda não agendado pro cleanup) deve mapear
   * `expiresAt: null` — sem quebrar o shape.
   */
  it('expiresAt null → DTO expiresAt: null (não omitido)', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({ status: 'PENDING', expiresAt: null }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body).toHaveProperty('expiresAt', null)
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  /**
   * Branch descoberto (controller:69 `isFailed ? (job.errorMessage ?? null)`).
   * FAILED com errorMessage null no DB (worker morreu antes de gravar a
   * mensagem) NÃO pode virar `undefined`/omitido — o front faz polling e espera
   * shape estável. Fallback explícito pra null.
   */
  it('FAILED com errorMessage null no DB → DTO errorMessage: null (shape estável)', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'FAILED',
        completedAt: new Date('2026-06-21T10:02:00.000Z'),
        errorMessage: null,
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body).toHaveProperty('errorMessage', null)
    expect(body.downloadUrl).toBeNull()
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  /**
   * Defensivo: COMPLETED mas outputSize null no DB (estado inconsistente —
   * não deveria acontecer, mas o front não pode receber `undefined`). O guard
   * `isCompleted && job.outputSize != null` deve cair no ramo null. Mantém o
   * shape estável mesmo num COMPLETED degenerado.
   */
  it('COMPLETED com outputSize null → outputSize: null, downloadUrl ainda preenchido', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'COMPLETED',
        completedAt: new Date('2026-06-21T10:05:00.000Z'),
        outputSize: null,
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body).toHaveProperty('outputSize', null)
    // downloadUrl independe de outputSize — segue apontando pra rota 6.6.
    expect(body.downloadUrl).toBe(`/process/download/${JOB_ID}`)
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  /**
   * O CORAÇÃO da decisão B-6.5.1: outputSize é STRING porque BIGINT > 2^53-1
   * (Number.MAX_SAFE_INTEGER) perde precisão como JSON number. O teste original
   * usava 123456 (cabe num double e NÃO prova nada sobre precisão). Aqui um
   * valor acima do limite seguro do double prova que a string preserva o dígito
   * exato — se alguém "otimizar" pra Number(), este teste pega.
   */
  it('COMPLETED: outputSize > MAX_SAFE_INTEGER preservado EXATO como string (B-6.5.1)', async () => {
    // 9_007_199_254_740_993 = 2^53 + 1 — o primeiro inteiro que o double NÃO
    // representa (vira 9_007_199_254_740_992). String tem que sair intacta.
    const huge = BigInt('9007199254740993')
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'COMPLETED',
        completedAt: new Date('2026-06-21T10:05:00.000Z'),
        outputSize: huge,
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(body.outputSize).toBe('9007199254740993')
    // A prova da perda de precisão se fosse number: round-trip via double falha.
    expect(String(Number(body.outputSize))).not.toBe(body.outputSize)
    expect(processStatusResponseSchema.safeParse(body).success).toBe(true)
  })

  /**
   * Conformidade de contrato no caminho feliz COMPLETED: o DTO inteiro tem que
   * passar pelo response schema declarado na rota — prova que outputSize bate o
   * regex `^\d+$`, timestamps são ISO datetime e nenhum campo condicional foi
   * omitido (z.object exige a chave; nullable ≠ optional).
   */
  it('COMPLETED: DTO completo conforma ao processStatusResponseSchema', async () => {
    mocks.findFirst.mockResolvedValue(
      baseJob({
        status: 'COMPLETED',
        completedAt: new Date('2026-06-21T10:05:00.000Z'),
        outputSize: BigInt(123456),
      }),
    )
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    const parsed = processStatusResponseSchema.safeParse(body)
    expect(parsed.success).toBe(true)
  })

  /**
   * Anti-leak: o controller faz `select` whitelist e monta DTO manual, mas se
   * um dia trocarem por spread da entidade, campos internos vazariam. O response
   * schema é STRIP por default (Zod remove desconhecidos no parse), então o
   * teste compara as CHAVES brutas do body com a whitelist do contrato.
   */
  it('não vaza campos além da whitelist do contrato', async () => {
    mocks.findFirst.mockResolvedValue(baseJob({ status: 'PENDING' }))
    const reply = makeReply()
    await processStatus(makeRequest(), reply as never)
    const body = reply.send.mock.calls[0][0]
    expect(Object.keys(body).sort()).toEqual(
      [
        'completedAt',
        'createdAt',
        'downloadUrl',
        'errorMessage',
        'expiresAt',
        'jobId',
        'outputSize',
        'status',
      ].sort(),
    )
  })
})
