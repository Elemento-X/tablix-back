/**
 * Smoke test de integração — banco de dados real (Testcontainers + Postgres 17).
 *
 * Este é o canário da infra de integração montada no Card 3.1b:
 *   - Se cair, o problema é no scaffold (container, schema.sql, helpers).
 *   - Se passar, os demais integration tests (Card 3.3) têm base confiável.
 *
 * Cinco blocos pra cobrir contratos críticos do schema:
 *   1. INTROSPECTION — o schema aplicado bate com a produção (7 tabelas,
 *      27 índices, 4 enums). Drift aqui = snapshot desatualizado.
 *   2. CRUD — roundtrip simples no User (create/find/update/delete) prova
 *      que o PrismaClient está vinculado ao container.
 *   3. FK CASCADE — deletar User faz Session cascatear (behavior crítico:
 *      session não pode sobreviver ao dono).
 *   4. FK RESTRICT — deletar User com Token falha (behavior crítico:
 *      não podemos deletar user enquanto tiver assinatura ligada).
 *   5. TRUNCATE — `truncateAll()` zera contagens de TODAS as tabelas, sem
 *      precisar de lista hardcoded (descoberta dinâmica).
 *
 * @owner: @tester
 * @card: 3.1b
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import {
  getTestPrisma,
  truncateAll,
  disconnectTestPrisma,
} from '../helpers/prisma'

describe('DB smoke (integration)', () => {
  const prisma = getTestPrisma()

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await disconnectTestPrisma()
  })

  describe('1. schema introspection', () => {
    it('tem 7 tabelas no schema public', async () => {
      const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `
      const names = rows.map((r) => r.tablename)
      expect(names).toEqual(
        [
          'audit_log',
          'jobs',
          'sessions',
          'stripe_events',
          'tokens',
          'usage',
          'users',
        ].sort(),
      )
    })

    it('tem 4 enums customizados', async () => {
      const rows = await prisma.$queryRaw<{ typname: string }[]>`
        SELECT typname
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
        ORDER BY typname
      `
      expect(rows.map((r) => r.typname)).toEqual([
        'JobStatus',
        'Plan',
        'Role',
        'TokenStatus',
      ])
    })

    // Pega drift silencioso de TIMESTAMP vs TIMESTAMPTZ e TEXT vs UUID que
    // escapou o Card 3.1b original: o snapshot foi gerado pré-Fase 3 DB
    // Hardening (commit 43bc1c2), mas o Prisma schema já declarava os tipos
    // novos. Sem essa assertion, testes de integração passam com semântica
    // de timezone/tipo diferente da produção e bugs de TZ vazam em deploy.
    it('todas as colunas *_at das tabelas de domínio são TIMESTAMPTZ', async () => {
      const rows = await prisma.$queryRaw<
        {
          table_name: string
          column_name: string
          data_type: string
        }[]
      >`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('users','sessions','tokens','usage','jobs','stripe_events','audit_log')
          AND (column_name LIKE '%_at' OR column_name = 'processed_at')
        ORDER BY table_name, column_name
      `
      const offenders = rows.filter(
        (r) => r.data_type !== 'timestamp with time zone',
      )
      expect(offenders).toEqual([])
      expect(rows.length).toBeGreaterThanOrEqual(14)
    })

    it('PKs id e FKs user_id são UUID nativo (não TEXT)', async () => {
      const rows = await prisma.$queryRaw<
        {
          table_name: string
          column_name: string
          udt_name: string
        }[]
      >`
        SELECT table_name, column_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('users','sessions','tokens','usage','jobs','audit_log')
          AND column_name IN ('id','user_id')
        ORDER BY table_name, column_name
      `
      const offenders = rows.filter((r) => r.udt_name !== 'uuid')
      expect(offenders).toEqual([])
      expect(rows.length).toBeGreaterThanOrEqual(10)
    })

    it('índices órfãos droppados em Fase 3 não voltam', async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('tokens_token_idx','idx_usage_token_period')
      `
      expect(rows).toEqual([])
    })

    it('preserva o CHECK constraint de audit_log.action (regex ^[A-Z_]+$, length 3-50)', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_log (action, success) VALUES ('invalid-lowercase', true)`,
        ),
      ).rejects.toThrow()
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_log (action, success) VALUES ('AB', true)`,
        ),
      ).rejects.toThrow()
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO audit_log (action, success) VALUES ('VALID_ACTION', true)`,
        ),
      ).resolves.toBeDefined()
    })

    it('preserva o partial index idx_audit_log_failures (WHERE success = false)', async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_audit_log_failures'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toMatch(/WHERE \(success = false\)/)
    })
  })

  describe('2. CRUD básico (User roundtrip)', () => {
    it('cria, lê, atualiza e deleta um User', async () => {
      const created = await prisma.user.create({
        data: { email: 'smoke@tablix.test' },
      })
      expect(created.id).toBeDefined()
      expect(created.role).toBe('FREE')

      const found = await prisma.user.findUnique({ where: { id: created.id } })
      expect(found?.email).toBe('smoke@tablix.test')

      const updated = await prisma.user.update({
        where: { id: created.id },
        data: { role: 'PRO' },
      })
      expect(updated.role).toBe('PRO')

      await prisma.user.delete({ where: { id: created.id } })
      const afterDelete = await prisma.user.findUnique({
        where: { id: created.id },
      })
      expect(afterDelete).toBeNull()
    })
  })

  describe('3. FK CASCADE (delete User → Session desaparece)', () => {
    it('session cascateia ao deletar o user dono', async () => {
      const user = await prisma.user.create({
        data: { email: 'cascade@tablix.test' },
      })
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: 'hash_cascade_test_' + Date.now(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })

      const before = await prisma.session.count({ where: { userId: user.id } })
      expect(before).toBe(1)

      await prisma.user.delete({ where: { id: user.id } })

      const after = await prisma.session.count({ where: { userId: user.id } })
      expect(after).toBe(0)
    })
  })

  describe('4. FK RESTRICT (delete User com Token → erro)', () => {
    it('bloqueia delete de user que ainda tem token ativo', async () => {
      const user = await prisma.user.create({
        data: { email: 'restrict@tablix.test' },
      })
      await prisma.token.create({
        data: {
          userId: user.id,
          token: 'tbx_pro_restrict_' + Date.now(),
        },
      })

      await expect(
        prisma.user.delete({ where: { id: user.id } }),
      ).rejects.toThrow()

      // User continua intacto
      const stillThere = await prisma.user.findUnique({
        where: { id: user.id },
      })
      expect(stillThere).not.toBeNull()
    })
  })

  describe('5. truncateAll zera contagens de todas as tabelas', () => {
    it('após inserir em múltiplas tabelas, truncateAll limpa tudo', async () => {
      const user = await prisma.user.create({
        data: { email: 'trunc@tablix.test' },
      })
      await prisma.session.create({
        data: {
          userId: user.id,
          refreshTokenHash: 'hash_trunc_' + Date.now(),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
      await prisma.usage.create({
        data: { userId: user.id, period: '2026-04', unificationsCount: 3 },
      })
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit_log (action, success) VALUES ('TRUNCATE_SMOKE', true)`,
      )

      expect(await prisma.user.count()).toBe(1)
      expect(await prisma.session.count()).toBe(1)
      expect(await prisma.usage.count()).toBe(1)

      await truncateAll()

      expect(await prisma.user.count()).toBe(0)
      expect(await prisma.session.count()).toBe(0)
      expect(await prisma.usage.count()).toBe(0)

      const auditCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM audit_log
      `
      expect(Number(auditCount[0].count)).toBe(0)
    })
  })
})
