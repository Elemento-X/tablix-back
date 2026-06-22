/**
 * Worker-thread entry do parse de planilha (Card 6.4 / 6.10).
 *
 * **Por que existe:** `XLSX.read` (e o parse de CSV de arquivos grandes) é
 * SÍNCRONO e CPU-bound. Um `AbortSignal.timeout` + `Promise.race` no event loop
 * principal NÃO interrompe trabalho síncrono — o cozinheiro não escuta o timer.
 * Rodando o parse num worker_thread isolado, o supervisor (`parse-in-thread.ts`)
 * pode chamar `worker.terminate()` e MATAR o parse de verdade no timeout
 * (defesa real contra ReDoS — CVE-2024-22363 — e contra hang de arquivo crafted).
 *
 * Bônus: isola o pico de memória do parse do processo do worker (R-1 OOM).
 *
 * Contrato: recebe `{ buffer, fileName }` via `workerData`, devolve via
 * `postMessage` um resultado SERIALIZÁVEL discriminado (`ok: true|false`) — o
 * `AppError` não cruza a fronteira de thread como instância, então achatamos
 * pra `{ code, message, details }` e o supervisor reconstrói.
 *
 * @owner: @security
 * @card: 6.4 (6.10 folddado)
 */
import { parentPort, workerData } from 'node:worker_threads'
import { AppError } from '../../errors/app-error'
import { parseSpreadsheet } from './parser'

interface ParseWorkerInput {
  /** Buffer cruzando a fronteira de thread chega como Uint8Array (structured clone). */
  buffer: Buffer | Uint8Array
  fileName: string
}

function main(): void {
  // Guard defensivo — só roda como worker_thread (parentPort presente).
  if (!parentPort) return

  const { buffer, fileName } = workerData as ParseWorkerInput
  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    const data = parseSpreadsheet(buf, fileName)
    parentPort.postMessage({ ok: true, data })
  } catch (err) {
    if (err instanceof AppError) {
      parentPort.postMessage({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      })
    } else {
      parentPort.postMessage({
        ok: false,
        error: {
          code: 'PROCESSING_FAILED',
          message: err instanceof Error ? err.message : 'parse failed',
        },
      })
    }
  }
}

main()
