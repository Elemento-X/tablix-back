-- Migration: add_audit_log
-- Version: 20260419230228
-- Card: 2.4 — Auditoria de eventos criticos (tabela audit_log)
--
-- Contexto:
--   OWASP A09 (Security Logging and Monitoring Failures).
--   Tabela forense para investigacao post-mortem: quem fez o que, quando, de onde.
--   Emissao fire-and-forget via src/lib/audit/audit.service.ts com redundancia
--   tripla (Prisma + Sentry breadcrumb + pino log).
--
-- Decisoes (consolidadas com @dba, 2026-04-19):
--   1. CONCURRENTLY nao usado: tabela nasce vazia, build de indice e instantaneo.
--      Quando a tabela crescer (meses 2+), QUALQUER indice novo deve usar
--      CONCURRENTLY em migration separada.
--   2. Indice composto [actor, created_at DESC] substitui indice simples em actor
--      (query dominante: "ultimos N eventos do ator X").
--   3. Indice parcial WHERE success = false otimiza queries de investigacao
--      (visualizar somente falhas recentes = padrao de ataque).
--   4. CHECK constraint em action: defesa em profundidade contra injecao de
--      action arbitraria. Enum do TS normaliza no app, CHECK valida no banco.
--   5. VARCHAR(50) em action: folga para 11 eventos propostos (max 23 chars).
--   6. actor nullable: webhooks/crons podem nao ter actor definido.
--   7. Retencao 90 dias: via job externo (nao implementado neste card).

-- ===========================================
-- TABELA audit_log
-- ===========================================

CREATE TABLE "audit_log" (
  "id"         TEXT         NOT NULL DEFAULT gen_random_uuid(),
  "action"     VARCHAR(50)  NOT NULL,
  "actor"      VARCHAR(255),
  "ip"         VARCHAR(45),
  "user_agent" VARCHAR(512),
  "success"    BOOLEAN      NOT NULL,
  "metadata"   JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- ===========================================
-- CHECK CONSTRAINT (defesa em profundidade)
-- ===========================================

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_action_format_check"
  CHECK ("action" ~ '^[A-Z_]+$' AND length("action") BETWEEN 3 AND 50);

-- ===========================================
-- INDICES
-- ===========================================

-- Busca por tipo de evento (ex: "todos os WEBHOOK_SIGNATURE_FAILED")
CREATE INDEX "idx_audit_log_action"
  ON "audit_log" ("action");

-- Query dominante: "ultimos N eventos do ator X" (dashboard forense)
CREATE INDEX "idx_audit_log_actor_created_at"
  ON "audit_log" ("actor", "created_at" DESC);

-- Query de retencao/timeline: "eventos nas ultimas 24h"
CREATE INDEX "idx_audit_log_created_at"
  ON "audit_log" ("created_at");

-- Indice parcial: otimiza investigacao de falhas (padrao de ataque)
-- Muito mais seletivo que indice em success isolado (boolean cardinal baixo)
CREATE INDEX "idx_audit_log_failures"
  ON "audit_log" ("created_at" DESC)
  WHERE "success" = false;
