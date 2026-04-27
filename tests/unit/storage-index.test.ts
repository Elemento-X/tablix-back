/**
 * Unit tests da factory singleton do storage (Card 5.1, fix-pack)
 *
 * Cobre `getStorageAdapter()` + `resetStorageAdapterForTests()`. Branches
 * críticas:
 *   - dev/test sem env → cache `null` (caller decide)
 *   - prod sem env → throw (defesa em profundidade — env.ts.superRefine
 *     já barra no boot, mas se passar, factory grita)
 *   - cache estável (mesma instância em múltiplas chamadas)
 *   - reset limpa cache
 *
 * Mocka `env.ts` pra controlar `NODE_ENV` e vars sem precisar setar
 * `process.env` real (que poderia vazar entre suites).
 *
 * @owner: @tester
 * @card: 5.1 — Adapter de storage (Fase 5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock do env — sobrescreve por teste pra cobrir as 4 branches.
const envMock: {
  NODE_ENV: 'development' | 'production' | 'test'
  SUPABASE_URL?: string
  SUPABASE_STORAGE_KEY?: string
  SUPABASE_STORAGE_BUCKET?: string
} = {
  NODE_ENV: 'test',
}

vi.mock('../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

// Mock do SDK pra evitar criar SupabaseClient real (não interessa pra
// este teste — só validamos comportamento do factory).
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({ storage: { from: vi.fn() } }),
}))

beforeEach(async () => {
  // Reset singleton pra isolar cada teste
  const { resetStorageAdapterForTests } =
    await import('../../src/lib/storage/index')
  resetStorageAdapterForTests()
  // Reset env mock pro estado default
  envMock.NODE_ENV = 'test'
  envMock.SUPABASE_URL = undefined
  envMock.SUPABASE_STORAGE_KEY = undefined
  envMock.SUPABASE_STORAGE_BUCKET = undefined
})

afterEach(async () => {
  const { resetStorageAdapterForTests } =
    await import('../../src/lib/storage/index')
  resetStorageAdapterForTests()
})

describe('getStorageAdapter — dev sem env', () => {
  it('retorna null e cacheia (sem throw)', async () => {
    envMock.NODE_ENV = 'development'

    const { getStorageAdapter } = await import('../../src/lib/storage/index')
    const result = getStorageAdapter()

    expect(result).toBeNull()
  })

  it('chamadas subsequentes retornam mesmo null cached', async () => {
    envMock.NODE_ENV = 'test'

    const { getStorageAdapter } = await import('../../src/lib/storage/index')
    const a = getStorageAdapter()
    const b = getStorageAdapter()

    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(a).toBe(b) // mesma referência (null === null trivialmente)
  })
})

describe('getStorageAdapter — production sem env', () => {
  it('lança Error (defesa em profundidade — env.ts deveria ter pego antes)', async () => {
    envMock.NODE_ENV = 'production'
    envMock.SUPABASE_URL = undefined

    const { getStorageAdapter } = await import('../../src/lib/storage/index')

    expect(() => getStorageAdapter()).toThrow(
      /Storage adapter requested in production but env is incomplete/,
    )
  })

  it('lança se só SUPABASE_URL ausente (env parcial)', async () => {
    envMock.NODE_ENV = 'production'
    envMock.SUPABASE_URL = undefined
    envMock.SUPABASE_STORAGE_KEY = 'sb_secret_x'
    envMock.SUPABASE_STORAGE_BUCKET = 'tablix-history-prod'

    const { getStorageAdapter } = await import('../../src/lib/storage/index')

    expect(() => getStorageAdapter()).toThrow()
  })
})

describe('getStorageAdapter — env completa', () => {
  it('retorna instância e cacheia singleton', async () => {
    envMock.NODE_ENV = 'production'
    envMock.SUPABASE_URL = 'https://xyz.supabase.co'
    envMock.SUPABASE_STORAGE_KEY = 'sb_secret_test'
    envMock.SUPABASE_STORAGE_BUCKET = 'tablix-history-staging'

    const { getStorageAdapter } = await import('../../src/lib/storage/index')
    const a = getStorageAdapter()
    const b = getStorageAdapter()

    expect(a).not.toBeNull()
    expect(a).toBe(b) // mesma instância (singleton lazy)
  })
})

describe('resetStorageAdapterForTests', () => {
  it('limpa cache — próxima chamada re-inicializa', async () => {
    envMock.NODE_ENV = 'production'
    envMock.SUPABASE_URL = 'https://xyz.supabase.co'
    envMock.SUPABASE_STORAGE_KEY = 'sb_secret_test'
    envMock.SUPABASE_STORAGE_BUCKET = 'tablix-history-staging'

    const { getStorageAdapter, resetStorageAdapterForTests } =
      await import('../../src/lib/storage/index')

    const before = getStorageAdapter()
    resetStorageAdapterForTests()
    const after = getStorageAdapter()

    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(before).not.toBe(after) // nova instância após reset
  })
})
