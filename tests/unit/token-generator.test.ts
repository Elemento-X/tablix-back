/**
 * Unit tests for token-generator (Card 3.2 #31 — checklist item 2).
 *
 * Token Pro é a credencial de alto-privilégio do sistema — portão de acesso
 * ao plano pago. Security rule exige mínimo 256 bits de entropia via
 * `crypto.randomBytes`, prefixo estável e formato base64url. Qualquer
 * regressão aqui é finding CRÍTICO.
 *
 * Cobertura:
 *   - generateProToken: prefixo, comprimento, charset, unicidade em batch
 *   - isValidTokenFormat: aceita tokens legítimos, rejeita variações
 *   - getTokenInfo: shape estável, consistência com isValidTokenFormat
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import {
  generateProToken,
  isValidTokenFormat,
  getTokenInfo,
} from '../../src/lib/token-generator'

// 32 bytes em base64url = 43 chars (sem padding). Valor determinístico pelo
// math; se o TOKEN_BYTES mudar, o teste pega.
const EXPECTED_RANDOM_PART_LENGTH = 43
const EXPECTED_TOTAL_LENGTH = 'tbx_pro_'.length + EXPECTED_RANDOM_PART_LENGTH

describe('generateProToken', () => {
  it('retorna token com prefixo tbx_pro_', () => {
    const token = generateProToken()
    expect(token.startsWith('tbx_pro_')).toBe(true)
  })

  it('retorna token com comprimento total de 51 chars (8 prefix + 43 random)', () => {
    const token = generateProToken()
    expect(token).toHaveLength(EXPECTED_TOTAL_LENGTH)
  })

  it('parte aleatória tem 43 chars (32 bytes em base64url sem padding)', () => {
    const token = generateProToken()
    const randomPart = token.slice('tbx_pro_'.length)
    expect(randomPart).toHaveLength(EXPECTED_RANDOM_PART_LENGTH)
  })

  it('parte aleatória usa apenas charset base64url (A-Z a-z 0-9 - _)', () => {
    // Repete várias vezes pra aumentar prob de pegar char fora do charset
    // se crypto.randomBytes for substituído acidentalmente.
    for (let i = 0; i < 100; i++) {
      const token = generateProToken()
      const randomPart = token.slice('tbx_pro_'.length)
      expect(randomPart).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('nunca contém "+" ou "/" ou "=" (padding/symbols do base64 padrão)', () => {
    // base64url ≠ base64. Se acidentalmente alguém trocar toString('base64url')
    // por toString('base64'), vão aparecer + / e =. Guard explícito.
    for (let i = 0; i < 50; i++) {
      const token = generateProToken()
      expect(token).not.toMatch(/[+/=]/)
    }
  })

  it('gera 1000 tokens sem nenhuma colisão (256 bits de entropia)', () => {
    const tokens = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      tokens.add(generateProToken())
    }
    expect(tokens.size).toBe(1000)
  })

  it('dois tokens gerados em sequência são sempre diferentes', () => {
    const a = generateProToken()
    const b = generateProToken()
    expect(a).not.toBe(b)
  })

  it('cada token gerado satisfaz isValidTokenFormat', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateProToken()
      expect(isValidTokenFormat(token)).toBe(true)
    }
  })

  it('distribuição de bytes é uniforme (monobit smoke — entropia real)', () => {
    // Concatena parte aleatória de 100 tokens e conta chars únicos.
    // Em 100×43 = 4300 chars aleatórios de alfabeto 64, charset observado
    // deve ser ~64 (esperado) com altíssima probabilidade. Se cair pra < 30,
    // é sinal de randomBytes degradado ou trocado por algo determinístico.
    const chars = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const randomPart = generateProToken().slice('tbx_pro_'.length)
      for (const c of randomPart) chars.add(c)
    }
    expect(chars.size).toBeGreaterThan(50)
  })
})

describe('isValidTokenFormat', () => {
  it('aceita token gerado pelo próprio generator', () => {
    const token = generateProToken()
    expect(isValidTokenFormat(token)).toBe(true)
  })

  it('aceita token com parte aleatória de exatamente 43 chars', () => {
    const t = 'tbx_pro_' + 'A'.repeat(43)
    expect(isValidTokenFormat(t)).toBe(true)
  })

  it('aceita token com parte aleatória mais longa (> 43 chars)', () => {
    // Implementação checa `length < 43`; maior é permitido.
    const t = 'tbx_pro_' + 'A'.repeat(100)
    expect(isValidTokenFormat(t)).toBe(true)
  })

  it('rejeita token sem prefixo tbx_pro_', () => {
    const t = 'wrong_prefix_' + 'A'.repeat(43)
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita string vazia', () => {
    expect(isValidTokenFormat('')).toBe(false)
  })

  it('rejeita só o prefixo sem parte aleatória', () => {
    expect(isValidTokenFormat('tbx_pro_')).toBe(false)
  })

  it('rejeita parte aleatória curta (< 43 chars)', () => {
    const t = 'tbx_pro_' + 'A'.repeat(42)
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita parte aleatória com "+" (base64 padrão, não base64url)', () => {
    const t = 'tbx_pro_' + 'A'.repeat(40) + '+AB'
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita parte aleatória com "/" (base64 padrão)', () => {
    const t = 'tbx_pro_' + 'A'.repeat(40) + '/AB'
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita parte aleatória com "=" (padding base64)', () => {
    const t = 'tbx_pro_' + 'A'.repeat(40) + '=AB'
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita parte aleatória com espaço', () => {
    const t = 'tbx_pro_' + 'A'.repeat(40) + ' AB'
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('rejeita parte aleatória com caractere unicode', () => {
    const t = 'tbx_pro_' + 'A'.repeat(40) + 'ção'
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('prefixo case-sensitive: rejeita TBX_PRO_', () => {
    const t = 'TBX_PRO_' + 'A'.repeat(43)
    expect(isValidTokenFormat(t)).toBe(false)
  })

  it('prefixo estrito: rejeita prefixo parcial "tbx_pr"', () => {
    const t = 'tbx_pr' + 'A'.repeat(43)
    expect(isValidTokenFormat(t)).toBe(false)
  })
})

describe('getTokenInfo', () => {
  it('retorna shape { prefix, length, valid } para token válido', () => {
    const token = generateProToken()
    const info = getTokenInfo(token)
    expect(info).toEqual({
      prefix: 'tbx_pro_',
      length: EXPECTED_TOTAL_LENGTH,
      valid: true,
    })
  })

  it('prefix é sempre os primeiros 8 chars (independente do token ser válido)', () => {
    const info = getTokenInfo('garbage_total')
    expect(info.prefix).toBe('garbage_')
  })

  it('length reflete o comprimento total da string', () => {
    const info = getTokenInfo('short')
    expect(info.length).toBe(5)
  })

  it('valid=false quando token não tem prefixo correto', () => {
    const info = getTokenInfo('wrong_prefix_' + 'A'.repeat(43))
    expect(info.valid).toBe(false)
  })

  it('valid=false para string curta (prefix slice não quebra)', () => {
    const info = getTokenInfo('abc')
    expect(info.valid).toBe(false)
    expect(info.prefix).toBe('abc') // slice(0, 8) de 'abc' = 'abc'
    expect(info.length).toBe(3)
  })

  it('valid=false para empty string', () => {
    const info = getTokenInfo('')
    expect(info.valid).toBe(false)
    expect(info.prefix).toBe('')
    expect(info.length).toBe(0)
  })

  it('consistência: getTokenInfo.valid === isValidTokenFormat(token)', () => {
    const cases = [
      generateProToken(),
      'tbx_pro_',
      'wrong_prefix_' + 'A'.repeat(43),
      'tbx_pro_' + 'A'.repeat(43),
      'tbx_pro_' + 'A'.repeat(42),
      '',
    ]
    for (const t of cases) {
      expect(getTokenInfo(t).valid).toBe(isValidTokenFormat(t))
    }
  })
})
