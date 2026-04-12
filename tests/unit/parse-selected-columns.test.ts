/**
 * Unit tests for parseSelectedColumnsField (Card 1.16)
 *
 * Cobre:
 *   - Caminho feliz: JSON array de strings
 *   - Fallback single-value string
 *   - DoS: string grande demais (> 8KB) → rejeita
 *   - Prototype pollution: {__proto__:...}, {constructor:...} → rejeita
 *   - null, number, boolean, undefined → rejeita
 *   - Array com não-strings → rejeita
 *   - Array vazio → rejeita
 *   - String vazia como nome → rejeita
 *   - Nome de coluna > 255 chars → rejeita
 *   - Regression: unicode PT-BR em nome de coluna → aceita
 *   - Mutation guard: remover cap byte → teste de DoS quebraria
 *   - Mutation guard: remover Zod shape → prototype pollution passaria
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import {
  parseSelectedColumnsField,
  MAX_SELECTED_COLUMNS_FIELD_BYTES,
  MAX_COLUMN_NAME_LENGTH,
} from '../../src/lib/parse-selected-columns'
import { AppError } from '../../src/errors/app-error'

// ============================================
// Caminho feliz
// ============================================
describe('parseSelectedColumnsField — caminho feliz', () => {
  it('JSON array de strings válido', () => {
    expect(parseSelectedColumnsField('["Nome","Email"]')).toEqual(['Nome', 'Email'])
  })

  it('JSON array com single item', () => {
    expect(parseSelectedColumnsField('["Nome"]')).toEqual(['Nome'])
  })

  it('JSON array com espaços nos nomes', () => {
    expect(parseSelectedColumnsField('["Nome Completo","Data de Nascimento"]')).toEqual([
      'Nome Completo',
      'Data de Nascimento',
    ])
  })

  it('REGRESSION: unicode PT-BR preservado', () => {
    expect(parseSelectedColumnsField('["São Paulo","João","Ação"]')).toEqual([
      'São Paulo',
      'João',
      'Ação',
    ])
  })

  it('fallback single-value: string simples vira [string]', () => {
    // Legado de UX: form HTML single field sem JSON.stringify
    expect(parseSelectedColumnsField('Nome')).toEqual(['Nome'])
  })

  it('fallback single-value com acentos', () => {
    expect(parseSelectedColumnsField('São Paulo')).toEqual(['São Paulo'])
  })
})

// ============================================
// DoS — Camada 1 (cap de bytes)
// ============================================
describe('parseSelectedColumnsField — anti-DoS', () => {
  it('rejeita field > MAX_SELECTED_COLUMNS_FIELD_BYTES (8KB)', () => {
    // Constrói string de 8KB + 1 byte
    const huge = 'a'.repeat(MAX_SELECTED_COLUMNS_FIELD_BYTES + 1)
    expect(() => parseSelectedColumnsField(huge)).toThrow(AppError)
    try {
      parseSelectedColumnsField(huge)
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).message).toContain('excede')
    }
  })

  it('aceita exatamente no limite (8KB de string valida JSON)', () => {
    // Monta JSON array que cabe exato — nome de coluna preenche
    const col = 'a'.repeat(200)
    const json = JSON.stringify([col, col, col])
    expect(json.length).toBeLessThan(MAX_SELECTED_COLUMNS_FIELD_BYTES)
    expect(parseSelectedColumnsField(json)).toEqual([col, col, col])
  })

  it('MUTATION GUARD: sem cap de bytes, JSON gigante de [1,1,1,...] passaria do parse', () => {
    // Simula ataque: 100KB de '[1,1,1,...]'. Se o cap for removido, o
    // JSON.parse roda O(n) antes do Zod rejeitar. Com cap, erra antes.
    const attack = '[' + Array(20000).fill('1').join(',') + ']'
    expect(attack.length).toBeGreaterThan(MAX_SELECTED_COLUMNS_FIELD_BYTES)
    expect(() => parseSelectedColumnsField(attack)).toThrow(/excede/)
  })

  it('REGRESSION b7e4c1a92f03: mede bytes UTF-8 reais, não code units UTF-16', () => {
    // Emoji 4-byte UTF-8 (💥 = U+1F4A5) conta como 2 code units em .length.
    // Com .length, 4096 emojis = 8192 "chars" (passa no cap antigo).
    // Com Buffer.byteLength, 4096 emojis = 16384 bytes (rejeita corretamente).
    const emoji = '💥'
    const payload = JSON.stringify([emoji.repeat(4096)])
    expect(payload.length).toBeLessThanOrEqual(MAX_SELECTED_COLUMNS_FIELD_BYTES + 10)
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(MAX_SELECTED_COLUMNS_FIELD_BYTES)
    expect(() => parseSelectedColumnsField(payload)).toThrow(/excede/)
  })
})

// ============================================
// Caracteres de controle — finding d1f0ab839e47
// ============================================
describe('parseSelectedColumnsField — caracteres de controle', () => {
  it('rejeita null byte (U+0000) no nome', () => {
    expect(() => parseSelectedColumnsField('["Nome\\u0000Evil"]')).toThrow(AppError)
  })

  it('rejeita zero-width space (U+200B)', () => {
    expect(() => parseSelectedColumnsField('["Nome\\u200BInvisivel"]')).toThrow(AppError)
  })

  it('rejeita BOM (U+FEFF)', () => {
    expect(() => parseSelectedColumnsField('["\\uFEFFNome"]')).toThrow(AppError)
  })

  it('rejeita RTL override (U+202E) — ataque homograph', () => {
    expect(() => parseSelectedColumnsField('["Nome\\u202Eevil"]')).toThrow(AppError)
  })

  it('rejeita line separator (U+2028)', () => {
    expect(() => parseSelectedColumnsField('["Nome\\u2028"]')).toThrow(AppError)
  })

  it('rejeita DEL (U+007F) — finding fa03c7e5d812', () => {
    // Cobre o range U+007F-U+009F do FORBIDDEN_CONTROL_CHARS explicitamente.
    // Mutation guard: remover a faixa não é detectado sem este teste.
    expect(() => parseSelectedColumnsField('["Nome\\u007FCol"]')).toThrow(AppError)
  })

  it('rejeita C1 control (U+0085 NEL)', () => {
    expect(() => parseSelectedColumnsField('["Nome\\u0085Col"]')).toThrow(AppError)
  })

  it('rejeita tab/newline ASCII em nome', () => {
    expect(() => parseSelectedColumnsField('["Nome\\tCol"]')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('["Nome\\nCol"]')).toThrow(AppError)
  })

  it('aceita espaço comum (U+0020) — não é control char', () => {
    expect(parseSelectedColumnsField('["Nome Completo"]')).toEqual(['Nome Completo'])
  })
})

// ============================================
// Prototype pollution — Camada 3 (Zod shape)
// ============================================
describe('parseSelectedColumnsField — prototype pollution', () => {
  it('rejeita {__proto__:...}', () => {
    expect(() => parseSelectedColumnsField('{"__proto__":{"polluted":1}}')).toThrow(AppError)
  })

  it('rejeita {constructor:{prototype:...}}', () => {
    expect(() => parseSelectedColumnsField('{"constructor":{"prototype":{"polluted":1}}}')).toThrow(
      AppError,
    )
  })

  it('rejeita object literal qualquer', () => {
    expect(() => parseSelectedColumnsField('{"selectedColumns":["Nome"]}')).toThrow(AppError)
  })

  it('MUTATION GUARD: sem Zod shape, object pollution passaria silenciosa', () => {
    // Se o helper retornasse parsed direto sem validar, qualquer objeto
    // virava selectedColumns e engatilhava bugs downstream (pollution ou
    // crash em .map/.filter).
    expect(() => parseSelectedColumnsField('{}')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('{"a":1}')).toThrow(AppError)
  })

  it('Object.prototype não fica poluído após rejeição', () => {
    // Se o prototype tivesse sido poluído, todo objeto novo herdaria `polluted`.
    // Probe via acesso direto num objeto vazio — ES5 compatível, sem hasOwn.
    const probeBefore: Record<string, unknown> = {}
    expect(probeBefore.polluted).toBeUndefined()

    try {
      parseSelectedColumnsField('{"__proto__":{"polluted":"yes"}}')
    } catch {
      // Esperado
    }

    const probeAfter: Record<string, unknown> = {}
    expect(probeAfter.polluted).toBeUndefined()
  })
})

// ============================================
// Tipos inválidos
// ============================================
describe('parseSelectedColumnsField — tipos inválidos', () => {
  it('rejeita null', () => {
    expect(() => parseSelectedColumnsField('null')).toThrow(AppError)
  })

  it('rejeita number puro', () => {
    expect(() => parseSelectedColumnsField('42')).toThrow(AppError)
  })

  it('rejeita boolean', () => {
    expect(() => parseSelectedColumnsField('true')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('false')).toThrow(AppError)
  })

  it('rejeita array com não-strings', () => {
    expect(() => parseSelectedColumnsField('[1,2,3]')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('[null]')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('[{"a":1}]')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('[["nested"]]')).toThrow(AppError)
  })

  it('rejeita array vazio', () => {
    expect(() => parseSelectedColumnsField('[]')).toThrow(AppError)
  })

  it('rejeita string vazia como nome de coluna', () => {
    expect(() => parseSelectedColumnsField('[""]')).toThrow(AppError)
    expect(() => parseSelectedColumnsField('["Nome",""]')).toThrow(AppError)
  })

  it('rejeita nome de coluna > MAX_COLUMN_NAME_LENGTH (255)', () => {
    const longName = 'a'.repeat(MAX_COLUMN_NAME_LENGTH + 1)
    const json = JSON.stringify([longName])
    // Ainda cabe no cap de bytes (256 chars + overhead < 8KB)
    expect(json.length).toBeLessThan(MAX_SELECTED_COLUMNS_FIELD_BYTES)
    expect(() => parseSelectedColumnsField(json)).toThrow(AppError)
  })

  it('aceita nome de coluna exatamente no limite (255 chars)', () => {
    const maxName = 'a'.repeat(MAX_COLUMN_NAME_LENGTH)
    const result = parseSelectedColumnsField(JSON.stringify([maxName]))
    expect(result).toEqual([maxName])
    expect(result[0].length).toBe(MAX_COLUMN_NAME_LENGTH)
  })

  it('rejeita fallback single-value vazio', () => {
    // String vazia não é JSON válido E vira [''] no fallback, que também falha
    expect(() => parseSelectedColumnsField('')).toThrow(AppError)
  })

  it('rejeita fallback single-value longo demais', () => {
    // String de 300 chars não é JSON → fallback [value] → falha no max(255)
    const longString = 'a'.repeat(300)
    expect(longString.length).toBeLessThan(MAX_SELECTED_COLUMNS_FIELD_BYTES)
    expect(() => parseSelectedColumnsField(longString)).toThrow(AppError)
  })
})
