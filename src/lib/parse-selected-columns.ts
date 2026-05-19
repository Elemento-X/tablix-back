/**
 * Parse defensivo do campo `selectedColumns` vindo do multipart/form-data.
 *
 * Contexto — Card 1.16 (OWASP A03 / A04):
 *   O field chega como string crua. Antes era `JSON.parse(value)` direto no
 *   controller, sem tamanho máximo e sem validação de shape. 3 problemas reais:
 *
 *   1. DoS parse — atacante mandava campo multipart com 10MB de `[1,1,1,...]`
 *      (o cap global do @fastify/multipart protege upload de ARQUIVO, não
 *      tamanho de FIELD) e forçava o servidor a pagar CPU antes do Zod rodar.
 *
 *   2. Prototype pollution — Node 22 já mitiga `__proto__` em JSON.parse, mas
 *      defesa em profundidade manda validar shape IMEDIATAMENTE após parse,
 *      não confiar que o runtime do Node vai proteger pra sempre.
 *
 *   3. Fallback permissivo — quando o parse falhava, o código antigo fazia
 *      `selectedColumns.push(value)` aceitando string arbitrária sem validação
 *      de tamanho. Atacante mandava `selectedColumns=<8MB de 'A'>` e engatilhava
 *      alocação de memória upstream.
 *
 * Este helper isola o parse, aplica cap defensivo, valida shape com Zod e
 * retorna `string[]` validado OU lança `AppError` (validationError). A camada
 * 2 (Zod de `processSyncInputSchema`) continua rodando depois como defesa em
 * profundidade — mesmo input passa por 2 validações independentes.
 *
 * @owner: @security
 */
import { z } from 'zod'
import { Errors } from '../errors/app-error'

/**
 * Tamanho máximo do field cru, em **bytes reais** (UTF-8).
 *
 * Justificativa do valor: PRO_LIMITS.maxColumns = 15 colunas. Cada coluna tem
 * max 255 chars (regra do schema). Worst case JSON ASCII: `[` + 15 * (`"` + 255 + `",`) + `]`
 * ≈ 3.9KB. Cap de 8KB é 2x folga, suficiente pra BOM/unicode/spaces sem abrir
 * vetor real de DoS. Se alguém precisar mais, algo está errado no cliente.
 *
 * **IMPORTANTE: medido via `Buffer.byteLength(value, 'utf8')`, não `value.length`.**
 * Card 1.16 @security finding b7e4c1a92f03: `.length` é contagem de code units
 * UTF-16, então um emoji 4-byte UTF-8 conta como 2 code units — atacante
 * enviando 4000 emojis passa `.length < 8192` mas usa ~16KB reais. Byte count
 * fecha essa janela.
 *
 * NOTA: validar o tamanho ANTES do JSON.parse é crucial — parse já aloca e
 * é O(n). Rejeitar cedo protege CPU e RSS.
 */
export const MAX_SELECTED_COLUMNS_FIELD_BYTES = 8 * 1024 // 8 KB

/**
 * Tamanho máximo por nome de coluna, em chars.
 *
 * Justificativa: headers reais de planilhas raramente ultrapassam 100 chars.
 * 255 é o limite de VARCHAR clássico — confortável pra unicode PT-BR e nomes
 * compostos ("Quantidade de Itens Vendidos no Trimestre"). Acima disso é abuso.
 */
export const MAX_COLUMN_NAME_LENGTH = 255

/**
 * Regex que rejeita caracteres de controle perigosos em nome de coluna.
 *
 * Card 1.16 @security finding d1f0ab839e47: nomes de coluna podem vazar
 * caracteres invisíveis (zero-width joiner, BOM, RTL override) que bypassam
 * validação visual e confundem lookup downstream. Null byte (U+0000) e
 * line separators (U+2028/2029) também são vetores clássicos de injection
 * em log/filename/header.
 *
 * Rejeita:
 *   - U+0000–U+001F : null byte + ASCII control chars
 *   - U+007F        : DEL
 *   - U+0080–U+009F : C1 control chars
 *   - U+200B–U+200F : zero-width chars (ZWSP, ZWNJ, ZWJ, LRM, RLM)
 *   - U+2028/U+2029 : line/paragraph separator (quebra JSON.parse downstream)
 *   - U+202A–U+202E : bidi override (ataques de homograph)
 *   - U+FEFF        : BOM (já deveria ter sido strippado upstream, mas defense-in-depth)
 */
const FORBIDDEN_CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/

/**
 * Schema Zod interno do parse — mais estrito que o schema público
 * (`processSyncInputSchema`) em 2 aspectos: valida max length por coluna
 * e rejeita caracteres de controle/invisíveis.
 *
 * O schema público depende de PRO_LIMITS.maxColumns (quantidade), este aqui
 * complementa garantindo que cada ITEM é sensato.
 *
 * Shape obrigatório: array de strings não-vazias, cada uma com max 255 chars
 * e sem control chars. Qualquer objeto (prototype pollution, {__proto__:...},
 * {constructor:...}), null, number, boolean, undefined é rejeitado pelo
 * `z.array(z.string())`.
 */
const selectedColumnsShapeSchema = z
  .array(
    z
      .string()
      .min(1, 'Nome de coluna não pode ser vazio')
      .max(
        MAX_COLUMN_NAME_LENGTH,
        `Nome de coluna excede ${MAX_COLUMN_NAME_LENGTH} caracteres`,
      )
      .refine((s) => !FORBIDDEN_CONTROL_CHARS.test(s), {
        message: 'Nome de coluna contém caractere de controle proibido',
      }),
  )
  .min(1, 'selectedColumns não pode ser array vazio')

/**
 * Parse seguro do campo `selectedColumns` do multipart.
 *
 * Aceita 2 formatos de entrada (ordem de tentativa):
 *   1. JSON array de strings — formato canônico (`'["Nome","Email"]'`)
 *   2. String simples — fallback single-value (`'Nome'` → `['Nome']`)
 *
 * Regras:
 *   - Rejeita se `value.length > MAX_SELECTED_COLUMNS_FIELD_BYTES` (anti-DoS,
 *     checagem ANTES do parse).
 *   - Rejeita se o resultado não bate com `selectedColumnsShapeSchema`.
 *   - Rejeita prototype pollution payloads (`{__proto__:...}`, `{constructor:...}`)
 *     porque o shape exige `array`, não `object`.
 *   - Fallback single-value passa pelo mesmo cap e pela mesma validação de
 *     tamanho por coluna — atacante não consegue mandar single-value de 8MB.
 *
 * @throws AppError (validationError) quando value é malformado, grande demais
 *         ou shape inválido. Nunca retorna undefined.
 */
export function parseSelectedColumnsField(value: string): string[] {
  // Camada 1: cap de BYTES REAIS UTF-8 ANTES do parse (anti-DoS).
  // Card 1.16 @security finding b7e4c1a92f03: `value.length` mede code units
  // UTF-16, subestimando o tamanho real em UTF-8 (emoji 4-byte conta como 2).
  // Buffer.byteLength é a fonte da verdade — fecha amplificação 2x-4x.
  const byteSize = Buffer.byteLength(value, 'utf8')
  if (byteSize > MAX_SELECTED_COLUMNS_FIELD_BYTES) {
    throw Errors.validationError(
      `Campo selectedColumns excede ${MAX_SELECTED_COLUMNS_FIELD_BYTES} bytes`,
      {
        maxBytes: MAX_SELECTED_COLUMNS_FIELD_BYTES,
        receivedBytes: byteSize,
      },
    )
  }

  // Camada 2: tenta parse JSON. Se falhar, trata como single-value string.
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // Fallback single-value: a própria string vira `[value]`.
    // Ainda assim passa pelo shape validator abaixo, que rejeita se o nome
    // for vazio ou exceder MAX_COLUMN_NAME_LENGTH.
    parsed = [value]
  }

  // Camada 3: valida shape com Zod. Esta camada rejeita:
  //   - object literal (prototype pollution: {__proto__:...}, {constructor:...})
  //   - null, number, boolean
  //   - array com elementos não-string
  //   - array vazio
  //   - strings vazias ou longas demais
  const result = selectedColumnsShapeSchema.safeParse(parsed)
  if (!result.success) {
    throw Errors.validationError('selectedColumns tem formato inválido', {
      errors: result.error.flatten().formErrors,
    })
  }

  return result.data
}
