-- Migration: card3_b_uuid_native_full
-- Version: 20260424120100
-- Card: Fase 3 — Hardening de schema (Migration B de 3)
--
-- Contexto:
--   PKs e user_id FKs de User/Session/Token/Usage/Job nasceram como
--   TEXT NOT NULL DEFAULT gen_random_uuid() por geração inicial do
--   Prisma (`@default(uuid())` gera no app + DEFAULT gen_random_uuid()
--   no DB). Drift latente: app produz UUID v4 string, DB também produz
--   UUID válido — formatos compatíveis hoje, mas semântica divergente.
--   Card 2.4 (audit_log_uuid_native) corrigiu o mesmo padrão para
--   audit_log; este card replica o tratamento para as 5 tabelas
--   restantes que ainda armazenam UUID em coluna TEXT.
--
-- Objetivo:
--   Converter PKs e FKs (id, user_id) de TEXT → uuid nativo em
--   User/Session/Token/Usage/Job. Schema Prisma simultaneamente
--   atualizado para `@db.Uuid + @default(dbgenerated("gen_random_uuid()"))`
--   na MESMA branch (DB é SSOT do UUID; app nunca mais gera).
--
-- Segurança da conversão:
--   - Tabelas VAZIAS (validado pré-migração: 0 linhas em cada).
--   - Cast TEXT → uuid em valores hipotéticos é total (gen_random_uuid
--     produz UUIDv4 sempre válido). Tabela vazia = sem cast a executar
--     no momento — operação é metadata-only.
--   - PostgreSQL DDL é transacional. Falha em qualquer ALTER dentro
--     do BEGIN/COMMIT reverte TODO o bloco — sem estado intermediário
--     visível, sem FK órfã.
--
-- Estratégia (transação única, ordem precisa):
--   1. DROP CONSTRAINT em todas as 4 FKs que referenciam users.id
--      (sessions, tokens, usage, jobs).
--   2. ALTER COLUMN TYPE uuid + SET DEFAULT gen_random_uuid() na PK
--      pai (users.id).
--   3. ALTER COLUMN TYPE uuid em todos os user_id (FKs filhas).
--   4. ALTER COLUMN TYPE uuid + SET DEFAULT gen_random_uuid() em todas
--      as PKs filhas (sessions/tokens/usage/jobs.id).
--   5. ADD CONSTRAINT recriando as 4 FKs com tipos novos compatíveis.
--
-- Guardrails:
--   - lock_timeout = 5s: falha rápida em lock conflict.
--   - statement_timeout = 120s: cap superior generoso (operação real
--     esperada: <2s em tabelas vazias).
--   - SET LOCAL aplica apenas dentro da transação — sem efeito
--     colateral em sessões subsequentes.
--
-- Pós-migration:
--   - ANALYZE nas 5 tabelas para refresh de estatísticas (rápido em
--     tabela vazia mas é boa higiene).
--   - Schema Prisma deve estar atualizado e mergeado na MESMA entrega
--     (drift CRÍTICO se sair só o SQL — finding [CRÍTICO] do @devops).
--   - tests/fixtures/schema.sql regenerada via test:schema:verify.
--
-- Rollback:
--   Reversível via SQL simétrico (ALTER TYPE text USING id::text +
--   recreate FKs). Procedimento completo em
--   docs/runbooks/database-rollback.md. Em tabelas vazias, rollback
--   também é metadata-only.
--
-- @owner: @dba + @devops
-- @cards: Fase 3 (descoberta em auditoria pré-go-live)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ===========================================================================
-- 1. DROP CONSTRAINT — todas as FKs que apontam para users.id
-- ===========================================================================
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";
ALTER TABLE "tokens"   DROP CONSTRAINT "tokens_user_id_fkey";
ALTER TABLE "usage"    DROP CONSTRAINT "usage_user_id_fkey";
ALTER TABLE "jobs"     DROP CONSTRAINT "jobs_user_id_fkey";

-- ===========================================================================
-- 2. PK pai: users.id (TEXT → uuid)
-- ===========================================================================
ALTER TABLE "users"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- ===========================================================================
-- 3. FKs filhas: *.user_id (TEXT → uuid)
-- ===========================================================================
ALTER TABLE "sessions" ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "tokens"   ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "usage"    ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;
ALTER TABLE "jobs"     ALTER COLUMN "user_id" TYPE uuid USING "user_id"::uuid;

-- ===========================================================================
-- 4. PKs filhas: sessions/tokens/usage/jobs.id (TEXT → uuid)
-- ===========================================================================
ALTER TABLE "sessions"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "tokens"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "usage"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

ALTER TABLE "jobs"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid,
  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- ===========================================================================
-- 5. RECREATE FKs — tipos compatíveis (uuid → uuid), preservar ON UPDATE/DELETE
-- ===========================================================================
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE  ON UPDATE CASCADE;

ALTER TABLE "tokens"
  ADD CONSTRAINT "tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "usage"
  ADD CONSTRAINT "usage_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE  ON UPDATE CASCADE;

-- ===========================================================================
-- 6. Refresh de estatísticas (dentro da transação para atomicidade)
--    ALTER TYPE invalida stats; rodar ANALYZE já garante stats coerentes
--    no mesmo commit. Em tabela vazia é <10ms por tabela, sem risco de
--    estourar statement_timeout=120s. Decisão do @dba em 2026-04-24.
-- ===========================================================================
ANALYZE "users", "sessions", "tokens", "usage", "jobs";

COMMIT;

-- Validação:
--
--   SELECT table_name, column_name, data_type, udt_name
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name IN ('users','sessions','tokens','usage','jobs')
--     AND column_name IN ('id','user_id')
--   ORDER BY table_name, column_name;
--
--   Esperado: data_type='uuid', udt_name='uuid' em TODAS as linhas.
--
--   SELECT conname, conrelid::regclass, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE contype = 'f' AND confrelid = 'public.users'::regclass;
--
--   Esperado: 4 FKs de volta (sessions/tokens/usage/jobs → users(id)).
