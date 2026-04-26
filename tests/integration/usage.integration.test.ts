/**
 * Integration tests — Usage module (Card 4.1 #33).
 *
 * Valida GET /usage e GET /limits contra app Fastify real + Postgres real
 * (Testcontainers). Auth real (JWT assinado com TEST_JWT_FAKE_KEY +
 * Session no DB). Sem mock de service.
 *
 * Cobertura:
 *   - /usage: 401 sem JWT, 200 com JWT (current=0 sem registro, current=N
 *     com registro), saturated remaining=0, headers Cache-Control + Vary
 *   - /limits: 401 sem JWT, 200 PRO (PRO_LIMITS + hasWatermark=false),
 *     200 FREE (FREE_LIMITS + hasWatermark=true), headers
 *   - SECURITY: plan resolvido do JWT, não do client (cliente envia
 *     query/body com plan diferente — ignorado)
 *
 * @owner: @tester
 * @card: 4.1 (#33)
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
import request from 'supertest'
import jwt from 'jsonwebtoken'

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'
import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'
import { TEST_JWT_FAKE_KEY } from '../helpers/env-stub'
import { hashRefreshToken } from '../../src/lib/jwt'
import { PRO_LIMITS, FREE_LIMITS } from '../../src/config/plan-limits'
import { getCurrentPeriod } from '../../src/modules/usage/usage.service'

let app: TestApp

beforeAll(async () => {
  app = await buildTestApp()
})

afterAll(async () => {
  await closeTestApp(app)
  await disconnectTestPrisma()
})

beforeEach(async () => {
  await truncateAll()
})

// ============================================
// Helpers
// ============================================
async function seedUserAndSession(params: {
  email: string
  role?: 'FREE' | 'PRO'
}): Promise<{ userId: string; sessionId: string; accessToken: string }> {
  const prisma = getTestPrisma()
  const user = await prisma.user.create({
    data: { email: params.email, role: params.role ?? 'PRO' },
  })
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken('fake-refresh-token-' + user.id),
      fingerprint: 'fp-test-usage',
      expiresAt: new Date(Date.now() + 86_400_000), // 24h
    },
  })
  const accessToken = jwt.sign(
    {
      sub: session.id,
      userId: user.id,
      email: params.email,
      role: params.role ?? 'PRO',
    },
    TEST_JWT_FAKE_KEY,
    { algorithm: 'HS256', expiresIn: '15m' },
  )
  return { userId: user.id, sessionId: session.id, accessToken }
}

async function seedUsage(userId: string, count: number): Promise<void> {
  await getTestPrisma().usage.create({
    data: {
      userId,
      period: getCurrentPeriod(),
      unificationsCount: count,
    },
  })
}

// ============================================
// GET /usage
// ============================================
describe('GET /usage (integration)', () => {
  it('401 sem header Authorization', async () => {
    const res = await request(app.server).get('/usage')
    expect(res.status).toBe(401)
    expect(res.body.error?.code).toBe('UNAUTHORIZED')
  })

  it('200 retorna current=0 quando usuário não tem registro de uso', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'no-usage@tablix.test',
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.current).toBe(0)
    expect(res.body.data.limit).toBe(PRO_LIMITS.unificationsPerMonth)
    expect(res.body.data.remaining).toBe(PRO_LIMITS.unificationsPerMonth)
    expect(res.body.data.period).toMatch(/^\d{4}-\d{2}$/)
    expect(res.body.data.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  })

  it('200 reflete uso existente no período corrente', async () => {
    const { userId, accessToken } = await seedUserAndSession({
      email: 'with-usage@tablix.test',
      role: 'PRO',
    })
    await seedUsage(userId, 7)

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.current).toBe(7)
    expect(res.body.data.remaining).toBe(PRO_LIMITS.unificationsPerMonth - 7)
  })

  it('SATURATED: remaining=0 quando current ultrapassa limit (TOCTOU pré-Card 4.2)', async () => {
    const { userId, accessToken } = await seedUserAndSession({
      email: 'over-limit@tablix.test',
      role: 'PRO',
    })
    await seedUsage(userId, PRO_LIMITS.unificationsPerMonth + 5)

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.current).toBe(PRO_LIMITS.unificationsPerMonth + 5)
    expect(res.body.data.remaining).toBe(0) // saturated, nunca negativo
  })

  it('FREE plan: usa FREE_LIMITS (limit=1)', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'free@tablix.test',
      role: 'FREE',
    })

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.limit).toBe(FREE_LIMITS.unificationsPerMonth)
    expect(res.body.data.remaining).toBe(FREE_LIMITS.unificationsPerMonth)
  })

  it('seta Cache-Control private,no-cache + Vary Authorization', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'headers@tablix.test',
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.headers['cache-control']).toBe('private, no-cache')
    expect(res.headers['vary']).toContain('Authorization')
  })

  it('isolation: usuário A não vê usage do usuário B', async () => {
    const { userId: userA, accessToken: tokenA } = await seedUserAndSession({
      email: 'userA@tablix.test',
      role: 'PRO',
    })
    const { userId: userB } = await seedUserAndSession({
      email: 'userB@tablix.test',
      role: 'PRO',
    })
    await seedUsage(userA, 3)
    await seedUsage(userB, 25)

    const res = await request(app.server)
      .get('/usage')
      .set('Authorization', `Bearer ${tokenA}`)

    expect(res.status).toBe(200)
    expect(res.body.data.current).toBe(3) // do A, não do B
  })
})

// ============================================
// GET /limits
// ============================================
describe('GET /limits (integration)', () => {
  it('401 sem header Authorization', async () => {
    const res = await request(app.server).get('/limits')
    expect(res.status).toBe(401)
    expect(res.body.error?.code).toBe('UNAUTHORIZED')
  })

  it('200 PRO retorna PRO_LIMITS + hasWatermark=false', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'pro@tablix.test',
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/limits')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.plan).toBe('PRO')
    expect(res.body.data.limits.unificationsPerMonth).toBe(
      PRO_LIMITS.unificationsPerMonth,
    )
    expect(res.body.data.limits.maxInputFiles).toBe(PRO_LIMITS.maxInputFiles)
    expect(res.body.data.limits.maxFileSize).toBe(PRO_LIMITS.maxFileSize)
    expect(res.body.data.limits.maxRowsPerFile).toBe(PRO_LIMITS.maxRows)
    expect(res.body.data.limits.maxColumns).toBe(PRO_LIMITS.maxColumns)
    expect(res.body.data.limits.hasWatermark).toBe(false)
  })

  it('200 FREE retorna FREE_LIMITS + hasWatermark=true', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'free@tablix.test',
      role: 'FREE',
    })

    const res = await request(app.server)
      .get('/limits')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.plan).toBe('FREE')
    expect(res.body.data.limits.unificationsPerMonth).toBe(
      FREE_LIMITS.unificationsPerMonth,
    )
    expect(res.body.data.limits.hasWatermark).toBe(true)
  })

  it('seta Cache-Control private,max-age=60 + Vary Authorization', async () => {
    const { accessToken } = await seedUserAndSession({
      email: 'headers-limits@tablix.test',
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/limits')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.headers['cache-control']).toBe('private, max-age=60')
    expect(res.headers['vary']).toContain('Authorization')
  })

  it('SECURITY: plan vem do JWT, query/body com plan diferente é ignorado', async () => {
    // Cria user FREE no DB + JWT com role=FREE
    const { accessToken } = await seedUserAndSession({
      email: 'attacker@tablix.test',
      role: 'FREE',
    })

    // Cliente envia query plan=PRO tentando burlar
    const res = await request(app.server)
      .get('/limits')
      .query({ plan: 'PRO' })
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    // Server resolveu pelo JWT (FREE), não pelo query (PRO)
    expect(res.body.data.plan).toBe('FREE')
    expect(res.body.data.limits.hasWatermark).toBe(true)
  })
})
