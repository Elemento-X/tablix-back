/**
 * Unit tests para templates de email de alerta de quota — Card #147 (5.2c) F2.
 *
 * Cobre:
 *  - Renderização correta das variáveis (usagePercent, unificationsCount,
 *    limit, remaining, resetAtFormatted) em HTML e text fallback
 *  - Asserts que NÃO há inline `<script>` (defesa XSS — embora email clients
 *    sanitizem, padrão de defesa em profundidade)
 *  - Asserts de tom (não-alarmista, sem menção a "upgrade", sem emoji)
 *  - Text fallback fiel ao HTML (mesmas variáveis)
 *  - Comment HTML "Transactional email" presente (declaração LGPD/CASL)
 *
 * NÃO testa envio real via Resend (mockado em quota-alert-job.test.ts F3).
 *
 * @owner: @tester + @security
 * @card: #147 (5.2c) F2 — T-2.5
 */
import { describe, expect, it } from 'vitest'

import { __testing } from '../../src/lib/email'

const VALID_OPTS = {
  to: 'maclean@example.com',
  usagePercent: 75,
  unificationsCount: 22,
  limit: 30,
  remaining: 8,
  resetAtFormatted: '31/05/2026',
}

const CRITICAL_OPTS = {
  ...VALID_OPTS,
  usagePercent: 95,
  unificationsCount: 28,
  remaining: 2,
}

// ============================================
// Warning (70%) — HTML
// ============================================

describe('generateQuotaWarningEmailHtml', () => {
  const html = __testing.generateQuotaWarningEmailHtml(VALID_OPTS)

  it('contem usagePercent renderizado', () => {
    expect(html).toContain('75%')
  })

  it('contem unificationsCount renderizado', () => {
    expect(html).toContain('22 de 30')
  })

  it('contem remaining renderizado', () => {
    expect(html).toContain('8 unificacoes')
  })

  it('contem resetAtFormatted renderizado', () => {
    expect(html).toContain('31/05/2026')
  })

  it('contem CTA com FRONTEND_URL', () => {
    expect(html).toMatch(/href="https?:\/\/[^"]+"/)
    // Card #147 fix-pack ciclo 1 (@copywriter MÉDIO): CTA "Ver detalhes" →
    // "Ver meu uso" (mais específico, "meu" cria conexão pessoal).
    expect(html).toContain('Ver meu uso')
  })

  it('usa alert box amarelo (#fef3c7 + #f59e0b)', () => {
    expect(html).toContain('#fef3c7')
    expect(html).toContain('#f59e0b')
  })

  it('NAO contem inline script tag (defesa XSS)', () => {
    expect(html).not.toMatch(/<script\b/i)
  })

  it('NAO contem onload/onclick handlers (defesa XSS)', () => {
    expect(html).not.toMatch(/\bon\w+\s*=/i)
  })

  it('contem comment Transactional email (declaracao LGPD/CASL)', () => {
    expect(html).toContain('Transactional email')
  })

  it('NAO menciona upgrade ou plano superior', () => {
    expect(html.toLowerCase()).not.toContain('upgrade')
    expect(html.toLowerCase()).not.toContain('plano superior')
  })

  it('NAO usa emoji (identidade visual)', () => {
    // Coverage de emoji ranges comuns
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
    expect(html).not.toMatch(/[\u{2600}-\u{27BF}]/u)
  })

  it('header dark (#18181b) consistente com templates atuais', () => {
    expect(html).toContain('#18181b')
  })
})

// ============================================
// Warning (70%) — Text fallback
// ============================================

describe('generateQuotaWarningEmailText', () => {
  const text = __testing.generateQuotaWarningEmailText(VALID_OPTS)

  it('contem usagePercent', () => {
    expect(text).toContain('75%')
  })

  it('contem unificationsCount + limit', () => {
    expect(text).toContain('22 de 30')
  })

  it('contem remaining + resetAtFormatted', () => {
    expect(text).toContain('8 unificacoes')
    expect(text).toContain('31/05/2026')
  })

  it('contem footer Tablix', () => {
    expect(text).toContain('Tablix - Unifique suas planilhas com facilidade')
  })

  it('NAO contem tags HTML', () => {
    expect(text).not.toMatch(/<[a-z][^>]*>/i)
  })

  it('NAO menciona upgrade', () => {
    expect(text.toLowerCase()).not.toContain('upgrade')
  })
})

// ============================================
// Critical (90%) — HTML
// ============================================

describe('generateQuotaCriticalEmailHtml', () => {
  const html = __testing.generateQuotaCriticalEmailHtml(CRITICAL_OPTS)

  it('contem usagePercent renderizado (95%)', () => {
    expect(html).toContain('95%')
  })

  it('contem unificationsCount renderizado (28 de 30)', () => {
    expect(html).toContain('28 de 30')
  })

  it('contem remaining renderizado (apenas 2)', () => {
    expect(html).toContain('apenas 2 unificacoes')
  })

  it('contem resetAtFormatted renderizado 1x + "ate la" (fix-pack ciclo 1 @copywriter MÉDIO)', () => {
    // Card #147 fix-pack: removida repetição da data no alert box critical.
    // 2ª ocorrência substituída por "la" (anáfora) — menos cognitive load.
    const matches = html.match(/31\/05\/2026/g) ?? []
    expect(matches.length).toBe(1)
    expect(html).toContain('ficarao indisponiveis ate la')
  })

  it('usa alert box vermelho-claro (#fef2f2 + #dc2626)', () => {
    expect(html).toContain('#fef2f2')
    expect(html).toContain('#dc2626')
  })

  it('NAO usa header vermelho (vermelho e pra falha, este e alerta)', () => {
    // Header dark #18181b, NÃO #dc2626 no header
    const headerSection = html.split('Content')[0] ?? ''
    expect(headerSection).not.toMatch(/background-color:\s*#dc2626/i)
  })

  it('frase "ficarao indisponiveis" presente (literal, sem ameaça)', () => {
    expect(html).toContain('ficarao indisponiveis')
  })

  it('NAO contem inline script tag (defesa XSS)', () => {
    expect(html).not.toMatch(/<script\b/i)
  })

  it('NAO contem onload/onclick handlers (defesa XSS)', () => {
    expect(html).not.toMatch(/\bon\w+\s*=/i)
  })

  it('contem comment Transactional email', () => {
    expect(html).toContain('Transactional email')
  })

  it('NAO menciona upgrade', () => {
    expect(html.toLowerCase()).not.toContain('upgrade')
  })

  it('NAO usa emoji', () => {
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
    expect(html).not.toMatch(/[\u{2600}-\u{27BF}]/u)
  })
})

// ============================================
// Critical (90%) — Text fallback
// ============================================

describe('generateQuotaCriticalEmailText', () => {
  const text = __testing.generateQuotaCriticalEmailText(CRITICAL_OPTS)

  it('contem usagePercent + count + remaining', () => {
    expect(text).toContain('95%')
    expect(text).toContain('28 de 30')
    expect(text).toContain('apenas 2 unificacoes')
  })

  it('contem resetAtFormatted 1x + "ate la" (fix-pack ciclo 1 @copywriter MÉDIO)', () => {
    // Card #147 fix-pack: text fallback espelha HTML — 1x + "la".
    const matches = text.match(/31\/05\/2026/g) ?? []
    expect(matches.length).toBe(1)
    expect(text).toContain('ficarao indisponiveis ate la')
  })

  it('NAO contem tags HTML', () => {
    expect(text).not.toMatch(/<[a-z][^>]*>/i)
  })

  it('contem footer Tablix', () => {
    expect(text).toContain('Tablix - Unifique suas planilhas com facilidade')
  })
})

// ============================================
// Paridade HTML <-> Text fallback
// ============================================

describe('paridade HTML <-> Text (warning)', () => {
  const html = __testing.generateQuotaWarningEmailHtml(VALID_OPTS)
  const text = __testing.generateQuotaWarningEmailText(VALID_OPTS)

  it('html e text contem usagePercent identico', () => {
    expect(html).toContain('75%')
    expect(text).toContain('75%')
  })

  it('html e text contem mesma resetAtFormatted', () => {
    expect(html).toContain('31/05/2026')
    expect(text).toContain('31/05/2026')
  })

  it('html e text contem mesma frase de unificacoes restantes', () => {
    expect(html).toContain('8 unificacoes')
    expect(text).toContain('8 unificacoes')
  })
})

describe('paridade HTML <-> Text (critical)', () => {
  const html = __testing.generateQuotaCriticalEmailHtml(CRITICAL_OPTS)
  const text = __testing.generateQuotaCriticalEmailText(CRITICAL_OPTS)

  it('html e text contem usagePercent identico', () => {
    expect(html).toContain('95%')
    expect(text).toContain('95%')
  })

  it('html e text contem frase "ficarao indisponiveis"', () => {
    expect(html).toContain('ficarao indisponiveis')
    expect(text).toContain('ficarao indisponiveis')
  })
})

// ============================================
// Edge cases
// ============================================

describe('edge cases de variáveis', () => {
  it('usagePercent zero renderiza (defesa contra divisao errada)', () => {
    const html = __testing.generateQuotaWarningEmailHtml({
      ...VALID_OPTS,
      usagePercent: 0,
      unificationsCount: 0,
      remaining: 30,
    })
    expect(html).toContain('0%')
  })

  it('remaining zero renderiza (limit atingido — mas e teorico, cron filtra)', () => {
    const html = __testing.generateQuotaCriticalEmailHtml({
      ...CRITICAL_OPTS,
      remaining: 0,
      usagePercent: 100,
    })
    expect(html).toContain('apenas 0 unificacoes')
  })

  it('resetAtFormatted com formato pt-BR longo', () => {
    const html = __testing.generateQuotaWarningEmailHtml({
      ...VALID_OPTS,
      resetAtFormatted: '01/06/2026',
    })
    expect(html).toContain('01/06/2026')
  })
})
