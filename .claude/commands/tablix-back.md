---
description: Contexto completo do backend Tablix (Fastify). Use este comando para iniciar qualquer conversa sobre o backend com entendimento total da arquitetura, decisões técnicas, integrações e regras de negócio.
---

================================================================
TABLIX BACKEND — DOCUMENTAÇÃO TÉCNICA
================================================================

Este documento é a fonte da verdade para o backend do Tablix.
Leia completamente antes de qualquer implementação ou sugestão.

Última atualização: 2026-06-21 (pós-encerramento Fase 5, ressync via @docs)

================================================================
VISÃO GERAL DO SISTEMA

**O que é o Tablix:**
Plataforma de unificação de planilhas (CSV/Excel) com modelo freemium.

**Arquitetura:**
- **Frontend:** Next.js + React — repositório separado (tablix-front). JÁ NO AR (tablix.me)
- **Backend:** Fastify 5 + TypeScript — ESTE REPOSITÓRIO. Ainda não deployado (deploy = Fase 7, Fly.io)

**Responsabilidade do Backend:**
1. Autenticação via token Pro + sessões JWT (access + refresh)
2. Integração com Stripe (billing, webhooks, customer portal)
3. Processamento de arquivos grandes (server-side, PRO)
4. Validação e enforcement de limites por plano (server é a única barreira real)
5. Storage de histórico opt-in PRO (Supabase Storage)
6. Observabilidade (Sentry, pino logger, audit_log forense)
7. Scheduler de crons (LGPD purge, quota alert, cleanup)
8. API REST para o frontend

**O que o Frontend faz (não duplicar):**
- Upload e parsing de arquivos <10MB (client-side)
- Merge de planilhas <10MB (client-side)
- Watermarking para Free (client-side)
- Controle de uso via fingerprint (frontend; backend é SSOT server-side)

================================================================
ROADMAP DE IMPLEMENTAÇÃO
================================================================

Houve renumeração de 12 para 11 fases em 2026-04-26.
Estado em 2026-06-21:

### FASE 1 — Segurança & Hardening ✅ CLOSED_NO_OPEN_DEBT
Fundação + billing + auth JWT + token Pro + rate limiting multicamada + erros
padronizados + LGPD (env seguro, CORS, Helmet, idempotency-key, circuit breaker
webhook, global cap anti denial-of-wallet no checkout).

### FASE 2 — Observabilidade & Auditoria ✅ CLOSED
Pino logger SSOT (REDACT_PATHS LGPD), Sentry SDK + PII scrubbing, audit_log
forense (A09/V7.1), health checks SWR (live/ready/verbose), graceful shutdown.

### FASE 3 — Testes & Qualidade ✅ CLOSED_NO_OPEN_DEBT
Vitest + testcontainers (Postgres real), DB hardening (migrations, índices,
partial indexes), idempotency-key completo, webhook circuit breaker Lua atomic.

### FASE 4 — Usage & Limits ✅ CLOSED
GET /usage + GET /limits, atomic quota enforcement (INSERT...ON CONFLICT DO
UPDATE WHERE), módulo usage SSOT (sem drift TZ), WV-2026-002 fechado.
Side-quest fix-pack: CNPJ/LGPD, stripCrlf anti-ReDoS, multipart edge cases.

### FASE 5 — Storage ✅ CLOSED_NO_OPEN_DEBT (2026-05-18)
StorageAdapter Supabase user-scoped + 4 RLS policies, UserScopedPath branded,
audit_log_legal LGPD 5 anos (Card #150), feature opt-in PRO (historyOptIn),
6 endpoints /history/* + 2 endpoints /admin/jobs/*, scheduler node-cron + Redis
lock distribuído, 4 cron jobs (history-purge, cron-runs-cleanup,
dead-letter-reprocess, quota-alert), email de alerta via Resend (70%/90%
threshold, dedupe monthly via QuotaAlertSent). Saúde @analyst: 86/100.

**Baseline de testes pós-Fase 5:** 1669 unit + 209 integration = **1878 testes verdes**.

### FASE 6 — Fila Assíncrona 🔲 PRÓXIMA (em andamento — iniciada 2026-06-21)
BullMQ + Redis TCP, /process/async, worker de processamento, /process/status,
/process/download, cleanup cron, webhook outbound, smoke E2E, worker-thread XLSX.
Sequência natural: começa por 6.1 (smoke E2E). Pré-requisito recomendado:
pre-merge gate Docker. NOTA: BullMQ exige Redis TCP real (Upstash REST não
suporta BLPOP/XREAD — decisão de infra a fechar no card 6.2).

### FASE 7 — Infra & Deploy 🔲
Dockerfile + fly.toml, **Fly.io (plano free — decidido 2026-06-21)**, secrets,
migrate, Stripe live keys, setup prod, multi-currency via CF-IPCountry
(Cloudflare proxy → Fly.io).

### FASE 8 — CI/CD 🔲
GitHub Actions, branch protection, lint/test/build automatizados, sourcemaps Sentry.

### FASE 9 — Go-live & Docs 🔲
Rotação de secrets (Card 9.5), smoke prod, CHANGELOG público, API docs revisadas.

### FASE 10 — Cleanup Técnico 🔲
Débito técnico residual, refactors, waivers expirados.

### FASE 11 — Docs & Revisão Final 🔲
Documentação final revisada, postmortem geral.

================================================================
STACK TÉCNICA DO BACKEND

**Runtime e Framework:**
- Node.js >= 20.0.0
- Fastify 5.x (latest)
- TypeScript 5.7.3 (strict mode)

**Dependências de produção (package.json):**
```
@fastify/cors 10.0.2            # CORS configurável
@fastify/helmet 13.0.1          # Security headers
@fastify/multipart 9.4.0        # Upload de arquivos (30MB, 15 arquivos)
@fastify/rate-limit 10.2.2      # Rate-limit plugin Fastify (complementar ao Upstash)
@fastify/swagger 9.4.2          # OpenAPI docs
@fastify/swagger-ui 5.2.1       # Swagger UI em /docs
@prisma/client 6.19.2           # ORM client
@sentry/node 10.48.0            # Error tracking + performance
@sentry/profiling-node 10.48.0  # Node profiling para Sentry
@supabase/supabase-js 2.104.1   # Client Supabase Storage (NÃO banco — Prisma é o ORM)
@upstash/ratelimit 2.0.8        # Rate limiting sliding window (Redis Upstash)
@upstash/redis 1.36.1           # Cliente Redis para Upstash
axios 1.7.9                     # HTTP client para integrações externas
body-parser 1.20.3              # Raw body parser (webhook Stripe)
cors 2.8.5                      # Middleware CORS auxiliar
dotenv 16.4.7                   # Env vars
fastify 5.8.5                   # Framework web
fastify-type-provider-zod 4.0.2 # Zod → JSON Schema (Swagger)
jsonwebtoken 9.0.3              # JWT sign/verify
node-cron 3.0.3                 # Scheduler de crons
papaparse 5.5.3                 # Parse CSV
prisma 6.19.2                   # ORM CLI
resend 6.7.0                    # Email SDK (token + alertas)
stripe 20.1.2                   # Billing SDK
xlsx 0.18.5                     # Parse Excel (xlsx/xls) — CVE-2024-22363 ReDoS (WV-2026-003, card 6.10)
zod 3.24.1                      # Validação de schemas
zod-to-json-schema 3.25.1       # Conversão Zod → JSON Schema
```

**Banco de Dados:**
- PostgreSQL via Supabase (dados persistentes) — região São Paulo (sa-east-1)
- Prisma ORM 6.x (queries type-safe)
- Conexão: pooler porta 6543 (pgbouncer=true) para app; porta 5432 (DIRECT_URL) para migrations

**Redis:**
- Upstash Redis (compartilhado com frontend) — mesma instância, prefixos distintos
- Backend usa prefixo `tablix:ratelimit:*`
- Upstash é necessário em produção para rate limiting; dev funciona sem Redis (fallback: sem limite)

**Storage:**
- Supabase Storage (migrado de S3/R2 em Fase 5)
- Adapter: `src/lib/storage/supabase.adapter.ts`
- Bucket por ambiente: `tablix-history-{env}` (staging / prod)
- RLS policies: 4 policies (INSERT/SELECT/UPDATE/DELETE user-scoped)
- StorageAdapter user-scoped com UserScopedPath branded type

**Billing:**
- Stripe (embedded checkout, webhooks, customer portal)
- Multi-currency: BRL/USD/EUR com price IDs separados por moeda
- Política fechada: moeda resolvida server-side via CF-IPCountry (Cloudflare, Fase 7)
- Até Fase 7: apenas BRL ativo; USD/EUR pendentes

**Testes:**
- Vitest + testcontainers (Postgres real para integração)
- fast-check (property-based)
- supertest (HTTP)
- 1878 testes verdes (1669 unit + 209 integration)

================================================================
MODELO DE AUTENTICAÇÃO

**IMPORTANTE: Não há tela de login/registro no frontend.**

**Entidades de identidade:**
- `User` — identidade central (email, role FREE/PRO, historyOptIn)
- `Session` — sessão ativa (JWT referencia session.id, revokedAt para logout)
- `Token` — token Pro gerado pós-pagamento (vinculado a User via userId)

**Fluxo de autenticação:**

```
1. Cliente acessa o site (role FREE por padrão)
2. Cliente decide assinar Pro
3. Frontend abre Stripe Embedded Checkout
4. Cliente paga
5. Stripe envia webhook para backend
6. Backend:
   - Cria/localiza User por email (stripeCustomerId)
   - Cria Token Pro no PostgreSQL
   - Gera token único (tbx_pro_{32+ chars})
   - Envia email com token para o cliente via Resend
7. Cliente usa o token
8. Frontend envia para backend: POST /auth/validate-token
   - Body: { token, fingerprint }
9. Backend:
   - Valida token (timing-safe)
   - Vincula token ao fingerprint (primeiro uso)
   - Cria Session no banco (userId, refreshTokenHash, ip, userAgent)
   - Retorna { accessToken (15m), refreshToken (30d opaco) }
10. Frontend usa accessToken em requests autenticados (Authorization: Bearer)
11. Quando accessToken expira, frontend usa POST /auth/refresh com refreshToken
```

**Tokens JWT:**
| Token | Duração | Uso |
|-------|---------|-----|
| Access Token | 15min | Bearer em todo request autenticado |
| Refresh Token | 30 dias | POST /auth/refresh (rotação a cada uso) |

**Regras de segurança do token Pro:**

| Regra | Implementação |
|-------|---------------|
| Formato | `tbx_pro_{32+ chars aleatórios}` |
| Entropia | Mínimo 256 bits (crypto.randomBytes) |
| Comparação | timing-safe (crypto.timingSafeEqual) |
| Vinculação | Fingerprint vinculado no primeiro uso |
| Rate limit | 5 tentativas/min por IP (anti brute-force) |
| Expiração | Token não expira; assinatura controlada pelo Stripe |

================================================================
INTEGRAÇÃO COM STRIPE

**Multi-currency (política fechada — 2026-04-20):**
- Moeda decidida server-side via CF-IPCountry (Cloudflare, Fase 7)
- Cada país tem price ID próprio (BRL/USD/EUR)
- Schema /billing/create-checkout aceita `currency` no body, mas handler ignora
  e resolve via PRICE_MAP server-side
- WV-2026-004 cobre risco de price arbitrage até Fase 7 (renovado, expira 2026-09-15)
- Até Fase 7: apenas STRIPE_PRO_MONTHLY/YEARLY_BRL_PRICE_ID em uso

**Fluxos implementados:**

1. **Checkout (upgrade para Pro)**
   - Frontend chama: `POST /billing/create-checkout`
   - Rate limit: 5/min per IP + 30/min cap global agregado (anti denial-of-wallet)
   - Suporte a Idempotency-Key (optional header, cached 24h)
   - Backend cria Stripe Checkout Session (embedded) + retorna client_secret

2. **Webhook (confirmação de pagamento)**
   - Stripe chama: `POST /webhooks/stripe`
   - Circuit breaker Lua atomic (5 signature failures/60s → ban 15min → 429)
   - Idempotência via tabela stripe_events (P2002 = evento já processado)
   - Eventos tratados:
     - `checkout.session.completed` → cria User + Token Pro + envia email
     - `customer.subscription.updated` → atualiza status
     - `customer.subscription.deleted` → revoga acesso Pro
     - `invoice.payment_failed` → notifica cliente

3. **Customer Portal**
   - Frontend chama: `POST /billing/portal`
   - Backend gera URL do Stripe Customer Portal

================================================================
ESTRUTURA DO BANCO DE DADOS (Prisma)

**Arquivo:** `prisma/schema.prisma`

### Modelos (12 total):

```
User                   — Identidade central (email, role FREE/PRO, historyOptIn)
Session                — Sessão ativa (JWT → session.id, revokedAt para logout)
Token                  — Token Pro pós-pagamento (userId FK, fingerprint, status)
Usage                  — Uso mensal por user (period YYYY-MM, unificationsCount)
Job                    — Jobs de processamento assíncrono (pendente Fase 6)
StripeEvent            — Idempotência de webhooks (event.id do Stripe, UNIQUE)
AuditLog               — Trilha forense operacional (90 dias, fire-and-forget)
AuditLogLegal          — Trilha LGPD (5 anos, eventId idempotency, SEM FK em users)
FileHistory            — Histórico opt-in PRO (soft-delete two-phase, expiresAt)
CronRun                — Histórico persistente do scheduler (30 dias)
FileHistoryDeadLetter  — Quarentena de purga (Storage delete falhou >= 5x)
QuotaAlertSent         — Dedupe de alertas (UNIQUE user+threshold+period)
```

### Enums:
```
Role        — FREE | PRO
Plan        — PRO
TokenStatus — ACTIVE | CANCELLED | EXPIRED
JobStatus   — PENDING | PROCESSING | COMPLETED | FAILED
```

### Decisões irreversíveis de schema (consultar antes de mudar):
- `AuditLogLegal.userId` SEM FK em users.id — intencional (prova sobrevive ao delete do user)
- `FileHistoryDeadLetter.userId` SEM FK — idem
- `gen_random_uuid()` DB-side (dbgenerated) em todos os UUIDs — SSOT no banco
- Partial indexes gerenciados via SQL raw (Prisma não suporta declarativamente):
  audit_log, audit_log_legal, file_history, file_history_dead_letter, cron_runs
- NÃO usar `prisma migrate dev` em tabelas com partial indexes (drop silencioso);
  preferir `prisma db pull` ou migration SQL manual

================================================================
SPECS DOS PLANOS

**Fonte da verdade:** `src/config/plan-limits.ts` (PLAN_LIMITS / FREE_LIMITS / PRO_LIMITS)

### PLANO FREE

| Limite | Valor |
|--------|-------|
| Unificações/mês | 1 |
| Planilhas por unificação | 3 |
| Linhas por arquivo | 500 |
| Linhas totais (soma) | 500 |
| Tamanho por arquivo | 1MB |
| Tamanho total (soma) | 1MB |
| Colunas selecionáveis | 3 |
| Marca d'água | Obrigatória (aba "Sobre" + coluna "Gerado por Tablix") |
| Processamento | Client-side (frontend) |

Free NÃO usa o backend para processamento de arquivos.

### PLANO PRO

| Limite | Valor (SSOT plan-limits.ts) |
|--------|-------|
| Unificações/mês | 30 |
| Planilhas por unificação | 15 |
| Linhas por arquivo | 5.000 |
| Linhas totais (merge) | 75.000 |
| Tamanho por arquivo | 2MB (mitigação ReDoS — ver WV-2026-003 / card 6.10) |
| Tamanho total (soma) | 30MB |
| Colunas selecionáveis | 10 |
| Marca d'água | Não tem |
| Processamento | Server-side (backend) |

**⚠️ DIVERGÊNCIA ATIVA COM O FRONT (front no ar):**
- `plan-limits.ts:61` documenta: o backend faz **30 unificações/mês**, mas o
  **front ainda anuncia 40** (FAQ/landing). Card **#57** no Backlog ([FRONT-BUG])
  rastreia isso. Como o front está no ar e indexado, é uma promessa visível ao
  cliente pagante que o back não honra — **decisão do dono pendente**: alinhar o
  front para 30 OU subir o limite do back para 40.
- Os valores antigos desta doc (15 colunas, "sem limite" por arquivo) estavam
  ERRADOS — eram drift da própria doc do back. O código (10 colunas, 2MB/arquivo)
  está alinhado com o spec do front, exceto pelo ponto acima.

================================================================
PROCESSAMENTO DE ARQUIVOS

**Fluxo Síncrono ✅ IMPLEMENTADO**

```
POST /process/sync (multipart/form-data)
├── Rate limit (10 req/min)
├── Valida JWT (authMiddleware)
├── Valida limites do plano → src/config/plan-limits.ts (getLimitsForPlan)
├── Para cada arquivo: valida extensão + parse + sanitização
├── Valida limite total de linhas
├── Executa merge
├── Gera arquivo de saída (XLSX ou CSV)
├── Incrementa contador (Usage, atomic INSERT...ON CONFLICT)
└── Retorna: { file (base64), fileName, fileSize, rowsCount, columnsCount, format }
```

**Fluxo Assíncrono 🔲 Pendente Fase 6**

```
POST /process/async        — enfileira job BullMQ, retorna jobId
GET  /process/status/:id   — status do job
GET  /process/download/:id — download do resultado (entrega única)
```

================================================================
ENDPOINTS DA API

### Autenticação ✅ IMPLEMENTADO

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /auth/validate-token | Valida token Pro, cria Session, retorna access+refresh | Não | 5/min |
| POST | /auth/refresh | Renova access token (rotação do refresh token) | Refresh token | 10/min |
| GET | /auth/me | Retorna dados do usuário, plano e uso | JWT | 60/min |
| POST | /auth/logout | Revoga Session (revokedAt no banco) | JWT | 100/min |

### Billing ✅ IMPLEMENTADO

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /billing/create-checkout | Cria sessão de checkout Stripe | Não | 5/min por IP + 30/min global cap |
| POST | /billing/portal | Gera URL do Customer Portal | JWT | 20/min |
| GET | /billing/prices | Retorna preços disponíveis | Não | 100/min |
| POST | /webhooks/stripe | Recebe webhooks do Stripe | Stripe Signature | Sem limite (circuit breaker) |

### Processamento

| Método | Endpoint | Status | Auth | Rate Limit |
|--------|----------|--------|------|------------|
| POST | /process/sync | ✅ | JWT | 10/min |
| POST | /process/async | 🔲 Fase 6 | JWT | 10/min |
| GET | /process/status/:jobId | 🔲 Fase 6 | JWT | 60/min |
| GET | /process/download/:jobId | 🔲 Fase 6 | JWT | 10/min |

### Usage & Limits ✅ IMPLEMENTADO (Fase 4)

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| GET | /usage | Uso atual do mês (unificações) | JWT | 60/min |
| GET | /limits | Limites do plano (server-side) | JWT | 100/min |

### History opt-in PRO ✅ IMPLEMENTADO (Fase 5)

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /history/enable | Opt-in (LGPD consent_given AWAIT) | JWT | 10/min |
| POST | /history/disable | Opt-out + agenda purga (consent_withdrawn AWAIT) | JWT | 10/min |
| GET | /history | Listagem paginada (cursor-based) | JWT | 60/min |
| GET | /history/:id | Detalhe + signed URL efêmera (TTL 60s) | JWT | 60/min |
| DELETE | /history/:id | Soft-delete individual (two-phase) | JWT | 5/min |
| DELETE | /history | Soft-delete em massa (Idempotency-Key MANDATORY) | JWT | 1 req/5min por user + 5 req/5min global cap |

DELETE /history exige body `{ "confirmation": "CONFIRM_DELETE_ALL" }` literal
e header `Idempotency-Key: <uuid-v4-lowercase>`. Retorna 403 FEATURE_DISABLED se
historyOptIn=false. Feature controlada por HISTORY_FEATURE_ENABLED.

### Admin (scheduler) ✅ IMPLEMENTADO (Fase 5)

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /admin/jobs/run/:name | Dispara job manualmente | JWT + Admin allowlist + step-up reauth | 5/min por admin + 20/min global cap |
| GET | /admin/jobs/list | Snapshot do scheduler | JWT + Admin allowlist | — |

Admin protegido por WV-2026-006 (allowlist ADMIN_USER_IDS, máx 5 admins).
Kill criteria: Card #157 (enum UserRole).

### Health ✅ IMPLEMENTADO (Fase 2)

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| GET | /health/live | Liveness probe (sempre 200 se processo vivo, sem deps externas) | Não | Sem limite |
| GET | /health/ready | Readiness probe (200 DB+Redis ok, 503 degraded) | Não | 60/min |
| GET | /health | Verbose debug + scheduler snapshot | Não | 60/min |
| GET | /docs | Swagger UI | Não | Sem limite |
| GET | /docs/json | OpenAPI spec | Não | Sem limite |

================================================================
REDIS & RATE LIMITING ✅ IMPLEMENTADO

**Instância:** Upstash Redis (compartilhada com frontend)
**Biblioteca:** @upstash/ratelimit (sliding window)
**Prefixo backend:** `tablix:ratelimit:*`

**Rate Limiters por Endpoint:**

| Limiter | Requests | Janela | Aplicado em |
|---------|----------|--------|-------------|
| validateToken | 5 | 1 min | /auth/validate-token |
| authRefresh | 10 | 1 min | /auth/refresh |
| authMe | 60 | 1 min | /auth/me |
| checkout (per-IP) | 5 | 1 min | /billing/create-checkout |
| checkoutGlobalCap | 30 | 1 min | /billing/create-checkout (agregado) |
| billing | 20 | 1 min | /billing/portal, /billing/prices |
| process | 10 | 1 min | /process/sync |
| health | 60 | 1 min | /health, /health/ready |
| usage | 60 | 1 min | /usage |
| limits | 100 | 1 min | /limits |
| historyOptIn | 10 | 1 min | /history/enable, /history/disable |
| historyList | 60 | 1 min | GET /history, GET /history/:id |
| historyDeleteOne | 5 | 1 min | DELETE /history/:id |
| historyDeleteAll (per-user) | 1 | 5 min | DELETE /history |
| historyDeleteAllGlobalCap | 5 | 5 min | DELETE /history (agregado) |
| adminJobs (per-admin) | 5 | 1 min | /admin/jobs/run/:name |
| adminJobsGlobalCap | 20 | 1 min | /admin/jobs/run/:name (agregado) |
| global | 100 | 1 min | Fallback geral |

**Fallback em dev:** rate limit ignorado se UPSTASH_REDIS_REST_URL não configurado.

**Pattern anti denial-of-wallet:** rotas com chamadas externas pagas têm SEMPRE
dois limiters: per-IP + cap global agregado com identifier fixo.

================================================================
SCHEDULER & CRON JOBS ✅ IMPLEMENTADO (Fase 5)

**Implementação:** node-cron + Redis lock distribuído (src/scheduler/)
**NÃO usa BullMQ** — node-cron é suficiente para os 4 jobs atuais.

**Jobs registrados:**

| Job | Schedule (UTC) | Horário BRT | Handler |
|-----|----------------|-------------|---------|
| history-purge | 0 6 * * * | 03:00 daily | src/jobs/retention.job.ts |
| cron-runs-cleanup | 0 7 * * * | 04:00 daily | src/jobs/cron-runs-cleanup.job.ts |
| dead-letter-reprocess | 0 7 * * 0 | 04:00 Sunday | src/jobs/dead-letter-reprocess.job.ts |
| quota-alert | 0 11 * * * | 08:00 daily | src/jobs/quota-alert.job.ts |

**Kill-switches:**
- `HISTORY_FEATURE_ENABLED=true` + `CRON_PURGE_ENABLED=true` ativa todos os jobs
- `CRON_DRY_RUN=true` → loga mas não purga/envia (alerta Sentry em prod)
- NODE_ENV=test → cron nunca dispara (guard interno)

**Garantias:** Redis lock antes de executar, heartbeat 60s, release no finally,
CronRun persistido no banco (30 dias), snapshot no GET /health verbose.

================================================================
STORAGE (Supabase Storage) ✅ IMPLEMENTADO (Fase 5)

**Adapter:** `src/lib/storage/supabase.adapter.ts`
**Formato do path:** `{userId}/{yyyy-mm-dd UTC}/{fileId}.{ext}` (UserScopedPath branded)
**Bucket:** `tablix-history-{env}` (staging / prod)
**4 RLS policies** user-scoped no bucket

**Fluxo two-phase de purga:**
1. Soft-delete: `file_history.deleted_at = NOW()`
2. Hard-purge: cron history-purge apaga objeto Storage + hard-deleta row
3. Se purga falha >= 5x: move para `file_history_dead_letter` (quarentena)
4. Cron dead-letter-reprocess tenta novamente (semanal, max 3x) + alerta Sentry CRITICAL

**signedUrl:** gerada on-demand com TTL 60s; nunca persistida no banco.
**resource_hash:** SHA-256(userId:storagePath) em bytea — nunca o path real. Frozen v1.

================================================================
VARIÁVEIS DE AMBIENTE

**Arquivo:** `.env` (não commitado) | **Template:** `.env.example`

```env
# Server
PORT=3333
NODE_ENV=development
API_URL=http://localhost:3333

# Database (Supabase PostgreSQL — São Paulo sa-east-1)
DATABASE_URL=postgresql://postgres.{ref}:{password}@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&statement_timeout=5000
DIRECT_URL=postgresql://postgres:{password}@db.{ref}.supabase.co:5432/postgres

# Redis (Upstash)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_MONTHLY_BRL_PRICE_ID=price_...
STRIPE_PRO_YEARLY_BRL_PRICE_ID=price_...
STRIPE_PRO_MONTHLY_USD_PRICE_ID=price_...
STRIPE_PRO_YEARLY_USD_PRICE_ID=price_...
STRIPE_PRO_MONTHLY_EUR_PRICE_ID=price_...
STRIPE_PRO_YEARLY_EUR_PRICE_ID=price_...

# Email (Resend)
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
FROM_EMAIL=Tablix <noreply@tablix.com.br>

# JWT (access curto + refresh longo)
JWT_SECRET=... (mínimo 32 caracteres)
JWT_ACCESS_TOKEN_EXPIRES_IN=15m
JWT_REFRESH_TOKEN_EXPIRES_IN=30d

# Frontend
FRONTEND_URL=https://tablix.com.br

# Health checks
HEALTH_TIMEOUT_DB_MS=1000
HEALTH_TIMEOUT_REDIS_MS=500
HEALTH_CACHE_TTL_MS=2000

# Logging — default por NODE_ENV (dev=debug, prod=info, test=fatal)
LOG_LEVEL=

# Sentry
SENTRY_DSN=https://...@....ingest.us.sentry.io/...
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=
SENTRY_TRACES_SAMPLE_RATE=1.0
SENTRY_PROFILES_SAMPLE_RATE=1.0
SENTRY_AUTH_TOKEN=
SENTRY_ORG=tablix
SENTRY_PROJECT=tablix-back

# Supabase Storage
SUPABASE_URL=https://{project-ref}.supabase.co
SUPABASE_STORAGE_KEY=          # secret DEDICADA (NÃO reusar a service_role)
SUPABASE_STORAGE_BUCKET=tablix-history-staging

# History opt-in PRO
HISTORY_FEATURE_ENABLED=false  # kill-switch global (enum 'true'/'false', não bool)
CRON_PURGE_ENABLED=false       # kill-switch cron de purga
CRON_DRY_RUN=false             # dry-run (loga, não purga)
PRO_RETENTION_DAYS=30          # range 1-365, SSOT via env.PRO_RETENTION_DAYS

# Admin
ADMIN_USER_IDS=                # CSV de UUIDs v4 lowercase, max 5
ADMIN_STEPUP_SECRET=           # min 32 chars, DIFERENTE do JWT_SECRET
SHUTDOWN_DRAIN_MS=15000        # grace drain SIGTERM
```

**Obrigatórios em produção (validação fail-fast no boot via superRefine):**
DATABASE_URL, JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, RESEND_API_KEY,
todos 6 STRIPE_PRO_*_PRICE_IDs, SENTRY_DSN, FRONTEND_URL (HTTPS, não localhost),
SUPABASE_URL, SUPABASE_STORAGE_KEY, SUPABASE_STORAGE_BUCKET.
Se HISTORY_FEATURE_ENABLED=true: ADMIN_USER_IDS (min 1) + ADMIN_STEPUP_SECRET.

================================================================
ESTRUTURA DE PASTAS (Estado real em 2026-06-21)

```
tablix-back/
├── .claude/                       # Configuração Claude
├── prisma/
│   ├── schema.prisma              # Schema completo (12 models)
│   └── seed.ts
├── supabase/migrations/           # Migrations SQL (partial indexes + CHECK constraints)
├── scripts/
│   └── dump-test-schema.ts        # Snapshot do schema para testes
├── docs/
│   ├── baselines/
│   └── runbooks/                  # Runbooks operacionais (database-rollback, history-rollback,
│                                  #   purge-overshoot, lock-stuck, cron-stuck, quota-alert-stuck, etc.)
├── tests/
│   ├── unit/                      # Testes unitários (Vitest)
│   ├── integration/               # Testes de integração (testcontainers)
│   └── helpers/                   # jwt-mock, prisma helper, etc.
├── src/
│   ├── @types/index.d.ts          # Extensão FastifyRequest
│   ├── config/
│   │   ├── env.ts                 # Zod fail-fast no boot
│   │   ├── logger.ts              # Pino logger config
│   │   ├── plan-limits.ts         # SSOT limites por plano (getLimitsForPlan)
│   │   ├── rate-limit.ts          # Rate limiters Upstash
│   │   ├── redis.ts               # Singleton Redis
│   │   └── sentry.ts              # Sentry config (beforeSend scrubbing)
│   ├── errors/app-error.ts        # AppError + factory Errors.*
│   ├── http/
│   │   ├── controllers/           # auth, billing, history, process, usage, webhook
│   │   └── routes/
│   │       ├── index.ts           # registerRoutes() centralizado
│   │       ├── auth.routes.ts
│   │       ├── billing.routes.ts
│   │       ├── health.routes.ts   # /health/live + /health/ready + /health
│   │       ├── history.routes.ts  # 6 endpoints /history/*
│   │       ├── process.routes.ts
│   │       ├── usage.routes.ts    # /usage + /limits
│   │       └── webhook.routes.ts
│   ├── instrument.ts              # Inicialização Sentry (import antes de tudo)
│   ├── jobs/
│   │   ├── cron-runs-cleanup.job.ts
│   │   ├── dead-letter-reprocess.job.ts
│   │   ├── quota-alert.job.ts     # Alerta 70%/90% + dedupe QuotaAlertSent
│   │   └── retention.job.ts       # Purga two-phase LGPD
│   ├── lib/
│   │   ├── audit/                 # audit.service.ts (fire-and-forget, tripla redundância)
│   │   ├── audit-hash.ts          # SHA-256(userId:storagePath) frozen v1
│   │   ├── email.ts               # Resend + templates
│   │   ├── health/                # SWR orchestrator, check-db, check-redis
│   │   ├── idempotency/           # idempotency.service.ts
│   │   ├── jwt.ts                 # access + refresh tokens
│   │   ├── logger.ts              # Instância pino global
│   │   ├── prisma.ts              # Singleton Prisma Client
│   │   ├── security/
│   │   │   └── webhook-circuit-breaker.ts  # Lua atomic ban
│   │   ├── spreadsheet/           # parser, merger, sanitizer, types
│   │   ├── storage/
│   │   │   ├── supabase.adapter.ts
│   │   │   ├── key-builder.ts     # UserScopedPath builder
│   │   │   └── types.ts           # UserScopedPath branded
│   │   └── token-generator.ts     # tbx_pro_* (256 bits)
│   ├── middleware/
│   │   ├── auth.middleware.ts
│   │   └── rate-limit.middleware.ts  # rateLimitMiddleware + createGlobalCapMiddleware
│   ├── modules/
│   │   ├── audit-legal/           # recordLegalEvent (AWAIT — não fire-and-forget)
│   │   ├── auth/                  # auth.schema.ts + auth.service.ts
│   │   ├── billing/               # billing.schema.ts + stripe.service.ts + webhook.handler.ts
│   │   ├── health/health.schema.ts
│   │   ├── history/               # history.schema.ts + history.service.ts
│   │   ├── process/               # process.schema.ts + process.service.ts
│   │   └── usage/                 # usage.schema.ts + usage.service.ts (getCurrentPeriod UTC)
│   ├── scheduler/
│   │   ├── admin.middleware.ts    # adminMiddleware (allowlist + step-up reauth)
│   │   ├── admin.routes.ts        # /admin/jobs/*
│   │   ├── cron.ts                # Core scheduler (register, run, shutdown)
│   │   ├── jobs.bootstrap.ts      # Registra os 4 cron jobs no boot
│   │   ├── lock.ts                # Redis lock distribuído
│   │   ├── metrics.ts
│   │   ├── observability.ts       # emitSchedulerEvent
│   │   └── types.ts
│   ├── schemas/common.schema.ts   # errorResponseSchema + schemas compartilhados
│   ├── app.ts                     # Fastify + plugins + Swagger + registerRoutes()
│   └── server.ts                  # Entry point (listen + bootstrapCronJobs + SIGTERM)
├── .env.example                   # Template documentado
├── .eslintrc.json
├── package.json
├── tsconfig.json
├── vitest.config.ts               # Configuração unit tests
└── vitest.integration.config.ts   # Configuração integration (testcontainers)
```

**Módulos a criar (próximas fases):**
- `src/jobs/process.worker.ts` — worker BullMQ (Fase 6)
- `src/jobs/queue.ts` — configuração BullMQ (Fase 6)
- `Dockerfile` + `fly.toml` — deploy Fly.io (Fase 7)

================================================================
OBSERVABILIDADE E LGPD

**Logger (pino):** SSOT via src/lib/logger.ts + src/config/logger.ts.
REDACT_PATHS cobre PII (tokens, authorization, emails em paths sensíveis, CPF, CNPJ).
Nível default: dev=debug, prod=info, test=fatal.

**Sentry:** inicializado em instrument.ts (import ANTES de qualquer módulo).
beforeSend scrubbing recursivo. Sample rates configuráveis por NODE_ENV
(prod: traces 0.1, profiles 0.05).

**audit_log (90 dias):** fire-and-forget, tripla redundância (Prisma + Sentry breadcrumb + pino).
NUNCA armazenar PII direta; actor é userId/customerId.

**audit_log_legal (5 anos):** AWAIT obrigatório (não fire-and-forget).
Falha de DB bloqueia caller (sem prova jurídica = sem conformidade LGPD).
SEM FK em users.id (intencional — prova sobrevive ao delete).
resource_hash: SHA-256(userId:storagePath) em bytea. Frozen v1.

================================================================
REGRAS DE EXECUÇÃO PARA O CLAUDE

- NÃO gerar código sem alinhamento prévio
- NÃO duplicar lógica que já existe no frontend
- SEMPRE usar `getLimitsForPlan()` (src/config/plan-limits.ts) — nunca hardcodar limites
- SEMPRE usar `env.X` (src/config/env.ts) — nunca `process.env.X` direto
- SEMPRE validar TODOS os inputs externos com Zod
- SEMPRE usar `recordLegalEvent` com AWAIT para eventos LGPD (nunca fire-and-forget)
- NÃO usar `$queryRawUnsafe` com input do usuário — apenas `$queryRaw` template tag
- NÃO usar `Math.random` para tokens/secrets — sempre `crypto.randomBytes`
- NÃO usar `===` para comparar tokens — usar `crypto.timingSafeEqual`
- NÃO usar `prisma migrate dev` em tabelas com partial indexes
- NÃO adicionar FK em audit_log_legal.userId e file_history_dead_letter.userId
- NÃO modificar resource_hash_algo sem coluna v2 (hash é frozen v1)
- SEMPRE seguir os padrões de erro definidos em src/errors/app-error.ts
- Se documentação contradiz código: PARAR e perguntar qual está correto

================================================================
CHANGELOG
================================================================

### 2026-05-18 — Fase 5 Storage ✅ CLOSED_NO_OPEN_DEBT
- StorageAdapter Supabase user-scoped + UserScopedPath branded + 4 RLS policies
- audit_log_legal LGPD 5 anos (Card #150): 5 camadas defesa, coverage 100%
- Feature opt-in PRO: User.historyOptIn, historyOptInAt, historyOptOutAt
- 6 endpoints /history/* (enable/disable/list/get/delete-one/delete-all)
- 2 endpoints /admin/jobs/* (run/:name + list) — WV-2026-006
- Scheduler: node-cron + Redis lock distribuído (src/scheduler/)
- 4 cron jobs: history-purge (LGPD two-phase), cron-runs-cleanup (30d),
  dead-letter-reprocess (weekly), quota-alert (70%/90% via Resend + dedupe)
- FileHistoryDeadLetter + QuotaAlertSent + CronRun (3 novos modelos)
- HISTORY_FEATURE_ENABLED / CRON_PURGE_ENABLED / CRON_DRY_RUN / PRO_RETENTION_DAYS
- ADMIN_USER_IDS / ADMIN_STEPUP_SECRET / SHUTDOWN_DRAIN_MS
- 1878 testes verdes (1669 unit + 209 integration)

### 2026-04-26 — Fase 4 Usage & Limits ✅ CLOSED
- GET /usage + GET /limits (módulo usage SSOT, getCurrentPeriod UTC)
- Atomic quota enforcement via INSERT...ON CONFLICT DO UPDATE WHERE
- WV-2026-002 (TOCTOU validateProLimits) fechado
- plan-limits.ts SSOT: getLimitsForPlan, FREE_LIMITS, PRO_LIMITS
- Side-quest fix-pack (Fases 1/2): CNPJ Sentry, breadcrumbs scrub,
  stripCrlf anti-ReDoS, ip/userAgent asserts, multipart integration test
- Renumeração 12→11 fases; Fly.io confirmado como plataforma de deploy

### 2026-04-25 — Fase 3 Testes & Qualidade ✅ CLOSED_NO_OPEN_DEBT
- Vitest + testcontainers (Postgres real para integração) + fast-check
- DB hardening: migrations, índices, Idempotency-Key completo (PTTL+PX, UUID v4 strict)
- Webhook circuit breaker Lua atomic (INCR+EXPIRE+SET num único EVAL)

### 2026-04-24 — Fase 2 Observabilidade & Auditoria ✅ CLOSED
- Pino logger SSOT com REDACT_PATHS LGPD
- Sentry SDK + PII scrubbing recursivo (beforeSend)
- audit_log forense (A09/V7.1): fire-and-forget, tripla redundância
- Health checks SWR: /health/live, /health/ready, /health (verbose)
- Graceful shutdown SIGTERM (SHUTDOWN_DRAIN_MS)

### 2026-04-20 — Global cap anti denial-of-wallet + política multi-currency
- createGlobalCapMiddleware em /billing/create-checkout (30/min agregado)
- Rate limit create-checkout: 5/min per IP + 30/min global cap
- Multi-currency policy fechada: CF-IPCountry → Fase 7

### 2026-04-09 a 2026-04-24 — Fase 1 Segurança & Hardening ✅ CLOSED
- Fastify 5 + TypeScript strict + Prisma + env Zod fail-fast
- Modelo User + Session (identidade desacoplada de billing)
- Rate limiting Upstash multicamada, CORS + Helmet + CSP
- Stripe billing (checkout embedded + portal + webhooks + stripe_events idempotência)
- Email Resend (token Pro + cancelamento + falha de pagamento)
- Auth JWT session-backed (access 15m + refresh 30d, Session.revokedAt)
- Token Pro (tbx_pro_*, 256 bits, timing-safe, fingerprint first-use binding)
- Processamento síncrono /process/sync (xlsx + papaparse + sanitizer)
- Swagger UI em /docs

### 2026-01-22 — Estado inicial (pré-pipeline QA)
- Fundação Fastify + TypeScript + Prisma (schema original: Token, Usage, Job)
- Stripe checkout + portal + webhooks
- Email Resend (templates token Pro)
- Auth JWT básico (JWT_EXPIRES_IN=30d — substituído por access 15m + refresh 30d)
- Rate limiting Upstash (versão inicial)
- Processamento síncrono /process/sync
