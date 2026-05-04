/**
 * Admin middleware — Card #145 (5.2a) F4 + WV-2026-006 + F4 fix-pack.
 *
 * Aplica as 9 mitigations do D#3 (admin auth via env allowlist) — workaround
 * temporário até enum `UserRole` separado (#157, kill criteria do waiver).
 *
 * **F4 fix-pack @security:**
 *  - F-ALTO-01 (replay): nonce single-use Redis SET NX EX + janela 30s
 *  - F-ALTO-02 (secret reuse): ADMIN_STEPUP_SECRET separada do JWT_SECRET
 *  - F-ALTO-03 (body binding): HMAC inclui method+path+sha256(body)
 *  - F-MED-01 (cache revoke): invalidateAdminCache exposto pra revoke
 *  - F-MED-03 (log err): err.code/name/sanitized only, NUNCA err raw
 *  - F-BAIXO-02 (failure counter): step-up fail count no Redis (lockout)
 *
 * **9 Mitigations consolidadas:**
 *  1. ✅ Zod boot fail-fast em prod com UUID inválido (env.ts F2)
 *  2. ✅ min(1).max(5) admins (env.ts F2)
 *  3. **prisma.user.findUnique cache 30s + invalidateAdminCache** (este arquivo)
 *  4. **session.revokedAt IS NULL** (delegado authMiddleware Card 1.2)
 *  5. **recordLegalEvent AWAIT ANTES da action** (factory pra handler)
 *  6. ✅ Rate limit 5/min admin + 20/min global (F2 + F4 routes)
 *  7. **crypto.timingSafeEqual** (este arquivo)
 *  8. **Step-up reauth com nonce + body binding + secret separada** (este arquivo)
 *  9. ✅ Card descoberta `roles-admin-enum` (#157 Backlog)
 *
 * @owner: @security + @devops
 * @card: #145 (5.2a) F4 / WV-2026-006
 */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

import { env } from '../config/env'
import { redis } from '../config/redis'
import { Errors } from '../errors/app-error'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { recordLegalEvent } from '../modules/audit-legal/audit-legal.service'

// ============================================
// CONSTANTES
// ============================================

/**
 * TTL do cache de user lookup. 30s é trade-off:
 *  - Curto: ex-admin perde acesso rápido (Mit 3 + F-MED-01)
 *  - Longo: reduz load do DB em polling do dashboard
 *
 * Invalidação proativa via `invalidateAdminCache(userId)` em revoke session
 * (chamada em logout / admin removido do allowlist). F-MED-01 fix.
 */
const ADMIN_USER_CACHE_TTL_MS = 30_000

/**
 * Janela do step-up reauth REDUZIDA pra 30s (era 60s) — F4 fix-pack
 * F-ALTO-01. Combinada com nonce single-use, replay window é máx 30s
 * + HMAC inválido após primeira aceita. Pattern Stripe webhook
 * tolerance é 300s mas eles têm signature por evento; admin tem
 * binding por request (Mit 8 + nonce).
 */
const STEPUP_REAUTH_WINDOW_MS = 30_000

/**
 * TTL do nonce no Redis. Single-use — primeira request consome,
 * segunda recebe FORBIDDEN. TTL > janela permite cleanup natural sem
 * logic adicional.
 */
const STEPUP_NONCE_TTL_SECONDS = 60

/**
 * Lockout pós N falhas de step-up (F-BAIXO-02). Defesa contra brute-force
 * de timestamps válidos (atacante com JWT já validado tenta forjar HMAC).
 */
const STEPUP_FAIL_LIMIT = 3
const STEPUP_FAIL_WINDOW_SECONDS = 5 * 60
const STEPUP_LOCKOUT_DURATION_SECONDS = 15 * 60

/**
 * Header obrigatório pra step-up reauth. Formato pós-fix-pack:
 *   `X-Admin-Confirm: <ts-ms>.<nonce-uuid>.<hmac-hex>`
 *
 * HMAC = HMAC-SHA256(
 *   ADMIN_STEPUP_SECRET,
 *   `${userId}:${method}:${path}:${ts}:${nonce}:${sha256(body)}`
 * ).
 *
 * Diferenças vs F4 inicial (corrigido fix-pack @security):
 *  - Nonce single-use (F-ALTO-01 anti-replay)
 *  - method/path/body hash no input (F-ALTO-03 binding)
 *  - ADMIN_STEPUP_SECRET separada do JWT_SECRET (F-ALTO-02)
 */
const STEPUP_HEADER = 'x-admin-confirm'
const STEPUP_NONCE_REDIS_PREFIX = 'tablix:admin:stepup:nonce:'
const STEPUP_FAIL_REDIS_PREFIX = 'tablix:admin:stepup:fail:'
const STEPUP_LOCKOUT_REDIS_PREFIX = 'tablix:admin:stepup:lockout:'

// ============================================
// CACHE — admin user lookup (Mit 3 + F-MED-01)
// ============================================

interface CachedUser {
  user: {
    id: string
    historyOptIn: boolean
  } | null
  cachedAt: number
}

const adminUserCache = new Map<string, CachedUser>()

async function getAdminUserCached(userId: string): Promise<CachedUser['user']> {
  const now = Date.now()
  const cached = adminUserCache.get(userId)
  if (cached && now - cached.cachedAt < ADMIN_USER_CACHE_TTL_MS) {
    return cached.user
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, historyOptIn: true },
  })

  adminUserCache.set(userId, { user, cachedAt: now })
  return user
}

/**
 * Invalidação proativa do cache. Chamar em revoke session, admin removido
 * do allowlist, etc. F-MED-01 fix — fecha gap de 30s onde admin removido
 * mantém acesso por cache stale.
 */
export function invalidateAdminCache(userId: string): void {
  adminUserCache.delete(userId)
}

// ============================================
// TIMING-SAFE ALLOWLIST CHECK (Mit 7)
// ============================================

function isUserIdInAllowlistTimingSafe(
  userId: string,
  allowlist: ReadonlyArray<string>,
): boolean {
  if (userId.length !== 36) return false

  const userIdBuf = Buffer.from(userId, 'utf8')
  let matched = false

  for (const adminId of allowlist) {
    if (adminId.length !== 36) continue
    const adminBuf = Buffer.from(adminId, 'utf8')
    matched = timingSafeEqual(userIdBuf, adminBuf) || matched
  }

  return matched
}

// ============================================
// STEP-UP REAUTH — F4 fix-pack redesign (Mit 8)
// ============================================

/**
 * SHA-256 hex do body. Usado no canonical request pro HMAC. Body vazio
 * (ex: GET) usa hash de string vazia — determinístico, não colide com
 * "body ausente".
 */
function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Computa HMAC esperado pra um par (userId, method, path, ts, nonce, body).
 * Determinístico — cliente computa via endpoint separado (out of scope F4).
 *
 * Inclui no input:
 *  - userId: binding por user (atacante user A não forja HMAC pra user B)
 *  - method/path: binding por route (atacante não troca :name)
 *  - ts: timestamp (janela ±30s)
 *  - nonce: single-use UUID (anti-replay)
 *  - sha256(body): binding por body (atacante MITM não troca payload)
 */
function computeExpectedHmac(args: {
  userId: string
  method: string
  path: string
  ts: number
  nonce: string
  bodyHash: string
  secret: string
}): string {
  const canonical = `${args.userId}:${args.method.toUpperCase()}:${args.path}:${args.ts}:${args.nonce}:${args.bodyHash}`
  return createHmac('sha256', args.secret).update(canonical).digest('hex')
}

interface StepUpValidationContext {
  header: string | undefined
  userId: string
  method: string
  path: string
  bodyRaw: string | Buffer
  now: number
  secret: string
}

/**
 * Valida step-up reauth completo. Retorna `true` se válido. Falha em qualquer
 * etapa retorna `false` (caller traduz pra 403 genérico — anti-enumeração).
 *
 * Etapas (em ordem):
 *  1. Format do header (3 partes separadas por ponto)
 *  2. Timestamp parseable + dentro da janela ±30s
 *  3. Nonce UUID v4 strict
 *  4. HMAC bate (constant-time compare)
 *  5. Nonce ainda não consumido (Redis SET NX EX) — atomic single-use
 */
async function validateStepUpReauth(
  ctx: StepUpValidationContext,
): Promise<boolean> {
  const { header, userId, method, path, bodyRaw, now, secret } = ctx

  if (!header || typeof header !== 'string') return false

  const parts = header.split('.')
  if (parts.length !== 3) return false
  const [tsStr, nonce, providedHmacHex] = parts

  // (2) Timestamp + janela
  const ts = Number(tsStr)
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return false
  if (Math.abs(now - ts) > STEPUP_REAUTH_WINDOW_MS) return false

  // (3) Nonce UUID v4 strict
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  if (!uuidV4Regex.test(nonce)) return false

  // (4) HMAC compare (constant-time)
  const bodyHash = sha256Hex(bodyRaw)
  const expected = computeExpectedHmac({
    userId,
    method,
    path,
    ts,
    nonce,
    bodyHash,
    secret,
  })

  if (providedHmacHex.length !== expected.length) return false

  let hmacValid: boolean
  try {
    hmacValid = timingSafeEqual(
      Buffer.from(providedHmacHex, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  } catch {
    return false
  }

  if (!hmacValid) return false

  // (5) Nonce single-use via Redis SET NX EX (F-ALTO-01)
  // Sem Redis: fail-closed (nonce não pode ser garantido). Em dev/test isso
  // é gap conhecido — em prod, env.ts superRefine exige Redis.
  if (!redis) {
    logger.warn({ userId }, 'admin.stepup.redis_unavailable.fail_closed')
    return false
  }

  const nonceKey = `${STEPUP_NONCE_REDIS_PREFIX}${userId}:${nonce}`
  const claimed = await redis.set(nonceKey, '1', {
    nx: true,
    ex: STEPUP_NONCE_TTL_SECONDS,
  })

  // Upstash: 'OK' se claimed (primeira vez), null se já existia (replay).
  return claimed === 'OK'
}

// ============================================
// FAILURE COUNTER + LOCKOUT (F-BAIXO-02 fix)
// ============================================

async function isUserLockedOut(userId: string): Promise<boolean> {
  if (!redis) return false
  const key = `${STEPUP_LOCKOUT_REDIS_PREFIX}${userId}`
  const value = await redis.get(key)
  return value !== null
}

async function recordStepUpFailure(userId: string): Promise<void> {
  if (!redis) return
  const failKey = `${STEPUP_FAIL_REDIS_PREFIX}${userId}`
  const lockoutKey = `${STEPUP_LOCKOUT_REDIS_PREFIX}${userId}`

  // INCR + EXPIRE first-time + SET lockout-on-threshold via Lua atomic
  // (mesmo pattern Card #86 webhook-circuit-breaker)
  const LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
  return {count, 1}
end
return {count, 0}
`
  try {
    const result = (await redis.eval(
      LUA,
      [failKey, lockoutKey],
      [
        String(STEPUP_FAIL_WINDOW_SECONDS),
        String(STEPUP_FAIL_LIMIT),
        String(STEPUP_LOCKOUT_DURATION_SECONDS),
      ],
    )) as [number, number] | undefined

    if (Array.isArray(result) && result.length === 2) {
      const [count, lockoutApplied] = [Number(result[0]), Number(result[1])]
      if (lockoutApplied === 1) {
        logger.warn({ userId, count }, 'admin.stepup.lockout_applied')
      }
    }
  } catch (err) {
    // Defesa em profundidade: erro no rate limit não escala
    logger.error(
      {
        userId,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage:
          err instanceof Error
            ? err.message.slice(0, 200).replace(/[\r\n\t]/g, ' ')
            : 'unknown',
      },
      'admin.stepup.fail_counter_error',
    )
  }
}

// ============================================
// MIDDLEWARE
// ============================================

export async function adminMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.user) {
    throw Errors.unauthorized('Sessão inválida')
  }

  const userId = request.user.userId

  // Lockout precoce — F-BAIXO-02 fix
  const lockedOut = await isUserLockedOut(userId)
  if (lockedOut) {
    logger.warn({ userId, ip: request.ip }, 'admin.middleware.rejected.lockout')
    throw Errors.forbidden('Acesso administrativo negado.')
  }

  // Mit 7: timing-safe allowlist check
  if (!isUserIdInAllowlistTimingSafe(userId, env.ADMIN_USER_IDS)) {
    logger.warn(
      { userId, ip: request.ip },
      'admin.middleware.rejected.not_in_allowlist',
    )
    throw Errors.forbidden('Acesso administrativo negado.')
  }

  // Mit 3: user lookup cached 30s
  const adminUser = await getAdminUserCached(userId)
  if (!adminUser) {
    logger.warn(
      { userId, ip: request.ip },
      'admin.middleware.rejected.user_not_found',
    )
    throw Errors.forbidden('Acesso administrativo negado.')
  }

  // Mit 8 (redesigned): step-up reauth com nonce + body binding + secret separada
  const stepupHeader = request.headers[STEPUP_HEADER]
  const headerStr = typeof stepupHeader === 'string' ? stepupHeader : undefined

  // F-ALTO-02 fix: ADMIN_STEPUP_SECRET separado. Em dev sem env, fail-closed.
  const stepupSecret = env.ADMIN_STEPUP_SECRET
  if (!stepupSecret) {
    logger.warn(
      { userId, ip: request.ip },
      'admin.middleware.rejected.stepup_secret_not_configured',
    )
    throw Errors.forbidden('Acesso administrativo negado.')
  }

  // Body raw — Fastify pode ter parsed; usamos rawBody se exposed,
  // senão JSON.stringify do parsed (determinístico em ordem de chaves
  // requer JSON canonical, mas pra F4 schemas são `.strict()` e small;
  // body vazio é caso comum em GET admin/jobs/list e POST /run/:name).
  const bodyRaw =
    typeof request.body === 'object' && request.body !== null
      ? JSON.stringify(request.body)
      : ''

  const stepupValid = await validateStepUpReauth({
    header: headerStr,
    userId,
    method: request.method,
    path: request.routeOptions?.url ?? request.url,
    bodyRaw,
    now: Date.now(),
    secret: stepupSecret,
  })

  if (!stepupValid) {
    await recordStepUpFailure(userId)
    logger.warn(
      { userId, ip: request.ip },
      'admin.middleware.rejected.stepup_invalid',
    )
    throw Errors.forbidden('Acesso administrativo negado.')
  }

  logger.info(
    { userId, route: request.url, method: request.method },
    'admin.middleware.granted',
  )
}

// ============================================
// AUDIT FACTORY (Mit 5)
// ============================================

export async function recordAdminActionAttempt(args: {
  adminUserId: string
  action: string
  resourceType: string
  resourceId: string
  ip: string
  userAgent: string
}): Promise<void> {
  const eventId = randomUUID()
  await recordLegalEvent({
    eventId,
    eventType: 'dsar_request',
    userId: args.adminUserId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    legalBasis: `admin_panel_action_${args.action}`.toLowerCase(),
    actor: 'admin_panel',
    outcome: 'success',
    metadata: {
      action: args.action,
      ip: args.ip,
      userAgent: args.userAgent,
    },
  })
}

// ============================================
// HELPERS DE TESTE
// ============================================

/**
 * Computa HMAC esperado pra forjar X-Admin-Confirm em integration tests.
 * Inclui method/path/body — caller deve passar exatamente o que vai ser
 * enviado no request real.
 *
 * F4 fix-pack @security smart re-run MÉDIO: fallback `?? env.JWT_SECRET`
 * removido. Inconsistência entre prod (exige ADMIN_STEPUP_SECRET) e test
 * (caía no JWT_SECRET) podia produzir falsos-positivos em CI. Throw
 * explícito força configuração correta no test setup.
 */
export function computeStepUpHmacForTesting(args: {
  userId: string
  method: string
  path: string
  timestamp: number
  nonce: string
  body: string
  secret?: string
}): string {
  const secret = args.secret ?? env.ADMIN_STEPUP_SECRET
  if (!secret) {
    throw new Error(
      'computeStepUpHmacForTesting: ADMIN_STEPUP_SECRET not configured. Mock env or pass `secret` explicitly.',
    )
  }
  return computeExpectedHmac({
    userId: args.userId,
    method: args.method,
    path: args.path,
    ts: args.timestamp,
    nonce: args.nonce,
    bodyHash: sha256Hex(args.body),
    secret,
  })
}

export const __testing = {
  ADMIN_USER_CACHE_TTL_MS,
  STEPUP_REAUTH_WINDOW_MS,
  STEPUP_NONCE_TTL_SECONDS,
  STEPUP_FAIL_LIMIT,
  STEPUP_HEADER,
  STEPUP_NONCE_REDIS_PREFIX,
  adminUserCache,
  isUserIdInAllowlistTimingSafe,
  validateStepUpReauth,
  getAdminUserCached,
  computeExpectedHmac,
  sha256Hex,
  resetCacheForTests: () => adminUserCache.clear(),
}
