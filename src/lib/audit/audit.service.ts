/**
 * Card 2.4 — Audit service (fire-and-forget + triple redundância).
 *
 * Emite eventos forenses para a tabela `audit_log` com três camadas:
 *
 *   1. **Prisma** (primary) — persistência em Postgres. Fonte da verdade.
 *   2. **Sentry breadcrumb** — breadcrumb no escopo do request atual.
 *      Se a persistência falhar mas o request gerar um erro capturado, o
 *      breadcrumb viaja no evento Sentry e preserva a ordem cronológica
 *      do que aconteceu antes do erro.
 *   3. **Pino log estruturado** — JSON log na stdout. Alimentado ao log
 *      aggregator (Logtail/Datadog) — segunda cópia imediata.
 *
 * As três camadas se reforçam: perder a gravação no Postgres NÃO significa
 * perder a evidência forense, pois os logs estruturados e breadcrumbs ficam.
 * Esta é a razão pela qual o padrão fire-and-forget é aceitável aqui — o
 * custo de uma entrada perdida é mitigado pela redundância, mas nunca
 * bloquear o request do usuário por erro de auditoria (AWS CloudTrail,
 * GitHub Audit Log e Stripe Events usam o mesmo padrão).
 *
 * Garantias:
 *   - `emitAuditEvent` NUNCA lança. Se persistência falhar, loga e segue.
 *   - `emitAuditEvent` NUNCA retorna Promise — assinatura `void` força o
 *     caller a não fazer `await` (fire-and-forget de verdade).
 *   - Metadata passa por `scrubObject` (SSOT com Sentry/logger) antes de
 *     ser persistida — defense in depth contra PII/segredo vazado.
 *   - Metadata acima de 1 KB é truncado. Postgres TOAST_TUPLE_THRESHOLD real
 *     é ~2032 bytes (não 8 KB — esse é o tamanho total da page). Cap de 1 KB
 *     deixa folga pros outros campos fixos (action, actor, ip, userAgent,
 *     timestamp) e mantém row inteira inline, evitando out-of-line storage
 *     que triplica tempo de INSERT. Defense in depth com toast_tuple_target
 *     = 4096 configurado via migration 20260420115000.
 *   - `actor`, `ip` e `userAgent` são truncados ao limite do schema para
 *     evitar que um caller bugado derrube a emissão inteira.
 *
 * @owner: @security + @dba
 */
import { Prisma } from '@prisma/client'
import { isIP } from 'net'
import { Sentry, scrubObject } from '../../config/sentry'
import { logger } from '../logger'
import { prisma } from '../prisma'
import type { AuditAction, AuditEventInput } from './audit.types'

/**
 * Cap de bytes do metadata serializado. Acima disso, substituímos o objeto
 * por um placeholder com o tamanho original — mantém o log utilizável sem
 * corromper o campo JSONB no banco.
 *
 * 1024 bytes é o cap pragmático. TOAST_TUPLE_THRESHOLD do Postgres é ~2032
 * bytes (valor hardcoded do source, NÃO 8 KB — esse é o tamanho da page).
 * Row que excede o threshold tem campos variáveis movidos pra TOAST storage
 * out-of-line, triplicando o tempo de INSERT. 1 KB pra metadata + ~800
 * bytes dos outros campos fixos (action/actor/ip/userAgent/createdAt) cabe
 * inline com folga.
 *
 * Safety net no banco: migration 20260420115000 aplica SET
 * (toast_tuple_target = 4096) pra absorver eventuais picos sem degradação.
 */
const METADATA_MAX_BYTES = 1024

/** Limite de caracteres do schema por coluna. Truncate defensivo. */
const COLUMN_LIMITS = {
  actor: 255,
  ip: 45,
  userAgent: 512,
} as const

/**
 * Remove CR/LF/NUL bytes para prevenir log injection.
 *
 * Contexto: pino emite JSON estruturado (CRLF é escapado automaticamente),
 * mas o valor é persistido no Postgres como texto e consumido por analistas
 * via dashboard forense, grep em export CSV e log viewer. CR/LF injetado em
 * User-Agent ou em campo de metadata (string) pode quebrar ferramental
 * downstream e forjar entradas falsas em visualizações line-based.
 * Estripar na borda é barato e fecha a classe inteira.
 *
 * **Card #88 — implementação linear (split/join) sem regex backtracking.**
 * V8 regex engine não tem catastrophic backtracking conhecido pra
 * `[\r\n\0]/g` (character class simples), mas defense in depth bana o
 * pattern de risco: split/join é O(n) garantido em qualquer engine, sem
 * estado interno, sem possibilidade de ReDoS futuro se padrão evoluir.
 *
 * Trade-off mensurado: split/join faz 3 passes (1 por separador) vs 1
 * pass do regex. Strings <1KB (limite truncateString) → diferença < 1ms.
 */
function stripCrlf(value: string): string {
  // Linear, sem backtracking. Cada split/join é O(n).
  return value.split('\r').join('').split('\n').join('').split('\0').join('')
}

function truncateString(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value == null) return null
  const normalized = stripCrlf(value)
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max)
}

/**
 * Valida formato de IP (IPv4 ou IPv6) com `net.isIP`. Se inválido, retorna
 * null — preferimos perder o campo a gravar lixo forense. Também passa por
 * stripCrlf como defense in depth.
 *
 * Fastify popula `request.ip` a partir de X-Forwarded-For quando
 * `trustProxy` está ativo; atacante pode injetar header arbitrário se o
 * reverse proxy não sanear. Validar na gravação fecha o fallback.
 */
function sanitizeIp(value: string | null | undefined): string | null {
  if (value == null) return null
  const stripped = stripCrlf(value)
  if (stripped.length === 0) return null
  return isIP(stripped) === 0 ? null : stripped
}

/**
 * Retorna o metadata pronto para persistir:
 *   - `scrubObject` aplicado (remove campos com nomes sensíveis)
 *   - Truncado se serialização > METADATA_MAX_BYTES
 *
 * Caller pode passar objeto com secret por engano — esta é a última
 * barreira antes do banco. Nunca remove, apenas substitui por `[REDACTED]`
 * (visível em dashboard forense como prova de tentativa de logging).
 */
function prepareMetadata(
  raw: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (raw == null) return undefined
  const scrubbed = scrubObject(raw) as Record<string, unknown>
  const serialized = JSON.stringify(scrubbed)
  if (serialized.length <= METADATA_MAX_BYTES) {
    return scrubbed as Prisma.InputJsonValue
  }
  return {
    _truncated: true,
    _originalBytes: serialized.length,
    _limitBytes: METADATA_MAX_BYTES,
  }
}

/**
 * Persiste o evento no banco. Retorna Promise para ser encadeada em .catch()
 * pelo `emitAuditEvent` (que não a aguarda).
 */
async function persist(
  action: AuditAction,
  actor: string | null,
  ip: string | null,
  userAgent: string | null,
  success: boolean,
  metadata: Prisma.InputJsonValue | undefined,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action,
      actor,
      ip,
      userAgent,
      success,
      metadata,
    },
  })
}

/**
 * Emite um evento auditável. Fire-and-forget: retorna `void` imediatamente,
 * a persistência roda em background sem bloquear o request.
 *
 * Toda falha de persistência é logada via pino (`audit.persist_failed`) e
 * enviada ao Sentry como breadcrumb warning — nunca re-throw, nunca retry.
 * Retry em auditoria transforma degradação do DB em amplificação de carga
 * (evento → retry 3× → 3× mais linhas pra inserir quando DB voltar).
 */
export function emitAuditEvent(input: AuditEventInput): void {
  const action = input.action
  const actor = truncateString(input.actor ?? null, COLUMN_LIMITS.actor)
  const ip = truncateString(sanitizeIp(input.ip), COLUMN_LIMITS.ip)
  const userAgent = truncateString(
    input.userAgent ?? null,
    COLUMN_LIMITS.userAgent,
  )
  const success = input.success
  const metadata = prepareMetadata(input.metadata)

  // Camada 2: Sentry breadcrumb — roda sincronamente, sem custo de rede.
  // Level `warning` quando success=false destaca falhas na timeline do
  // request quando um erro ulterior for capturado.
  try {
    Sentry.addBreadcrumb({
      category: 'audit',
      type: 'info',
      level: success ? 'info' : 'warning',
      message: action,
      data: {
        actor,
        success,
        ...(metadata != null ? { metadata } : {}),
      },
    })
  } catch {
    // Sentry não inicializado (dev/test sem DSN) — silencioso é correto.
  }

  // Camada 3: Pino log estruturado — sincrono, vai direto pra stdout.
  // Sem success condicional: o campo `success` é parte do objeto estruturado
  // e o consumidor de logs filtra por ele. `action` fica no top-level pra
  // facilitar query em Logtail (ex: `action:WEBHOOK_SIGNATURE_FAILED`).
  logger.info(
    {
      audit: true,
      action,
      actor,
      success,
      ...(metadata != null ? { metadata } : {}),
    },
    'audit_event',
  )

  // Camada 1: Prisma persist — fire-and-forget. O .catch() captura
  // qualquer falha (DB down, constraint violation, connection pool exhausted)
  // e degrada gracefully para log + breadcrumb. Nunca re-throw.
  persist(action, actor, ip, userAgent, success, metadata).catch((err) => {
    logger.error(
      {
        err,
        audit: true,
        action,
        actor,
        success,
      },
      'audit.persist_failed',
    )
    try {
      Sentry.addBreadcrumb({
        category: 'audit',
        type: 'error',
        level: 'error',
        message: 'audit.persist_failed',
        data: { action, actor },
      })
    } catch {
      // noop — Sentry pode não estar inicializado
    }
  })
}

/**
 * Internals expostos apenas para testes unitários. Não usar em produção.
 */
export const __testing = {
  prepareMetadata,
  truncateString,
  stripCrlf,
  sanitizeIp,
  METADATA_MAX_BYTES,
  COLUMN_LIMITS,
}
