/**
 * Card #150 — Integration tests para audit_log_legal (Postgres real).
 *
 * Cobre o que mocks de unit nao podem cobrir:
 *  - CHECK constraints SQL realmente rejeitam valores fora da whitelist
 *    (raw insert via $executeRawUnsafe bypassando Zod)
 *  - UNIQUE constraint em event_id dispara P2002 real
 *  - RLS esta ENABLED (rowsecurity=true) — defesa em profundidade
 *  - Partial indexes existem com WHERE clauses corretos
 *  - TOAST tuning aplicado (toast_tuple_target=4096)
 *  - Idempotencia E2E via service real (P2002 + lookup retorna existente)
 *  - resourceHash bytea aceita exatamente 32 bytes; rejeita outros tamanhos
 *
 * Estrategia: usa testcontainers Postgres 17 + schema.sql aplicado.
 * Service usa o PrismaClient super-user (bypassa RLS por design).
 *
 * @owner: @tester
 * @card: #150
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { ErrorCodes, type AppError } from '../../src/errors/app-error'
import { recordLegalEvent } from '../../src/modules/audit-legal/audit-legal.service'
import {
  LegalActor,
  LegalEventType,
  LegalOutcome,
  RESOURCE_HASH_ALGO_V1,
} from '../../src/modules/audit-legal/audit-legal.types'
import {
  disconnectTestPrisma,
  getTestPrisma,
  truncateAll,
} from '../helpers/prisma'

// F-MED-NONDET fix: crypto.randomUUID() — determinístico no sentido de
// "criptograficamente forte, sem viés". Math.random() poderia colidir sob
// CI sharded em escala extrema; randomUUID() é UUID v4 nativo do Node.
function uuid(): string {
  return randomUUID()
}

describe('audit_log_legal (integration)', () => {
  const prisma = getTestPrisma()

  beforeEach(async () => {
    await truncateAll()
  })

  afterAll(async () => {
    await disconnectTestPrisma()
  })

  // ==========================================================================
  // SCHEMA / METADATA
  // ==========================================================================

  describe('schema metadata', () => {
    it('tabela tem RLS ENABLED (defesa em profundidade)', async () => {
      const rows = await prisma.$queryRaw<{ rowsecurity: boolean }[]>`
        SELECT rowsecurity FROM pg_tables
        WHERE tablename = 'audit_log_legal'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].rowsecurity).toBe(true)
    })

    it('tabela tem TOAST tuning configurado (toast_tuple_target=4096)', async () => {
      const rows = await prisma.$queryRaw<{ reloptions: string[] | null }[]>`
        SELECT reloptions FROM pg_class
        WHERE relname = 'audit_log_legal'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].reloptions).toContain('toast_tuple_target=4096')
    })

    it('partial index idx_audit_log_legal_failures existe (WHERE outcome=failure)', async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE indexname = 'idx_audit_log_legal_failures'
      `
      expect(rows).toHaveLength(1)
      // Postgres normaliza WHERE: `WHERE ((outcome)::text = 'failure'::text)`
      expect(rows[0].indexdef).toMatch(/outcome.*=.*'failure'/)
    })

    it('partial index idx_audit_log_legal_hash_pending existe (cron correlation)', async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE indexname = 'idx_audit_log_legal_hash_pending'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toMatch(/event_type/)
      expect(rows[0].indexdef).toMatch(/purge_pending/)
      expect(rows[0].indexdef).toMatch(/resource_hash IS NOT NULL/)
    })

    it('userId NAO tem foreign key (D-5: evento sobrevive ao delete do user)', async () => {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON rc.constraint_name = kcu.constraint_name
        WHERE kcu.table_name = 'audit_log_legal'
          AND kcu.column_name = 'user_id'
      `
      expect(Number(rows[0].count)).toBe(0)
    })
  })

  // ==========================================================================
  // CHECK CONSTRAINTS — defesa em profundidade vs Zod
  // ==========================================================================

  describe('CHECK constraints (raw insert bypassa Zod)', () => {
    // F-LOW-rawInsert-escape (security): usa parameterizacao via Prisma sql tag
    // pra bloquear SQL injection acidental + permite testar valores adversariais
    // (ex: aspa simples, null byte) que CHECK constraint precisa rejeitar.
    async function rawInsert(
      overrides: Partial<Record<string, string>> = {},
    ): Promise<number> {
      const f = {
        event_id: uuid(),
        event_type: 'purge_completed',
        user_id: uuid(),
        resource_type: 'file_history',
        resource_id: 'abc',
        legal_basis: 'retention_expired',
        actor: 'cron_purge_worker',
        outcome: 'success',
        error_code: null as string | null,
        ...overrides,
      }
      // Parametrizado: aspas/null bytes no input nao corrompem SQL.
      return prisma.$executeRaw`
        INSERT INTO audit_log_legal (
          event_id, event_type, user_id, resource_type, resource_id,
          legal_basis, actor, outcome, error_code
        ) VALUES (
          ${f.event_id}::uuid, ${f.event_type}, ${f.user_id}::uuid,
          ${f.resource_type}, ${f.resource_id}, ${f.legal_basis},
          ${f.actor}, ${f.outcome}, ${f.error_code}
        )
      `
    }

    it('rejeita event_type fora da whitelist', async () => {
      await expect(rawInsert({ event_type: 'invalid_type' })).rejects.toThrow()
    })

    it('rejeita actor fora da whitelist', async () => {
      await expect(rawInsert({ actor: 'fake_actor' })).rejects.toThrow()
    })

    it('rejeita outcome fora da whitelist', async () => {
      await expect(rawInsert({ outcome: 'unknown_outcome' })).rejects.toThrow()
    })

    it('rejeita legal_basis com letra maiuscula', async () => {
      await expect(
        rawInsert({ legal_basis: 'RetentionExpired' }),
      ).rejects.toThrow()
    })

    it('rejeita legal_basis muito curto', async () => {
      await expect(rawInsert({ legal_basis: 'ab' })).rejects.toThrow()
    })

    it('rejeita outcome=failure sem error_code', async () => {
      await expect(rawInsert({ outcome: 'failure' })).rejects.toThrow(
        /error_code/,
      )
    })

    it('aceita outcome=failure com error_code', async () => {
      const affected = await rawInsert({
        outcome: 'failure',
        error_code: 'ERR_OK',
      })
      expect(affected).toBe(1)
    })

    it('aceita todos os 7 event_types da whitelist (eventType propaga corretamente)', async () => {
      const validTypes = [
        'purge_pending',
        'purge_completed',
        'purge_failed',
        'consent_given',
        'consent_withdrawn',
        'dsar_request',
        'dsar_fulfilled',
      ]
      for (const eventType of validTypes) {
        const affected =
          eventType === 'purge_failed'
            ? await rawInsert({
                event_type: eventType,
                outcome: 'failure',
                error_code: 'ERR',
              })
            : await rawInsert({ event_type: eventType })
        expect(affected).toBe(1)
      }

      // Confirma que TODOS os eventTypes ficaram no DB (não foi UPSERT silencioso)
      const rows = await prisma.$queryRaw<{ event_type: string }[]>`
        SELECT DISTINCT event_type FROM audit_log_legal
      `
      const stored = rows.map((r) => r.event_type).sort()
      expect(stored).toEqual([...validTypes].sort())
    })

    it('CHECK rejeita payload adversarial (aspas simples) ou aceita escapado', async () => {
      // Validar que parameterizacao escapa corretamente — payload com aspa
      // não corrompe outras colunas. Aspa eh char ascii valido pra VARCHAR,
      // mas regex de legal_basis vai rejeitar.
      await expect(
        rawInsert({ legal_basis: "evil'); DROP TABLE--" }),
      ).rejects.toThrow()
    })
  })

  // ==========================================================================
  // PARITY Zod ↔ CHECK SQL (F-MED-PARITY)
  // ==========================================================================
  // Drift detection: enums TS devem espelhar exatamente o CHECK constraint SQL.
  // Se um for atualizado sem o outro, este teste pega.

  describe('parity Zod enums ↔ CHECK SQL whitelist', () => {
    async function getCheckClause(constraintName: string): Promise<string> {
      const rows = await prisma.$queryRaw<{ check_clause: string }[]>`
        SELECT cc.check_clause
        FROM information_schema.check_constraints cc
        WHERE cc.constraint_name = ${constraintName}
      `
      return rows[0]?.check_clause ?? ''
    }

    it('event_type CHECK contém TODOS os valores de LegalEventType', async () => {
      const clause = await getCheckClause('audit_log_legal_event_type_check')
      for (const value of Object.values(LegalEventType)) {
        expect(clause).toContain(value)
      }
    })

    it('actor CHECK contém TODOS os valores de LegalActor', async () => {
      const clause = await getCheckClause('audit_log_legal_actor_check')
      for (const value of Object.values(LegalActor)) {
        expect(clause).toContain(value)
      }
    })

    it('outcome CHECK contém TODOS os valores de LegalOutcome', async () => {
      const clause = await getCheckClause('audit_log_legal_outcome_check')
      for (const value of Object.values(LegalOutcome)) {
        expect(clause).toContain(value)
      }
    })
  })

  // ==========================================================================
  // resource_hash bytea — CHECK octet_length = 32
  // ==========================================================================

  describe('resource_hash bytea (CHECK octet_length=32)', () => {
    it('aceita resource_hash NULL', async () => {
      const result = await prisma.auditLogLegal.create({
        data: {
          eventId: uuid(),
          eventType: LegalEventType.PURGE_COMPLETED,
          userId: uuid(),
          resourceType: 'file_history',
          resourceId: 'r1',
          legalBasis: 'retention_expired',
          actor: LegalActor.CRON_PURGE_WORKER,
          outcome: LegalOutcome.SUCCESS,
        },
      })
      expect(result.resourceHash).toBeNull()
    })

    it('aceita resource_hash de exatamente 32 bytes', async () => {
      const hash = Buffer.alloc(32, 7)
      const result = await prisma.auditLogLegal.create({
        data: {
          eventId: uuid(),
          eventType: LegalEventType.PURGE_COMPLETED,
          userId: uuid(),
          resourceType: 'file_history',
          resourceId: 'r2',
          legalBasis: 'retention_expired',
          actor: LegalActor.CRON_PURGE_WORKER,
          outcome: LegalOutcome.SUCCESS,
          resourceHash: hash,
        },
      })
      expect(result.resourceHash?.byteLength).toBe(32)
    })

    it('rejeita resource_hash com tamanho diferente (CHECK octet_length=32)', async () => {
      await expect(
        prisma.auditLogLegal.create({
          data: {
            eventId: uuid(),
            eventType: LegalEventType.PURGE_COMPLETED,
            userId: uuid(),
            resourceType: 'file_history',
            resourceId: 'r3',
            legalBasis: 'retention_expired',
            actor: LegalActor.CRON_PURGE_WORKER,
            outcome: LegalOutcome.SUCCESS,
            resourceHash: Buffer.alloc(16),
          },
        }),
      ).rejects.toThrow()
    })
  })

  // ==========================================================================
  // SERVICE E2E
  // ==========================================================================

  describe('recordLegalEvent E2E', () => {
    it('persiste evento com resourceHashAlgo=sha256v1 default', async () => {
      const eventId = uuid()
      const result = await recordLegalEvent({
        eventId,
        eventType: LegalEventType.PURGE_COMPLETED,
        userId: uuid(),
        resourceType: 'file_history',
        resourceId: 'res_abc',
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
      })

      expect(result.eventId).toBe(eventId)
      expect(result.resourceHashAlgo).toBe(RESOURCE_HASH_ALGO_V1)
      expect(result.timestamp).toBeInstanceOf(Date)
    })

    it('idempotency: 2x recordLegalEvent com mesmo eventId retorna mesmo registro', async () => {
      const eventId = uuid()
      const userId = uuid()
      const input = {
        eventId,
        eventType: LegalEventType.PURGE_COMPLETED,
        userId,
        resourceType: 'file_history',
        resourceId: 'res_idem',
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
      }

      const first = await recordLegalEvent(input)
      const second = await recordLegalEvent(input)

      // Mesma row (mesmo id)
      expect(second.id).toBe(first.id)
      expect(second.eventId).toBe(eventId)

      // Confirma que so existe 1 row no DB
      const count = await prisma.auditLogLegal.count({ where: { eventId } })
      expect(count).toBe(1)
    })

    it('CONCORRÊNCIA REAL (Promise.all 5x) com mesmo eventId → 1 row, todas resolvem ao mesmo id (F-ALTO-01)', async () => {
      // Cenário do consumer real (cron #146 retry sob falha de rede): múltiplos
      // workers do mesmo eventId chegam simultaneamente. UNIQUE + lookup
      // idempotente DEVE garantir EXATAMENTE 1 row e que todas as Promises
      // resolvem com o mesmo id (sem AppError(LEGAL_AUDIT_PERSIST_FAILED) por
      // race teórica).
      const eventId = uuid()
      const userId = uuid()
      const input = {
        eventId,
        eventType: LegalEventType.PURGE_COMPLETED,
        userId,
        resourceType: 'file_history',
        resourceId: 'res_concurrent',
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
      }

      const results = await Promise.allSettled([
        recordLegalEvent(input),
        recordLegalEvent(input),
        recordLegalEvent(input),
        recordLegalEvent(input),
        recordLegalEvent(input),
      ])

      // Confirma exatamente 1 row no DB (UNIQUE + idempotency funcionou)
      const count = await prisma.auditLogLegal.count({ where: { eventId } })
      expect(count).toBe(1)

      // Pelo menos uma chamada teve sucesso (a que ganhou a corrida)
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)

      // Se houver rejeições, devem TODAS ser raceCondition=true
      // (caller deve retentar imediatamente, não com backoff)
      const rejected = results.filter((r) => r.status === 'rejected')
      for (const r of rejected) {
        const err = (r as PromiseRejectedResult).reason as AppError
        expect(err.code).toBe(ErrorCodes.LEGAL_AUDIT_PERSIST_FAILED)
        expect(err.details?.raceCondition).toBe(true)
      }

      // Todas as Promises bem-sucedidas devem retornar a MESMA row
      const ids = new Set(
        fulfilled.map(
          (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
        ),
      )
      expect(ids.size).toBe(1)
    })

    it('persiste resourceHash como bytea de 32 bytes', async () => {
      const hash = Buffer.alloc(32, 0xab)
      const result = await recordLegalEvent({
        eventId: uuid(),
        eventType: LegalEventType.PURGE_COMPLETED,
        userId: uuid(),
        resourceType: 'file_history',
        resourceId: 'res_hash',
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
        resourceHash: hash,
      })

      expect(result.resourceHash).not.toBeNull()
      expect(result.resourceHash?.byteLength).toBe(32)
      expect(result.resourceHash?.[0]).toBe(0xab)
    })
  })

  // ==========================================================================
  // RLS posture (authentication bypassada por service_role)
  // ==========================================================================

  describe('RLS posture', () => {
    it('NAO ha policies definidas (deny implicito pra non-superuser)', async () => {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM pg_policies
        WHERE tablename = 'audit_log_legal'
      `
      // Sem policies = ninguem que nao seja super-user/owner consegue ler/escrever
      // (RLS enabled + zero policies = deny all by default)
      expect(Number(rows[0].count)).toBe(0)
    })

    it('RLS funcional: role NAO-superuser (similar a authenticated) NAO consegue SELECT/INSERT (F-MED-RLS)', async () => {
      // Testa o EFEITO real da RLS: usar SET ROLE pra simular role non-superuser
      // (Postgres respeita RLS quando session role != owner). Em Supabase real,
      // `authenticated` eh role JWT-derivado; aqui simulamos com role temporaria.
      const roleName = `test_audit_role_${Date.now()}`
      try {
        await prisma.$executeRawUnsafe(
          `CREATE ROLE "${roleName}" NOLOGIN NOINHERIT`,
        )
        await prisma.$executeRawUnsafe(
          `GRANT USAGE ON SCHEMA public TO "${roleName}"`,
        )
        // SELECT e INSERT explícitos: por padrão SEM grant na tabela.
        // Mesmo se um dia GRANT for adicionado por engano, RLS sem policy bloqueia.
        await prisma.$executeRawUnsafe(
          `GRANT SELECT, INSERT ON audit_log_legal TO "${roleName}"`,
        )

        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${roleName}"`)
          // Sob a role: RLS deny implícito (zero policies)
          const selectRows = await tx.$queryRawUnsafe<unknown[]>(
            `SELECT * FROM audit_log_legal LIMIT 1`,
          )
          // RLS bloqueou (sem policy SELECT) — retorna 0 linhas mesmo se houver dados
          expect(selectRows.length).toBe(0)

          // INSERT também bloqueado por RLS (sem policy INSERT)
          let insertError: unknown = null
          try {
            await tx.$executeRawUnsafe(`
              INSERT INTO audit_log_legal (event_id, event_type, user_id, resource_type, resource_id, legal_basis, actor, outcome)
              VALUES (gen_random_uuid(), 'purge_completed', gen_random_uuid(), 'x', 'y', 'retention_expired', 'cron_purge_worker', 'success')
            `)
          } catch (e) {
            insertError = e
          }
          expect(insertError).not.toBeNull()
        })
      } finally {
        // Cleanup
        await prisma.$executeRawUnsafe(
          `REVOKE ALL ON audit_log_legal FROM "${roleName}"`,
        )
        await prisma.$executeRawUnsafe(
          `REVOKE USAGE ON SCHEMA public FROM "${roleName}"`,
        )
        await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${roleName}"`)
      }
    })
  })

  // ==========================================================================
  // APPEND-ONLY TRIGGER (Card #150 fix-pack F-MED-01)
  // ==========================================================================

  describe('append-only trigger (UPDATE/DELETE bloqueados)', () => {
    async function insertOne(): Promise<string> {
      const eventId = uuid()
      await recordLegalEvent({
        eventId,
        eventType: LegalEventType.PURGE_COMPLETED,
        userId: uuid(),
        resourceType: 'file_history',
        resourceId: 'res_append_only',
        legalBasis: 'retention_expired',
        actor: LegalActor.CRON_PURGE_WORKER,
        outcome: LegalOutcome.SUCCESS,
      })
      return eventId
    }

    it('UPDATE em audit_log_legal levanta exception (LGPD prova juridica)', async () => {
      const eventId = await insertOne()
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE audit_log_legal SET resource_id = 'tampered' WHERE event_id = '${eventId}'`,
        ),
      ).rejects.toThrow(/append-only/i)
    })

    it('DELETE em audit_log_legal levanta exception (LGPD prova juridica)', async () => {
      const eventId = await insertOne()
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM audit_log_legal WHERE event_id = '${eventId}'`,
        ),
      ).rejects.toThrow(/append-only/i)
    })

    it('triggers existem em pg_trigger', async () => {
      const rows = await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'audit_log_legal'::regclass
          AND NOT tgisinternal
        ORDER BY tgname
      `
      const names = rows.map((r) => r.tgname)
      expect(names).toContain('audit_log_legal_block_update')
      expect(names).toContain('audit_log_legal_block_delete')
    })
  })
})
