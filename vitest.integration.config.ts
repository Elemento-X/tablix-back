import { defineConfig } from 'vitest/config'

/**
 * Vitest config — SUÍTE DE INTEGRAÇÃO (Card 3.1b, Testcontainers).
 *
 * Rodar via: `npm run test:integration`.
 *
 * **Separação de suítes:** integration tests vivem em config próprio para
 * (1) isolar o `globalSetup` (sobe Postgres efêmero via Testcontainers — é
 * custoso; unit tests não devem pagar esse custo) e (2) permitir timeouts
 * mais generosos sem afrouxar unit tests.
 *
 * **globalSetup:** `tests/helpers/global-setup.ts` sobe o container uma
 * vez por execução (Vitest chama `setup` antes de qualquer worker iniciar
 * e `teardown` ao fim). Container efêmero — `--rm` equivalente. Migrations
 * aplicadas a partir de `tests/fixtures/schema.sql` (snapshot de prod).
 *
 * **single-thread:** integration tests usam banco compartilhado. Rodar em
 * paralelo geraria race em truncateAll entre suítes. `singleFork` evita
 * isso e ainda isola de testes unit (sem vazar estado de Prisma).
 *
 * **Timeouts:** 60s test / 90s hook. Subida de container pode levar 5-15s
 * no primeiro `beforeAll`; migrations adicionam ~2-5s. Folga suficiente
 * sem esconder test smells (test unit que demora 60s é bug).
 *
 * **Coverage:** desabilitado nesta suíte. Coverage é medido no unit
 * (vitest.config.ts). Rodar coverage em integration infla números sem
 * validar comportamento de unidade; `test:coverage` continua apontando só
 * pro config default.
 *
 * @owner: @tester
 * @card: 3.1b
 */
export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules', 'dist'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
})
