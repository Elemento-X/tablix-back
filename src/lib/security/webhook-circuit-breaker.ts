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
 * Lua script atômico — INCR + EXPIRE-on-first + SET ban-on-threshold numa
 * única round-trip. Fecha 3 races em sequência:
 *
 * 1. TOCTOU original (INCR + EXPIRE separados): worker morto entre eles
 *    deixava contador eterno, ban permanente após N falhas históricas.
 * 2. TOCTOU residual EVAL → SET ban (race entre EVAL atingindo MAX e SET
 *    ban): atacante com 5 falhas e crash do worker recomeçava sem ban.
 * 3. Log noise (ban dispara só quando `count == MAX`, não `>=`): cada falha
 *    extra após o ban não re-loga "IP banido".
 *
 * Atomicidade garantida pelo Redis (script roda single-threaded).
 * Upstash REST suporta EVAL nativo.
 *
 * Card #86 — pipeline-discovery do Card 2.4 (@security BAIXO).
 *
 * KEYS[1] = failKey
 * KEYS[2] = banKey
 * ARGV[1] = janela em segundos (failure window)
 * ARGV[2] = MAX_FAILURES (threshold pro ban)
 * ARGV[3] = duração do ban em segundos
 *
 * Retorna: [count, banApplied] — banApplied=1 se este EVAL aplicou o ban
 * (only-once por IP), 0 caso contrário. Caller usa pra logar ban exatamente
 * 1 vez.
 */
const INCR_WITH_EXPIRE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local banApplied = 0
if count == tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[3]))
  banApplied = 1
end
return {count, banApplied}
`.trim()

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
 * INCR + EXPIRE + SET ban são atômicos via Lua EVAL — um worker que morra
 * entre as operações não deixa o contador eterno nem permite bypass do
 * ban entre EVAL e SET (Card #86 fix completo).
 *
 * Fire-and-forget: nunca lança. Falha de Redis é logada e swallowed
 * — não pode derrubar o handler do webhook.
 */
export async function recordWebhookSignatureFailure(ip: string): Promise<void> {
  if (!redis) return
  try {
    const result = (await redis.eval(
      INCR_WITH_EXPIRE_SCRIPT,
      [failKey(ip), banKey(ip)],
      [
        String(FAILURE_WINDOW_SECONDS),
        String(MAX_FAILURES),
        String(BAN_DURATION_SECONDS),
      ],
    )) as [number, number] | undefined

    // Defensive: Upstash retorna array [count, banApplied]. Se vier nulo
    // ou shape inesperado (script error silencioso), trata como no-op
    // observável em logs — não dispara ban falso nem mascara o evento.
    if (!Array.isArray(result) || result.length !== 2) {
      logger.warn(
        { ip, result },
        '[circuit-breaker] EVAL retornou shape inesperado',
      )
      return
    }

    const [count, banApplied] = [Number(result[0]), Number(result[1])]
    if (banApplied === 1) {
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
