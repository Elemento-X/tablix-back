# PLANO @planner (v2.1) — 2026-04-28 — card-150-audit-log-legal

**DEMANDA:** Tabela `audit_log_legal` separada com retenção 5 anos (LGPD Art. 16/37 + CDC Art. 27)
**SOLICITANTE:** Operador (cumprindo decisão pré-#145/#146)
**TIPO:** feature (compliance — schema novo + service)
**TAMANHO:** M (1.5–2.5 dias)
**LoC ESTIMADO:** 350–550

---

## 1. Entendimento & contexto

### Reformulação
Criar tabela `audit_log_legal` + service `recordLegalEvent` + migration expand-only + RLS, **separada** do `audit_log` operacional (Card 2.4). Por quê separar: retenção é diferente (5 anos vs 90 dias), audiência é diferente (auditor LGPD vs SRE forense), CHECK constraint de `event_type` é whitelist diferente. **Sem o cron de purga aqui** — só o substrato pra #146 emitir.

### Ambiguidades a resolver com operador (T1)
- **A-1** `actor` é enum fechado (`cron_purge_worker|user_self_service|admin_panel`) ou string livre? → **Recomendo fechado** via CHECK + `as const` no TS.
- **A-4** `eventId` (UUID externo) vem do CALLER ou geramos no service? → **Recomendo caller-fornecido** (idempotency-key style — necessário pra cron retentar sem duplicar).
- **A-5** `resourceHash` é SHA-256 de quê exatamente? → **Recomendo `SHA-256("${userId}:${storagePath}")`** hex 64 chars.

### Valor
Sem #150, #146 (cron purge) bloqueado. Sem `audit_log_legal`, em auditoria LGPD ou disputa judicial (CDC Art. 27 = 5 anos), `purge_completed` pode ter sido apagado pelo cron de retenção 90d do `audit_log` operacional → ônus da prova vira problema do operador.

### Stakeholders
- Solicitante: operador
- Usuário final: cron de purga (#146), futuro DSAR (#147), auditor LGPD
- Aprovador: usuário (Maclean)
- Informados: @dba, @security, @reviewer

---

## 2. Estado atual

### Arquivos lidos
- `prisma/schema.prisma` — model AuditLog (Card 2.4) é template direto
- `src/lib/audit/audit.service.ts` — fire-and-forget + scrubObject + truncate + isIP
- `src/lib/audit/audit.types.ts` — `as const` + union type pattern
- `supabase/migrations/20260419230228_add_audit_log.sql` — CHECK + 4 indexes (1 partial)
- `supabase/migrations/20260426000001_card_5_1_storage_bucket_history.sql` — RLS pattern
- `tests/unit/audit-service.test.ts` — modelo de spec com mocks
- `tests/fixtures/schema.fingerprint.json` — drift detection ativa (Card 32)

### O que existe
- `audit_log` operacional + `emitAuditEvent` fire-and-forget (Card 2.4, 100% testado)
- `scrubObject` SSOT (Card 2.2) — REUSAR, não duplicar
- Padrão `dbgenerated UUID + Timestamptz(3)` consolidado (Fase 3)
- Padrão CHECK constraint defesa em profundidade
- Padrão raw SQL CONCURRENTLY pra indexes em tabelas que vão crescer
- Padrão schema fingerprint regenerado a cada migration (drift test guard)

### Débito no caminho
**Nenhum.** `audit_log` (Card 2.4) já tem postgres TOAST tuning + isIP guard + REDACT propagado.

---

## 3. Impacto

### Arquivos a criar
- `prisma/migrations/<ts>_card_150_add_audit_log_legal/migration.sql`
- `supabase/migrations/<ts>_card_150_add_audit_log_legal.sql` (SSOT documental)
- `src/modules/audit-legal/audit-legal.types.ts`
- `src/modules/audit-legal/audit-legal.service.ts`
- `tests/unit/audit-legal-service.test.ts`
- `tests/integration/audit-legal.integration.test.ts`

### Arquivos a alterar
- `prisma/schema.prisma` (adicionar model AuditLogLegal)
- `tests/fixtures/schema.fingerprint.json` (regenerar)
- `.claude/metrics/categories.json` (checar se `legal-audit-*` precisa categoria nova)

### Blast radius
- Direto: módulo novo isolado em `src/modules/audit-legal/`
- Indireto: futuro #146 importa `recordLegalEvent`; teste de schema-drift recompila

| Aspecto | Avaliação |
|---|---|
| Contrato API | Backward-compat (sem rota HTTP) |
| Schema/migration | SIM (→ @dba mandatório) |
| Infra/deploy | Parcial (RLS via MCP supabase; sem Dockerfile) |
| Performance | Irrelevante pré-volume; índices pré-emptivos |
| Segurança | ALTA — compliance LGPD; @security mandatório |
| i18n/copy | Nenhum |

---

## 4. Assumption log

| ID | Assumption | Confidence | Verificada | Impacto se errada |
|---|---|---|---|---|
| A-1 | `recordLegalEvent` AWAIT (não fire-and-forget) | HIGH | ✅ FECHADA — voto unânime | Cron marca "purged" sem evento gravado |
| A-2 | Tabela vazia ⇒ indexes inline OK (sem CONCURRENTLY) | HIGH | Sim | Zero |
| A-3 | RLS deny-all + grant explícito service_role | MEDIUM | Parcial | User comum lê eventos legais |
| A-4 | `eventId` UUID externo + UNIQUE = idempotency natural | HIGH | ✅ FECHADA — voto unânime | Cron sem retry idempotente duplica |
| A-5 | `resourceHash = SHA-256("${userId}:${storagePath}")` em **bytea 32 bytes** | HIGH | ✅ FECHADA — voto unânime time (security+dba+planner) | Retrabalho em #146 |

## 4.1 Hard requirements adicionais (consulta time A-5, 2026-04-28)

### Do @security
1. **Função pura isolada** em `src/lib/audit-hash.ts`, **freezed como v1** — mudança de fórmula = nova coluna `resourceHashV2`, nunca mutar a v1
2. **Coluna explícita** `resource_hash_algo VARCHAR(8) NOT NULL DEFAULT 'sha256v1'` — permite migração futura sem ambiguidade
3. **Teste unitário com vetor fixo conhecido** — `hash("user-uuid", "user-uuid/file.pdf") === "<hex-fixo>"`. Quebra do teste = quebra de contrato 5 anos
4. **PROIBIDO logar input** da função (userId+path são PII) — sem `logger.debug` na função
5. **COMMENT SQL** na coluna: "Determinístico SHA-256(userId:storagePath). Não reversível. Não rotacionável. Ver src/lib/audit-hash.ts"

### Do @dba
1. **`bytea`** (32 bytes) vs hex (64 chars) — **50% economia** em coluna + índice em 5 anos
2. **Index parcial dedicado** — `CREATE INDEX CONCURRENTLY ix_audit_log_legal_hash_pending ON audit_log_legal(resource_hash) WHERE event_type IN ('purge_pending','purge_completed') AND resource_hash IS NOT NULL` (~5% do volume)
3. **Computar em JS** (SSOT app, evita drift app↔SQL). `pgcrypto` extension habilitada só pra queries forenses ad-hoc
4. **CHECK ajustado**: `(resource_hash IS NULL) OR (octet_length(resource_hash) = 32)`

---

## 5. Risk register

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R-1 | RLS errada expõe eventos legais | M | H | Integration test com `authenticated` + `service_role`; @security audita policy |
| R-2 | Caller esqueceu await silenciosamente | M | H | Assinatura `Promise<AuditLogLegal>`; ESLint `no-floating-promises`; spec testa rejection |
| R-3 | Whitelist desatualiza com #147 (DSAR) | M | M | Comentário em types + checklist em PR review |
| R-4 | `metadata` JSONB aceita PII | M | H | REUSAR `scrubObject` SSOT (Card 2.2); cap 1024 bytes |
| R-5 | Migration sem regenerar schema.fingerprint.json | H | L | Checklist operador (T7) |
| R-6 | 5 anos sem partitioning vira problema em ~2030 | L | M (futuro) | Card discovery N1 no Backlog |
| R-7 | Cron 90d acidentalmente apaga eventos legais | L | H | Comentário GIGANTE no model: "NÃO REUSAR cron audit_log" |
| R-8 | Dev futuro adiciona FK userId por reflexo | M | H | Comentário pesado em D-5; `userId` é STRING intencional sem FK |

---

## 6. Decisões & trade-offs

### D-1 — Service síncrono (await) vs fire-and-forget
**Recomendação:** AWAIT. LGPD não é log forense — é prova jurídica. Falha de DB DEVE bloquear cron pra evitar marcar "purged" sem evento. Confidence: HIGH.

### D-2 — Whitelist event_type via CHECK SQL vs só TS
**Recomendação:** CHECK SQL `eventType IN (...)` + `as const` no TS (defesa em profundidade). Lista pequena e estável; vale a fricção. Confidence: HIGH.

### D-3 — Schema separado vs flag `is_legal` no audit_log
**Recomendação:** Tabela separada (já decidido). Flag exige cron filtrar `WHERE is_legal=false` — bug = apaga prova legal. Confidence: HIGH.

### D-4 — `actor` enum fechado vs string livre
**Recomendação:** Enum fechado (`cron_purge_worker|user_self_service|admin_panel`). Análise forense determinística. Confidence: HIGH.

### D-5 — FK de `userId` para `users(id)`? (descoberta no red-team)
**Recomendação:** **SEM FK** (string solta). O evento legal precisa SOBREVIVER ao delete do user (essa é a prova!). FK com SET NULL = "purga de quem?" absurdo legalmente. FK RESTRICT trava cron. Documentar com comentário GIGANTE no model. Confidence: HIGH.

---

## 7. Tasks INVEST

### Fase única: Schema + Service + Tests + RLS

**Definition of Success:** `recordLegalEvent({eventType:'purge_completed', ...})` funciona em integration test contra Postgres real, RLS bloqueia user comum, coverage ≥ 90%.

| ID | Task | Arquivos | Critério | Owner | Size |
|---|---|---|---|---|---|
| T1 | Resolver A-5 + confirmar A-1/A-4 com operador | — | 3 perguntas respondidas | operador | P (15min) |
| T2 | Adicionar model `AuditLogLegal` em prisma/schema.prisma | `prisma/schema.prisma` | uuid dbgenerated; Timestamptz(3); 4 índices declarativos; `eventId` UNIQUE; comentário 5y retention + LGPD basis + R-7 anti-friendly-fire + R-8 sem FK userId | operador | P |
| T3 | Gerar migration Prisma + editar SQL com CHECK constraints | `prisma/migrations/.../migration.sql` | CHECK whitelist event_type (7 tipos), CHECK actor (3 valores), CHECK outcome (success\|failure), CHECK legal_basis regex+length, CHECK resourceHash regex, TOAST tuning, RLS ENABLE | operador | M |
| T4 | Partial index `idx_audit_log_legal_failures` via raw SQL | mesmo arquivo T3 | `WHERE outcome='failure'` | operador | P |
| T5 | RLS policies (4 policies — DENY ALL authenticated + GRANT service_role) | `prisma/migrations/.../migration.sql` + `supabase/migrations/.../sql` | DROP POLICY IF EXISTS + CREATE; documenta service_role bypassa | operador | M |
| T6 | Aplicar migration no DB local + Supabase staging via MCP | — | `prisma migrate dev` + `mcp__supabase__apply_migration` | operador | P |
| T7 | Regenerar schema.fingerprint.json | `tests/fixtures/schema.fingerprint.json` | `npm run schema:fingerprint` + commit + schema-drift test verde | operador | P |
| T8 | Criar `audit-legal.types.ts` (LegalEventType, LegalActor, LegalBasis, Zod schema) | `src/modules/audit-legal/audit-legal.types.ts` | `as const` + union type; Zod input strict (eventId UUID v4, eventType enum, actor enum, outcome enum, resourceHash regex, errorCode obrigatório se failure) | operador | M |
| T9 | Criar `audit-legal.service.ts` (recordLegalEvent) | `src/modules/audit-legal/audit-legal.service.ts` | `async (input): Promise<AuditLogLegal>`; Zod parse; scrubObject metadata; cap 1024 bytes; persist via prisma; P2002 → lookup idempotente; pino log + Sentry breadcrumb sempre; throw `AppError(LEGAL_AUDIT_PERSIST_FAILED)` em DB error; export `__testing` | operador | M |
| T10 | Unit test src/modules/audit-legal — coverage ≥90% | `tests/unit/audit-legal-service.test.ts` | Zod rejections, persist sucesso, P2002 idempotency, scrubObject aplicado, cap 1024, log+breadcrumb emitidos, throw em DB error, todos eventTypes ≥1× | @tester | M |
| T11 | Integration test contra Postgres real | `tests/integration/audit-legal.integration.test.ts` | CHECK rejeita eventType inválido (raw insert bypass Zod); RLS bloqueia `authenticated`; `service_role` acessa; idempotência por eventId; partial index existe; toast_tuple_target=4096 | @tester | M |
| T12 | Atualizar `.claude/metrics/categories.json` se @security/@dba propuserem categoria nova | `categories.json` (talvez) | enum drift detection passa | operador | P |

**Sequência caminho crítico:** T1 → T2 → T3 → T6 → T9 → T11 → pipeline

**Paralelizável:** T8 e início de T10 (skeleton) durante T9.

**Checkpoints com usuário:**
- Após T1 (A-1/A-3/A-5 confirmadas) — antes de T2
- Após T6 (migration aplicada em staging) — antes de service

---

## 8. Pipeline QA

**Path-matrix detectada:**
- `prisma/schema.prisma` → @dba mandatório
- `prisma/migrations/**` → @dba mandatório
- `**/*.sql` → @dba mandatório
- `src/modules/audit-legal/**` → core + api-contract rule
- LGPD compliance → @security mandatório

**Pipeline final:** core (@tester + @security + @reviewer) + @dba (schema/migration/RLS).

---

## 9. Observability

**Logs estruturados:**
- `audit_legal_event` (info) — `legal:true, event_type, actor, outcome, user_id, resource_type, resource_id, error_code(optional)` — REDACT_PATHS aplicado
- `audit_legal.persist_failed` (error) — `err, event_type, event_id` — escala pro Sentry

**Alertas:**
- Sentry: ≥1 `audit_legal.persist_failed` em 5min → HIGH (compliance!) → runbook (config no Card 11.x)

**Métricas Prometheus:** futuro Card 11.x (`audit_legal_event_recorded_total{event_type,outcome}`).

**Trace:** span auto via Sentry Prisma integration.

---

## 10. Rollout

- Feature flag: NÃO (substrato schema)
- Canary: irrelevante
- Sincronia back/front: irrelevante (zero superfície front)
- Kill criteria: integration test falha em RLS → rollback antes de merge
- Post-launch review: validar +24h em prod sem erro (Fase 7); até lá só staging

---

## 11. Rollback

**Reversível até:** cron de #146 começar a popular em produção.

**Como reverter:**
1. `git revert <merge commit>` no feat/Maclean
2. `npx prisma migrate resolve --rolled-back card_150_add_audit_log_legal`
3. Em staging: `mcp__supabase__execute_sql` com `DROP TABLE IF EXISTS audit_log_legal CASCADE`
4. Regenerar schema.fingerprint.json

**Dados afetados:** nenhum (tabela nasce vazia).

---

## 12. Definition of Success

- [x] Build/lint/tsc verde no feat/Maclean
- [x] `npx prisma generate` reflete model AuditLogLegal sem erro
- [x] Migration aplicada em DB local + Supabase staging
- [x] Schema fingerprint regenerado e commitado
- [x] Coverage src/modules/audit-legal ≥ 90%
- [x] Integration test prova: CHECK rejeita eventType inválido; RLS bloqueia authenticated; service_role acessa; idempotency por eventId
- [x] Pipeline QA v2 APPROVED unânime: @tester + @security + @dba + @reviewer
- [x] Push pro feat/Maclean: `feat(audit): tabela audit_log_legal LGPD 5y retention (Card #150 / Fase 5)`

---

## 13. Cards descoberta no Backlog (gerados pelo plano)

| ID | Subject | Size | Prio | Labels |
|---|---|---|---|---|
| N1 | audit_log_legal partitioning by year | M | BAIXO | `from-plan:card-150`, `dba`, `pipeline-discovery` |
| N2 | audit_log_legal retention cleanup cron 5y | M | MÉDIO | `from-plan:card-150`, `dba`, `compliance` |
| N3 | audit_log_legal metadata encrypt at rest (pgcrypto) | M | BAIXO | `from-plan:card-150`, `security`, `pipeline-discovery` |

---

## Custo do planejamento

- Cost @planner: ~$1.10
- Lead time planejamento: ~25min
- Budget (≤10% custo execução estimado $8-12): OK
