import { createHash, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { Errors } from '../errors/app-error'

// Payload do access token (curto, 15min)
export interface AccessTokenPayload {
  sub: string // sessionId
  userId: string
  email: string
  role: 'FREE' | 'PRO'
  iat?: number
  exp?: number
}

// Resultado da verificação do JWT
export interface VerifyResult {
  valid: true
  payload: AccessTokenPayload
}

export interface VerifyError {
  valid: false
  error: 'expired' | 'invalid' | 'malformed'
}

export type VerifyJwtResult = VerifyResult | VerifyError

/**
 * Gera um access token JWT (curto, 15min por default)
 */
export function generateAccessToken(
  payload: Omit<AccessTokenPayload, 'iat' | 'exp'>,
): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TOKEN_EXPIRES_IN,
  } as jwt.SignOptions)
}

/**
 * Gera um refresh token opaco (256 bits de entropia)
 * Retorna o token raw e o hash para armazenar no DB
 */
export function generateRefreshToken(): {
  token: string
  hash: string
} {
  const token = randomBytes(32).toString('base64url')
  const hash = hashRefreshToken(token)
  return { token, hash }
}

/**
 * Gera SHA-256 hex do refresh token para armazenamento seguro
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Verifica e decodifica um access token JWT
 */
export function verifyAccessToken(token: string): VerifyJwtResult {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as AccessTokenPayload
    return { valid: true, payload }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: 'expired' }
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { valid: false, error: 'invalid' }
    }
    return { valid: false, error: 'malformed' }
  }
}

/**
 * Decodifica um JWT sem verificar a assinatura
 * Útil para extrair sub de token expirado no refresh flow
 */
export function decodeJwt(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.decode(token)
    if (decoded && typeof decoded === 'object') {
      return decoded as AccessTokenPayload
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extrai o token Bearer do header Authorization
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  return authHeader.slice(7)
}

/**
 * Verifica access token e lança erro se inválido
 * Versão que lança exceção para uso em middlewares
 */
export function verifyAccessTokenOrThrow(token: string): AccessTokenPayload {
  const result = verifyAccessToken(token)

  if (!result.valid) {
    switch (result.error) {
      case 'expired':
        throw Errors.unauthorized('Sessão expirada. Faça login novamente.')
      case 'invalid':
        throw Errors.invalidToken('Token de sessão inválido')
      case 'malformed':
        throw Errors.invalidToken('Token malformado')
    }
  }

  return result.payload
}

/**
 * Calcula data de expiração do refresh token
 */
export function getRefreshTokenExpiresAt(): Date {
  const expiresIn = env.JWT_REFRESH_TOKEN_EXPIRES_IN
  const match = expiresIn.match(/^(\d+)([smhd])$/)

  if (!match) {
    // Default: 30 dias
    return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }

  const value = parseInt(match[1], 10)
  const unit = match[2]

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }

  return new Date(Date.now() + value * multipliers[unit])
}
