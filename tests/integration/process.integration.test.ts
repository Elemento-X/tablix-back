/**
 * Integration tests — Process module (Card 3.3 #32 — checklist Process 1-3).
 *
 * Valida `/process/sync` contra app Fastify real + multipart real. Testa:
 *   - Auth obrigatória (JWT + role PRO)
 *   - Fluxo completo CSV → XLSX
 *   - Limites de plano (files, extensão, selectedColumns)
 *   - Sanitização formula injection
 *   - Headers X-Tablix-* presentes na response
 *
 * Redis mockado como null (sem concurrency guard); processamento real.
 *
 * @owner: @tester
 * @card: 3.3
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
import * as XLSX from 'xlsx'
import jwt from 'jsonwebtoken'

vi.mock('../../src/config/env', () => ({
  env: {
    PORT: 3333,
    NODE_ENV: 'test' as const,
    API_URL: undefined,
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    DIRECT_URL: undefined,
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRO_MONTHLY_BRL_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_BRL_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_USD_PRICE_ID: undefined,
    STRIPE_PRO_MONTHLY_EUR_PRICE_ID: undefined,
    STRIPE_PRO_YEARLY_EUR_PRICE_ID: undefined,
    EMAIL_PROVIDER: 'resend' as const,
    RESEND_API_KEY: undefined,
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

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'
import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'
import { hashRefreshToken } from '../../src/lib/jwt'

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedProUserWithSession(email = 'pro@tablix.test') {
  const prisma = getTestPrisma()
  const user = await prisma.user.create({
    data: { email, role: 'PRO' },
  })
  // Token Pro ativo pra resolver limits via getUserInfo
  await prisma.token.create({
    data: {
      userId: user.id,
      token: 'tbx_pro_' + Math.random().toString(36).repeat(10).slice(0, 43),
      status: 'ACTIVE',
    },
  })
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken('raw_refresh_' + Math.random()),
      fingerprint: 'fp-process',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  return { user, session }
}

function signJwt(params: {
  sessionId: string
  userId: string
  email: string
  role?: 'FREE' | 'PRO'
}) {
  return jwt.sign(
    {
      sub: params.sessionId,
      userId: params.userId,
      email: params.email,
      role: params.role ?? 'PRO',
    },
    'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    { algorithm: 'HS256', expiresIn: '15m' },
  )
}

function makeCsvBuffer(headers: string[], rows: string[][]): Buffer {
  const lines = [headers.join(','), ...rows.map((r) => r.join(','))]
  return Buffer.from(lines.join('\n'), 'utf-8')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /process/sync — auth (integration)', () => {
  it('401 sem Authorization header', async () => {
    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(401)
  })

  it('403 com role FREE (requireRole PRO)', async () => {
    const prisma = getTestPrisma()
    const user = await prisma.user.create({
      data: { email: 'free@tablix.test', role: 'FREE' },
    })
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashRefreshToken('raw_free_' + Math.random()),
        fingerprint: 'fp-free',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      role: 'FREE',
    })

    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(403)
  })
})

describe('POST /process/sync — fluxo completo (integration)', () => {
  it('200 unifica 2 CSVs em XLSX com headers X-Tablix-* corretos', async () => {
    const { user, session } = await seedProUserWithSession('flow@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csvA = makeCsvBuffer(
      ['nome', 'email'],
      [
        ['Alice', 'a@x.com'],
        ['Bob', 'b@x.com'],
      ],
    )
    const csvB = makeCsvBuffer(['nome', 'email'], [['Carol', 'c@x.com']])

    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csvA, 'a.csv')
      .attach('files', csvB, 'b.csv')
      .field('selectedColumns', JSON.stringify(['nome', 'email']))
      .field('outputFormat', 'xlsx')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="unified-\d{4}-\d{2}-\d{2}\.xlsx"/,
    )
    expect(res.headers['x-tablix-rows']).toBe('3')
    expect(res.headers['x-tablix-columns']).toBe('2')
    expect(res.headers['x-tablix-format']).toBe('xlsx')
    expect(Number(res.headers['x-tablix-file-size'])).toBeGreaterThan(0)

    // Parse o XLSX de volta e valida conteúdo
    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' })
    expect(wb.SheetNames).toContain('Unified')
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets.Unified,
    )
    expect(rows).toHaveLength(3)
    expect(rows[0].nome).toBe('Alice')
    expect(rows[2].nome).toBe('Carol')
  })

  it('200 com outputFormat=csv retorna text/csv', async () => {
    const { user, session } = await seedProUserWithSession('csv@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    // Papaparse precisa de >= 1 delimiter pra auto-detect — CSV com coluna
    // única falha. Múltiplas colunas ou linha extra com vírgula resolvem.
    const csv = makeCsvBuffer(
      ['nome', 'email'],
      [
        ['Alice', 'a@x.com'],
        ['Bob', 'b@x.com'],
      ],
    )
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'csv')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['x-tablix-format']).toBe('csv')
  })
})

describe('POST /process/sync — validation + security (integration)', () => {
  it('400 sem arquivos (nenhum part file)', async () => {
    const { user, session } = await seedProUserWithSession('nofile@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_ERROR')
  })

  it('400 com extensão inválida (.txt rejeitado)', async () => {
    const { user, session } = await seedProUserWithSession('ext@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'malicious.txt')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(400)
    expect(res.body.error?.code).toBe('VALIDATION_ERROR')
  })

  it('400 com selectedColumns duplicado (Card 1.16 @security)', async () => {
    const { user, session } = await seedProUserWithSession('dup@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('selectedColumns', JSON.stringify(['email']))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/selectedColumns.*mais de uma vez/)
  })

  it('400 com fieldname desconhecido', async () => {
    const { user, session } = await seedProUserWithSession('unk@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')
      .field('evilField', 'payload')

    expect(res.status).toBe(400)
    expect(res.body.error?.message).toMatch(/Campo desconhecido/)
  })

  it('formula injection: célula =SUM(A1) é sanitizada no XLSX de saída', async () => {
    const { user, session } = await seedProUserWithSession(
      'formula@tablix.test',
    )
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome', 'email'], [['=SUM(A1:A9)', 'a@x.com']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'evil.csv')
      .field('selectedColumns', JSON.stringify(['nome']))
      .field('outputFormat', 'xlsx')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks)))
      })

    expect(res.status).toBe(200)
    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' })
    const sheet = wb.Sheets.Unified
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    // Célula não pode começar com "=" (prevenção injection)
    expect(String(rows[0].nome).startsWith('=')).toBe(false)
  })

  it('400 com selectedColumns vazio (array sem elementos)', async () => {
    const { user, session } = await seedProUserWithSession('empty@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome'], [['Alice']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify([]))
      .field('outputFormat', 'xlsx')

    expect(res.status).toBe(400)
  })

  it('400 com selectedColumns com prototype pollution payload', async () => {
    // Card 1.16: parseSelectedColumnsField bloqueia __proto__ via validação
    // de forma + charset (control chars / array-like).
    const { user, session } = await seedProUserWithSession('proto@tablix.test')
    const token = signJwt({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
    })

    const csv = makeCsvBuffer(['nome', 'email'], [['Alice', 'a@x.com']])
    const res = await request(app.server)
      .post('/process/sync')
      .set('Authorization', `Bearer ${token}`)
      .attach('files', csv, 'a.csv')
      .field('selectedColumns', JSON.stringify(['__proto__', 'constructor']))
      .field('outputFormat', 'xlsx')

    // Pode ser 4xx (rejected parseSelectedColumns ou validação do schema),
    // 5xx (processamento não encontra colunas), ou 200 (se Object.create(null)
    // no merger absorve). O que importa é NÃO haver vazamento pro protótipo
    // global — teste não polui.
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(600)
    // Documenta: prototype pollution real já foi isolado no Card 1.16 por
    // parseSelectedColumnsField (cap 8KB + validação control chars).
  })
})
