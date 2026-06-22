/**
 * Supervisor do parse em worker_thread (Card 6.4 / 6.10).
 *
 * Roda `parse-worker.thread` num thread isolado com TIMEOUT DURO: se o parse
 * exceder `timeoutMs`, chama `worker.terminate()` — mata o trabalho CPU-bound
 * de verdade (o que `AbortSignal`/`Promise.race` no event loop não conseguem).
 *
 * **Resolução cross-runtime do arquivo do worker:** o projeto é CommonJS e roda
 * de 3 formas — `tsx` (dev), `vitest` (teste) e `tsc → dist` (prod). Em dev/teste
 * este módulo é `.ts` e o worker precisa ser carregado via `--require tsx/cjs`
 * (registra o loader de `.ts` no thread). Em prod este módulo já é `.js` e o
 * worker é o `.js` compilado, sem loader extra. Detectamos pela extensão do
 * próprio arquivo (`__filename`).
 *
 * @owner: @security
 * @card: 6.4 (6.10 folddado)
 */
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { AppError, Errors } from '../../errors/app-error'
import type { ParsedSpreadsheet } from './types'

/** Mensagem serializável devolvida pelo worker de parse. */
export type ParseWorkerResult =
  | { ok: true; data: ParsedSpreadsheet }
  | {
      ok: false
      error: {
        code: string
        message: string
        details?: Record<string, unknown>
      }
    }

/** Erro de timeout do parse — o worker foi terminado por exceder o limite. */
export class ParseTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`spreadsheet parse exceeded ${timeoutMs}ms and was terminated`)
    this.name = 'ParseTimeoutError'
  }
}

const isTsRuntime = __filename.endsWith('.ts')

/**
 * execArgv do worker: em runtime TS (dev/teste) registra o loader do tsx pra o
 * thread conseguir carregar um arquivo `.ts`; em prod (`.js`) não precisa.
 */
const WORKER_EXEC_ARGV = isTsRuntime ? ['--require', 'tsx/cjs'] : []

/**
 * Teto de heap do worker_thread de parse (@security/@devops ALTO). O timeout é
 * guarda de TEMPO; isto é a guarda de MEMÓRIA. worker_threads COMPARTILHAM o RSS
 * do processo — sem limite, um xlsx crafted que descomprima pra GBs derrubaria o
 * PROCESSO worker inteiro (OOM kill no Fly 256MB) + crash-loop. Com o limite, o
 * OOM vira crash do THREAD (`ERR_WORKER_OUT_OF_MEMORY` no evento 'error'), que o
 * handler classifica como PERMANENTE (sem retry). Dimensionado < metade dos
 * 256MB pra deixar margem ao pai (BullMQ + Prisma pool).
 */
const WORKER_MAX_OLD_GEN_MB = 96
const WORKER_MAX_YOUNG_GEN_MB = 32

function resolveParseWorkerFile(): string {
  const ext = isTsRuntime ? '.ts' : '.js'
  return path.join(__dirname, `parse-worker.thread${ext}`)
}

function rebuildError(error: {
  code: string
  message: string
  details?: Record<string, unknown>
}): AppError {
  // Preserva o discriminador de validação (parser só lança validationError);
  // qualquer outra coisa vira erro genérico de processamento (sem vazar interno).
  if (error.code === 'VALIDATION_ERROR') {
    return Errors.validationError(error.message, error.details)
  }
  return Errors.processingFailed(error.message)
}

/**
 * Mecanismo genérico: roda um arquivo de worker com `workerData` e um timeout
 * DURO que termina o thread. Exportado pra permitir testar o cancelamento com
 * uma fixture CPU-bound de forma determinística (sem flaky), sem expor hook de
 * teste no caminho de produção.
 *
 * @throws {ParseTimeoutError} se exceder `timeoutMs` (worker terminado)
 * @throws {AppError} reconstruído a partir do erro reportado pelo worker
 * @throws {Error} se o worker emitir erro de runtime ou sair inesperadamente
 */
export function runInThread<T>(
  workerFile: string,
  workerData: unknown,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(workerFile, {
      workerData,
      execArgv: WORKER_EXEC_ARGV,
      resourceLimits: {
        maxOldGenerationSizeMb: WORKER_MAX_OLD_GEN_MB,
        maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GEN_MB,
      },
    })

    let settled = false
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // terminate é best-effort/idempotente; não esperamos a promise (swallow
      // pra não gerar unhandled rejection se o thread já morreu).
      worker.terminate().catch(() => {})
      action()
    }

    const timer = setTimeout(() => {
      settle(() => reject(new ParseTimeoutError(timeoutMs)))
    }, timeoutMs)

    worker.once('message', (msg: ParseWorkerResult) => {
      settle(() => {
        if (msg.ok) resolve(msg.data as unknown as T)
        else reject(rebuildError(msg.error))
      })
    })
    worker.once('error', (err) => settle(() => reject(err)))
    worker.once('exit', (code) => {
      // exit antes de message/timeout = falha real (crash do thread).
      settle(() =>
        reject(new Error(`parse worker exited unexpectedly (code ${code})`)),
      )
    })
  })
}

/**
 * Faz o parse de uma planilha num worker_thread isolado, abortando (com
 * `terminate()`) se exceder `timeoutMs`. Mesma saída do `parseSpreadsheet`
 * síncrono, mas com cancelamento real.
 */
export function parseInWorkerThread(
  buffer: Buffer,
  fileName: string,
  timeoutMs: number,
): Promise<ParsedSpreadsheet> {
  return runInThread<ParsedSpreadsheet>(
    resolveParseWorkerFile(),
    { buffer, fileName },
    timeoutMs,
  )
}
