import { redis } from '../../config/redis'
import { logger } from '../logger'

/**
 * Circuit breaker para falhas de assinatura de webhook Stripe.
 *
 * Racional (OWASP A07/A09): `/webhooks/stripe` não pode ter rate limit
 * uniforme porque Stripe legítimo pode disparar muitos eventos em burst.
 * Mas um atacante forjando assinaturas invalida amplifica a carga de
 * auditoria (Prisma INSERT + Sentry breadcrumb + pino log por request)
 * e pode consumir RTT/tokens/quota de log.
 *
 * Estratégia: contar SÓ assinaturas inválidas por IP em janela curta.
 * Stripe legítimo jamais dispara signature failure — então o contador
 * é zero em operação normal. Atacante enche o contador rápido e é
 * banido por duração maior.
 *
 * Defaults:
 * - MAX_FAILURES: 5 tentativas
 * - FAILURE_WINDOW: 60s (janela do contador)
 * - BAN_DURATION: 900s (15min de ban após atingir o limite)
 *
 * Sem Redis configurado: no-op (retorna "não banido" e não registra).
 * Fail-open por design — falha de Redis não deve bloquear Stripe real.
 */

const MAX_FAILURES = 5
const FAILURE_WINDOW_SECONDS = 60
const BAN_DURATION_SECONDS = 900

const banKey = (ip: string) => `tablix:webhook-sig:ban:${ip}`
const failKey = (ip: string) => `tablix:webhook-sig:fails:${ip}`

/**
 * Verifica se o IP está banido por excesso de falhas de assinatura.
 * Fail-open: se Redis não está disponível, retorna false.
 */
export async function isWebhookSignatureBanned(ip: string): Promise<boolean> {
  if (!redis) return false
  try {
    const banned = await redis.get(banKey(ip))
    return banned !== null
  } catch (err) {
    logger.warn({ err, ip }, '[circuit-breaker] erro ao consultar ban')
    return false
  }
}

/**
 * Registra uma falha de assinatura. Se o IP atingir MAX_FAILURES na
 * janela, aplica ban por BAN_DURATION_SECONDS.
 *
 * Fire-and-forget: nunca lança. Falha de Redis é logada e swallowed
 * — não pode derrubar o handler do webhook.
 */
export async function recordWebhookSignatureFailure(ip: string): Promise<void> {
  if (!redis) return
  try {
    const key = failKey(ip)
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, FAILURE_WINDOW_SECONDS)
    }
    if (count >= MAX_FAILURES) {
      await redis.set(banKey(ip), '1', { ex: BAN_DURATION_SECONDS })
      logger.warn(
        { ip, failures: count },
        '[circuit-breaker] IP banido por falhas de assinatura webhook',
      )
    }
  } catch (err) {
    logger.warn(
      { err, ip },
      '[circuit-breaker] erro ao registrar falha de assinatura',
    )
  }
}

export const WEBHOOK_CIRCUIT_BREAKER_CONFIG = {
  MAX_FAILURES,
  FAILURE_WINDOW_SECONDS,
  BAN_DURATION_SECONDS,
} as const
