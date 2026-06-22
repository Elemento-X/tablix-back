/**
 * Unit tests de SupabaseStorageAdapter.downloadByPath (Card 6.2 — G-2).
 *
 * Mock do SupabaseClient injetado. Cobre:
 *   - sucesso: Blob → Buffer + contentType derivado da ext (EXTENSION_TO_MIME)
 *   - OBJECT_NOT_FOUND: error "not found" com data null
 *   - OBJECT_NOT_FOUND: data null sem error reconhecível (tratado como 404)
 *   - DOWNLOAD_FAILED: erro genérico do Supabase
 *   - PATH_TRAVERSAL_REJECTED ANTES de tocar o client (path inválido)
 *   - contentType por ext (csv/xlsx/xls)
 *   - aceita forma job-scoped (input-NN) e legada
 *
 * @owner: @tester
 * @card: 6.2 — Setup BullMQ + conexão Redis TCP (Fase 6)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupabaseStorageAdapter } from '../../src/lib/storage/supabase.adapter'
import { EXTENSION_TO_MIME } from '../../src/lib/storage/types'

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DATE = '2026-06-21'
const JOBKEY = '8c7e123456784abc89def01234567890'
const BUCKET = 'tablix-history-staging'

const INPUT_CSV = `${UUID}/${DATE}/${JOBKEY}/input-00.csv`
const OUTPUT_XLSX = `${UUID}/${DATE}/${JOBKEY}/output.xlsx`
const LEGACY_XLS = `${UUID}/${DATE}/abc1234.xls`

interface MockBucketAPI {
  download: ReturnType<typeof vi.fn>
}

function makeMockClient(bucketAPI: MockBucketAPI) {
  return {
    storage: {
      from: vi.fn().mockReturnValue(bucketAPI),
    },
  }
}

/**
 * Fake Blob — supabase-js v2 retorna Blob com `.arrayBuffer()`. Não dependemos
 * do Blob global do Node; um objeto com arrayBuffer() basta pro adapter.
 */
function fakeBlob(content: string) {
  const bytes = new TextEncoder().encode(content)
  return {
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
  }
}

let bucketAPI: MockBucketAPI
let adapter: SupabaseStorageAdapter

beforeEach(() => {
  bucketAPI = { download: vi.fn() }
  adapter = new SupabaseStorageAdapter(
    makeMockClient(bucketAPI) as unknown as ConstructorParameters<
      typeof SupabaseStorageAdapter
    >[0],
    BUCKET,
  )
})

describe('downloadByPath — sucesso', () => {
  it('Blob → Buffer com conteúdo correto + contentType da ext (csv)', async () => {
    bucketAPI.download.mockResolvedValue({
      data: fakeBlob('a,b,c\n1,2,3'),
      error: null,
    })

    const result = await adapter.downloadByPath(INPUT_CSV)

    expect(Buffer.isBuffer(result.buffer)).toBe(true)
    expect(result.buffer.toString('utf8')).toBe('a,b,c\n1,2,3')
    expect(result.contentType).toBe(EXTENSION_TO_MIME.csv)
    expect(bucketAPI.download).toHaveBeenCalledWith(INPUT_CSV)
  })

  it('contentType derivado da ext xlsx (não do metadata do Blob)', async () => {
    bucketAPI.download.mockResolvedValue({
      data: fakeBlob('binary-xlsx'),
      error: null,
    })

    const result = await adapter.downloadByPath(OUTPUT_XLSX)
    expect(result.contentType).toBe(EXTENSION_TO_MIME.xlsx)
  })

  it('aceita forma legada (sync) e deriva contentType xls', async () => {
    bucketAPI.download.mockResolvedValue({
      data: fakeBlob('legacy'),
      error: null,
    })

    const result = await adapter.downloadByPath(LEGACY_XLS)
    expect(result.contentType).toBe(EXTENSION_TO_MIME.xls)
  })

  it('buffer vazio quando objeto vazio (0 bytes)', async () => {
    bucketAPI.download.mockResolvedValue({ data: fakeBlob(''), error: null })

    const result = await adapter.downloadByPath(INPUT_CSV)
    expect(result.buffer).toHaveLength(0)
  })
})

describe('downloadByPath — OBJECT_NOT_FOUND', () => {
  it('error "Object not found" + data null → OBJECT_NOT_FOUND', async () => {
    bucketAPI.download.mockResolvedValue({
      data: null,
      error: { message: 'Object not found' },
    })

    await expect(adapter.downloadByPath(INPUT_CSV)).rejects.toThrow(
      /object not found/i,
    )
  })

  it('data null sem error reconhecível → tratado como not-found', async () => {
    bucketAPI.download.mockResolvedValue({ data: null, error: null })

    let captured: { storageError?: { code?: string } } | undefined
    try {
      await adapter.downloadByPath(INPUT_CSV)
    } catch (e) {
      captured = e as { storageError?: { code?: string } }
    }
    expect(captured?.storageError?.code).toBe('OBJECT_NOT_FOUND')
  })

  it('error "does not exist" → OBJECT_NOT_FOUND', async () => {
    bucketAPI.download.mockResolvedValue({
      data: null,
      error: { message: 'Bucket does not exist' },
    })

    let captured: { storageError?: { code?: string } } | undefined
    try {
      await adapter.downloadByPath(INPUT_CSV)
    } catch (e) {
      captured = e as { storageError?: { code?: string } }
    }
    expect(captured?.storageError?.code).toBe('OBJECT_NOT_FOUND')
  })
})

describe('downloadByPath — DOWNLOAD_FAILED', () => {
  it('erro genérico do Supabase (com data null) → DOWNLOAD_FAILED', async () => {
    bucketAPI.download.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    })

    let captured: { storageError?: { code?: string } } | undefined
    try {
      await adapter.downloadByPath(INPUT_CSV)
    } catch (e) {
      captured = e as { storageError?: { code?: string } }
    }
    expect(captured?.storageError?.code).toBe('DOWNLOAD_FAILED')
  })

  it('erro genérico mas COM data presente → ainda DOWNLOAD_FAILED', async () => {
    // error truthy entra no branch de erro mesmo com data; não é "not found".
    bucketAPI.download.mockResolvedValue({
      data: fakeBlob('x'),
      error: { message: 'rate limited' },
    })

    await expect(adapter.downloadByPath(INPUT_CSV)).rejects.toThrow(
      /failed to download/i,
    )
  })
})

describe('downloadByPath — validação de path ANTES do client', () => {
  it('rejeita `..` (traversal) sem tocar o Supabase', async () => {
    await expect(adapter.downloadByPath('../etc/passwd.csv')).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })

  it('rejeita `\\` (Windows separator) sem tocar o Supabase', async () => {
    await expect(
      adapter.downloadByPath(`${UUID}\\${DATE}\\abc1234.csv`),
    ).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })

  it('rejeita ext fora da whitelist sem tocar o Supabase', async () => {
    await expect(
      adapter.downloadByPath(`${UUID}/${DATE}/${JOBKEY}/input-00.exe`),
    ).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })

  it('rejeita UUID uppercase sem tocar o Supabase', async () => {
    await expect(
      adapter.downloadByPath(`${UUID.toUpperCase()}/${DATE}/abc1234.csv`),
    ).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })

  it('rejeita filename arbitrário na subpasta sem tocar o Supabase', async () => {
    await expect(
      adapter.downloadByPath(`${UUID}/${DATE}/${JOBKEY}/evil.csv`),
    ).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })

  it('rejeita string vazia sem tocar o Supabase', async () => {
    await expect(adapter.downloadByPath('')).rejects.toThrow()
    expect(bucketAPI.download).not.toHaveBeenCalled()
  })
})
