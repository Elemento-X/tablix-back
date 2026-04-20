/**
 * Unit tests for src/middleware/auth.middleware.ts
 * Covers: authMiddleware, optionalAuthMiddleware, requireRole
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '../../src/errors/app-error'

import {
  authMiddleware,
  optionalAuthMiddleware,
  requireRole,
} from '../../src/middleware/auth.middleware'

// --- vi.hoisted: shared mock state accessible inside vi.mock factories ---
const { prismaMock, mockVerifyAccessTokenOrThrow, mockExtractBearerToken } =
  vi.hoisted(() => {
    function createModelMock() {
      return {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
        upsert: vi.fn(),
        count: vi.fn(),
      }
    }

    return {
      prismaMock: {
        user: createModelMock(),
        session: createModelMock(),
        token: createModelMock(),
        usage: createModelMock(),
        job: createModelMock(),
        $transaction: vi.fn(),
        $connect: vi.fn(),
        $disconnect: vi.fn(),
      },
      mockVerifyAccessTokenOrThrow: vi.fn(),
      mockExtractBearerToken: vi.fn(),
    }
  })

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    EMAIL_PROVIDER: 'resend',
    FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
  },
}))

vi.mock('../../src/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('../../src/lib/jwt', () => ({
  extractBearerToken: (...args: unknown[]) => mockExtractBearerToken(...args),
  verifyAccessTokenOrThrow: (...args: unknown[]) =>
    mockVerifyAccessTokenOrThrow(...args),
}))

// --- Helpers ---
const NOW = new Date('2026-01-15T12:00:00Z')
const FUTURE = new Date('2026-06-15T12:00:00Z')
const PAST = new Date('2025-01-01T12:00:00Z')

const VALID_JWT_PAYLOAD = {
  sub: 'session-001',
  userId: 'user-001',
  email: 'test@example.com',
  role: 'PRO' as const,
  iat: 1736942400,
  exp: 1736943300,
}

function buildRequest(overrides = {}) {
  return {
    headers: { authorization: 'Bearer valid-token' },
    user: undefined as unknown,
    ...overrides,
  } as unknown as import('fastify').FastifyRequest
}

function buildReply() {
  return {} as unknown as import('fastify').FastifyReply
}

function buildSession(overrides = {}) {
  return {
    id: 'session-001',
    userId: 'user-001',
    fingerprint: 'fp-abc',
    userAgent: 'TestAgent',
    ipAddress: '127.0.0.1',
    refreshTokenHash: 'hash-placeholder',
    createdAt: NOW,
    lastActivityAt: NOW,
    expiresAt: FUTURE,
    revokedAt: null,
    ...overrides,
  }
}

describe('auth.middleware.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // =============================================
  // authMiddleware
  // =============================================
  describe('authMiddleware', () => {
    it('deve injetar user no request para token valido com sessao ativa', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.session.update.mockResolvedValue(buildSession())

      const request = buildRequest()
      await authMiddleware(request, buildReply())

      expect(request.user).toEqual(VALID_JWT_PAYLOAD)
    })

    it('deve lancar UNAUTHORIZED quando Authorization header ausente', async () => {
      mockExtractBearerToken.mockReturnValue(null)

      const request = buildRequest({ headers: {} })

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
          statusCode: 401,
        },
      )
    })

    it('deve lancar UNAUTHORIZED quando token Bearer ausente no header', async () => {
      mockExtractBearerToken.mockReturnValue(null)

      const request = buildRequest({
        headers: { authorization: 'Basic abc' },
      })

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
        },
      )
    })

    it('deve propagar erro do verifyAccessTokenOrThrow para token invalido', async () => {
      mockExtractBearerToken.mockReturnValue('invalid-token')
      mockVerifyAccessTokenOrThrow.mockImplementation(() => {
        throw new AppError('INVALID_TOKEN', 'Token de sessão inválido', 401)
      })

      const request = buildRequest()

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'INVALID_TOKEN',
        },
      )
    })

    it('deve lancar UNAUTHORIZED quando sessao nao encontrada no DB', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(null)

      const request = buildRequest()

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
          message: expect.stringContaining('não encontrada'),
        },
      )
    })

    it('deve lancar UNAUTHORIZED quando sessao esta revogada', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(
        buildSession({ revokedAt: PAST }),
      )

      const request = buildRequest()

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
          message: expect.stringContaining('revogada'),
        },
      )
    })

    it('deve lancar UNAUTHORIZED quando sessao esta expirada', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(
        buildSession({ expiresAt: PAST }),
      )

      const request = buildRequest()

      await expect(authMiddleware(request, buildReply())).rejects.toMatchObject(
        {
          code: 'UNAUTHORIZED',
          message: expect.stringContaining('expirada'),
        },
      )
    })

    it('deve atualizar lastActivityAt como fire-and-forget (nao bloqueia)', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.session.update.mockResolvedValue(buildSession())

      const request = buildRequest()
      await authMiddleware(request, buildReply())

      // user should be set regardless of update result
      expect(request.user).toBeTruthy()
      expect(prismaMock.session.update).toHaveBeenCalledWith({
        where: { id: 'session-001' },
        data: { lastActivityAt: expect.any(Date) },
      })
    })

    it('deve completar mesmo quando fire-and-forget update falha', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.session.update.mockRejectedValue(new Error('DB down'))

      const request = buildRequest()

      // Should NOT throw — fire-and-forget absorbs the error
      await authMiddleware(request, buildReply())

      expect(request.user).toEqual(VALID_JWT_PAYLOAD)
    })
  })

  // =============================================
  // optionalAuthMiddleware
  // =============================================
  describe('optionalAuthMiddleware', () => {
    it('deve injetar user quando token valido presente', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.session.update.mockResolvedValue(buildSession())

      const request = buildRequest()
      await optionalAuthMiddleware(request, buildReply())

      expect(request.user).toEqual(VALID_JWT_PAYLOAD)
    })

    it('deve retornar sem erro quando nenhum token fornecido', async () => {
      mockExtractBearerToken.mockReturnValue(null)

      const request = buildRequest({ headers: {} })
      await optionalAuthMiddleware(request, buildReply())

      expect(request.user).toBeUndefined()
    })

    it('deve setar user como undefined quando token e invalido (sem throw)', async () => {
      mockExtractBearerToken.mockReturnValue('bad-token')
      mockVerifyAccessTokenOrThrow.mockImplementation(() => {
        throw new AppError('INVALID_TOKEN', 'Token invalido', 401)
      })

      const request = buildRequest()
      await optionalAuthMiddleware(request, buildReply())

      expect(request.user).toBeUndefined()
    })

    it('deve setar user como undefined quando sessao revogada (sem throw)', async () => {
      mockExtractBearerToken.mockReturnValue('valid-token')
      mockVerifyAccessTokenOrThrow.mockReturnValue(VALID_JWT_PAYLOAD)
      prismaMock.session.findUnique.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

      const request = buildRequest()
      await optionalAuthMiddleware(request, buildReply())

      expect(request.user).toBeUndefined()
    })
  })

  // =============================================
  // requireRole
  // =============================================
  describe('requireRole', () => {
    it('deve permitir acesso quando user.role esta na allowlist', async () => {
      const middleware = requireRole('PRO')
      const request = buildRequest()
      request.user = VALID_JWT_PAYLOAD

      // Should not throw
      await middleware(request, buildReply())
    })

    it('deve lancar FORBIDDEN quando user.role nao esta na allowlist', async () => {
      const middleware = requireRole('PRO')
      const request = buildRequest()
      request.user = { ...VALID_JWT_PAYLOAD, role: 'FREE' as const }

      await expect(middleware(request, buildReply())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        statusCode: 403,
      })
    })

    it('deve lancar UNAUTHORIZED quando user nao esta no request', async () => {
      const middleware = requireRole('PRO')
      const request = buildRequest()
      request.user = undefined

      await expect(middleware(request, buildReply())).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        statusCode: 401,
      })
    })

    it('deve aceitar multiplos roles na allowlist', async () => {
      const middleware = requireRole('FREE', 'PRO')
      const request = buildRequest()
      request.user = { ...VALID_JWT_PAYLOAD, role: 'FREE' as const }

      // Should not throw for either role
      await middleware(request, buildReply())
    })

    it('deve rejeitar role que nao esta em nenhuma posicao da allowlist', async () => {
      const middleware = requireRole('PRO')
      const request = buildRequest()
      request.user = { ...VALID_JWT_PAYLOAD, role: 'FREE' as const }

      await expect(middleware(request, buildReply())).rejects.toThrow(AppError)
    })
  })
})
