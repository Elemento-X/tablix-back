/**
 * Unit tests do path-validator JOB-SCOPED (Card 6.2 — Fase 6, decisão G-3).
 *
 * `assertValidStoragePath` agora aceita a UNIÃO de duas formas estritas:
 *   - legada (sync):   {userId}/{date}/{jobId}.{ext}
 *   - job-scoped (async): {userId}/{date}/{jobKey}/input-NN.{ext}
 *                         {userId}/{date}/{jobKey}/output.{ext}
 *
 * Cobre:
 *   - aceita input-NN e output válidos
 *   - REGRESSÃO: forma legada continua válida (nenhuma forma afrouxa a outra)
 *   - rejeita traversal/uppercase/ext inválida/`..`/`\`/null byte na forma nova
 *   - filename estrito: input-NN exige 2 dígitos; só `output` literal
 *   - STORAGE_JOB_PATH_REGEX exposto em __testing
 *   - EXTENSION_TO_MIME (mapa completo) — Card 6.2
 *
 * @owner: @tester
 * @card: 6.2 — Setup BullMQ + conexão Redis TCP (Fase 6)
 */
import { describe, expect, it } from 'vitest'
import {
  __testing,
  assertValidStoragePath,
} from '../../src/lib/storage/path-validator'
import {
  ALLOWED_EXTENSIONS,
  EXTENSION_TO_MIME,
} from '../../src/lib/storage/types'

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const DATE = '2026-06-21'
const JOBKEY = '8c7e123456784abc89def01234567890' // 32 hex (UUID sem hífens)
const LEGACY_JOB = 'abc1234'

describe('forma job-scoped — happy paths (G-3)', () => {
  it('aceita input-00.csv', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-00.csv`),
    ).not.toThrow()
  })

  it('aceita input-99.xlsx (teto de padding)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-99.xlsx`),
    ).not.toThrow()
  })

  it('aceita output.csv', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/output.csv`),
    ).not.toThrow()
  })

  it.each(ALLOWED_EXTENSIONS)('aceita output.%s', (ext) => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/output.${ext}`),
    ).not.toThrow()
  })

  it.each(ALLOWED_EXTENSIONS)('aceita input-05.%s', (ext) => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-05.${ext}`),
    ).not.toThrow()
  })
})

describe('REGRESSÃO — forma legada (sync) continua válida', () => {
  it('aceita {userId}/{date}/{jobId}.csv (legado)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${LEGACY_JOB}.csv`),
    ).not.toThrow()
  })

  it.each(ALLOWED_EXTENSIONS)('aceita legado .%s', (ext) => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${LEGACY_JOB}.${ext}`),
    ).not.toThrow()
  })

  it('legado com jobId 64 chars ainda válido', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${'a'.repeat(64)}.csv`),
    ).not.toThrow()
  })
})

describe('forma job-scoped — rejeições de segurança', () => {
  it('rejeita `..` na subpasta (traversal)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/../input-00.csv`),
    ).toThrow()
  })

  it('rejeita `\\` (Windows separator)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}\\input-00.csv`),
    ).toThrow()
  })

  it('rejeita UUID uppercase', () => {
    expect(() =>
      assertValidStoragePath(
        `${UUID.toUpperCase()}/${DATE}/${JOBKEY}/input-00.csv`,
      ),
    ).toThrow()
  })

  it('rejeita ext fora da whitelist (input-00.exe)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-00.exe`),
    ).toThrow()
  })

  it('rejeita ext fora da whitelist (output.sh)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/output.sh`),
    ).toThrow()
  })

  it('rejeita null byte (0x00) na subpasta', () => {
    const nul = String.fromCharCode(0x00)
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}${nul}/input-00.csv`),
    ).toThrow()
  })

  it('rejeita jobKey uppercase', () => {
    expect(() =>
      assertValidStoragePath(
        `${UUID}/${DATE}/${JOBKEY.toUpperCase()}/input-00.csv`,
      ),
    ).toThrow()
  })

  it('rejeita data inválida na forma job-scoped (mês 13)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/2026-13-01/${JOBKEY}/input-00.csv`),
    ).toThrow()
  })
})

describe('forma job-scoped — filename estrito', () => {
  it('rejeita input-1 (1 dígito, padding errado)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-1.csv`),
    ).toThrow()
  })

  it('rejeita input-100 (3 dígitos)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input-100.csv`),
    ).toThrow()
  })

  it('rejeita input sem índice (input.csv)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/input.csv`),
    ).toThrow()
  })

  it('rejeita filename arbitrário (random.csv)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/random.csv`),
    ).toThrow()
  })

  it('rejeita output com sufixo (output-1.csv)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/output-1.csv`),
    ).toThrow()
  })

  it('rejeita subpasta extra (nível a mais)', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/sub/input-00.csv`),
    ).toThrow()
  })

  it('rejeita trailing slash na forma job-scoped', () => {
    expect(() =>
      assertValidStoragePath(`${UUID}/${DATE}/${JOBKEY}/output.csv/`),
    ).toThrow()
  })
})

describe('STORAGE_JOB_PATH_REGEX exposto (internals)', () => {
  it('regex existe e é case-sensitive (sem flag /i)', () => {
    expect(__testing.STORAGE_JOB_PATH_REGEX).toBeInstanceOf(RegExp)
    expect(__testing.STORAGE_JOB_PATH_REGEX.flags).toBe('')
  })

  it('casa input-NN e output mas não filename arbitrário', () => {
    const re = __testing.STORAGE_JOB_PATH_REGEX
    expect(re.test(`${UUID}/${DATE}/${JOBKEY}/input-42.csv`)).toBe(true)
    expect(re.test(`${UUID}/${DATE}/${JOBKEY}/output.csv`)).toBe(true)
    expect(re.test(`${UUID}/${DATE}/${JOBKEY}/evil.csv`)).toBe(false)
  })
})

describe('EXTENSION_TO_MIME — mapa completo (Card 6.2)', () => {
  it('csv → text/csv', () => {
    expect(EXTENSION_TO_MIME.csv).toBe('text/csv')
  })

  it('xlsx → spreadsheetml.sheet', () => {
    expect(EXTENSION_TO_MIME.xlsx).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
  })

  it('xls → application/vnd.ms-excel', () => {
    expect(EXTENSION_TO_MIME.xls).toBe('application/vnd.ms-excel')
  })

  it('cobre TODAS as ALLOWED_EXTENSIONS (sem buraco no Record)', () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(EXTENSION_TO_MIME[ext]).toBeTruthy()
    }
    // Sem chaves extras além das permitidas.
    expect(Object.keys(EXTENSION_TO_MIME).sort()).toEqual(
      [...ALLOWED_EXTENSIONS].sort(),
    )
  })
})
