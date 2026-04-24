/**
 * Vitest globalSetup para a suíte de integração.
 *
 * Executado UMA vez por `vitest run` (antes de qualquer worker iniciar) e
 * recebe função de teardown que Vitest chama ao fim (mesmo em falha).
 *
 * **ANTI-PROD GUARD (crítico):** este setup sobe Postgres efêmero e reescreve
 * `process.env.DATABASE_URL` para apontar pra ele. Se por acidente for
 * executado num ambiente com credenciais reais, PODE destruir dados.
 *
 * Três camadas de proteção (delegadas a `safe-env-guard.ts`):
 * 1. Rejeita `NODE_ENV=production`.
 * 2. Allowlist-first: URL atual DEVE apontar pra host local conhecido
 *    (localhost, 127.x, ::1, host.docker.internal, RFC1918). Override
 *    explícito via `TABLIX_TEST_MODE_ALLOW_ANY_DB=true`.
 * 3. Blocklist extra de providers de prod (Supabase/Fly/Neon/Heroku/Azure/
 *    DO/PlanetScale/GCP/etc) — defesa em profundidade, não bypassável
 *    pelo override.
 *
 * @owner: @tester + @security
 * @card: 3.1b
 */
import { startPostgresContainer, stopPostgresContainer } from './testcontainers'
import { assertSafeEnvironment } from './safe-env-guard'

export default async function setup() {
  assertSafeEnvironment({ context: 'integration-setup' })

  const uri = await startPostgresContainer()

  // Prisma lê DATABASE_URL do process.env; setar aqui garante que qualquer
  // `new PrismaClient()` instanciado nos testes aponte pro container.
  process.env.DATABASE_URL = uri
  process.env.DIRECT_URL = uri
  // Marca que estamos em modo integração — helpers podem usar pra decidir
  // entre Prisma real vs mock.
  process.env.TABLIX_TEST_MODE = 'integration'

  return async function teardown() {
    await stopPostgresContainer()
    delete process.env.TABLIX_TEST_MODE
  }
}
