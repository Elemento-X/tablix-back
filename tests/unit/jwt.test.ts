/**
 * Unit tests for src/lib/jwt.ts
 * Covers: generateAccessToken, verifyAccessToken, verifyAccessTokenOrThrow,
 *         generateRefreshToken, hashRefreshToken, decodeJwt, extractBearerToken,
 *         getRefreshTokenExpiresAt
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { testEnv, TEST_JWT_FAKE_KEY } from '../helpers/env-stub'

// Mock env BEFORE importing jwt module
vi.mock('../../src/config/env', () => ({
  env: {
    ...{
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
  },
}))

// Import AFTER mock
import {
  generateAccessToken,
  verifyAccessToken,
  verifyAccessTokenOrThrow,
  generateRefreshToken,
  hashRefreshToken,
  decodeJwt,
  extractBearerToken,
  getRefreshTokenExpiresAt,
} from '../../src/lib/jwt'
import { AppError } from '../../src/errors/app-error'

const VALID_PAYLOAD = {
  sub: 'session-id-123',
  userId: 'user-id-456',
  email: 'test@example.com',
  role: 'PRO' as const,
}

describe('jwt.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // =============================================
  // generateAccessToken
  // =============================================
  describe('generateAccessToken', () => {
    it('deve gerar um JWT valido com HS256', () => {
      const token = generateAccessToken(VALID_PAYLOAD)

      expect(token).toBeTruthy()
      expect(typeof token).toBe('string')
      expect(token.split('.')).toHaveLength(3)

      // Decode header to verify algorithm
      const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
      expect(header.alg).toBe('HS256')
      expect(header.typ).toBe('JWT')
    })

    it('deve incluir sub, userId, email, role no payload', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const decoded = jwt.decode(token) as Record<string, unknown>

      expect(decoded.sub).toBe(VALID_PAYLOAD.sub)
      expect(decoded.userId).toBe(VALID_PAYLOAD.userId)
      expect(decoded.email).toBe(VALID_PAYLOAD.email)
      expect(decoded.role).toBe(VALID_PAYLOAD.role)
    })

    it('deve definir exp baseado em JWT_ACCESS_TOKEN_EXPIRES_IN (15m)', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const decoded = jwt.decode(token) as Record<string, unknown>
      const iat = decoded.iat as number
      const exp = decoded.exp as number

      // 15 minutes = 900 seconds
      expect(exp - iat).toBe(900)
    })

    it('deve gerar tokens distintos para payloads distintos', () => {
      const token1 = generateAccessToken(VALID_PAYLOAD)
      const token2 = generateAccessToken({
        ...VALID_PAYLOAD,
        userId: 'different-user',
      })

      expect(token1).not.toBe(token2)
    })

    it('deve gerar tokens distintos em timestamps distintos', () => {
      const token1 = generateAccessToken(VALID_PAYLOAD)
      vi.advanceTimersByTime(1000)
      const token2 = generateAccessToken(VALID_PAYLOAD)

      expect(token1).not.toBe(token2)
    })
  })

  // =============================================
  // verifyAccessToken
  // =============================================
  describe('verifyAccessToken', () => {
    it('deve retornar valid:true para token valido', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const result = verifyAccessToken(token)

      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.payload.sub).toBe(VALID_PAYLOAD.sub)
        expect(result.payload.userId).toBe(VALID_PAYLOAD.userId)
        expect(result.payload.email).toBe(VALID_PAYLOAD.email)
        expect(result.payload.role).toBe(VALID_PAYLOAD.role)
      }
    })

    it('deve retornar error:expired para token expirado', () => {
      const token = generateAccessToken(VALID_PAYLOAD)

      // Advance past 15min expiry
      vi.advanceTimersByTime(16 * 60 * 1000)

      const result = verifyAccessToken(token)

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('expired')
      }
    })

    it('deve retornar error:invalid para token com assinatura errada', () => {
      const forgedToken = jwt.sign(VALID_PAYLOAD, 'wrong-key-that-is-long-enough-32chars!!', {
        algorithm: 'HS256',
      })

      const result = verifyAccessToken(forgedToken)

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('invalid')
      }
    })

    it('deve rejeitar token com algorithm none (alg:none attack)', () => {
      // Craft a token with alg: none manually
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify(VALID_PAYLOAD)).toString('base64url')
      const algNoneToken = `${header}.${payload}.`

      const result = verifyAccessToken(algNoneToken)

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('invalid')
      }
    })

    it('deve rejeitar token com algorithm HS384 (fora da allowlist)', () => {
      const hs384Token = jwt.sign(VALID_PAYLOAD, TEST_JWT_FAKE_KEY, {
        algorithm: 'HS384',
      })

      const result = verifyAccessToken(hs384Token)

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('invalid')
      }
    })

    it('deve retornar error:invalid para string completamente invalida', () => {
      const result = verifyAccessToken('not-a-jwt-at-all')

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('invalid')
      }
    })

    it('deve retornar error:invalid para string vazia', () => {
      const result = verifyAccessToken('')

      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('invalid')
      }
    })

    it('deve retornar error:invalid para token com payload manipulado', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const parts = token.split('.')

      // Tamper with payload
      const tamperedPayload = Buffer.from(
        JSON.stringify({ ...VALID_PAYLOAD, role: 'ADMIN' }),
      ).toString('base64url')
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`

      const result = verifyAccessToken(tamperedToken)

      expect(result.valid).toBe(false)
    })
  })

  // =============================================
  // verifyAccessTokenOrThrow
  // =============================================
  describe('verifyAccessTokenOrThrow', () => {
    it('deve retornar payload para token valido', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const payload = verifyAccessTokenOrThrow(token)

      expect(payload.sub).toBe(VALID_PAYLOAD.sub)
      expect(payload.userId).toBe(VALID_PAYLOAD.userId)
    })

    it('deve lancar AppError UNAUTHORIZED para token expirado', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      vi.advanceTimersByTime(16 * 60 * 1000)

      try {
        verifyAccessTokenOrThrow(token)
        expect.unreachable('Deveria ter lancado erro')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        const appErr = err as AppError
        expect(appErr.code).toBe('UNAUTHORIZED')
        expect(appErr.statusCode).toBe(401)
        expect(appErr.message).toContain('expirada')
      }
    })

    it('deve lancar AppError INVALID_TOKEN para token invalido', () => {
      try {
        verifyAccessTokenOrThrow('garbage-token')
        expect.unreachable('Deveria ter lancado erro')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        const appErr = err as AppError
        expect(appErr.code).toBe('INVALID_TOKEN')
        expect(appErr.statusCode).toBe(401)
      }
    })

    it('deve lancar AppError INVALID_TOKEN para alg:none', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify(VALID_PAYLOAD)).toString('base64url')
      const algNoneToken = `${header}.${payload}.`

      expect(() => verifyAccessTokenOrThrow(algNoneToken)).toThrow(AppError)
    })
  })

  // =============================================
  // generateRefreshToken + hashRefreshToken
  // =============================================
  describe('generateRefreshToken', () => {
    it('deve retornar token e hash distintos', () => {
      const result = generateRefreshToken()

      expect(result.token).toBeTruthy()
      expect(result.hash).toBeTruthy()
      expect(result.token).not.toBe(result.hash)
    })

    it('deve gerar token com pelo menos 256 bits de entropia (base64url >= 43 chars)', () => {
      const result = generateRefreshToken()

      // 32 bytes = 43 base64url chars (ceil(32 * 4/3))
      expect(result.token.length).toBeGreaterThanOrEqual(43)
    })

    it('deve gerar hash SHA-256 hex (64 chars)', () => {
      const result = generateRefreshToken()

      expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('deve gerar tokens unicos entre chamadas', () => {
      const results = Array.from({ length: 10 }, () => generateRefreshToken())
      const tokens = results.map((r) => r.token)
      const hashes = results.map((r) => r.hash)

      // All unique
      expect(new Set(tokens).size).toBe(10)
      expect(new Set(hashes).size).toBe(10)
    })
  })

  describe('hashRefreshToken', () => {
    it('deve ser deterministica (mesmo input = mesmo output)', () => {
      const hash1 = hashRefreshToken('test-token-value')
      const hash2 = hashRefreshToken('test-token-value')

      expect(hash1).toBe(hash2)
    })

    it('deve retornar hash hex de 64 caracteres', () => {
      const hash = hashRefreshToken('any-value')

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('deve gerar hashes distintos para inputs distintos', () => {
      const hash1 = hashRefreshToken('token-a')
      const hash2 = hashRefreshToken('token-b')

      expect(hash1).not.toBe(hash2)
    })

    it('deve funcionar com string vazia', () => {
      const hash = hashRefreshToken('')

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('deve funcionar com caracteres unicode', () => {
      const hash = hashRefreshToken('token-com-acentuacao-e-emoji-\u{1F600}')

      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  // =============================================
  // decodeJwt
  // =============================================
  describe('decodeJwt', () => {
    it('deve decodificar token valido sem verificar assinatura', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      const decoded = decodeJwt(token)

      expect(decoded).not.toBeNull()
      expect(decoded?.sub).toBe(VALID_PAYLOAD.sub)
      expect(decoded?.userId).toBe(VALID_PAYLOAD.userId)
    })

    it('deve decodificar token expirado (util para refresh flow)', () => {
      const token = generateAccessToken(VALID_PAYLOAD)
      vi.advanceTimersByTime(60 * 60 * 1000) // 1 hour past expiry

      const decoded = decodeJwt(token)

      expect(decoded).not.toBeNull()
      expect(decoded?.sub).toBe(VALID_PAYLOAD.sub)
    })

    it('deve retornar null para string invalida', () => {
      expect(decodeJwt('not-a-jwt')).toBeNull()
    })

    it('deve retornar null para string vazia', () => {
      expect(decodeJwt('')).toBeNull()
    })

    it('deve decodificar token com assinatura errada (decode nao verifica)', () => {
      const forgedToken = jwt.sign(VALID_PAYLOAD, 'completely-different-key-at-least-32-chars', {
        algorithm: 'HS256',
      })
      const decoded = decodeJwt(forgedToken)

      expect(decoded).not.toBeNull()
      expect(decoded?.sub).toBe(VALID_PAYLOAD.sub)
    })
  })

  // =============================================
  // extractBearerToken
  // =============================================
  describe('extractBearerToken', () => {
    it('deve extrair token de header Bearer valido', () => {
      const result = extractBearerToken('Bearer my-jwt-token')

      expect(result).toBe('my-jwt-token')
    })

    it('deve retornar null para undefined', () => {
      expect(extractBearerToken(undefined)).toBeNull()
    })

    it('deve retornar null para string vazia', () => {
      expect(extractBearerToken('')).toBeNull()
    })

    it('deve retornar null para header sem prefixo Bearer', () => {
      expect(extractBearerToken('Basic abc123')).toBeNull()
    })

    it('deve retornar null para "Bearer" sem espaco (sem token)', () => {
      expect(extractBearerToken('Bearer')).toBeNull()
    })

    it('deve ser case-sensitive (bearer minusculo nao funciona)', () => {
      expect(extractBearerToken('bearer my-token')).toBeNull()
    })

    it('deve retornar token com espacos internos intacto', () => {
      // Edge case: token nao deveria ter espaco, mas extractBearerToken nao valida o conteudo
      const result = extractBearerToken('Bearer token with spaces')

      expect(result).toBe('token with spaces')
    })

    it('deve preservar token longo com caracteres especiais', () => {
      const longToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-_123'
      const result = extractBearerToken(`Bearer ${longToken}`)

      expect(result).toBe(longToken)
    })
  })

  // =============================================
  // getRefreshTokenExpiresAt
  // =============================================
  describe('getRefreshTokenExpiresAt', () => {
    it('deve retornar data 30 dias no futuro para "30d"', () => {
      const expiresAt = getRefreshTokenExpiresAt()

      const expected = new Date('2026-01-15T12:00:00Z')
      expected.setDate(expected.getDate() + 30)

      expect(expiresAt.getTime()).toBe(expected.getTime())
    })

    it('deve retornar Date (nao string, nao number)', () => {
      const result = getRefreshTokenExpiresAt()

      expect(result).toBeInstanceOf(Date)
    })

    it('deve retornar data no futuro relativa ao momento atual', () => {
      // Advance 5 days
      vi.advanceTimersByTime(5 * 24 * 60 * 60 * 1000)

      const result = getRefreshTokenExpiresAt()
      const now = new Date()

      expect(result.getTime()).toBeGreaterThan(now.getTime())
    })
  })
})
