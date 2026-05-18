-- =============================================================================
-- Migration: db_keepalive_pg_cron
-- Version: 20260518121000
-- Card: #179 (Backlog) — keepalive anti auto-pause Supabase free tier
--
-- Contexto:
--   Supabase free tier auto-pausa o projeto após ~7 dias sem atividade no DB.
--   "Atividade" = qualquer query SQL real (health probe HTTP não conta).
--   Pausa = projeto fica dormente, precisa Resume manual no dashboard.
--
--   Solução: pg_cron extension nativa do Supabase roda 1 query trivial a
--   cada 6h DIRETO no Postgres. Independe de app deployado (Fase 7 ainda
--   não chegou) ou container Fly.io. Defesa robusta.
--
-- Decisão operador 2026-05-18: pg_cron > scheduler do app (Card #145 F4)
-- pela razão acima. Trade-off: poluí pg_stat_statements com SELECT NOW()
-- a cada 6h (aceitável).
--
-- DECISÕES IRREVERSÍVEIS:
--
-- (schedule) '0 */6 * * *' UTC = a cada 6h em horários :00. 4 execuções/dia
--       cobre folgado os 7d de threshold do auto-pause. Mais frequente
--       (ex: 1h) é desperdício; menos (24h) reduz margem de segurança.
--
-- (query SELECT NOW()) Mais leve possível, sem efeito colateral. NÃO usar
--       SELECT 1 — algumas implementações de pool reconhecem como ping e
--       NÃO contam como atividade real do DB no Supabase.
--
-- (job name 'tablix_db_keepalive') Prefixo `tablix_` evita colisão com
--       outros jobs pg_cron do mesmo Postgres (se Supabase compartilhar
--       infra entre projetos do free tier no futuro).
--
-- Rollback: ver bloco no final (DROP cron job + DROP extension condicional).
--
-- Refs:
-- - https://supabase.com/docs/guides/database/extensions/pg_cron
-- - https://supabase.com/docs/guides/platform/project-status (auto-pause policy)
-- =============================================================================

-- Habilita pg_cron (idempotente — IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- Agenda job `tablix_db_keepalive` rodando SELECT NOW() a cada 6h em UTC.
-- pg_cron.schedule retorna jobid; idempotente via DELETE+SCHEDULE quando
-- a migration roda em ambiente já configurado.
DO $$
DECLARE
  existing_jobid BIGINT;
BEGIN
  -- Remove job anterior se existir (idempotência da migration).
  SELECT jobid INTO existing_jobid
  FROM cron.job
  WHERE jobname = 'tablix_db_keepalive';

  IF existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(existing_jobid);
  END IF;

  -- Agenda novo job.
  PERFORM cron.schedule(
    'tablix_db_keepalive',
    '0 */6 * * *',  -- a cada 6h em UTC (00:00, 06:00, 12:00, 18:00)
    'SELECT NOW();'
  );
END $$;

COMMENT ON EXTENSION "pg_cron" IS
  'Habilitado pra job tablix_db_keepalive (anti auto-pause Supabase free tier). Card #179.';

-- =============================================================================
-- ROLLBACK (rodar manualmente se precisar reverter):
-- =============================================================================
-- DO $$
-- DECLARE
--   existing_jobid BIGINT;
-- BEGIN
--   SELECT jobid INTO existing_jobid FROM cron.job WHERE jobname = 'tablix_db_keepalive';
--   IF existing_jobid IS NOT NULL THEN PERFORM cron.unschedule(existing_jobid); END IF;
-- END $$;
--
-- -- NÃO DROP EXTENSION pg_cron se outros jobs já dependerem dela.
-- -- Confirmar primeiro: SELECT * FROM cron.job;
-- -- DROP EXTENSION IF EXISTS "pg_cron";
-- =============================================================================
