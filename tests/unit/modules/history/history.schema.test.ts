/**
 * Tests do contrato Zod cross-card (Card #145 — 5.2a).
 *
 * Schema é CONGELADO v1 e consumido por:
 *  - Card #145 (5.2a) — endpoints REST
 *  - Card #146 (5.2b) — cron purge two-phase
 *  - Card #147 (5.2c) — cron alerta quota
 *
 * Mutation testing aqui rende ALTO valor: asserções negativas (rejeição de
 * boundary, control chars, UUID uppercase) detectam regressão em z.literal,
 * z.uuid, .strict() — falhas que integration de happy-path não pega.
 *
 * @owner: @tester
 * @card: #145 (5.2a) F2
 */
import { describe, it, expect } from 'vitest'
import {
  DELETE_ALL_CONFIRMATION_LITERAL,
  HISTORY_LIST_DEFAULT_LIMIT,
  HISTORY_LIST_MAX_LIMIT,
  enableHistoryRequestSchema,
  disableHistoryRequestSchema,
  listHistoryQuerySchema,
  getHistoryParamsSchema,
  deleteOneHistoryParamsSchema,
  deleteOneHistoryRequestSchema,
  deleteAllHistoryRequestSchema,
  fileHistoryDtoSchema,
  filePurgeCandidateSchema,
  userStorageAggregateSchema,
} from '../../../../src/modules/history/history.schema'

const validUuidV4 = '550e8400-e29b-41d4-a716-446655440000'
const uppercaseUuid = '550E8400-E29B-41D4-A716-446655440000'
const nilUuid = '00000000-0000-0000-0000-000000000000'
// UUID v3 — version=3 no 13º char (em vez de 4)
const uuidV3 = '550e8400-e29b-31d4-a716-446655440000'

describe('history.schema (Card #145 contrato cross-card v1)', () => {
  describe('DELETE_ALL_CONFIRMATION_LITERAL — D#1 fechada', () => {
    it('exporta literal exato CONFIRM_DELETE_ALL', () => {
      expect(DELETE_ALL_CONFIRMATION_LITERAL).toBe('CONFIRM_DELETE_ALL')
    })

    it('aceita literal exato', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: 'CONFIRM_DELETE_ALL',
      })
      expect(result.success).toBe(true)
    })

    it('rejeita boolean true (z.literal não coage)', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: true,
      })
      expect(result.success).toBe(false)
    })

    it('rejeita string lowercase "confirm_delete_all"', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: 'confirm_delete_all',
      })
      expect(result.success).toBe(false)
    })

    it('rejeita string com whitespace " CONFIRM_DELETE_ALL "', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: ' CONFIRM_DELETE_ALL ',
      })
      expect(result.success).toBe(false)
    })

    it('rejeita string com null byte CONFIRM_DELETE_ALL\\x00', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: 'CONFIRM_DELETE_ALL\x00',
      })
      expect(result.success).toBe(false)
    })

    it('rejeita null', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: null,
      })
      expect(result.success).toBe(false)
    })

    it('rejeita undefined / missing', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({})
      expect(result.success).toBe(false)
    })

    it('rejeita extra props (.strict())', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: 'CONFIRM_DELETE_ALL',
        sneakyField: 'should be rejected',
      })
      expect(result.success).toBe(false)
    })

    it('mensagem de erro inclui payload literal pra dev', () => {
      const result = deleteAllHistoryRequestSchema.safeParse({
        confirmation: 'wrong',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ')
        expect(messages).toContain('CONFIRM_DELETE_ALL')
      }
    })
  })

  describe('originalFilename (espelha CHECK constraint do schema DB)', () => {
    const baseListQuery = (filename: string) =>
      fileHistoryDtoSchema.safeParse({
        id: validUuidV4,
        originalFilename: filename,
        mimeType: 'text/csv',
        fileSizeBytes: 1024,
        createdAt: '2026-05-03T12:00:00.000Z',
        expiresAt: '2026-06-02T12:00:00.000Z',
      })

    it('aceita filename normal "rj_dezembro.csv"', () => {
      expect(baseListQuery('rj_dezembro.csv').success).toBe(true)
    })

    it('aceita acentos PT-BR "relatório.csv"', () => {
      expect(baseListQuery('relatório.csv').success).toBe(true)
    })

    it('aceita emoji 📊 (não é control char)', () => {
      expect(baseListQuery('vendas-📊.csv').success).toBe(true)
    })

    it('aceita 1 char (boundary mínimo)', () => {
      expect(baseListQuery('a').success).toBe(true)
    })

    it('aceita 255 chars (boundary máximo)', () => {
      expect(baseListQuery('a'.repeat(255)).success).toBe(true)
    })

    it('rejeita string vazia', () => {
      expect(baseListQuery('').success).toBe(false)
    })

    it('rejeita 256 chars (off-by-one)', () => {
      expect(baseListQuery('a'.repeat(256)).success).toBe(false)
    })

    it('rejeita NUL (0x00)', () => {
      expect(baseListQuery('bad\x00.csv').success).toBe(false)
    })

    it('rejeita US (0x1F) — boundary final do range C0', () => {
      expect(baseListQuery('bad\x1f.csv').success).toBe(false)
    })

    it('rejeita DEL (0x7F) — fix-pack F1', () => {
      expect(baseListQuery('bad\x7f.csv').success).toBe(false)
    })

    it('aceita SPACE (0x20) — boundary inicial fora do C0', () => {
      expect(baseListQuery('my file.csv').success).toBe(true)
    })

    it('rejeita LRM U+200E (bidi mark)', () => {
      expect(baseListQuery('bad\u200E.csv').success).toBe(false)
    })

    it('rejeita line separator U+2028', () => {
      expect(baseListQuery('bad\u2028.csv').success).toBe(false)
    })

    it('rejeita paragraph separator U+2029', () => {
      expect(baseListQuery('bad\u2029.csv').success).toBe(false)
    })

    it('rejeita RLO U+202E (bidi override — anti-spoof)', () => {
      // Vetor: filename "evil‮txt.exe" exibido como "evilexe.txt"
      expect(baseListQuery('evil\u202Etxt.exe').success).toBe(false)
    })
  })

  describe('uuidV4Schema (lowercase strict RFC 4122)', () => {
    const parseId = (id: string) => getHistoryParamsSchema.safeParse({ id })

    it('aceita UUID v4 lowercase válido', () => {
      expect(parseId(validUuidV4).success).toBe(true)
    })

    it('rejeita UUID v4 UPPERCASE', () => {
      expect(parseId(uppercaseUuid).success).toBe(false)
    })

    it('rejeita UUID v3', () => {
      expect(parseId(uuidV3).success).toBe(false)
    })

    it('rejeita NIL UUID 00000000-...', () => {
      expect(parseId(nilUuid).success).toBe(false)
    })

    it('rejeita string não-UUID', () => {
      expect(parseId('not-a-uuid').success).toBe(false)
    })

    it('rejeita UUID com caracteres extras "uuid_extra"', () => {
      expect(parseId(`${validUuidV4}_extra`).success).toBe(false)
    })
  })

  describe('listHistoryQuerySchema', () => {
    it('aplica defaults limit=20 quando ausente', () => {
      const result = listHistoryQuerySchema.parse({})
      expect(result.limit).toBe(HISTORY_LIST_DEFAULT_LIMIT)
      expect(result.cursor).toBeUndefined()
    })

    it('rejeita limit=0', () => {
      const result = listHistoryQuerySchema.safeParse({ limit: 0 })
      expect(result.success).toBe(false)
    })

    it('aceita limit=1 (boundary mínimo)', () => {
      const result = listHistoryQuerySchema.safeParse({ limit: 1 })
      expect(result.success).toBe(true)
    })

    it('aceita limit=100 (boundary max)', () => {
      const result = listHistoryQuerySchema.safeParse({
        limit: HISTORY_LIST_MAX_LIMIT,
      })
      expect(result.success).toBe(true)
    })

    it('rejeita limit=101 (off-by-one)', () => {
      const result = listHistoryQuerySchema.safeParse({
        limit: HISTORY_LIST_MAX_LIMIT + 1,
      })
      expect(result.success).toBe(false)
    })

    it('coerce string "30" → number 30', () => {
      const result = listHistoryQuerySchema.parse({ limit: '30' })
      expect(result.limit).toBe(30)
    })

    it('rejeita cursor com 513 chars', () => {
      const result = listHistoryQuerySchema.safeParse({
        cursor: 'a'.repeat(513),
      })
      expect(result.success).toBe(false)
    })

    it('aceita cursor com 512 chars (boundary)', () => {
      const result = listHistoryQuerySchema.safeParse({
        cursor: 'a'.repeat(512),
      })
      expect(result.success).toBe(true)
    })

    it('rejeita cursor vazio (min 1)', () => {
      const result = listHistoryQuerySchema.safeParse({ cursor: '' })
      expect(result.success).toBe(false)
    })
  })

  describe('enable/disable/deleteOne — bodies vazios + .strict()', () => {
    it('enableHistoryRequestSchema aceita {} vazio', () => {
      expect(enableHistoryRequestSchema.safeParse({}).success).toBe(true)
    })

    it('enableHistoryRequestSchema rejeita extra prop', () => {
      expect(
        enableHistoryRequestSchema.safeParse({ extra: 'field' }).success,
      ).toBe(false)
    })

    it('disableHistoryRequestSchema aceita {} vazio', () => {
      expect(disableHistoryRequestSchema.safeParse({}).success).toBe(true)
    })

    it('disableHistoryRequestSchema rejeita extra prop', () => {
      expect(
        disableHistoryRequestSchema.safeParse({ confirm: true }).success,
      ).toBe(false)
    })

    it('deleteOneHistoryParamsSchema valida UUID v4 lowercase', () => {
      expect(
        deleteOneHistoryParamsSchema.safeParse({ id: validUuidV4 }).success,
      ).toBe(true)
      expect(
        deleteOneHistoryParamsSchema.safeParse({ id: uppercaseUuid }).success,
      ).toBe(false)
    })

    it('deleteOneHistoryRequestSchema rejeita extra prop', () => {
      expect(
        deleteOneHistoryRequestSchema.safeParse({ force: true }).success,
      ).toBe(false)
    })
  })

  describe('cross-card DTOs — consumidos por #146/#147', () => {
    it('filePurgeCandidateSchema aceita deletedAt null (purge não-iniciado)', () => {
      const result = filePurgeCandidateSchema.safeParse({
        id: validUuidV4,
        userId: validUuidV4,
        storagePath: 'some/path/file.csv',
        expiresAt: '2026-05-03T12:00:00.000Z',
        deletedAt: null,
        purgeAttempts: 0,
      })
      expect(result.success).toBe(true)
    })

    it('filePurgeCandidateSchema aceita deletedAt timestamp (soft-deleted)', () => {
      const result = filePurgeCandidateSchema.safeParse({
        id: validUuidV4,
        userId: validUuidV4,
        storagePath: 'some/path/file.csv',
        expiresAt: '2026-05-03T12:00:00.000Z',
        deletedAt: '2026-05-04T12:00:00.000Z',
        purgeAttempts: 1,
      })
      expect(result.success).toBe(true)
    })

    it('filePurgeCandidateSchema rejeita purgeAttempts negativo', () => {
      const result = filePurgeCandidateSchema.safeParse({
        id: validUuidV4,
        userId: validUuidV4,
        storagePath: 'some/path/file.csv',
        expiresAt: '2026-05-03T12:00:00.000Z',
        deletedAt: null,
        purgeAttempts: -1,
      })
      expect(result.success).toBe(false)
    })

    it('userStorageAggregateSchema rejeita activeBytes negativo', () => {
      const result = userStorageAggregateSchema.safeParse({
        userId: validUuidV4,
        activeRowCount: 5,
        activeBytes: -100,
      })
      expect(result.success).toBe(false)
    })

    it('userStorageAggregateSchema aceita zeros (user sem histórico)', () => {
      const result = userStorageAggregateSchema.safeParse({
        userId: validUuidV4,
        activeRowCount: 0,
        activeBytes: 0,
      })
      expect(result.success).toBe(true)
    })
  })
})
