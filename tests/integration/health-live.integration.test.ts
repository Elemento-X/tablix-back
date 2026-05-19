/**
 * Smoke test de integração — GET /health/live.
 *
 * Objetivo: validar que a FACTORY do app (buildApp) sobe sem tocar DB/Redis
 * usando apenas env-stub + mocks. É o canário que falha primeiro se o scaffold
 * de testes quebra.
 *
 * Por que /health/live?
 * - Liveness probe deliberadamente não depende de Prisma nem Upstash.
 * - Handler é síncrono e determinístico (`{ data: { status: 'ok' } }`).
 * - Sem rate limit (ver health.routes.ts), então não precisamos mockar limiter.
 *
 * Este teste vale como gate do scaffold — NÃO cobre o contrato completo de
 * health (isso é Card 3.3). Deleção ou skip aqui = problema no scaffold.
 *
 * @owner: @tester
 */
/* eslint-disable import/first */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'

// Mock env ANTES de qualquer import que consuma `env` (buildApp cai em app.ts
// → config/env, logger, sentry, stripe, redis...). vi.mock é hoisted para o
// topo do arquivo pelo vitest, então o import abaixo já vê o mock aplicado.
vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'

describe('GET /health/live (smoke integration)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await buildTestApp()
  })

  afterAll(async () => {
    await closeTestApp(app)
  })

  it('responde 200 com envelope { data: { status: "ok" } }', async () => {
    const res = await request(app.server).get('/health/live')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { status: 'ok' } })
  })

  it('define Cache-Control: no-store para evitar cache em CDN', async () => {
    const res = await request(app.server).get('/health/live')

    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('expõe x-request-id para rastreabilidade', async () => {
    const res = await request(app.server).get('/health/live')

    expect(res.headers['x-request-id']).toBeDefined()
    expect(typeof res.headers['x-request-id']).toBe('string')
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0)
  })
})
