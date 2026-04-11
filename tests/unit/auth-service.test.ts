/**
 * Unit tests for src/modules/auth/auth.service.ts
 * Covers: validateProToken, refreshSession, revokeSession, revokeAllSessions,
 *         getUserInfo, safeCompare (indirectly via fingerprint mismatch)
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '../../src/errors/app-error'

// --- vi.hoisted: shared mock state accessible inside vi.mock factories ---
const { prismaMock } = vi.hoisted(() => {
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

  const prismaMock = {
    user: createModelMock(),
    session: createModelMock(),
    token: createModelMock(),
    usage: createModelMock(),
    job: createModelMock(),
    $transaction: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  }

  return { prismaMock }
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
  generateAccessToken: vi.fn().mockReturnValue('fake-access-token'),
  generateRefreshToken: vi.fn().mockReturnValue({
    token: 'fake-refresh-token',
    hash: 'fake-refresh-hash-64chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }),
  hashRefreshToken: vi
    .fn()
    .mockReturnValue('hashed-refresh-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  getRefreshTokenExpiresAt: vi.fn().mockReturnValue(new Date('2026-02-15T12:00:00Z')),
}))

vi.mock('../../src/lib/token-generator', () => ({
  isValidTokenFormat: vi.fn().mockReturnValue(true),
}))

import {
  validateProToken,
  refreshSession,
  revokeSession,
  revokeAllSessions,
  getUserInfo,
} from '../../src/modules/auth/auth.service'
import { isValidTokenFormat } from '../../src/lib/token-generator'

// --- Test data factories ---
const NOW = new Date('2026-01-15T12:00:00Z')
const FUTURE = new Date('2026-06-15T12:00:00Z')
const PAST = new Date('2025-01-01T12:00:00Z')

function buildUser(overrides = {}) {
  return {
    id: 'user-001',
    email: 'test@example.com',
    role: 'PRO' as const,
    stripeCustomerId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function buildToken(overrides = {}) {
  return {
    id: 'token-001',
    userId: 'user-001',
    token: 'tbx_pro_validtokenvalue01234567890123456789012',
    fingerprint: null,
    stripeSubscriptionId: null,
    plan: 'PRO',
    status: 'ACTIVE' as const,
    createdAt: NOW,
    activatedAt: null,
    expiresAt: FUTURE,
    user: buildUser(),
    ...overrides,
  }
}

function buildSession(overrides = {}) {
  return {
    id: 'session-001',
    userId: 'user-001',
    fingerprint: 'fp-abc123',
    userAgent: 'TestAgent/1.0',
    ipAddress: '127.0.0.1',
    refreshTokenHash: 'hashed-refresh-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    createdAt: NOW,
    lastActivityAt: NOW,
    expiresAt: FUTURE,
    revokedAt: null,
    user: buildUser(),
    ...overrides,
  }
}

const SESSION_INFO = {
  fingerprint: 'fp-abc123',
  userAgent: 'TestAgent/1.0',
  ipAddress: '127.0.0.1',
}

describe('auth.service.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // =============================================
  // validateProToken
  // =============================================
  describe('validateProToken', () => {
    it('deve autenticar com token valido e criar sessao', async () => {
      prismaMock.token.findUnique.mockResolvedValue(buildToken())
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.user.update.mockResolvedValue(buildUser())
      prismaMock.session.create.mockResolvedValue(buildSession())

      const result = await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      expect(result.accessToken).toBe('fake-access-token')
      expect(result.refreshToken).toBe('fake-refresh-token')
      expect(result.user.id).toBe('user-001')
      expect(result.user.email).toBe('test@example.com')
      expect(result.user.role).toBe('PRO')
    })

    it('deve rejeitar token com formato invalido', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValueOnce(false)

      await expect(validateProToken('invalid-format', SESSION_INFO)).rejects.toThrow(AppError)
    })

    it('deve rejeitar token inexistente no banco', async () => {
      prismaMock.token.findUnique.mockResolvedValue(null)

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO),
      ).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
        message: 'Token inválido ou expirado',
      })
    })

    it('deve rejeitar token com status EXPIRED', async () => {
      prismaMock.token.findUnique.mockResolvedValue(buildToken({ status: 'EXPIRED' }))

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO),
      ).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
        message: 'Token inválido ou expirado',
      })
    })

    it('deve rejeitar token CANCELLED cujo expiresAt ja passou', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: PAST }),
      )

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO),
      ).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve permitir token CANCELLED ainda dentro do periodo de graca', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: FUTURE }),
      )
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.user.update.mockResolvedValue(buildUser())
      prismaMock.session.create.mockResolvedValue(buildSession())

      const result = await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      expect(result.accessToken).toBeTruthy()
    })

    it('deve rejeitar token CANCELLED com expiresAt null', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: null }),
      )

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO),
      ).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve vincular fingerprint no primeiro uso (fingerprint null)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(buildToken({ fingerprint: null }))
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.user.update.mockResolvedValue(buildUser())
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO)

      expect(prismaMock.token.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fingerprint: 'fp-abc123',
          }),
        }),
      )
    })

    it('deve rejeitar fingerprint diferente (timing-safe via safeCompare)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ fingerprint: 'fp-original-device' }),
      )

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', {
          ...SESSION_INFO,
          fingerprint: 'fp-attacker-device',
        }),
      ).rejects.toMatchObject({
        code: 'TOKEN_ALREADY_USED',
        message: 'Token inválido ou expirado',
      })
    })

    it('deve aceitar mesmo fingerprint (timing-safe via safeCompare)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(buildToken({ fingerprint: 'fp-abc123' }))
      prismaMock.user.update.mockResolvedValue(buildUser())
      prismaMock.session.create.mockResolvedValue(buildSession())

      const result = await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      expect(result.accessToken).toBeTruthy()
      // Should NOT call token.update for fingerprint bind (already bound)
      expect(prismaMock.token.update).not.toHaveBeenCalled()
    })

    it('deve promover user FREE para PRO', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ user: buildUser({ role: 'FREE' }) }),
      )
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.user.update.mockResolvedValue(buildUser({ role: 'PRO' }))
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO)

      expect(prismaMock.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { role: 'PRO' },
        }),
      )
    })

    it('nao deve chamar user.update se role ja e PRO', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({
          fingerprint: 'fp-abc123',
          user: buildUser({ role: 'PRO' }),
        }),
      )
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO)

      expect(prismaMock.user.update).not.toHaveBeenCalled()
    })

    it('deve usar mensagem generica em erros (sem information disclosure)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(null)

      try {
        await validateProToken('tbx_pro_validtokenvalue01234567890123456789012', SESSION_INFO)
        expect.unreachable('Deveria ter lancado erro')
      } catch (err) {
        const appErr = err as AppError
        // Message should be generic — not reveal whether token exists
        expect(appErr.message).toBe('Token inválido ou expirado')
        expect(appErr.message).not.toContain('não encontrado')
        expect(appErr.message).not.toContain('not found')
      }
    })
  })

  // =============================================
  // refreshSession
  // =============================================
  describe('refreshSession', () => {
    it('deve rotacionar refresh token e gerar novo access token', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(buildToken())
      prismaMock.session.updateMany.mockResolvedValue({ count: 1 })

      const result = await refreshSession('old-refresh-token')

      expect(result.accessToken).toBe('fake-access-token')
      expect(result.refreshToken).toBe('fake-refresh-token')
    })

    it('deve rejeitar refresh token invalido (nao encontrado no banco)', async () => {
      prismaMock.session.findUnique.mockResolvedValue(null)

      await expect(refreshSession('invalid-token')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      })
    })

    it('deve rejeitar sessao revogada', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession({ revokedAt: NOW }))

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('revogada'),
      })
    })

    it('deve rejeitar sessao expirada', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession({ expiresAt: PAST }))

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('expirada'),
      })
    })

    it('deve revogar sessao e rejeitar se usuario nao tem token ativo', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.session.update.mockResolvedValue(buildSession({ revokedAt: NOW }))

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })

      expect(prismaMock.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        }),
      )
    })

    it('deve revogar sessao e rejeitar se token CANCELLED expirou', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: PAST }),
      )
      prismaMock.session.update.mockResolvedValue(buildSession({ revokedAt: NOW }))

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve revogar sessao se token CANCELLED com expiresAt null', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: null }),
      )
      prismaMock.session.update.mockResolvedValue(buildSession({ revokedAt: NOW }))

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve usar updateMany com WHERE atomico (previne TOCTOU race)', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(buildToken())
      prismaMock.session.updateMany.mockResolvedValue({ count: 1 })

      await refreshSession('old-refresh-token')

      expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'session-001',
            refreshTokenHash: expect.any(String),
            revokedAt: null,
          }),
        }),
      )
    })

    it('deve rejeitar quando updateMany retorna count 0 (TOCTOU race detectada)', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(buildToken())
      prismaMock.session.updateMany.mockResolvedValue({ count: 0 })

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    })

    it('deve permitir refresh com token CANCELLED dentro do periodo de graca', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: FUTURE }),
      )
      prismaMock.session.updateMany.mockResolvedValue({ count: 1 })

      const result = await refreshSession('some-token')

      expect(result.accessToken).toBeTruthy()
      expect(result.refreshToken).toBeTruthy()
    })
  })

  // =============================================
  // revokeSession
  // =============================================
  describe('revokeSession', () => {
    it('deve setar revokedAt na sessao', async () => {
      prismaMock.session.update.mockResolvedValue(buildSession({ revokedAt: NOW }))

      await revokeSession('session-001')

      expect(prismaMock.session.update).toHaveBeenCalledWith({
        where: { id: 'session-001' },
        data: { revokedAt: expect.any(Date) },
      })
    })

    it('deve propagar erro do Prisma se session nao existe', async () => {
      prismaMock.session.update.mockRejectedValue(new Error('Record not found'))

      await expect(revokeSession('nonexistent')).rejects.toThrow('Record not found')
    })
  })

  // =============================================
  // revokeAllSessions
  // =============================================
  describe('revokeAllSessions', () => {
    it('deve revogar todas sessoes ativas do usuario', async () => {
      prismaMock.session.updateMany.mockResolvedValue({ count: 3 })

      const count = await revokeAllSessions('user-001')

      expect(count).toBe(3)
      expect(prismaMock.session.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-001',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      })
    })

    it('deve retornar 0 se usuario nao tem sessoes ativas', async () => {
      prismaMock.session.updateMany.mockResolvedValue({ count: 0 })

      const count = await revokeAllSessions('user-no-sessions')

      expect(count).toBe(0)
    })
  })

  // =============================================
  // getUserInfo
  // =============================================
  describe('getUserInfo', () => {
    it('deve retornar info do usuario com usage atual', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [{ unificationsCount: 3 }],
      })

      const info = await getUserInfo('user-001')

      expect(info.id).toBe('user-001')
      expect(info.email).toBe('test@example.com')
      expect(info.role).toBe('PRO')
      expect(info.usage.current).toBe(3)
      expect(info.usage.limit).toBe(40) // PRO limit
      expect(info.usage.remaining).toBe(37)
    })

    it('deve retornar usage 0 quando nao tem registro no periodo', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })

      const info = await getUserInfo('user-001')

      expect(info.usage.current).toBe(0)
      expect(info.usage.remaining).toBe(40)
    })

    it('deve retornar limite FREE (5) para user FREE', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'FREE' }),
        usages: [{ unificationsCount: 2 }],
      })

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(5)
      expect(info.usage.remaining).toBe(3)
    })

    it('deve retornar remaining 0 (nao negativo) quando excede o limite', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'FREE' }),
        usages: [{ unificationsCount: 10 }],
      })

      const info = await getUserInfo('user-001')

      expect(info.usage.remaining).toBe(0)
    })

    it('deve lancar AppError se usuario nao existe', async () => {
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(getUserInfo('nonexistent')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      })
    })

    it('deve incluir periodo no formato YYYY-MM', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })

      const info = await getUserInfo('user-001')

      expect(info.usage.period).toMatch(/^\d{4}-\d{2}$/)
      expect(info.usage.period).toBe('2026-01')
    })
  })
})
