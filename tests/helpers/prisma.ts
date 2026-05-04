/**
 * Prisma helper para testes de INTEGRAÇÃO com DB REAL (Card 3.1b).
 *
 * Contrato:
 * - `getTestPrisma()` retorna singleton PrismaClient vinculado ao
 *   DATABASE_URL apontando para o container Postgres efêmero (setado pelo
 *   globalSetup em `tests/helpers/global-setup.ts`).
 * - `truncateAll()` limpa todas as tabelas do schema `public`
 *   (dinamicamente via information_schema — sem lista hardcoded que vira
 *   drift quando o schema evolui). Usa `RESTART IDENTITY CASCADE` para
 *   zerar sequences e respeitar FKs.
 * - `disconnectTestPrisma()` fecha a conexão — útil em `afterAll` por
 *   suíte pra evitar warnings de handle pendente no Vitest.
 *
 * **Guard:** se chamado fora de modo integração (ex: unit test importou
 * sem querer, ou rodou antes do globalSetup rodar), lança erro explícito.
 * Usa `TABLIX_TEST_MODE=integration` como sinal, setado pelo globalSetup.
 *
 * **Para unit tests:** continue usando `tests/helpers/prisma-mock.ts` —
 * nunca atinge banco, rápido, isolado.
 *
 * @owner: @tester
 * @card: 3.1b
 */
import { PrismaClient } from '@prisma/client'

let singleton: PrismaClient | null = null

function assertIntegrationMode() {
  if (process.env.TABLIX_TEST_MODE !== 'integration') {
    throw new Error(
      '[prisma-test-helper] Chamado fora de modo integração. ' +
        'Use "npm run test:integration" (carrega globalSetup) ou, em unit tests, ' +
        'importe createPrismaMock de tests/helpers/prisma-mock.ts.',
    )
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      '[prisma-test-helper] DATABASE_URL não setado. globalSetup deveria ter populado — verificar ordem de execução.',
    )
  }
}

export function getTestPrisma(): PrismaClient {
  assertIntegrationMode()
  if (!singleton) {
    singleton = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
      log: ['warn', 'error'],
    })
  }
  return singleton
}

// Identifiers Postgres aceitos em schema.public sem quoting especial.
// Vale a pena validar mesmo os rows vindo de `pg_tables` — é defesa em
// profundidade: se algum dia um migration criar tabela com nome estranho
// (acentos, aspas, null-byte), TRUNCATE com identifier não-sanitizado
// vira vetor de injection dentro do teste. Custo zero, segurança real.
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Trunca todas as tabelas base do schema `public` (exclui tabelas de
 * extensão, views, etc). Descoberta dinâmica — mesmo que schema evolua,
 * truncateAll continua correto sem manutenção manual.
 *
 * `RESTART IDENTITY` zera sequences; `CASCADE` respeita FKs truncando em
 * cadeia — importante porque users é referenciado por sessions/tokens/etc.
 */
export async function truncateAll(): Promise<void> {
  const prisma = getTestPrisma()
  // Query via pg_class em vez de pg_tables: relkind='r' exclui views/
  // foreign tables/partitions; regex `!~ '^_'` exclui tabelas internas de
  // ferramentas (ex: `_prisma_migrations`). Ambos filtros são defesa em
  // profundidade contra evolução futura do schema. Uso do regex operator
  // em vez de `LIKE ... ESCAPE` evita colisão do escape backslash com
  // o template literal do $queryRaw.
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname !~ '^_'
  `
  if (rows.length === 0) return
  const identifiers = rows
    .map((r) => {
      if (!SAFE_IDENTIFIER.test(r.tablename)) {
        throw new Error(
          `[truncateAll] Nome de tabela inesperado: ${JSON.stringify(r.tablename)}. ` +
            'Identifier não passou pela regex de segurança — aborta pra evitar injection.',
        )
      }
      return `"public"."${r.tablename}"`
    })
    .join(', ')
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`,
  )
}

/**
 * Fecha a conexão do singleton. Safe to call multiple times.
 */
export async function disconnectTestPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect()
    singleton = null
  }
}
