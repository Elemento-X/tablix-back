-- Card #147 (5.2c) F1 — RLS service-role only para quota_alerts_sent.
--
-- Cron + admin operam via service-role (bypass RLS implícito do Supabase/Prisma
-- direct connection). Nenhum user-context tem acesso — alertas são metadata
-- interna do sistema de notificação, não dado consumível pelo usuário final.
--
-- User pode ver suas próprias quotas via GET /usage do Card 4.1 (`usage` table
-- tem RLS user-scoped). Este histórico de alertas enviados é puramente ops.
--
-- Pattern: deny-all para public/authenticated. Service-role (chave secret no env)
-- não passa por RLS — bypass implícito.
--
-- @owner: @dba + @security
-- @card: #147 (5.2c) F1 — T-1.3

ALTER TABLE quota_alerts_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY quota_alerts_service_role_only ON quota_alerts_sent
  FOR ALL
  TO public
  USING (false)
  WITH CHECK (false);

COMMENT ON POLICY quota_alerts_service_role_only ON quota_alerts_sent IS
  'Deny-all pra public/authenticated. Service-role (Prisma direct connection) bypass RLS implícito — não precisa de policy explícita pra ALLOW.';
