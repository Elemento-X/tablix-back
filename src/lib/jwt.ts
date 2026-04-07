import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { Errors } from '../errors/app-error'

// Payload do JWT de sessão
export interface JwtPayload {
  sub: string // tokenId (identificador único do token Pro)
  email: string
  plan: 'PRO'
  fingerprint: string | null
  iat?: number
  exp?: number
}

// Resultado da verificação do JWT
export interface VerifyResult {
  valid: true
  payload: JwtPayload
}

export interface VerifyError {
  valid: false
  error: 'expired' | 'invalid' | 'malformed'
}

export type VerifyJwtResult = VerifyResult | VerifyError

/**
 * Gera um JWT de sessão para o usuário Pro
 */
export function generateSessionJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions)
}

/**
 * Verifica e decodifica um JWT
 * Retorna objeto tipado com resultado ou erro
 */
export function verifyJwt(token: string): VerifyJwtResult {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload
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
 * Útil para refresh tokens (pegar o sub mesmo expirado)
 */
export function decodeJwt(token: string): JwtPayload | null {
  try {
    const decoded = jwt.decode(token)
    if (decoded && typeof decoded === 'object') {
      return decoded as JwtPayload
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
 * Verifica JWT e lança erro se inválido
 * Versão que lança exceção para uso em middlewares
 */
export function verifyJwtOrThrow(token: string): JwtPayload {
  const result = verifyJwt(token)

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
