/**
 * Integration tests — error handler global do app.ts (Card #224).
 *
 * Card #224 muda o branch `if (error instanceof AppError)` do setErrorHandler:
 * ANTES de retornar a resposta, quando `error.statusCode >= 500 && !== 503`, o
 * handler chama `request.log.error(error)` + `captureException(error, {...})`.
 * 503 cai em `else if (=== 503)` → só `request.log.warn` (sem Sentry). 4xx
 * continua SEM Sentry (gate 7.5 / #215: rota pública não vira flood/denial-of-wallet).
 *
 * OBJETIVO testado aqui:
 *   - AppError 5xx não-503 (internal/webhookFailed/...) → Sentry DISPARA (1×) + status + envelope.
 *   - AppError 502 (sintético) → Sentry DISPARA — prova que a fronteira é `>= 500`,
 *     não `=== 500` hardcoded (mutation-resilient).
 *   - AppError 4xx (invalidToken/forbidden/rateLimited/webhookSignatureInvalid)
 *     → Sentry NÃO dispara + status + envelope.
 *   - AppError 503 (serviceBusy/queueUnavailable) → Sentry NÃO dispara (backpressure/
 *     infra = degradação esperada; alerta por TAXA, não por evento). Resolução da
 *     questão de design levantada por @tester/@security na execução #1.
 *   - Erro genérico não-AppError 500 → Sentry dispara (inalterado, branch do fundo).
 *   - Validação Zod 400 → Sentry NÃO dispara (inalterado).
 *
 * Fronteira final do branch AppError: 500/501/502 DISPARAM; 503 NÃO; 4xx NÃO.
 *
 * Estratégia (hermética, exercita o handler REAL, não uma cópia):
 *   buildApp() instala o setErrorHandler real e retorna o app ANTES de ready().
 *   Registramos rotas de teste `/__test__/...` que lançam cada tipo de erro e só
 *   então chamamos ready(). As rotas passam pelo handler global de produção.
 *   Sem DB/Redis: o throw acontece no handler, antes de qualquer I/O. Usamos
 *   `app.inject()` (sem TCP) para determinismo.
 *
 * @owner: @tester
 * @card: #224
 */
/* eslint-disable import/first */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

// Env determinístico — mesma forma do env-stub (NODE_ENV=test, sem segredos reais).
// Inline (não via helper) para casar com o hoisting do vi.mock, padrão do #215.
vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test' as const,
    API_URL: undefined,
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    DIRECT_URL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    REDIS_URL: undefined,
    ASYNC_PROCESSING_ENABLED: false,
    ASYNC_JOB_TTL_HOURS: 24,
    PROCESS_WORKER_TIMEOUT_MS: 300_000,
    STRIPE_SECRET_KEY: 'sk_test_fake_errorhandler_sentry',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_errorhandler_sentry',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_test_brl_monthly',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_test_brl_yearly',
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
    EMAIL_PROVIDER: 'resend' as const,
    RESEND_API_KEY: 're_fake_errorhandler_sentry',
    FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    HEALTH_TIMEOUT_DB_MS: 1000,
    HEALTH_TIMEOUT_REDIS_MS: 500,
    HEALTH_CACHE_TTL_MS: 2000,
    LOG_LEVEL: 'silent',
    SENTRY_DSN: undefined,
    SENTRY_ENVIRONMENT: 'development' as const,
    SENTRY_RELEASE: undefined,
    SENTRY_TRACES_SAMPLE_RATE: 0,
    SENTRY_PROFILES_SAMPLE_RATE: 0,
    SENTRY_AUTH_TOKEN: undefined,
    SENTRY_ORG: undefined,
    SENTRY_PROJECT: undefined,
  },
}))

// captureException é mocado: é o sinal observável do Card #224. O spy prova a
// DIFERENÇA de comportamento por faixa de status (disparou vs não disparou),
// não só o status code. initSentry é no-op (sem DSN em test, mas mocamos por
// segurança contra side-effect de import).
const { captureExceptionSpy } = vi.hoisted(() => ({
  captureExceptionSpy: vi.fn(),
}))
vi.mock('../../src/config/sentry', () => ({
  captureException: captureExceptionSpy,
  initSentry: vi.fn(),
}))

import { buildApp } from '../../src/app'
import { AppError, ErrorCodes, Errors } from '../../src/errors/app-error'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance

/**
 * Mapa path → factory de AppError. Cada rota lança o erro correspondente;
 * o handler global de produção decide o que fazer (Sentry ou não) por faixa.
 * Faixas escolhidas para cobrir explicitamente a fronteira `statusCode >= 500`.
 */
const APP_ERROR_ROUTES: Record<string, () => never> = {
  // 5xx não-503 — falha de SERVIDOR → DEVE alertar (núcleo do #224)
  'internal-500': () => {
    throw Errors.internal()
  },
  'webhook-failed-500': () => {
    throw Errors.webhookFailed()
  },
  'processing-failed-500': () => {
    throw Errors.processingFailed()
  },
  'legal-audit-500': () => {
    throw Errors.legalAuditPersistFailed()
  },
  // 502 sintético — nenhuma factory do projeto usa 502, mas o handler é por
  // FAIXA (`>= 500 && !== 503`), não por código. Prova que a fronteira não é
  // `=== 500` hardcoded (mata o mutante `statusCode === 500`).
  'bad-gateway-502': () => {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      'upstream bad gateway (sintético)',
      502,
    )
  },
  // 4xx — cliente/forgery → NÃO alertar (gate 7.5 / #215)
  'invalid-token-401': () => {
    throw Errors.invalidToken()
  },
  'forbidden-403': () => {
    throw Errors.forbidden()
  },
  'rate-limited-429': () => {
    throw Errors.rateLimited()
  },
  'webhook-sig-400': () => {
    throw Errors.webhookSignatureInvalid()
  },
  // 503 — backpressure (#219)/infra (Redis down). >=500 mas EXCEÇÃO: NÃO alerta
  // (alerta por taxa, não por evento). Resolução da questão de design da exec #1.
  'service-busy-503': () => {
    throw Errors.serviceBusy()
  },
  'queue-unavailable-503': () => {
    throw Errors.queueUnavailable()
  },
}

beforeAll(async () => {
  // buildApp() instala o setErrorHandler real e retorna ANTES de ready() —
  // janela onde ainda dá pra registrar rotas que passam pelo handler global.
  app = await buildApp()

  for (const [path, factory] of Object.entries(APP_ERROR_ROUTES)) {
    app.get(`/__test__/apperror/${path}`, async () => {
      factory()
    })
  }

  // Erro genérico não-AppError (cai no branch do fundo: log.error + Sentry + 500).
  app.get('/__test__/generic-error', async () => {
    throw new Error('boom generic non-apperror')
  })

  // Rota com schema Zod para exercitar o branch hasZodFastifySchemaValidationErrors.
  const typed = app.withTypeProvider<ZodTypeProvider>()
  typed.post(
    '/__test__/zod-validate',
    { schema: { body: z.object({ name: z.string() }) } },
    async () => ({ ok: true }),
  )

  await app.ready()
})

afterAll(async () => {
  try {
    await app?.close()
  } catch {
    // best-effort
  }
})

beforeEach(() => {
  captureExceptionSpy.mockClear()
})

describe('error handler #224 — AppError 5xx não-503 (SERVIDOR) dispara Sentry', () => {
  it.each([
    ['internal-500', 500, 'INTERNAL_ERROR'],
    ['webhook-failed-500', 500, 'WEBHOOK_FAILED'],
    ['processing-failed-500', 500, 'PROCESSING_FAILED'],
    ['legal-audit-500', 500, 'LEGAL_AUDIT_PERSIST_FAILED'],
    // 502 sintético: prova que a fronteira é `>= 500` (faixa), não `=== 500`.
    ['bad-gateway-502', 502, 'INTERNAL_ERROR'],
  ])(
    '%s → status %i, captureException 1×, envelope {error:{code,message}}',
    async (path, status, code) => {
      const res = await app.inject({
        method: 'GET',
        url: `/__test__/apperror/${path}`,
      })

      expect(res.statusCode).toBe(status)
      const body = res.json()
      expect(body.error?.code).toBe(code)
      expect(typeof body.error?.message).toBe('string')
      expect(body.error.message.length).toBeGreaterThan(0)

      // Núcleo do #224: falha de servidor ALERTA, exatamente 1×.
      expect(captureExceptionSpy).toHaveBeenCalledTimes(1)
    },
  )

  it('passa o erro AppError e contexto seguro (reqId + route template) ao Sentry', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test__/apperror/internal-500',
    })

    expect(res.statusCode).toBe(500)
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1)

    const [errArg, ctxArg] = captureExceptionSpy.mock.calls[0]
    // 1º arg é o próprio AppError (não um wrap genérico).
    expect((errArg as Error).name).toBe('AppError')
    expect((errArg as { statusCode: number }).statusCode).toBe(500)
    // Contexto: reqId presente + route é TEMPLATE do Fastify, nunca URL crua
    // com valores (F5 do sentry.ts — anti cardinality/PII).
    expect(ctxArg).toMatchObject({
      reqId: expect.any(String),
      route: '/__test__/apperror/internal-500',
    })
  })
})

describe('error handler #224 — AppError 4xx (CLIENTE) NÃO dispara Sentry', () => {
  it.each([
    ['invalid-token-401', 401, 'INVALID_TOKEN'],
    ['forbidden-403', 403, 'FORBIDDEN'],
    ['rate-limited-429', 429, 'RATE_LIMITED'],
    ['webhook-sig-400', 400, 'WEBHOOK_SIGNATURE_INVALID'],
  ])(
    '%s → status %i, captureException NÃO chamado, envelope {error:{code,message}}',
    async (path, status, code) => {
      const res = await app.inject({
        method: 'GET',
        url: `/__test__/apperror/${path}`,
      })

      expect(res.statusCode).toBe(status)
      const body = res.json()
      expect(body.error?.code).toBe(code)
      expect(typeof body.error?.message).toBe('string')

      // Gate 7.5 / #215: 4xx é cliente/forgery → Sentry SILENCIOSO.
      expect(captureExceptionSpy).not.toHaveBeenCalled()
    },
  )
})

/**
 * 503 — EXCEÇÃO consciente à regra `>= 500` (resolução da questão de design da
 * execução #1, decidida com @security).
 *
 * `serviceBusy` (#219, backpressure do cap de concorrência) e `queueUnavailable`
 * (Card 6.3, Redis/BullMQ down) são AppError **503**: DEGRADAÇÃO ESPERADA, não
 * exceção de código. Capturá-las por-evento afogaria os 500 reais no SLI e
 * queimaria quota do Sentry sob burst legítimo — o MESMO risco de alert fatigue
 * que motivou tirar 4xx no #215. O sinal de capacidade/infra vem por TAXA
 * (metric `concurrency.rejected` + /health/ready), não por evento.
 *
 * Código (app.ts): `if (>= 500 && !== 503) captureException; else if (=== 503) log.warn`.
 * Estes testes travam: 503 → status correto + envelope + Sentry SILENCIOSO. Se
 * alguém reverter para `>= 500` puro, quebram de propósito.
 */
describe('error handler #224 — AppError 503 (backpressure/infra) NÃO dispara Sentry', () => {
  it.each([
    ['service-busy-503', 'SERVICE_BUSY'],
    ['queue-unavailable-503', 'QUEUE_UNAVAILABLE'],
  ])(
    '%s → status 503, captureException NÃO chamado (log-only), envelope correto',
    async (path, code) => {
      const res = await app.inject({
        method: 'GET',
        url: `/__test__/apperror/${path}`,
      })

      expect(res.statusCode).toBe(503)
      const body = res.json()
      expect(body.error?.code).toBe(code)
      expect(typeof body.error?.message).toBe('string')
      // 503 é exceção à regra >= 500: degradação esperada → sem Sentry.
      expect(captureExceptionSpy).not.toHaveBeenCalled()
    },
  )
})

describe('error handler #224 — não-AppError e validação (inalterados)', () => {
  it('erro genérico (não-AppError) → 500 INTERNAL_ERROR + captureException 1× (branch do fundo)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test__/generic-error',
    })

    expect(res.statusCode).toBe(500)
    const body = res.json()
    expect(body.error?.code).toBe('INTERNAL_ERROR')
    // NODE_ENV=test (não development) → mensagem genérica, não vaza error.message.
    expect(body.error?.message).toBe('Erro interno do servidor')
    expect(body.error?.message).not.toContain('boom generic')

    expect(captureExceptionSpy).toHaveBeenCalledTimes(1)
    const [errArg] = captureExceptionSpy.mock.calls[0]
    expect((errArg as Error).message).toBe('boom generic non-apperror')
  })

  it('validação Zod (body inválido) → 400 VALIDATION_ERROR SEM Sentry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test__/zod-validate',
      payload: { name: 123 }, // tipo errado → ZodError
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error?.code).toBe('VALIDATION_ERROR')
    // Validação é erro de cliente → nunca Sentry (inalterado pelo #224).
    expect(captureExceptionSpy).not.toHaveBeenCalled()
  })
})

describe('error handler #224 — determinismo da fronteira >= 500', () => {
  it('mesma rota 500 chamada 3× dispara Sentry exatamente 1× por request (sem acúmulo/vazamento)', async () => {
    for (let i = 0; i < 3; i++) {
      captureExceptionSpy.mockClear()
      const res = await app.inject({
        method: 'GET',
        url: '/__test__/apperror/internal-500',
      })
      expect(res.statusCode).toBe(500)
      expect(captureExceptionSpy).toHaveBeenCalledTimes(1)
    }
  })

  it('intercalar 4xx e 5xx não vaza estado: 401 silencioso entre dois 500 alertados', async () => {
    captureExceptionSpy.mockClear()
    await app.inject({ method: 'GET', url: '/__test__/apperror/internal-500' })
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1)

    captureExceptionSpy.mockClear()
    await app.inject({
      method: 'GET',
      url: '/__test__/apperror/invalid-token-401',
    })
    expect(captureExceptionSpy).not.toHaveBeenCalled()

    captureExceptionSpy.mockClear()
    await app.inject({
      method: 'GET',
      url: '/__test__/apperror/webhook-failed-500',
    })
    expect(captureExceptionSpy).toHaveBeenCalledTimes(1)
  })
})
