---
description: Contexto completo do backend Tablix (Fastify). Use este comando para iniciar qualquer conversa sobre o backend com entendimento total da arquitetura, decisões técnicas, integrações e regras de negócio.
---

================================================================
TABLIX BACKEND — DOCUMENTAÇÃO TÉCNICA
================================================================

Este documento é a fonte da verdade para o backend do Tablix.
Leia completamente antes de qualquer implementação ou sugestão.

================================================================
VISÃO GERAL DO SISTEMA

**O que é o Tablix:**
Plataforma de unificação de planilhas (CSV/Excel) com modelo freemium.

**Arquitetura:**
- **Frontend:** Next.js 16 (App Router) + React 19 — JÁ IMPLEMENTADO
- **Backend:** Fastify 5 + TypeScript — ESTE REPOSITÓRIO

**Responsabilidade do Backend:**
1. Autenticação via token (sem login tradicional)
2. Integração com Stripe (billing, webhooks, customer portal)
3. Processamento de arquivos grandes (>10MB, até 30MB)
4. Validação e enforcement de limites por plano
5. API REST para o frontend

**O que o Frontend já faz (não duplicar):**
- Upload e parsing de arquivos <10MB (client-side)
- Merge de planilhas <10MB (client-side)
- Watermarking para Free (client-side)
- Rate limiting via Upstash Redis
- Controle de uso via fingerprint (será migrado para token)

================================================================
ROADMAP DE IMPLEMENTAÇÃO
================================================================

### FASE 1: FUNDAÇÃO (Infraestrutura Base) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Configurar Fastify + TypeScript | ✅ Concluído | `src/server.ts`, `src/app.ts` |
| Configurar variáveis de ambiente | ✅ Concluído | `src/config/env.ts`, `.env` |
| PostgreSQL + Prisma ORM | ✅ Concluído | `prisma/schema.prisma`, `src/lib/prisma.ts` |
| Sistema de erros padronizados | ✅ Concluído | `src/errors/app-error.ts` |

### FASE 2: BILLING (Stripe) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar SDK Stripe | ✅ Concluído | `package.json` |
| Criar Stripe service | ✅ Concluído | `src/modules/billing/stripe.service.ts` |
| Endpoint create-checkout | ✅ Concluído | `src/modules/billing/billing.routes.ts` |
| Endpoint customer portal | ✅ Concluído | `src/modules/billing/billing.routes.ts` |
| Webhook handler | ✅ Concluído | `src/modules/billing/webhook.handler.ts` |
| Gerador de tokens Pro | ✅ Concluído | `src/lib/token-generator.ts` |

### FASE 3: EMAIL (Resend) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar Resend SDK | ✅ Concluído | `package.json` |
| Criar email service | ✅ Concluído | `src/lib/email.ts` |
| Templates de email (token, cancelamento, falha) | ✅ Concluído | `src/lib/email.ts` |
| Integrar com webhook Stripe | ✅ Concluído | `src/modules/billing/webhook.handler.ts` |

### FASE 4: AUTENTICAÇÃO (JWT + Token) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar jsonwebtoken | ✅ Concluído | `package.json` |
| Criar JWT service | ✅ Concluído | `src/lib/jwt.ts` |
| Endpoint validate-token | ✅ Concluído | `src/modules/auth/auth.routes.ts` |
| Endpoint refresh token | ✅ Concluído | `src/modules/auth/auth.routes.ts` |
| Endpoint /auth/me | ✅ Concluído | `src/modules/auth/auth.routes.ts` |
| Endpoint /auth/logout | ✅ Concluído | `src/modules/auth/auth.routes.ts` |
| Middleware de autenticação | ✅ Concluído | `src/middleware/auth.middleware.ts` |
| Refatorar billing/portal para JWT | ✅ Concluído | `src/modules/billing/billing.routes.ts` |

### FASE 5: PROCESSAMENTO (Arquivos) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar xlsx + papaparse + multipart | ✅ Concluído | `package.json` |
| Tipos de planilhas | ✅ Concluído | `src/lib/spreadsheet/types.ts` |
| Parser de planilhas | ✅ Concluído | `src/lib/spreadsheet/parser.ts` |
| Merger de planilhas | ✅ Concluído | `src/lib/spreadsheet/merger.ts` |
| Endpoint /process/sync | ✅ Concluído | `src/http/routes/process.routes.ts` |
| Validação de limites Pro | ✅ Concluído | `src/modules/process/process.service.ts` |

### FASE 6: FILA ASSÍNCRONA (BullMQ)
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar BullMQ | 🔲 Pendente | `package.json` |
| Configurar fila | 🔲 Pendente | `src/jobs/queue.ts` |
| Worker de processamento | 🔲 Pendente | `src/jobs/workers/process.worker.ts` |
| Endpoint /process/async | 🔲 Pendente | `src/modules/process/process.routes.ts` |
| Endpoint /process/status | 🔲 Pendente | `src/modules/process/process.routes.ts` |
| Endpoint /process/download | 🔲 Pendente | `src/modules/process/process.routes.ts` |

### FASE 7: STORAGE (S3/R2)
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Configurar S3/R2 client | 🔲 Pendente | `src/lib/storage.ts` |
| Upload de arquivos temporários | 🔲 Pendente | `src/lib/storage.ts` |
| Download e cleanup | 🔲 Pendente | `src/lib/storage.ts` |
| URLs pré-assinadas | 🔲 Pendente | `src/lib/storage.ts` |

### FASE 8: USAGE & LIMITES
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Endpoint /usage | 🔲 Pendente | `src/modules/usage/usage.routes.ts` |
| Endpoint /limits | 🔲 Pendente | `src/modules/usage/usage.routes.ts` |
| Incremento de contador | ✅ Concluído | `src/modules/process/process.service.ts` |
| Validação de limites | ✅ Concluído | `src/modules/process/process.service.ts` |

### FASE 9: REDIS (Rate Limiting) ✅ CONCLUÍDA
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Instalar @upstash/ratelimit | ✅ Concluído | `package.json` |
| Configurar Upstash client | ✅ Concluído | `src/config/redis.ts` |
| Configurar rate limiters | ✅ Concluído | `src/config/rate-limit.ts` |
| Rate limit middleware | ✅ Concluído | `src/middleware/rate-limit.middleware.ts` |
| Aplicar em endpoints | ✅ Concluído | `src/http/routes/*.ts` |
| Cache de sessões (opcional) | 🔲 Pendente | `src/lib/cache.ts` |

### FASE 10: TESTES & DOCUMENTAÇÃO
| Tarefa | Status | Arquivos |
|--------|--------|----------|
| Configurar ESLint | ✅ Concluído | `.eslintrc.json` |
| Testes unitários | 🔲 Pendente | `__tests__/` |
| Testes de integração | 🔲 Pendente | `__tests__/` |
| Swagger/OpenAPI docs | ✅ Concluído | `src/app.ts` |
| Health checks | ✅ Concluído | `src/app.ts` (GET /health) |

================================================================
STACK TÉCNICA DO BACKEND

**Runtime e Framework:**
- Node.js (ES2020+)
- Fastify 5.2.1
- TypeScript 5.7.3 (strict mode)

**Dependências Instaladas (package.json):**
```
Produção:
├── @fastify/cors 10.0.2            # CORS configurável
├── @fastify/helmet 13.0.1          # Security headers
├── @fastify/multipart 9.x          # Upload de arquivos ✅ NOVO
├── @fastify/swagger 9.4.2          # OpenAPI docs ✅ CONFIGURADO
├── @fastify/swagger-ui 5.2.1       # Swagger UI ✅ CONFIGURADO
├── @prisma/client 6.19.2           # ORM client
├── @upstash/ratelimit 2.x          # Rate limiting (sliding window) ✅ CONFIGURADO
├── @upstash/redis 1.x              # Cliente Redis para Upstash ✅ CONFIGURADO
├── axios 1.7.9                     # HTTP client (para integrações)
├── dotenv 16.4.7                   # Env vars
├── fastify 5.2.1                   # Framework web
├── fastify-type-provider-zod 4.0.2 # Zod → JSON Schema (Swagger)
├── jsonwebtoken 9.0.3              # JWT sign/verify
├── papaparse 5.x                   # Parse CSV ✅ NOVO
├── prisma 6.19.2                   # ORM CLI
├── resend 6.7.0                    # Email SDK (envio de tokens)
├── stripe 20.1.2                   # Billing SDK
├── xlsx 0.18.x                     # Parse Excel (xlsx/xls) ✅ NOVO
├── zod 3.24.1                      # Validação de schemas
└── zod-to-json-schema 3.25.1       # Conversão Zod → JSON Schema

Dev:
├── @rocketseat/eslint-config 2.2.2 # ESLint config ✅ CONFIGURADO
├── @types/papaparse 5.x            # Tipos para papaparse ✅ NOVO
├── @vitest/coverage-istanbul 3.0.5 # Coverage
├── tsx 4.19.2                      # TypeScript runner (dev)
├── vitest 3.2.4                    # Test runner
├── supertest 7.1.4                 # HTTP testing
├── typescript 5.7.3                # TypeScript
└── eslint 8.57.1                   # Linting
```

**Banco de Dados:**
- PostgreSQL via **Supabase** (dados persistentes)
- Prisma ORM 6.x (queries type-safe)
- Redis Upstash (compartilhado com frontend — rate limiting, cache)

**Supabase (Configuração atual):**
- Projeto: Tablix - DataBase
- Região: US East 2 (Ohio)
- Conexão: Pooler (porta 6543) - necessário pois porta 5432 bloqueada em algumas redes
- Dashboard: https://supabase.com/dashboard (visualizar tabelas)

**Validação:**
- Zod (schemas de request/response)

**Billing:**
- Stripe (embedded checkout, webhooks, customer portal)

**Processamento de Arquivos:**
- xlsx (parsing Excel) ✅ IMPLEMENTADO
- papaparse (parsing CSV) ✅ IMPLEMENTADO
- @fastify/multipart (upload de arquivos) ✅ IMPLEMENTADO
- BullMQ (fila para processamento assíncrono) 🔲 PENDENTE

**Testes:**
- Vitest

**Linting:**
- ESLint com @rocketseat/eslint-config/node ✅ CONFIGURADO

**Documentação API:**
- @fastify/swagger + @fastify/swagger-ui ✅ CONFIGURADO
- fastify-type-provider-zod (converte schemas Zod → JSON Schema)
- Disponível em: GET /docs (Swagger UI) e GET /docs/json (OpenAPI spec)

================================================================
MODELO DE AUTENTICAÇÃO

**IMPORTANTE: Não há tela de login/registro no frontend.**

**Fluxo de autenticação:**

```
1. Cliente acessa o site (Free por padrão)
2. Cliente decide assinar Pro
3. Frontend abre Stripe Embedded Checkout
4. Cliente paga
5. Stripe envia webhook para backend
6. Backend:
   - Cria registro no PostgreSQL
   - Gera token único (ex: tbx_pro_a8f3k9x2m4n7...)
   - Envia email com token para o cliente
7. Cliente recebe email e copia o token
8. Cliente cola token no frontend (input dedicado)
9. Frontend envia para backend: POST /auth/validate-token
   - Body: { token, fingerprint }
10. Backend:
    - Valida token
    - Vincula token ao fingerprint (primeiro uso)
    - Retorna JWT de sessão (7-30 dias)
11. Frontend armazena JWT e usa em requests autenticados
```

**Regras de segurança do token:**

| Regra | Implementação |
|-------|---------------|
| Formato | `tbx_pro_{32+ chars aleatórios}` |
| Entropia | Mínimo 256 bits |
| Vinculação | Token vinculado ao fingerprint no primeiro uso |
| Dispositivo | Se fingerprint mudar, cliente precisa re-inputar token |
| Rate limit | Máximo 5 tentativas/minuto por IP |
| Expiração | Token não expira, mas assinatura sim (controlado pelo Stripe) |

**Se cliente compartilhar token:**
- Token fica vinculado ao fingerprint de quem usou primeiro
- Quem compartilhou perde acesso
- Não abrimos suporte para esse caso (responsabilidade do cliente)

================================================================
INTEGRAÇÃO COM STRIPE

**Produtos e Preços:**
- Plano Pro Mensal
- Plano Pro Anual

**Fluxos implementados:**

1. **Checkout (upgrade para Pro)**
   - Frontend chama: `POST /billing/create-checkout`
   - Backend cria Stripe Checkout Session (embedded)
   - Retorna client_secret para o frontend
   - Frontend renderiza Embedded Checkout

2. **Webhook (confirmação de pagamento)**
   - Stripe chama: `POST /webhooks/stripe`
   - Eventos tratados:
     - `checkout.session.completed` → gera token, envia email
     - `customer.subscription.updated` → atualiza plano
     - `customer.subscription.deleted` → revoga acesso Pro
     - `invoice.payment_failed` → notifica cliente

3. **Customer Portal (gerenciar assinatura)**
   - Frontend chama: `POST /billing/portal`
   - Backend gera URL do Stripe Customer Portal
   - Frontend redireciona cliente

**NÃO construímos UI própria para:**
- Troca de cartão
- Cancelamento
- Histórico de faturas
- Troca de plano

Tudo isso é feito no Stripe Customer Portal.

================================================================
ESTRUTURA DO BANCO DE DADOS (Prisma)

**Arquivo:** `prisma/schema.prisma`

```prisma
model Token {
  id                    String      @id @default(uuid())
  token                 String      @unique @db.VarChar(64)
  fingerprint           String?     @db.VarChar(64)
  stripeCustomerId      String      @map("stripe_customer_id")
  stripeSubscriptionId  String?     @map("stripe_subscription_id")
  plan                  Plan        @default(PRO)
  status                TokenStatus @default(ACTIVE)
  email                 String      @db.VarChar(255)
  createdAt             DateTime    @default(now()) @map("created_at")
  activatedAt           DateTime?   @map("activated_at")
  expiresAt             DateTime?   @map("expires_at")
  usages                Usage[]
  jobs                  Job[]
  @@map("tokens")
}

model Usage {
  id                String   @id @default(uuid())
  tokenId           String   @map("token_id")
  period            String   @db.VarChar(7) // 'YYYY-MM'
  unificationsCount Int      @default(0) @map("unifications_count")
  createdAt         DateTime @default(now()) @map("created_at")
  token             Token    @relation(...)
  @@unique([tokenId, period])
  @@map("usage")
}

model Job {
  id              String    @id @default(uuid())
  tokenId         String    @map("token_id")
  status          JobStatus @default(PENDING)
  inputFiles      Json      @map("input_files")
  outputFileUrl   String?   @map("output_file_url")
  errorMessage    String?   @map("error_message")
  createdAt       DateTime  @default(now()) @map("created_at")
  startedAt       DateTime? @map("started_at")
  completedAt     DateTime? @map("completed_at")
  token           Token     @relation(...)
  @@map("jobs")
}

enum Plan { PRO }
enum TokenStatus { ACTIVE, CANCELLED, EXPIRED }
enum JobStatus { PENDING, PROCESSING, COMPLETED, FAILED }
```

================================================================
SPECS DOS PLANOS

### PLANO FREE

| Limite | Valor |
|--------|-------|
| Unificações/mês | 1 |
| Planilhas por unificação | 3 |
| Tamanho total | 1MB |
| Linhas totais (soma) | 500 |
| Colunas selecionáveis | 3 |
| Marca d'água | Obrigatória (aba "Sobre" + coluna "Gerado por Tablix") |
| Processamento | Client-side (frontend) |

**Free NÃO usa o backend para processamento.**
Backend só é chamado para validar se usuário tem token Pro.

### PLANO PRO

| Limite | Valor |
|--------|-------|
| Unificações/mês | 40 |
| Planilhas por unificação | 15 |
| Tamanho por planilha | Sem limite |
| Tamanho total | 30MB |
| Linhas por planilha | Sem limite |
| Linhas totais (merge) | 75.000 |
| Colunas selecionáveis | 15 |
| Marca d'água | Não tem |
| Processamento | Server-side (backend) |

**Constantes de limites:** `src/lib/spreadsheet/types.ts` (PRO_LIMITS)

================================================================
PROCESSAMENTO DE ARQUIVOS

**Decisão arquitetural: Síncrono + Assíncrono**

| Cenário | Tipo | Justificativa |
|---------|------|---------------|
| Arquivos <10MB | Síncrono | Rápido (<5s), resposta imediata |
| Arquivos >10MB | Assíncrono | Evita timeout, usa fila BullMQ |

### Fluxo Síncrono (<10MB) ✅ IMPLEMENTADO

```
POST /process/sync (multipart/form-data)
├── Rate limit (10 req/min)
├── Valida JWT (authMiddleware)
├── Valida limites do plano (unificações, arquivos, tamanho)
├── Para cada arquivo:
│   ├── Valida extensão (.csv, .xlsx, .xls)
│   ├── Faz parsing (papaparse para CSV, xlsx para Excel)
│   └── Valida colunas selecionadas existem
├── Valida limite total de linhas (75.000)
├── Executa merge das planilhas
├── Gera arquivo de saída (XLSX ou CSV)
├── Incrementa contador de uso (tabela Usage)
└── Retorna: { file (base64), fileName, fileSize, rowsCount, columnsCount, format }
```

### Fluxo Assíncrono (>10MB) 🔲 PENDENTE

```
POST /process/async
├── Valida token/JWT
├── Valida limites do plano
├── Salva arquivos em storage temporário
├── Cria job no PostgreSQL
├── Enfileira job no BullMQ
├── Retorna job_id

Worker BullMQ:
├── Pega job da fila
├── Faz parsing dos arquivos
├── Executa merge
├── Salva resultado em storage temporário
├── Atualiza job no PostgreSQL (completed + URL)
├── Incrementa contador de uso

GET /process/status/:jobId
├── Valida token/JWT
├── Retorna status do job
└── Se completed, retorna URL para download

GET /process/download/:jobId
├── Valida token/JWT
├── Retorna arquivo
└── Deleta arquivo do storage (entrega única)
```

================================================================
ENDPOINTS DA API

### Autenticação ✅ IMPLEMENTADO

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /auth/validate-token | Valida token Pro e retorna JWT | Não | 5/min |
| POST | /auth/refresh | Renova JWT expirado | Não (JWT expirado no body) | 10/min |
| GET | /auth/me | Retorna dados do usuário/plano | JWT | 60/min |
| POST | /auth/logout | Logout (client-side) | JWT | 100/min |

### Billing ✅ IMPLEMENTADO

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| POST | /billing/create-checkout | Cria sessão de checkout Stripe | Não | 20/min |
| POST | /billing/portal | Gera URL do Customer Portal | JWT | 20/min |
| GET | /billing/prices | Retorna preços disponíveis | Não | 100/min |
| POST | /webhooks/stripe | Recebe webhooks do Stripe | Stripe Signature | Sem limite |

### Processamento

| Método | Endpoint | Descrição | Auth | Rate Limit | Status |
|--------|----------|-----------|------|------------|--------|
| POST | /process/sync | Processa arquivos síncronamente | JWT | 10/min | ✅ IMPLEMENTADO |
| POST | /process/async | Inicia processamento assíncrono | JWT | 10/min | 🔲 Pendente |
| GET | /process/status/:jobId | Status do job assíncrono | JWT | 60/min | 🔲 Pendente |
| GET | /process/download/:jobId | Download do resultado | JWT | 10/min | 🔲 Pendente |

### Uso/Limites (Pendente - Fase 8)

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| GET | /usage | Retorna uso atual do mês | JWT | 60/min |
| GET | /limits | Retorna limites do plano | JWT | 100/min |

### Health ✅ IMPLEMENTADO

| Método | Endpoint | Descrição | Auth | Rate Limit |
|--------|----------|-----------|------|------------|
| GET | /health | Health check | Não | Sem limite |
| GET | /docs | Swagger UI | Não | Sem limite |
| GET | /docs/json | OpenAPI spec | Não | Sem limite |

================================================================
REDIS & RATE LIMITING ✅ IMPLEMENTADO

**Instância:** Upstash Redis (mesma do frontend)
**Biblioteca:** @upstash/ratelimit (sliding window)

**Por que Upstash e não in-memory?**
- Deploy na Vercel = serverless = instâncias efêmeras
- Rate limit in-memory não funciona (cada request pode ir para instância diferente)
- Upstash Redis mantém estado compartilhado entre todas as instâncias

**Prefixos de chave:**

| Sistema | Prefixo | Exemplo |
|---------|---------|---------|
| Frontend | `front:` | `front:upload:{fingerprint}:2024-01` |
| Backend | `tablix:ratelimit:` | `tablix:ratelimit:validate-token:{ip}` |

**Rate Limits por Endpoint:**

| Endpoint | Limite | Limiter | Justificativa |
|----------|--------|---------|---------------|
| `/auth/validate-token` | 5/min | `validateToken` | Anti brute-force |
| `/auth/refresh` | 10/min | `authRefresh` | Uso esporádico |
| `/auth/me` | 60/min | `authMe` | Frontend pode polling |
| `/auth/logout` | 100/min | `global` | Uso normal |
| `/billing/create-checkout` | 20/min | `billing` | Operação esporádica |
| `/billing/portal` | 20/min | `billing` | Operação esporádica |
| `/billing/prices` | 100/min | `global` | Cache no frontend |
| `/webhooks/stripe` | Sem limite | — | Stripe pode enviar vários |
| `/health` | Sem limite | — | Monitoramento |
| `/process/sync` | 10/min | `process` | ✅ Implementado |

**Headers de resposta (quando rate limited):**
- `X-RateLimit-Limit`: Limite total
- `X-RateLimit-Remaining`: Requisições restantes
- `X-RateLimit-Reset`: Timestamp de reset
- `Retry-After`: Segundos até poder tentar novamente

**Comportamento em dev (sem Redis):**
- Se `UPSTASH_REDIS_REST_URL` não configurado, rate limit é ignorado
- Permite rodar localmente sem Redis

**Usos futuros no backend:**
- Cache de sessão JWT (opcional)
- Fila BullMQ (se usar Redis como broker)

================================================================
NOTIFICAÇÕES DE ERRO

Erros devem ser claros e específicos, seguindo o padrão do frontend:

```json
{
  "error": {
    "code": "LIMIT_EXCEEDED",
    "message": "Limite de tamanho excedido",
    "details": {
      "limit": "2MB",
      "actual": "2.5MB",
      "file": "planilha3.xlsx"
    }
  }
}
```

**Códigos de erro padronizados:**

| Código | Descrição |
|--------|-----------|
| INVALID_TOKEN | Token inválido ou expirado |
| TOKEN_ALREADY_USED | Token já vinculado a outro fingerprint |
| SUBSCRIPTION_EXPIRED | Assinatura expirada |
| LIMIT_EXCEEDED | Limite do plano excedido |
| RATE_LIMITED | Muitas requisições |
| PROCESSING_FAILED | Erro no processamento |
| JOB_NOT_FOUND | Job não encontrado |
| VALIDATION_ERROR | Erro de validação de dados |

================================================================
VARIÁVEIS DE AMBIENTE

**Arquivo:** `.env` (não commitado)
**Template:** `.env.example`

```env
# Server
PORT=3333
NODE_ENV=development
API_URL=http://localhost:3333  # URL base da API (usado no Swagger)

# Database (Supabase PostgreSQL)
# Usar pooler (porta 6543) para queries da aplicação
DATABASE_URL=postgresql://postgres.{ref}:{password}@aws-1-us-east-2.pooler.supabase.com:6543/postgres
# Conexão direta (porta 5432) para migrations - usar quando rede permitir
# DIRECT_URL=postgresql://postgres:{password}@db.{ref}.supabase.co:5432/postgres

# Redis (mesmo do frontend - usado para rate limiting)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_MONTHLY_PRICE_ID=price_...
STRIPE_PRO_YEARLY_PRICE_ID=price_...

# Email (para envio de tokens)
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
FROM_EMAIL=Tablix <noreply@tablix.com.br>  # Remetente dos emails

# JWT
JWT_SECRET=... (mínimo 32 caracteres)
JWT_EXPIRES_IN=30d

# Frontend
FRONTEND_URL=https://tablix.com
```

**Nota sobre Supabase:**
- Senhas com caracteres especiais ($, @, etc) devem ser URL-encoded no DATABASE_URL
- Exemplo: `$` → `%24`
- Para criar tabelas manualmente, usar SQL Editor no dashboard (arquivo `prisma/setup.sql`)

================================================================
REGRAS DE EXECUÇÃO PARA O CLAUDE

- NÃO gerar código sem alinhamento prévio
- NÃO duplicar lógica que já existe no frontend
- NÃO assumir decisões de produto sem validar
- SEMPRE validar se endpoint/funcionalidade já existe no front
- SEMPRE seguir os padrões de erro definidos
- SEMPRE considerar os dois fluxos (síncrono e assíncrono)
- SEMPRE atualizar este documento após implementações

================================================================
ESTRUTURA DE PASTAS (Atual)

```
tablix-back/
├── .claude/
│   └── commands/                  # Comandos/contexto para Claude
│       ├── start.md               # Modo sócio genérico
│       ├── tablix.md              # Contexto do frontend
│       └── tablix-back.md         # ESTE ARQUIVO
├── prisma/
│   ├── schema.prisma              # ✅ Schema do banco (Token, Usage, Job)
│   └── setup.sql                  # ✅ SQL para criar tabelas no Supabase
├── src/
│   ├── @types/
│   │   └── index.d.ts             # ✅ Extensão FastifyRequest (user?: JwtPayload)
│   ├── config/
│   │   ├── env.ts                 # ✅ Validação Zod de env vars
│   │   ├── redis.ts               # ✅ Cliente Upstash Redis (singleton)
│   │   └── rate-limit.ts          # ✅ Configuração dos rate limiters
│   ├── errors/
│   │   └── app-error.ts           # ✅ AppError + factory Errors.*
│   ├── http/
│   │   ├── controllers/
│   │   │   ├── auth.controller.ts     # ✅ validateToken, refresh, me, logout
│   │   │   ├── billing.controller.ts  # ✅ createCheckout, portal, prices
│   │   │   ├── process.controller.ts  # ✅ processSync (multipart) ✅ NOVO
│   │   │   └── webhook.controller.ts  # ✅ stripeWebhook
│   │   └── routes/
│   │       ├── index.ts               # ✅ registerRoutes()
│   │       ├── auth.routes.ts         # ✅ /auth/*
│   │       ├── billing.routes.ts      # ✅ /billing/*
│   │       ├── process.routes.ts      # ✅ /process/* ✅ NOVO
│   │       └── webhook.routes.ts      # ✅ /webhooks/*
│   ├── lib/
│   │   ├── email.ts               # ✅ Resend SDK + templates HTML/texto
│   │   ├── jwt.ts                 # ✅ JWT sign/verify/decode
│   │   ├── prisma.ts              # ✅ Singleton Prisma Client
│   │   ├── token-generator.ts     # ✅ Gerador tbx_pro_* (256 bits)
│   │   └── spreadsheet/           # ✅ NOVO - Módulo de planilhas
│   │       ├── index.ts           # ✅ Re-exports
│   │       ├── types.ts           # ✅ Tipos + PRO_LIMITS
│   │       ├── parser.ts          # ✅ Parse CSV/XLSX/XLS
│   │       └── merger.ts          # ✅ Merge + geração de output
│   ├── middleware/
│   │   ├── auth.middleware.ts     # ✅ authMiddleware, optionalAuthMiddleware
│   │   └── rate-limit.middleware.ts # ✅ Rate limit por endpoint (Upstash)
│   ├── modules/
│   │   ├── auth/                  # ✅ MÓDULO COMPLETO
│   │   │   ├── auth.schema.ts     # ✅ Schemas Zod (validateToken, refresh, me)
│   │   │   └── auth.service.ts    # ✅ Lógica de autenticação
│   │   ├── billing/               # ✅ MÓDULO COMPLETO
│   │   │   ├── billing.schema.ts  # ✅ Schemas Zod (checkout, portal, prices)
│   │   │   ├── stripe.service.ts  # ✅ SDK Stripe (checkout, portal, webhook)
│   │   │   └── webhook.handler.ts # ✅ Handlers: checkout, subscription, invoice
│   │   └── process/               # ✅ NOVO - MÓDULO COMPLETO
│   │       ├── process.schema.ts  # ✅ Schemas Zod (processSync input/response)
│   │       └── process.service.ts # ✅ Lógica: validação limites, parse, merge
│   ├── schemas/
│   │   └── common.schema.ts       # ✅ Schemas compartilhados (error, usage, limits, plan)
│   ├── app.ts                     # ✅ Fastify + plugins + Swagger + registerRoutes()
│   └── server.ts                  # ✅ Entry point (listen :3333)
├── .env                           # 🔒 Variáveis locais (não commitado)
├── .env.example                   # ✅ Template documentado
├── .eslintrc.json                 # ✅ ESLint com @rocketseat/eslint-config ✅ NOVO
├── package.json                   # ✅ Scripts: dev, build, test, db:*
├── tsconfig.json                  # ✅ ES2020, strict, outDir: ./dist
└── vitest.config.ts               # ⚠️ Esperado mas não encontrado
```

**Módulos a criar (próximas fases):**
- `src/jobs/` - BullMQ workers para processamento assíncrono (Fase 6)
- `src/lib/storage.ts` - S3/R2 para arquivos temporários (Fase 7)
- `src/modules/usage/` - Endpoints de uso e limites (Fase 8)
- `src/lib/cache.ts` - Cache de sessões JWT (opcional)

================================================================
SINCRONIZAÇÃO FRONT-END ↔ BACK-END
================================================================

### Estado Atual do Frontend (de tablix.md)

O frontend Next.js já implementa:
- ✅ Upload e parsing client-side (<10MB)
- ✅ Merge de planilhas com seleção de colunas
- ✅ Marca d'água para Free (aba "Sobre" + coluna)
- ✅ Rate limiting via Upstash Redis
- ✅ Controle de uso via fingerprint + Redis
- ✅ Validação de limites por plano
- ✅ i18n (pt-BR, en, es)

### O que o Frontend AGUARDA do Backend

| Funcionalidade | Endpoint Esperado | Status |
|----------------|-------------------|--------|
| Validar token Pro | `POST /auth/validate-token` | ✅ Implementado |
| Dados do usuário/plano | `GET /auth/me` | ✅ Implementado |
| Refresh de sessão | `POST /auth/refresh` | ✅ Implementado |
| Checkout Stripe | `POST /billing/create-checkout` | ✅ Implementado |
| Customer Portal | `POST /billing/portal` | ✅ Implementado |
| Processamento síncrono | `POST /process/sync` | ✅ Implementado |
| Processamento assíncrono | `POST /process/async` | 🔲 Pendente |
| Status do job | `GET /process/status/:id` | 🔲 Pendente |
| Download resultado | `GET /process/download/:id` | 🔲 Pendente |

### Fluxo de Integração (Próximos Passos)

```
1. ✅ Backend implementa /auth/validate-token
2. Frontend substitui fingerprint por token Pro
3. ✅ Frontend chama /auth/me para detectar plano real
4. ✅ Frontend usa /billing/* para upgrade/portal
5. ✅ Frontend usa /process/sync para arquivos (Pro)
6. 🔲 Frontend usa /process/async para arquivos >10MB (Pro) - FASE 6
```

### Notas de Compatibilidade

- **CORS:** Backend aceita apenas `FRONTEND_URL` (configurado em .env)
- **Autenticação:** Todos os endpoints protegidos usam JWT (Authorization: Bearer)
- **Prefixos Redis:** Frontend usa `front:`, backend deve usar `back:`
- **Fingerprint:** Vinculado ao token Pro no primeiro uso (não substituído)

================================================================
CHANGELOG
================================================================

### 2026-01-22 — Fase 5: Processamento de Arquivos ✅
- ✅ Instalado xlsx (parse Excel), papaparse (parse CSV), @fastify/multipart (upload)
- ✅ Instalado @types/papaparse (tipos TypeScript)
- ✅ Registrado @fastify/multipart no app.ts (limits: 30MB, 15 arquivos)
- ✅ Criado módulo src/lib/spreadsheet/:
  - types.ts: PRO_LIMITS, tipos (ParsedSpreadsheet, MergedResult, OutputFile)
  - parser.ts: parseSpreadsheet (CSV via papaparse, Excel via xlsx)
  - merger.ts: mergeSpreadsheets, generateOutputFile (XLSX ou CSV)
  - index.ts: re-exports
- ✅ Criado módulo src/modules/process/:
  - process.schema.ts: processSyncInputSchema, processSyncResponseSchema
  - process.service.ts: validateProLimits, processSpreadsheets, incrementUsage
- ✅ Criado src/http/controllers/process.controller.ts: processSync (multipart)
- ✅ Criado src/http/routes/process.routes.ts: POST /process/sync com Swagger
- ✅ Registrado processRoutes em src/http/routes/index.ts
- ✅ Validação de limites Pro implementada:
  - 40 unificações/mês (consulta tabela Usage)
  - 15 arquivos/unificação
  - 30MB tamanho total
  - 75.000 linhas totais
  - 15 colunas selecionáveis
- ✅ Incremento de contador Usage após processamento bem-sucedido

### 2026-01-22 — Configuração ESLint
- ✅ Criado .eslintrc.json com @rocketseat/eslint-config/node
- ✅ Configurado argsIgnorePattern/varsIgnorePattern para prefixo "_"
- ✅ Corrigido erros de lint existentes:
  - process.routes.ts: escape desnecessário em template literal
  - auth.middleware.ts: parâmetro _reply não usado
  - webhook.handler.ts: declaração const em case block (adicionado escopo {})

### 2026-01-22 — Fase 9: Rate Limiting com Upstash
- ✅ Instalado @upstash/ratelimit e @upstash/redis
- ✅ Criado cliente Redis (src/config/redis.ts)
- ✅ Criado configuração de rate limiters (src/config/rate-limit.ts):
  - global: 100 req/min
  - validateToken: 5 req/min (anti brute-force)
  - authRefresh: 10 req/min
  - authMe: 60 req/min
  - billing: 20 req/min
  - process: 10 req/min
- ✅ Criado middleware de rate limit (src/middleware/rate-limit.middleware.ts)
- ✅ Aplicado rate limit em todos os endpoints (exceto webhooks e health)
- ✅ Headers X-RateLimit-* e Retry-After nas respostas
- ✅ Fallback: se Redis não configurado, rate limit é ignorado (dev local)
- ✅ Movido hardcoded para ENV:
  - API_URL (Swagger server URL)
  - FROM_EMAIL (remetente de emails)

### 2026-01-22 — Swagger/OpenAPI Configurado
- ✅ Instalado fastify-type-provider-zod v4.0.2
- ✅ Instalado zod-to-json-schema v3.25.1
- ✅ Configurado jsonSchemaTransform no registro do Swagger
- ✅ Schemas Zod agora são convertidos automaticamente para JSON Schema
- ✅ Swagger UI disponível em GET /docs
- ✅ OpenAPI spec disponível em GET /docs/json
- ✅ Criada pasta src/schemas/ para schemas compartilhados
- ✅ common.schema.ts com: errorResponseSchema, usageSchema, limitsSchema, planSchema

### 2026-01-15 — Refatoração: Routes + Controllers
- ✅ Criada pasta src/http/controllers/
- ✅ Separada lógica de handlers em controllers:
  - auth.controller.ts (validateToken, refresh, me, logout)
  - billing.controller.ts (createCheckout, portal, prices)
  - webhook.controller.ts (stripeWebhook)
- ✅ Routes agora são declarativos (só mapeamento path → controller)
- ✅ Centralizado registro de rotas em src/http/routes/index.ts

### 2026-01-15 — Fase 4: Autenticação (JWT + Token)
- ✅ Instalado jsonwebtoken
- ✅ Criado JWT service (src/lib/jwt.ts):
  - generateSessionJwt - gera JWT de sessão
  - verifyJwt - verifica e decodifica JWT
  - decodeJwt - decodifica sem verificar (para refresh)
  - extractBearerToken - extrai token do header
  - verifyJwtOrThrow - verifica ou lança exceção
- ✅ Criado middleware de autenticação (src/middleware/auth.middleware.ts):
  - authMiddleware - requer JWT válido
  - optionalAuthMiddleware - tenta autenticar mas não falha
- ✅ Criado módulo auth (src/modules/auth/):
  - POST /auth/validate-token - valida token Pro, vincula fingerprint, retorna JWT
  - POST /auth/refresh - renova JWT expirado
  - GET /auth/me - retorna dados do usuário e uso mensal
  - POST /auth/logout - logout (stateless)
- ✅ Criado auth.service.ts com lógica de:
  - Validação de token Pro
  - Vinculação de fingerprint no primeiro uso
  - Verificação de status da assinatura
  - Refresh de sessão
- ✅ Refatorado billing/portal para usar authMiddleware
- ✅ Declaração de tipos Fastify para request.user

### 2026-01-15 — Fase 3: Email (Resend)
- ✅ Instalado Resend SDK v4.x
- ✅ Criado email service (src/lib/email.ts) com funções:
  - sendTokenEmail - envia token Pro após checkout
  - sendCancellationEmail - notifica cancelamento de assinatura
  - sendPaymentFailedEmail - notifica falha de pagamento
- ✅ Templates HTML responsivos com fallback texto puro
- ✅ Integrado com webhook.handler.ts:
  - checkout.session.completed → envia token por email
  - customer.subscription.deleted → envia notificação de cancelamento
  - invoice.payment_failed → envia alerta de falha de pagamento
- ✅ Tratamento de erro resiliente (falha de email não bloqueia webhook)

### 2026-01-15 — Sincronização de Documentação
- ✅ Atualizado tablix-back.md com estado real do código
- ✅ Adicionada seção "Sincronização Front-End ↔ Back-End"
- ✅ Documentadas todas as dependências do package.json
- ✅ Adicionada seção "Pendências Técnicas (TODOs no código)"
- ✅ Atualizada estrutura de pastas com arquivos reais
- ✅ Adicionado endpoint GET /billing/prices à tabela de rotas

### 2025-01-15 — Fase 2: Billing (Stripe)
- ✅ Instalado Stripe SDK v20.1.2
- ✅ Criado sistema de erros padronizados (src/errors/app-error.ts)
- ✅ Criado gerador de tokens Pro (src/lib/token-generator.ts)
- ✅ Criado Stripe service com funções:
  - createCheckoutSession (embedded checkout)
  - createPortalSession (customer portal)
  - constructWebhookEvent (validação de assinatura)
  - getCheckoutSession, getSubscription (consultas)
  - getPriceIds (retorna IDs de preço configurados)
- ✅ Criado rotas de billing:
  - POST /billing/create-checkout
  - POST /billing/portal
  - GET /billing/prices
- ✅ Criado webhook handler para eventos Stripe:
  - checkout.session.completed → cria token Pro no banco
  - customer.subscription.updated → atualiza status do token
  - customer.subscription.deleted → marca como cancelado
  - invoice.payment_failed → log (TODO: email)
- ✅ Configurado app.ts com:
  - CORS (origin: FRONTEND_URL)
  - Helmet (CSP em produção)
  - Error handler global (AppError, validação, genérico)
  - Health check: GET /health
- ✅ Webhook com raw body parser (requisito Stripe)

### 2025-01-15 — Fase 1: Fundação
- ✅ Configurado Fastify 5.x + TypeScript
- ✅ PostgreSQL via Supabase (pooler porta 6543)
- ✅ Prisma ORM com schema:
  - Token (id, token, fingerprint, stripeCustomerId, status, email, etc)
  - Usage (tokenId, period YYYY-MM, unificationsCount)
  - Job (tokenId, status, inputFiles JSON, outputFileUrl, etc)
- ✅ Enums: Plan (PRO), TokenStatus (ACTIVE/CANCELLED/EXPIRED), JobStatus
- ✅ Índices otimizados para queries frequentes
- ✅ Validação de env vars com Zod
- ✅ Scripts npm: dev, build, test, db:generate/migrate/push/studio/seed

================================================================
🚀 STATUS DE DEPLOY (2026-01-22)
================================================================

**Backend está pronto para deploy de staging.**

O core está funcional:
- ✅ Autenticação JWT + Token Pro
- ✅ Billing Stripe (checkout, portal, webhooks)
- ✅ Email com Resend (envio de tokens)
- ✅ Processamento síncrono (/process/sync)
- ✅ Rate limiting com Upstash
- ✅ Health check + Swagger

O que falta mas **não bloqueia** deploy:
- 🔲 BullMQ (assíncrono) - síncrono funciona para arquivos <30MB
- 🔲 S3/R2 (storage) - só necessário para assíncrono
- 🔲 Endpoints /usage /limits - pode adicionar depois
- 🔲 Testes automatizados - risco, mas não bloqueia

**Decisão de hospedagem:**
- **Recomendado:** Railway ou Render
- **Não recomendado:** Vercel (Fastify é servidor tradicional, não serverless)

**Por que não Vercel?**
- Cold starts prejudicam UX
- Conexões com PostgreSQL ficam instáveis
- Rate limiting por IP inconsistente (requests vão para instâncias diferentes)
- WebSocket/long-polling não funciona bem

**Checklist pré-deploy:**
1. [ ] Configurar variáveis de ambiente no serviço escolhido
2. [ ] Configurar Stripe webhook URL para produção
3. [ ] Verificar CORS apontando para URL do frontend
4. [ ] Testar health check (/health)
5. [ ] Testar Swagger (/docs)

================================================================
PENDÊNCIAS TÉCNICAS (TODOs no código)
================================================================

Nenhuma pendência técnica crítica no momento.

**Próximos passos (Fase 6):**
- Implementar processamento assíncrono com BullMQ
- Endpoints /process/async, /process/status/:id, /process/download/:id

================================================================
