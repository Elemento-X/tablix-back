/**
 * Integration tests — error handler global do app.ts (Card #215 / gate 7.5).
 *
 * Cobre o branch "client-error 4xx genérico" adicionado no fix-pack #215:
 * um erro do Fastify com `statusCode` 4xx (ex: JSON malformado →
 * FST_ERR_CTP_INVALID_JSON 400) deve devolver o status do CLIENTE com
 * envelope `{ error: { code: 'BAD_REQUEST', message } }` — NUNCA cair no
 * 500 + captureException (Sentry). Sem este branch, um body inválido numa
 * rota pública vira denial-of-wallet / flood de Sentry.
 *
 * Não toca DB: o erro de parse acontece na fase de parsing, antes do
 * preHandler (rate-limit) e do handler. O container do globalSetup sobe mas
 * não é usado por estes testes.
 *
 * @owner: @tester
 * @card: #215
 */
/* eslint-disable import/first */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'

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
    STRIPE_SECRET_KEY: 'sk_test_fake_errorhandler',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake_errorhandler',
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_test_brl_monthly',
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_test_brl_yearly',
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
    EMAIL_PROVIDER: 'resend' as const,
    RESEND_API_KEY: 're_fake_errorhandler',
    FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    JWT_ACCESS_TOKEN_EXPIRES_IN: '15m',
    JWT_REFRESH_TOKEN_EXPIRES_IN: '30d',
    FRONTEND_URL: 'http://localhost:3000',
    HEALTH_TIMEOUT_DB_MS: 1000,
    HEALTH_TIMEOUT_REDIS_MS: 500,
    HEALTH_CACHE_TTL_MS: 2000,
    LOG_LEVEL: undefined,
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

// Espiona captureException: o branch 4xx NÃO pode chamar Sentry. Se o erro
// caísse no genérico (500), captureException seria invocado — o spy prova
// a diferença de comportamento, não só o status code.
const { captureExceptionSpy } = vi.hoisted(() => ({
  captureExceptionSpy: vi.fn(),
}))
vi.mock('../../src/config/sentry', () => ({
  captureException: captureExceptionSpy,
  initSentry: vi.fn(),
}))

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'

let app: TestApp

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await closeTestApp(app)
})

describe('error handler global — branch client-error 4xx (Card #215)', () => {
  it('JSON malformado em rota JSON → 400 BAD_REQUEST, não 500', async () => {
    captureExceptionSpy.mockClear()

    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('content-type', 'application/json')
      // Body sintaticamente inválido: o parser JSON do Fastify lança
      // FST_ERR_CTP_INVALID_JSON (statusCode 400) na fase de parsing,
      // antes do preHandler de rate-limit e do handler.
      .send('{ "currency": "BRL", ')

    // Comportamento esperado do fix #215: status do cliente (400), não 500.
    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('BAD_REQUEST')
    // O branch 4xx retorna ANTES de captureException — Sentry não dispara.
    expect(captureExceptionSpy).not.toHaveBeenCalled()
  })

  it('não vaza detalhe interno do parser na mensagem (information disclosure)', async () => {
    const res = await request(app.server)
      .post('/billing/create-checkout')
      .set('content-type', 'application/json')
      .send('not-even-close-to-json')

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('BAD_REQUEST')
    // Mensagem genérica — sem stack, sem nome do erro do Fastify, sem o body.
    const message: string = res.body.error?.message ?? ''
    expect(message).not.toContain('FST_ERR')
    expect(message).not.toContain('JSON')
    expect(message).not.toContain('not-even-close')
  })
})
