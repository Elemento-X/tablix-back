/**
 * Integration tests do storage (Card 5.1)
 *
 * Bate no Supabase Storage REAL contra o bucket `tablix-history-staging`
 * configurado em `SUPABASE_STORAGE_BUCKET`. Cobre o caminho completo
 * do adapter — upload, signed URL com fetch real, list, delete.
 *
 * **Skip automático** se env não está configurada (dev local sem
 * `SUPABASE_URL`/`SUPABASE_STORAGE_KEY`/`SUPABASE_STORAGE_BUCKET`).
 *
 * Cleanup: `afterEach` deleta TODOS os objetos criados pelo userId
 * de teste — testes idempotentes mesmo se interrompidos.
 *
 * @owner: @tester
 * @card: 5.1 — Adapter de storage (Fase 5)
 */
// Carrega `.env` antes de ler as vars — globalSetup do integration NÃO
// importa env.ts (que importa dotenv) por design (anti-prod guard sobre
// DATABASE_URL acontece antes). dotenv aqui não sobrescreve `DATABASE_URL`
// já setada pelo globalSetup (default: no override de vars existentes).
import 'dotenv/config'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createSupabaseStorageAdapter } from '../../src/lib/storage/supabase.adapter'
import type { SupabaseStorageAdapter } from '../../src/lib/storage/supabase.adapter'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_STORAGE_KEY = process.env.SUPABASE_STORAGE_KEY
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET

const skipIfNoEnv =
  !SUPABASE_URL || !SUPABASE_STORAGE_KEY || !SUPABASE_STORAGE_BUCKET

describe.skipIf(skipIfNoEnv)('storage integration — Supabase real', () => {
  let adapter: SupabaseStorageAdapter
  let testUserId: string
  // jobIds criados pelo teste corrente — deletados em afterEach
  const createdJobs: Array<{ jobId: string; ext: 'csv' | 'xlsx' | 'xls' }> = []

  beforeAll(() => {
    adapter = createSupabaseStorageAdapter({
      url: SUPABASE_URL!,
      key: SUPABASE_STORAGE_KEY!,
      bucket: SUPABASE_STORAGE_BUCKET!,
    })
  })

  beforeEach(() => {
    // Fix-pack @tester MÉDIO `7f3a1c8b4e9d`: prefixo identificável pra
    // permitir cleanup script diferenciar test data de prod data em
    // caso de orphan (afterEach interrompido por crash/CTRL+C).
    //
    // Pattern do randomUUID + assert local de UUID v4: gera UUID válido
    // que começa com "00000000-test" como marcador. Ainda casa
    // UUID_V4_REGEX porque mantém o formato 8-4-4-4-12.
    //
    // Atual: usar apenas randomUUID() — TODO migrar pra prefixo após
    // helper de cleanup ser criado em script separado (Card 5.7 cron).
    testUserId = randomUUID()
    createdJobs.length = 0
  })

  afterEach(async () => {
    for (const { jobId, ext } of createdJobs) {
      await adapter
        .deleteForUser({ userId: testUserId, jobId, ext })
        .catch(() => undefined) // best-effort cleanup
    }
  })

  it('upload + list + delete (caminho feliz)', async () => {
    const jobId = `tst${randomUUID().replace(/-/g, '').slice(0, 12)}`
    createdJobs.push({ jobId, ext: 'csv' })

    const upload = await adapter.uploadForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
      buffer: Buffer.from('nome,email\nAlice,a@x.com\n', 'utf-8'),
      contentType: 'text/csv',
    })
    expect(upload.path).toContain(testUserId)
    expect(upload.path).toContain('.csv')

    const list = await adapter.listForUser({ userId: testUserId })
    // Listing pode demorar pra propagar — mas pra um upload imediato
    // deve estar lá. Se flaky, considerar retry.
    expect(list.length).toBeGreaterThanOrEqual(1)

    const del = await adapter.deleteForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
    })
    expect(del.deleted).toBe(true)
    createdJobs.length = 0 // já deletado
  })

  it('upload duplicado rejeita com OBJECT_ALREADY_EXISTS', async () => {
    const jobId = `dup${randomUUID().replace(/-/g, '').slice(0, 12)}`
    createdJobs.push({ jobId, ext: 'csv' })

    await adapter.uploadForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
      buffer: Buffer.from('a,b\n'),
      contentType: 'text/csv',
    })

    await expect(
      adapter.uploadForUser({
        userId: testUserId,
        jobId,
        ext: 'csv',
        buffer: Buffer.from('c,d\n'),
        contentType: 'text/csv',
      }),
    ).rejects.toThrow(/already exists/)
  })

  it('signed URL retorna URL fetchável com conteúdo correto', async () => {
    const jobId = `url${randomUUID().replace(/-/g, '').slice(0, 12)}`
    createdJobs.push({ jobId, ext: 'csv' })

    const content = 'header1,header2\nv1,v2\n'
    await adapter.uploadForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
      buffer: Buffer.from(content, 'utf-8'),
      contentType: 'text/csv',
    })

    const signed = await adapter.getSignedUrlForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
      expiresInSeconds: 60,
    })
    expect(signed.url).toMatch(/^https:\/\//)

    const res = await fetch(signed.url)
    expect(res.ok).toBe(true)
    const body = await res.text()
    expect(body).toBe(content)
  })

  it('signed URL pra objeto inexistente: SIGNED_URL_FAILED ou OBJECT_NOT_FOUND', async () => {
    const jobId = `nope${randomUUID().replace(/-/g, '').slice(0, 12)}`

    await expect(
      adapter.getSignedUrlForUser({
        userId: testUserId,
        jobId,
        ext: 'xlsx',
      }),
    ).rejects.toThrow(/(not found|signed URL)/)
  })

  it('delete idempotente: objeto inexistente não falha', async () => {
    const jobId = `del${randomUUID().replace(/-/g, '').slice(0, 12)}`

    const result = await adapter.deleteForUser({
      userId: testUserId,
      jobId,
      ext: 'csv',
    })

    expect(result.deleted).toBe(false)
  })

  it('list de user sem objetos retorna vazio', async () => {
    const isolatedUser = randomUUID()
    const result = await adapter.listForUser({ userId: isolatedUser })
    expect(result).toEqual([])
  })

  it('getTotalSize retorna número não-negativo', async () => {
    const result = await adapter.getTotalSize()
    expect(result.bytes).toBeGreaterThanOrEqual(0)
  })

  it('rejeita userId não-UUID antes de tocar Supabase', async () => {
    await expect(
      adapter.uploadForUser({
        userId: 'not-a-uuid',
        jobId: 'cuid12345',
        ext: 'csv',
        buffer: Buffer.from(''),
        contentType: 'text/csv',
      }),
    ).rejects.toThrow(/UUID v4/)
  })
})
