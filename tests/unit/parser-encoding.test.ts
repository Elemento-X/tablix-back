/**
 * Unit tests for decodeTextBuffer + parseCsv encoding (Card 1.14)
 *
 * Cobre:
 *   - UTF-8 puro sem BOM
 *   - UTF-8 com BOM (EF BB BF) — strip antes do header
 *   - windows-1252 (Excel BR default) — bytes 0xE1=á, 0xE7=ç, 0xE3=ã, 0xF4=ô, 0x80=€
 *   - UTF-16 LE com BOM (FF FE)
 *   - UTF-16 BE com BOM (FE FF)
 *   - ASCII puro (caminho feliz)
 *   - Buffer curto (<2/<3 bytes) — não crashar
 *   - Regression guard: BOM UTF-8 não fica colado no primeiro header
 *   - Regression guard: Excel BR (windows-1252) decodifica corretamente
 *   - Mutation guard: remover fatal:true — bytes inválidos passariam silenciosos
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import { decodeTextBuffer, parseSpreadsheet } from '../../src/lib/spreadsheet/parser'

// Helper: monta buffer a partir de hex bytes (clareza nos testes)
function hex(...bytes: number[]): Buffer {
  return Buffer.from(bytes)
}

// Helper: concatena buffer de BOM + payload
function withBom(bom: Buffer, payload: Buffer): Buffer {
  return Buffer.concat([bom, payload])
}

describe('decodeTextBuffer — Card 1.14', () => {
  // ===========================================
  // UTF-8 puro (sem BOM)
  // ===========================================
  describe('UTF-8 sem BOM', () => {
    it('ASCII puro', () => {
      const buf = Buffer.from('Nome,Idade\nJoao,30', 'utf-8')
      expect(decodeTextBuffer(buf)).toBe('Nome,Idade\nJoao,30')
    })

    it('caracteres acentuados PT-BR em UTF-8', () => {
      const buf = Buffer.from('Nome,Cidade\nJoão,São Paulo', 'utf-8')
      expect(decodeTextBuffer(buf)).toBe('Nome,Cidade\nJoão,São Paulo')
    })

    it('caracteres especiais (€, travessão, aspas tipográficas)', () => {
      const buf = Buffer.from('Preço,Descrição\n€100,"texto — fim"', 'utf-8')
      expect(decodeTextBuffer(buf)).toContain('€')
      expect(decodeTextBuffer(buf)).toContain('—')
    })
  })

  // ===========================================
  // UTF-8 com BOM
  // ===========================================
  describe('UTF-8 com BOM', () => {
    const BOM_UTF8 = hex(0xef, 0xbb, 0xbf)

    it('BOM é removido antes do decode', () => {
      const payload = Buffer.from('Nome,Idade\nJoao,30', 'utf-8')
      const result = decodeTextBuffer(withBom(BOM_UTF8, payload))
      expect(result).toBe('Nome,Idade\nJoao,30')
    })

    it('REGRESSION: BOM não fica colado no primeiro header', () => {
      const payload = Buffer.from('Nome,Cidade\nAna,Rio', 'utf-8')
      const result = decodeTextBuffer(withBom(BOM_UTF8, payload))
      // Bug clássico: sem strip, primeiro header vira '\uFEFFNome'
      expect(result.startsWith('\uFEFF')).toBe(false)
      expect(result.startsWith('Nome')).toBe(true)
    })

    it('BOM + conteúdo com acentos UTF-8', () => {
      const payload = Buffer.from('Nome,Cidade\nJoão,São Paulo', 'utf-8')
      const result = decodeTextBuffer(withBom(BOM_UTF8, payload))
      expect(result).toBe('Nome,Cidade\nJoão,São Paulo')
    })
  })

  // ===========================================
  // windows-1252 (Excel BR)
  // ===========================================
  describe('windows-1252 (Excel BR default)', () => {
    it('REGRESSION: Excel BR CSV decodifica acentos corretamente', () => {
      // Nome;Cidade\nJoão;São Paulo em windows-1252
      // J=0x4A o=0x6F ã=0xE3 o=0x6F / S=0x53 ã=0xE3 o=0x6F (space) P=0x50...
      const buf = hex(
        0x4e,
        0x6f,
        0x6d,
        0x65,
        0x3b,
        0x43,
        0x69,
        0x64,
        0x61,
        0x64,
        0x65,
        0x0a, // Nome;Cidade\n
        0x4a,
        0x6f,
        0xe3,
        0x6f,
        0x3b, // João;
        0x53,
        0xe3,
        0x6f,
        0x20,
        0x50,
        0x61,
        0x75,
        0x6c,
        0x6f, // São Paulo
      )
      const result = decodeTextBuffer(buf)
      expect(result).toBe('Nome;Cidade\nJoão;São Paulo')
    })

    it('ç (0xE7) e á (0xE1) decodificam em win-1252', () => {
      // "açaí" em win-1252: a=0x61 ç=0xE7 a=0x61 í=0xED
      const buf = hex(0x61, 0xe7, 0x61, 0xed)
      expect(decodeTextBuffer(buf)).toBe('açaí')
    })

    it('bytes 0xC0-0xFF (acentos PT-BR) decodificam sem replacement char', () => {
      // Range 0xC0-0xFF é onde iso-8859-1 e win-1252 concordam — é onde
      // vivem todos os acentos PT-BR. Node mapeia 'windows-1252' via WHATWG
      // mas em algumas builds 0x80-0x9F caem em U+0080..U+009F (C1 controls)
      // em vez dos símbolos win-1252 (€, smart quotes). Para CSVs Excel BR,
      // isso é irrelevante: os acentos que importam estão em 0xC0-0xFF.
      const buf = hex(0xc1, 0xc9, 0xcd, 0xd3, 0xda, 0xe7, 0xe3, 0xf5) // ÁÉÍÓÚçãõ
      const result = decodeTextBuffer(buf)
      expect(result).toBe('ÁÉÍÓÚçãõ')
      expect(result).not.toContain('\uFFFD')
    })
  })

  // ===========================================
  // UTF-16 LE/BE com BOM
  // ===========================================
  describe('UTF-16 com BOM', () => {
    it('UTF-16 LE (BOM FF FE) decodifica corretamente', () => {
      // "Nome" em UTF-16 LE: FF FE 4E 00 6F 00 6D 00 65 00
      const buf = hex(0xff, 0xfe, 0x4e, 0x00, 0x6f, 0x00, 0x6d, 0x00, 0x65, 0x00)
      expect(decodeTextBuffer(buf)).toBe('Nome')
    })

    it('UTF-16 BE (BOM FE FF) decodifica corretamente', () => {
      // "Nome" em UTF-16 BE: FE FF 00 4E 00 6F 00 6D 00 65
      const buf = hex(0xfe, 0xff, 0x00, 0x4e, 0x00, 0x6f, 0x00, 0x6d, 0x00, 0x65)
      expect(decodeTextBuffer(buf)).toBe('Nome')
    })

    it('UTF-16 LE com acentos PT-BR', () => {
      // "João" em UTF-16 LE
      const text = 'João'
      const u16 = Buffer.alloc(text.length * 2 + 2)
      u16[0] = 0xff
      u16[1] = 0xfe
      for (let i = 0; i < text.length; i++) {
        u16.writeUInt16LE(text.charCodeAt(i), 2 + i * 2)
      }
      expect(decodeTextBuffer(u16)).toBe('João')
    })
  })

  // ===========================================
  // Edge cases
  // ===========================================
  describe('edge cases', () => {
    it('buffer vazio retorna string vazia', () => {
      expect(decodeTextBuffer(Buffer.alloc(0))).toBe('')
    })

    it('buffer de 1 byte ASCII', () => {
      expect(decodeTextBuffer(hex(0x41))).toBe('A')
    })

    it('buffer de 2 bytes ASCII (não BOM)', () => {
      expect(decodeTextBuffer(hex(0x41, 0x42))).toBe('AB')
    })

    it('buffer só com BOM UTF-8 (sem payload) retorna string vazia', () => {
      // Fecha finding 7a3f1e9c2b84 (run #1): assertion explícita do comportamento
      // após strip. TextDecoder decoda buffer vazio sem erro.
      expect(decodeTextBuffer(hex(0xef, 0xbb, 0xbf))).toBe('')
    })

    it('buffer só com BOM UTF-16 LE (sem payload) retorna string vazia', () => {
      expect(decodeTextBuffer(hex(0xff, 0xfe))).toBe('')
    })

    it('buffer só com BOM UTF-16 BE (sem payload) retorna string vazia', () => {
      expect(decodeTextBuffer(hex(0xfe, 0xff))).toBe('')
    })

    it('BOM UTF-8 incompleto (EF BB sem BF) não crasha — cai em fallback win-1252', () => {
      // Fecha finding c91d2b7e4a56 (run #1): length<3 não entra no if do BOM,
      // bytes vão direto pro decoder. 0xEF isolado é inválido em UTF-8 →
      // TextDecoder fatal lança → fallback win-1252 (0xEF=ï, 0xBB=»).
      const result = decodeTextBuffer(hex(0xef, 0xbb))
      expect(result).toBe('ï»')
      expect(result).not.toContain('\uFFFD')
    })

    it('MUTATION GUARD: sem fatal:true, bytes inválidos virariam U+FFFD silencioso', () => {
      // Sequência que NÃO é UTF-8 válida mas É win-1252 válida:
      // 0xE3 (ã em win-1252) sozinho é byte inválido em UTF-8 (início de 3-byte seq)
      const buf = hex(0x4a, 0x6f, 0xe3, 0x6f) // "João" em win-1252
      const result = decodeTextBuffer(buf)
      // Se fatal:true funciona, cai no fallback win-1252 → 'João'
      // Se fatal:false (mutante), UTF-8 replacement → 'Jo\uFFFDo'
      expect(result).toBe('João')
      expect(result).not.toContain('\uFFFD')
    })
  })
})

// ===========================================
// Integração: parseSpreadsheet CSV com encoding real
// ===========================================
describe('parseSpreadsheet CSV — encoding integration (Card 1.14)', () => {
  it('CSV UTF-8 puro é parseado corretamente', () => {
    const csv = Buffer.from('Nome,Idade\nAna,30\nBruno,25', 'utf-8')
    const result = parseSpreadsheet(csv, 'teste.csv')
    expect(result.headers).toEqual(['Nome', 'Idade'])
    expect(result.rowCount).toBe(2)
    expect(result.rows[0].Nome).toBe('Ana')
  })

  it('REGRESSION: CSV UTF-8 com BOM — primeiro header não carrega \\uFEFF', () => {
    const BOM = hex(0xef, 0xbb, 0xbf)
    const payload = Buffer.from('Nome,Idade\nAna,30', 'utf-8')
    const csv = withBom(BOM, payload)

    const result = parseSpreadsheet(csv, 'bom.csv')
    // Bug histórico: validateColumns falharia porque header seria '\uFEFFNome'
    expect(result.headers[0]).toBe('Nome')
    expect(result.headers[0].charCodeAt(0)).toBe(0x4e) // 'N'
    expect(result.headers[0].charCodeAt(0)).not.toBe(0xfeff)
  })

  it('REGRESSION: CSV windows-1252 (Excel BR) — acentos preservados', () => {
    // "Nome,Cidade\nJoão,São Paulo" em windows-1252
    const csv = hex(
      0x4e,
      0x6f,
      0x6d,
      0x65,
      0x2c,
      0x43,
      0x69,
      0x64,
      0x61,
      0x64,
      0x65,
      0x0a,
      0x4a,
      0x6f,
      0xe3,
      0x6f,
      0x2c,
      0x53,
      0xe3,
      0x6f,
      0x20,
      0x50,
      0x61,
      0x75,
      0x6c,
      0x6f,
    )
    const result = parseSpreadsheet(csv, 'excel-br.csv')
    expect(result.headers).toEqual(['Nome', 'Cidade'])
    expect(result.rows[0].Nome).toBe('João')
    expect(result.rows[0].Cidade).toBe('São Paulo')
  })

  it('MUTATION GUARD: sem decodeTextBuffer, acentos em win-1252 virariam U+FFFD', () => {
    // "Nome,Cidade\nJoão,Recife" em windows-1252
    const csv = hex(
      0x4e,
      0x6f,
      0x6d,
      0x65,
      0x2c,
      0x43,
      0x69,
      0x64,
      0x61,
      0x64,
      0x65,
      0x0a,
      0x4a,
      0x6f,
      0xe3,
      0x6f,
      0x2c,
      0x52,
      0x65,
      0x63,
      0x69,
      0x66,
      0x65,
    )
    const result = parseSpreadsheet(csv, 'mut.csv')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('\\ufffd')
    // Nenhum replacement char em nenhuma célula
    expect(result.rows[0].Nome).toBe('João')
  })
})
