/**
 * Unit tests — Card #225: cap de COLUNAS do input no parser
 * (backstop dimensional anti-amplificação de memória).
 *
 * O parser materializa TODAS as células do input (colunas × linhas). Um arquivo
 * pequeno em bytes mas com milhares de colunas (grid esparso/crafted) ampliaria a
 * memória. Este cap rejeita o arquivo largo ANTES de materializar:
 *   - CSV:   após `result.meta.fields`, valida `headers.length`.
 *   - Excel: ANTES do `sheet_to_json` (que materializa o grid), valida o nº de
 *            colunas lido do range `!ref` via `decode_range`.
 *
 * Cobre:
 *   1. CSV/Excel acima do limite → 400 LIMIT_EXCEEDED.
 *   2. Prova de que o check Excel vem do `!ref` (worksheet esparso largo) e
 *      ACONTECE ANTES do `sheet_to_json` (spy não-chamado).
 *   3. Boundary exata: maxInputColumns passa, +1 rejeita (ambos formatos).
 *   4. details do LIMIT_EXCEEDED NÃO contém fileName (consistência #224 PII).
 *   5. Regressão: arquivos normais (≤10 colunas) seguem parseando.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSpreadsheet } from '../../src/lib/spreadsheet/parser'
import { PRO_LIMITS } from '../../src/lib/spreadsheet/types'
import { AppError, ErrorCodes } from '../../src/errors/app-error'

const MAX = PRO_LIMITS.maxInputColumns // 100 (PRO)

// ===========================================
// Helpers
// ===========================================

/** Captura o erro lançado por `fn` (ou `undefined` se não lançou). */
function catchErr(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  return undefined
}

/** CSV com `nCols` colunas (header + 1 linha de dados, field counts batendo). */
function makeWideCsv(nCols: number): Buffer {
  const header = Array.from({ length: nCols }, (_, i) => `c${i + 1}`).join(',')
  const row = Array.from({ length: nCols }, (_, i) => `v${i + 1}`).join(',')
  return Buffer.from(`${header}\n${row}`, 'utf-8')
}

/** XLSX denso com `nCols` colunas reais (header + 1 linha). */
function makeWideXlsx(nCols: number): Buffer {
  const header = Array.from({ length: nCols }, (_, i) => `c${i + 1}`)
  const row = Array.from({ length: nCols }, (_, i) => `v${i + 1}`)
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([header, row])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/**
 * XLSX ESPARSO: `!ref` declara um range largo (`A1:<lastCol>2`) mas o worksheet
 * tem só algumas células reais materializadas. Prova que o cap lê o range `!ref`
 * — não conta células do grid materializado. Se o check operasse sobre as células
 * reais, veria 2 colunas e PASSARIA; como rejeita, a fonte é o `!ref`.
 */
function makeSparseWideXlsx(nCols: number): Buffer {
  const lastCol = XLSX.utils.encode_col(nCols - 1) // 0-based → letra da última coluna
  const ws: XLSX.WorkSheet = {
    '!ref': `A1:${lastCol}2`,
    A1: { t: 's', v: 'Name' },
    B1: { t: 's', v: 'Age' },
    A2: { t: 's', v: 'Alice' },
    B2: { t: 'n', v: 30 },
  }
  const wb = XLSX.utils.book_new()
  wb.SheetNames.push('Sheet1')
  wb.Sheets.Sheet1 = ws
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

function expectLimitExceeded(err: unknown): AppError {
  expect(err).toBeInstanceOf(AppError)
  const e = err as AppError
  expect(e.code).toBe(ErrorCodes.LIMIT_EXCEEDED)
  expect(e.statusCode).toBe(400)
  return e
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================
// 1. CSV — acima do limite rejeita; dentro passa
// ===========================================
describe('parseSpreadsheet CSV — cap de colunas (#225)', () => {
  it('rejeita CSV com > maxInputColumns colunas (101) → 400 LIMIT_EXCEEDED', () => {
    const err = catchErr(() =>
      parseSpreadsheet(makeWideCsv(MAX + 1), 'wide.csv'),
    )
    const e = expectLimitExceeded(err)
    // Mutation-resilient: prova que `actual` reflete o nº real de colunas (101),
    // não um literal hardcoded. Pega mutação no `headers.length`.
    expect(e.details).toMatchObject({
      limit: `${MAX} colunas no arquivo`,
      actual: `${MAX + 1} colunas`,
    })
  })

  it('aceita CSV com exatamente maxInputColumns (100) colunas', () => {
    const result = parseSpreadsheet(makeWideCsv(MAX), 'exact.csv')
    expect(result.headers).toHaveLength(MAX)
    expect(result.headers[0]).toBe('c1')
    expect(result.headers[MAX - 1]).toBe(`c${MAX}`)
    expect(result.rowCount).toBe(1)
  })

  it('aceita CSV com 10 colunas (caso normal)', () => {
    const result = parseSpreadsheet(makeWideCsv(10), 'normal.csv')
    expect(result.headers).toHaveLength(10)
    expect(result.rowCount).toBe(1)
  })
})

// ===========================================
// 2. Excel — acima do limite rejeita; prova de origem (!ref) e de ordem (antes do sheet_to_json)
// ===========================================
describe('parseSpreadsheet Excel — cap de colunas (#225)', () => {
  it('rejeita XLSX denso com > maxInputColumns colunas (101) → 400 LIMIT_EXCEEDED', () => {
    const err = catchErr(() =>
      parseSpreadsheet(makeWideXlsx(MAX + 1), 'wide.xlsx'),
    )
    const e = expectLimitExceeded(err)
    expect(e.details).toMatchObject({
      limit: `${MAX} colunas no arquivo`,
      actual: `${MAX + 1} colunas`,
    })
  })

  it('PROVA (origem !ref): worksheet ESPARSO com !ref largo (A1:CW2 = 101 col) mas só 2 colunas reais → rejeita por 101', () => {
    // O grid materializado tem 2 colunas (Name, Age). Só o range `!ref` declara 101.
    // Rejeitar por 101 prova que o cap lê o `!ref` (decode_range), não as células.
    const buf = makeSparseWideXlsx(MAX + 1)

    // Sanidade do fixture: o !ref realmente declara 101 colunas após round-trip.
    const wsRead = XLSX.read(buf, { type: 'buffer' }).Sheets.Sheet1
    expect(wsRead['!ref']).toBe('A1:CW2')
    const range = XLSX.utils.decode_range(wsRead['!ref'] as string)
    expect(range.e.c - range.s.c + 1).toBe(MAX + 1)

    const err = catchErr(() => parseSpreadsheet(buf, 'sparse.xlsx'))
    const e = expectLimitExceeded(err)
    // `actual` = 101 vem do colCount do !ref, não das 2 colunas materializadas.
    expect(e.details).toMatchObject({ actual: `${MAX + 1} colunas` })
  })

  it('PROVA (ordem): o cap roda ANTES do sheet_to_json — o materializador NUNCA é chamado ao rejeitar', () => {
    // Mock que explode se chamado. Se o cap estivesse DEPOIS do sheet_to_json,
    // o grid seria materializado primeiro e este sentinel dispararia em vez do
    // LIMIT_EXCEEDED. Como recebemos LIMIT_EXCEEDED, o check provou-se anterior.
    const spy = vi.spyOn(XLSX.utils, 'sheet_to_json').mockImplementation(() => {
      throw new Error(
        'SENTINEL: sheet_to_json materializou o grid antes do cap',
      )
    })

    const err = catchErr(() =>
      parseSpreadsheet(makeWideXlsx(MAX + 1), 'wide.xlsx'),
    )

    expectLimitExceeded(err)
    expect(spy).not.toHaveBeenCalled()
  })

  it('regressão: XLSX dentro do limite materializa normalmente (sheet_to_json É chamado)', () => {
    const spy = vi.spyOn(XLSX.utils, 'sheet_to_json')
    const result = parseSpreadsheet(makeWideXlsx(10), 'ok.xlsx')
    expect(result.headers).toHaveLength(10)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('rejeita XLS (legado) com > maxInputColumns colunas — o cap é format-agnostic', () => {
    const header = Array.from({ length: MAX + 1 }, (_, i) => `c${i + 1}`)
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([header, header.map((_, i) => `v${i}`)])
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer

    const err = catchErr(() => parseSpreadsheet(buf, 'wide.xls'))
    expectLimitExceeded(err)
  })
})

// ===========================================
// 3. Boundary exata: max passa, max+1 rejeita (ambos formatos)
// ===========================================
describe('cap de colunas — boundary exata maxInputColumns (#225)', () => {
  it('CSV: exatamente maxInputColumns passa; +1 rejeita', () => {
    expect(() => parseSpreadsheet(makeWideCsv(MAX), 'b.csv')).not.toThrow()
    expect(() => parseSpreadsheet(makeWideCsv(MAX + 1), 'b.csv')).toThrow(
      AppError,
    )
  })

  it('XLSX: exatamente maxInputColumns passa; +1 rejeita', () => {
    const okResult = parseSpreadsheet(makeWideXlsx(MAX), 'b.xlsx')
    expect(okResult.headers).toHaveLength(MAX)
    expect(() => parseSpreadsheet(makeWideXlsx(MAX + 1), 'b.xlsx')).toThrow(
      AppError,
    )
  })

  it('XLSX: o limite é `>`, não `>=` — maxInputColumns NÃO dispara o cap', () => {
    // Guard explícito contra mutação `>` → `>=` (que rejeitaria 100 colunas).
    const err = catchErr(() => parseSpreadsheet(makeWideXlsx(MAX), 'edge.xlsx'))
    expect(err).toBeUndefined()
  })
})

// ===========================================
// 4. PII: details NÃO contém fileName (#224 consistência)
// ===========================================
describe('cap de colunas — LIMIT_EXCEEDED não vaza fileName (#224 PII)', () => {
  const piiName = 'folha_pagamento_joao_cpf_12345678900'

  it('CSV: nem a mensagem nem os details contêm o fileName', () => {
    const e = expectLimitExceeded(
      catchErr(() => parseSpreadsheet(makeWideCsv(MAX + 1), `${piiName}.csv`)),
    )
    // O parser chama limitExceeded(limit, actual) SEM o 3º arg (file) — logo
    // a chave `file` não existe nos details.
    expect(e.details).not.toHaveProperty('file')
    expect(JSON.stringify(e.details)).not.toContain(piiName)
    expect(e.message).not.toContain(piiName)
  })

  it('XLSX: nem a mensagem nem os details contêm o fileName', () => {
    const e = expectLimitExceeded(
      catchErr(() =>
        parseSpreadsheet(makeWideXlsx(MAX + 1), `${piiName}.xlsx`),
      ),
    )
    expect(e.details).not.toHaveProperty('file')
    expect(JSON.stringify(e.details)).not.toContain(piiName)
    expect(e.message).not.toContain(piiName)
  })

  it('o envelope toJSON() do erro também não vaza o fileName', () => {
    const e = expectLimitExceeded(
      catchErr(() => parseSpreadsheet(makeWideCsv(MAX + 1), `${piiName}.csv`)),
    )
    expect(JSON.stringify(e.toJSON())).not.toContain(piiName)
  })
})

// ===========================================
// 5. Regressão: arquivos normais seguem parseando end-to-end
// ===========================================
describe('cap de colunas — regressão de arquivos normais (#225)', () => {
  it('CSV de 3 colunas parseia com dados corretos', () => {
    const csv = Buffer.from(
      'Nome,Idade,Cidade\nAna,30,SP\nBruno,25,RJ',
      'utf-8',
    )
    const result = parseSpreadsheet(csv, 'small.csv')
    expect(result.headers).toEqual(['Nome', 'Idade', 'Cidade'])
    expect(result.rowCount).toBe(2)
    expect(result.rows[0].Nome).toBe('Ana')
    expect(result.rows[1].Cidade).toBe('RJ')
  })

  it('XLSX de 3 colunas parseia com tipos preservados', () => {
    const xlsx = makeWideXlsx(3)
    const result = parseSpreadsheet(xlsx, 'small.xlsx')
    expect(result.headers).toEqual(['c1', 'c2', 'c3'])
    expect(result.rowCount).toBe(1)
  })
})
