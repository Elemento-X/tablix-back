/**
 * Singleton do container Postgres efêmero para testes de integração.
 *
 * **Design:** um único container por `vitest run` (iniciado pelo globalSetup,
 * encerrado no teardown). Container é efêmero — `withReuse(false)` é o default
 * correto para garantir isolamento entre execuções de CI. O schema snapshot
 * (`tests/fixtures/schema.sql`) é aplicado via `client.query()` pós-start do
 * container (não via initScript do Testcontainers) para termos controle
 * explícito sobre erros de aplicação e ordem de execução.
 *
 * **Versão:** `postgres:17-alpine` casa com a produção (Supabase roda PG 17.6
 * em 2026-04, validado via MCP).
 *
 * **Sinais:** handlers para SIGINT/SIGTERM garantem parada do container
 * mesmo se o processo for abortado (CTRL+C). Sem isso, vaza container em
 * dev se um teste trava.
 *
 * **TZ UTC:** container sobe com `TZ=UTC` e `PGTZ=UTC` para eliminar
 * dependência de timezone local (dev em São Paulo, CI em UTC, produção
 * em UTC — testes devem ser determinísticos independente disso).
 *
 * @owner: @tester
 * @card: 3.1b
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'

// Digest-pin garante que tag flutuante (`17-alpine`) não reescreva o
// schema introspectado silenciosamente entre runs. Digest obtido via
// `docker inspect postgres:17-alpine` em 2026-04-24. Casa com Supabase
// PG 17.6 em prod (validado via MCP). Bump manual quando Supabase migrar
// minor + regeneração do fingerprint.
const POSTGRES_IMAGE =
  'postgres:17-alpine@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609'
const SCHEMA_SQL_PATH = resolve(__dirname, '..', 'fixtures', 'schema.sql')

let container: StartedPostgreSqlContainer | null = null
let signalHandlersInstalled = false

function installSignalHandlers() {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  const stop = async () => {
    if (container) {
      try {
        await container.stop({ timeout: 5_000 })
      } catch {
        /* best-effort — processo saindo */
      }
      container = null
    }
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

/**
 * Sobe o container e aplica o schema snapshot. Idempotente: chamadas
 * subsequentes retornam a URL existente (singleton por processo).
 */
export async function startPostgresContainer(): Promise<string> {
  if (container) {
    return container.getConnectionUri()
  }

  installSignalHandlers()

  if (!existsSync(SCHEMA_SQL_PATH)) {
    throw new Error(
      `Schema snapshot não encontrado em ${SCHEMA_SQL_PATH}. ` +
        `Regenere via MCP Supabase ou pg_dump --schema-only e rode ` +
        `"npm run test:schema:verify -- --update" para sincronizar o fingerprint.`,
    )
  }
  const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8')

  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('tablix_test')
    .withUsername('postgres')
    .withPassword('postgres')
    .withEnvironment({ TZ: 'UTC', PGTZ: 'UTC' })
    .withStartupTimeout(60_000)
    .start()

  const uri = container.getConnectionUri()

  const client = new Client({ connectionString: uri })
  await client.connect()
  try {
    await client.query(schemaSql)
  } finally {
    await client.end()
  }

  return uri
}

export async function stopPostgresContainer(): Promise<void> {
  if (!container) return
  try {
    await container.stop({ timeout: 10_000 })
  } finally {
    container = null
  }
}

export function getContainerUri(): string | null {
  return container?.getConnectionUri() ?? null
}
