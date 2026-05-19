/**
 * History controller tests — Card #145 (5.2a) F3.
 *
 * Cobre helpers do controller (`parseStoragePath` via getOneHistoryHandler)
 * + Idempotency-Key state machine no `deleteAllHistoryHandler` — F3 fix-pack
 * do @tester ALTOs. `requireHistoryOptIn` testado indiretamente via
 * mock do prisma client.
 *
 * Integration completa (auth + rate limit + audit_log_legal AWAIT real)
 * fica deferred pro card discovery.
 *
 * @owner: @tester
 * @card: #145 (5.2a) F3
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'

// Mock prisma + service + idempotency + storage adapter ANTES de importar
// o controller (vitest hoists vi.mock).
vi.mock('../../../../src/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}))
vi.mock('../../../../src/modules/history/history.service', () => ({
  enableHistory: vi.fn(),
  disableHistory: vi.fn(),
  listUserHistory: vi.fn(),
  getOneHistory: vi.fn(),
  softDeleteOne: vi.fn(),
  softDeleteAll: vi.fn(),
  toFileHistoryDto: vi.fn((row) => ({
    id: row.id,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    fileSizeBytes: row.fileSize,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  })),
}))
vi.mock('../../../../src/lib/idempotency/idempotency.service', () => ({
  beginIdempotentOperation: vi.fn(),
  completeIdempotentOperation: vi.fn(),
  releaseIdempotencyKey: vi.fn(),
  hashBody: vi.fn(() => 'fake-hash'),
}))
vi.mock('../../../../src/lib/storage', () => ({
  getStorageAdapter: vi.fn(),
}))

import { prisma } from '../../../../src/lib/prisma'
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  releaseIdempotencyKey,
} from '../../../../src/lib/idempotency/idempotency.service'
import {
  getOneHistory,
  softDeleteAll,
} from '../../../../src/modules/history/history.service'
import { getStorageAdapter } from '../../../../src/lib/storage'
import {
  deleteAllHistoryHandler,
  getOneHistoryHandler,
  getListHistory,
} from '../../../../src/http/controllers/history.controller'

const validUuidV4 = '550e8400-e29b-41d4-a716-446655440000'
const otherUuidV4 = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'

function makeReply(): FastifyReply {
  const reply = {
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    code: vi.fn().mockReturnThis(),
  }
  return reply as unknown as FastifyReply
}

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  const base = {
    user: { userId: validUuidV4, sub: 'session-id', role: 'PRO' },
    headers: {},
    body: {},
    params: {},
    query: {},
    ip: '192.0.2.1',
    id: 'req-123',
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  }
  return { ...base, ...overrides } as unknown as FastifyRequest
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('history.controller — F3', () => {
  // ============================================
  // requireHistoryOptIn (testado via getListHistory)
  // ============================================
  describe('requireHistoryOptIn (gate D#4)', () => {
    it('throws UNAUTHORIZED se request.user é null', async () => {
      const reply = makeReply()
      const request = makeRequest({ user: undefined })
      await expect(getListHistory(request as never, reply)).rejects.toThrow(
        /não autenticado/i,
      )
    })

    it('throws FEATURE_DISABLED se historyOptIn = false', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        historyOptIn: false,
      } as never)
      const reply = makeReply()
      await expect(
        getListHistory(makeRequest() as never, reply),
      ).rejects.toMatchObject({
        code: 'FEATURE_DISABLED',
        statusCode: 403,
      })
    })

    it('throws UNAUTHORIZED se user não existe no DB (defesa em profundidade)', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)
      const reply = makeReply()
      await expect(
        getListHistory(makeRequest() as never, reply),
      ).rejects.toThrow(/sessão inválida/i)
    })
  })

  // ============================================
  // parseStoragePath (testado via getOneHistoryHandler)
  // ============================================
  describe('parseStoragePath (via getOneHistoryHandler)', () => {
    beforeEach(() => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        historyOptIn: true,
      } as never)
      vi.mocked(getStorageAdapter).mockReturnValue({
        getSignedUrlForUser: vi.fn().mockResolvedValue({
          url: 'https://signed.url',
          expiresAt: new Date('2026-05-04T12:01:00Z'),
        }),
      } as never)
    })

    function setupRowWithPath(storagePath: string): void {
      vi.mocked(getOneHistory).mockResolvedValue({
        id: validUuidV4,
        userId: validUuidV4,
        storagePath,
        originalFilename: 'test.csv',
        mimeType: 'text/csv',
        fileSize: 1024,
        expiresAt: new Date('2026-06-03T12:00:00Z'),
        deletedAt: null,
        purgeAttempts: 0,
        createdAt: new Date('2026-05-04T12:00:00Z'),
      } as never)
    }

    it('aceita path válido `{userId}/{date}/{jobId}.{ext}`', async () => {
      const validPath = `${validUuidV4}/2026-05-04/abc1234567.csv`
      setupRowWithPath(validPath)
      const reply = makeReply()
      const request = makeRequest({
        params: { id: validUuidV4 },
      } as never)
      await getOneHistoryHandler(request as never, reply)
      expect(reply.send).toHaveBeenCalled()
    })

    it('rejeita path com 1 segmento (sem date/jobId)', async () => {
      setupRowWithPath('only-one-segment')
      const reply = makeReply()
      const request = makeRequest({
        params: { id: validUuidV4 },
      } as never)
      await expect(
        getOneHistoryHandler(request as never, reply),
      ).rejects.toThrow(/3 segments/)
    })

    it('rejeita path com 2 segmentos', async () => {
      setupRowWithPath(`${validUuidV4}/abc1234567.csv`)
      const reply = makeReply()
      const request = makeRequest({
        params: { id: validUuidV4 },
      } as never)
      await expect(
        getOneHistoryHandler(request as never, reply),
      ).rejects.toThrow(/3 segments/)
    })

    it('rejeita filename sem extensão', async () => {
      setupRowWithPath(`${validUuidV4}/2026-05-04/no-extension`)
      const reply = makeReply()
      const request = makeRequest({
        params: { id: validUuidV4 },
      } as never)
      await expect(
        getOneHistoryHandler(request as never, reply),
      ).rejects.toThrow(/extension/i)
    })

    it('rejeita extensão fora da whitelist (xlsm)', async () => {
      setupRowWithPath(`${validUuidV4}/2026-05-04/abc1234567.xlsm`)
      const reply = makeReply()
      const request = makeRequest({
        params: { id: validUuidV4 },
      } as never)
      await expect(
        getOneHistoryHandler(request as never, reply),
      ).rejects.toThrow(/extension/i)
    })
  })

  // ============================================
  // deleteAllHistoryHandler — Idempotency-Key state machine
  // ============================================
  describe('deleteAllHistoryHandler (D#1 + Idempotency MANDATORY)', () => {
    beforeEach(() => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        historyOptIn: true,
      } as never)
    })

    function makeDeleteAllRequest(
      headers: Record<string, string> = {},
    ): FastifyRequest {
      return makeRequest({
        body: { confirmation: 'CONFIRM_DELETE_ALL' },
        headers: {
          'user-agent': 'test-agent/1.0',
          ...headers,
        },
      } as never)
    }

    it('rejeita 400 se Idempotency-Key header ausente', async () => {
      const reply = makeReply()
      await expect(
        deleteAllHistoryHandler(makeDeleteAllRequest() as never, reply),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      })
    })

    it('rejeita 400 se Idempotency-Key não é UUID v4 lowercase', async () => {
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': 'not-a-uuid',
      })
      await expect(
        deleteAllHistoryHandler(request as never, reply),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    })

    it('rejeita 400 se Idempotency-Key UUID UPPERCASE', async () => {
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': '550E8400-E29B-41D4-A716-446655440000',
      })
      await expect(
        deleteAllHistoryHandler(request as never, reply),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      })
    })

    it('hit: retorna response cached + header Idempotency-Replay', async () => {
      const cached = {
        data: {
          affectedRowCount: 5,
          deletedAt: '2026-05-04T12:00:00.000Z',
          truncated: false,
        },
      }
      vi.mocked(beginIdempotentOperation).mockResolvedValue({
        status: 'hit',
        cached,
      })
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await deleteAllHistoryHandler(request as never, reply)
      expect(reply.header).toHaveBeenCalledWith('Idempotency-Replay', 'true')
      expect(reply.send).toHaveBeenCalledWith(cached)
      expect(softDeleteAll).not.toHaveBeenCalled()
    })

    it('conflict: throws IDEMPOTENCY_CONFLICT (mesma key + body diferente)', async () => {
      vi.mocked(beginIdempotentOperation).mockResolvedValue({
        status: 'conflict',
      })
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await expect(
        deleteAllHistoryHandler(request as never, reply),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
        statusCode: 422,
      })
    })

    it('in_progress: throws IDEMPOTENCY_IN_PROGRESS + header Retry-After', async () => {
      vi.mocked(beginIdempotentOperation).mockResolvedValue({
        status: 'in_progress',
      })
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await expect(
        deleteAllHistoryHandler(request as never, reply),
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        statusCode: 409,
      })
      expect(reply.header).toHaveBeenCalledWith('Retry-After', '5')
    })

    it('miss + degraded: header Idempotency-Degraded + executa', async () => {
      vi.mocked(beginIdempotentOperation).mockResolvedValue({
        status: 'miss',
        degraded: true,
      })
      vi.mocked(softDeleteAll).mockResolvedValue({
        affectedRowCount: 3,
        deletedAt: new Date('2026-05-04T12:00:00.000Z'),
        truncated: false,
      })
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await deleteAllHistoryHandler(request as never, reply)
      expect(reply.header).toHaveBeenCalledWith('Idempotency-Degraded', 'true')
      expect(softDeleteAll).toHaveBeenCalled()
      expect(completeIdempotentOperation).toHaveBeenCalled()
    })

    it('miss: executa softDeleteAll + complete + retorna response', async () => {
      vi.mocked(beginIdempotentOperation).mockResolvedValue({ status: 'miss' })
      vi.mocked(softDeleteAll).mockResolvedValue({
        affectedRowCount: 5,
        deletedAt: new Date('2026-05-04T12:00:00.000Z'),
        truncated: false,
      })
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await deleteAllHistoryHandler(request as never, reply)
      expect(softDeleteAll).toHaveBeenCalledWith({
        userId: validUuidV4,
        ip: '192.0.2.1',
        userAgent: 'test-agent/1.0',
        fingerprint: 'req-123',
      })
      expect(completeIdempotentOperation).toHaveBeenCalled()
      expect(reply.send).toHaveBeenCalledWith({
        data: {
          affectedRowCount: 5,
          deletedAt: '2026-05-04T12:00:00.000Z',
          truncated: false,
        },
      })
    })

    it('falha em softDeleteAll: libera idempotency key + propaga erro', async () => {
      vi.mocked(beginIdempotentOperation).mockResolvedValue({ status: 'miss' })
      const error = new Error('audit_log_legal failed')
      vi.mocked(softDeleteAll).mockRejectedValue(error)
      const reply = makeReply()
      const request = makeDeleteAllRequest({
        'idempotency-key': otherUuidV4,
      })
      await expect(
        deleteAllHistoryHandler(request as never, reply),
      ).rejects.toThrow(/audit_log_legal failed/)
      expect(releaseIdempotencyKey).toHaveBeenCalled()
      expect(completeIdempotentOperation).not.toHaveBeenCalled()
    })
  })
})
