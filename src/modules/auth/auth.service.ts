import { prisma } from '../../lib/prisma'
import { generateSessionJwt, decodeJwt, JwtPayload } from '../../lib/jwt'
import { isValidTokenFormat } from '../../lib/token-generator'
import { Errors } from '../../errors/app-error'

export interface ValidateTokenResult {
  jwt: string
  user: {
    email: string
    plan: 'PRO'
    status: string
    activatedAt: Date | null
    expiresAt: Date | null
  }
}

export interface RefreshTokenResult {
  jwt: string
}

/**
 * Valida um token Pro e retorna um JWT de sessão
 * - Verifica se o token existe e está ativo
 * - Vincula ao fingerprint no primeiro uso
 * - Gera JWT de sessão
 */
export async function validateProToken(
  token: string,
  fingerprint: string,
): Promise<ValidateTokenResult> {
  // Valida formato do token
  if (!isValidTokenFormat(token)) {
    throw Errors.invalidToken('Formato de token inválido')
  }

  // Busca o token no banco
  const tokenRecord = await prisma.token.findUnique({
    where: { token },
  })

  if (!tokenRecord) {
    throw Errors.invalidToken('Token não encontrado')
  }

  // Verifica status do token
  if (tokenRecord.status === 'EXPIRED') {
    throw Errors.subscriptionExpired('Assinatura expirada')
  }

  if (tokenRecord.status === 'CANCELLED') {
    // Verifica se ainda está no período de graça
    if (!tokenRecord.expiresAt || tokenRecord.expiresAt < new Date()) {
      throw Errors.subscriptionExpired(
        'Assinatura cancelada e período de acesso encerrado',
      )
    }
    // Ainda tem acesso até expirar - continua
  }

  // Verifica vinculação do fingerprint
  if (tokenRecord.fingerprint) {
    // Token já foi usado - verifica se é o mesmo fingerprint
    if (tokenRecord.fingerprint !== fingerprint) {
      throw Errors.tokenAlreadyUsed(
        'Este token já está vinculado a outro dispositivo. ' +
          'Se você é o dono, use o mesmo dispositivo onde ativou pela primeira vez.',
      )
    }
  } else {
    // Primeiro uso - vincula ao fingerprint
    await prisma.token.update({
      where: { id: tokenRecord.id },
      data: {
        fingerprint,
        activatedAt: new Date(),
      },
    })
  }

  // Gera JWT de sessão
  const jwt = generateSessionJwt({
    sub: tokenRecord.id,
    email: tokenRecord.email,
    plan: 'PRO',
    fingerprint,
  })

  return {
    jwt,
    user: {
      email: tokenRecord.email,
      plan: 'PRO',
      status: tokenRecord.status,
      activatedAt: tokenRecord.activatedAt,
      expiresAt: tokenRecord.expiresAt,
    },
  }
}

/**
 * Renova um JWT expirado
 * - Decodifica o JWT antigo (sem verificar expiração)
 * - Verifica se o token Pro ainda está ativo
 * - Gera novo JWT
 */
export async function refreshSession(
  expiredJwt: string,
): Promise<RefreshTokenResult> {
  // Decodifica sem verificar (para pegar o sub mesmo expirado)
  const payload = decodeJwt(expiredJwt)

  if (!payload || !payload.sub) {
    throw Errors.invalidToken('Token de refresh inválido')
  }

  // Busca o token Pro no banco
  const tokenRecord = await prisma.token.findUnique({
    where: { id: payload.sub },
  })

  if (!tokenRecord) {
    throw Errors.invalidToken('Token não encontrado')
  }

  // Verifica se ainda está ativo
  if (tokenRecord.status === 'EXPIRED') {
    throw Errors.subscriptionExpired(
      'Assinatura expirada. Renove para continuar.',
    )
  }

  if (tokenRecord.status === 'CANCELLED') {
    if (!tokenRecord.expiresAt || tokenRecord.expiresAt < new Date()) {
      throw Errors.subscriptionExpired(
        'Assinatura cancelada e período de acesso encerrado',
      )
    }
  }

  // Verifica fingerprint (se tiver no payload)
  if (payload.fingerprint && tokenRecord.fingerprint !== payload.fingerprint) {
    throw Errors.tokenAlreadyUsed('Dispositivo não reconhecido')
  }

  // Gera novo JWT
  const jwt = generateSessionJwt({
    sub: tokenRecord.id,
    email: tokenRecord.email,
    plan: 'PRO',
    fingerprint: tokenRecord.fingerprint,
  })

  return { jwt }
}

/**
 * Retorna informações do usuário a partir do payload JWT
 */
export async function getUserInfo(payload: JwtPayload) {
  const tokenRecord = await prisma.token.findUnique({
    where: { id: payload.sub },
    include: {
      usages: {
        where: {
          period: getCurrentPeriod(),
        },
      },
    },
  })

  if (!tokenRecord) {
    throw Errors.invalidToken('Token não encontrado')
  }

  const currentUsage = tokenRecord.usages[0]?.unificationsCount ?? 0

  return {
    email: tokenRecord.email,
    plan: tokenRecord.plan,
    status: tokenRecord.status,
    activatedAt: tokenRecord.activatedAt,
    expiresAt: tokenRecord.expiresAt,
    usage: {
      period: getCurrentPeriod(),
      unificationsUsed: currentUsage,
      unificationsLimit: 40, // Pro limit
    },
  }
}

/**
 * Retorna o período atual no formato YYYY-MM
 */
function getCurrentPeriod(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}
