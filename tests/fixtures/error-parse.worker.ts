/**
 * Fixture de teste (Card 6.4) — worker que reporta um erro NÃO-validação.
 *
 * Cobre o ramo `rebuildError` para `code !== 'VALIDATION_ERROR'` em
 * `parse-in-thread.ts`: o supervisor deve reconstruir o erro como
 * `Errors.processingFailed` (genérico, sem vazar interno), NÃO como
 * validationError. Posta um resultado discriminado `{ ok: false }` com um
 * código arbitrário de processamento.
 */
import { parentPort } from 'node:worker_threads'

if (parentPort) {
  parentPort.postMessage({
    ok: false,
    error: { code: 'PROCESSING_FAILED', message: 'parse exploded internally' },
  })
}
