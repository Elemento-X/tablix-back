import { prisma } from '../../lib/prisma'
import {
  generateAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiresAt,
} from '../../lib/jwt'
import { isValidTokenFormat } from '../../lib/token-generator'
import { getLimitsForPlan } from '../../config/plan-limits'
import { Errors } from '../../errors/app-error'
import { emitAuditEvent } from '../../lib/audit/audit.service'
import { AuditAction } from '../../lib/audit/audit.types'
import { createHmac, timingSafeEqual } from 'crypto'

export interface ValidateTokenResult {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    email: string
    role: 'FREE' | 'PRO'
    status: string
    activatedAt: Date | null
    expiresAt: Date | null
  }
}

export interface RefreshResult {
  accessToken: string
  refreshToken: string
}

export interface SessionInfo {
  fingerprint: string
  userAgent?: string
  ipAddress?: string
}

/**
 * Valida um token Pro e retorna access + refresh tokens
 * - Verifica se o token existe e está ativo
 * - Cria User se não existe (primeiro uso)
 * - Vincula fingerprint no primeiro uso
 * - Cria Session
 * - Gera access token (15min) + refresh token (30d)
 */
export async function validateProToken(
  token: string,
  sessionInfo: SessionInfo,
): Promise<ValidateTokenResult> {
  if (!isValidTokenFormat(token)) {
    throw Errors.invalidToken('Formato de token inválido')
  }

  const tokenRecord = await prisma.token.findUnique({
    where: { token },
    include: { user: true },
  })

  if (!tokenRecord) {
    throw Errors.invalidToken('Token inválido ou expirado')
  }

  if (tokenRecord.status === 'EXPIRED') {
    throw Errors.subscriptionExpired('Token inválido ou expirado')
  }

  if (tokenRecord.status === 'CANCELLED') {
    if (!tokenRecord.expiresAt || tokenRecord.expiresAt < new Date()) {
      throw Errors.subscriptionExpired('Token inválido ou expirado')
    }
  }

  // Verifica vinculação do fingerprint
  if (tokenRecord.fingerprint) {
    // Token já foi usado — verifica se é o mesmo fingerprint (timing-safe)
    const fingerprintMatch = safeCompare(
      tokenRecord.fingerprint,
      sessionInfo.fingerprint,
    )
    if (!fingerprintMatch) {
      // Evento forense dedicado: preserva o motivo real (mismatch) antes do
      // controller logar TOKEN_VALIDATE_FAILURE com reason genérico. Permite
      // ao analista diferenciar compartilhamento de token (FINGERPRINT_MISMATCH)
      // de token inválido/expirado (TOKEN_VALIDATE_FAILURE com code INVALID_TOKEN).
      emitAuditEvent({
        action: AuditAction.FINGERPRINT_MISMATCH,
        actor: tokenRecord.userId,
        ip: sessionInfo.ipAddress ?? null,
        userAgent: sessionInfo.userAgent ?? null,
        success: false,
        metadata: { tokenId: tokenRecord.id },
      })
      throw Errors.tokenAlreadyUsed('Token inválido ou expirado')
    }
  } else {
    // Primeiro uso — vincula fingerprint e ativa
    await prisma.token.update({
      where: { id: tokenRecord.id },
      data: {
        fingerprint: sessionInfo.fingerprint,
        activatedAt: new Date(),
      },
    })

    // Audita o bind: primeiro uso do token, associa device→usuário.
    // Recurring bind mismatch (token já tinha fingerprint) gera
    // TOKEN_VALIDATE_FAILURE no controller, não FINGERPRINT_BOUND aqui.
    emitAuditEvent({
      action: AuditAction.FINGERPRINT_BOUND,
      actor: tokenRecord.userId,
      ip: sessionInfo.ipAddress ?? null,
      userAgent: sessionInfo.userAgent ?? null,
      success: true,
      metadata: { tokenId: tokenRecord.id },
    })
  }

  // User já existe (criado pelo webhook) — atualiza role se necessário
  const user = tokenRecord.user
  if (user.role !== 'PRO') {
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'PRO' },
    })
    // ASVS V7.1: escalada de privilégio auditada no momento da efetivação.
    // Caminho possível se o webhook de checkout não rodou ainda (race) e
    // o user ativou o token diretamente — raro mas possível.
    emitAuditEvent({
      action: AuditAction.ROLE_CHANGED,
      actor: user.id,
      ip: sessionInfo.ipAddress ?? null,
      userAgent: sessionInfo.userAgent ?? null,
      success: true,
      metadata: {
        from: user.role,
        to: 'PRO',
        reason: 'token_validate',
      },
    })
  }

  // Cria sessão
  const refreshTokenData = generateRefreshToken()
  const expiresAt = getRefreshTokenExpiresAt()

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      fingerprint: sessionInfo.fingerprint,
      userAgent: sessionInfo.userAgent,
      ipAddress: sessionInfo.ipAddress,
      refreshTokenHash: refreshTokenData.hash,
      expiresAt,
    },
  })

  const accessToken = generateAccessToken({
    sub: session.id,
    userId: user.id,
    email: user.email,
    role: 'PRO',
  })

  return {
    accessToken,
    refreshToken: refreshTokenData.token,
    user: {
      id: user.id,
      email: user.email,
      role: 'PRO',
      status: tokenRecord.status,
      activatedAt: tokenRecord.activatedAt,
      expiresAt: tokenRecord.expiresAt,
    },
  }
}

/**
 * Renova tokens usando refresh token
 * - Valida refresh token via hash
 * - Verifica session ativa (não revogada, não expirada)
 * - Rotaciona refresh token (invalida anterior, gera novo)
 * - Gera novo access token
 */
export async function refreshSession(
  refreshToken: string,
): Promise<RefreshResult> {
  const hash = hashRefreshToken(refreshToken)

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    include: { user: true },
  })

  if (!session) {
    throw Errors.invalidToken('Refresh token inválido')
  }

  if (session.revokedAt) {
    throw Errors.unauthorized('Sessão revogada. Faça login novamente.')
  }

  if (session.expiresAt < new Date()) {
    throw Errors.unauthorized('Sessão expirada. Faça login novamente.')
  }

  // Verifica se user ainda tem acesso (subscription pode ter expirado).
  // `select` explícito: minimiza exposição de dados sensíveis do Token
  // (defense-in-depth — só precisamos de status/expiresAt aqui).
  const activeToken = await prisma.token.findFirst({
    where: {
      userId: session.userId,
      status: { in: ['ACTIVE', 'CANCELLED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { status: true, expiresAt: true },
  })

  if (!activeToken) {
    // Revoga sessão se não tem token ativo
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    })
    throw Errors.subscriptionExpired('Assinatura expirada')
  }

  // Se CANCELLED, verifica período de graça
  if (activeToken.status === 'CANCELLED') {
    if (!activeToken.expiresAt || activeToken.expiresAt < new Date()) {
      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      })
      throw Errors.subscriptionExpired(
        'Assinatura cancelada e período de acesso encerrado',
      )
    }
  }

  // Rotaciona refresh token atomicamente (WHERE inclui hash atual → previne TOCTOU)
  const newRefreshTokenData = generateRefreshToken()
  const newExpiresAt = getRefreshTokenExpiresAt()

  const rotated = await prisma.session.updateMany({
    where: {
      id: session.id,
      refreshTokenHash: hash,
      revokedAt: null,
    },
    data: {
      refreshTokenHash: newRefreshTokenData.hash,
      lastActivityAt: new Date(),
      expiresAt: newExpiresAt,
    },
  })

  if (rotated.count === 0) {
    throw Errors.unauthorized('Sessão inválida. Faça login novamente.')
  }

  const accessToken = generateAccessToken({
    sub: session.id,
    userId: session.user.id,
    email: session.user.email,
    role: session.user.role,
  })

  return {
    accessToken,
    refreshToken: newRefreshTokenData.token,
  }
}

/**
 * Retorna informações do usuário autenticado
 */
export async function getUserInfo(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      usages: {
        where: { period: getCurrentPeriod() },
      },
    },
  })

  if (!user) {
    // Mensagem genérica — não diferenciar "não encontrado" vs "não autorizado"
    // (security.md: error discrimination proibida). Log interno preservado
    // pelo error handler global para observabilidade.
    throw Errors.unauthorized()
  }

  // Resolve limites via Token ativo (plano) → fallback FREE se não houver.
  // Fonte da verdade: src/config/plan-limits.ts (Card 1.11).
  //
  // ALTO: CANCELLED só mantém privilégios dentro do grace period (expiresAt > now).
  // Ex-PRO com assinatura cancelada e período encerrado volta ao fallback FREE.
  // Mirror do fluxo de refreshSession — sem assimetria entre endpoints.
  const now = new Date()
  const activeToken = await prisma.token.findFirst({
    where: {
      userId: user.id,
      OR: [
        { status: 'ACTIVE' },
        { status: 'CANCELLED', expiresAt: { gt: now } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { plan: true },
  })

  const limits = getLimitsForPlan(activeToken?.plan ?? null)
  const currentUsage = user.usages[0]?.unificationsCount ?? 0
  const unificationsLimit = limits.unificationsPerMonth

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    usage: {
      period: getCurrentPeriod(),
      current: currentUsage,
      limit: unificationsLimit,
      remaining: Math.max(0, unificationsLimit - currentUsage),
    },
  }
}

/**
 * Revoga uma sessão específica (logout)
 */
export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  })
}

/**
 * Revoga todas as sessões de um usuário (logout de todos os dispositivos)
 */
export async function revokeAllSessions(userId: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  })

  return result.count
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

/**
 * Comparação timing-safe de strings
 * Usa HMAC para normalizar tamanho e eliminar timing leak por length
 */
function safeCompare(a: string, b: string): boolean {
  const key = Buffer.from('safeCompare')
  const hmacA = createHmac('sha256', key).update(a).digest()
  const hmacB = createHmac('sha256', key).update(b).digest()
  return timingSafeEqual(hmacA, hmacB)
}
