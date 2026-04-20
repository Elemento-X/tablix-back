/**
 * Fastify factory para testes de integração.
 *
 * Uso típico (supertest):
 *
 *   import { buildTestApp, closeTestApp } from '../helpers/app'
 *   let app: Awaited<ReturnType<typeof buildTestApp>>
 *   beforeAll(async () => { app = await buildTestApp() })
 *   afterAll(async () => { await closeTestApp(app) })
 *
 *   it('responde /health/live', async () => {
 *     const res = await request(app.server).get('/health/live')
 *     expect(res.status).toBe(200)
 *   })
 *
 * Requisitos:
 * - `vi.mock('../../src/config/env', ...)` já deve ter sido aplicado (via env-stub).
 * - Se o teste atinge Prisma de verdade, usar helpers/prisma.ts (até Card 3.1b
 *   ficar pronto, o stub falha com mensagem explícita).
 *
 * Não registra listeners TCP — supertest usa `app.server` diretamente.
 *
 * @owner: @tester
 */
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app'

export type TestApp = FastifyInstance

/**
 * Constrói o app Fastify de teste. Chama `app.ready()` para garantir que todos
 * os plugins registraram antes do primeiro request (evita race em supertest).
 */
export async function buildTestApp(): Promise<TestApp> {
  const app = await buildApp()
  await app.ready()
  return app
}

/**
 * Fecha o app e libera handles (evita vazamento de workers/timers em suíte).
 * Silencioso em caso de double-close — testes costumam chamar em afterEach + afterAll.
 */
export async function closeTestApp(app: TestApp | undefined): Promise<void> {
  if (!app) return
  try {
    await app.close()
  } catch {
    // swallow — afterAll é best-effort
  }
}
