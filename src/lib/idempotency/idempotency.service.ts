/**
 * Idempotency service — Card #74 (3.4).
 *
 * Protege endpoints de mutação arriscada (billing, provisioning) contra
 * double-submit do cliente via header `Idempotency-Key`. Padrão alinhado
 * com Stripe, GitHub, AWS: cliente envia UUID v4 (ou equivalente), servidor
 * armazena resultado da primeira execução em Redis por 24h. Réplicas com
 * mesma key retornam o mesmo resultado sem reexecutar; mesmo key com body
 * diferente retorna 422 (conflict).
 *
 * **Fluxo:**
 * 1. Cliente envia POST com `Idempotency-Key: <key>`
 * 2. Controller chama `beginIdempotentOperation({ key, scope, identifier, bodyHash })`
 * 3. Se retorna `{ status: 'hit' }` — serve cached e retorna
 * 4. Se retorna `{ status: 'conflict' }` — 422 IDEMPOTENCY_CONFLICT
 * 5. Se retorna `{ status: 'in_progress' }` — 409 Conflict (outro worker processando)
 * 6. Se retorna `{ status: 'miss', release }` — executa lógica de negócio; ao
 *    final chama `completeIdempotentOperation({ ..., data })` pra gravar resultado
 *
 * **Lock atômico via Redis SETNX:** SET ... NX EX é single-statement no
 * Upstash Redis — garante que apenas 1 worker adquire a key por vez.
 * Workers perdedores recebem `in_progress`.
 *
 * **Sem Redis configurado:** no-op (retorna `{ status: 'miss' }`). Aceito em
 * dev/test; em produção o Redis é obrigatório via `env.ts:superRefine`.
 * Operação prossegue sem proteção mas o caller não vê diferença de API.
 *
 * **Segurança:**
 * - `identifier` no key evita colisão entre clientes (ex: dois emails
 *   distintos mandando a mesma key não sobreescrevem um ao outro)
 * - `bodyHash` (SHA-256) detecta replay conflict (mesma key + body diferente
 *   = atacante/bug; aceitar seria violação de contrato)
 * - Key max 255 chars (enforced upstream no schema Zod)
 *
 * @owner: @security + @dba
 * @card: 3.4 (#74)
 */
import { createHash } from 'node:crypto'
import { redis } from '../../config/redis'
import { logger } from '../logger'

const DEFAULT_TTL_SECONDS = 24 * 60 * 60 // 24h — alinhado com Stripe/api-contract.md
const KEY_PREFIX = 'tablix:idempotency'

export type IdempotencyStatus = 'hit' | 'miss' | 'conflict' | 'in_progress'

export interface IdempotencyRecord<T> {
  bodyHash: string
  data: T
  createdAt: string // ISO
}

export interface BeginResult<T> {
  status: IdempotencyStatus
  cached?: T
  /**
   * Sinaliza fail-open: Redis configurado mas falhou (timeout/network) e a
   * operação prossegue SEM proteção de idempotência. Caller pode emitir
   * header `Idempotency-Degraded: true` e logger/metric pra ops alarmar.
   * Distinto de `redis === null` (dev/test sem Redis — comportamento esperado,
   * NÃO degraded). @dba finding Card #74 MÉDIO.
   */
  degraded?: boolean
}

export interface BeginParams {
  key: string
  scope: string // ex: 'checkout'
  identifier: string // ex: email ou userId
  bodyHash: string
  ttlSeconds?: number
}

export interface CompleteParams<T> {
  key: string
  scope: string
  identifier: string
  bodyHash: string
  data: T
  ttlSeconds?: number
}

/**
 * Gera hash SHA-256 estável de um payload. Normaliza via JSON.stringify
 * canonical (chaves ordenadas) para evitar diferenças cosméticas quebrarem
 * detecção de duplicata legítima.
 */
export function hashBody(body: unknown): string {
  const json = canonicalJsonStringify(body)
  return createHash('sha256').update(json).digest('hex')
}

function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) {
    // JSON.stringify(undefined) === undefined (não string), o que quebra
    // o update() do crypto. Normalizar pra sentinel distinto de null.
    return '"__undefined__"'
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
    .join(',')}}`
}

function buildKey(params: {
  scope: string
  identifier: string
  key: string
}): string {
  return `${KEY_PREFIX}:${params.scope}:${params.identifier}:${params.key}`
}

/**
 * Tenta adquirir o lock atômico para a key de idempotência. Retorna:
 * - `hit`: já executada antes com mesmo bodyHash, retorna cached
 * - `conflict`: mesma key com bodyHash diferente (atacante/bug) → caller responde 422
 * - `in_progress`: outro worker está executando a mesma key agora → caller responde 409
 * - `miss`: caller deve executar a lógica e depois chamar `completeIdempotentOperation`
 */
export async function beginIdempotentOperation<T>(
  params: BeginParams,
): Promise<BeginResult<T>> {
  if (!redis) return { status: 'miss' } // Sem Redis: no-op

  const fullKey = buildKey(params)
  const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS

  // Tenta adquirir lock atômico (SET NX EX). Se bem-sucedido, é miss.
  // Lock inicial guarda só o bodyHash — `data` é gravado em completeIdempotentOperation.
  const lockPayload = JSON.stringify({
    bodyHash: params.bodyHash,
    status: 'processing',
    createdAt: new Date().toISOString(),
  })

  try {
    const acquired = await redis.set(fullKey, lockPayload, {
      nx: true,
      ex: ttl,
    })
    if (acquired === 'OK') {
      return { status: 'miss' }
    }
  } catch (err) {
    // Falha de Redis: fail-open (permite operação sem idempotência).
    // Produção terá alarme via Sentry no logger.warn.
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scope: params.scope,
        metric: 'idempotency.degraded',
      },
      '[idempotency] SET NX falhou — fail-open sem proteção',
    )
    return { status: 'miss', degraded: true }
  }

  // Lock existente: lê e compara bodyHash
  let raw: string | null
  try {
    raw = (await redis.get<string>(fullKey)) as string | null
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scope: params.scope,
        metric: 'idempotency.degraded',
      },
      '[idempotency] GET falhou — fail-open',
    )
    return { status: 'miss', degraded: true }
  }

  if (!raw) {
    // Expirou entre SET NX e GET — raríssimo, trata como miss novo
    return { status: 'miss' }
  }

  let parsed: { bodyHash: string; status: string; data?: T }
  try {
    parsed =
      typeof raw === 'string'
        ? (JSON.parse(raw) as typeof parsed)
        : (raw as unknown as typeof parsed)
  } catch {
    logger.warn(
      { scope: params.scope },
      '[idempotency] payload corrompido — tratando como miss',
    )
    return { status: 'miss' }
  }

  // bodyHash diferente = conflict (mesma key, request diferente)
  if (parsed.bodyHash !== params.bodyHash) {
    return { status: 'conflict' }
  }

  // Mesmo bodyHash: ainda em processamento ou já completo
  if (parsed.status === 'done' && parsed.data !== undefined) {
    return { status: 'hit', cached: parsed.data }
  }

  // processing: outro worker ainda está executando
  return { status: 'in_progress' }
}

/**
 * Grava o resultado da operação bem-sucedida sob a mesma key. Sobrescreve
 * o lock inicial com `{ status: 'done', data }`. **TTL é preservado** —
 * lê o TTL restante via PTTL e re-aplica via `px` pra não estender a janela
 * além do contrato de 24h declarado (@dba finding #74: SET com EX resetaria
 * o TTL, esticando dedup além do alinhamento com Stripe).
 */
export async function completeIdempotentOperation<T>(
  params: CompleteParams<T>,
): Promise<void> {
  if (!redis) return

  const fullKey = buildKey(params)
  const fallbackTtl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS

  const payload = JSON.stringify({
    bodyHash: params.bodyHash,
    status: 'done',
    data: params.data,
    createdAt: new Date().toISOString(),
  })

  try {
    // Preserva TTL real do lock inicial: PTTL retorna ms restantes; se < 1s
    // (quase expirado) ou falhar (-1/-2), usa fallback de 24h pra evitar key
    // gravada sem TTL. `px` aceita ms.
    let pttl = -1
    try {
      pttl = (await redis.pttl(fullKey)) ?? -1
    } catch {
      pttl = -1
    }
    const remainingMs = pttl > 1000 ? pttl : fallbackTtl * 1000
    await redis.set(fullKey, payload, { px: remainingMs })
  } catch (err) {
    // Falha ao gravar não deve propagar — a operação de negócio já foi
    // executada. Próximo retry com mesma key vai ser tratado como miss
    // (re-executa), o que é o mesmo comportamento de "sem idempotência".
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scope: params.scope,
      },
      '[idempotency] gravação do resultado falhou — próximo retry re-executa',
    )
  }
}

/**
 * Remove explicitamente uma key de idempotência. Útil em caso de falha da
 * operação pra permitir retry imediato do cliente (ao invés de esperar
 * 24h do TTL).
 */
export async function releaseIdempotencyKey(params: {
  key: string
  scope: string
  identifier: string
}): Promise<void> {
  if (!redis) return

  try {
    await redis.del(buildKey(params))
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scope: params.scope,
      },
      '[idempotency] release falhou — TTL expira em 24h',
    )
  }
}

export const IDEMPOTENCY_CONSTANTS = {
  DEFAULT_TTL_SECONDS,
  KEY_PREFIX,
  MAX_KEY_LENGTH: 255,
} as const
