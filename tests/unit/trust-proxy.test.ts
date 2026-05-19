/**
 * Unit tests for resolveTrustProxy (Card 1.12 + extraído no Card 3.2).
 *
 * Cobre:
 *   - production → 1 hop (LB da plataforma)
 *   - development → loopback CIDRs canônicos
 *   - test → loopback CIDRs canônicos
 *   - CIDR canônico: 127.0.0.0/8 (não 127.0.0.1/8)
 *
 * Importa de `src/lib/trust-proxy.ts` (função pura) em vez de `src/app.ts`
 * pra evitar re-instrumentação de Fastify+plugins sob coverage. Era a causa
 * do timeout de 34s na execução #2 do Card 3.1+3.1b.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

async function importWithEnv(nodeEnv: 'production' | 'development' | 'test') {
  vi.resetModules()
  vi.doMock('../../src/config/env', () => ({
    env: {
      NODE_ENV: nodeEnv,
      PORT: 3333,
      FRONTEND_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:3333',
    },
  }))
  const mod = await import('../../src/lib/trust-proxy')
  return mod.resolveTrustProxy
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../../src/config/env')
})

describe('resolveTrustProxy — Card 1.12', () => {
  it('production → confia em 1 hop (load balancer da plataforma)', async () => {
    const resolveTrustProxy = await importWithEnv('production')
    expect(resolveTrustProxy()).toBe(1)
  })

  it('development → loopback CIDRs explícitos', async () => {
    const resolveTrustProxy = await importWithEnv('development')
    const result = resolveTrustProxy()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toContain('127.0.0.0/8')
    expect(result).toContain('::1/128')
  })

  it('test → loopback CIDRs explícitos (mesmo comportamento de development)', async () => {
    const resolveTrustProxy = await importWithEnv('test')
    const result = resolveTrustProxy()
    expect(result).toEqual(['127.0.0.0/8', '::1/128'])
  })

  it('CIDR IPv4 é canônico: 127.0.0.0/8 (não 127.0.0.1/8)', async () => {
    // Regression guard: /8 com host bits setados é mal-formado.
    // Fastify/proxy-addr aceita ambos mas canônico é 127.0.0.0/8.
    const resolveTrustProxy = await importWithEnv('development')
    const result = resolveTrustProxy() as string[]
    expect(result).not.toContain('127.0.0.1/8')
    expect(result).toContain('127.0.0.0/8')
  })

  it('production NÃO retorna array de CIDR (fail-closed: 1 hop único)', async () => {
    const resolveTrustProxy = await importWithEnv('production')
    expect(Array.isArray(resolveTrustProxy())).toBe(false)
  })
})
