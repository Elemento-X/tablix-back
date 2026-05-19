/**
 * Unit tests do SupabaseStorageAdapter (Card 5.1)
 *
 * Mock do `SupabaseClient` injetado no construtor — testa todas as
 * branches de erro e success sem tocar Supabase real (cobertura
 * integration fica em tests/integration/storage.integration.test.ts).
 *
 * Cobre os 5 métodos da interface user-scoped + mapping de erros do
 * SDK pra `StorageError` discriminada.
 *
 * @owner: @tester
 * @card: 5.1 — Adapter de storage (Fase 5)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SUPABASE_ERROR_PATTERNS,
  SupabaseStorageAdapter,
} from '../../src/lib/storage/supabase.adapter'

const VALID_USER_ID = 'a3b6f9c2-1d4e-4a8b-9c2d-3e5f7a9b1c4d'
const VALID_JOB_ID = 'cuidabc123def456'
const BUCKET = 'tablix-history-staging'

interface MockBucketAPI {
  upload: ReturnType<typeof vi.fn>
  createSignedUrl: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
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
    upload: vi.fn(),
    createSignedUrl: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
  }
  // Cast minimal pra interface real do SupabaseClient — adapter
  // só usa `client.storage.from(bucket).<method>`.
  adapter = new SupabaseStorageAdapter(
    makeMockClient(bucketAPI) as unknown as ConstructorParameters<
      typeof SupabaseStorageAdapter
    >[0],
    BUCKET,
  )
})

describe('SupabaseStorageAdapter — uploadForUser', () => {
  it('sucesso: monta path correto e retorna { path }', async () => {
    bucketAPI.upload.mockResolvedValue({ data: { path: 'mock' }, error: null })

    const result = await adapter.uploadForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'xlsx',
      buffer: Buffer.from('test'),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })

    expect(result.path).toMatch(
      new RegExp(
        `^${VALID_USER_ID}/\\d{4}-\\d{2}-\\d{2}/${VALID_JOB_ID}\\.xlsx$`,
      ),
    )
    expect(bucketAPI.upload).toHaveBeenCalledWith(
      result.path,
      expect.any(Buffer),
      expect.objectContaining({ upsert: false }),
    )
  })

  it('sempre passa upsert: false (rejeita overwrite)', async () => {
    bucketAPI.upload.mockResolvedValue({ data: { path: 'mock' }, error: null })

    await adapter.uploadForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
      buffer: Buffer.from('a,b'),
      contentType: 'text/csv',
    })

    const callOpts = bucketAPI.upload.mock.calls[0][2]
    expect(callOpts.upsert).toBe(false)
  })

  it('mapeia erro "already exists" → OBJECT_ALREADY_EXISTS', async () => {
    bucketAPI.upload.mockResolvedValue({
      data: null,
      error: { message: 'The resource already exists' },
    })

    await expect(
      adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'xlsx',
        buffer: Buffer.from(''),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('mapeia erro genérico → UPLOAD_FAILED', async () => {
    bucketAPI.upload.mockResolvedValue({
      data: null,
      error: { message: 'Network timeout' },
    })

    await expect(
      adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'xlsx',
        buffer: Buffer.from(''),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).rejects.toThrow(/upload to storage failed/)
  })

  it('rejeita userId inválido (UUID v4 strict)', async () => {
    await expect(
      adapter.uploadForUser({
        userId: 'not-a-uuid',
        jobId: VALID_JOB_ID,
        ext: 'csv',
        buffer: Buffer.from(''),
        contentType: 'text/csv',
      }),
    ).rejects.toThrow(/UUID v4/)
    expect(bucketAPI.upload).not.toHaveBeenCalled()
  })
})

describe('SupabaseStorageAdapter — getSignedUrlForUser', () => {
  it('sucesso: retorna URL e expiresAt', async () => {
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example.com/xyz' },
      error: null,
    })

    const result = await adapter.getSignedUrlForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'xlsx',
    })

    expect(result.url).toBe('https://signed.example.com/xyz')
    expect(result.expiresAt).toBeInstanceOf(Date)
  })

  it('default TTL = 300s (5 min)', async () => {
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://x' },
      error: null,
    })

    await adapter.getSignedUrlForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
    })

    expect(bucketAPI.createSignedUrl).toHaveBeenCalledWith(
      expect.any(String),
      300,
    )
  })

  it('rejeita TTL <= 0', async () => {
    await expect(
      adapter.getSignedUrlForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        expiresInSeconds: 0,
      }),
    ).rejects.toThrow(/expiresInSeconds/)
  })

  it('rejeita TTL > 3600 (max 1h)', async () => {
    await expect(
      adapter.getSignedUrlForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        expiresInSeconds: 3601,
      }),
    ).rejects.toThrow(/expiresInSeconds/)
  })

  it('aceita TTL 3600 (limite alto inclusive)', async () => {
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://x' },
      error: null,
    })

    await expect(
      adapter.getSignedUrlForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        expiresInSeconds: 3600,
      }),
    ).resolves.toBeDefined()
  })

  it('mapeia erro "not found" → OBJECT_NOT_FOUND', async () => {
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'Object not found' },
    })

    await expect(
      adapter.getSignedUrlForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'xlsx',
      }),
    ).rejects.toThrow(/object not found/)
  })

  it('mapeia erro genérico → SIGNED_URL_FAILED', async () => {
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'service unavailable' },
    })

    await expect(
      adapter.getSignedUrlForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'xlsx',
      }),
    ).rejects.toThrow(/failed to generate signed URL/)
  })
})

describe('SupabaseStorageAdapter — deleteForUser', () => {
  it('sucesso (objeto existia): retorna { deleted: true }', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: [{ name: 'mock' }],
      error: null,
    })

    const result = await adapter.deleteForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
    })

    expect(result.deleted).toBe(true)
  })

  it('idempotente (objeto não existia): retorna { deleted: false }', async () => {
    bucketAPI.remove.mockResolvedValue({ data: [], error: null })

    const result = await adapter.deleteForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
    })

    expect(result.deleted).toBe(false)
  })

  it('mapeia erro → DELETE_FAILED', async () => {
    bucketAPI.remove.mockResolvedValue({
      data: null,
      error: { message: 'permission denied' },
    })

    await expect(
      adapter.deleteForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
      }),
    ).rejects.toThrow(/failed to delete/)
  })
})

describe('SupabaseStorageAdapter — listForUser', () => {
  it('sucesso: passa prefix do user e retorna StorageObject[]', async () => {
    bucketAPI.list.mockResolvedValue({
      data: [
        {
          name: '2026-04-26/job1.xlsx',
          created_at: '2026-04-26T12:00:00Z',
          metadata: { size: 1234, mimetype: 'application/xlsx' },
        },
      ],
      error: null,
    })

    const result = await adapter.listForUser({ userId: VALID_USER_ID })

    expect(result).toHaveLength(1)
    expect(result[0].path).toContain(VALID_USER_ID)
    expect(result[0].sizeBytes).toBe(1234)
    expect(bucketAPI.list).toHaveBeenCalledWith(
      `${VALID_USER_ID}/`,
      expect.objectContaining({ limit: 100 }),
    )
  })

  it('default limit = 100', async () => {
    bucketAPI.list.mockResolvedValue({ data: [], error: null })

    await adapter.listForUser({ userId: VALID_USER_ID })

    expect(bucketAPI.list).toHaveBeenCalledWith(expect.any(String), {
      limit: 100,
    })
  })

  it('cap limit em 1000 (máximo Supabase)', async () => {
    bucketAPI.list.mockResolvedValue({ data: [], error: null })

    await adapter.listForUser({ userId: VALID_USER_ID, limit: 5000 })

    expect(bucketAPI.list).toHaveBeenCalledWith(expect.any(String), {
      limit: 1000,
    })
  })

  it('rejeita limit <= 0', async () => {
    await expect(
      adapter.listForUser({ userId: VALID_USER_ID, limit: 0 }),
    ).rejects.toThrow(/limit must be positive/)
  })

  it('rejeita userId inválido antes de tocar Supabase', async () => {
    await expect(adapter.listForUser({ userId: 'not-a-uuid' })).rejects.toThrow(
      /UUID v4/,
    )
    expect(bucketAPI.list).not.toHaveBeenCalled()
  })

  it('mapeia erro → LIST_FAILED', async () => {
    bucketAPI.list.mockResolvedValue({
      data: null,
      error: { message: 'rate limited' },
    })

    await expect(
      adapter.listForUser({ userId: VALID_USER_ID }),
    ).rejects.toThrow(/failed to list/)
  })

  it('default vazio quando metadata ausente (graceful degradation)', async () => {
    bucketAPI.list.mockResolvedValue({
      data: [{ name: 'a.csv', created_at: '2026-04-26T12:00:00Z' }],
      error: null,
    })

    const result = await adapter.listForUser({ userId: VALID_USER_ID })

    expect(result[0].sizeBytes).toBe(0)
    expect(result[0].contentType).toBe('application/octet-stream')
  })
})

describe('SupabaseStorageAdapter — getTotalSize', () => {
  it('soma bytes de todos os objetos top-level', async () => {
    bucketAPI.list.mockResolvedValue({
      data: [
        { name: 'a', metadata: { size: 100 } },
        { name: 'b', metadata: { size: 250 } },
        { name: 'c', metadata: { size: 50 } },
      ],
      error: null,
    })

    const result = await adapter.getTotalSize()

    expect(result.bytes).toBe(400)
  })

  it('retorna 0 em bucket vazio', async () => {
    bucketAPI.list.mockResolvedValue({ data: [], error: null })

    const result = await adapter.getTotalSize()

    expect(result.bytes).toBe(0)
  })

  it('lista com limit max (1000)', async () => {
    bucketAPI.list.mockResolvedValue({ data: [], error: null })

    await adapter.getTotalSize()

    expect(bucketAPI.list).toHaveBeenCalledWith('', { limit: 1000 })
  })

  it('mapeia erro → LIST_FAILED', async () => {
    bucketAPI.list.mockResolvedValue({
      data: null,
      error: { message: 'service down' },
    })

    await expect(adapter.getTotalSize()).rejects.toThrow(
      /failed to compute total size/,
    )
  })
})

describe('SupabaseStorageAdapter — content-type validation (fix-pack #6)', () => {
  it('rejeita contentType fora da whitelist com INVALID_CONTENT_TYPE', async () => {
    await expect(
      adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        buffer: Buffer.from('a,b'),
        contentType: 'text/html',
      }),
    ).rejects.toThrow(/contentType must be one of/)
    expect(bucketAPI.upload).not.toHaveBeenCalled()
  })

  it('rejeita contentType vazio', async () => {
    await expect(
      adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        buffer: Buffer.from('a,b'),
        contentType: '',
      }),
    ).rejects.toThrow(/contentType must be one of/)
  })

  it.each([
    ['text/csv', 'csv'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    ],
    ['application/vnd.ms-excel', 'xls'],
  ] as const)('aceita contentType permitido: %s', async (mime, ext) => {
    bucketAPI.upload.mockResolvedValue({ data: { path: 'mock' }, error: null })

    await expect(
      adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext,
        buffer: Buffer.from(''),
        contentType: mime,
      }),
    ).resolves.toBeDefined()
  })
})

describe('SUPABASE_ERROR_PATTERNS — regression fixture (fix-pack #2)', () => {
  // Hard guard: SDK pode mudar mensagens em minor bump. Tests fixture-based
  // detectam regressão antes de prod. Se Supabase mudar "already exists"
  // pra "duplicate key" sem o segundo termo, o regex deve ser atualizado
  // EXPLICITAMENTE — esse teste falha como sinal.

  it('alreadyExists casa "The resource already exists"', () => {
    expect(
      SUPABASE_ERROR_PATTERNS.alreadyExists.test('The resource already exists'),
    ).toBe(true)
  })

  it('alreadyExists casa "Duplicate" (case-insensitive)', () => {
    expect(SUPABASE_ERROR_PATTERNS.alreadyExists.test('Duplicate key')).toBe(
      true,
    )
  })

  it('alreadyExists NÃO casa "permission denied"', () => {
    expect(
      SUPABASE_ERROR_PATTERNS.alreadyExists.test('permission denied'),
    ).toBe(false)
  })

  it('notFound casa "Object not found"', () => {
    expect(SUPABASE_ERROR_PATTERNS.notFound.test('Object not found')).toBe(true)
  })

  it('notFound casa "does not exist"', () => {
    expect(SUPABASE_ERROR_PATTERNS.notFound.test('Bucket does not exist')).toBe(
      true,
    )
  })

  it('notFound NÃO casa "permission denied"', () => {
    expect(SUPABASE_ERROR_PATTERNS.notFound.test('permission denied')).toBe(
      false,
    )
  })
})

describe('SupabaseStorageAdapter — expiresAt determinístico (fix-pack #8c)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expiresAt = now + ttl*1000 ms (boundary preciso)', async () => {
    const fixedNow = new Date('2026-04-26T12:00:00Z')
    vi.setSystemTime(fixedNow)
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://x' },
      error: null,
    })

    const result = await adapter.getSignedUrlForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
      expiresInSeconds: 60,
    })

    expect(result.expiresAt.getTime()).toBe(fixedNow.getTime() + 60 * 1000)
  })

  it('TTL default 300s aplicado corretamente', async () => {
    const fixedNow = new Date('2026-04-26T12:00:00Z')
    vi.setSystemTime(fixedNow)
    bucketAPI.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://x' },
      error: null,
    })

    const result = await adapter.getSignedUrlForUser({
      userId: VALID_USER_ID,
      jobId: VALID_JOB_ID,
      ext: 'csv',
    })

    expect(result.expiresAt.getTime()).toBe(fixedNow.getTime() + 300 * 1000)
  })
})

describe('SupabaseStorageAdapter — cause sanitização em prod (fix-pack #3)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
  })

  it('em production: storageError.cause é zerado (anti information-disclosure)', async () => {
    process.env.NODE_ENV = 'production'
    bucketAPI.upload.mockResolvedValue({
      data: null,
      error: { message: 'internal supabase shape leak' },
    })

    let captured: { storageError?: { cause?: unknown } } | undefined
    try {
      await adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        buffer: Buffer.from(''),
        contentType: 'text/csv',
      })
    } catch (e) {
      captured = e as { storageError?: { cause?: unknown } }
    }

    expect(captured?.storageError).toBeDefined()
    expect(captured?.storageError?.cause).toBeUndefined()
  })

  it('em test/dev: storageError.cause é preservado (debug)', async () => {
    process.env.NODE_ENV = 'test'
    bucketAPI.upload.mockResolvedValue({
      data: null,
      error: { message: 'debuggable error message' },
    })

    let captured: { storageError?: { cause?: unknown } } | undefined
    try {
      await adapter.uploadForUser({
        userId: VALID_USER_ID,
        jobId: VALID_JOB_ID,
        ext: 'csv',
        buffer: Buffer.from(''),
        contentType: 'text/csv',
      })
    } catch (e) {
      captured = e as { storageError?: { cause?: unknown } }
    }

    expect(captured?.storageError?.cause).toBe('debuggable error message')
  })
})
