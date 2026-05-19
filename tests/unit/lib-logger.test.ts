/**
 * Unit tests para src/lib/logger.ts (Card 3.2 #31).
 *
 * Não confundir com tests/unit/logger.test.ts, que é do Card 2.1 e testa
 * `src/config/logger.ts` (logger do Fastify com redact/serializers). Este
 * arquivo cobre o root pino `src/lib/logger.ts` — usado por helpers
 * fora do ciclo de request.
 *
 * Cobre as 3 branches de `resolveLogLevel()`: test→silent, production→info,
 * development/default→debug. Testadas via import dinâmico + vi.doMock do env
 * porque o módulo instancia `logger` no top-level (immutable após import).
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

async function importLoggerWithEnv(nodeEnv: string) {
  vi.resetModules()
  vi.doMock('../../src/config/env', () => ({
    env: { NODE_ENV: nodeEnv },
  }))
  const mod = await import('../../src/lib/logger')
  return mod.logger
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../../src/config/env')
})

describe('src/lib/logger — resolveLogLevel via NODE_ENV', () => {
  it('NODE_ENV=test → level silent (suprime saída em suítes)', async () => {
    const logger = await importLoggerWithEnv('test')
    expect(logger.level).toBe('silent')
  })

  it('NODE_ENV=production → level info (descarta debug/trace)', async () => {
    const logger = await importLoggerWithEnv('production')
    expect(logger.level).toBe('info')
  })

  it('NODE_ENV=development → level debug (verbose em dev)', async () => {
    const logger = await importLoggerWithEnv('development')
    expect(logger.level).toBe('debug')
  })

  it('NODE_ENV desconhecido cai no default debug (fallback do else)', async () => {
    // Guard: se um quarto NODE_ENV vazar (ex: "staging" sem atualizar
    // resolveLogLevel), cai no default debug — não silencia (fail-loud).
    const logger = await importLoggerWithEnv('staging')
    expect(logger.level).toBe('debug')
  })

  it('expõe a instância como singleton (mesma ref em chamadas subsequentes)', async () => {
    vi.resetModules()
    vi.doMock('../../src/config/env', () => ({
      env: { NODE_ENV: 'test' },
    }))
    const a = (await import('../../src/lib/logger')).logger
    const b = (await import('../../src/lib/logger')).logger
    expect(a).toBe(b)
  })
})
