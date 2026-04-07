import { randomBytes } from 'crypto'

const TOKEN_PREFIX = 'tbx_pro_'
const TOKEN_BYTES = 32 // 256 bits de entropia

/**
 * Gera um token Pro único com alta entropia
 * Formato: tbx_pro_{32+ chars aleatórios}
 * Entropia: 256 bits (32 bytes)
 */
export function generateProToken(): string {
  const randomPart = randomBytes(TOKEN_BYTES).toString('base64url')
  return `${TOKEN_PREFIX}${randomPart}`
}

/**
 * Valida o formato de um token Pro
 */
export function isValidTokenFormat(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return false
  }

  const randomPart = token.slice(TOKEN_PREFIX.length)

  // Base64url deve ter pelo menos 43 caracteres para 32 bytes
  if (randomPart.length < 43) {
    return false
  }

  // Valida caracteres base64url (A-Z, a-z, 0-9, -, _)
  const base64urlRegex = /^[A-Za-z0-9_-]+$/
  return base64urlRegex.test(randomPart)
}

/**
 * Extrai informações do token (para debug/logging)
 */
export function getTokenInfo(token: string): {
  prefix: string
  length: number
  valid: boolean
} {
  return {
    prefix: token.slice(0, TOKEN_PREFIX.length),
    length: token.length,
    valid: isValidTokenFormat(token),
  }
}
