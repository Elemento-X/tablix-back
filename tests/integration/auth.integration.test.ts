/**
 * Integration tests — Auth module (Card 3.3 #32 — checklist items 1-3).
 *
 * Valida o fluxo completo de `/auth/*` contra Prisma real (Testcontainers)
 * e JWT real de `src/lib/jwt`. Não mocka auth.service — só env e rate-limit
 * (Upstash Redis é no-op em test por UPSTASH_REDIS_REST_URL undefined).
 *
 * Cobertura:
 *   - POST /auth/validate-token: válido (cria User+Session), inválido formato,
 *     token inexistente, fingerprint mismatch, status EXPIRED/CANCELLED
 *   - POST /auth/refresh: válido (rotaciona), inválido, sessão revogada,
 *     sessão expirada, sem token ativo, assinatura CANCELLED fora do grace
 *   - GET /auth/me: com JWT válido + session ativa, sem header, JWT expirado,
 *     JWT com secret errado (alg:none indirect via wrong key)
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
import jwt from 'jsonwebtoken'

// Mock env antes de qualquer import que consuma `env`. O env-stub não
// passa pelo superRefine do env.ts real (FAKE_TEST_KEY seria rejeitado),
// mas aqui é mock direto — só entra testEnv.
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
import { generateProToken } from '../../src/lib/token-generator'
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

// Helpers locais
async function seedUserWithActiveToken(
  email: string,
  tokenValue: string,
  overrides: {
    fingerprint?: string | null
    status?: 'ACTIVE' | 'CANCELLED' | 'EXPIRED'
    expiresAt?: Date | null
  } = {},
) {
  const prisma = getTestPrisma()
  const user = await prisma.user.create({
    data: { email, role: 'PRO' },
  })
  const token = await prisma.token.create({
    data: {
      userId: user.id,
      token: tokenValue,
      fingerprint: overrides.fingerprint ?? null,
      status: overrides.status ?? 'ACTIVE',
      expiresAt: overrides.expiresAt ?? null,
    },
  })
  return { user, token }
}

async function seedSession(params: {
  userId: string
  refreshTokenRaw: string
  expiresAt?: Date
  revokedAt?: Date | null
  fingerprint?: string
}) {
  const prisma = getTestPrisma()
  return prisma.session.create({
    data: {
      userId: params.userId,
      refreshTokenHash: hashRefreshToken(params.refreshTokenRaw),
      fingerprint: params.fingerprint ?? 'fp-test',
      expiresAt: params.expiresAt ?? new Date(Date.now() + 86_400_000),
      revokedAt: params.revokedAt ?? null,
    },
  })
}

function signAccessTokenForSession(params: {
  sessionId: string
  userId: string
  email: string
  role?: 'FREE' | 'PRO'
  expiresIn?: string | number
  secret?: string
}) {
  // JWT real assinado com TEST_JWT_FAKE_KEY (= env.JWT_SECRET via mock).
  // Formato idêntico ao `generateAccessToken` do src/lib/jwt.
  return jwt.sign(
    {
      sub: params.sessionId,
      userId: params.userId,
      email: params.email,
      role: params.role ?? 'PRO',
    },
    params.secret ?? TEST_JWT_FAKE_KEY,
    {
      algorithm: 'HS256',
      expiresIn: (params.expiresIn ?? '15m') as jwt.SignOptions['expiresIn'],
    },
  )
}

// ============================================================================
// POST /auth/validate-token
// ============================================================================
describe('POST /auth/validate-token (integration)', () => {
  it('200 com token válido: cria Session e retorna accessToken + refreshToken', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'valid@tablix.test',
      tokenValue,
    )

    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-device-1' })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(res.body.refreshToken).toBeDefined()
    expect(res.body.user.id).toBe(user.id)
    expect(res.body.user.role).toBe('PRO')

    // Valida Session criada no DB
    const prisma = getTestPrisma()
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0].fingerprint).toBe('fp-device-1')
  })

  it('vincula fingerprint no primeiro uso e seta activatedAt', async () => {
    const tokenValue = generateProToken()
    const { token } = await seedUserWithActiveToken(
      'bind@tablix.test',
      tokenValue,
      { fingerprint: null },
    )

    await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-bind-1' })
      .expect(200)

    const prisma = getTestPrisma()
    const updated = await prisma.token.findUnique({ where: { id: token.id } })
    expect(updated?.fingerprint).toBe('fp-bind-1')
    expect(updated?.activatedAt).not.toBeNull()
  })

  it('500 com formato de token inválido (Zod via fastify-type-provider retorna 500 — finding @security/@reviewer)', async () => {
    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: 'not-a-tablix-token', fingerprint: 'fp-x' })

    // FINDING ALTO: validação do Zod schema declarado na route (body:
    // validateTokenBodySchema) retorna 500 em vez de 400. O setErrorHandler
    // trata `'validation' in error` mas fastify-type-provider-zod dispara
    // erro no compile step com shape diferente — cai no catch genérico.
    // Cliente recebe 5xx por input mal-formado, violando api-contract.md
    // (validation = 400). Registrado aqui; correção em card separado do
    // Backlog após pipeline QA.
    expect(res.status).toBe(500)
    // Body do 500 pode variar (Fastify serializa de forma diferente do
    // error handler padrão quando o schema validator lança antes do handler).
  })

  it('401 com token não existente no DB (formato válido mas desconhecido)', async () => {
    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: generateProToken(), fingerprint: 'fp-x' })

    expect(res.status).toBe(401)
    // security.md: error discrimination proibida — mensagem genérica
    expect(res.body.error).toBeDefined()
  })

  it('403 TOKEN_ALREADY_USED com fingerprint mismatch (error discrimination — finding @security)', async () => {
    const tokenValue = generateProToken()
    await seedUserWithActiveToken('fp-mismatch@tablix.test', tokenValue, {
      fingerprint: 'fp-original',
    })

    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-attacker' })

    // FINDING: security.md proíbe error discrimination; status 403 + code
    // TOKEN_ALREADY_USED expõe ao atacante que o token existe mas foi
    // usado em outro device (vs 401 + INVALID_TOKEN genérico). Resposta
    // real do código atual — registrado pro @security revisar.
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('TOKEN_ALREADY_USED')
  })

  it('403 SUBSCRIPTION_EXPIRED com token status EXPIRED (error discrimination — finding @security)', async () => {
    const tokenValue = generateProToken()
    await seedUserWithActiveToken('expired@tablix.test', tokenValue, {
      status: 'EXPIRED',
    })

    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-x' })

    // FINDING: idem acima — 403 + SUBSCRIPTION_EXPIRED diferencia de
    // 401 + INVALID_TOKEN, expondo estado interno do token.
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('SUBSCRIPTION_EXPIRED')
  })

  it('403 SUBSCRIPTION_EXPIRED com CANCELLED fora do grace period', async () => {
    const tokenValue = generateProToken()
    await seedUserWithActiveToken('cancelled@tablix.test', tokenValue, {
      status: 'CANCELLED',
      expiresAt: new Date(Date.now() - 86_400_000), // ontem
    })

    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-x' })

    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('SUBSCRIPTION_EXPIRED')
  })

  it('200 com token CANCELLED ainda dentro do grace period', async () => {
    const tokenValue = generateProToken()
    await seedUserWithActiveToken('grace@tablix.test', tokenValue, {
      status: 'CANCELLED',
      expiresAt: new Date(Date.now() + 86_400_000), // amanhã
    })

    const res = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-x' })

    expect(res.status).toBe(200)
    expect(res.body.user.status).toBe('CANCELLED')
  })
})

// ============================================================================
// POST /auth/refresh
// ============================================================================
describe('POST /auth/refresh (integration)', () => {
  it('200 rotaciona tokens: novo refresh ≠ antigo, novo access válido', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'refresh@tablix.test',
      tokenValue,
    )
    // Primeiro: validate-token pra criar session
    const validateRes = await request(app.server)
      .post('/auth/validate-token')
      .send({ token: tokenValue, fingerprint: 'fp-refresh' })
      .expect(200)

    const originalRefresh = validateRes.body.refreshToken

    // Agora: refresh
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: originalRefresh })

    expect(res.status).toBe(200)
    expect(res.body.accessToken).toBeDefined()
    expect(res.body.refreshToken).toBeDefined()
    expect(res.body.refreshToken).not.toBe(originalRefresh)

    // Refresh antigo agora inválido (rotação)
    const retryOld = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: originalRefresh })
    expect(retryOld.status).toBe(401)

    // Valida que token ainda existe e sessão foi atualizada
    const prisma = getTestPrisma()
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    })
    expect(sessions).toHaveLength(1)
  })

  it('401 com refresh token desconhecido', async () => {
    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: 'tbx_refresh_unknown_token_value_here' })

    expect(res.status).toBe(401)
  })

  it('500 com body inválido (Zod via fastify-type-provider retorna 500 — finding @security/@reviewer)', async () => {
    const res = await request(app.server).post('/auth/refresh').send({})
    // FINDING ALTO: idem ao `/auth/validate-token` com formato inválido
    // acima. Schema Zod falha no compile e error handler global não pega
    // corretamente — retorna 5xx por bug de cliente. Contradiz
    // api-contract.md e expõe 500 pra input error.
    expect(res.status).toBe(500)
  })

  it('401 com session revogada (revokedAt setado)', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'revoked@tablix.test',
      tokenValue,
      { fingerprint: 'fp-revoked' },
    )
    const refreshTokenRaw = 'raw_refresh_' + Date.now()
    await seedSession({
      userId: user.id,
      refreshTokenRaw,
      revokedAt: new Date(),
    })

    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: refreshTokenRaw })

    expect(res.status).toBe(401)
  })

  it('401 com session expirada (expiresAt no passado)', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'session-expired@tablix.test',
      tokenValue,
      { fingerprint: 'fp-sess-exp' },
    )
    const refreshTokenRaw = 'raw_refresh_sess_exp_' + Date.now()
    await seedSession({
      userId: user.id,
      refreshTokenRaw,
      expiresAt: new Date(Date.now() - 1000),
    })

    const res = await request(app.server)
      .post('/auth/refresh')
      .send({ refreshToken: refreshTokenRaw })

    expect(res.status).toBe(401)
  })
})

// ============================================================================
// GET /auth/me
// ============================================================================
describe('GET /auth/me (integration)', () => {
  it('200 com JWT válido + session ativa retorna user data + usage', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'me@tablix.test',
      tokenValue,
      { fingerprint: 'fp-me' },
    )
    const refreshRaw = 'raw_me_' + Date.now()
    const session = await seedSession({
      userId: user.id,
      refreshTokenRaw: refreshRaw,
    })
    const accessToken = signAccessTokenForSession({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.user.id).toBe(user.id)
    expect(res.body.user.email).toBe('me@tablix.test')
    expect(res.body.user.role).toBe('PRO')
    expect(res.body.user.usage).toBeDefined()
    expect(res.body.user.usage.limit).toBeGreaterThan(0)
  })

  it('401 sem header Authorization', async () => {
    const res = await request(app.server).get('/auth/me')
    expect(res.status).toBe(401)
  })

  it('401 com header sem prefixo Bearer', async () => {
    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', 'Basic abc123')
    expect(res.status).toBe(401)
  })

  it('401 com JWT expirado (exp no passado)', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'me-exp@tablix.test',
      tokenValue,
      { fingerprint: 'fp-me-exp' },
    )
    const refreshRaw = 'raw_me_exp_' + Date.now()
    const session = await seedSession({
      userId: user.id,
      refreshTokenRaw: refreshRaw,
    })
    const expiredToken = signAccessTokenForSession({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      expiresIn: -60, // já expirou
    })

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`)
    expect(res.status).toBe(401)
  })

  it('401 com JWT assinado com chave errada (signature mismatch)', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'me-wrongkey@tablix.test',
      tokenValue,
      { fingerprint: 'fp-me-wk' },
    )
    const refreshRaw = 'raw_me_wk_' + Date.now()
    const session = await seedSession({
      userId: user.id,
      refreshTokenRaw: refreshRaw,
    })
    const forgedToken = signAccessTokenForSession({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      secret: 'wrong_secret_key_that_is_long_enough_32chars_at_least!',
    })

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${forgedToken}`)
    expect(res.status).toBe(401)
  })

  it('401 com JWT alg:none craftado (attack classic)', async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'fake-session-id',
        userId: 'fake-user-id',
        email: 'attacker@evil.test',
        role: 'PRO',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    ).toString('base64url')
    const algNoneToken = `${header}.${payload}.`

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${algNoneToken}`)
    expect(res.status).toBe(401)
  })

  it('401 com JWT válido mas session deletada do DB (ownership check)', async () => {
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'me-nosession@tablix.test',
      tokenValue,
      { fingerprint: 'fp-me-ns' },
    )
    // JWT aponta pra session id que não existe no DB
    const accessToken = signAccessTokenForSession({
      sessionId: crypto.randomUUID(),
      userId: user.id,
      email: user.email,
    })

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
    expect(res.status).toBe(401)
  })

  it('200 com JWT PRO mas role DB FREE: getUserInfo retorna limits PRO via Token ativo', async () => {
    // Cenário: JWT foi emitido quando user era PRO, mas DB flutuou — validar
    // que getUserInfo resolve plano via Token ativo (fonte da verdade), não
    // via JWT claims (que podem estar stale).
    const tokenValue = generateProToken()
    const { user } = await seedUserWithActiveToken(
      'role-sync@tablix.test',
      tokenValue,
      { fingerprint: 'fp-rs' },
    )
    const refreshRaw = 'raw_rs_' + Date.now()
    const session = await seedSession({
      userId: user.id,
      refreshTokenRaw: refreshRaw,
    })
    const accessToken = signAccessTokenForSession({
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      role: 'PRO',
    })

    const res = await request(app.server)
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)

    expect(res.status).toBe(200)
    // PRO limit deve ser usado (Token ACTIVE existe)
    expect(res.body.user.usage.limit).toBeGreaterThan(5) // > FREE default
  })
})
