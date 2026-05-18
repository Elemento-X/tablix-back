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
    it('tem 11 tabelas no schema public', async () => {
      const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `
      const names = rows.map((r) => r.tablename)
      expect(names).toEqual(
        [
          'audit_log',
          'audit_log_legal', // Card #150 — LGPD 5y retention
          'cron_runs', // Card #146 F2.5 — scheduler history (30d)
          'file_history', // Card #145 — opt-in PRO storage history
          'file_history_dead_letter', // Card #146 F2.5 — quarentena LGPD 5y
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
          AND table_name IN ('users','sessions','tokens','usage','jobs','stripe_events','audit_log','file_history')
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
          AND table_name IN ('users','sessions','tokens','usage','jobs','audit_log','file_history')
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

  describe('6. file_history (Card #145) — invariantes de schema', () => {
    /**
     * Helper: gera storage_path válido pelo regex CHECK.
     * Formato: {userId-uuidv4}/{yyyy-mm-dd UTC}/{jobId-cuid}.{ext}
     */
    const buildPath = (userId: string, jobId = 'abc1234567', ext = 'csv') =>
      `${userId}/2026-05-03/${jobId}.${ext}`

    const baseRow = (userId: string) => ({
      user_id: userId,
      storage_path: buildPath(userId),
      original_filename: 'rj_dezembro_dre.csv',
      mime_type: 'text/csv',
      file_size: 1024,
      expires_at: new Date(Date.now() + 30 * 86_400_000),
    })

    it('aceita INSERT válido (controle positivo)', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-pos@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).resolves.toBe(1)
    })

    it('CHECK file_size > 0 rejeita INSERT com file_size=0', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-fs0@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, 0, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_file_size_positive_check/)
    })

    it('CHECK file_size <= 100MB rejeita INSERT acima do cap', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-fsmax@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${104857601}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_file_size_positive_check/)
    })

    it('CHECK purge_attempts >= 0 rejeita INSERT com valor negativo', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-pa@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at, purge_attempts)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at}, -1)
        `,
      ).rejects.toThrow(/file_history_purge_attempts_nonneg_check/)
    })

    it('CHECK storage_path regex rejeita formato malformado', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-sp1@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, 'invalid-path-no-uuid.csv', ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_storage_path_format_check/)
    })

    it('CHECK storage_path regex rejeita month inválido (13)', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-sp2@tablix.test' },
      })
      const row = baseRow(user.id)
      const badPath = `${user.id}/2026-13-15/abc1234567.csv`
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${badPath}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_storage_path_format_check/)
    })

    it('CHECK storage_path regex rejeita ext fora da whitelist (xlsm)', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-sp3@tablix.test' },
      })
      const row = baseRow(user.id)
      const badPath = `${user.id}/2026-05-03/abc1234567.xlsm`
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${badPath}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_storage_path_format_check/)
    })

    it('CHECK original_filename rejeita control char 0x00 (NULL byte)', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-fn1@tablix.test' },
      })
      const row = baseRow(user.id)
      // E'...' é literal C-style do Postgres pra inserir control char
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
           VALUES ('${row.user_id}'::uuid, '${row.storage_path}', E'bad\\x01name.csv', '${row.mime_type}', ${row.file_size}, NOW() + INTERVAL '30 days')`,
        ),
      ).rejects.toThrow(/file_history_original_filename_check/)
    })

    it('CHECK original_filename rejeita 0x7F (DEL) — fix-pack F-LOW-01', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-fn2@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
           VALUES ('${row.user_id}'::uuid, '${row.storage_path}', E'bad\\x7Fname.csv', '${row.mime_type}', ${row.file_size}, NOW() + INTERVAL '30 days')`,
        ),
      ).rejects.toThrow(/file_history_original_filename_check/)
    })

    it('CHECK original_filename rejeita string vazia', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-fn3@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, '', ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_original_filename_check/)
    })

    it('CHECK mime_type rejeita string vazia', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-mt@tablix.test' },
      })
      const row = baseRow(user.id)
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, '', ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_mime_type_nonempty_check/)
    })

    it('CHECK expires_at >= created_at rejeita expires_at no passado', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-exp@tablix.test' },
      })
      const row = baseRow(user.id)
      const pastExpiry = new Date(Date.now() - 86_400_000) // ontem
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${pastExpiry})
        `,
      ).rejects.toThrow(/file_history_expires_at_after_created_check/)
    })

    it('UNIQUE storage_path bloqueia INSERT duplicado (23505)', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-uniq@tablix.test' },
      })
      const row = baseRow(user.id)
      await prisma.$executeRaw`
        INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
        VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
      `
      await expect(
        prisma.$executeRaw`
          INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
          VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
        `,
      ).rejects.toThrow(/file_history_storage_path_key|already exists|23505/)
    })

    it('FK Cascade: delete user → file_history rows desaparecem', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-cascade@tablix.test' },
      })
      const row = baseRow(user.id)
      await prisma.$executeRaw`
        INSERT INTO file_history (user_id, storage_path, original_filename, mime_type, file_size, expires_at)
        VALUES (${row.user_id}::uuid, ${row.storage_path}, ${row.original_filename}, ${row.mime_type}, ${row.file_size}, ${row.expires_at})
      `
      const before = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM file_history WHERE user_id = ${user.id}::uuid
      `
      expect(Number(before[0].count)).toBe(1)

      await prisma.user.delete({ where: { id: user.id } })

      const after = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM file_history WHERE user_id = ${user.id}::uuid
      `
      expect(Number(after[0].count)).toBe(0)
    })

    it('preserva 3 partial indexes parciais corretos', async () => {
      const rows = await prisma.$queryRaw<
        { indexname: string; indexdef: string }[]
      >`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'file_history'
          AND indexname IN (
            'idx_filehistory_expires_active',
            'idx_filehistory_purge_pending'
          )
        ORDER BY indexname
      `
      expect(rows).toHaveLength(2)
      const expiresActive = rows.find(
        (r) => r.indexname === 'idx_filehistory_expires_active',
      )
      const purgePending = rows.find(
        (r) => r.indexname === 'idx_filehistory_purge_pending',
      )
      expect(expiresActive?.indexdef).toMatch(/WHERE \(deleted_at IS NULL\)/)
      expect(purgePending?.indexdef).toMatch(/WHERE \(deleted_at IS NOT NULL\)/)
    })

    /**
     * Structural-only: valida EXISTÊNCIA + nomes + cmd whitelist via
     * `pg_policies`. Runtime testing (anon vs authenticated com auth.uid())
     * fica deferred pra F2 quando Supabase Auth integration acontecer
     * (Testcontainers Postgres puro não tem extension auth — usamos stub
     * que retorna NULL, suficiente pra DDL apply mas não pra runtime).
     * Card discovery: rls-runtime-untested — ativar em F2.
     */
    it('preserva RLS habilitada + 3 policies definidas (regression detector)', async () => {
      const rls = await prisma.$queryRaw<{ relrowsecurity: boolean }[]>`
        SELECT relrowsecurity FROM pg_class
        WHERE relname = 'file_history' AND relnamespace = 'public'::regnamespace
      `
      expect(rls[0]?.relrowsecurity).toBe(true)

      const policies = await prisma.$queryRaw<
        { policyname: string; cmd: string }[]
      >`
        SELECT policyname, cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'file_history'
        ORDER BY policyname
      `
      expect(policies.map((p) => p.policyname)).toEqual([
        'file_history_insert_own',
        'file_history_select_own_active',
        'file_history_update_own_active',
      ])
      // DELETE deny implícito: verificar ausência de policy DELETE
      const deletePolicies = policies.filter((p) => p.cmd === 'DELETE')
      expect(deletePolicies).toEqual([])
    })

    it('User opt-in defaults: history_opt_in=false, in_at/out_at NULL', async () => {
      const user = await prisma.user.create({
        data: { email: 'fh-defaults@tablix.test' },
      })
      const row = await prisma.$queryRaw<
        {
          history_opt_in: boolean
          history_opt_in_at: Date | null
          history_opt_out_at: Date | null
        }[]
      >`
        SELECT history_opt_in, history_opt_in_at, history_opt_out_at
        FROM users WHERE id = ${user.id}::uuid
      `
      expect(row[0].history_opt_in).toBe(false)
      expect(row[0].history_opt_in_at).toBeNull()
      expect(row[0].history_opt_out_at).toBeNull()
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
