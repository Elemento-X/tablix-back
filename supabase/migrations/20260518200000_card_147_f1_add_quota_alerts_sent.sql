-- Card #147 (5.2c) F1 — Tabela de dedupe de alertas de quota mensal.
--
-- Pattern: UNIQUE(user_id, threshold, period) + INSERT...ON CONFLICT DO NOTHING
-- garante atomicamente "1 alerta por threshold por mês por user" mesmo sob
-- concorrência (crash mid-batch, 2 workers, restart do cron, etc).
--
-- Reset implícito: nova `period` (mês UTC, alinhado com usage.service.getCurrentPeriod)
-- permite reenvio automático sem regra explícita.
--
-- Decisões irreversíveis cobertas (ver plano §11):
--   R-1: threshold INTEGER + CHECK em vez de enum Postgres (drift-free pra
--        adicionar valores no futuro via ALTER simples).
--   R-2: period YYYY-MM mensal, NÃO sliding 24h (alinha com reset de quota).
--
-- LGPD: FK ON DELETE CASCADE — purge user purga histórico de alertas.
--
-- @owner: @dba + @security
-- @card: #147 (5.2c) F1 — T-1.2

CREATE TABLE quota_alerts_sent (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  threshold   INTEGER      NOT NULL,
  period      VARCHAR(7)   NOT NULL,   -- YYYY-MM UTC
  sent_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT quota_alerts_threshold_check
    CHECK (threshold IN (70, 90)),

  CONSTRAINT quota_alerts_period_format_check
    CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),

  CONSTRAINT quota_alerts_unique_user_threshold_period
    UNIQUE (user_id, threshold, period)
);

COMMENT ON TABLE quota_alerts_sent IS
  'Dedupe de alertas de quota mensal (Card #147, 5.2c). 1 row = 1 alerta enviado. UNIQUE(user_id, threshold, period) garante anti-duplicação por user/threshold/mês.';

COMMENT ON COLUMN quota_alerts_sent.threshold IS
  '70 ou 90 (% de uso da quota PRO mensal). CHECK constraint enforça enum-like.';

COMMENT ON COLUMN quota_alerts_sent.period IS
  'YYYY-MM em UTC, alinhado com usage.service.getCurrentPeriod(). Reset mensal natural via period nova → ON CONFLICT DO NOTHING permite reenvio.';

COMMENT ON COLUMN quota_alerts_sent.sent_at IS
  'Timestamp do envio (audit). NOT logged as PII porque user_id já está em logs estruturados.';
