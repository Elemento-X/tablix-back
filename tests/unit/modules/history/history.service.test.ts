/**
 * History service tests — Card #145 (5.2a) F3.
 *
 * Cobre helpers puros (encodeCursor/decodeCursor + toFileHistoryDto
 * whitelist) — F3 fix-pack do @tester ALTO. Operações complexas (Prisma
 * queries reais + advisory lock + audit_log_legal AWAIT) ficam em
 * integration tests deferidos pra discovery card.
 *
 * @owner: @tester
 * @card: #145 (5.2a) F3
 */
import { describe, it, expect } from 'vitest'
import type { FileHistory } from '@prisma/client'

import {
  __testing,
  toFileHistoryDto,
} from '../../../../src/modules/history/history.service'

const { encodeCursor, decodeCursor, DELETE_ALL_BATCH_CAP } = __testing

const validUuidV4 = '550e8400-e29b-41d4-a716-446655440000'

describe('history.service helpers (Card #145 F3)', () => {
  describe('encodeCursor + decodeCursor — roundtrip', () => {
    it('roundtrip preserva id e createdAt', () => {
      const id = validUuidV4
      const createdAt = new Date('2026-05-04T12:00:00.000Z')
      const cursor = encodeCursor(id, createdAt)
      const decoded = decodeCursor(cursor)
      expect(decoded).not.toBeNull()
      expect(decoded?.id).toBe(id)
      expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString())
    })

    it('cursor é base64url (sem chars problemáticos URL)', () => {
      const cursor = encodeCursor(validUuidV4, new Date())
      expect(cursor).not.toContain('+')
      expect(cursor).not.toContain('/')
      expect(cursor).not.toContain('=')
    })
  })

  describe('decodeCursor — defesa contra cursor malformado', () => {
    it('retorna null pra base64 malformado', () => {
      expect(decodeCursor('not_valid_base64!@#')).toBeNull()
    })

    it('retorna null pra JSON inválido', () => {
      const malformed = Buffer.from('not json', 'utf8').toString('base64url')
      expect(decodeCursor(malformed)).toBeNull()
    })

    it('retorna null pra missing id', () => {
      const noId = Buffer.from(
        JSON.stringify({ createdAt: '2026-05-04T12:00:00Z' }),
        'utf8',
      ).toString('base64url')
      expect(decodeCursor(noId)).toBeNull()
    })

    it('retorna null pra missing createdAt', () => {
      const noDate = Buffer.from(
        JSON.stringify({ id: validUuidV4 }),
        'utf8',
      ).toString('base64url')
      expect(decodeCursor(noDate)).toBeNull()
    })

    it('retorna null pra createdAt não-string', () => {
      const wrongType = Buffer.from(
        JSON.stringify({ id: validUuidV4, createdAt: 123 }),
        'utf8',
      ).toString('base64url')
      expect(decodeCursor(wrongType)).toBeNull()
    })

    it('retorna null pra datetime inválido (Invalid Date)', () => {
      const badDate = Buffer.from(
        JSON.stringify({ id: validUuidV4, createdAt: 'not-a-date' }),
        'utf8',
      ).toString('base64url')
      expect(decodeCursor(badDate)).toBeNull()
    })

    it('retorna null pra string vazia', () => {
      expect(decodeCursor('')).toBeNull()
    })

    it('NUNCA throws — sempre retorna null em malformed input', () => {
      // Property: cursor inválido NUNCA causa throw (defesa contra DoS via
      // input adversarial)
      const adversarialInputs = [
        '\x00\x01\x02',
        'a'.repeat(10000),
        '🚀',
        '%%%%',
        Buffer.from('not json', 'utf8').toString('base64url'),
      ]
      for (const input of adversarialInputs) {
        expect(() => decodeCursor(input)).not.toThrow()
        expect(decodeCursor(input)).toBeNull()
      }
    })
  })

  describe('toFileHistoryDto — whitelist (NUNCA vaza campos internos)', () => {
    /**
     * Whitelist explícita: response NUNCA pode conter `userId`, `storagePath`,
     * `deletedAt`, `purgeAttempts` — são uso interno do cron #146.
     * Se schema do banco evoluir e adicionar campo, regression test pega.
     */
    const ALLOWED_DTO_KEYS = [
      'id',
      'originalFilename',
      'mimeType',
      'fileSizeBytes',
      'createdAt',
      'expiresAt',
    ]

    const sampleRow: FileHistory = {
      id: validUuidV4,
      userId: 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa', // PII — NUNCA expor
      storagePath:
        'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa/2026-05-04/abc1234567.csv',
      originalFilename: 'rj_dezembro.csv',
      mimeType: 'text/csv',
      fileSize: 1024,
      expiresAt: new Date('2026-06-03T12:00:00.000Z'),
      deletedAt: null,
      purgeAttempts: 0,
      createdAt: new Date('2026-05-04T12:00:00.000Z'),
    }

    it('retorna apenas chaves whitelisted', () => {
      const dto = toFileHistoryDto(sampleRow)
      const keys = Object.keys(dto).sort()
      expect(keys).toEqual([...ALLOWED_DTO_KEYS].sort())
    })

    it('NUNCA expõe userId', () => {
      const dto = toFileHistoryDto(sampleRow)
      expect(dto).not.toHaveProperty('userId')
    })

    it('NUNCA expõe storagePath (cross-card DTO interno)', () => {
      const dto = toFileHistoryDto(sampleRow)
      expect(dto).not.toHaveProperty('storagePath')
    })

    it('NUNCA expõe deletedAt (sentinela two-phase interna)', () => {
      const rowWithDeletedAt = {
        ...sampleRow,
        deletedAt: new Date('2026-05-04T13:00:00.000Z'),
      }
      const dto = toFileHistoryDto(rowWithDeletedAt)
      expect(dto).not.toHaveProperty('deletedAt')
    })

    it('NUNCA expõe purgeAttempts (uso interno cron)', () => {
      const dto = toFileHistoryDto({ ...sampleRow, purgeAttempts: 3 })
      expect(dto).not.toHaveProperty('purgeAttempts')
    })

    it('mapeia fileSize → fileSizeBytes (camelCase + unit explícito)', () => {
      const dto = toFileHistoryDto(sampleRow)
      expect(dto.fileSizeBytes).toBe(1024)
      expect(dto).not.toHaveProperty('fileSize')
    })

    it('serializa Date → ISO string (api-contract.md)', () => {
      const dto = toFileHistoryDto(sampleRow)
      expect(dto.createdAt).toBe('2026-05-04T12:00:00.000Z')
      expect(dto.expiresAt).toBe('2026-06-03T12:00:00.000Z')
    })
  })

  describe('DELETE_ALL_BATCH_CAP — invariante R-4', () => {
    it('cap é 10000 conforme R-4 do plano', () => {
      expect(DELETE_ALL_BATCH_CAP).toBe(10_000)
    })
  })
})
