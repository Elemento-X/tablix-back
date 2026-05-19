/**
 * Anti-prod guard compartilhado entre globalSetup e scripts de dump/verify.
 *
 * Protege qualquer operação destrutiva (subir container + reescrever
 * DATABASE_URL, rodar TRUNCATE, aplicar migration de teste) de rodar acidental
 * contra banco de produção.
 *
 * **Modelo: allowlist-first.** Blocklist sozinha falha silenciosa se um
 * provider novo não estiver listado (Heroku, Azure, PlanetScale, etc). A
 * decisão correta é exigir que o host bata com um padrão LOCAL conhecido
 * (localhost, 127.0.0.1, ::1, host.docker.internal, IP privado RFC1918 ou
 * faixa Docker). Se não bater, rejeita — mesmo que o host seja desconhecido.
 *
 * **Escape hatch:** `TABLIX_TEST_MODE_ALLOW_ANY_DB=true` permite override
 * explícito (ex: dev que quer rodar contra um staging local com DNS custom).
 * Exige consciência — atacar a env var é opt-in ativo.
 *
 * **Blocklist extra:** mesmo com a allowlist, mantemos blocklist de hosts de
 * produção conhecidos como defesa em profundidade. Se um dia a allowlist
 * tiver bug (ex: regex de RFC1918 quebrar) e alguém passar um host de prod,
 * a blocklist pega em segunda camada.
 *
 * @owner: @tester + @security
 * @card: 3.1b — Fase 1
 */

/**
 * Padrões de host considerados seguros para testes.
 * URL deve casar com um destes para ser aceita (a menos que
 * TABLIX_TEST_MODE_ALLOW_ANY_DB=true).
 *
 * Inclui:
 * - localhost, 127.0.0.1, ::1 (loopback)
 * - host.docker.internal (Docker Desktop)
 * - 0.0.0.0 (bind-all, usado por Testcontainers em alguns modos)
 * - RFC1918 (10.x, 172.16-31.x, 192.168.x) — redes privadas
 * - link-local IPv4 (169.254.x) e IPv6 (fe80::)
 * - CGNAT/shared address space (100.64.x — usado por Docker networks em alguns setups)
 */
export const LOCAL_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127(\.\d{1,3}){3}$/,
  /^::1$/,
  /^\[::1\]$/,
  /^host\.docker\.internal$/i,
  /^0\.0\.0\.0$/,
  // RFC1918 — 10.0.0.0/8
  /^10(\.\d{1,3}){3}$/,
  // RFC1918 — 172.16.0.0/12
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/,
  // RFC1918 — 192.168.0.0/16
  /^192\.168(\.\d{1,3}){2}$/,
  // Link-local IPv4 — 169.254.0.0/16
  /^169\.254(\.\d{1,3}){2}$/,
  // Link-local IPv6
  /^\[?fe80:/i,
  // CGNAT — 100.64.0.0/10
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d{1,3}){2}$/,
]

/**
 * Blocklist extra de hosts de produção conhecidos — defesa em profundidade.
 * A allowlist já rejeita o que não é local, mas esta lista existe para
 * gerar mensagem de erro mais clara ("parece $provider") e proteger contra
 * bug eventual na allowlist.
 */
export const PROD_URL_PATTERNS: readonly RegExp[] = [
  // Supabase
  /\.supabase\.co/i,
  /\.supabase\.com/i,
  /\.pooler\.supabase\./i,
  // Fly.io
  /\.fly\.dev/i,
  // AWS (RDS, Aurora, ElastiCache)
  /\.rds\.amazonaws\.com/i,
  /amazonaws\.com/i,
  // Neon
  /\.neon\.tech/i,
  // Render
  /\.render\.com/i,
  // Heroku
  /\.compute-\d+\.amazonaws\.com/i,
  /\.herokuapp\.com/i,
  /\.heroku(db|postgres)\./i,
  // DigitalOcean Managed Databases
  /\.ondigitalocean\.app/i,
  /\.db\.ondigitalocean\.com/i,
  // Azure Database for PostgreSQL
  /\.postgres\.database\.azure\.com/i,
  /\.database\.windows\.net/i,
  // Google Cloud SQL
  /\.cloudsql\.googleapis\.com/i,
  /\.c\.[a-z0-9-]+\.internal/i,
  // Upstash (Redis, normalmente — mas cobrir por precaução se virar Postgres)
  /\.upstash\.io/i,
  // PlanetScale
  /\.psdb\.cloud/i,
  /\.connect\.psdb\.cloud/i,
  // Aiven
  /\.aivencloud\.com/i,
  // Railway
  /\.railway\.app/i,
  /\.proxy\.rlwy\.net/i,
  // Crunchy Bridge
  /\.postgresbridge\.com/i,
  // Timescale Cloud
  /\.tsdb\.cloud\.timescale\.com/i,
]

export class UnsafeTestEnvironmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTestEnvironmentError'
  }
}

function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url)
    // Remove brackets do IPv6 literal em URL (pg driver aceita sem bracket)
    return parsed.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOST_PATTERNS.some((p) => p.test(hostname))
}

function matchProdPattern(url: string): RegExp | null {
  for (const pattern of PROD_URL_PATTERNS) {
    if (pattern.test(url)) return pattern
  }
  return null
}

export interface AssertSafeOptions {
  /**
   * Nome do contexto para mensagens de erro (ex: "integration-setup", "schema-dump").
   */
  context: string
  /**
   * Env vars que serão inspecionadas. Default: ['DATABASE_URL'].
   * Scripts de dump podem adicionar SCHEMA_DUMP_URL.
   */
  urlEnvVars?: readonly string[]
  /**
   * Override do process.env (útil para testes). Default: process.env.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * Valida ambiente antes de operação destrutiva de teste.
 *
 * Ordem de verificação:
 * 1. `NODE_ENV === 'production'` → rejeita.
 * 2. Para cada URL fornecida: se setada, valida allowlist primeiro, blocklist depois.
 * 3. Se `TABLIX_TEST_MODE_ALLOW_ANY_DB === 'true'`, pula allowlist (mas mantém
 *    NODE_ENV e blocklist — override não libera tudo).
 *
 * @throws UnsafeTestEnvironmentError
 */
export function assertSafeEnvironment(options: AssertSafeOptions): void {
  const { context, urlEnvVars = ['DATABASE_URL'], env = process.env } = options

  if (env.NODE_ENV === 'production') {
    throw new UnsafeTestEnvironmentError(
      `[${context}] RECUSADO: NODE_ENV=production. ` +
        'Operações de teste JAMAIS devem rodar contra produção.',
    )
  }

  const allowAny = env.TABLIX_TEST_MODE_ALLOW_ANY_DB === 'true'

  for (const envVar of urlEnvVars) {
    const url = env[envVar]
    if (!url) continue

    // Blocklist roda sempre, mesmo com allowAny — providers de prod conhecidos
    // são rejeitados mesmo sob override, pra não criar foot-gun.
    const prodMatch = matchProdPattern(url)
    if (prodMatch) {
      throw new UnsafeTestEnvironmentError(
        `[${context}] RECUSADO: ${envVar} casa com padrão de produção (${prodMatch}). ` +
          'Mesmo com TABLIX_TEST_MODE_ALLOW_ANY_DB=true, providers de prod conhecidos são bloqueados. ' +
          'Desconecte a env var antes de rodar.',
      )
    }

    if (allowAny) continue

    const hostname = extractHostname(url)
    if (!hostname) {
      throw new UnsafeTestEnvironmentError(
        `[${context}] RECUSADO: ${envVar} não é uma URL válida.`,
      )
    }

    if (!isLocalHost(hostname)) {
      throw new UnsafeTestEnvironmentError(
        `[${context}] RECUSADO: ${envVar} aponta para host "${hostname}" que não é local. ` +
          'Allowlist permite apenas localhost, 127.x, ::1, host.docker.internal, RFC1918 e faixas equivalentes. ' +
          'Se for um ambiente seguro customizado, exporte TABLIX_TEST_MODE_ALLOW_ANY_DB=true para override explícito.',
      )
    }
  }
}
