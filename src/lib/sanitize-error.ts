/**
 * Sanitize de error messages — SSOT compartilhado.
 *
 * Extraído de `retention.job.ts` + `quota-alert.job.ts` que mantinham cópias
 * idênticas (declarado nos comments dos próprios arquivos como "duplicação
 * consciente"). Discovery card resolvido @dba + @security convergente do
 * Card #147 fix-pack ciclo 1.
 *
 * **O que faz** (pattern Card #150 + retention.job + scheduler/cron.ts):
 *  1. Cap 100 chars — força msg sintética curta no logger
 *  2. Split em `:` e pega só PREFIXO (`Invalid prisma.X.Y() invocation`)
 *     antes do trecho com query SQL — Prisma sempre tem `:` separador
 *     entre header e payload da query (que vaza UUID/PII parametrizado)
 *  3. Replace CR/LF/TAB — defesa contra log injection (atacante injeta
 *     newline + linha falsa "user=admin authorized" no log estruturado)
 *
 * **Anti-pattern proibido**: NÃO logar `err.message` cru. Stacks de Prisma
 * têm shape:
 *   `Invalid prisma.fileHistory.update() invocation: <query SQL com WHERE id="abc-uuid">`
 * Cap 200 cortava DEPOIS do trecho com PII. Split em `:` pega só `Invalid...invocation`.
 *
 * Para erros NÃO-Prisma (Storage 5xx, network), o split em `:` mantém
 * a mensagem inteira (sem `:` = pega 1ª parte = tudo). Aceitável: erros
 * de rede tem msg curta e sem PII típica.
 *
 * @owner: @dba + @security
 * @card: #147 fix-pack ciclo 2 (extract discovery convergente)
 */
export function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const prefix = err.message.split(':')[0] ?? ''
    return prefix.slice(0, 100).replace(/[\r\n\t]/g, ' ')
  }
  return 'unknown error'
}
