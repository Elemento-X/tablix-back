-- Migration: audit_log_uuid_native
-- Version: 20260420115000
-- Card: 2.4 — Fix @dba ALTO: drift entre schema Prisma e DB
--
-- Contexto:
--   Migration original (20260419230228) criou id como TEXT DEFAULT
--   gen_random_uuid(). Prisma schema declarava `@default(uuid())`, que
--   gera o UUID no app. Drift silencioso: inserts via Prisma usam UUID
--   do app; inserts via SQL direto usam gen_random_uuid(). Semântica
--   divergente é bomba-relógio forense.
--
-- Solução:
--   1. Converter coluna id para UUID nativo (16 bytes vs 36 bytes de
--      TEXT — índices mais rápidos, menor footprint).
--   2. Schema Prisma passa a declarar `@default(dbgenerated(...))`
--      + `@db.Uuid` — DB é SSOT do UUID, app nunca gera.
--
-- Segurança da conversão:
--   - Tabela audit_log nasceu vazia (card acabou de mergear).
--   - gen_random_uuid() sempre produz string UUID válida — cast é total.
--   - Operação rápida: sem necessidade de CONCURRENTLY.
--
-- @owner: @dba

ALTER TABLE "audit_log"
  ALTER COLUMN "id" TYPE uuid USING "id"::uuid;

-- Defesa extra: força TOAST tuple target maior pra acomodar metadata
-- de até 2KB inline sem pagar o custo de out-of-line storage. O default
-- do Postgres (2032 bytes) faz rows com metadata > ~1500 bytes irem
-- pra TOAST, triplicando tempo de INSERT. Subimos pra 4096 pra casar
-- com o app cap original de 4KB, mas o app reduziu pra 1KB em defense
-- in depth (ver src/lib/audit/audit.service.ts).
ALTER TABLE "audit_log" SET (toast_tuple_target = 4096);
