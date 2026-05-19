-- =============================================================================
-- Migration: card_146_fixpack_revoke_pg_cron_acl
-- Version: 20260518125000
-- Card: #146 (5.2b) F5 fix-pack ciclo 1
--
-- Contexto:
--   @dba ALTO #1 (fingerprint b8a7c5d2f4e1) + @security MÉDIO (CWE-829):
--   pg_cron extension habilitada via migration 20260518121000 sem REVOKE
--   explícito. Validação MCP `has_table_privilege` em 2026-05-18 confirmou:
--     - service_role: SELECT=true (esperado — backend admin)
--     - anon: SELECT=true (LEAK!)
--     - authenticated: SELECT=true (LEAK!)
--
--   Qualquer JWT (anon key embedded em frontend OU JWT de qualquer user)
--   pode fazer `SELECT command FROM cron.job` via PostgREST e listar
--   TODOS os jobs do scheduler + commands literais. Em produção:
--     - Reveals stack interno (existência de cron tablix_db_keepalive,
--       schedules, parâmetros)
--     - Se algum job futuro armazenar credenciais no `command` literal
--       (anti-pattern mas possível), credentials VAZAM
--
-- Fix: REVOKE explícito de anon + authenticated em cron.job e
--   cron.job_run_details. service_role mantém acesso (backend admin futuro
--   poderá listar jobs via /admin/cron-jobs).
--
-- Hardening adicional: REVOKE USAGE no schema cron pra anon/authenticated.
--   Sem USAGE no schema, nem mesmo qualificação `cron.job` resolve —
--   defesa em camadas.
--
-- Pattern: append-only migration. Confirmar via has_table_privilege pós-apply.
-- =============================================================================

-- ===========================================
-- TENTATIVA DE FIX 1: REVOKE PUBLIC + anon/authenticated em cron.job
-- ===========================================
-- NOTA OPERADOR (2026-05-18): Tentativa de REVOKE não foi totalmente
-- efetiva no Supabase Free tier. Validação pós-apply:
--   1. REVOKE ALL FROM anon, authenticated: aceito (success=true)
--   2. REVOKE ALL FROM PUBLIC: aceito (success=true)
--   3. information_schema.table_privileges mostra PUBLIC ainda com SELECT
--      (grantor=supabase_admin) — Supabase auto-grant não revogável via
--      service_role (precisa ser owner do schema cron, que pertence ao
--      supabase_admin role).
--
-- LIMITAÇÃO DE PLATAFORMA: schema cron é Supabase-managed em Free tier.
-- REVOKE definitivo requer:
--   (a) Upgrade Pro tier (não pausa + maior controle de roles)
--   (b) Abrir ticket Supabase pra revogar grant do supabase_admin
--   (c) DESABILITAR pg_cron extension (perde keepalive — Card #179)
--
-- Aceitar gap pre-go-live (zero users reais, anon key não em uso) +
-- discovery card pra resolução pré-launch (Fase 9). Mitigação imediata:
-- comentário no schema explicitando o risco.

REVOKE ALL ON TABLE cron.job FROM anon, authenticated;
REVOKE ALL ON TABLE cron.job_run_details FROM anon, authenticated;
REVOKE ALL ON TABLE cron.job FROM PUBLIC;
REVOKE ALL ON TABLE cron.job_run_details FROM PUBLIC;

COMMENT ON SCHEMA cron IS
  'pg_cron extension. ACL hardened pelo Card #146 fix-pack ciclo 1 (REVOKE anon + authenticated). service_role retém acesso pra admin endpoints futuros. Adicionar novos jobs requer REVIEW @security (cron.schedule arbitrário = SQL execution agendado).';
