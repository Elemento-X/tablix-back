// ===========================================
// TABLIX - SANITIZACAO DE CELULAS (CSV Injection / CWE-1236)
// ===========================================
// Previne formula injection em arquivos CSV/XLSX.
// Celulas que comecam com caracteres de formula sao prefixadas
// com apostrofo (') para que Excel/Sheets interpretem como texto.
//
// Ref: https://owasp.org/www-community/attacks/CSV_Injection

/**
 * Caracteres que disparam interpretacao de formula em Excel/Sheets.
 * '=' formula direta, '+'/'-' formula com sinal, '@' funcao,
 * '\t'/'\r'/'\n' bypass de prefixo via whitespace.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r', '\n']

/**
 * Sanitiza uma celula para prevenir formula injection.
 * Se o valor comecar com caractere de formula, prefixar com apostrofo.
 * Valores nao-string passam direto (numeros, booleans, null).
 */
export function sanitizeCell(
  value: string | number | boolean | null,
): string | number | boolean | null {
  if (typeof value !== 'string') return value
  if (value.length === 0) return value

  if (FORMULA_PREFIXES.includes(value[0])) {
    return `'${value}`
  }

  return value
}

/**
 * Sanitiza um array de headers.
 */
export function sanitizeHeaders(headers: string[]): string[] {
  return headers.map((h) => {
    const sanitized = sanitizeCell(h)
    return typeof sanitized === 'string' ? sanitized : h
  })
}
