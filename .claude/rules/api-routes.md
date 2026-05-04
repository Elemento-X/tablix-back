---
paths:
  - "src/http/routes/**/*.ts"
  - "src/http/controllers/**/*.ts"
  - "src/http/middlewares/**/*.ts"
  - "src/modules/**/*.routes.ts"
  - "src/modules/**/*.schema.ts"
  - "src/schemas/**/*.ts"
---

# API Routes (Fastify)

> **Escopo desta rule:** padrões práticos e operacionais do Fastify — estrutura de rotas, config do framework, health checks, timeouts, graceful degradation. Para disciplina de **contrato** (breaking changes, versionamento, envelope, idempotency, ETag, paginação, bulk ops, precisão numérica, webhooks outbound, SDK), ver `api-contract.md`.

## Referência cruzada

- **`api-contract.md`** — disciplina de contrato: versionamento, breaking changes, envelope `{ "data" }` / `{ "error" }`, paginação cursor-based, idempotency, ETag, bulk ops, LRO, precisão numérica, webhooks outbound, SDK generation, CI gate, deprecation.
- **`security.md`** — auth (deny-by-default, JWT, CSRF, timing-safe), rate limit (3 camadas), input validation, multitenancy/IDOR, error discrimination, Content-Type enforcement, supply chain.
- **`qa-pipeline.md`** — path-matrix que determina quais rules e agentes carregam por arquivo tocado.

## Estrutura obrigatória

- Routes são declarativas: só mapeamento `path → controller`. Lógica vai no controller (`src/http/controllers/`), regras de negócio no service (`src/modules/<modulo>/<modulo>.service.ts`).
- Schemas Zod obrigatórios para request (body/params/query) e response — alimentam o Swagger automaticamente via `fastify-type-provider-zod`.
- Nunca declarar schema inline na rota: schemas ficam em `src/modules/<modulo>/<modulo>.schema.ts` ou `src/schemas/common.schema.ts` quando compartilhados.

## Sorting e filtering (complemento ao api-contract)

- **Sort**: query param `?sort=field:direction` (ex: `?sort=created_at:desc`). Múltiplos sorts separados por vírgula: `?sort=status:asc,created_at:desc`.
- **Filter**: query param com nome do campo (ex: `?status=active`, `?created_after=2026-01-01`). Nunca aceitar filtros arbitrários — cada rota define quais campos são filtráveis no schema Zod.
- **Validação**: campos de sort e filter DEVEM ser validados via Zod enum (allowlist). Nunca passar valor do client direto pro `orderBy` ou `where` do Prisma — injection via sort field (`?sort=password:asc`).
- **Schema compartilhado**: helpers de sort/filter em `src/schemas/common.schema.ts` (ex: `createSortSchema(['created_at', 'status'])`).

## HTTP status codes (quick reference)

Tabela rápida pra consulta durante implementação. Definição autoritativa em `api-contract.md`.

| Operação | Sucesso | | Erro | Status |
|----------|---------|---|------|--------|
| GET recurso | `200` | | Validação | `400` |
| GET lista | `200` | | Não autenticado | `401` |
| POST criação | `201` + `Location` | | Sem permissão | `403` |
| PUT/PATCH | `200` | | Não encontrado | `404` |
| DELETE | `204` | | Conflito | `409` |
| Ação sem retorno | `204` | | Rate limited | `429` |

## Request ID e rastreabilidade

- **`X-Request-Id`**: se o cliente enviar, usar o valor. Se não, gerar UUID v4 automaticamente (plugin Fastify ou middleware).
- Request ID deve estar em **todo log** daquela request (request id, rota, status, latência).
- Request ID deve ser retornado no **response header** `X-Request-Id` — permite o cliente correlacionar.
- **Correlation**: se a request dispara chamada a serviço externo (Stripe, Resend), logar o request ID junto com o external request ID.

## Timeout por rota

- **Timeout global**: configurar `connectionTimeout` e `requestTimeout` no Fastify (ex: 30s).
- **Rotas de processamento pesado** (upload + parse de planilha): timeout estendido explícito (ex: 120s) via `request.raw.setTimeout()` ou config por rota.
- **Regra**: se uma rota pode demorar > 10s, ela deve ser assíncrona (aceitar o request, processar em background, retornar status via polling ou webhook). Pattern LRO detalhado em `api-contract.md`.

## Health check

- **`/health`** (ou `/healthz`): verifica conectividade real, não só uptime do processo.
  - DB: `SELECT 1` via Prisma
  - Stripe: API key válida (cache de 60s, não verificar em todo request)
  - Resultado: `200 { "status": "healthy", "checks": { "db": "ok", "stripe": "ok" } }` ou `503` se qualquer check crítico falhar.
- **`/ready`** (opcional): indica que o server está pronto pra receber tráfego (útil pra Fly.io health checks).
- Health check NÃO passa por auth middleware nem rate limit.

## Graceful degradation

- **Fail fast**: se dependência crítica (DB) está down, retornar `503 Service Unavailable` imediatamente. Não tentar retry dentro do request.
- **Dependência não-crítica** (ex: Stripe metadata fetch para enriquecer resposta): continuar sem o dado, logar warning, retornar resposta parcial.
- **Circuit breaker mental**: se uma dependência externa está falhando consistentemente, as rotas que dependem dela devem retornar erro rápido em vez de acumular timeouts.
- **Regra**: nunca mascarar falha de dependência como sucesso. Sempre comunicar ao cliente que algo está degradado (via header `X-Degraded: stripe` ou campo no response).

## Cache headers (quick reference)

Detalhes de ETag, `If-None-Match`, optimistic concurrency em `api-contract.md`.

- **GET estável** (planos, configs): `Cache-Control: public, max-age=300` + `ETag`.
- **GET dinâmico** (usage, subscription): `Cache-Control: private, no-cache` + `ETag`.
- **Respostas autenticadas**: sempre `Cache-Control: private`.
- **Mutations**: `Cache-Control: no-store`.
- **Regra**: toda rota GET DEVE ter `Cache-Control` explícito.

## Segurança por rota

Regras completas em `security.md`. Quick reference:

- **Rate limiting obrigatório** em toda rota pública exceto `/webhooks/stripe` e `/health`. Usar limiters de `src/config/rate-limit.ts` via `rateLimitMiddleware`.
- **Auth middleware** (`authMiddleware` de `src/middleware/auth.middleware.ts`) em toda rota protegida. `optionalAuthMiddleware` só onde faz sentido.
- **Validação de limites do plano** via service (`process.service.ts` já tem `validateProLimits`) — nunca hardcodar limites, usar `PRO_LIMITS` de `src/lib/spreadsheet/types.ts`.
- **Content-Type** validado implicitamente pelo Zod; para `multipart/form-data` usar `@fastify/multipart` com limites já configurados no `app.ts` (30MB, 15 arquivos).

## Erros

- Usar `AppError` + factory `Errors.*` de `src/errors/app-error.ts`. Nunca `throw new Error()` cru em route/controller.
- Formato, error codes e envelope definidos em `api-contract.md`. Registry em `src/errors/error-codes.ts`.
- Nunca expor stack trace, SQL error, nem mensagem do Prisma ao cliente em produção.

## Webhooks (recebidos)

- `/webhooks/stripe` precisa de raw body (já configurado). **Nunca** adicionar parser JSON antes do handler.
- Toda verificação de assinatura Stripe via `stripe.service.ts → constructWebhookEvent`. Nunca confiar em header sem verificar assinatura.
- Handler de webhook deve ser **idempotente** — mesmo evento pode chegar múltiplas vezes.
- Webhooks **enviados** (outbound): ver `api-contract.md`.

## Swagger

- Toda rota nova precisa de `schema.tags`, `schema.summary`, `schema.description` e schemas Zod de input/output para aparecer corretamente em `/docs`.
- Exemplos em `src/http/routes/auth.routes.ts` e `process.routes.ts`.
- OpenAPI components e SDK discipline em `api-contract.md`.

## Proibições

- NÃO registrar rotas fora de `src/http/routes/` e `src/http/routes/index.ts`.
- NÃO usar `request.body as any` — sempre tipagem via Zod.
- NÃO logar `request.headers.authorization`, tokens, nem body de `/auth/*` e `/webhooks/stripe`.
- NÃO retornar dados do Prisma direto (`Token`, `Usage`) — mapear para DTO do response schema.
- NÃO retornar objeto solto no top-level — sempre envelope `{ "data": ... }`.
- Lista completa de proibições de contrato em `api-contract.md`.
