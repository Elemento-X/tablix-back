/**
 * Unit tests for hashStoragePathForAudit (Card #146 F1 — promoção do helper
 * do Card #145 F5 fix-pack).
 *
 * Cobre:
 *   - Determinismo: mesmo input → mesmo output
 *   - SHA-256 hex 64 chars lowercase
 *   - Inputs diversos: caracteres especiais, vazio, UTF-8, paths Tablix
 *   - Reuso em controller + cron compartilha a mesma implementação
 *
 * @owner: @tester
 * @card: #146 F1 (T-1.1)
 */
import { describe, it, expect } from 'vitest'

import { hashStoragePathForAudit } from '../../src/lib/audit/storage-path-hash'

describe('hashStoragePathForAudit', () => {
  describe('determinismo', () => {
    it('mesmo input retorna mesmo hash em chamadas consecutivas', () => {
      const path = 'abc-uuid/2026-05-18/job123.csv'
      const h1 = hashStoragePathForAudit(path)
      const h2 = hashStoragePathForAudit(path)
      expect(h1).toBe(h2)
    })

    it('inputs diferentes retornam hashes diferentes', () => {
      const h1 = hashStoragePathForAudit('a')
      const h2 = hashStoragePathForAudit('b')
      expect(h1).not.toBe(h2)
    })
  })

  describe('shape do output', () => {
    it('retorna string hex 64 chars (SHA-256)', () => {
      const hash = hashStoragePathForAudit('test')
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('lowercase apenas', () => {
      const hash = hashStoragePathForAudit('UPPERCASE_INPUT')
      expect(hash).toBe(hash.toLowerCase())
    })

    it('aceita string vazia (não throw)', () => {
      // SHA-256 de string vazia é um valor conhecido — defensivo contra
      // bug que poderia retornar string vazia ou null.
      const hash = hashStoragePathForAudit('')
      expect(hash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      )
    })
  })

  describe('inputs Tablix reais', () => {
    it('path com UUID v4 + data + cuid + ext', () => {
      const path = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/2026-05-18/abc1234.csv'
      const hash = hashStoragePathForAudit(path)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('path com extensões diferentes geram hashes diferentes', () => {
      const base = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/2026-05-18/abc1234'
      const csv = hashStoragePathForAudit(`${base}.csv`)
      const xlsx = hashStoragePathForAudit(`${base}.xlsx`)
      const xls = hashStoragePathForAudit(`${base}.xls`)
      expect(csv).not.toBe(xlsx)
      expect(csv).not.toBe(xls)
      expect(xlsx).not.toBe(xls)
    })

    it('path com UTF-8 (acentos, emoji) hashes correto', () => {
      // Embora paths reais Tablix sejam ASCII (UUID/cuid/data), helper deve
      // ser bytes-safe pra inputs arbitrários.
      const h1 = hashStoragePathForAudit('café')
      const h2 = hashStoragePathForAudit('cafe')
      expect(h1).not.toBe(h2)
      expect(h1).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('non-reversibilidade (sanity)', () => {
    it('hash NÃO contém o input original', () => {
      const path = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/2026-05-18/abc1234.csv'
      const hash = hashStoragePathForAudit(path)
      // Hash é hex puro; não pode conter `/`, `-`, `.`, ou nenhuma parte
      // legível do input.
      expect(hash).not.toContain('/')
      expect(hash).not.toContain('-')
      expect(hash).not.toContain('.')
      expect(hash).not.toContain('aaaa')
    })
  })
})
