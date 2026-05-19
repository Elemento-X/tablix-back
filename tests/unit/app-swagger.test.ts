/**
 * Unit tests for Swagger UI environment gating (Card 1.18)
 *
 * Cobre:
 *   - swaggerUi só é registrado em dev/test, nunca em production
 *   - @fastify/swagger (spec gen) continua ativo em todos ambientes
 *   - Comentário explicativo do finding SEC.18 presente
 *   - Mutation guard: remover o if retornaria expose em prod
 *
 * Por que source-based test: buildApp() tem cadeia pesada (Prisma, redis,
 * rotas) que exigiria mock excessivo pra testar 1 comportamento binário.
 * Leitura estática do source é determinística e suficiente — mesmo padrão
 * do app-trust-proxy.test.ts.
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appSource = readFileSync(resolve('src/app.ts'), 'utf-8')

describe('Swagger UI gating — Card 1.18 (OWASP A05)', () => {
  it('swaggerUi registration is wrapped in NODE_ENV !== production guard', () => {
    // Regex tolerante a reformatação: captura o if seguido do register(swaggerUi)
    const pattern =
      /if\s*\(\s*env\.NODE_ENV\s*!==\s*['"]production['"]\s*\)\s*\{[\s\S]*?app\.register\(\s*swaggerUi/
    expect(appSource).toMatch(pattern)
  })

  it('swaggerUi is NOT registered unconditionally (mutation guard)', () => {
    // Se alguém remover o if mas deixar o register cru, este teste pega.
    // Conta ocorrências de `app.register(swaggerUi` — tem que ser exatamente 1,
    // E ela tem que estar dentro do bloco condicional (validado acima).
    const occurrences = appSource.match(/app\.register\(\s*swaggerUi/g)
    expect(occurrences).toHaveLength(1)

    // Extrai o contexto 200 chars antes do register pra garantir que o if
    // está imediatamente acima (não num bloco distante)
    const idx = appSource.indexOf('app.register(swaggerUi')
    const prelude = appSource.slice(Math.max(0, idx - 200), idx)
    expect(prelude).toMatch(/NODE_ENV\s*!==\s*['"]production['"]/)
  })

  it('@fastify/swagger (spec generator) continues registered unconditionally', () => {
    // O finding é só sobre o UI — o spec generator (swagger base) pode
    // continuar, porque ele só expõe rota se swaggerUi estiver registrado.
    // Em prod, sem swaggerUi, o spec fica acessível apenas via app.swagger().
    expect(appSource).toMatch(/app\.register\(\s*swagger\s*,/)
  })

  it('comment documents the SEC.18 rationale (docs not exposed in prod)', () => {
    // Evita refactor que remova o comentário sem contexto do porquê
    expect(appSource).toMatch(/Card 1\.18/)
    expect(appSource).toMatch(/OWASP A05/)
  })
})
