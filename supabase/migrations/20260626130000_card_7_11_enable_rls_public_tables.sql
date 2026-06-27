-- =============================================================================
-- Card 7.11 (#85) — Habilita RLS deny-all em TODAS as tabelas public
-- Fase 7 — Infra & Deploy — GATE DE PROD (fecha 2 CRÍTICOS do advisor)
-- =============================================================================
-- Estado antes: users, sessions, tokens, usage, jobs, audit_log, stripe_events
-- com RLS OFF e expostas via PostgREST (advisor ERROR rls_disabled_in_public +
-- sensitive_columns_exposed em tokens.token). Vetor real: anon key vazada (é
-- embarcada no frontend por design Supabase) → SELECT * direto.
--
-- Decisão (auditoria @security lead + @dba, 2026-06-26):
--   - HABILITAR RLS + policy deny-all explícita (TO public USING(false)) —
--     padrão da migration #147 quota_alerts_sent. Limpa também o advisor INFO
--     rls_enabled_no_policy das 3 que hoje só têm ENABLE.
--   - SEM FORCE ROW LEVEL SECURITY. Provado empiricamente: o backend conecta
--     como role `postgres` (rolbypassrls=true) e as 4 tabelas já-RLS usam
--     FORCE=false. FORCE aplicaria RLS até ao owner/postgres → QUEBRARIA o
--     backend, sem fechar nenhum vetor a mais (anon nunca é owner).
--   - REVOKE grants anon/authenticated (2a camada; service_role/postgres não
--     são afetados por REVOKE de anon/authenticated).
--   - Fix WARN function_search_path_mutable no guard append-only LGPD.
--
-- Lock: ALTER ENABLE RLS / CREATE POLICY pegam ACCESS EXCLUSIVE metadata-only
-- (sem rewrite/scan). lock_timeout curto evita empilhar fila atrás de query
-- longa em tabela quente. Idempotente (ENABLE é no-op se já ligado;
-- DROP POLICY IF EXISTS guarda o CREATE). Reversível (DISABLE + DROP POLICY).
--
-- @owner: @security + @dba | @card: 7.11 (#85)
-- =============================================================================

SET lock_timeout = '3s';

-- ============================================================
-- 1) As 7 tabelas com RLS OFF → ENABLE + deny-all explícito
-- ============================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_deny_all ON public.users;
CREATE POLICY users_deny_all ON public.users
  FOR ALL TO public USING (false) WITH CHECK (false);

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_deny_all ON public.sessions;
CREATE POLICY sessions_deny_all ON public.sessions
  FOR ALL TO public USING (false) WITH CHECK (false);

-- tokens: PRIORIDADE — coluna `token` (tbx_pro_*, 256 bits) era legível via API.
ALTER TABLE public.tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tokens_deny_all ON public.tokens;
CREATE POLICY tokens_deny_all ON public.tokens
  FOR ALL TO public USING (false) WITH CHECK (false);

ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_deny_all ON public.usage;
CREATE POLICY usage_deny_all ON public.usage
  FOR ALL TO public USING (false) WITH CHECK (false);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS jobs_deny_all ON public.jobs;
CREATE POLICY jobs_deny_all ON public.jobs
  FOR ALL TO public USING (false) WITH CHECK (false);

-- audit_log: trilha forense 90d, SEM trigger append-only → RLS é a barreira.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_deny_all ON public.audit_log;
CREATE POLICY audit_log_deny_all ON public.audit_log
  FOR ALL TO public USING (false) WITH CHECK (false);

-- stripe_events: idempotência de webhook (tampering = reabrir o bug #189).
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_events_deny_all ON public.stripe_events;
CREATE POLICY stripe_events_deny_all ON public.stripe_events
  FOR ALL TO public USING (false) WITH CHECK (false);

-- ============================================================
-- 2) As 3 já-RLS-ON sem policy → deny-all explícito (limpa advisor INFO)
-- ============================================================
DROP POLICY IF EXISTS audit_log_legal_deny_all ON public.audit_log_legal;
CREATE POLICY audit_log_legal_deny_all ON public.audit_log_legal
  FOR ALL TO public USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS cron_runs_deny_all ON public.cron_runs;
CREATE POLICY cron_runs_deny_all ON public.cron_runs
  FOR ALL TO public USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS file_history_dead_letter_deny_all ON public.file_history_dead_letter;
CREATE POLICY file_history_dead_letter_deny_all ON public.file_history_dead_letter
  FOR ALL TO public USING (false) WITH CHECK (false);

-- ============================================================
-- 3) REVOKE grants do PostgREST (anon/authenticated) — defesa em profundidade
-- ============================================================
REVOKE ALL ON TABLE
  public.users, public.sessions, public.tokens, public.usage,
  public.jobs, public.audit_log, public.stripe_events,
  -- simetria: as 3 já-RLS deny-all também (não inclui file_history/quota_alerts_sent,
  -- que têm policy user-scoped TO authenticated por design).
  public.audit_log_legal, public.cron_runs, public.file_history_dead_letter
FROM anon, authenticated;

-- ============================================================
-- 4) Fix WARN function_search_path_mutable (guard append-only audit_log_legal)
--    Corpo idêntico ao atual + SET search_path = '' (seguro: só RAISE EXCEPTION,
--    nenhuma referência a objeto não-qualificado).
-- ============================================================
CREATE OR REPLACE FUNCTION public.block_audit_log_legal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION
    'audit_log_legal is append-only (LGPD prova juridica). UPDATE/DELETE proibidos. Cron de retencao 5 anos (Card #152) usa role dedicada com bypass explicito.'
    USING
      ERRCODE = 'insufficient_privilege',
      HINT = 'Para deletar registros expirados, use o cron #152 com role audit_legal_purge_role.';
END;
$function$;
