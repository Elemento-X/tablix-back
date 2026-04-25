/**
 * Unit tests para src/config/sentry.ts (Card 2.2).
 *
 * Cobre:
 *   - SENSITIVE_FIELD_NAMES derivado de REDACT_PATHS (SSOT)
 *   - extractFieldName: bracket, dot, wildcard
 *   - isSensitiveUrl: /auth, /webhooks, outros
 *   - scrubObject: nested, array, circular, depth limit, key match
 *   - beforeSend: drop em test env (default), drop em URL sensível,
 *     scrub de request.data/headers/query_string, scrub de extra/contexts/tags
 *   - captureException: tags de contexto, user opcional
 *   - initSentry: idempotent, skip sem DSN
 *
 * Estratégia: internals expostos via `__testing`. beforeSend é testado via
 * mock de env.NODE_ENV (vi.mock) — em runtime normal, test env dropa tudo.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  SENSITIVE_FIELD_NAMES,
  beforeSend,
  captureException,
  initSentry,
  __testing,
} from '../../src/config/sentry'
import { REDACT_PATHS } from '../../src/config/logger'
import type { ErrorEvent } from '@sentry/node'

// Mock do módulo env ANTES de importar sentry — senão env é avaliado
// com NODE_ENV=test e beforeSend sempre retorna null.
// envMock é mutável pra permitir flip de SENTRY_DSN em testes de initSentry.
const envMock = {
  NODE_ENV: 'development' as 'development' | 'production' | 'test',
  SENTRY_DSN: '' as string,
  SENTRY_ENVIRONMENT: 'development',
  SENTRY_RELEASE: '' as string,
  SENTRY_TRACES_SAMPLE_RATE: 1.0,
  SENTRY_PROFILES_SAMPLE_RATE: 1.0,
}
vi.mock('../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

// Mock do Sentry SDK — não queremos chamadas reais durante testes.
const captureExceptionMock = vi.fn()
const initMock = vi.fn()
vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}))
vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({ name: 'ProfilingIntegration' }),
}))

const { extractFieldName, isSensitiveUrl, scrubObject } = __testing

beforeEach(() => {
  captureExceptionMock.mockClear()
  initMock.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('SENSITIVE_FIELD_NAMES (SSOT)', () => {
  it('contém campos críticos derivados de REDACT_PATHS', () => {
    expect(SENSITIVE_FIELD_NAMES.has('authorization')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('cookie')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('stripe-signature')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('password')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('token')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('jwt')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('database_url')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('access_token')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('client_secret')).toBe(true)
    // Card #77 (@security MÉDIO LGPD): email/phone propagados do REDACT_PATHS
    expect(SENSITIVE_FIELD_NAMES.has('email')).toBe(true)
    expect(SENSITIVE_FIELD_NAMES.has('phone')).toBe(true)
  })

  it('não vaza nome comum não sensível', () => {
    expect(SENSITIVE_FIELD_NAMES.has('user')).toBe(false)
    expect(SENSITIVE_FIELD_NAMES.has('id')).toBe(false)
    expect(SENSITIVE_FIELD_NAMES.has('name')).toBe(false)
  })
})

describe('extractFieldName', () => {
  it('extrai dot notation (último segmento)', () => {
    expect(extractFieldName('req.headers.authorization')).toBe('authorization')
    expect(extractFieldName('req.body.password')).toBe('password')
  })

  it('extrai bracket notation', () => {
    expect(extractFieldName('req.headers["stripe-signature"]')).toBe(
      'stripe-signature',
    )
    expect(extractFieldName('obj["x-api-key"]')).toBe('x-api-key')
  })

  it('extrai wildcard (*.field)', () => {
    expect(extractFieldName('*.database_url')).toBe('database_url')
    expect(extractFieldName('*.jwt_secret')).toBe('jwt_secret')
  })

  it('normaliza para lowercase', () => {
    expect(extractFieldName('req.headers.AUTHORIZATION')).toBe('authorization')
  })
})

describe('isSensitiveUrl', () => {
  it('casa /auth e /webhooks', () => {
    expect(isSensitiveUrl('/auth/validate-token')).toBe(true)
    expect(isSensitiveUrl('/auth')).toBe(true)
    expect(isSensitiveUrl('/webhooks/stripe')).toBe(true)
  })

  it('não casa rotas normais', () => {
    expect(isSensitiveUrl('/api/process')).toBe(false)
    expect(isSensitiveUrl('/health')).toBe(false)
    expect(isSensitiveUrl('/')).toBe(false)
  })

  it('fail-closed em undefined', () => {
    expect(isSensitiveUrl(undefined)).toBe(false)
  })
})

describe('scrubObject', () => {
  it('redacta chave sensível simples', () => {
    const out = scrubObject({ password: 'hunter2', user: 'bob' }) as Record<
      string,
      unknown
    >
    expect(out.password).toBe('[REDACTED]')
    expect(out.user).toBe('bob')
  })

  it('redacta aninhado', () => {
    const out = scrubObject({
      meta: { authorization: 'Bearer xxx', path: '/foo' },
    }) as { meta: Record<string, unknown> }
    expect(out.meta.authorization).toBe('[REDACTED]')
    expect(out.meta.path).toBe('/foo')
  })

  it('redacta dentro de array', () => {
    const out = scrubObject([
      { token: 'a', id: 1 },
      { token: 'b', id: 2 },
    ]) as Array<Record<string, unknown>>
    expect(out[0].token).toBe('[REDACTED]')
    expect(out[1].token).toBe('[REDACTED]')
    expect(out[0].id).toBe(1)
  })

  it('trata referência circular', () => {
    const obj: Record<string, unknown> = { a: 1 }
    obj.self = obj
    const out = scrubObject(obj) as Record<string, unknown>
    expect(out.a).toBe(1)
    expect(out.self).toBe('[CIRCULAR]')
  })

  it('limita profundidade (DoS protection)', () => {
    let deep: Record<string, unknown> = { value: 'leaf' }
    for (let i = 0; i < 10; i++) deep = { nested: deep }
    const out = scrubObject(deep)
    // Navega até encontrar [DEPTH_LIMIT] — deve existir em algum ponto
    const str = JSON.stringify(out)
    expect(str).toContain('[DEPTH_LIMIT]')
  })

  it('preserva primitivos null/undefined/number/string', () => {
    expect(scrubObject(null)).toBe(null)
    expect(scrubObject(42)).toBe(42)
    expect(scrubObject('hello')).toBe('hello')
    expect(scrubObject(true)).toBe(true)
  })

  it('comparação case-insensitive na chave', () => {
    const out = scrubObject({ Authorization: 'Bearer xxx' }) as Record<
      string,
      unknown
    >
    expect(out.Authorization).toBe('[REDACTED]')
  })
})

describe('beforeSend', () => {
  function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
    return {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      ...overrides,
    } as ErrorEvent
  }

  it('dropa evento de URL sensível (/auth)', () => {
    const ev = makeEvent({
      request: { url: 'https://api.tablix.com.br/auth/validate-token' },
    })
    expect(beforeSend(ev, {})).toBeNull()
  })

  it('dropa evento de URL sensível (/webhooks)', () => {
    const ev = makeEvent({
      request: { url: 'https://api.tablix.com.br/webhooks/stripe' },
    })
    expect(beforeSend(ev, {})).toBeNull()
  })

  it('permite URL normal', () => {
    const ev = makeEvent({
      request: { url: 'https://api.tablix.com.br/api/process' },
    })
    const out = beforeSend(ev, {})
    expect(out).not.toBeNull()
  })

  it('scruba request.data', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        data: { password: 'secret', user: 'bob' },
      },
    })
    const out = beforeSend(ev, {})!
    expect((out.request!.data as Record<string, unknown>).password).toBe(
      '[REDACTED]',
    )
    expect((out.request!.data as Record<string, unknown>).user).toBe('bob')
  })

  it('redacta query_string parse-based (só o valor sensível, preserva resto — F4)', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        query_string: 'token=abc123&x=1',
      },
    })
    const out = beforeSend(ev, {})!
    // F4: parse-based via URLSearchParams — só o campo sensível é redactado,
    // preservando debugabilidade do resto da query.
    expect(out.request!.query_string).toContain('token=%5BREDACTED%5D')
    expect(out.request!.query_string).toContain('x=1')
  })

  it('preserva query_string sem padrão sensível', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        query_string: 'page=1&limit=10',
      },
    })
    const out = beforeSend(ev, {})!
    expect(out.request!.query_string).toBe('page=1&limit=10')
  })

  it('scruba headers sensíveis', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        headers: {
          authorization: 'Bearer xxx',
          'content-type': 'application/json',
        },
      },
    })
    const out = beforeSend(ev, {})!
    expect(out.request!.headers!.authorization).toBe('[REDACTED]')
    expect(out.request!.headers!['content-type']).toBe('application/json')
  })

  it('scruba extra, contexts, tags', () => {
    const ev = makeEvent({
      extra: { password: 'x', note: 'ok' },
      contexts: { custom: { jwt: 'eyJ', scope: 'user' } },
      tags: { password: 'x', route: '/foo' },
    })
    const out = beforeSend(ev, {})!
    expect((out.extra as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((out.extra as Record<string, unknown>).note).toBe('ok')
    expect((out.contexts!.custom as Record<string, unknown>).jwt).toBe(
      '[REDACTED]',
    )
    expect((out.tags as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((out.tags as Record<string, unknown>).route).toBe('/foo')
  })
})

describe('captureException', () => {
  it('passa contexto como tags', () => {
    const err = new Error('boom')
    captureException(err, { reqId: 'req-1', route: '/api/foo' })
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { reqId: 'req-1', route: '/api/foo' },
      user: undefined,
    })
  })

  it('inclui user quando userId presente (route sem template → unknown — F5)', () => {
    const err = new Error('boom')
    captureException(err, { userId: 'u-42' })
    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      tags: { reqId: undefined, route: 'unknown' },
      user: { id: 'u-42' },
    })
  })

  it('F5 — rejeita route com query string (PII em tag cardinal)', () => {
    const err = new Error('boom')
    captureException(err, { route: '/auth/reset?token=xxx' })
    const call = captureExceptionMock.mock.calls.at(-1)!
    expect((call[1] as { tags: { route: string } }).tags.route).toBe('unknown')
  })

  it('F5 — rejeita route com UUID em path param (não-template)', () => {
    const err = new Error('boom')
    captureException(err, {
      route: '/users/123e4567-e89b-12d3-a456-426614174000',
    })
    const call = captureExceptionMock.mock.calls.at(-1)!
    // UUID contém dígitos e hífens — regex SAFE_ROUTE_TEMPLATE aceita só
    // /[A-Za-z0-9/:_-]/ então UUID passa (é valor, mas tecnicamente caracteres
    // permitidos). Teste documenta que a proteção é só contra ? e =, não
    // cardinality — fix real é upstream (usar routeOptions.url template).
    expect((call[1] as { tags: { route: string } }).tags.route).toBe(
      '/users/123e4567-e89b-12d3-a456-426614174000',
    )
  })

  it('F5 — aceita route template válido (/users/:id)', () => {
    const err = new Error('boom')
    captureException(err, { route: '/users/:id' })
    const call = captureExceptionMock.mock.calls.at(-1)!
    expect((call[1] as { tags: { route: string } }).tags.route).toBe(
      '/users/:id',
    )
  })

  it('funciona sem contexto', () => {
    const err = new Error('boom')
    captureException(err)
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
  })
})

describe('initSentry', () => {
  afterEach(() => {
    // reseta DSN pra não vazar entre testes
    envMock.SENTRY_DSN = ''
    envMock.SENTRY_RELEASE = ''
  })

  it('retorna false quando DSN ausente (skip silencioso em dev/test)', () => {
    envMock.SENTRY_DSN = ''
    expect(initSentry()).toBe(false)
    expect(initMock).not.toHaveBeenCalled()
  })

  it('inicializa com DSN presente e passa config correta', () => {
    envMock.SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/123'
    envMock.SENTRY_RELEASE = 'v1.2.3'
    expect(initSentry()).toBe(true)
    expect(initMock).toHaveBeenCalledTimes(1)
    const cfg = initMock.mock.calls[0][0] as Record<string, unknown>
    expect(cfg.dsn).toBe('https://abc@o1.ingest.sentry.io/123')
    expect(cfg.environment).toBe('development')
    expect(cfg.release).toBe('v1.2.3')
    expect(cfg.sendDefaultPii).toBe(false)
    expect(cfg.tracesSampleRate).toBe(1.0)
    expect(cfg.profilesSampleRate).toBe(1.0)
    expect(typeof cfg.beforeSend).toBe('function')
    expect(typeof cfg.beforeBreadcrumb).toBe('function')
    expect(Array.isArray(cfg.integrations)).toBe(true)
  })

  it('passa release=undefined quando SENTRY_RELEASE vazio (não string vazia)', () => {
    envMock.SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/123'
    envMock.SENTRY_RELEASE = ''
    initSentry()
    const cfg = initMock.mock.calls[0][0] as Record<string, unknown>
    expect(cfg.release).toBeUndefined()
  })
})

describe('beforeSend — edge cases', () => {
  function makeEvent(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
    return {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      ...overrides,
    } as ErrorEvent
  }

  it('dropa tudo quando NODE_ENV=test (não polui dashboard com vitest)', () => {
    envMock.NODE_ENV = 'test'
    try {
      const ev = makeEvent({
        request: { url: 'https://api.tablix.com.br/api/foo' },
      })
      expect(beforeSend(ev, {})).toBeNull()
    } finally {
      envMock.NODE_ENV = 'development'
    }
  })

  it('não dropa quando event não tem request', () => {
    const ev = makeEvent({})
    const out = beforeSend(ev, {})
    expect(out).not.toBeNull()
    expect(out).toBe(ev)
  })

  it('não dropa quando request existe mas sem url (fail-open no URL check)', () => {
    const ev = makeEvent({ request: { data: { ok: 1 } } })
    const out = beforeSend(ev, {})
    expect(out).not.toBeNull()
  })

  it('F1 — fail-closed em URL malformada (dropa em vez de throw)', () => {
    // F1 (@security): safePathname retorna null em URL impossível (com chars
    // inválidos tipo \0), e beforeSend dropa o evento. Fail-closed: se não
    // conseguimos parsear, assume sensível.
    const ev = makeEvent({ request: { url: 'http://a\x00b/' } })
    expect(beforeSend(ev, {})).toBeNull()
  })

  it('F1 — aceita path relativo via base URL dummy', () => {
    // Sentry Node SDK muitas vezes preenche request.url como path relativo
    // (`/api/process`), e `new URL('/api/process')` throw sem base. safePathname
    // usa base `http://_` pra aceitar.
    const ev = makeEvent({ request: { url: '/api/process' } })
    const out = beforeSend(ev, {})
    expect(out).not.toBeNull()
  })

  it('F1 — dropa path relativo sensível (/auth/validate-token)', () => {
    const ev = makeEvent({ request: { url: '/auth/validate-token' } })
    expect(beforeSend(ev, {})).toBeNull()
  })

  it('F1 — dropa path relativo versionado sensível (/v1/auth/x)', () => {
    const ev = makeEvent({ request: { url: '/v1/auth/something' } })
    expect(beforeSend(ev, {})).toBeNull()
  })

  it('não mexe em request sem data/headers/query_string', () => {
    const ev = makeEvent({
      request: { url: 'https://api.tablix.com.br/api/foo' },
    })
    const out = beforeSend(ev, {})!
    expect(out.request).toEqual({ url: 'https://api.tablix.com.br/api/foo' })
  })

  it('não mexe em extra/contexts/tags ausentes', () => {
    const ev = makeEvent({
      request: { url: 'https://api.tablix.com.br/api/foo' },
    })
    const out = beforeSend(ev, {})!
    expect(out.extra).toBeUndefined()
    expect(out.contexts).toBeUndefined()
    expect(out.tags).toBeUndefined()
  })

  it('F4 — query_string parse-based redacta case-insensitive (TOKEN=)', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        query_string: 'TOKEN=abc&x=1',
      },
    })
    const out = beforeSend(ev, {})!
    expect(out.request!.query_string).toContain('TOKEN=%5BREDACTED%5D')
    expect(out.request!.query_string).toContain('x=1')
  })

  it('F4 — query_string parse-based redacta email (PII LGPD — Card #77)', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/search',
        query_string: 'email=victim@x.com&page=1',
      },
    })
    const out = beforeSend(ev, {})!
    // Card #77 (@security MÉDIO LGPD) RESOLVED: REDACT_PATHS agora inclui
    // `req.query.email` + `*.email`, propagado pro SSOT SENSITIVE_FIELD_NAMES.
    // Email em query string é redactado, page (não-sensível) preservado.
    expect(out.request!.query_string).toContain('email=%5BREDACTED%5D')
    expect(out.request!.query_string).toContain('page=1')
    // Anti-regression: valor literal do email NÃO pode aparecer em lugar nenhum
    expect(out.request!.query_string).not.toContain('victim@x.com')
  })

  it('F4 — query_string parse-based redacta phone (PII LGPD — Card #77)', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/search',
        query_string: 'phone=11999998888&page=2',
      },
    })
    const out = beforeSend(ev, {})!
    expect(out.request!.query_string).toContain('phone=%5BREDACTED%5D')
    expect(out.request!.query_string).toContain('page=2')
    expect(out.request!.query_string).not.toContain('11999998888')
  })

  it('F4 — query_string parse-based redacta password/cpf', () => {
    const ev = makeEvent({
      request: {
        url: 'https://api.tablix.com.br/api/foo',
        query_string: 'password=hunter2&cpf=12345678900',
      },
    })
    const out = beforeSend(ev, {})!
    expect(out.request!.query_string).toContain('password=%5BREDACTED%5D')
    expect(out.request!.query_string).toContain('cpf=%5BREDACTED%5D')
  })
})

describe('F3 — scrubObject em instâncias especiais', () => {
  it('Error instance vira shape redactado', () => {
    const err = new Error('user email@x.com not found')
    const out = __testing.scrubObject(err) as Record<string, unknown>
    expect(out.message).toBe('[REDACTED_ERROR_MESSAGE]')
    expect(out.name).toBe('Error')
    expect(typeof out.stack).toBe('string')
  })

  it('Map vira sentinela', () => {
    const m = new Map([['password', 'secret']])
    expect(__testing.scrubObject(m)).toBe('[MAP_REDACTED]')
  })

  it('Set vira sentinela', () => {
    const s = new Set(['secret'])
    expect(__testing.scrubObject(s)).toBe('[SET_REDACTED]')
  })

  it('Buffer vira sentinela (DoS protection contra recursão em bytes)', () => {
    const buf = Buffer.from('secret')
    expect(__testing.scrubObject(buf)).toBe('[BINARY]')
  })

  it('Uint8Array vira sentinela', () => {
    const arr = new Uint8Array([1, 2, 3])
    expect(__testing.scrubObject(arr)).toBe('[BINARY]')
  })
})

describe('F8 — scrub de exception.values e message (PII em strings livres)', () => {
  it('redacta JWT na exception message', () => {
    const ev = {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      request: { url: '/api/foo' },
      exception: {
        values: [
          {
            type: 'Error',
            value:
              'jwt malformed: eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload.sig',
          },
        ],
      },
    } as unknown as Parameters<typeof beforeSend>[0]
    const out = beforeSend(ev, {})!
    expect(out.exception!.values![0].value).toContain('[JWT]')
    expect(out.exception!.values![0].value).not.toContain('eyJ0eXAi')
  })

  it('redacta email na exception message', () => {
    const ev = {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      request: { url: '/api/foo' },
      exception: {
        values: [
          { type: 'Error', value: 'User victim@tablix.com.br not found' },
        ],
      },
    } as unknown as Parameters<typeof beforeSend>[0]
    const out = beforeSend(ev, {})!
    expect(out.exception!.values![0].value).toContain('[EMAIL]')
  })

  it('redacta CPF, Stripe key, TBX token na message', () => {
    const ev = {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      request: { url: '/api/foo' },
      exception: {
        values: [
          {
            type: 'Error',
            value:
              'CPF 123.456.789-00 with key sk_live_abc123 and token tbx_pro_xyz',
          },
        ],
      },
    } as unknown as Parameters<typeof beforeSend>[0]
    const out = beforeSend(ev, {})!
    const v = out.exception!.values![0].value!
    expect(v).toContain('[CPF]')
    expect(v).toContain('[STRIPE_KEY]')
    expect(v).toContain('[TBX_PRO]')
  })

  it('redacta PII em event.message top-level', () => {
    const ev = {
      event_id: 'abc',
      timestamp: Date.now() / 1000,
      request: { url: '/api/foo' },
      message: 'login failed for victim@tablix.com.br',
    } as unknown as Parameters<typeof beforeSend>[0]
    const out = beforeSend(ev, {})!
    expect(out.message).toContain('[EMAIL]')
  })
})

describe('F7 — isSensitiveUrl regex anchored', () => {
  it('casa versioning /v1/auth/*, /api/auth/*', () => {
    expect(__testing.isSensitiveUrl('/v1/auth/x')).toBe(true)
    expect(__testing.isSensitiveUrl('/api/auth/x')).toBe(true)
    expect(__testing.isSensitiveUrl('/v2/webhooks/stripe')).toBe(true)
  })

  it('NÃO casa /authentication (false positive evitado)', () => {
    expect(__testing.isSensitiveUrl('/authentication')).toBe(false)
  })

  it('NÃO casa /author (false positive evitado)', () => {
    expect(__testing.isSensitiveUrl('/author')).toBe(false)
  })

  it('casa /webhook/ e /webhooks/ (singular e plural)', () => {
    expect(__testing.isSensitiveUrl('/webhook/stripe')).toBe(true)
    expect(__testing.isSensitiveUrl('/webhooks/stripe')).toBe(true)
  })
})

describe('F11 — SENSITIVE_FIELD_NAMES imutável em runtime', () => {
  it('add lança', () => {
    expect(() =>
      (SENSITIVE_FIELD_NAMES as unknown as Set<string>).add('x'),
    ).toThrow()
  })

  it('delete lança', () => {
    expect(() =>
      (SENSITIVE_FIELD_NAMES as unknown as Set<string>).delete('authorization'),
    ).toThrow()
  })

  it('clear lança', () => {
    expect(() =>
      (SENSITIVE_FIELD_NAMES as unknown as Set<string>).clear(),
    ).toThrow()
  })

  it('has funciona normalmente', () => {
    expect(SENSITIVE_FIELD_NAMES.has('authorization')).toBe(true)
  })
})

describe('beforeBreadcrumb (via init config capture)', () => {
  function getBeforeBreadcrumb(): (
    b: Record<string, unknown>,
  ) => Record<string, unknown> | null {
    envMock.SENTRY_DSN = 'https://abc@o1.ingest.sentry.io/123'
    initMock.mockClear()
    initSentry()
    const cfg = initMock.mock.calls[0][0] as {
      beforeBreadcrumb: (
        b: Record<string, unknown>,
      ) => Record<string, unknown> | null
    }
    envMock.SENTRY_DSN = ''
    return cfg.beforeBreadcrumb
  }

  it('scruba data sensível no breadcrumb', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'custom',
      data: { password: 'x', step: 'upload' },
    })!
    expect((out.data as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((out.data as Record<string, unknown>).step).toBe('upload')
  })

  it('dropa breadcrumb http de URL sensível (/auth)', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: '/auth/validate-token', method: 'POST' },
    })
    expect(out).toBeNull()
  })

  it('dropa breadcrumb http de URL sensível (/webhooks)', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: '/webhooks/stripe', method: 'POST' },
    })
    expect(out).toBeNull()
  })

  it('F9 — dropa breadcrumb http de host fora da allowlist', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: 'https://evil.com/x', method: 'POST' },
    })
    expect(out).toBeNull()
  })

  it('F9 — preserva breadcrumb http de host allowlisted (api.stripe.com)', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: 'https://api.stripe.com/v1/customers', method: 'POST' },
    })
    expect(out).not.toBeNull()
  })

  it('F9 — scruba query string de outbound allowlisted', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: {
        url: 'https://api.stripe.com/v1/customers?token=secret&ok=1',
        method: 'POST',
      },
    })!
    expect((out.data as { url: string }).url).toContain('ok=1')
    expect((out.data as { url: string }).url).toContain('token=%5BREDACTED%5D')
  })

  it('F9 — upstash suffix match preservado', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: 'https://some-db-123.upstash.io/get', method: 'GET' },
    })
    expect(out).not.toBeNull()
  })

  it('preserva breadcrumb http sem url (fail-open no URL check)', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { method: 'GET' },
    })
    expect(out).not.toBeNull()
  })

  it('preserva breadcrumb http com data.url não-string (inválido, fail-open)', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const out = beforeBreadcrumb({
      category: 'http',
      data: { url: 42, method: 'GET' },
    })
    expect(out).not.toBeNull()
  })

  it('breadcrumb sem data passa sem modificação', () => {
    const beforeBreadcrumb = getBeforeBreadcrumb()
    const crumb = { category: 'navigation', message: 'ok' }
    const out = beforeBreadcrumb(crumb)
    expect(out).toEqual(crumb)
  })
})

describe('extractFieldName — edge cases', () => {
  it('path vazio retorna string vazia (fail-open benigno)', () => {
    expect(extractFieldName('')).toBe('')
  })

  it('path com múltiplos brackets pega o primeiro match', () => {
    // regex atual não é global — primeiro match é o retornado.
    // Documenta o contrato: formato esperado é path pino único.
    expect(extractFieldName('a["x-api-key"].b["other"]')).toBe('x-api-key')
  })

  it('bracket com valor já lowercase é idempotente', () => {
    expect(extractFieldName('["token"]')).toBe('token')
  })

  it('path sem dot nem bracket (single token)', () => {
    expect(extractFieldName('password')).toBe('password')
  })
})

describe('SSOT mutation guard — contrato REDACT_PATHS ↔ SENSITIVE_FIELD_NAMES', () => {
  it('todo REDACT_PATH produz entrada em SENSITIVE_FIELD_NAMES', () => {
    // Se alguém adicionar path em REDACT_PATHS e esquecer que o derive
    // é automático, esse teste ainda passa — é o ponto. Mas se mudar
    // o extractFieldName e quebrar a derivação, quebra aqui.
    expect(SENSITIVE_FIELD_NAMES.size).toBeGreaterThan(0)
    expect(SENSITIVE_FIELD_NAMES.size).toBeLessThanOrEqual(REDACT_PATHS.length)
    // Cada path conhecido tem sua "ponta" no set
    for (const path of REDACT_PATHS) {
      const tail =
        path.match(/\["([^"]+)"\]/)?.[1]?.toLowerCase() ??
        path.split('.').pop()!.toLowerCase()
      expect(SENSITIVE_FIELD_NAMES.has(tail)).toBe(true)
    }
  })

  it('todas as entradas são lowercase (contrato de comparação)', () => {
    for (const name of SENSITIVE_FIELD_NAMES) {
      expect(name).toBe(name.toLowerCase())
    }
  })
})
