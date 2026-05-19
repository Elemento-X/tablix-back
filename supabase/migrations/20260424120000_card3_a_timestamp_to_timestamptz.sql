-- Migration: card3_a_timestamp_to_timestamptz
-- Version: 20260424120000
-- Card: Fase 3 — Hardening de schema (Migration A de 3)
--
-- Contexto:
--   Tabelas users/sessions/tokens/usage/jobs nasceram com TIMESTAMP(3)
--   (sem TZ) por geração default do Prisma. Servidor Postgres roda em
--   UTC (current_setting('timezone') = 'UTC' validado pré-migração).
--   Aplicação SEMPRE escreveu valores em UTC. stripe_events e audit_log
--   já são TIMESTAMPTZ (corrigidos em cards anteriores).
--
-- Objetivo:
--   Converter colunas de tempo das 5 tabelas para TIMESTAMPTZ(3) para
--   eliminar ambiguidade temporal e casar com o padrão estabelecido nas
--   outras 2 tabelas (consistência).
--
-- Segurança da conversão:
--   - 5 tabelas estão VAZIAS no momento (validado via SELECT count(*)
--     pré-migração: users=0, sessions=0, tokens=0, usage=0, jobs=0).
--   - ALTER COLUMN TYPE em tabela vazia é metadata-only — sem rewrite
--     pesado, lock ACCESS EXCLUSIVE adquirido por milissegundos apenas.
--   - SET TIME ZONE 'UTC' explícito no início garante semântica
--     determinística independente da TZ default da sessão MCP.
--   - USING (col AT TIME ZONE 'UTC') interpreta valor existente como
--     UTC (correto, app sempre gravou UTC) e converte para timestamptz.
--   - SET DEFAULT CURRENT_TIMESTAMP após o ALTER TYPE evita que o
--     catalog registre o DEFAULT na forma castada (drift no próximo
--     prisma db pull).
--
-- Guardrails:
--   - lock_timeout = 5s: falha rápida se houver lock conflict (evita
--     migration travada indefinidamente).
--   - statement_timeout = 60s: cap superior generoso para tabela vazia
--     (operação real esperada: <1s total).
--   - Tudo em transação única (BEGIN/COMMIT) — DDL transacional do PG
--     garante atomicidade. Falha em qualquer ALTER reverte o conjunto.
--
-- Rollback:
--   Reversível via ALTER COLUMN TYPE timestamp(3) USING (col AT TIME
--   ZONE 'UTC'). Em UTC puro a operação inversa preserva valores.
--   Documentação completa em docs/runbooks/database-rollback.md.
--
-- @owner: @dba + @devops
-- @cards: Fase 3 (descoberta em auditoria pré-go-live)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL TIME ZONE 'UTC';

-- ===========================================================================
-- users
-- ===========================================================================
ALTER TABLE "users"
  ALTER COLUMN "created_at" TYPE timestamptz(3) USING ("created_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "updated_at" TYPE timestamptz(3) USING ("updated_at" AT TIME ZONE 'UTC');

ALTER TABLE "users"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ===========================================================================
-- sessions
-- ===========================================================================
ALTER TABLE "sessions"
  ALTER COLUMN "created_at"       TYPE timestamptz(3) USING ("created_at"       AT TIME ZONE 'UTC'),
  ALTER COLUMN "last_activity_at" TYPE timestamptz(3) USING ("last_activity_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "expires_at"       TYPE timestamptz(3) USING ("expires_at"       AT TIME ZONE 'UTC'),
  ALTER COLUMN "revoked_at"       TYPE timestamptz(3) USING ("revoked_at"       AT TIME ZONE 'UTC');

ALTER TABLE "sessions"
  ALTER COLUMN "created_at"       SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "last_activity_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ===========================================================================
-- tokens
-- ===========================================================================
ALTER TABLE "tokens"
  ALTER COLUMN "created_at"   TYPE timestamptz(3) USING ("created_at"   AT TIME ZONE 'UTC'),
  ALTER COLUMN "activated_at" TYPE timestamptz(3) USING ("activated_at" AT TIME ZONE 'UTC'),
  ALTER COLUMN "expires_at"   TYPE timestamptz(3) USING ("expires_at"   AT TIME ZONE 'UTC');

ALTER TABLE "tokens"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ===========================================================================
-- usage
-- ===========================================================================
ALTER TABLE "usage"
  ALTER COLUMN "created_at" TYPE timestamptz(3) USING ("created_at" AT TIME ZONE 'UTC');

ALTER TABLE "usage"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

-- ===========================================================================
-- jobs
-- ===========================================================================
ALTER TABLE "jobs"
  ALTER COLUMN "created_at"   TYPE timestamptz(3) USING ("created_at"   AT TIME ZONE 'UTC'),
  ALTER COLUMN "started_at"   TYPE timestamptz(3) USING ("started_at"   AT TIME ZONE 'UTC'),
  ALTER COLUMN "completed_at" TYPE timestamptz(3) USING ("completed_at" AT TIME ZONE 'UTC');

ALTER TABLE "jobs"
  ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP;

COMMIT;

-- Pós-migration: validação rápida (executar manualmente)
--
--   SELECT table_name, column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name IN ('users','sessions','tokens','usage','jobs')
--     AND column_name LIKE '%_at%'
--   ORDER BY table_name, column_name;
--
--   Esperado: data_type = 'timestamp with time zone' em TODAS as linhas.
