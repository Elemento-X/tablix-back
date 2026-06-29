/**
 * Unit tests for PROCESS_RATE_LIMIT_PER_MIN (Card 7.5 / R-8).
 *
 * O limiter `process` (POST /process/sync, GET /process/download) teve seu teto
 * tornado configurável por env var pra o load test 7.5 afrouxar SÓ em staging.
 * Default 10 = comportamento de PRODUÇÃO (inalterado).
 *
 *   PROCESS_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1000).default(10)
 *
 * Estratégia (anti-mutação, diferente do env-validation.test.ts):
 *   env.ts está EXCLUÍDO da coverage e o schema NÃO é exportado. A réplica usada
 *   em env-validation.test.ts não pega mutação no arquivo real (mudar o default
 *   de 10 pra 50 em env.ts passaria batido na réplica). Aqui importamos o MÓDULO
 *   REAL `src/config/env.ts` com process.env controlado, então qualquer mutação
 *   no campo (default/min/max/int/coerce) quebra estes testes.
 *
 * Determinismo:
 *   - `vi.mock('dotenv/config')` neutraliza a leitura do .env do dev (senão o
 *     valor real do .env contaminaria os casos de default/coerção).
 *   - process.env é substituído por um objeto mínimo e válido por caso, e
 *     restaurado no afterEach. Sem timers, sem random, sem I/O.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Neutraliza o side-effect de `import 'dotenv/config'` no topo de env.ts.
// Sem isso, dotenv repovoaria PROCESS_RATE_LIMIT_PER_MIN / DATABASE_URL a partir
// do .env do dev e os casos de default/coerção virariam não-determinísticos.
vi.mock('dotenv/config', () => ({}))

// Base mínima e VÁLIDA pra env.ts parsear em NODE_ENV=test (isProd=false):
// só DATABASE_URL (url) e JWT_SECRET (>=32, sem placeholder) são exigidos.
// JWT real (44 chars, sem nenhum dos placeholders rejeitados, incluindo
// FAKE_TEST_KEY que o env.ts REAL bloqueia — por isso não reusamos o env-stub).
const BASE_VALID_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
  JWT_SECRET: 'a]3kF9#mP!qR7$vX2&wZ5^cB8(dG0+hJ4*lN6-oS1@tU',
} as const

// Base COMPLETA e válida pra NODE_ENV=production: satisfaz TODOS os outros guards
// do superRefine (Stripe, Redis REST, 6 price IDs, RESEND, SENTRY_DSN no formato
// do regex, FRONTEND_URL https, SUPABASE_* no formato). Sem isso, um boot que
// falha por OUTRA var passaria por engano nos testes do guard PROCESS_RATE_LIMIT.
// O "controle positivo" (prod + 10 → passa) prova que esta base está limpa, então
// qualquer falha subsequente é atribuível EXCLUSIVAMENTE ao nosso path.
const BASE_VALID_PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://fake:fake@db.example.com:5432/fakedb',
  JWT_SECRET: 'a]3kF9#mP!qR7$vX2&wZ5^cB8(dG0+hJ4*lN6-oS1@tU',
  STRIPE_SECRET_KEY: 'sk_live_fake_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake_secret',
  UPSTASH_REDIS_REST_URL: 'https://fake-rest.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'fake_rest_token',
  STRIPE_PRO_MONTHLY_BRL_PRICE_ID: 'price_brl_m',
  STRIPE_PRO_YEARLY_BRL_PRICE_ID: 'price_brl_y',
  STRIPE_PRO_MONTHLY_USD_PRICE_ID: 'price_usd_m',
  STRIPE_PRO_YEARLY_USD_PRICE_ID: 'price_usd_y',
  STRIPE_PRO_MONTHLY_EUR_PRICE_ID: 'price_eur_m',
  STRIPE_PRO_YEARLY_EUR_PRICE_ID: 'price_eur_y',
  RESEND_API_KEY: 're_fake_api_key',
  SENTRY_DSN: 'https://abc123def456@o123456.ingest.us.sentry.io/1234567',
  FRONTEND_URL: 'https://app.tablix.com.br',
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_STORAGE_KEY: 'fake_storage_key',
  SUPABASE_STORAGE_BUCKET: 'tablix-uploads',
} as const

let envSnapshot: NodeJS.ProcessEnv

beforeEach(() => {
  envSnapshot = process.env
})

afterEach(() => {
  process.env = envSnapshot
  vi.resetModules()
  vi.restoreAllMocks()
})

/**
 * Importa o env.ts REAL com um process.env limpo + overrides, e devolve o `env`
 * resolvido. Lança (rejeita) se o boot falhar — capturamos o stderr pra afirmar
 * QUAL var causou a falha (não basta "lançou": precisa ser a NOSSA var).
 */
async function loadRealEnv(
  override: Record<string, string | undefined>,
  base: Record<string, string> = BASE_VALID_ENV,
): Promise<{
  value: number
  rawType: string
}> {
  const next: NodeJS.ProcessEnv = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  process.env = next
  vi.resetModules()
  const mod = await import('../../src/config/env')
  return {
    value: mod.env.PROCESS_RATE_LIMIT_PER_MIN,
    rawType: typeof mod.env.PROCESS_RATE_LIMIT_PER_MIN,
  }
}

/**
 * Igual a loadRealEnv mas espera FALHA de boot. Retorna o stderr capturado
 * (lista de `path: message`) pra afirmar que a var culpada foi a nossa.
 */
async function expectBootFailure(
  override: Record<string, string | undefined>,
  base: Record<string, string> = BASE_VALID_ENV,
): Promise<string> {
  const next: NodeJS.ProcessEnv = { ...base }
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  process.env = next
  vi.resetModules()

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  let threw = false
  try {
    await import('../../src/config/env')
  } catch (err) {
    threw = true
    expect((err as Error).message).toContain('Invalid environment variables')
  }
  expect(threw).toBe(true)
  // Junta tudo que foi pro stderr no boot (path + message, sem valores — Card #72)
  const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
  return stderr
}

describe('PROCESS_RATE_LIMIT_PER_MIN (Card 7.5 / R-8) — schema REAL de env.ts', () => {
  // ---------------------------------------------------------------------------
  // Default — preserva o comportamento de produção (10/min)
  // ---------------------------------------------------------------------------
  describe('default', () => {
    it('deve resolver 10 quando a var está AUSENTE (paridade com produção)', async () => {
      const { value, rawType } = await loadRealEnv({
        PROCESS_RATE_LIMIT_PER_MIN: undefined,
      })
      // Mutação-alvo: trocar `.default(10)` por qualquer outro literal quebra aqui.
      expect(value).toBe(10)
      expect(rawType).toBe('number')
    })

    it('string vazia NÃO cai no default — coage a 0 e é REJEITADA por min(1)', async () => {
      // Comportamento real documentado: '' é valor PRESENTE (não ausente), então
      // o `.default(10)` não dispara. `z.coerce.number('')` = Number('') = 0, que
      // reprova `.min(1)`. Garante que ninguém troque a var por '' em staging
      // achando que "volta ao default" — na verdade quebra o boot.
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })
  })

  // ---------------------------------------------------------------------------
  // Coerção string → number (z.coerce)
  // ---------------------------------------------------------------------------
  describe('coerção (z.coerce.number)', () => {
    it('deve coagir "200" (string do fly secrets) para 200 (number)', async () => {
      // Mutação-alvo: remover `z.coerce` → `z.number()` rejeita a string '200'
      // e o boot LANÇA. Este teste espera SUCESSO + número, matando a mutação.
      const { value, rawType } = await loadRealEnv({
        PROCESS_RATE_LIMIT_PER_MIN: '200',
      })
      expect(value).toBe(200)
      expect(rawType).toBe('number')
    })

    it('deve coagir "1" para 1 (number, não a string)', async () => {
      const { value, rawType } = await loadRealEnv({
        PROCESS_RATE_LIMIT_PER_MIN: '1',
      })
      expect(value).toBe(1)
      expect(rawType).toBe('number')
    })

    it('deve rejeitar valor não-numérico ("abc")', async () => {
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: 'abc',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })
  })

  // ---------------------------------------------------------------------------
  // Limites inferior/superior (min 1, max 1000) e int()
  // ---------------------------------------------------------------------------
  describe('limites e integralidade', () => {
    it('deve ACEITAR o limite inferior 1', async () => {
      const { value } = await loadRealEnv({ PROCESS_RATE_LIMIT_PER_MIN: '1' })
      expect(value).toBe(1)
    })

    it('deve ACEITAR o limite superior 1000', async () => {
      const { value } = await loadRealEnv({
        PROCESS_RATE_LIMIT_PER_MIN: '1000',
      })
      expect(value).toBe(1000)
    })

    it('deve REJEITAR 0 (abaixo de min 1)', async () => {
      // Mutação-alvo: remover `.min(1)` ou trocar pra `.min(0)` → 0 passaria.
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '0',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })

    it('deve REJEITAR negativo (-5)', async () => {
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '-5',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })

    it('deve REJEITAR 1001 (acima de max 1000)', async () => {
      // Mutação-alvo: remover `.max(1000)` ou alargar → 1001 passaria.
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '1001',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })

    it('deve REJEITAR valor exorbitante (999999) — guarda max', async () => {
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '999999',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })

    it('deve REJEITAR não-inteiro (10.5) — guarda int()', async () => {
      // Mutação-alvo: remover `.int()` → 10.5 passaria como float.
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '10.5',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })
  })

  // ---------------------------------------------------------------------------
  // Boundary off-by-one — calibra que min/max são EXATAMENTE 1 e 1000
  // ---------------------------------------------------------------------------
  describe('boundary off-by-one (min===1, max===1000)', () => {
    it('limite exato 1000 passa, 1001 falha — max é 1000, não 1001', async () => {
      const ok = await loadRealEnv({ PROCESS_RATE_LIMIT_PER_MIN: '1000' })
      expect(ok.value).toBe(1000)
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '1001',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })

    it('limite exato 1 passa, 0 falha — min é 1, não 0', async () => {
      const ok = await loadRealEnv({ PROCESS_RATE_LIMIT_PER_MIN: '1' })
      expect(ok.value).toBe(1)
      const stderr = await expectBootFailure({
        PROCESS_RATE_LIMIT_PER_MIN: '0',
      })
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
    })
  })

  // ---------------------------------------------------------------------------
  // Guard de PRODUÇÃO (@security F1, fechado pelo finding ALTO 9d4b2f7e1a05):
  //   if (isProd && SENTRY_ENVIRONMENT !== 'staging' && PROCESS_RATE_LIMIT_PER_MIN !== 10)
  //     → boot FALHA.
  //
  // O discriminador é SENTRY_ENVIRONMENT, NÃO NODE_ENV — porque staging e prod
  // compartilham NODE_ENV=production (twin fiel, D-STAGING-ENV), e só a tag
  // SENTRY_ENVIRONMENT distingue os dois. Fatos do deploy:
  //   - staging: NODE_ENV=production + SENTRY_ENVIRONMENT=staging (fly.toml:31/37)
  //   - prod (7.6): NODE_ENV=production + SENTRY_ENVIRONMENT=production
  //   - SENTRY_ENVIRONMENT default = 'development' (env.ts:168) → deny-by-default:
  //     se a tag de staging for ESQUECIDA, o guard AINDA trava em 10.
  //
  // O teto fica FIXO em 10 em prod real (não pode inflar — enfraquece anti-DoS;
  // nem reduzir — o limite é contrato público em X-RateLimit-Limit). Em staging o
  // knob é LIVRE (1..1000): é exatamente o que o load test 7.5 precisa afrouxar
  // via `fly secrets set` sem rebuild.
  //
  // BASE_VALID_PROD_ENV não declara SENTRY_ENVIRONMENT → cai no default 'development'
  // = cenário "tag esquecida". Cada teste seta a tag explicitamente quando precisa.
  // ---------------------------------------------------------------------------
  describe('guard de produção (@security F1) — SENTRY_ENVIRONMENT discrimina staging×prod', () => {
    // CONTROLE POSITIVO: prova que BASE_VALID_PROD_ENV satisfaz TODOS os outros
    // guards de prod. Sem este passar, os testes de falha abaixo seriam
    // inconclusivos (poderiam falhar por var alheia, não pelo nosso guard).
    it('controle positivo: prod-real (SENTRY=production) + 10 → boot PASSA (base limpa)', async () => {
      const { value } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '10', SENTRY_ENVIRONMENT: 'production' },
        BASE_VALID_PROD_ENV,
      )
      expect(value).toBe(10)
    })

    // -------------------------------------------------------------------------
    // 1. STAGING REAL — o teste-CHAVE: prova que o load test 7.5 consegue
    //    afrouxar o limiter via fly secrets sem quebrar o boot.
    // -------------------------------------------------------------------------
    it('STAGING REAL: NODE_ENV=production + SENTRY_ENVIRONMENT=staging + 200 → boot PASSA', async () => {
      const { value, rawType } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '200', SENTRY_ENVIRONMENT: 'staging' },
        BASE_VALID_PROD_ENV,
      )
      // O afrouxamento documentado do 7.5 funciona: knob livre em staging.
      expect(value).toBe(200)
      expect(rawType).toBe('number')
    })

    it('STAGING REAL aceita o teto do range (1000) — knob totalmente livre em staging', async () => {
      const { value } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '1000', SENTRY_ENVIRONMENT: 'staging' },
        BASE_VALID_PROD_ENV,
      )
      expect(value).toBe(1000)
    })

    // -------------------------------------------------------------------------
    // 2. PROD REAL — teto travado em 10. Inflar (1000) FALHA.
    // -------------------------------------------------------------------------
    it('PROD REAL: SENTRY_ENVIRONMENT=production + 1000 → boot FALHA, atribuível ao nosso path', async () => {
      const stderr = await expectBootFailure(
        {
          PROCESS_RATE_LIMIT_PER_MIN: '1000',
          SENTRY_ENVIRONMENT: 'production',
        },
        BASE_VALID_PROD_ENV,
      )
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
      // Atribuição ESTRITA: a base é válida, então NENHUM outro guard de prod
      // pode aparecer no stderr. Se aparecesse, o teste seria inconclusivo.
      expect(stderr).not.toContain('SUPABASE')
      expect(stderr).not.toContain('STRIPE')
      expect(stderr).not.toContain('SENTRY_DSN')
      expect(stderr).not.toContain('FRONTEND_URL')
      expect(stderr).not.toContain('RESEND')
      // Mensagem do guard (não erro genérico de range):
      expect(stderr).toContain('deve ser 10 em produção')
    })

    it('PROD REAL: SENTRY_ENVIRONMENT=production + 5 (abaixo de 10) → boot FALHA', async () => {
      // Reduzir também quebra contrato (X-RateLimit-Limit menor que o anunciado).
      const stderr = await expectBootFailure(
        { PROCESS_RATE_LIMIT_PER_MIN: '5', SENTRY_ENVIRONMENT: 'production' },
        BASE_VALID_PROD_ENV,
      )
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
      expect(stderr).toContain('deve ser 10 em produção')
    })

    // -------------------------------------------------------------------------
    // 3. DENY-BY-DEFAULT — tag de staging ESQUECIDA (SENTRY_ENVIRONMENT ausente →
    //    default 'development'). O guard AINDA trava: fail-safe, não fail-open.
    // -------------------------------------------------------------------------
    it('DENY-BY-DEFAULT: NODE_ENV=production + SENTRY_ENVIRONMENT ausente (default dev) + 1000 → boot FALHA', async () => {
      const stderr = await expectBootFailure(
        { PROCESS_RATE_LIMIT_PER_MIN: '1000', SENTRY_ENVIRONMENT: undefined },
        BASE_VALID_PROD_ENV,
      )
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
      expect(stderr).toContain('deve ser 10 em produção')
    })

    it('DENY-BY-DEFAULT mutation guard: SENTRY_ENVIRONMENT="development" explícito + 1000 → boot FALHA', async () => {
      // Trava se alguém trocar a condição pra `=== 'production'` (que deixaria
      // 'development' passar livre — fail-open indesejado em prod mal-tagueado).
      const stderr = await expectBootFailure(
        {
          PROCESS_RATE_LIMIT_PER_MIN: '1000',
          SENTRY_ENVIRONMENT: 'development',
        },
        BASE_VALID_PROD_ENV,
      )
      expect(stderr).toContain('PROCESS_RATE_LIMIT_PER_MIN')
      expect(stderr).toContain('deve ser 10 em produção')
    })

    // -------------------------------------------------------------------------
    // 4. Valor canônico 10 passa em QUALQUER tag (o guard só atua quando != 10).
    // -------------------------------------------------------------------------
    it('PROD REAL + 10 → boot PASSA (valor canônico nunca é bloqueado)', async () => {
      const { value } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '10', SENTRY_ENVIRONMENT: 'production' },
        BASE_VALID_PROD_ENV,
      )
      expect(value).toBe(10)
    })

    it('STAGING + 10 → boot PASSA (10 é válido em staging também)', async () => {
      const { value } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '10', SENTRY_ENVIRONMENT: 'staging' },
        BASE_VALID_PROD_ENV,
      )
      expect(value).toBe(10)
    })

    it('PROD REAL + AUSENTE → default 10 → boot PASSA', async () => {
      const { value } = await loadRealEnv(
        {
          PROCESS_RATE_LIMIT_PER_MIN: undefined,
          SENTRY_ENVIRONMENT: 'production',
        },
        BASE_VALID_PROD_ENV,
      )
      expect(value).toBe(10)
    })

    // -------------------------------------------------------------------------
    // Sanidade: NODE_ENV não-prod continua com knob livre (independe da tag).
    // Lembrete: NODE_ENV não tem 'staging' no enum; valores não-prod são
    // 'development' e 'test'. Em deploy, "staging" é NODE_ENV=production +
    // SENTRY_ENVIRONMENT=staging (coberto pelos testes STAGING REAL acima).
    // -------------------------------------------------------------------------
    it('development (NODE_ENV) + 200 → boot PASSA (isProd=false, guard nem avalia)', async () => {
      const devBase = { ...BASE_VALID_ENV, NODE_ENV: 'development' }
      const { value } = await loadRealEnv(
        { PROCESS_RATE_LIMIT_PER_MIN: '200' },
        devBase,
      )
      expect(value).toBe(200)
    })

    it('test (NODE_ENV) + 200 → boot PASSA (isProd=false, guard nem avalia)', async () => {
      const { value } = await loadRealEnv({
        PROCESS_RATE_LIMIT_PER_MIN: '200',
      })
      expect(value).toBe(200)
    })
  })
})
