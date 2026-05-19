/**
 * Unit tests for SupabaseStorageAdapter.removeByPath (Card #146 F1 — T-1.3).
 *
 * Cobre os 4 cenários do plano R-10:
 *   - Path válido → sucesso (deleted=true, notFound=false)
 *   - Path inválido (traversal) → throw PATH_TRAVERSAL_REJECTED
 *   - Storage 404 (data vazio sem erro) → idempotente (deleted=false, notFound=true)
 *   - Storage 404 (erro com mensagem matching) → idempotente
 *   - Erro genérico Supabase → throw DELETE_FAILED
 *
 * + cenários adicionais: path como `UserScopedPath` branded, defesa em
 * profundidade do regex.
 *
 * @owner: @tester
 * @card: #146 F1 (T-1.3)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SupabaseStorageAdapter } from '../../src/lib/storage/supabase.adapter'
import type { UserScopedPath } from '../../src/lib/storage/types'

const VALID_PATH = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/2026-05-18/abc1234.csv'
const BUCKET = 'tablix-history-staging'

interface MockBucketAPI {
  remove: ReturnType<typeof vi.fn>
}

function makeMockClient(bucketAPI: MockBucketAPI) {
  return {
    storage: {
      from: vi.fn().mockReturnValue(bucketAPI),
    },
  }
}

let bucketAPI: MockBucketAPI
let adapter: SupabaseStorageAdapter

beforeEach(() => {
  bucketAPI = {
    remove: vi.fn(),
  }
  adapter = new SupabaseStorageAdapter(
    makeMockClient(bucketAPI) as unknown as ConstructorParameters<
      typeof SupabaseStorageAdapter
    >[0],
    BUCKET,
  )
})

describe('removeByPath — happy paths', () => {
  it('sucesso: data com 1 objeto → { deleted: true, notFound: false }', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: [{ name: 'abc1234.csv' }],
      error: null,
    })

    const result = await adapter.removeByPath(VALID_PATH)

    expect(result).toEqual({ deleted: true, notFound: false })
    expect(bucketAPI.remove).toHaveBeenCalledWith([VALID_PATH])
  })

  it('aceita path como UserScopedPath branded', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: [{ name: 'abc1234.csv' }],
      error: null,
    })

    const branded = VALID_PATH as UserScopedPath
    const result = await adapter.removeByPath(branded)

    expect(result.deleted).toBe(true)
  })
})

describe('removeByPath — idempotência (404)', () => {
  it('data: [] sem erro → { deleted: false, notFound: true }', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: [],
      error: null,
    })

    const result = await adapter.removeByPath(VALID_PATH)

    expect(result).toEqual({ deleted: false, notFound: true })
  })

  it('error com mensagem "not found" → { deleted: false, notFound: true }', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'Object not found' },
    })

    const result = await adapter.removeByPath(VALID_PATH)

    expect(result).toEqual({ deleted: false, notFound: true })
  })

  it('error com mensagem "does not exist" → { deleted: false, notFound: true }', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'Object does not exist in bucket' },
    })

    const result = await adapter.removeByPath(VALID_PATH)

    expect(result.notFound).toBe(true)
  })
})

describe('removeByPath — defesa em profundidade R-10 (path inválido)', () => {
  it('throw em path com `..` (traversal)', async () => {
    await expect(adapter.removeByPath('../etc/passwd.csv')).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })

  it('throw em path com `\\` (Windows separator)', async () => {
    await expect(
      adapter.removeByPath(
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\\2026-05-18\\abc1234.csv',
      ),
    ).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })

  it('throw em path com extensão fora do whitelist', async () => {
    await expect(
      adapter.removeByPath(
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/2026-05-18/abc1234.exe',
      ),
    ).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })

  it('throw em UUID uppercase', async () => {
    await expect(
      adapter.removeByPath(
        'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE/2026-05-18/abc1234.csv',
      ),
    ).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })

  it('throw em string vazia', async () => {
    await expect(adapter.removeByPath('')).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })

  it('throw em null', async () => {
    await expect(
      adapter.removeByPath(null as unknown as string),
    ).rejects.toThrow()
    expect(bucketAPI.remove).not.toHaveBeenCalled()
  })
})

describe('removeByPath — erro genérico Supabase', () => {
  it('throw DELETE_FAILED em erro genérico', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'Connection timeout' },
    })

    await expect(adapter.removeByPath(VALID_PATH)).rejects.toThrow()
  })

  it('throw DELETE_FAILED em erro 5xx do Supabase', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'Internal Server Error' },
    })

    await expect(adapter.removeByPath(VALID_PATH)).rejects.toThrow(
      /failed to delete/i,
    )
  })

  it('preserva cause no error pra debug', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'specific supabase error message' },
    })

    try {
      await adapter.removeByPath(VALID_PATH)
      expect.fail('should have thrown')
    } catch (err) {
      const errWithStorage = err as Error & {
        storageError?: { code: string; cause?: unknown }
      }
      expect(errWithStorage.storageError?.code).toBe('DELETE_FAILED')
      // cause em prod (NODE_ENV=production) é zerado; em test/dev preserva
      expect(errWithStorage.storageError?.cause).toBe(
        'specific supabase error message',
      )
    }
  })
})

describe('removeByPath — chamada correta ao SDK', () => {
  it('passa array com 1 path pro remove (não single string)', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: [{ name: 'abc1234.csv' }],
      error: null,
    })

    await adapter.removeByPath(VALID_PATH)

    expect(bucketAPI.remove).toHaveBeenCalledTimes(1)
    expect(bucketAPI.remove).toHaveBeenCalledWith([VALID_PATH])
  })
})
