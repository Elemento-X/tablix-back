/**
 * Unit/spike tests do parse em worker_thread (Card 6.4 / 6.10).
 *
 * Valida o ELO crítico do timeout real: um parse CPU-bound infinito (fixture)
 * é MORTO via terminate() dentro do timeout — o que `AbortSignal`/`Promise.race`
 * não conseguiriam. Também prova o caminho feliz (parse real num thread) e a
 * propagação do erro de validação reconstruído como AppError.
 *
 * @owner: @tester
 * @card: 6.4
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppError, ErrorCodes } from '../../src/errors/app-error'
import {
  ParseTimeoutError,
  parseInWorkerThread,
  runInThread,
} from '../../src/lib/spreadsheet/parse-in-thread'

const SLOW_WORKER = path.join(__dirname, '../fixtures/slow-parse.worker.ts')
const ERROR_WORKER = path.join(__dirname, '../fixtures/error-parse.worker.ts')
const CRASH_WORKER = path.join(__dirname, '../fixtures/crash-parse.worker.ts')

describe('parseInWorkerThread — caminho feliz (parse real em thread)', () => {
  it('parseia um CSV válido num worker_thread e retorna ParsedSpreadsheet', async () => {
    const buffer = Buffer.from('name,age\nAlice,30\nBob,25\n', 'utf-8')
    const result = await parseInWorkerThread(buffer, 'people.csv', 10_000)

    expect(result.format).toBe('csv')
    expect(result.headers).toEqual(['name', 'age'])
    expect(result.rowCount).toBe(2)
    expect(result.rows[0].name).toBe('Alice')
  })

  it('propaga erro de validação do parser como AppError (extensão inválida)', async () => {
    const buffer = Buffer.from('whatever', 'utf-8')
    await expect(
      parseInWorkerThread(buffer, 'malware.exe', 10_000),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('runInThread — timeout DURO mata o thread CPU-bound', () => {
  it('termina o worker e rejeita ParseTimeoutError quando excede o timeout', async () => {
    const start = Date.now()
    await expect(
      runInThread(SLOW_WORKER, { irrelevant: true }, 300),
    ).rejects.toBeInstanceOf(ParseTimeoutError)
    // Prova que NÃO pendurou até o testTimeout — terminou perto do limite.
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('o ParseTimeoutError carrega o timeoutMs configurado', async () => {
    try {
      await runInThread(SLOW_WORKER, {}, 250)
      throw new Error('deveria ter dado timeout')
    } catch (err) {
      expect(err).toBeInstanceOf(ParseTimeoutError)
      expect((err as ParseTimeoutError).timeoutMs).toBe(250)
    }
  })
})

describe('runInThread — reconstrução de erro reportado pelo worker', () => {
  it('erro NÃO-validação reportado pelo worker → AppError PROCESSING_FAILED (genérico)', async () => {
    // O worker posta { ok:false, code:'PROCESSING_FAILED' }. rebuildError NÃO
    // cai no ramo de validação — vira Errors.processingFailed (sem vazar interno).
    const err = await runInThread(ERROR_WORKER, {}, 5_000).catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(ErrorCodes.PROCESSING_FAILED)
    // Não vaza como VALIDATION_ERROR (discriminador preservado só pra validação).
    expect((err as AppError).code).not.toBe(ErrorCodes.VALIDATION_ERROR)
  })
})

describe('runInThread — exit inesperado do thread (crash antes de postMessage)', () => {
  it('thread sai sem postar mensagem → rejeita Error "exited unexpectedly" (não pendura)', async () => {
    const err = await runInThread(CRASH_WORKER, {}, 5_000).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ParseTimeoutError)
    expect((err as Error).message).toMatch(/exited unexpectedly/)
  })
})
