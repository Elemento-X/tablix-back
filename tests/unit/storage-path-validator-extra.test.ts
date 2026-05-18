/**
 * Unit tests EXTRAS for storage path validator — Card #146 fix-pack ciclo 1.
 *
 * Cobre cenários complementares ao storage-path-validator.test.ts:
 *   - Null byte (\x00) literal rejeitado (@tester BAIXO a1b9c3d2d4)
 *   - DEL char (\x7F) literal rejeitado
 *   - Tab (\x09) rejeitado
 *   - Casos sintetizados via concatenação Node-level (não inline source)
 *
 * **Por que arquivo separado**: storage-path-validator.test.ts tem
 * caracteres especiais (\x00) embebidos literais no source que dificultam
 * Edit cirúrgico. Manter testes novos em arquivo separado preserva
 * legibilidade + Edit confiável.
 *
 * @owner: @tester
 * @card: #146 fix-pack ciclo 1
 */
import { describe, it, expect } from 'vitest'

import { assertValidStoragePath } from '../../src/lib/storage/path-validator'

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VALID_DATE = '2026-05-18'
const VALID_JOB = 'abc1234'

describe('assertValidStoragePath — control chars (Card #146 fix-pack)', () => {
  it('rejeita null byte (0x00) — CWE-158', () => {
    const nullChar = String.fromCharCode(0x00)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${nullChar}.csv`,
      ),
    ).toThrow()
  })

  it('rejeita DEL char (0x7F)', () => {
    const delChar = String.fromCharCode(0x7f)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${delChar}.csv`,
      ),
    ).toThrow()
  })

  it('rejeita TAB (0x09)', () => {
    const tabChar = String.fromCharCode(0x09)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${tabChar}.csv`,
      ),
    ).toThrow()
  })

  it('rejeita BEL (0x07)', () => {
    const belChar = String.fromCharCode(0x07)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${belChar}.csv`,
      ),
    ).toThrow()
  })

  it('rejeita CR (0x0D)', () => {
    const crChar = String.fromCharCode(0x0d)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${crChar}.csv`,
      ),
    ).toThrow()
  })

  it('rejeita LF (0x0A)', () => {
    const lfChar = String.fromCharCode(0x0a)
    expect(() =>
      assertValidStoragePath(
        `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}${lfChar}.csv`,
      ),
    ).toThrow()
  })
})

describe('assertValidStoragePath — datas inválidas (Card #146 fix-pack — drift fhdl)', () => {
  // Card #146 fix-pack ciclo 1 (@dba ALTO #2): regex de file_history (e agora
  // fhdl pós-migration 123000) endurece dates pra mes/dia válidos.
  // Path-validator TS espelha o regex SQL — testes provam paridade.

  it('rejeita data inválida 9999-99-99', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/9999-99-99/${VALID_JOB}.csv`),
    ).toThrow()
  })

  it('rejeita mês 00', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-00-15/${VALID_JOB}.csv`),
    ).toThrow()
  })

  it('rejeita mês 13', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-13-15/${VALID_JOB}.csv`),
    ).toThrow()
  })

  it('rejeita dia 00', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-05-00/${VALID_JOB}.csv`),
    ).toThrow()
  })

  it('rejeita dia 32', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-05-32/${VALID_JOB}.csv`),
    ).toThrow()
  })

  it('aceita 2026-01-01 (extremo válido inferior)', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-01-01/${VALID_JOB}.csv`),
    ).not.toThrow()
  })

  it('aceita 2026-12-31 (extremo válido superior)', () => {
    expect(() =>
      assertValidStoragePath(`${VALID_UUID}/2026-12-31/${VALID_JOB}.csv`),
    ).not.toThrow()
  })

  // NOTA: regex NÃO valida day-month consistency (ex: 2026-02-30 passa).
  // Aceitável — regex é gate primário; data inválida 02-30 ainda passa porque
  // regex aceita 01-31 todos. Validação semântica é app-side (não chegamos
  // a esse cenário pois jobs gerados pelo Tablix usam Date.now() UTC).
})

describe('assertValidStoragePath — paridade Zod ↔ SQL CHECK (Card #146 fix-pack)', () => {
  // @tester MÉDIO: matriz mínima provando paridade entre regex TS e SQL
  // CHECK fhdl_storage_path_format_check (pós-migration 123000).
  //
  // Integration test completo Zod ↔ SQL com Postgres real é Fix #12 separado.
  // Aqui validamos APENAS que regex TS rejeita os mesmos casos que o regex
  // SQL rejeita — checagem sintática (não runtime DB).

  const matrixCases: Array<{
    input: string
    shouldAccept: boolean
    reason: string
  }> = [
    {
      input: `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}.csv`,
      shouldAccept: true,
      reason: 'canônico válido',
    },
    {
      input: `aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee/${VALID_DATE}/${VALID_JOB}.csv`,
      shouldAccept: false,
      reason: 'UUID v3 (não v4)',
    },
    {
      input: `${VALID_UUID}/2026-99-99/${VALID_JOB}.csv`,
      shouldAccept: false,
      reason: 'data inválida pós fix-pack',
    },
    {
      input: `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}.exe`,
      shouldAccept: false,
      reason: 'extensão não-whitelist',
    },
    {
      input: `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}.xlsx`,
      shouldAccept: true,
      reason: 'extensão xlsx válida',
    },
    {
      input: `${VALID_UUID}/${VALID_DATE}/${VALID_JOB}.xls`,
      shouldAccept: true,
      reason: 'extensão xls válida',
    },
    {
      input: '',
      shouldAccept: false,
      reason: 'vazio',
    },
    {
      input: `${VALID_UUID}//${VALID_JOB}.csv`,
      shouldAccept: false,
      reason: 'sem data segment',
    },
  ]

  matrixCases.forEach(({ input, shouldAccept, reason }) => {
    it(`${shouldAccept ? 'aceita' : 'rejeita'}: ${reason}`, () => {
      if (shouldAccept) {
        expect(() => assertValidStoragePath(input)).not.toThrow()
      } else {
        expect(() => assertValidStoragePath(input)).toThrow()
      }
    })
  })
})
