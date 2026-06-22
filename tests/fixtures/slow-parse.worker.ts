/**
 * Fixture de teste (Card 6.4) — worker que NUNCA responde (CPU-bound infinito).
 *
 * Prova que `runInThread` mata o thread no timeout via `terminate()`: um loop
 * busy não-cooperativo só pode ser interrompido por terminate (é exatamente o
 * cenário de um XLSX malicioso travando o parse). Não faz `postMessage` — se o
 * timeout não funcionasse, o teste penduraria até estourar o testTimeout.
 */

// eslint-disable-next-line no-constant-condition
while (true) {
  // busy loop intencional — não cooperativo, não escuta sinais.
}
