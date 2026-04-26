/**
 * Card 2.2 — Sentry SDK integration.
 *
 * Single source of truth para error tracking + performance monitoring.
 * Reutiliza `REDACT_PATHS` do logger (Card 2.1) via `extractFieldName`
 * como sanitizador adicional no `beforeSend` — defense in depth sobre o
 * scrubbing server-side do Sentry (17 sensitiveFields + dataScrubber +
 * scrubIPAddresses + storeCrashReports=0 configurados via MCP no bootstrap).
 *
 * Camadas de proteção:
 *   1. `beforeSend` client-side — scrubbing local antes de sair da máquina
 *   2. `sendDefaultPii: false` — não mandar IP, cookies, headers por default
 *   3. Sentry project scrubbing (server-side) — segunda rede de segurança
 *
 * Security rules aplicadas:
 *   - Nunca enviar body de /auth/* ou /webhooks/* (dropa event inteiro)
 *   - Nunca enviar headers sensíveis (authorization, cookie, stripe-signature)
 *   - Nunca enviar secrets de ambiente (database_url, jwt_secret, api_keys)
 *   - `sendDefaultPii: false` força opt-in explícito pra qualquer PII
 *   - Drop de eventos em `test` environment (vitest não polui dashboard)
 *   - Scrub de exception.values (message/stack contém PII real — JWT, CPF, email)
 *   - Query string parse-based via SENSITIVE_FIELD_NAMES (não regex blacklist)
 *   - URL parse fail-closed (se não parsear, assume sensível e dropa)
 *   - Error/Map/Set/Buffer instances tratados explicitamente em scrubObject
 *
 * @owner: @security + @devops
 */
import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'
import type { ErrorEvent, EventHint } from '@sentry/node'
import { env } from './env'
import { REDACT_PATHS } from './logger'

/**
 * Extrai o nome do campo do path do pino-redact para uso em comparação
 * local (beforeSend). Exemplos:
 *   `req.headers.authorization` → `authorization`
 *   `req.headers["stripe-signature"]` → `stripe-signature`
 *   `*.database_url` → `database_url`
 *   `req.body.access_token` → `access_token`
 */
function extractFieldName(path: string): string {
  const bracketMatch = path.match(/\["([^"]+)"\]/)
  if (bracketMatch) return bracketMatch[1].toLowerCase()
  const segments = path.split('.')
  return segments[segments.length - 1].toLowerCase()
}

/**
 * Conjunto de nomes de campos sensíveis derivado de REDACT_PATHS.
 * Single source of truth — muda no logger, reflete aqui.
 *
 * F11 (@security): `ReadonlySet` é só tipo TS. Runtime wrapping via Proxy
 * bloqueia mutação de `add/delete/clear` — defense in depth contra RCE
 * hipotético que tentasse desabilitar scrubbing em runtime.
 */
const _mutableSet = new Set(REDACT_PATHS.map(extractFieldName))
export const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Proxy(
  _mutableSet,
  {
    get(target, prop) {
      if (prop === 'add' || prop === 'delete' || prop === 'clear') {
        return () => {
          throw new Error('SENSITIVE_FIELD_NAMES is immutable')
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  },
) as ReadonlySet<string>

/**
 * F7 — Regex anchored para matching de URL sensível. Cobre variações:
 *   /auth/*, /authz/* (OIDC), /webhook/*, /webhooks/*
 *   /v1/auth/*, /api/auth/*, /v2/webhooks/*
 * NÃO casa: /authentication, /author, /webhooked.
 */
const SENSITIVE_URL_REGEX =
  /^(?:\/(?:v\d+|api))?\/(?:auth|authz|webhooks?)(?:\/|$)/i

function isSensitiveUrl(url: string | undefined): boolean {
  if (!url) return false
  return SENSITIVE_URL_REGEX.test(url)
}

/**
 * F1 — Parse fail-closed de pathname. Aceita URL absoluta OU path relativo
 * (que é como Sentry preenche `event.request.url` no Node SDK). Se o parse
 * falhar, retorna `null` e o caller trata como "não sei → trate como
 * sensível e drope o evento".
 */
function safePathname(url: string): string | null {
  try {
    return new URL(url, 'http://_').pathname
  } catch {
    return null
  }
}

/**
 * F3 — Sanitiza recursivamente removendo valores cujos nomes de chave casam
 * com SENSITIVE_FIELD_NAMES. Trata instâncias especiais (Error, Map, Set,
 * Buffer) para evitar perda de dados silenciosa ou recursão em bytes.
 * Profundidade limitada a 5 (DoS protection) + WeakSet anti-circular.
 *
 * Exportado para reuso pelo `audit.service.ts` (Card 2.4) — o audit_log
 * persiste metadata de caller, e scrub no momento da persistência é defense
 * in depth contra PII/segredo vazado por engano (caller esqueceu de filtrar).
 */
export function scrubObject(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > 5) return '[DEPTH_LIMIT]'
  if (value === null || typeof value !== 'object') {
    // Strings passam por scrubString (regex de PII: JWT, email, CPF, Stripe,
    // Tablix). Defense in depth: scrubObject checa nome da chave, scrubString
    // checa o conteúdo. Caller que vaza `{ emailUsed: "a@b.com" }` em metadata
    // é capturado aqui mesmo — chave benigna, valor com PII.
    if (typeof value === 'string') return scrubString(value)
    return value
  }
  if (seen.has(value as object)) return '[CIRCULAR]'
  seen.add(value as object)

  // F3 — instâncias especiais tratadas antes do Object.entries genérico
  if (value instanceof Error) {
    return {
      name: value.name,
      message: '[REDACTED_ERROR_MESSAGE]',
      stack: value.stack,
    }
  }
  if (value instanceof Map) return '[MAP_REDACTED]'
  if (value instanceof Set) return '[SET_REDACTED]'
  if (
    value instanceof Uint8Array ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  ) {
    return '[BINARY]'
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item, depth + 1, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = scrubObject(val, depth + 1, seen)
    }
  }
  return out
}

/**
 * F4 — Scruba query string via URLSearchParams + SSOT (SENSITIVE_FIELD_NAMES).
 * Substitui a regex blacklist ad-hoc, que perdia `?email=`, `?jwt=`,
 * `?refresh=`, `?cpf=`, etc. Parse-based é imune a bypass por naming.
 */
function scrubQueryString(qs: string): string {
  const parsed = new URLSearchParams(qs)
  const clean = new URLSearchParams()
  for (const [k, v] of parsed) {
    if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
      clean.append(k, '[REDACTED]')
    } else {
      clean.append(k, v)
    }
  }
  return clean.toString()
}

/**
 * F8 — Regex patterns para scrubbing de strings livres (error.message,
 * exception values). Cobre os formatos mais vazáveis: JWT, email, CPF,
 * Stripe keys, Tablix Pro tokens, refresh tokens.
 */
const PII_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]'],
  // Card #82 — CNPJ pattern (XX.XXX.XXX/XXXX-XX, com ou sem máscara).
  // Hardening incremental para B2B/nota fiscal futura. Hoje não há endpoint
  // que aceite CNPJ, mas erros que vazem string com CNPJ literal (ex: log
  // de integração contábil) ficam scrubados.
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]'],
  [/sk_(?:live|test)_[A-Za-z0-9]+/g, '[STRIPE_KEY]'],
  [/whsec_[A-Za-z0-9]+/g, '[STRIPE_WHSEC]'],
  [/tbx_pro_[A-Za-z0-9]+/g, '[TBX_PRO]'],
]

function scrubString(value: string): string {
  let out = value
  for (const [pattern, replacement] of PII_STRING_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * beforeSend hook — última linha de defesa antes do evento sair da máquina.
 *
 * Ações (ordem importa):
 *   1. Drop total se environment é `test` (não polui dashboard com vitest)
 *   2. Drop total se URL parse falha OU pathname casa SENSITIVE_URL_REGEX
 *      (fail-closed: sem parse → assume sensível, F1)
 *   3. Scrub recursivo de request.data, extra, contexts, tags
 *   4. Scrub de headers por SSOT
 *   5. Scrub de query_string parse-based (F4)
 *   6. Scrub de exception.values message via regex patterns (F8)
 */
export function beforeSend(
  event: ErrorEvent,
  _hint: EventHint,
): ErrorEvent | null {
  if (env.NODE_ENV === 'test') return null

  // F1 — fail-closed em URL malformada
  const url = event.request?.url
  if (typeof url === 'string') {
    const pathname = safePathname(url)
    if (!pathname) return null
    if (isSensitiveUrl(pathname)) return null
  }

  // Scrub request data (body, query, headers)
  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubObject(
        event.request.data,
      ) as typeof event.request.data
    }
    if (event.request.query_string) {
      event.request.query_string = scrubQueryString(
        String(event.request.query_string),
      )
    }
    if (event.request.headers) {
      const cleanHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
          cleanHeaders[k] = '[REDACTED]'
        } else {
          cleanHeaders[k] = String(v)
        }
      }
      event.request.headers = cleanHeaders
    }
  }

  // Scrub extra, contexts, tags
  if (event.extra) event.extra = scrubObject(event.extra) as typeof event.extra
  if (event.contexts)
    event.contexts = scrubObject(event.contexts) as typeof event.contexts
  if (event.tags) event.tags = scrubObject(event.tags) as typeof event.tags

  // F8 — scrub de exception values (message e stack contém PII real)
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === 'string') {
        ex.value = scrubString(ex.value)
      }
    }
  }
  if (typeof event.message === 'string') {
    event.message = scrubString(event.message)
  }

  // Card #78 — defense in depth: scrub recursivo de event.breadcrumbs.
  // beforeBreadcrumb cobre breadcrumbs novos, mas se um breadcrumb foi
  // criado antes do SDK init terminar, foi injetado por outra integração
  // pré-existente, ou foi mutado post-hoc via SDK externo, chega a
  // beforeSend sem passar pelo scrub individual. Custo baixo (breadcrumbs
  // max=50, depth limitado por scrubObject), benefício invariante.
  if (event.breadcrumbs && Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((bc) => {
      if (!bc || typeof bc !== 'object') return bc
      const scrubbed = { ...bc }
      if (scrubbed.data && typeof scrubbed.data === 'object') {
        scrubbed.data = scrubObject(
          scrubbed.data as Record<string, unknown>,
        ) as typeof scrubbed.data
      }
      if (typeof scrubbed.message === 'string') {
        scrubbed.message = scrubString(scrubbed.message)
      }
      return scrubbed
    })
  }

  return event
}

/**
 * F9 — Allowlist de hosts outbound. Breadcrumbs HTTP para hosts fora da
 * allowlist são dropados em vez de vazar metadata de integrações inesperadas.
 */
const OUTBOUND_HOST_ALLOWLIST = [
  'api.stripe.com',
  'api.resend.com',
  '.upstash.io', // suffix match
] as const

function isAllowlistedHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    return OUTBOUND_HOST_ALLOWLIST.some((host) =>
      host.startsWith('.')
        ? parsed.hostname.endsWith(host)
        : parsed.hostname === host,
    )
  } catch {
    return false
  }
}

/**
 * Inicializa Sentry. Idempotente (chamar múltiplas vezes é no-op após
 * primeira inicialização). Deve ser chamado ANTES de qualquer outro código
 * que possa lançar erros — instrumentação Node precisa ser registrada cedo
 * pra capturar stack traces completos.
 *
 * Retorna `true` se inicializou, `false` se skip (sem DSN em dev/test).
 */
export function initSentry(): boolean {
  if (!env.SENTRY_DSN) return false

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    profilesSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
    // PII protection: opt-in explícito
    sendDefaultPii: false,
    // F9 — cap de breadcrumbs (default 100) reduz superfície
    maxBreadcrumbs: 50,
    integrations: [nodeProfilingIntegration()],
    beforeSend,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) {
        breadcrumb.data = scrubObject(breadcrumb.data) as typeof breadcrumb.data
      }
      // F9 — breadcrumbs HTTP: drop se URL sensível OU host fora da allowlist
      if (
        breadcrumb.category === 'http' ||
        breadcrumb.category === 'fetch' ||
        breadcrumb.category === 'xhr'
      ) {
        const bUrl = breadcrumb.data?.url
        if (typeof bUrl !== 'string') return breadcrumb
        if (isSensitiveUrl(bUrl)) return null
        if (!isAllowlistedHost(bUrl)) return null
        // F9 — scrub query string do outbound
        try {
          const parsed = new URL(bUrl)
          if (parsed.search) {
            parsed.search = scrubQueryString(parsed.search.slice(1))
            if (breadcrumb.data) {
              breadcrumb.data.url = parsed.toString()
            }
          }
        } catch {
          return null
        }
      }
      return breadcrumb
    },
  })

  return true
}

/**
 * Captura exceção com contexto adicional. Atalho tipado para chamadas
 * explícitas no app (ex: error handler do Fastify).
 *
 * F5 — `route` DEVE ser template (`/users/:id`), nunca URL cru com valores.
 * Tag cardinal com PII vaza direto no dashboard (violação LGPD + cardinality
 * explosion). O caller é responsável por passar o template; aqui validamos
 * com regex conservadora e fallback para `'unknown'` se não casar.
 */
const SAFE_ROUTE_TEMPLATE = /^\/[A-Za-z0-9/:_-]*$/

export function captureException(
  error: unknown,
  context?: { reqId?: string; userId?: string; route?: string },
): void {
  const route =
    typeof context?.route === 'string' &&
    SAFE_ROUTE_TEMPLATE.test(context.route)
      ? context.route
      : 'unknown'
  Sentry.captureException(error, {
    tags: {
      reqId: context?.reqId,
      route,
    },
    user: context?.userId ? { id: context.userId } : undefined,
  })
}

// Re-export do namespace Sentry pra uso direto em edge cases.
export { Sentry }

/**
 * Internals expostos apenas para testes unitários. Não usar em produção.
 */
export const __testing = {
  extractFieldName,
  isSensitiveUrl,
  scrubObject,
  safePathname,
  scrubQueryString,
  scrubString,
  isAllowlistedHost,
  SAFE_ROUTE_TEMPLATE,
}
