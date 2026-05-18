-- Card #147 (5.2c) fix-pack ciclo 1 — alinhamento da regex de `period` com
-- pattern do projeto (ASCII-only `[0-9]` em vez de `\d` POSIX ARE).
--
-- @security BAIXO (fingerprint c2e9a48d1037): outros CHECKs do projeto
-- (audit_log, file_history, cron_runs) usam `[0-9]`. `\d` no PostgreSQL ARE
-- inclui Unicode digits (Devanagari, Arabic-Indic) — exploit teórico se
-- caller futuro passar string Unicode digit (atualmente impossível: único
-- caller é getCurrentPeriod() retornando ASCII via padStart).
--
-- Risco real = zero hoje. Mudança alinha pattern + previne drift futuro.
--
-- @owner: @security + @dba
-- @card: #147 fix-pack ciclo 1

ALTER TABLE quota_alerts_sent
  DROP CONSTRAINT quota_alerts_period_format_check;

ALTER TABLE quota_alerts_sent
  ADD CONSTRAINT quota_alerts_period_format_check
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

COMMENT ON CONSTRAINT quota_alerts_period_format_check
  ON quota_alerts_sent IS
  'Period YYYY-MM ASCII-only (pattern do projeto). Card #147 fix-pack ciclo 1.';
