/**
 * Prisma helper para testes de integração com DB REAL.
 *
 * STATUS: STUB — bloqueado até Card 3.1b (Testcontainers + Postgres efêmero).
 *
 * O plano (Card 3.1b):
 * - Usar `@testcontainers/postgresql` para subir Postgres 17 em container efêmero
 *   por suíte (não por teste — custo de startup é alto).
 * - Aplicar migrations com `prisma migrate deploy` apontando para o DATABASE_URL
 *   do container.
 * - Expor `getTestPrisma()` que retorna um PrismaClient vinculado ao container
 *   atual, e `truncateAll()` para reset rápido entre testes da mesma suíte.
 * - `beforeAll` sobe o container e aplica schema; `afterAll` derruba.
 * - Pré-requisito: Docker Desktop instalado e rodando na máquina do dev + no CI.
 *
 * Até lá, testes de integração que dependam de Prisma REAL devem ser marcados
 * com `describe.skip` ou gated por env flag. Unit tests continuam usando
 * `tests/helpers/prisma-mock.ts` (vi.fn por método), que NÃO atinge banco.
 *
 * Referências:
 * - Card #30 (3.1a): scaffold sem Docker, esta stub
 * - Card 3.1b: Testcontainers setup (bloqueado até Docker ser instalado)
 * - Card 3.3 (#32): testes de integração consomem este helper
 *
 * @owner: @tester
 */

const CARD_3_1B_MSG = [
  'tests/helpers/prisma.ts é um STUB.',
  'Integração com DB real exige Testcontainers — ver Card 3.1b.',
  'Pré-requisito: Docker Desktop instalado e rodando.',
  'Até lá, use tests/helpers/prisma-mock.ts (createPrismaMock) em unit tests.',
].join(' ')

/**
 * Lança erro explícito para qualquer teste que importar este helper antes do
 * Card 3.1b estar pronto. Fail-loud é melhor que fail-silent com mock acidental.
 */
export function getTestPrisma(): never {
  throw new Error(CARD_3_1B_MSG)
}

export function truncateAll(): never {
  throw new Error(CARD_3_1B_MSG)
}

export function setupTestDatabase(): never {
  throw new Error(CARD_3_1B_MSG)
}

export function teardownTestDatabase(): never {
  throw new Error(CARD_3_1B_MSG)
}
