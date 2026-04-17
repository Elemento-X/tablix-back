/**
 * Card 2.3 — Health checks profundos.
 *
 * Tipos compartilhados entre orchestrator, runners e schemas Zod.
 *
 * Decisões de design (validadas com @security/@dba antes de implementar):
 *
 *   1. **Timeouts split por dependência** (não global).
 *      Redis Upstash REST tem p99 de ~100-200ms a partir de Fly.io us-east.
 *      Prisma + Supabase pooler tem cold start de ~300-600ms no primeiro
 *      ping pós-idle. Unificar 1s mascara latência anormal do Redis;
 *      apertar global para 500ms quebra DB legítimo em cold start.
 *
 *   2. **Cache stale-while-revalidate de 2s**.
 *      Fly.io probe default = 10s × 2 instances = 12 probes/min. Sem cache,
 *      cada probe paga round-trip Prisma + Redis. 2s de janela amortiza
 *      sem mascarar falha real por mais que 1 ciclo de probe.
 *      Stale serve imediato; revalidação dispara em background. Probe
 *      nunca espera latência cheia — antipadrão clássico de readiness probe
 *      é probe lento que vira dependência da latência da própria health.
 *
 *   3. **`/live` nunca toca cache nem dependências externas**.
 *      Liveness probe deve detectar processo travado/deadlock — tocar DB
 *      transforma DB down em container kill, blast radius errado.
 *
 *   4. **Stripe deliberadamente FORA** dos checks (mesmo verbose).
 *      Razões: blast radius (Stripe down não impede /process, /auth, /usage);
 *      self-DoS contra rate limit Stripe (compartilhado com checkout real);
 *      denial-of-wallet via Sentry tracing. Stripe canary é card separado.
 *
 * @owner: @devops + @security + @dba (pipeline core estendido)
 */
import { env } from '../../config/env'

/**
 * Status individual de cada dependência.
 *   - `up`      — check passou dentro do timeout
 *   - `down`    — check falhou (timeout, erro de rede, erro de auth)
 *   - `skipped` — dependência não aplicável neste ambiente
 *                 (ex: Redis null em dev/test; em prod isto vira `down`)
 */
export type CheckStatus = 'up' | 'down' | 'skipped'

/**
 * Códigos estáveis de falha. Discriminator pra dashboards/alertas.
 *
 * Nunca incluir `error.message` cru na response — vaza hostname,
 * stack, query string. Códigos enumerados são contrato; mensagem fica
 * só no log estruturado (pino com REDACT_PATHS aplicado).
 */
export type CheckCode =
  | 'DB_TIMEOUT'
  | 'DB_ERROR'
  | 'REDIS_TIMEOUT'
  | 'REDIS_ERROR'
  | 'REDIS_NOT_CONFIGURED'

export interface CheckResult {
  status: CheckStatus
  /** Latência observada do check em ms. 0 quando `skipped`. */
  latencyMs: number
  /** Presente apenas quando status !== 'up'. */
  code?: CheckCode
}

export type OverallStatus = 'ok' | 'degraded'

export interface HealthSnapshot {
  status: OverallStatus
  checks: {
    db: CheckResult
    redis: CheckResult
  }
  /** Momento ISO-8601 UTC em que este snapshot foi gerado (não retornado). */
  generatedAt: string
  /** `true` se a resposta veio do cache stale-while-revalidate. */
  cached: boolean
}

/**
 * Timeouts por dependência, em milissegundos.
 *
 * Lidos de env vars opcionais (HEALTH_TIMEOUT_DB_MS, HEALTH_TIMEOUT_REDIS_MS)
 * com fallback para os defaults. Permite tuning operacional sem rebuild.
 *
 * Mexer nos defaults exige re-validação com @dba (Prisma) e @devops (Redis).
 * Apertar muito gera flapping; afrouxar muito mascara degradação real
 * e atrasa rollback automático no orquestrador.
 */
export const TIMEOUTS = {
  get db() {
    return env.HEALTH_TIMEOUT_DB_MS
  },
  get redis() {
    return env.HEALTH_TIMEOUT_REDIS_MS
  },
}

/**
 * TTL do cache stale-while-revalidate, em ms.
 *
 * Lido de env var opcional (HEALTH_CACHE_TTL_MS) com fallback para 2000ms.
 * Não confundir com "Cache-Control max-age" — aqui é cache in-process
 * compartilhado entre requests do MESMO container. Cada container Fly.io
 * tem sua própria janela. Cliente recebe sempre `Cache-Control: no-store`.
 */
export const CACHE_TTL_MS = env.HEALTH_CACHE_TTL_MS
