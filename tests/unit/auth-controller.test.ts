/**
 * Smoke tests for src/http/controllers/auth.controller.ts
 * Garante que cada handler emite o AuditAction correto. Protege contra
 * regressão silenciosa — remover `emitAuditEvent` quebra o teste.
 *
 * Card 2.4 — gap identificado pelo @tester no smart re-run de 2026-04-20.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditAction } from '../../src/lib/audit/audit.types'
import { AppError, ErrorCodes } from '../../src/errors/app-error'
import {
  validateToken,
  refresh,
  logout,
  logoutAll,
} from '../../src/http/controllers/auth.controller'

const {
  emitAuditEventMock,
  validateProTokenMock,
  refreshSessionMock,
  revokeSessionMock,
  revokeAllSessionsMock,
  getUserInfoMock,
} = vi.hoisted(() => ({
  emitAuditEventMock: vi.fn(),
  validateProTokenMock: vi.fn(),
  refreshSessionMock: vi.fn(),
  revokeSessionMock: vi.fn(),
  revokeAllSessionsMock: vi.fn(),
  getUserInfoMock: vi.fn(),
}))

vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: (...args: unknown[]) => emitAuditEventMock(...args),
}))

vi.mock('../../src/modules/auth/auth.service', () => ({
  validateProToken: (...args: unknown[]) => validateProTokenMock(...args),
  refreshSession: (...args: unknown[]) => refreshSessionMock(...args),
  revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
  revokeAllSessions: (...args: unknown[]) => revokeAllSessionsMock(...args),
  getUserInfo: (...args: unknown[]) => getUserInfoMock(...args),
}))

interface FakeReply {
  send: ReturnType<typeof vi.fn>
}

function makeReply(): FakeReply {
  const send = vi.fn().mockImplementation((payload: unknown) => payload)
  return { send }
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    ip: '10.0.0.1',
    headers: { 'user-agent': 'test-agent/1.0' },
    ...overrides,
  } as unknown as Parameters<typeof validateToken>[0]
}

beforeEach(() => {
  emitAuditEventMock.mockReset()
  validateProTokenMock.mockReset()
  refreshSessionMock.mockReset()
  revokeSessionMock.mockReset()
  revokeAllSessionsMock.mockReset()
  getUserInfoMock.mockReset()
})

describe('auth.controller — audit emissions', () => {
  describe('validateToken', () => {
    it('emite TOKEN_VALIDATE_SUCCESS quando token é validado com sucesso', async () => {
      validateProTokenMock.mockResolvedValue({
        accessToken: 'acc',
        refreshToken: 'ref',
        user: {
          id: 'user-123',
          email: 'foo@bar.com',
          role: 'PRO',
          status: 'active',
          activatedAt: null,
          expiresAt: null,
        },
      })

      const req = makeRequest({
        body: { token: 'tbx_pro_' + 'a'.repeat(64), fingerprint: 'fp-1' },
      })
      const reply = makeReply()

      await validateToken(
        req as unknown as Parameters<typeof validateToken>[0],
        reply as unknown as Parameters<typeof validateToken>[1],
      )

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.TOKEN_VALIDATE_SUCCESS)
      expect(call.actor).toBe('user-123')
      expect(call.success).toBe(true)
      expect(call.ip).toBe('10.0.0.1')
      expect(call.userAgent).toBe('test-agent/1.0')
    })

    it('emite TOKEN_VALIDATE_FAILURE quando validateProToken lança AppError', async () => {
      validateProTokenMock.mockRejectedValue(
        new AppError(ErrorCodes.INVALID_TOKEN, 'Token inválido', 401),
      )

      const req = makeRequest({
        body: { token: 'tbx_pro_' + 'a'.repeat(64), fingerprint: 'fp-1' },
      })
      const reply = makeReply()

      await expect(
        validateToken(
          req as unknown as Parameters<typeof validateToken>[0],
          reply as unknown as Parameters<typeof validateToken>[1],
        ),
      ).rejects.toBeInstanceOf(AppError)

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.TOKEN_VALIDATE_FAILURE)
      expect(call.actor).toBeNull()
      expect(call.success).toBe(false)
      expect(call.metadata).toEqual({ reason: ErrorCodes.INVALID_TOKEN })
      // Card #91: ip/userAgent presentes em failure paths (não só em success).
      // Forense de incidente requer rastreamento de quem tentou — derivado
      // das mesmas variáveis que success path; assert previne regressão.
      expect(call.ip).toBe('10.0.0.1')
      expect(call.userAgent).toBe('test-agent/1.0')
    })

    it('TOKEN_VALIDATE_FAILURE usa reason="unknown" quando erro não tem code', async () => {
      validateProTokenMock.mockRejectedValue(new Error('boom'))

      const req = makeRequest({
        body: { token: 'tbx_pro_' + 'a'.repeat(64), fingerprint: 'fp-1' },
      })
      const reply = makeReply()

      await expect(
        validateToken(
          req as unknown as Parameters<typeof validateToken>[0],
          reply as unknown as Parameters<typeof validateToken>[1],
        ),
      ).rejects.toThrow('boom')

      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.metadata).toEqual({ reason: 'unknown' })
    })
  })

  describe('refresh', () => {
    it('emite SESSION_REFRESH quando refresh tem sucesso', async () => {
      refreshSessionMock.mockResolvedValue({
        accessToken: 'acc',
        refreshToken: 'ref',
      })

      const req = makeRequest({
        body: { refreshToken: 'some-refresh-token-with-enough-length-aaaaaa' },
      })
      const reply = makeReply()

      await refresh(
        req as unknown as Parameters<typeof refresh>[0],
        reply as unknown as Parameters<typeof refresh>[1],
      )

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.SESSION_REFRESH)
      expect(call.actor).toBeNull()
      expect(call.success).toBe(true)
    })

    it('emite SESSION_REFRESH_FAILURE quando refreshSession falha', async () => {
      refreshSessionMock.mockRejectedValue(
        new AppError(ErrorCodes.UNAUTHORIZED, 'Refresh expirado', 401),
      )

      const req = makeRequest({
        body: { refreshToken: 'some-refresh-token-with-enough-length-aaaaaa' },
      })
      const reply = makeReply()

      await expect(
        refresh(
          req as unknown as Parameters<typeof refresh>[0],
          reply as unknown as Parameters<typeof refresh>[1],
        ),
      ).rejects.toBeInstanceOf(AppError)

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.SESSION_REFRESH_FAILURE)
      expect(call.success).toBe(false)
      expect(call.metadata).toEqual({ reason: ErrorCodes.UNAUTHORIZED })
      // Card #91: ip/userAgent em failure paths — defesa em profundidade
      // contra regressão na derivação de variáveis de contexto.
      expect(call.ip).toBe('10.0.0.1')
      expect(call.userAgent).toBe('test-agent/1.0')
    })
  })

  describe('logout', () => {
    it('emite LOGOUT quando revokeSession termina', async () => {
      revokeSessionMock.mockResolvedValue(undefined)

      const req = makeRequest({
        user: { userId: 'user-42', sub: 'session-abc' },
      })
      const reply = makeReply()

      await logout(
        req as unknown as Parameters<typeof logout>[0],
        reply as unknown as Parameters<typeof logout>[1],
      )

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.LOGOUT)
      expect(call.actor).toBe('user-42')
      expect(call.success).toBe(true)
      expect(call.metadata).toEqual({ sessionId: 'session-abc' })
    })
  })

  describe('logoutAll', () => {
    it('emite LOGOUT_ALL com sessionsRevoked nos metadados', async () => {
      revokeAllSessionsMock.mockResolvedValue(7)

      const req = makeRequest({
        user: { userId: 'user-99', sub: 'session-xyz' },
      })
      const reply = makeReply()

      await logoutAll(
        req as unknown as Parameters<typeof logoutAll>[0],
        reply as unknown as Parameters<typeof logoutAll>[1],
      )

      expect(emitAuditEventMock).toHaveBeenCalledTimes(1)
      const call = emitAuditEventMock.mock.calls[0][0]
      expect(call.action).toBe(AuditAction.LOGOUT_ALL)
      expect(call.actor).toBe('user-99')
      expect(call.success).toBe(true)
      expect(call.metadata).toEqual({ sessionsRevoked: 7 })
    })
  })
})
