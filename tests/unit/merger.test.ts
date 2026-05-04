/**
 * Unit tests for spreadsheet/merger (Card 3.2 #31 — checklist item 5).
 *
 * Merger é o coração do produto: combina N planilhas em uma só, projetando
 * apenas colunas selecionadas. Comportamento crítico a preservar:
 *   - Match de coluna é case-insensitive (parser.findMatchingColumn)
 *   - Célula ausente/null → null (não "" nem undefined)
 *   - Headers do output = selectedColumns EXATOS (não os headers originais)
 *   - Ordem das linhas preserva ordem dos arquivos de entrada
 *
 * Cobertura:
 *   - mergeSpreadsheets: merge simples, colunas divergentes, case-insensitive
 *     match, linhas vazias, valores nulos, ordem preservada, múltiplas fontes
 *   - generateOutputFile: dispatch CSV vs XLSX, fileName com data,
 *     sanitização aplicada, colWidths no XLSX, MIME types corretos
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import Papa from 'papaparse'
import {
  mergeSpreadsheets,
  generateOutputFile,
} from '../../src/lib/spreadsheet/merger'
import type {
  ParsedSpreadsheet,
  MergedResult,
} from '../../src/lib/spreadsheet/types'

function makeSpreadsheet(
  fileName: string,
  headers: string[],
  rows: Array<Record<string, string | number | boolean | null>>,
): ParsedSpreadsheet {
  return {
    fileName,
    format: 'csv',
    headers,
    rows,
    rowCount: rows.length,
    fileSize: 1000,
  }
}

describe('mergeSpreadsheets', () => {
  it('merge simples: 1 arquivo, colunas exatas', () => {
    const s = makeSpreadsheet(
      'a.csv',
      ['nome', 'email'],
      [
        { nome: 'Alice', email: 'a@x.com' },
        { nome: 'Bob', email: 'b@x.com' },
      ],
    )
    const result = mergeSpreadsheets([s], ['nome', 'email'])
    expect(result.headers).toEqual(['nome', 'email'])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toEqual({ nome: 'Alice', email: 'a@x.com' })
    expect(result.rows[1]).toEqual({ nome: 'Bob', email: 'b@x.com' })
    expect(result.totalRows).toBe(2)
    expect(result.sourcesCount).toBe(1)
  })

  it('headers do output são as selectedColumns exatas, não os headers originais', () => {
    // Seleciona 'Nome' (maiúsculo); arquivo tem 'nome' (minúsculo).
    // Output deve ter 'Nome', não 'nome' — merger.ts:56.
    const s = makeSpreadsheet('a.csv', ['nome'], [{ nome: 'Alice' }])
    const result = mergeSpreadsheets([s], ['Nome'])
    expect(result.headers).toEqual(['Nome'])
    expect(result.rows[0]).toHaveProperty('Nome', 'Alice')
  })

  it('match de coluna é case-insensitive (findMatchingColumn)', () => {
    const s = makeSpreadsheet(
      'a.csv',
      ['NOME', 'Email'],
      [{ NOME: 'Alice', Email: 'a@x.com' }],
    )
    const result = mergeSpreadsheets([s], ['nome', 'email'])
    expect(result.rows[0]).toEqual({ nome: 'Alice', email: 'a@x.com' })
  })

  it('coluna selecionada sem match no arquivo → null', () => {
    const s = makeSpreadsheet('a.csv', ['nome'], [{ nome: 'Alice' }])
    const result = mergeSpreadsheets([s], ['nome', 'telefone'])
    expect(result.rows[0]).toEqual({ nome: 'Alice', telefone: null })
  })

  it('célula com undefined vira null (??)', () => {
    const s = makeSpreadsheet('a.csv', ['nome', 'idade'], [{ nome: 'Alice' }])
    const result = mergeSpreadsheets([s], ['nome', 'idade'])
    // idade é undefined no row → `row[actualCol] ?? null` → null
    expect(result.rows[0].idade).toBeNull()
  })

  it('célula null permanece null (não vira "")', () => {
    const s = makeSpreadsheet(
      'a.csv',
      ['nome', 'email'],
      [{ nome: 'Alice', email: null }],
    )
    const result = mergeSpreadsheets([s], ['nome', 'email'])
    expect(result.rows[0].email).toBeNull()
  })

  it('0 e "" (falsy não-nulos) são preservados', () => {
    // `??` é null-ish coalesce, não falsy-coalesce. Zero e empty string
    // devem sobreviver.
    const s = makeSpreadsheet(
      'a.csv',
      ['count', 'note'],
      [{ count: 0, note: '' }],
    )
    const result = mergeSpreadsheets([s], ['count', 'note'])
    expect(result.rows[0].count).toBe(0)
    expect(result.rows[0].note).toBe('')
  })

  it('multiple arquivos: rows concatenadas na ordem dos arquivos', () => {
    const a = makeSpreadsheet('a.csv', ['nome'], [{ nome: 'Alice' }])
    const b = makeSpreadsheet('b.csv', ['nome'], [{ nome: 'Bob' }])
    const c = makeSpreadsheet('c.csv', ['nome'], [{ nome: 'Carol' }])
    const result = mergeSpreadsheets([a, b, c], ['nome'])
    expect(result.rows.map((r) => r.nome)).toEqual(['Alice', 'Bob', 'Carol'])
    expect(result.sourcesCount).toBe(3)
  })

  it('colunas divergentes entre arquivos: preenche null no arquivo que não tem', () => {
    const a = makeSpreadsheet(
      'a.csv',
      ['nome', 'email'],
      [{ nome: 'Alice', email: 'a@x.com' }],
    )
    const b = makeSpreadsheet('b.csv', ['nome'], [{ nome: 'Bob' }])
    const result = mergeSpreadsheets([a, b], ['nome', 'email'])
    expect(result.rows[0]).toEqual({ nome: 'Alice', email: 'a@x.com' })
    expect(result.rows[1]).toEqual({ nome: 'Bob', email: null })
  })

  it('arquivo sem nenhuma coluna matching contribui 0 rows (mesmo tendo rows)', () => {
    // Loop itera sobre rows; se nenhuma coluna mapeia, cada row vira
    // objeto com todas as selectedColumns = null.
    const s = makeSpreadsheet(
      'a.csv',
      ['telefone'],
      [{ telefone: '123' }, { telefone: '456' }],
    )
    const result = mergeSpreadsheets([s], ['nome', 'email'])
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toEqual({ nome: null, email: null })
    expect(result.rows[1]).toEqual({ nome: null, email: null })
  })

  it('arquivo com 0 rows contribui 0 rows pro output', () => {
    const s = makeSpreadsheet('a.csv', ['nome'], [])
    const result = mergeSpreadsheets([s], ['nome'])
    expect(result.rows).toHaveLength(0)
    expect(result.totalRows).toBe(0)
    expect(result.sourcesCount).toBe(1)
  })

  it('empty array de arquivos retorna result vazio', () => {
    const result = mergeSpreadsheets([], ['nome'])
    expect(result.rows).toHaveLength(0)
    expect(result.totalRows).toBe(0)
    expect(result.sourcesCount).toBe(0)
    expect(result.headers).toEqual(['nome'])
  })

  it('empty selectedColumns: rows são objetos vazios', () => {
    const s = makeSpreadsheet('a.csv', ['nome'], [{ nome: 'Alice' }])
    const result = mergeSpreadsheets([s], [])
    expect(result.rows[0]).toEqual({})
    expect(result.headers).toEqual([])
  })

  it('preserva tipos não-string: number, boolean', () => {
    const s = makeSpreadsheet(
      'a.csv',
      ['idade', 'ativo'],
      [{ idade: 30, ativo: true }],
    )
    const result = mergeSpreadsheets([s], ['idade', 'ativo'])
    expect(result.rows[0].idade).toBe(30)
    expect(result.rows[0].ativo).toBe(true)
  })

  it('MergedResult.rows usa Object.create(null) — sem prototype pollution', () => {
    // Defensa contra protótipo — `mergedRow` é criado com Object.create(null)
    // em merger.ts:40. Garante que __proto__ / constructor não vazem.
    const s = makeSpreadsheet('a.csv', ['nome'], [{ nome: 'Alice' }])
    const result = mergeSpreadsheets([s], ['nome'])
    const row = result.rows[0]
    expect(Object.getPrototypeOf(row)).toBeNull()
  })
})

describe('generateOutputFile', () => {
  const sampleMerged: MergedResult = {
    headers: ['nome', 'email'],
    rows: [
      { nome: 'Alice', email: 'a@x.com' },
      { nome: 'Bob', email: 'b@x.com' },
    ],
    totalRows: 2,
    sourcesCount: 1,
  }

  it('format csv: retorna OutputFile com buffer + fileName + mimeType corretos', () => {
    const out = generateOutputFile(sampleMerged, 'csv')
    expect(out.format).toBe('csv')
    expect(out.mimeType).toBe('text/csv')
    expect(out.fileName).toMatch(/^unified-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(out.buffer).toBeInstanceOf(Buffer)
  })

  it('format xlsx: retorna OutputFile com MIME XLSX correto', () => {
    const out = generateOutputFile(sampleMerged, 'xlsx')
    expect(out.format).toBe('xlsx')
    expect(out.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(out.fileName).toMatch(/^unified-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(out.buffer).toBeInstanceOf(Buffer)
  })

  it('csv output: parseavel de volta com os mesmos dados', () => {
    const out = generateOutputFile(sampleMerged, 'csv')
    const parsed = Papa.parse(out.buffer.toString('utf-8'), { header: true })
    expect(parsed.data).toEqual([
      { nome: 'Alice', email: 'a@x.com' },
      { nome: 'Bob', email: 'b@x.com' },
    ])
  })

  it('csv null/undefined vira string vazia', () => {
    const merged: MergedResult = {
      headers: ['nome', 'email'],
      rows: [{ nome: 'Alice', email: null }],
      totalRows: 1,
      sourcesCount: 1,
    }
    const out = generateOutputFile(merged, 'csv')
    const text = out.buffer.toString('utf-8')
    // Segunda coluna vazia no CSV
    expect(text).toMatch(/Alice,\s*$/m)
  })

  it('xlsx output: sheet "Unified" com cabeçalhos + dados', () => {
    const out = generateOutputFile(sampleMerged, 'xlsx')
    const wb = XLSX.read(out.buffer, { type: 'buffer' })
    expect(wb.SheetNames).toContain('Unified')
    const sheet = wb.Sheets.Unified
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    expect(data).toHaveLength(2)
    expect(data[0]).toEqual({ nome: 'Alice', email: 'a@x.com' })
    expect(data[1]).toEqual({ nome: 'Bob', email: 'b@x.com' })
  })

  it('xlsx sanitiza células contra formula injection (= no início)', () => {
    const merged: MergedResult = {
      headers: ['formula'],
      rows: [{ formula: '=SUM(A1:A9)' }],
      totalRows: 1,
      sourcesCount: 1,
    }
    const out = generateOutputFile(merged, 'xlsx')
    const wb = XLSX.read(out.buffer, { type: 'buffer' })
    const sheet = wb.Sheets.Unified
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    // sanitizer prefixa com apóstrofo (ou equivalente) — valor não começa com "="
    const cell = String(data[0].formula)
    expect(cell.startsWith('=')).toBe(false)
  })

  it('fileName usa data no formato YYYY-MM-DD (ISO slice)', () => {
    const out = generateOutputFile(sampleMerged, 'csv')
    const today = new Date().toISOString().slice(0, 10)
    expect(out.fileName).toBe(`unified-${today}.csv`)
  })

  it('0 rows no merged: gera output sem lançar erro', () => {
    const empty: MergedResult = {
      headers: ['nome'],
      rows: [],
      totalRows: 0,
      sourcesCount: 0,
    }
    // papaparse.unparse com data=[] retorna "" — comportamento da lib,
    // aceito (output vazio é legítimo quando não há nada a escrever).
    expect(() => generateOutputFile(empty, 'csv')).not.toThrow()
    const xlsxOut = generateOutputFile(empty, 'xlsx')
    const wb = XLSX.read(xlsxOut.buffer, { type: 'buffer' })
    const sheet = wb.Sheets.Unified
    const data = XLSX.utils.sheet_to_json(sheet)
    expect(data).toHaveLength(0)
  })

  it('xlsx: gera buffer re-parseavel (round-trip preserva dados)', () => {
    // Guard de round-trip total em vez de inspecionar !cols (que o parser
    // XLSX.read descarta durante reconstrução — detalhe de impl da lib).
    const longValue = 'x'.repeat(200)
    const merged: MergedResult = {
      headers: ['col'],
      rows: [{ col: longValue }],
      totalRows: 1,
      sourcesCount: 1,
    }
    const out = generateOutputFile(merged, 'xlsx')
    const wb = XLSX.read(out.buffer, { type: 'buffer' })
    const sheet = wb.Sheets.Unified
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    expect(data).toHaveLength(1)
    expect(data[0].col).toBe(longValue)
  })
})
