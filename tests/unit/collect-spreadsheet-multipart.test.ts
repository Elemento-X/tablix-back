/**
 * Unit tests — collectSpreadsheetMultipart (Card 6.3,
 * src/http/controllers/helpers/collect-spreadsheet-multipart).
 *
 * Helper extraído com TODAS as defesas anti-abuso do Card 1.16. Prova:
 *   - coleta arquivos + selectedColumns (parse) + outputFormat
 *   - override de limites por-request (fileSize + files) repassado a parts()
 *   - extensão inválida → validationError na borda
 *   - arquivo truncado (excedeu fileSize do multipart) → limitExceeded
 *   - field duplicado (selectedColumns / outputFormat) → validationError + warn
 *   - fieldname desconhecido → validationError + warn
 *   - selectedColumns com parse inválido → rethrow + warn
 *   - default de outputFormat ('xlsx') quando ausente
 *
 * @owner: @tester
 * @card: 6.3
 */
/* eslint-disable import/first */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/config/env', async () => {
  const { testEnv } = await import('../helpers/env-stub')
  return { env: { ...testEnv } }
})
vi.mock('../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { collectSpreadsheetMultipart } from '../../src/http/controllers/helpers/collect-spreadsheet-multipart'

/** Espelha MAX_FILE_NAME_LENGTH do helper (não exportado) — fixado por contrato. */
const MAX_LEN = 255

const OPTS = {
  fileSizeLimitBytes: 30 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxFiles: 15,
  fileSizeLabel: '30MB por arquivo',
  totalSizeLabel: '30MB no total',
  userId: '550e8400-e29b-41d4-a716-446655440000',
}

interface PartSpec {
  type: 'file' | 'field'
  filename?: string
  content?: string
  truncated?: boolean
  fieldname?: string
  value?: string
}

function makeRequest(specs: PartSpec[]) {
  const partsFn = vi.fn(() => {
    async function* gen() {
      for (const s of specs) {
        if (s.type === 'file') {
          yield {
            type: 'file' as const,
            filename: s.filename,
            file: {
              [Symbol.asyncIterator]: async function* () {
                yield Buffer.from(s.content ?? '')
              },
              truncated: s.truncated ?? false,
            },
          }
        } else {
          yield {
            type: 'field' as const,
            fieldname: s.fieldname,
            value: s.value,
          }
        }
      }
    }
    return gen()
  })

  return {
    parts: partsFn,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('collectSpreadsheetMultipart — happy path', () => {
  it('coleta arquivos, parseia selectedColumns e lê outputFormat', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'Name\nAlice' },
      { type: 'file', filename: 'b.xlsx', content: 'PK' },
      {
        type: 'field',
        fieldname: 'selectedColumns',
        value: '["Name","Email"]',
      },
      { type: 'field', fieldname: 'outputFormat', value: 'csv' },
    ])

    const result = await collectSpreadsheetMultipart(req as never, OPTS)

    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toEqual({
      buffer: Buffer.from('Name\nAlice'),
      fileName: 'a.csv',
    })
    expect(result.files[1].fileName).toBe('b.xlsx')
    expect(result.selectedColumns).toEqual(['Name', 'Email'])
    expect(result.outputFormat).toBe('csv')
  })

  it('default de outputFormat é "xlsx" quando o field está ausente', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'x' },
      { type: 'field', fieldname: 'selectedColumns', value: '["Name"]' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    expect(result.outputFormat).toBe('xlsx')
  })

  it('repassa override de limites (fileSize + files) ao request.parts', async () => {
    const req = makeRequest([{ type: 'file', filename: 'a.csv', content: 'x' }])
    await collectSpreadsheetMultipart(req as never, OPTS)
    expect(req.parts).toHaveBeenCalledWith({
      limits: { fileSize: OPTS.fileSizeLimitBytes, files: OPTS.maxFiles },
    })
  })
})

describe('collectSpreadsheetMultipart — defesas anti-abuso', () => {
  it('rejeita extensão não suportada na borda (validationError)', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'doc.pdf', content: '%PDF' },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('rejeita arquivo truncado (excedeu fileSize) → limitExceeded com label', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'big.csv', content: 'data', truncated: true },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({ limit: '30MB por arquivo' }),
    })
  })

  it('rejeita selectedColumns duplicado + loga warn (anti-DoS multipart)', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'x' },
      { type: 'field', fieldname: 'selectedColumns', value: '["Name"]' },
      { type: 'field', fieldname: 'selectedColumns', value: '["Email"]' },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toThrow('Campo selectedColumns enviado mais de uma vez')
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fieldname: 'selectedColumns' }),
      expect.stringContaining('duplicate'),
    )
  })

  it('rejeita outputFormat duplicado', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'x' },
      { type: 'field', fieldname: 'outputFormat', value: 'csv' },
      { type: 'field', fieldname: 'outputFormat', value: 'xlsx' },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toThrow('Campo outputFormat enviado mais de uma vez')
  })

  it('rejeita fieldname desconhecido + loga warn', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'x' },
      { type: 'field', fieldname: 'evilField', value: 'payload' },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toThrow('Campo desconhecido: evilField')
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fieldname: 'evilField' }),
      expect.stringContaining('unknown'),
    )
  })

  it('rethrow + warn quando selectedColumns tem parse inválido (ex: [])', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'a.csv', content: 'x' },
      { type: 'field', fieldname: 'selectedColumns', value: '[]' },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, OPTS),
    ).rejects.toBeInstanceOf(Error)
    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fieldname: 'selectedColumns' }),
      expect.stringContaining('parse rejected'),
    )
  })
})

// ===========================================================================
// F-1 (@security): TETO CUMULATIVO incremental — bound do pico de RAM (OOM/DoS)
//
// Sem o check a cada arquivo, N arquivos no limite individual bufferizariam
// `N × fileSizeLimitBytes` antes de qualquer reject. Estes testes provam o
// COMPORTAMENTO: (1) a soma é checada incrementalmente e (2) o loop FAZ
// short-circuit — não lê todos os arquivos antes de rejeitar (a prova real do
// bound de memória, não só "rejeita no fim").
// ===========================================================================
describe('collectSpreadsheetMultipart — teto cumulativo (@security F-1 OOM)', () => {
  /**
   * Request instrumentado: conta quantos corpos de arquivo foram REALMENTE
   * consumidos. Se o teto cumulativo rejeita antes de drenar todos, o contador
   * fica abaixo do total — prova do short-circuit (pico de RAM limitado).
   */
  function makeCountingRequest(files: { filename: string; bytes: number }[]) {
    const readState = { filesRead: 0 }
    const partsFn = vi.fn(() => {
      async function* gen() {
        for (const f of files) {
          yield {
            type: 'file' as const,
            filename: f.filename,
            file: {
              [Symbol.asyncIterator]: async function* () {
                readState.filesRead++
                yield Buffer.alloc(f.bytes)
              },
              truncated: false,
            },
          }
        }
      }
      return gen()
    })
    return {
      readState,
      req: {
        parts: partsFn,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    }
  }

  it('rejeita com totalSizeLabel quando a SOMA excede maxTotalBytes (mesmo cada arquivo < limite individual)', async () => {
    // 3 arquivos de 10 bytes (cada < fileSizeLimitBytes), teto cumulativo 15.
    const { req } = makeCountingRequest([
      { filename: 'a.csv', bytes: 10 },
      { filename: 'b.csv', bytes: 10 },
      { filename: 'c.csv', bytes: 10 },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, {
        ...OPTS,
        fileSizeLimitBytes: 1024,
        maxTotalBytes: 15,
        totalSizeLabel: '15B no total',
      }),
    ).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: expect.objectContaining({ limit: '15B no total' }),
    })
  })

  it('FAZ short-circuit: rejeita ANTES de ler todos os arquivos (bound do pico de RAM)', async () => {
    // file0 (10) → soma 10 ≤ 15 ok; file1 (10) → soma 20 > 15 → THROW.
    // file2 NUNCA deve ser lido — prova de que o pico fica em ~maxTotalBytes,
    // não em N × fileSizeLimitBytes.
    const { req, readState } = makeCountingRequest([
      { filename: 'a.csv', bytes: 10 },
      { filename: 'b.csv', bytes: 10 },
      { filename: 'c.csv', bytes: 10 },
    ])
    await expect(
      collectSpreadsheetMultipart(req as never, {
        ...OPTS,
        fileSizeLimitBytes: 1024,
        maxTotalBytes: 15,
        totalSizeLabel: '15B no total',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    // Leu só até o arquivo que estourou o teto (2 de 3); o 3º não foi drenado.
    expect(readState.filesRead).toBe(2)
    expect(readState.filesRead).toBeLessThan(3)
  })

  it('loga warn estruturado de tentativa (userId + totalBytes + maxTotalBytes)', async () => {
    const { req } = makeCountingRequest([{ filename: 'a.csv', bytes: 20 }])
    await expect(
      collectSpreadsheetMultipart(req as never, {
        ...OPTS,
        fileSizeLimitBytes: 1024,
        maxTotalBytes: 15,
        totalSizeLabel: '15B no total',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    expect(req.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OPTS.userId,
        totalBytes: 20,
        maxTotalBytes: 15,
      }),
      expect.stringContaining('cumulative multipart size exceeded'),
    )
  })

  it('soma EXATAMENTE igual a maxTotalBytes NÃO rejeita (boundary: > é estrito)', async () => {
    // 15 bytes com teto 15 → 15 > 15 é false → passa. Prova do operador `>`.
    const { req } = makeCountingRequest([{ filename: 'a.csv', bytes: 15 }])
    const result = await collectSpreadsheetMultipart(req as never, {
      ...OPTS,
      fileSizeLimitBytes: 1024,
      maxTotalBytes: 15,
      totalSizeLabel: '15B no total',
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].buffer.length).toBe(15)
  })
})

// ===========================================================================
// F-3 (@security): sanitização do fileName antes do push (defense in depth)
//
// O nome é dado hostil relido por consumidores downstream (Content-Disposition
// 6.6, output 6.4, exibição no status). Control chars (NUL/CR/LF/TAB/DEL) →
// header/log injection. Comprimento → abuso de storage de metadados.
// ===========================================================================
describe('collectSpreadsheetMultipart — sanitização de fileName (@security F-3)', () => {
  it('remove control chars (NUL/SOH/LF/TAB/DEL) preservando o nome legível', async () => {
    // 'a\x00\x01b\tc\nd\x7f.csv' → control chars descartados → 'abcd.csv'.
    const dirty = 'a\x00\x01b\tc\nd\x7f.csv'
    const req = makeRequest([{ type: 'file', filename: dirty, content: 'x' }])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    expect(result.files[0].fileName).toBe('abcd.csv')
    // Garantia explícita: nenhum char de controle sobrou.
    for (const ch of result.files[0].fileName) {
      const code = ch.charCodeAt(0)
      expect(code > 0x1f && code !== 0x7f).toBe(true)
    }
  })

  it('capa o comprimento em 255 chars (anti abuso de metadados / overflow de header)', async () => {
    // 260 'x' + '.csv' (raw é extensão válida). Sanitizado para no máx. 255.
    const longName = 'x'.repeat(260) + '.csv'
    const req = makeRequest([
      { type: 'file', filename: longName, content: 'x' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    expect(result.files[0].fileName.length).toBe(255)
  })

  // -------------------------------------------------------------------------
  // ANTI-REGRESSÃO @security 9f2c4a7b1e30 — cap PRESERVA a extensão.
  //
  // Comportamento antigo: capar o tail cru com slice(0, 255) podia transformar
  // `.xlsx` em `.xls` (extensão DIFERENTE, mas ainda válida) — o nome armazenado
  // divergiria da ext validada na borda (isValidExtension) e do conteúdo real.
  // Comportamento novo: capa o STEM e mantém a ext intacta. Estes testes travam
  // esse contrato pra impedir que a regressão volte.
  // -------------------------------------------------------------------------
  it('nome 256+ chars com .xlsx → capa o stem e PRESERVA a ext (não vira .xls)', async () => {
    // 260 'x' + '.xlsx' = 265 chars (> 255). O cap antigo cortaria o 'x' final
    // de 'xlsx' → '.xls'. O cap novo: stem(250) + '.xlsx' = 255, ext intacta.
    const longName = 'x'.repeat(260) + '.xlsx'
    const req = makeRequest([
      { type: 'file', filename: longName, content: 'x' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    const name = result.files[0].fileName

    expect(name.length).toBeLessThanOrEqual(MAX_LEN)
    expect(name.length).toBe(MAX_LEN)
    // O coração do finding: extensão preservada, NÃO degradada pra '.xls'.
    expect(name.endsWith('.xlsx')).toBe(true)
    expect(name.endsWith('.xls')).toBe(false)
    // E o resultado ainda valida na borda (casa com a ext que foi aceita).
    expect(name).toMatch(/^x+\.xlsx$/)
  })

  it('nome 256+ chars com .xls (ext de 4 chars) → preserva a ext curta intacta', async () => {
    // Cobre a outra extensão multi-char: garante que o cap não corrompe '.xls'
    // (ex: virar '.xl' ou perder o ponto) ao truncar o stem.
    const longName = 'y'.repeat(300) + '.xls'
    const req = makeRequest([
      { type: 'file', filename: longName, content: 'x' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    const name = result.files[0].fileName

    expect(name.length).toBe(MAX_LEN)
    expect(name.endsWith('.xls')).toBe(true)
    expect(name).toMatch(/^y+\.xls$/)
  })

  it('nome limpo curto com .xlsx (<= 255) passa intacto, ext inalterada', async () => {
    // Boundary: abaixo do cap, nenhum truncamento — a ext não é tocada.
    const req = makeRequest([
      { type: 'file', filename: 'planilha.xlsx', content: 'x' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    expect(result.files[0].fileName).toBe('planilha.xlsx')
  })

  it('nome limpo passa intacto (não normaliza além do necessário)', async () => {
    const req = makeRequest([
      { type: 'file', filename: 'relatório_2026.xlsx', content: 'x' },
    ])
    const result = await collectSpreadsheetMultipart(req as never, OPTS)
    expect(result.files[0].fileName).toBe('relatório_2026.xlsx')
  })
})
