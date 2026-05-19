/**
 * Auth helpers for tests — geração determinística de JWTs válidos e expirados
 * usando TEST_JWT_FAKE_KEY de env-stub. Uso típico: injetar `Authorization:
 * Bearer <token>` em requests supertest para atravessar o middleware de auth
 * sem precisar orquestrar fluxo /auth/validate-token.
 *
 * Todos os tokens são HS256 (alinhado com src/lib/jwt.ts). Nunca usar estas
 * fabricas com JWT_SECRET real — o TEST_JWT_FAKE_KEY é deliberadamente
 * reconhecível para falhar auditoria se vazar em código de produção.
 *
 * @owner: @tester
 */
import jwt from 'jsonwebtoken'
import { TEST_JWT_FAKE_KEY } from './env-stub'

export interface TestJwtPayload {
  sub: string // userId
  sid?: string // sessionId
  role?: 'FREE' | 'PRO'
}

export interface SignTestJwtOptions {
  payload?: Partial<TestJwtPayload>
  expiresIn?: string | number
  secret?: string
}

const DEFAULT_PAYLOAD: TestJwtPayload = {
  sub: 'user_test_default',
  sid: 'session_test_default',
  role: 'FREE',
}

export function signTestJwt(opts: SignTestJwtOptions = {}): string {
  const payload = { ...DEFAULT_PAYLOAD, ...opts.payload }
  const secret = opts.secret ?? TEST_JWT_FAKE_KEY
  const expiresIn = opts.expiresIn ?? '15m'

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  })
}

/**
 * Gera JWT já expirado (útil pra testar rejeição por exp).
 * O secret é o mesmo TEST_JWT_FAKE_KEY; a expiração é backdated em 1h.
 */
export function signExpiredTestJwt(
  payload: Partial<TestJwtPayload> = {},
): string {
  const mergedPayload = { ...DEFAULT_PAYLOAD, ...payload }
  const nowSec = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { ...mergedPayload, iat: nowSec - 3600, exp: nowSec - 1 },
    TEST_JWT_FAKE_KEY,
    { algorithm: 'HS256' },
  )
}

/**
 * Gera JWT assinado com chave DIFERENTE da esperada — valida rejeição por
 * assinatura inválida. Não usar em caminhos felizes.
 */
export function signWrongKeyTestJwt(
  payload: Partial<TestJwtPayload> = {},
): string {
  const mergedPayload = { ...DEFAULT_PAYLOAD, ...payload }
  return jwt.sign(
    mergedPayload,
    'wrong_key_for_signature_mismatch_test_xxxxxx',
    {
      algorithm: 'HS256',
      expiresIn: '15m',
    },
  )
}

/**
 * Atalho: gera header `Authorization` pronto pra supertest.
 * Ex: .set(authHeader({ sub: 'user_123', role: 'PRO' }))
 */
export function authHeader(payload: Partial<TestJwtPayload> = {}): {
  Authorization: string
} {
  return { Authorization: `Bearer ${signTestJwt({ payload })}` }
}
