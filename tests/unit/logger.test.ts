/**
 * Unit tests para src/config/logger.ts (Card 2.1).
 *
 * Cobre:
 *   - Redaction de authorization, stripe-signature, tokens, senhas
 *   - maskEmail: formato correto, fail-closed em input inválido
 *   - genReqId: aceita UUID v4 válido incoming, rejeita spoof
 *   - buildLoggerOptions: nível por NODE_ENV, redact paths presentes
 *   - Serializers: req pula headers/body em /auth e /webhooks
 *   - Mutation guard: remover REDACT_PATHS → authorization vaza
 *   - Regression: wildcard pega campo aninhado em profundidade
 *
 * Estratégia: usa pino com stream Writable em memória pra capturar JSON
 * real serializado, não mock do logger. Validação end-to-end.
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import {
  buildLoggerOptions,
  genReqId,
  maskEmail,
  REDACT_PATHS,
} from '../../src/config/logger'

/**
 * Cria um logger pino que escreve em um buffer em memória, usando a mesma
 * config do buildLoggerOptions (sem transport — transport usa worker thread
 * e quebra testes unitários).
 */
function createCapturedLogger(overrides: Partial<pino.LoggerOptions> = {}) {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const str = chunk.toString()
      for (const line of str.split('\n').filter(Boolean)) {
        try {
          lines.push(JSON.parse(line))
        } catch {
          // ignore
        }
      }
      callback()
    },
  })

  const opts = buildLoggerOptions()
  // Remove transport — não funciona com stream customizado
  delete (opts as { transport?: unknown }).transport

  const logger = pino(
    {
      ...opts,
      level: 'trace', // captura tudo nos testes
      ...overrides,
    },
    stream,
  )

  return { logger, lines }
}

// ============================================
// REDACT_PATHS — cobertura dos paths críticos
// ============================================
describe('logger REDACT_PATHS — header sensíveis', () => {
  it('redacts req.headers.authorization', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { req: { headers: { authorization: 'Bearer secret-jwt-xyz' } } },
      'test',
    )
    // Serializer allowlist descarta headers não-explícitos (defense in depth
    // além do redact). Resultado: authorization nunca é logado.
    expect(JSON.stringify(lines[0])).not.toContain('secret-jwt-xyz')
  })

  it('redacts req.headers.cookie', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ req: { headers: { cookie: 'session=abc123' } } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('abc123')
  })

  it('redacts req.headers["stripe-signature"]', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { req: { headers: { 'stripe-signature': 't=12345,v1=forgedsig' } } },
      'test',
    )
    expect(JSON.stringify(lines[0])).not.toContain('forgedsig')
  })

  it('redacts req.headers["x-api-key"]', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { req: { headers: { 'x-api-key': 'sk_live_secretkey' } } },
      'test',
    )
    expect(JSON.stringify(lines[0])).not.toContain('sk_live_secretkey')
  })

  it('redacts res.headers["set-cookie"]', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { res: { headers: { 'set-cookie': 'token=evil; HttpOnly' } } },
      'test',
    )
    expect(JSON.stringify(lines[0])).not.toContain('evil')
  })
})

describe('logger REDACT_PATHS — body de request', () => {
  it('redacts req.body.token', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ req: { body: { token: 'tbx_pro_secret' } } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('tbx_pro_secret')
  })

  it('redacts req.body.jwt', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ req: { body: { jwt: 'eyJhbGciOiJIUzI1NiJ9' } } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('redacts req.body.password', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ req: { body: { password: 'hunter2' } } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('hunter2')
  })

  it('redacts req.body.refresh_token e refreshToken', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      {
        req: {
          body: {
            refresh_token: 'rt_snake_secret',
            refreshToken: 'rt_camel_secret',
          },
        },
      },
      'test',
    )
    const serialized = JSON.stringify(lines[0])
    expect(serialized).not.toContain('rt_snake_secret')
    expect(serialized).not.toContain('rt_camel_secret')
  })
})

describe('logger REDACT_PATHS — wildcards em profundidade', () => {
  it('wildcard *.password pega objeto de 1 nível', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ nested: { password: 'one_level_secret' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('one_level_secret')
  })

  it('CONTRATO: wildcard fast-redact NÃO pega 2+ níveis (documentado)', () => {
    // fast-redact wildcards são 1 nível. Este teste documenta o limite
    // real como contrato — se a lib mudar e passar a pegar 2 níveis, este
    // teste quebra e forçamos reavaliação das expectativas de segurança.
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { user: { credentials: { password: 'two_level_secret' } } },
      'test',
    )
    // Intencionalmente documenta o gap: 2 níveis ESCAPAM do wildcard.
    // Mitigação real: paths literais em req.body.* + defense-in-depth do
    // serializer allowlist para /auth e /webhooks.
    expect(JSON.stringify(lines[0])).toContain('two_level_secret')
  })

  it('wildcard pega jwt em qualquer objeto nomeado', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ ctx: { jwt: 'jwt_to_redact' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('jwt_to_redact')
  })

  it('wildcard pega database_url', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { cfg: { database_url: 'postgresql://user:pass@host/db' } },
      'test',
    )
    expect(JSON.stringify(lines[0])).not.toContain('pass@host')
  })

  it('MUTATION GUARD SEMÂNTICO: authorization em objeto não-req é redacted pelo wildcard', () => {
    // Teste independente do allowlist do serializer: valida que `*.authorization`
    // no REDACT_PATHS efetivamente bloqueia leak em paths arbitrários.
    // Se alguém remover '*.authorization', este teste quebra no act.
    const { logger, lines } = createCapturedLogger()
    logger.info(
      { ctx: { authorization: 'Bearer mutation_test_token' } },
      'test',
    )
    expect(JSON.stringify(lines[0])).not.toContain('mutation_test_token')
  })

  it('MUTATION GUARD SEMÂNTICO: access_token redacted via wildcard', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ oauth: { access_token: 'oauth_access_secret' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('oauth_access_secret')
  })

  it('MUTATION GUARD SEMÂNTICO: client_secret (OAuth) redacted via wildcard', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ cfg: { client_secret: 'oauth_client_shh' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('oauth_client_shh')
  })

  it('MUTATION GUARD: REDACT_PATHS inclui paths críticos', () => {
    // Se alguém remover `req.headers.authorization` do array, este teste
    // pega no act, mas o guard real é semântico: o array tem que conter
    // o path crítico.
    expect(REDACT_PATHS).toContain('req.headers.authorization')
    expect(REDACT_PATHS).toContain('req.headers["stripe-signature"]')
    expect(REDACT_PATHS).toContain('req.body.token')
    expect(REDACT_PATHS).toContain('*.password')
    expect(REDACT_PATHS).toContain('*.access_token')
    expect(REDACT_PATHS).toContain('*.client_secret')
    expect(REDACT_PATHS).toContain('*.private_key')
    expect(REDACT_PATHS).toContain('req.query.token')
    expect(REDACT_PATHS).toContain('req.query.code')
    // Card #77 (@security MÉDIO LGPD): email/phone em query + body + wildcard
    expect(REDACT_PATHS).toContain('req.query.email')
    expect(REDACT_PATHS).toContain('req.query.phone')
    expect(REDACT_PATHS).toContain('req.body.email')
    expect(REDACT_PATHS).toContain('req.body.phone')
    expect(REDACT_PATHS).toContain('*.email')
  })

  it('MUTATION GUARD SEMÂNTICO: email em objeto qualquer é redacted (Card #77 LGPD)', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ user: { email: 'victim@tablix.test' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('victim@tablix.test')
  })

  it('MUTATION GUARD SEMÂNTICO: phone em objeto qualquer é redacted (Card #77 LGPD)', () => {
    const { logger, lines } = createCapturedLogger()
    logger.info({ contact: { phone: '11987654321' } }, 'test')
    expect(JSON.stringify(lines[0])).not.toContain('11987654321')
  })

  it('CONTRATO: pino-redact é case-sensitive — Email/EMAIL escapam de *.email (documentado)', () => {
    // Limitação do fast-redact: paths são case-sensitive. Variações de caixa
    // (Email, EMAIL, Phone) escapam dos wildcards. Mitigação real: payloads
    // gerados pelo nosso código usam lowercase consistente (ex: req.body.email,
    // user.email do Prisma). Este teste documenta o gap como contrato.
    //
    // Defense in depth: scrubObject do Sentry (sentry.ts:151) faz toLowerCase
    // na key antes de comparar com SENSITIVE_FIELD_NAMES — então a barreira
    // do Sentry pega Email/EMAIL, mas o pino direto não.
    //
    // Se um dia adicionarmos input externo que use camelCase/PascalCase,
    // expandir REDACT_PATHS com variantes ou trocar pra logger custom serializer.
    const { logger, lines } = createCapturedLogger()
    logger.info({ user: { Email: 'leaks@x.com', EMAIL: 'also@x.com' } }, 'test')
    // Documenta a limitação: variações de caixa NÃO são pegas pelo *.email
    expect(JSON.stringify(lines[0])).toContain('leaks@x.com')
    expect(JSON.stringify(lines[0])).toContain('also@x.com')
  })
})

// ============================================
// maskEmail
// ============================================
describe('maskEmail', () => {
  it('máscara básica preserva primeira letra do local e domínio', () => {
    expect(maskEmail('maclean@tablix.com.br')).toBe('m***@t***.com.br')
  })

  it('máscara preserva TLD composto', () => {
    expect(maskEmail('user@example.co.uk')).toBe('u***@e***.co.uk')
  })

  it('máscara domínio .com simples', () => {
    expect(maskEmail('john@acme.com')).toBe('j***@a***.com')
  })

  it('fail-closed: input não-string vira [REDACTED]', () => {
    expect(maskEmail(null)).toBe('[REDACTED]')
    expect(maskEmail(undefined)).toBe('[REDACTED]')
    expect(maskEmail(42)).toBe('[REDACTED]')
    expect(maskEmail({ email: 'x@y.com' })).toBe('[REDACTED]')
  })

  it('fail-closed: string que não é email vira [REDACTED]', () => {
    expect(maskEmail('notanemail')).toBe('[REDACTED]')
    expect(maskEmail('missing@tld')).toBe('[REDACTED]')
    expect(maskEmail('@nodomain.com')).toBe('[REDACTED]')
  })

  it('colide intencionalmente: mesma inicial+domínio vira mesma máscara (não reidentificável)', () => {
    // Dois emails diferentes com mesma primeira letra do local-part + mesmo
    // domínio viram strings idênticas. Isto é DESEJADO — impede reidentificação
    // via log diffing.
    expect(maskEmail('maclean@tablix.com.br')).toBe(
      maskEmail('marcos@tablix.com.br'),
    )
  })
})

// ============================================
// genReqId — UUID v4 anti-spoof
// ============================================
describe('genReqId', () => {
  const VALID_UUID_V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

  it('gera UUID v4 novo quando não há header incoming', () => {
    const id = genReqId({ headers: {} })
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('aceita x-request-id incoming se for UUID v4 válido', () => {
    const id = genReqId({ headers: { 'x-request-id': VALID_UUID_V4 } })
    expect(id).toBe(VALID_UUID_V4)
  })

  it('ANTI-SPOOF: rejeita x-request-id não-UUID e gera novo', () => {
    const id = genReqId({ headers: { 'x-request-id': 'attacker-controlled' } })
    expect(id).not.toBe('attacker-controlled')
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('ANTI-SPOOF: rejeita UUID v1/v3/v5 (só v4)', () => {
    // v1 (time-based) — quarto grupo começa com 1
    const uuidV1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    const id = genReqId({ headers: { 'x-request-id': uuidV1 } })
    expect(id).not.toBe(uuidV1)
  })

  it('ANTI-SPOOF: rejeita SQL injection tentativa', () => {
    const attack = "' OR '1'='1"
    const id = genReqId({ headers: { 'x-request-id': attack } })
    expect(id).not.toBe(attack)
  })

  it('lida com header em array (edge case HTTP)', () => {
    const id = genReqId({
      headers: { 'x-request-id': [VALID_UUID_V4, 'extra'] },
    })
    expect(id).toBe(VALID_UUID_V4)
  })

  it('gera UUIDs únicos em chamadas consecutivas', () => {
    const a = genReqId({ headers: {} })
    const b = genReqId({ headers: {} })
    expect(a).not.toBe(b)
  })
})

// ============================================
// buildLoggerOptions — shape e defaults
// ============================================
describe('buildLoggerOptions', () => {
  it('retorna objeto com redact configurado', () => {
    const opts = buildLoggerOptions()
    expect(opts.redact).toBeDefined()
    expect((opts.redact as { paths: string[] }).paths.length).toBeGreaterThan(
      20,
    )
    expect((opts.redact as { censor: string }).censor).toBe('[REDACTED]')
  })

  it('serializer.req pula body em /auth/*', () => {
    const opts = buildLoggerOptions()
    const reqSerializer = (
      opts.serializers as { req: (r: unknown) => Record<string, unknown> }
    ).req
    const result = reqSerializer({
      id: 'abc',
      method: 'POST',
      url: '/auth/login',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'test', 'content-length': '100' },
    })
    expect(result.userAgent).toBeUndefined()
    expect(result.contentLength).toBeUndefined()
    expect(result.url).toBe('/auth/login')
  })

  it('serializer.req pula body em /webhooks/*', () => {
    const opts = buildLoggerOptions()
    const reqSerializer = (
      opts.serializers as { req: (r: unknown) => Record<string, unknown> }
    ).req
    const result = reqSerializer({
      id: 'abc',
      method: 'POST',
      url: '/webhooks/stripe',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'stripe-webhook/1.0' },
    })
    expect(result.userAgent).toBeUndefined()
  })

  it('serializer.req inclui metadata em rota não-sensível', () => {
    const opts = buildLoggerOptions()
    const reqSerializer = (
      opts.serializers as { req: (r: unknown) => Record<string, unknown> }
    ).req
    const result = reqSerializer({
      id: 'abc',
      method: 'GET',
      url: '/process',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'curl/8.0', 'content-length': '42' },
    })
    expect(result.userAgent).toBe('curl/8.0')
    expect(result.contentLength).toBe('42')
    expect(result.url).toBe('/process')
  })

  it('CRLF strip: url com \\r\\n não quebra linhas no terminal (log injection)', () => {
    const opts = buildLoggerOptions()
    const reqSerializer = (
      opts.serializers as { req: (r: unknown) => Record<string, unknown> }
    ).req
    const result = reqSerializer({
      id: 'abc',
      method: 'GET',
      url: '/process\r\nFAKE_LOG_LINE',
      ip: '127.0.0.1',
      headers: { 'user-agent': 'curl\r\nInjected' },
    })
    expect(result.url).not.toContain('\r')
    expect(result.url).not.toContain('\n')
    expect(result.userAgent).not.toContain('\r')
    expect(result.userAgent).not.toContain('\n')
  })

  it('serializer.res retorna apenas statusCode', () => {
    const opts = buildLoggerOptions()
    const resSerializer = (
      opts.serializers as { res: (r: unknown) => Record<string, unknown> }
    ).res
    const result = resSerializer({ statusCode: 200, otherStuff: 'ignored' })
    expect(result).toEqual({ statusCode: 200 })
  })

  it('base metadata inclui service e env', () => {
    const opts = buildLoggerOptions()
    expect(opts.base).toMatchObject({
      service: 'tablix-back',
    })
  })
})

// ============================================
// Integração end-to-end: pino com config real
// ============================================
describe('logger integração — reqId + redact combinados', () => {
  it('linha logada contém reqId do child logger', () => {
    const { logger, lines } = createCapturedLogger()
    const reqId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const child = logger.child({ reqId })
    child.info('processing')
    expect(lines[0].reqId).toBe(reqId)
  })

  it('mesmo com reqId, authorization header continua redacted', () => {
    const { logger, lines } = createCapturedLogger()
    const child = logger.child({ reqId: 'test-id' })
    child.info(
      { req: { headers: { authorization: 'Bearer leak' } } },
      'processing',
    )
    expect(JSON.stringify(lines[0])).not.toContain('Bearer leak')
  })
})
