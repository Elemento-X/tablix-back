/**
 * Unit tests — worker.ts dark-launch IDLE-BLOCK (Card #216 / gate 7.5).
 *
 * Contexto: antes do #216, com `ASYNC_PROCESSING_ENABLED=false` o worker
 * fazia `return` (event loop esvaziava → processo saía 0). No Fly, a máquina
 * do process group worker nunca atingia "started" → `fly deploy` dava timeout
 * e marcava o release como failed. O fix faz o worker ficar IDLE: setInterval
 * SEM unref (segura o event loop → "started") + handler SIGTERM/SIGINT pra
 * encerrar limpo em deploy/scale.
 *
 * Por que source-based (mesmo padrão de app-swagger.test.ts /
 * app-trust-proxy.test.ts): `worker.ts` executa `start().catch(...)` como
 * side-effect no import e NÃO exporta `start`. Um teste comportamental
 * importaria o módulo e dispararia o worker real (timers, signal handlers,
 * conexões) — exigiria refactor de produção (exportar `start`) que o @tester
 * não faz. A leitura estática do source é determinística, hermética e guarda
 * exatamente a mutação que reintroduziria o bug (voltar pro `return`/exit 0).
 *
 * O gap de teste COMPORTAMENTAL do entrypoint do worker está reportado como
 * finding `worker-entrypoint-untestable` (architecture-violation, MÉDIO).
 *
 * @owner: @tester
 * @card: #216
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workerSource = readFileSync(resolve('src/worker.ts'), 'utf-8')

// Extrai o corpo do bloco idle: do `if (!env.ASYNC_PROCESSING_ENABLED) {`
// até a primeira statement do caminho ativo (`const redisUrl = env.REDIS_URL`),
// que marca o fim do bloco idle. Bound robusto: não corta no `return` interno
// do `idleShutdown` (if (idleShuttingDown) return). Garante que as asserções
// avaliam o bloco idle inteiro, não setInterval/handlers do caminho ativo.
function extractIdleBlock(): string {
  const start = workerSource.indexOf('if (!env.ASYNC_PROCESSING_ENABLED)')
  expect(start).toBeGreaterThan(-1)
  const end = workerSource.indexOf('const redisUrl = env.REDIS_URL', start)
  expect(end).toBeGreaterThan(start)
  return workerSource.slice(start, end)
}

describe('worker.ts — dark-launch IDLE-BLOCK (Card #216)', () => {
  it('com flag off NÃO sai imediatamente: mantém o event loop vivo via setInterval', () => {
    const idle = extractIdleBlock()
    // setInterval segura o event loop → máquina "started" no Fly.
    expect(idle).toMatch(/setInterval\s*\(/)
  })

  it('o setInterval do idle NÃO é unref (unref deixaria o loop esvaziar e sair)', () => {
    const idle = extractIdleBlock()
    // Mutation guard: se alguém adicionar `.unref()` ao idleTimer, o processo
    // volta a sair sozinho e o bug do `fly deploy` timeout retorna.
    expect(idle).not.toMatch(/idleTimer\s*\.unref\s*\(/)
    expect(idle).not.toMatch(/setInterval\s*\([^)]*\)\s*\.unref/)
  })

  it('registra handler de SIGTERM e SIGINT no caminho idle', () => {
    const idle = extractIdleBlock()
    expect(idle).toMatch(/SIGTERM/)
    expect(idle).toMatch(/SIGINT/)
    expect(idle).toMatch(/process\.on\(/)
  })

  it('o idle shutdown encerra limpo (clearInterval + process.exit(0))', () => {
    const idle = extractIdleBlock()
    expect(idle).toMatch(/clearInterval\s*\(\s*idleTimer\s*\)/)
    expect(idle).toMatch(/process\.exit\(0\)/)
  })

  it('o bloco idle não faz `return` antes de armar timer + handlers (mutation guard)', () => {
    // Reintroduzir o bug seria trocar todo o corpo por um `return` cru logo
    // após o warn. Garantimos que setInterval e process.on aparecem no bloco.
    const idle = extractIdleBlock()
    expect(idle).toMatch(/setInterval/)
    expect(idle).toMatch(/process\.on\(/)
    // E o `return` final aparece DEPOIS do registro dos handlers (ordem correta).
    const handlerIdx = idle.indexOf('process.on(')
    const returnIdx = idle.lastIndexOf('return')
    expect(returnIdx).toBeGreaterThan(handlerIdx)
  })

  it('documenta o racional do IDLE (deploy robusto no Fly) — guarda contra refactor cego', () => {
    const idle = extractIdleBlock()
    expect(idle).toMatch(/metric:\s*'worker\.idle'/)
    expect(workerSource).toMatch(/Card #216|gate 7\.5/)
  })
})
