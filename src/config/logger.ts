/**
 * Card 2.1 — Logger estruturado com pino.
 *
 * Single source of truth para configuração de logging. Resolve 3 problemas
 * do config legado (inline em app.ts):
 *
 *   1. Zero redaction → authorization/stripe-signature/tokens vazavam em dev
 *      e potencialmente em staging (LGPD/A09).
 *   2. Zero request correlation → impossível traçar request end-to-end em
 *      incidente.
 *   3. Zero padronização → formato de log variava por ambiente, quebrando
 *      log aggregator (Datadog/Logtail) downstream.
 *
 * Esta config é consumida pelo buildApp() e pelo Card 2.2 (Sentry — pino
 * transport reusa REDACT_PATHS como fonte única).
 *
 * Security rules:
 *   - NUNCA logar body de /auth/* ou /webhooks/stripe (serializer req pula)
 *   - Email em qualquer profundidade é mascarado, não redacted (debug-friendly)
 *   - reqId incoming só é aceito se for UUID válido (anti-spoof de correlação)
 *
 * @owner: @security + @tester
 */
import crypto from 'node:crypto'
import type { FastifyLoggerOptions, FastifyRequest } from 'fastify'
import type { LoggerOptions } from 'pino'
import { env } from './env'

/**
 * Paths do pino-redact. Casa com `sensitiveFields` do projeto Sentry
 * (ver memory/mcps_configured.md) para garantir uma única fonte da verdade.
 *
 * Sintaxe:
 *   - `*.x` → qualquer objeto com propriedade x em qualquer profundidade
 *     (pino usa fast-redact, wildcards explícitos)
 *   - `req.headers["x-y"]` → path literal com bracket notation
 *
 * IMPORTANTE: adicionar novo campo sensível? Espelhe em:
 *   (1) aqui
 *   (2) Sentry project config (mcp__sentry__update_project)
 *   (3) .claude/rules/security.md seção "Logs e dados sensíveis"
 */
export const REDACT_PATHS: readonly string[] = [
  // Headers HTTP sensíveis
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'req.headers["x-api-key"]',
  'req.headers["x-refresh-token"]',
  'res.headers["set-cookie"]',
  // Body paths comuns (nível raiz de req.body)
  'req.body.token',
  'req.body.jwt',
  'req.body.password',
  'req.body.refresh_token',
  'req.body.refreshToken',
  'req.body.secret',
  'req.body.access_token',
  'req.body.accessToken',
  'req.body.id_token',
  'req.body.idToken',
  'req.body.api_key',
  'req.body.apiKey',
  'req.body.client_secret',
  'req.body.clientSecret',
  // Query params sensíveis (OAuth callback, magic link)
  'req.query.token',
  'req.query.code',
  'req.query.access_token',
  'req.query.id_token',
  // Wildcards defensivos — pegam 1 nível de profundidade (limitação fast-redact)
  '*.password',
  '*.secret',
  '*.jwt',
  '*.authorization',
  '*.refresh_token',
  '*.refreshToken',
  '*.access_token',
  '*.accessToken',
  '*.id_token',
  '*.idToken',
  '*.api_key',
  '*.apiKey',
  '*.client_secret',
  '*.clientSecret',
  '*.private_key',
  '*.privateKey',
  '*.session',
  '*.sessionId',
  '*.session_id',
  '*.csrf',
  '*.csrfToken',
  '*.cpf',
  '*.phone',
  '*.stripe_customer_id',
  '*.stripe_subscription_id',
  '*.stripe_webhook_secret',
  '*.database_url',
  '*.direct_url',
  '*.redis_url',
  '*.upstash_redis_rest_token',
  '*.resend_api_key',
  '*.sentry_auth_token',
  '*.github_token',
  '*.jti',
  '*.fingerprint',
  '*.tbx_pro',
  '*.token_pro',
  '*.tokenPro',
] as const

/**
 * UUID v4 regex estrito. Aceita apenas o formato `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`.
 *
 * Por que estrito: aceitar string livre como reqId permitiria atacante
 * injetar IDs que colidam com os nossos logs, confundindo correlation em
 * incident response. UUIDv4 tem entropia suficiente (122 bits) pra anti-colisão.
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Máscara de email preservando debugabilidade sem reidentificar.
 *
 * Exemplo: `maclean@tablix.com.br` → `m***@t***.com.br`
 *
 * Mantém primeira letra do local-part, primeira letra do domínio, e TLD
 * completo. Suficiente pra um engenheiro saber "é o Maclean no Tablix" sem
 * virar PII.
 *
 * Se o input não parecer email, retorna `[REDACTED]` — fail-closed.
 */
export function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return '[REDACTED]'
  const match = /^([^@]+)@([^@.]+)\.(.+)$/.exec(value)
  if (!match) return '[REDACTED]'
  const [, local, domain, tld] = match
  return `${local[0]}***@${domain[0]}***.${tld}`
}

/**
 * Gera request ID: aceita header `x-request-id` incoming se for UUID v4
 * válido, senão gera novo UUID v4.
 *
 * Assina o tipo Fastify esperado (`string`) em vez de `string | undefined` —
 * `crypto.randomUUID()` sempre retorna UUID v4 válido em Node 20+.
 */
export function genReqId(req: {
  headers: Record<string, string | string[] | undefined>
}): string {
  const incoming = req.headers['x-request-id']
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming
  if (typeof candidate === 'string' && UUID_V4_REGEX.test(candidate)) {
    return candidate
  }
  return crypto.randomUUID()
}

/**
 * URL prefixes cujos body NUNCA devem ser logados, nem sanitizados —
 * pulo total pra defense in depth. Security rule explícita.
 */
const SENSITIVE_URL_PREFIXES = ['/auth', '/webhooks'] as const

function isSensitiveUrl(url: string | undefined): boolean {
  if (!url) return false
  return SENSITIVE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/**
 * Sanitize CRLF em strings que vão para log. Defense in depth: pino emite
 * JSON (newline-delimited) que já escapa `\n`, mas pino-pretty em dev renderiza
 * valores como texto — sem strip, atacante que controla user-agent/url pode
 * quebrar linhas no terminal do dev durante triage (log forging / CWE-117).
 */
function stripCRLF(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value
  return value.replace(/[\r\n]/g, '\\n')
}

/**
 * Retorna as opções de logger do Fastify para o NODE_ENV atual.
 * Single call site: buildApp() em src/app.ts.
 */
export function buildLoggerOptions(): FastifyLoggerOptions & LoggerOptions {
  const levelDefaults = {
    production: 'info',
    development: 'debug',
    test: 'fatal', // silent em test pra não poluir saída do vitest
  } as const

  const level = env.LOG_LEVEL ?? levelDefaults[env.NODE_ENV]

  const base: FastifyLoggerOptions & LoggerOptions = {
    level,
    base: {
      service: 'tablix-back',
      env: env.NODE_ENV,
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      // Nível como string (padrão observability stack)
      level(label) {
        return { level: label }
      },
    },
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
      remove: false,
    },
    serializers: {
      req(request: FastifyRequest) {
        const out: Record<string, unknown> = {
          id: request.id,
          method: request.method,
          url: stripCRLF(request.url),
          remoteAddress: request.ip,
        }
        // Defense in depth: body de auth/webhook jamais aparece, nem passado
        // pelo redact. O redact é correto, mas "nunca logar" > "logar redacted".
        if (!isSensitiveUrl(request.url) && request.headers) {
          // Headers não-sensíveis explícitos (allowlist) + CRLF strip
          out.userAgent = stripCRLF(
            request.headers['user-agent'] as string | undefined,
          )
          out.contentLength = request.headers['content-length']
        }
        return out
      },
      res(reply: { statusCode: number }) {
        return { statusCode: reply.statusCode }
      },
    },
  }

  if (env.NODE_ENV === 'development') {
    base.transport = {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
        colorize: true,
      },
    }
  }

  return base
}
