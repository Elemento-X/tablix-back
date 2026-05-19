-- Card #147 fix-pack ciclo 2 (followup) — índice parcial para query hot do cron quota-alert.
--
-- @dba ALTO pós-launch (kill criteria documentado: >1k PRO users obrigatório,
-- <100 pré-go-live aceitável). Index aplicado PRÉ-launch como defesa em
-- profundidade — zero risco em tabela vazia + ganho mensurável quando user
-- base crescer (evita seq scan em SELECT users WHERE tokens.status='ACTIVE').
--
-- Pattern partial index (status = 'ACTIVE'): cobertura mínima (subset pequeno
-- esperado), escrita barata, leitura otimizada pro filtro recorrente do cron.
-- `expires_at` fica como filtro post-index (cardinalidade alta, partial não-vale).
--
-- CONCURRENTLY: aplicação sem ACCESS EXCLUSIVE lock (safe em prod).
-- Aplicado via Supabase MCP em 2026-05-18 (tabela tokens com 0 rows PRO ativos).
--
-- @owner: @dba
-- @card: #147 fix-pack ciclo 2 (discovery resolvido)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tokens_active_pro
  ON tokens (user_id, status)
  WHERE status = 'ACTIVE';

COMMENT ON INDEX idx_tokens_active_pro IS
  'Index parcial pra cron quota-alert SELECT users.tokens WHERE status=ACTIVE. Card #147 fix-pack ciclo 2.';
