/**
 * Unit tests for src/modules/auth/auth.service.ts
 * Covers: validateProToken, refreshSession, revokeSession, revokeAllSessions,
 *         getUserInfo, safeCompare (indirectly via fingerprint mismatch)
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '../../src/errors/app-error'

import {
  validateProToken,
  refreshSession,
  revokeSession,
  revokeAllSessions,
  getUserInfo,
} from '../../src/modules/auth/auth.service'
import { isValidTokenFormat } from '../../src/lib/token-generator'
import { AuditAction } from '../../src/lib/audit/audit.types'

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
    .mockReturnValue(
      'hashed-refresh-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ),
  getRefreshTokenExpiresAt: vi
    .fn()
    .mockReturnValue(new Date('2026-02-15T12:00:00Z')),
}))

vi.mock('../../src/lib/token-generator', () => ({
  isValidTokenFormat: vi.fn().mockReturnValue(true),
}))

// Mock do audit service — capturamos `emitAuditEvent` para smoke tests que
// asseguram os pontos de emissão forense (Card 2.4). Não reimplementamos o
// serviço aqui; o comportamento real é testado em audit-service.test.ts.
const emitAuditEventMock = vi.fn()
vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: (...args: unknown[]) => emitAuditEventMock(...args),
}))

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
    refreshTokenHash:
      'hashed-refresh-token-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

      await expect(
        validateProToken('invalid-format', SESSION_INFO),
      ).rejects.toThrow(AppError)
    })

    it('deve rejeitar token inexistente no banco', async () => {
      prismaMock.token.findUnique.mockResolvedValue(null)

      await expect(
        validateProToken(
          'tbx_pro_validtokenvalue01234567890123456789012',
          SESSION_INFO,
        ),
      ).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
        message: 'Token inválido ou expirado',
      })
    })

    it('deve rejeitar token com status EXPIRED', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ status: 'EXPIRED' }),
      )

      await expect(
        validateProToken(
          'tbx_pro_validtokenvalue01234567890123456789012',
          SESSION_INFO,
        ),
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
        validateProToken(
          'tbx_pro_validtokenvalue01234567890123456789012',
          SESSION_INFO,
        ),
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
        validateProToken(
          'tbx_pro_validtokenvalue01234567890123456789012',
          SESSION_INFO,
        ),
      ).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve vincular fingerprint no primeiro uso (fingerprint null)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ fingerprint: null }),
      )
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.user.update.mockResolvedValue(buildUser())
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

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
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ fingerprint: 'fp-abc123' }),
      )
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

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

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

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      expect(prismaMock.user.update).not.toHaveBeenCalled()
    })

    it('deve usar mensagem generica em erros (sem information disclosure)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(null)

      try {
        await validateProToken(
          'tbx_pro_validtokenvalue01234567890123456789012',
          SESSION_INFO,
        )
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
      prismaMock.session.findUnique.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('revogada'),
      })
    })

    it('deve rejeitar sessao expirada', async () => {
      prismaMock.session.findUnique.mockResolvedValue(
        buildSession({ expiresAt: PAST }),
      )

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('expirada'),
      })
    })

    it('deve revogar sessao e rejeitar se usuario nao tem token ativo', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(null)
      prismaMock.session.update.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

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
      prismaMock.session.update.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

      await expect(refreshSession('some-token')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_EXPIRED',
      })
    })

    it('deve revogar sessao se token CANCELLED com expiresAt null', async () => {
      prismaMock.session.findUnique.mockResolvedValue(buildSession())
      prismaMock.token.findFirst.mockResolvedValue(
        buildToken({ status: 'CANCELLED', expiresAt: null }),
      )
      prismaMock.session.update.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

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
      prismaMock.session.update.mockResolvedValue(
        buildSession({ revokedAt: NOW }),
      )

      await revokeSession('session-001')

      expect(prismaMock.session.update).toHaveBeenCalledWith({
        where: { id: 'session-001' },
        data: { revokedAt: expect.any(Date) },
      })
    })

    it('deve propagar erro do Prisma se session nao existe', async () => {
      prismaMock.session.update.mockRejectedValue(new Error('Record not found'))

      await expect(revokeSession('nonexistent')).rejects.toThrow(
        'Record not found',
      )
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
    it('deve retornar info do usuario PRO com Token ACTIVE (limite 30 — D.1)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [{ unificationsCount: 3 }],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      const info = await getUserInfo('user-001')

      expect(info.id).toBe('user-001')
      expect(info.email).toBe('test@example.com')
      expect(info.role).toBe('PRO')
      expect(info.usage.current).toBe(3)
      // Regression guard: antes era 40 (bug fonte-dupla), D.1 fixou em 30.
      expect(info.usage.limit).toBe(30)
      expect(info.usage.remaining).toBe(27)
    })

    it('deve consultar Token ACTIVE OU CANCELLED-dentro-do-grace-period', async () => {
      // Pós-@security: CANCELLED só conta se `expiresAt > now` (grace period).
      // Mirror do refreshSession — sem assimetria entre endpoints.
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      await getUserInfo('user-001')

      const call = prismaMock.token.findFirst.mock.calls[0]?.[0]
      expect(call).toBeDefined()
      expect(call.where.userId).toBe('user-001')
      expect(call.where.OR).toEqual([
        { status: 'ACTIVE' },
        { status: 'CANCELLED', expiresAt: { gt: expect.any(Date) } },
      ])
      expect(call.orderBy).toEqual({ createdAt: 'desc' })
      expect(call.select).toEqual({ plan: true })
    })

    it('CANCELLED sem expiresAt ou com expiresAt expirado vira fallback FREE', async () => {
      // Regression guard: se o filtro OR for mutado pra aceitar CANCELLED sem
      // checar expiresAt, ex-PRO manteria privilégios indefinidamente.
      // O teste simula o Prisma respondendo null (porque o filtro OR
      // não matchou nenhum Token — CANCELLED fora do grace period).
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'PRO' }),
        usages: [{ unificationsCount: 0 }],
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(1) // FREE fallback
    })

    it('deve retornar limites PRO tambem para Token CANCELLED (periodo de graca)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [{ unificationsCount: 5 }],
      })
      // Token CANCELLED ainda dentro do periodo de graca — findFirst retorna ele
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(30)
      expect(info.usage.remaining).toBe(25)
    })

    it('deve retornar usage 0 quando nao tem registro no periodo (PRO)', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      const info = await getUserInfo('user-001')

      expect(info.usage.current).toBe(0)
      expect(info.usage.remaining).toBe(30)
    })

    it('deve aplicar fallback FREE (limite 1) quando nao ha Token ativo', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'FREE' }),
        usages: [{ unificationsCount: 0 }],
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      const info = await getUserInfo('user-001')

      // Regression guard: antes era 5, spec real do front e 1 unificacao/mes.
      expect(info.usage.limit).toBe(1)
      expect(info.usage.remaining).toBe(1)
    })

    it('deve retornar remaining 0 (nao negativo) quando FREE excede o limite', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'FREE' }),
        usages: [{ unificationsCount: 3 }],
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      const info = await getUserInfo('user-001')

      expect(info.usage.remaining).toBe(0)
    })

    it('deve aplicar fallback FREE mesmo se user.role=PRO mas sem Token (estado inconsistente)', async () => {
      // Cenario defensivo: user com role PRO mas sem Token ativo.
      // Fonte da verdade de limites e o Token, nao o role.
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser({ role: 'PRO' }),
        usages: [{ unificationsCount: 0 }],
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(1) // FREE fallback, nao PRO
    })

    it('deve lancar AppError UNAUTHORIZED (generico) se usuario nao existe', async () => {
      // Pós-@security: error discrimination proibida (security.md).
      // Antes retornava "Usuário não encontrado" (oracle), agora retorna
      // 401 UNAUTHORIZED genérico — indistinguível de JWT válido pra user
      // deletado vs JWT inválido.
      prismaMock.user.findUnique.mockResolvedValue(null)

      await expect(getUserInfo('nonexistent')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        statusCode: 401,
      })
    })

    it('mensagem de erro em user inexistente NÃO contém "não encontrado" (anti-oracle)', async () => {
      // Mutation guard + security.md: error discrimination proibida.
      // Se alguém regride pra `Errors.invalidToken('Usuário não encontrado')`
      // ou similar, esse teste quebra. O 401 genérico não pode vazar o motivo.
      prismaMock.user.findUnique.mockResolvedValue(null)

      try {
        await getUserInfo('nonexistent')
        expect.unreachable('Deveria ter lançado')
      } catch (err) {
        const appErr = err as AppError
        expect(appErr.message).not.toContain('não encontrado')
        expect(appErr.message).not.toContain('nao encontrado')
        expect(appErr.message).not.toContain('not found')
        expect(appErr.message).not.toContain('inexistente')
        expect(appErr.message).toBe('Não autorizado')
      }
    })

    it('deve ignorar Tokens EXPIRED (filtro OR só inclui ACTIVE/CANCELLED-grace)', async () => {
      // Cenário: user tem só Token EXPIRED. findFirst deve devolver null
      // por causa do filtro OR. Se alguém mutar o filtro pra incluir EXPIRED,
      // o teste de fallback FREE passaria errado.
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue(null)

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(1)

      // Mutation guard: a query DEVE conter o filtro OR exato, nunca EXPIRED
      const call = prismaMock.token.findFirst.mock.calls[0]?.[0]
      expect(call.where.OR).toBeDefined()
      const statusValues = call.where.OR.map(
        (o: { status: string }) => o.status,
      )
      expect(statusValues).toContain('ACTIVE')
      expect(statusValues).toContain('CANCELLED')
      expect(statusValues).not.toContain('EXPIRED')
    })

    it('deve ordenar Tokens por createdAt desc (retorna o mais recente)', async () => {
      // Cenário: user com múltiplos Tokens. findFirst + orderBy desc
      // deve retornar o mais novo. Mutação `desc → asc` seria bug grave
      // (user renovou assinatura, mas back continua lendo o Token antigo).
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      await getUserInfo('user-001')

      expect(prismaMock.token.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      )
    })

    it('deve usar select: { plan: true } (não vazar dados sensíveis do Token)', async () => {
      // Mutation guard + defense-in-depth: a query só precisa de `plan`.
      // Selecionar o Token inteiro vazaria token string, fingerprint etc.
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      await getUserInfo('user-001')

      expect(prismaMock.token.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { plan: true },
        }),
      )
    })

    it('deve cair em fallback FREE quando Token existe mas plan é null (schema inconsistente)', async () => {
      // Cenário defensivo: coluna `plan` null no banco (bug de migration futura,
      // seed incompleto, linha criada antes do enum existir). getLimitsForPlan
      // trata null como FREE — este teste é o regression guard ponta-a-ponta.
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [{ unificationsCount: 0 }],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: null })

      const info = await getUserInfo('user-001')

      expect(info.usage.limit).toBe(1) // FREE fallback
    })

    it('deve incluir periodo no formato YYYY-MM', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...buildUser(),
        usages: [],
      })
      prismaMock.token.findFirst.mockResolvedValue({ plan: 'PRO' })

      const info = await getUserInfo('user-001')

      expect(info.usage.period).toMatch(/^\d{4}-\d{2}$/)
      expect(info.usage.period).toBe('2026-01')
    })
  })

  // =============================================
  // Smoke tests — pontos de emissão de audit (Card 2.4)
  // =============================================
  // Garantia de que o auth.service chama emitAuditEvent nos momentos
  // corretos, com a AuditAction certa. Não validamos payload completo (isso é
  // escopo do audit-service.test.ts); só o contrato "esse caminho emite esse
  // evento". Protege contra regressão silenciosa — alguém removendo um
  // emitAuditEvent deixa de derrubar nada funcional mas quebra observability.
  describe('audit emissions', () => {
    it('emite FINGERPRINT_BOUND no primeiro uso do token', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ fingerprint: null }),
      )
      prismaMock.token.update.mockResolvedValue(buildToken())
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      const actions = emitAuditEventMock.mock.calls.map(
        (c) => (c[0] as { action: string }).action,
      )
      expect(actions).toContain(AuditAction.FINGERPRINT_BOUND)
    })

    it('emite FINGERPRINT_MISMATCH quando fingerprint apresentado difere', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({ fingerprint: 'fp-original-device' }),
      )

      await expect(
        validateProToken('tbx_pro_validtokenvalue01234567890123456789012', {
          ...SESSION_INFO,
          fingerprint: 'fp-attacker-device',
        }),
      ).rejects.toThrow()

      const call = emitAuditEventMock.mock.calls.find(
        (c) =>
          (c[0] as { action: string }).action ===
          AuditAction.FINGERPRINT_MISMATCH,
      )
      expect(call).toBeDefined()
      // Metadata forense DEVE carregar tokenId pra correlação posterior
      const input = call![0] as {
        metadata?: Record<string, unknown>
        success: boolean
      }
      expect(input.success).toBe(false)
      expect(input.metadata?.tokenId).toBe('token-001')
    })

    it('emite ROLE_CHANGED quando user FREE é promovido a PRO via token', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({
          fingerprint: 'fp-abc123',
          user: buildUser({ role: 'FREE' }),
        }),
      )
      prismaMock.user.update.mockResolvedValue(buildUser({ role: 'PRO' }))
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      const call = emitAuditEventMock.mock.calls.find(
        (c) => (c[0] as { action: string }).action === AuditAction.ROLE_CHANGED,
      )
      expect(call).toBeDefined()
      const input = call![0] as { metadata?: Record<string, unknown> }
      expect(input.metadata).toMatchObject({
        from: 'FREE',
        to: 'PRO',
        reason: 'token_validate',
      })
    })

    it('NÃO emite ROLE_CHANGED quando user já é PRO (idempotência)', async () => {
      prismaMock.token.findUnique.mockResolvedValue(
        buildToken({
          fingerprint: 'fp-abc123',
          user: buildUser({ role: 'PRO' }),
        }),
      )
      prismaMock.session.create.mockResolvedValue(buildSession())

      await validateProToken(
        'tbx_pro_validtokenvalue01234567890123456789012',
        SESSION_INFO,
      )

      const actions = emitAuditEventMock.mock.calls.map(
        (c) => (c[0] as { action: string }).action,
      )
      expect(actions).not.toContain(AuditAction.ROLE_CHANGED)
    })
  })
})
