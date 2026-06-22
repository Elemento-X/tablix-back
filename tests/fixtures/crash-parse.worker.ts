/**
 * Fixture de teste (Card 6.4) — worker que sai sem nunca postar mensagem.
 *
 * Cobre o ramo `worker.once('exit')` em `parse-in-thread.ts`: um thread que
 * morre/crasha ANTES de `postMessage` (ex: OOM do thread, segfault de lib
 * nativa) deve rejeitar com `Error('parse worker exited unexpectedly ...')` —
 * nunca pendurar a Promise. Simulamos saindo imediatamente com código !=0.
 */
process.exit(1)
