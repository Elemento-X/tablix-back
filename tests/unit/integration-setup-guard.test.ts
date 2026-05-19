/**
 * Testes do anti-prod guard que protege a suíte de integração de tocar
 * banco real. Esse guard é a barreira entre "rodar npm run test:integration"
 * e "TRUNCATE em produção" — sem teste explícito, qualquer regressão
 * silenciosa no helper vira incidente.
 *
 * Cobertura mínima exigida:
 * - NODE_ENV=production sempre rejeita
 * - Allowlist aceita os hosts locais conhecidos
 * - Allowlist rejeita hosts fora da lista (default behavior)
 * - Blocklist explícita pega providers de prod conhecidos
 * - Override TABLIX_TEST_MODE_ALLOW_ANY_DB pula allowlist mas mantém blocklist
 * - Múltiplas urlEnvVars (caso do dump-test-schema)
 * - URL inválida é rejeitada com mensagem clara
 *
 * @owner: @tester + @security
 * @card: 3.1b — Fase 1
 */
import { describe, it, expect } from 'vitest'
import {
  assertSafeEnvironment,
  UnsafeTestEnvironmentError,
  LOCAL_HOST_PATTERNS,
  PROD_URL_PATTERNS,
} from '../helpers/safe-env-guard'

const ctx = { context: 'unit-test' }

describe('safe-env-guard — assertSafeEnvironment', () => {
  describe('NODE_ENV gate', () => {
    it('rejeita quando NODE_ENV=production, mesmo com URL local', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: {
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
          },
        }),
      ).toThrow(UnsafeTestEnvironmentError)
    })

    it('rejeita NODE_ENV=production mesmo com override allow_any_db', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: {
            NODE_ENV: 'production',
            TABLIX_TEST_MODE_ALLOW_ANY_DB: 'true',
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
          },
        }),
      ).toThrow(/NODE_ENV=production/)
    })

    it('aceita NODE_ENV=test ou development com URL local', () => {
      for (const nodeEnv of ['test', 'development', undefined]) {
        expect(() =>
          assertSafeEnvironment({
            ...ctx,
            env: {
              NODE_ENV: nodeEnv,
              DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
            },
          }),
        ).not.toThrow()
      }
    })
  })

  describe('allowlist (hosts locais aceitos)', () => {
    const acceptableHosts = [
      'localhost',
      'LocalHost',
      '127.0.0.1',
      '127.5.6.7',
      'host.docker.internal',
      'HOST.DOCKER.INTERNAL',
      '0.0.0.0',
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.5',
      '172.31.255.10',
      '192.168.1.1',
      '192.168.255.254',
      '169.254.42.42',
      '100.64.0.1',
      '100.127.255.254',
    ]

    for (const host of acceptableHosts) {
      it(`aceita host local "${host}"`, () => {
        expect(() =>
          assertSafeEnvironment({
            ...ctx,
            env: {
              DATABASE_URL: `postgresql://user:pass@${host}:5432/db`,
            },
          }),
        ).not.toThrow()
      })
    }

    it('aceita IPv6 loopback ::1', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: {
            DATABASE_URL: 'postgresql://user:pass@[::1]:5432/db',
          },
        }),
      ).not.toThrow()
    })
  })

  describe('allowlist (rejeita hosts fora da lista)', () => {
    const rejectedHosts = [
      'example.com',
      'db.mycompany.io',
      '8.8.8.8',
      // 172.x fora do range RFC1918 (172.16-31)
      '172.15.0.1',
      '172.32.0.1',
      // 192.x fora do range RFC1918 (192.168.x)
      '192.167.1.1',
      '192.169.1.1',
      // 100.x fora de CGNAT (100.64-127)
      '100.63.0.1',
      '100.128.0.1',
      // 10.x.com — string casa com /^10/ se mal escrito, mas hostname deve ser inteiro
      'mydb-10.0.0.1.example.com',
    ]

    for (const host of rejectedHosts) {
      it(`rejeita host não-local "${host}"`, () => {
        expect(() =>
          assertSafeEnvironment({
            ...ctx,
            env: {
              DATABASE_URL: `postgresql://user:pass@${host}:5432/db`,
            },
          }),
        ).toThrow(UnsafeTestEnvironmentError)
      })
    }
  })

  describe('blocklist (providers de prod)', () => {
    const prodUrls = [
      'postgresql://x:y@db.abc123.supabase.co:5432/postgres',
      'postgresql://x:y@aws-1-sa-east-1.pooler.supabase.com:6543/postgres',
      'postgresql://x:y@app.fly.dev:5432/app',
      'postgresql://x:y@instance.cluster-abc.rds.amazonaws.com:5432/db',
      'postgresql://x:y@ep-cool-dawn.us-east-1.aws.neon.tech:5432/neondb',
      'postgresql://x:y@dpg-abc123.render.com:5432/db',
      'postgresql://x:y@ec2-abc.compute-1.amazonaws.com:5432/db',
      'postgresql://x:y@my-db.ondigitalocean.app:5432/defaultdb',
      'postgresql://x:y@server.postgres.database.azure.com:5432/db',
      'postgresql://x:y@instance.cloudsql.googleapis.com:5432/db',
      'postgresql://x:y@db.abc.psdb.cloud:5432/db',
      'postgresql://x:y@db.aivencloud.com:25060/defaultdb',
      'postgresql://x:y@some.proxy.rlwy.net:5432/railway',
      'postgresql://x:y@app.postgresbridge.com:5432/postgres',
    ]

    for (const url of prodUrls) {
      it(`rejeita URL de prod ${url.split('@')[1]?.split(':')[0]}`, () => {
        expect(() =>
          assertSafeEnvironment({
            ...ctx,
            env: { DATABASE_URL: url },
          }),
        ).toThrow(/casa com padrão de produção/)
      })
    }
  })

  describe('override TABLIX_TEST_MODE_ALLOW_ANY_DB', () => {
    it('com override=true, aceita host fora da allowlist', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: {
            TABLIX_TEST_MODE_ALLOW_ANY_DB: 'true',
            DATABASE_URL: 'postgresql://user:pass@my-staging.internal:5432/db',
          },
        }),
      ).not.toThrow()
    })

    it('com override=true, AINDA rejeita prod URL conhecida (defesa em profundidade)', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: {
            TABLIX_TEST_MODE_ALLOW_ANY_DB: 'true',
            DATABASE_URL:
              'postgresql://x:y@aws-1-sa-east-1.pooler.supabase.com:6543/postgres',
          },
        }),
      ).toThrow(/casa com padrão de produção/)
    })

    it('override só vale com string exata "true" (não "1", não "yes")', () => {
      for (const wrongValue of ['1', 'yes', 'TRUE', 'on']) {
        expect(() =>
          assertSafeEnvironment({
            ...ctx,
            env: {
              TABLIX_TEST_MODE_ALLOW_ANY_DB: wrongValue,
              DATABASE_URL:
                'postgresql://user:pass@external.example.com:5432/db',
            },
          }),
        ).toThrow(UnsafeTestEnvironmentError)
      }
    })
  })

  describe('múltiplas urlEnvVars', () => {
    it('valida cada URL listada (caso do schema-dump)', () => {
      expect(() =>
        assertSafeEnvironment({
          context: 'schema-dump',
          urlEnvVars: ['SCHEMA_DUMP_URL', 'DATABASE_URL'],
          env: {
            SCHEMA_DUMP_URL:
              'postgresql://x:y@db.abc.supabase.co:5432/postgres',
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/db',
          },
        }),
      ).toThrow(/SCHEMA_DUMP_URL.*casa com padrão de produção/)
    })

    it('aceita quando ambas URLs são locais', () => {
      expect(() =>
        assertSafeEnvironment({
          context: 'schema-dump',
          urlEnvVars: ['SCHEMA_DUMP_URL', 'DATABASE_URL'],
          env: {
            SCHEMA_DUMP_URL: 'postgresql://x:y@localhost:5432/dump',
            DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/db',
          },
        }),
      ).not.toThrow()
    })

    it('ignora urlEnvVars não setadas (não exige todas)', () => {
      expect(() =>
        assertSafeEnvironment({
          context: 'schema-dump',
          urlEnvVars: ['SCHEMA_DUMP_URL', 'DATABASE_URL'],
          env: {
            DATABASE_URL: 'postgresql://x:y@localhost:5432/db',
            // SCHEMA_DUMP_URL não setada
          },
        }),
      ).not.toThrow()
    })
  })

  describe('URL inválida', () => {
    it('rejeita URL malformada', () => {
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: { DATABASE_URL: 'not-a-url' },
        }),
      ).toThrow(/não é uma URL válida/)
    })

    it('rejeita URL vazia se setada como string vazia falsy → ignora', () => {
      // String vazia é falsy — guard pula como "não setado"
      expect(() =>
        assertSafeEnvironment({
          ...ctx,
          env: { DATABASE_URL: '' },
        }),
      ).not.toThrow()
    })
  })

  describe('mensagens de erro identificam contexto', () => {
    it('inclui o context na mensagem para facilitar debug', () => {
      try {
        assertSafeEnvironment({
          context: 'meu-contexto-customizado',
          env: { NODE_ENV: 'production', DATABASE_URL: '' },
        })
        expect.fail('deveria ter lançado')
      } catch (err) {
        expect((err as Error).message).toContain('[meu-contexto-customizado]')
      }
    })
  })

  describe('exports estão coerentes', () => {
    it('LOCAL_HOST_PATTERNS é não-vazio e contém localhost', () => {
      expect(LOCAL_HOST_PATTERNS.length).toBeGreaterThan(0)
      expect(LOCAL_HOST_PATTERNS.some((r) => r.test('localhost'))).toBe(true)
    })

    it('PROD_URL_PATTERNS contém ao menos os 4 providers principais', () => {
      // Test via URL real: r.source escapa pontos (\.fly\.dev), então
      // string-match em source dá falso negativo. Behavior matters, não shape.
      const sampleUrls = {
        supabase: 'postgresql://x@db.abc.supabase.co:5432/db',
        fly: 'postgresql://x@app.fly.dev:5432/db',
        aws: 'postgresql://x@instance.rds.amazonaws.com:5432/db',
        neon: 'postgresql://x@ep-cool.neon.tech:5432/db',
      }
      for (const [name, url] of Object.entries(sampleUrls)) {
        expect(
          PROD_URL_PATTERNS.some((r) => r.test(url)),
          `nenhum padrão casou com ${name} (${url})`,
        ).toBe(true)
      }
    })
  })
})
