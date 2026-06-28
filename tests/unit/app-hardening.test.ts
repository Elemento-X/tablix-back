/**
 * Card #220 — Hardening de app-level plugins (pós-gate 7.5).
 *
 * Cobre as 3 frentes do bundle que vivem em src/app.ts:
 *
 *   1. Compressão (@fastify/compress): encodings ['br','gzip'], threshold 1024.
 *      - JSON > 1KB com Accept-Encoding → Content-Encoding (br preferido; gzip fallback).
 *      - corpo realmente comprimido (decodifica de volta pra JSON válido).
 *      - payload < threshold NÃO é comprimido (overhead evitado).
 *      - sem Accept-Encoding → identidade (sem Content-Encoding).
 *      - binário não-compressível (mime xlsx) NÃO é re-comprimido (módulo `compressible`).
 *
 *   2. Security headers:
 *      - helmet frameguard DENY → X-Frame-Options: DENY (clickjacking).
 *      - helmet nosniff → X-Content-Type-Options: nosniff.
 *      - hook onRequest → Permissions-Policy restritivo em toda resposta (inclui preflight).
 *
 *   3. CORS:
 *      - preflight OPTIONS reflete Access-Control-Max-Age: 86400 (anti preflight-flood).
 *
 * **Estratégia:**
 *   - Headers/CORS/compressão-de-texto: testados contra o app REAL (buildApp via
 *     env-stub) — prova o wiring de verdade. /docs/json (≈8KB) é o payload JSON
 *     grande público (sem auth/DB) usado pra exercer compressão; /health/live
 *     (≈30B) exercita o caminho abaixo-do-threshold. Nenhum toca DB/Redis.
 *   - Binário não-compressível: o app real não expõe rota binária pública >1KB
 *     sem auth+upload (custoso e não-determinístico). Reproduzimos o caminho
 *     factível num app mínimo que ESPELHA exatamente a config de app.ts
 *     (encodings/threshold), e blindamos a config real via source-guard (abaixo).
 *
 * @owner: @tester
 * @card: #220
 */
/* eslint-disable import/first */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import compress from '@fastify/compress'

// Mock env ANTES de qualquer import que consuma `env` (buildApp → config/env etc.).
vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})

import { buildTestApp, closeTestApp, type TestApp } from '../helpers/app'

const appSource = readFileSync(resolve('src/app.ts'), 'utf-8')

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// =============================================================================
// App real (buildApp) — compressão, headers, CORS
// =============================================================================
describe('Card #220 — app-level hardening (buildApp real)', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await buildTestApp()
  })

  afterAll(async () => {
    await closeTestApp(app)
  })

  // ---------------------------------------------------------------------------
  // Compressão
  // ---------------------------------------------------------------------------
  describe('compressão (@fastify/compress)', () => {
    it('JSON > 1KB com Accept-Encoding: br,gzip → Content-Encoding: br (br preferido)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/docs/json',
        headers: { 'accept-encoding': 'br, gzip' },
      })
      expect(res.statusCode).toBe(200)
      // encodings: ['br','gzip'] declara br como preferido quando o client oferece ambos.
      expect(res.headers['content-encoding']).toBe('br')
      // Prova que é compressão real: o corpo decodifica de volta pra OpenAPI JSON válido.
      const decoded = brotliDecompressSync(res.rawPayload).toString('utf-8')
      const spec = JSON.parse(decoded) as { openapi?: string; info?: unknown }
      expect(spec.openapi).toBeDefined()
      expect(spec.info).toBeDefined()
      // Sanidade: payload original é grande o suficiente pra cruzar o threshold de 1KB.
      expect(decoded.length).toBeGreaterThan(1024)
    })

    it('JSON > 1KB com Accept-Encoding: gzip (sem br) → Content-Encoding: gzip', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/docs/json',
        headers: { 'accept-encoding': 'gzip' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      const decoded = gunzipSync(res.rawPayload).toString('utf-8')
      expect(() => JSON.parse(decoded)).not.toThrow()
    })

    it('sem Accept-Encoding → resposta identidade (sem Content-Encoding)', async () => {
      const res = await app.inject({ method: 'GET', url: '/docs/json' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBeUndefined()
      // Corpo é JSON cru parseável.
      expect(() => JSON.parse(res.rawPayload.toString('utf-8'))).not.toThrow()
    })

    it('JSON < threshold (1KB) NÃO é comprimido mesmo com Accept-Encoding', async () => {
      // /health/live retorna ~30 bytes — abaixo do threshold de 1024. Comprimir
      // payload minúsculo só adiciona overhead de CPU + bytes de header.
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'accept-encoding': 'br, gzip' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.rawPayload.length).toBeLessThan(1024)
    })
  })

  // ---------------------------------------------------------------------------
  // Security headers
  // ---------------------------------------------------------------------------
  describe('security headers', () => {
    it('X-Frame-Options: DENY (helmet frameguard deny — clickjacking)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['x-frame-options']).toBe('DENY')
    })

    it('X-Content-Type-Options: nosniff (helmet)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    })

    it('Permissions-Policy restritivo presente em toda resposta (hook onRequest)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
      )
    })

    it('Permissions-Policy desliga as features sensíveis (camera/microphone/geolocation/payment/usb)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      const pp = res.headers['permissions-policy'] as string
      for (const feature of [
        'camera',
        'microphone',
        'geolocation',
        'payment',
        'usb',
        'browsing-topics',
      ]) {
        // Cada feature aparece com allowlist vazia `feature=()` → negada a todos.
        expect(pp).toContain(`${feature}=()`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // CORS preflight
  // ---------------------------------------------------------------------------
  describe('CORS preflight', () => {
    it('OPTIONS preflight reflete Access-Control-Max-Age: 86400 (anti preflight-flood)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-max-age']).toBe('86400')
      // origin fixo (FRONTEND_URL), nunca wildcard.
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000',
      )
    })

    it('Permissions-Policy também presente no preflight (hook roda antes do CORS)', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/health/live',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET',
        },
      })
      expect(res.headers['permissions-policy']).toBeDefined()
    })
  })
})

// =============================================================================
// Source guards — blindam a CONFIG real em app.ts (mutation guard)
// =============================================================================
describe('Card #220 — source guards (app.ts config)', () => {
  it('compress registrado com encodings [br, gzip] e threshold 1024', () => {
    const pattern =
      /register\(\s*compress\s*,\s*\{[\s\S]*?encodings:\s*\[\s*['"]br['"]\s*,\s*['"]gzip['"]\s*\][\s\S]*?threshold:\s*1024[\s\S]*?\}\s*\)/
    expect(appSource).toMatch(pattern)
  })

  it('compress com globalDecompression: false (@reviewer F-220-01 — anti decompression-bomb)', () => {
    // Regressão de superfície de ataque: religar a decompressão de body de REQUEST
    // reabriria o vetor de decompression-bomb (1KB gzip → N MB inflados no parser).
    // Nenhum cliente Tablix manda body comprimido — least-privilege.
    expect(appSource).toMatch(/globalDecompression:\s*false/)
    // Garante que o flag está DENTRO do register do compress (não num bloco solto).
    const compressBlock = appSource.match(
      /register\(\s*compress\s*,\s*\{[\s\S]*?\}\s*\)/,
    )
    expect(compressBlock).not.toBeNull()
    expect(compressBlock![0]).toContain('globalDecompression: false')
  })

  it('compress com brotli quality pinado em 4 (CPU-consciente p/ shared-cpu-1x)', () => {
    // Pin explícito evita herdar silenciosamente o default da lib (q11 = CPU proibitivo).
    expect(appSource).toMatch(
      /import\s*\{\s*constants as zlibConstants\s*\}\s*from\s*['"]node:zlib['"]/,
    )
    expect(appSource).toMatch(/brotliOptions:/)
    expect(appSource).toMatch(/\[zlibConstants\.BROTLI_PARAM_QUALITY\]:\s*4/)
  })

  it('helmet frameguard com action deny', () => {
    expect(appSource).toMatch(/frameguard:\s*\{\s*action:\s*['"]deny['"]\s*\}/)
  })

  it('CORS com maxAge 86400', () => {
    expect(appSource).toMatch(/maxAge:\s*86400/)
  })

  it('hook onRequest seta Permissions-Policy restritivo', () => {
    expect(appSource).toMatch(/['"]Permissions-Policy['"]/)
    expect(appSource).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/)
  })
})

// =============================================================================
// Binário não-compressível — app mínimo espelhando a config de app.ts
// =============================================================================
describe('Card #220 — compressão pula binário não-compressível (config-mirror)', () => {
  // ESPELHA exatamente o register de app.ts. O source-guard acima garante que
  // este mirror não diverge da config real (se app.ts mudar threshold/encodings,
  // o guard falha e força atualizar ambos).
  async function buildMirrorApp() {
    const app = Fastify({ logger: false })
    await app.register(compress, {
      encodings: ['br', 'gzip'],
      threshold: 1024,
    })

    // JSON grande (> 1KB) — compressível.
    app.get('/big-json', async () => ({
      items: Array.from({ length: 200 }, (_, i) => `row-${i}-payload-data`),
    }))

    // Binário tipo xlsx (> 1KB) — NÃO-compressível pelo módulo `compressible`.
    app.get('/xlsx', async (_req, reply) => {
      const buf = Buffer.alloc(4096, 0x42) // 4KB, bem acima do threshold
      reply.header('content-type', XLSX_MIME)
      return reply.send(buf)
    })

    // JSON pequeno (< threshold).
    app.get('/small-json', async () => ({ ok: true }))

    await app.ready()
    return app
  }

  let app: Awaited<ReturnType<typeof buildMirrorApp>>

  beforeAll(async () => {
    app = await buildMirrorApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('JSON > 1KB com Accept-Encoding: gzip → Content-Encoding: gzip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/big-json',
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    const decoded = gunzipSync(res.rawPayload).toString('utf-8')
    const parsed = JSON.parse(decoded) as { items: string[] }
    expect(parsed.items).toHaveLength(200)
  })

  it('binário xlsx > 1KB NÃO recebe Content-Encoding (módulo compressible pula)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/xlsx',
      headers: { 'accept-encoding': 'br, gzip' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain(XLSX_MIME)
    // O zip do xlsx já é comprimido — re-comprimir desperdiça CPU e não encolhe.
    // `compressible` (via mime-db) retorna false pra este mime → sem Content-Encoding.
    expect(res.headers['content-encoding']).toBeUndefined()
    // Corpo entregue intacto (mesmo tamanho do original, sem encoding).
    expect(res.rawPayload.length).toBe(4096)
  })

  it('JSON < threshold NÃO é comprimido mesmo com Accept-Encoding', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/small-json',
      headers: { 'accept-encoding': 'br, gzip' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
  })
})

// =============================================================================
// globalDecompression: false — semântica do flag (@reviewer F-220-01)
// =============================================================================
describe('Card #220 — request-side decompression desligada (config-mirror)', () => {
  // Por que mirror e não app real: o app real não expõe rota POST JSON pública
  // e leve sem auth/rate-limit pra mandar um body forjado. O mirror prova a
  // SEMÂNTICA do flag (o que `globalDecompression: false` faz), e o source-guard
  // acima prova que app.ts REALMENTE seta o flag. Divisão: guard = config real;
  // mirror = comportamento do flag. O contraste on/off documenta por que importa.
  async function buildDecompressApp(globalDecompression: boolean) {
    const app = Fastify({ logger: false })
    await app.register(compress, {
      encodings: ['br', 'gzip'],
      threshold: 1024,
      globalDecompression,
    })
    // Rota que ECOA o body parseado — se o body chegar decodificado, o handler
    // o vê como objeto; se chegar cru (gzip), o parser JSON falha antes do handler.
    app.post('/echo', async (req) => ({ received: req.body }))
    // Rota de RESPONSE grande pra provar que desligar request-side não afeta response-side.
    app.get('/big', async () => ({
      items: Array.from({ length: 200 }, (_, i) => `row-${i}-payload-data`),
    }))
    await app.ready()
    return app
  }

  it('OFF: body Content-Encoding: gzip NÃO é auto-decomprimido → request rejeitado (4xx)', async () => {
    const app = await buildDecompressApp(false)
    const gzipped = gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })))

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipped,
    })

    // Com decompressão de request DESLIGADA, os bytes gzip crus chegam ao parser
    // JSON → não parseiam → 4xx. O handler nunca vê `{hello:'world'}`. É exatamente
    // o que fecha a superfície de decompression-bomb: o body comprimido nunca é
    // inflado pelo servidor.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.payload).not.toContain('"hello":"world"')
    await app.close()
  })

  it('ON (contraste): mesmo body gzip SERIA decomprimido e parseado → 200 com objeto decodificado', async () => {
    const app = await buildDecompressApp(true)
    const gzipped = gzipSync(Buffer.from(JSON.stringify({ hello: 'world' })))

    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: gzipped,
    })

    // Contraprova: com o flag LIGADO, o servidor INFLA o body antes do parser.
    // Isso é precisamente o vetor que F-220-01 fecha ao desligar no app real.
    expect(res.statusCode).toBe(200)
    const body = res.json<{ received: { hello: string } }>()
    expect(body.received).toEqual({ hello: 'world' })
    await app.close()
  })

  it('OFF: compressão de RESPONSE segue funcionando (desligar request não afeta response)', async () => {
    // Garante que F-220-01 é cirúrgico: só o request-side desliga; a resposta
    // grande continua sendo comprimida normalmente.
    const app = await buildDecompressApp(false)

    const res = await app.inject({
      method: 'GET',
      url: '/big',
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    await app.close()
  })
})
