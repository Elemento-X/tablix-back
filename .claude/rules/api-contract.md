---
paths:
  - "src/http/routes/**/*.ts"
  - "src/http/controllers/**/*.ts"
  - "src/http/middlewares/**/*.ts"
  - "src/modules/**/*.routes.ts"
  - "src/modules/**/*.schema.ts"
  - "src/schemas/**/*.ts"
---

# API Contract — disciplina de contrato

A API é um **contrato público** com consumidores (frontend, integradores, mobile, parceiros). Toda mudança que quebra esse contrato sem aviso é incidente — independente de "estar em produção" ou não. Esta rule define a disciplina mínima.

## Referência cruzada

- **`api-routes.md`** — padrões operacionais Fastify: estrutura de rotas, sorting/filtering, request ID, timeouts, health check, graceful degradation, config de segurança por rota.
- **`security.md`** — auth, rate limit, input validation, multitenancy, error discrimination, supply chain.
- **`qa-pipeline.md`** — path-matrix que determina quais rules e agentes carregam por arquivo tocado.

## Princípio fundamental

**O schema é a fonte da verdade, não o código.** O schema Zod (que alimenta o Swagger via `fastify-type-provider-zod`) define o que entra e o que sai. Implementação muda; contrato é estável.

- Schema declarado **antes** do código do controller, não depois.
- Toda rota tem schema completo: `params`, `querystring`, `body`, `response[2xx]`, `response[4xx]`.
- Schema sem `response` declarado é finding **ALTO** — significa que o consumidor não tem garantia do shape.
- `/docs` (Swagger UI) é gerado automaticamente. Se a rota não aparece corretamente, o schema está incompleto.

## Estilo de API

Esta rule é primariamente **REST** (HTTP semantics), porque o Tablix é REST via Fastify. Para projetos não-REST, os princípios análogos:

- **GraphQL** — schema-first, deprecação por `@deprecated`, persisted queries pra controle de versão, evolução aditiva (nunca remover field sem deprecação).
- **tRPC** — types compartilhados são o contrato; quebra typing = breaking change. Versionamento via namespace.
- **gRPC** — `.proto` é o contrato; reservar field numbers, nunca renumerar, evolução aditiva.

Em qualquer estilo, as regras de **precisão numérica, idempotência, deprecação e auth-como-contrato** abaixo se aplicam igualmente.

## O que é breaking change

Tratar como breaking change qualquer um destes:

**Em request:**
- Adicionar campo obrigatório novo
- Tornar campo opcional → obrigatório
- Estreitar tipo (string → enum, number → integer com range)
- Remover campo aceito
- Renomear campo
- Mudar formato (ISO date → unix timestamp)
- Mudar regra de validação (max length menor, pattern mais restrito)
- Adicionar header obrigatório
- Mudar método HTTP de uma rota existente
- Mudar path/route

**Em response:**
- Remover campo
- Renomear campo
- Mudar tipo de campo (string → number, object → array)
- Tornar campo obrigatório → opcional/null (**breaking**)
- Mudar enum: remover valor (**breaking**); adicionar valor pode ser breaking se cliente fizer exhaustive matching
- Mudar status code de sucesso (200 → 201)
- Mudar formato de erro

**Em comportamento (não óbvios):**
- **Mudar método de auth** (Bearer JWT → OAuth, ou exigir scope novo) — breaking.
- **Reduzir rate limit** declarado nos headers — breaking pra cliente que dependia do throughput.
- **Mudar timeout do servidor** pra menor — pode quebrar cliente com payload grande.
- **Mudar significado de campo** sem mudar tipo (`status: "active"` agora significa coisa diferente) — breaking semântico, mais perigoso porque schema não detecta.

**Não-breaking** (seguros):
- Adicionar campo opcional novo em request
- Adicionar campo novo em response
- Adicionar nova rota
- Relaxar validação (max length maior, pattern mais permissivo)
- Tornar campo opcional → obrigatório em response (não-breaking)

## Versionamento

- Versão atual da API é única, sem prefixo `/v1`. Quando houver primeira breaking change inevitável, **versionar via path** (`/v1`, `/v2`) — não via header.
- Mudanças não-breaking entram diretamente na versão atual.
- Deploy de breaking change **sem nova versão** é proibido — exige aprovação explícita do operador principal e plano de migração documentado.

### Version support window matrix

Quando houver mais de uma versão viva, **declarar política explícita** de quanto tempo cada versão é mantida:

| Versão | Status | Suporte até | Política |
|---|---|---|---|
| `/v2` | Current | — | Recebe features e fixes |
| `/v1` | Maintenance | data | Só fixes críticos e segurança |
| `/v0` | Sunset | data | Só lê headers `Sunset`/`Deprecation` |

- Janela mínima entre lançar `/v2` e desligar `/v1`: **12 meses** pra parceiros externos, **6 meses** pra uso só interno.
- Matriz documentada em `docs/api-versions.md` (ou equivalente), atualizada em todo lançamento de versão nova.
- Sem essa matriz, cliente não sabe quando vai quebrar. Finding **ALTO** se não existir.

## Deprecação

Quando um endpoint, campo ou comportamento for marcado pra remoção:

- **Header `Deprecation`** na response: `Deprecation: true` (RFC 8594).
- **Header `Sunset`** com data limite: `Sunset: Wed, 11 Nov 2026 23:59:59 GMT`.
- **Header `Link`** apontando pra alternativa: `Link: </v2/users>; rel="successor-version"`.
- Documentar no schema (`schema.deprecated: true` no Fastify).
- Logar uso do endpoint deprecado com `request_id`, `user_id`, `route` pra medir adoção da migração.
- **Janela mínima de deprecação:** 90 dias para consumidores externos, 30 dias para uso só interno. Encurtar exige justificativa.
- Endpoint sunset: retornar `410 Gone` (não `404`) para indicar removido conscientemente.

## Formato de resposta — consistência absoluta

**Sucesso:**
- `2xx` sempre. `200 OK` para GET/PUT/PATCH, `201 Created` para POST que cria recurso, `204 No Content` para DELETE/operações sem corpo.
- Response shape consistente entre rotas similares. Se `GET /users/:id` retorna `{ "data": {...} }`, `GET /companies/:id` não pode retornar `{...}` direto.
- Listagem paginada **sempre** retorna envelope: `{ "data": [...], "meta": { "cursor": "...", "hasMore": true, "total": 42 } }`. Nunca array cru no body. (Alinhado com `api-routes.md`.)

**Erro (padrão do projeto, não RFC 7807 — mantém o padrão atual):**
```json
{ "error": { "code": "LIMIT_EXCEEDED", "message": "...", "details": {} } }
```
- `code` é o discriminator estável (consumidor faz `switch` em cima dele). Nunca renomear código sem nova versão.
- `message` é human-readable, pode mudar texto livremente — **não é parte do contrato**.
- `details` é opcional, contém dados estruturados pra UI montar mensagem específica.
- Status code HTTP coerente com o `code`: `400` validação, `401` auth, `403` permissão, `404` não encontrado, `409` conflito, `410` gone, `412` precondition failed, `422` semântico inválido, `428` precondition required, `429` rate limit, `5xx` erro de servidor.
- Mesmo erro = mesmo `code` em toda a API. `INVALID_TOKEN` não pode ser `INVALID_AUTH_TOKEN` em uma rota e `TOKEN_INVALID` em outra.
- **Registry de error codes**: todos os códigos vivem em `src/errors/error-codes.ts` (enum ou const object). Novo código = nova entrada lá, nunca string literal espalhada.

## Precisão numérica e dinheiro

**JavaScript perde precisão em inteiros maiores que `2^53 - 1` (~9 quadrilhões).** JSON é parseado com `Number` por default em quase todo cliente. Isso é fonte real de bug financeiro silencioso.

- **Dinheiro nunca como `number`.** Sempre como **string decimal em centavos** (`"price_cents": "12345"`) ou string decimal completa (`"amount": "123.45"`).
- **IDs grandes (snowflake, bigserial) também como string** — nunca como `number`.
- Decimal de alta precisão (taxa, percentual com 6 casas) também como string.
- Schema declara explicitamente: campo de dinheiro é `z.string().regex(/^\d+$/)`, não `z.number()`.
- Stripe usa centavos como integer e cabe em `2^53` na maioria dos casos — mas a regra geral é string. **Não confiar que vai caber pra sempre.**
- `BigInt` em JavaScript não serializa pra JSON nativamente — virou string ou erro. Prevenir o erro definindo o serializer.
- Documentar a unidade explicitamente: `"price_cents"` deixa claro que é centavo. `"price"` é ambíguo e fonte de bug.

Auditar: toda rota que toca `Subscription`, `Invoice`, `Payment`, `Usage`, `Quota`, `Stripe` no Tablix DEVE retornar valores monetários como string.

## Empty state — disciplina

- Listagem vazia retorna `{ "data": [] }`, **nunca** `{ "data": null }`.
- Coleção opcional retorna array vazio, não `undefined` nem `null`. Cliente faz `.map()` sem checar.
- Objeto opcional ausente: declarar `null` explicitamente OU omitir campo — **escolher um e nunca misturar na mesma API**. Misturar quebra cliente que faz `if (field === undefined)` vs `if (field === null)`.
- String vazia (`""`) ≠ `null` ≠ ausente. Decidir o que cada um significa e documentar.

## Polymorphic responses — discriminated unions

Quando uma rota retorna tipos diferentes baseado em condição (ex: `GET /events/:id` retorna `EmailEvent | WebhookEvent | UserEvent`):

- **Discriminator field obrigatório, estável e no topo do objeto.** Padrão: `type` ou `kind`.
- Valor do discriminator é string SCREAMING_SNAKE_CASE estável (`"EMAIL_EVENT"`, `"WEBHOOK_EVENT"`).
- Schema usa `z.discriminatedUnion('type', [...])` — não `z.union([...])`. Discriminated union dá narrowing correto no client.
- **Adicionar variante nova é breaking** se o cliente faz exhaustive matching. Documentar política explicitamente.
- Documentar todas as variantes no Swagger via `oneOf` + `discriminator`.

## Idempotência

- **Toda mutação POST/PATCH/DELETE arriscada** (cobrança, criação de recurso caro, envio de email/notificação) **DEVE** aceitar header `Idempotency-Key` do cliente.
- Servidor armazena resultado da primeira execução por N horas (mínimo 24h). Repetição com mesma key retorna mesmo resultado, sem reexecutar.
- Webhooks recebidos **sempre** idempotentes por `event_id` do provider — regra já presente em `api-routes.md`.
- `GET`, `PUT`, `DELETE` são idempotentes por definição HTTP — implementação **deve respeitar isso**.
- `POST` que cria recurso e é chamado 2x sem idempotency key cria 2 recursos. Documentar esse comportamento ou exigir a key.

## PATCH semantics — escolher um padrão

`PATCH` é o método mais ambíguo do HTTP. Três padrões válidos, **escolher um e nunca misturar**:

- **JSON Merge Patch (RFC 7396)** — corpo é objeto parcial, campos presentes substituem, `null` apaga. Simples, mas não consegue: setar campo pra `null`, modificar item de array, ou diferenciar "ausente" de "não enviado". Padrão recomendado pra começar.
- **JSON Patch (RFC 6902)** — array de operações (`{op: "replace", path: "/email", value: "..."}`). Poderoso (suporta arrays, nested), mas verbose. Bom pra editores complexos.
- **Custom partial update** — body tem só os campos a mudar, semântica documentada. É o que a maioria das APIs faz na prática. Documentar explicitamente o comportamento de `null`.

Documentar a escolha em `CLAUDE.md` e usar `Content-Type` correto: `application/merge-patch+json` ou `application/json-patch+json` quando aplicável.

## Conditional requests, ETag e optimistic concurrency

Sem isso, **lost updates** acontecem silenciosamente: dois clientes leem, ambos editam, o último sobrescreve o primeiro sem aviso.

- **`ETag` em response** de recursos editáveis. Hash do conteúdo ou versão do recurso (`W/"42"`).
- **`If-Match` em PUT/PATCH/DELETE**: cliente envia o ETag que tinha quando leu. Servidor compara antes de aplicar.
  - Match → aplica, retorna novo ETag.
  - Mismatch → `412 Precondition Failed`. Cliente lê de novo, resolve conflito, tenta de novo.
- **`If-None-Match` em GET**: cliente envia ETag que tem em cache. Servidor responde `304 Not Modified` se não mudou.
- **`Last-Modified` / `If-Modified-Since`** — alternativa mais leve ao ETag, granularidade de segundo.
- Em rotas com `If-Match` obrigatório, sem header retorna `428 Precondition Required`. Forçar o cliente a usar concurrency control.

Auditar: rotas que editam `Subscription`, `Process`, `Workspace`, `User` no Tablix DEVEM ter ETag + `If-Match` no PATCH.

## Paginação

- **Cursor-based** preferido sobre offset-based. Offset quebra com inserções concorrentes e tem custo crescente.
- Cursor é opaco pro cliente — base64 de `{id, sort_value}` ou similar. Cliente nunca decodifica, só passa de volta.
- Resposta sempre tem: `next_cursor` (null se acabou), `has_more` (bool). `total` é opcional e caro — só inclui se for necessário e indexável.
- Limit máximo declarado e enforced no servidor. Default razoável (20–50).
- Direção (`order_by`, `order_dir`) é parte do cursor — não permitir trocar ordenação no meio da paginação.

## Filtros, ordenação e sparse fieldsets

- Filtros via querystring com nomes consistentes (`?status=active&created_after=2026-01-01`).
- Operadores explícitos quando necessário: `?price_gte=100&price_lte=500`.
- Ordenação: `?sort=created_at&order=desc` ou `?sort=-created_at` (escolher um padrão).
- Whitelist de campos filtráveis e ordenáveis no schema. **Não permitir filtro arbitrário** — vaza estrutura interna e abre injection vector.
- Sparse fieldsets opcional: `?fields=id,name,email` — útil pra reduzir payload, mas só se a regra de auth não depender de campos retornados.

## Array encoding em query params

Frameworks parseiam diferente. Decisão explícita obrigatória:

- **Repetido** — `?id=1&id=2&id=3` (RFC 3986 puro, padrão Fastify).
- **Bracket** — `?id[]=1&id[]=2` (PHP/Rails-style, requer parser).
- **Comma-separated** — `?id=1,2,3` (compacto, mas valor com vírgula vira bug).

Recomendado pra Fastify: **repetido**. Documentar e nunca aceitar os 3 formatos ao mesmo tempo (ambiguidade).

Limites:
- **Max items por array** explícito (ex: 100). Sem isso, cliente envia 10k IDs e o servidor faz N+1 queries.
- **Max querystring length** configurado no Fastify pra evitar abuso.

## Bulk operations

Endpoint que aceita N itens precisa decidir semântica antes de implementar:

- **All-or-nothing (atomic)** — se um falha, todos rollback. Transação do banco. Resposta `200` com todos OK ou `4xx` com erro único.
- **Partial success** — cada item processado independente. Resposta `207 Multi-Status` ou `200` com:
  ```json
  {
    "success_count": 8,
    "failure_count": 2,
    "results": [
      { "index": 0, "status": "ok", "id": "..." },
      { "index": 1, "status": "error", "code": "DUPLICATE", "message": "..." }
    ]
  }
  ```
- **Async batch** — recebe job, retorna `202 Accepted` + `Location` pra polling. Ver Long-running operations abaixo.

Documentar a semântica no schema. Mudar de all-or-nothing pra partial success **é breaking change**.

Limites: max items por request explícito (ex: 100 ou 1000). Sem isso, cliente envia 50k itens e trava o servidor.

## Long-running operations (LRO) — pattern async

Operações que demoram mais que ~5s **NÃO** devem segurar a conexão HTTP. Padrão Google AIP / industry standard:

1. Cliente envia `POST /process`.
2. Servidor cria job, retorna **`202 Accepted`** com:
   - Header `Location: /jobs/{job_id}` apontando pro recurso de polling.
   - Body com `{ job_id, status: "PENDING", created_at, eta_seconds }`.
3. Cliente faz `GET /jobs/{job_id}` periodicamente (com `If-None-Match` se ETag presente).
4. Estados: `PENDING` → `RUNNING` → `SUCCEEDED` | `FAILED` | `CANCELED`.
5. Resposta final inclui `result` ou `error` quando terminado.
6. Opcional: cliente registra **webhook callback** ao criar o job, recebe notificação ao terminar.
7. Opcional: cancelamento via `DELETE /jobs/{job_id}`.

Auditar: rotas como `/process/sync` no Tablix devem ter contraparte async (`/process/async`) pra arquivos grandes que excedem timeout do Fastify (60s default).

## Validação de input e shape

- **Toda entrada externa validada com Zod** antes de tocar lógica de negócio. Sem exceção.
- `request.body as any`, `request.query as any` é finding **CRÍTICO** — bypass do contrato.
- Validar **na borda da API**, não em camadas profundas. Service não revalida o que controller já validou.
- Mensagens de erro de validação devem ser estruturadas, não strings concatenadas. Frontend monta mensagem localizada.
- Schemas reutilizáveis em `src/modules/<modulo>/<modulo>.schema.ts` — não duplicar.

## Estabilidade do response (não vazar internals)

- **Nunca retornar entidade do Prisma direto.** Mapear para DTO no schema de response.
- Campos sensíveis nunca aparecem em response: `password_hash`, `internal_notes`, `oauth_refresh_token`, `webhook_secret`, `stripe_customer_secret`, etc.
- Adicionar campo ao banco **não** adiciona automaticamente ao response. Inclusão é decisão consciente.
- Response schema lista **explicitamente** os campos que saem. Whitelist, não blacklist.
- Campo `null` vs ausente: definir e manter (ver Empty state acima).

## Field-level permissions / conditional fields

Quando alguns campos só aparecem pra certas roles (admin vê `internal_notes`, user normal não):

- **Schema declara explicitamente** quais campos são condicionais e por quê (`@admin-only`, `@owner-only`).
- **Implementação não filtra silenciosamente** — usa DTO mapper que respeita o role.
- **Documentação no Swagger** mostra os campos condicionais com nota explícita (`x-permission: admin`).
- **Cliente que recebe campo dependendo do role** sabe disso pelo contrato, não por experimentação.
- Alternativa: rotas separadas (`/users/:id` vs `/admin/users/:id`) com schemas distintos. Mais explícito, geralmente preferível pra blast radius reduzido.

**Anti-pattern proibido:** rota retorna `User` completo do Prisma e o frontend "esconde" campos no UI. Os campos vazam na response, qualquer um vê no DevTools.

## Headers de contrato

- `Content-Type: application/json; charset=utf-8` — sempre.
- `X-Request-Id` em toda response (gerado se não vier do cliente). Permite correlação com logs.
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` em rotas com rate limit. **`Reset` é Unix timestamp em segundos** (não seconds-remaining, não HTTP date) — padrão Stripe/GitHub, mais fácil de calcular no client.
- `Retry-After` em respostas `429` e `503` — **em segundos** (não HTTP date) pra consistência com `X-RateLimit-Reset`.
- `Cache-Control` explícito em toda resposta — `no-store` por default em rotas autenticadas.
- `Vary: Authorization` em respostas que dependem de auth — evita cache cross-user em CDN.
- `ETag` em recursos editáveis (ver Conditional requests acima).
- CORS: `Access-Control-Allow-Origin` específico, nunca `*` em rota autenticada.

## Auth e rate limit como parte do contrato

Não são "detalhes operacionais" — são contrato:

- **Método de auth declarado** (`Bearer JWT`, `Basic`, `OAuth2 + scope X`). Mudar é breaking change.
- **Scopes/permissions exigidos** declarados por rota no schema (Swagger `security`).
- **Rate limit declarado** — limite numérico documentado por rota e por tier (free/pro). Reduzir é breaking.
- **Headers de rate limit retornados** com nomes estáveis (`X-RateLimit-*`).
- **Janela de rate limit** documentada (por minuto, por hora, por dia).
- **Estratégia de bypass de rate limit** (API key especial, IP whitelist) documentada e auditada.

## Localization

- Mensagens human-readable da API (`message`, `error.message`) podem ser localizadas via header `Accept-Language: pt-BR, en;q=0.5`.
- **`code` do erro nunca é localizado.** É discriminator estável, não texto.
- Default sem header: `pt-BR` no Tablix (mercado primário).
- Fallback: se idioma não suportado, retorna default. Não retorna erro.
- Documentar quais idiomas são suportados — listagem fechada.

## Webhooks outbound (API que ENVIA webhook)

Webhook recebido tem regras em `api-routes.md`. Webhook **enviado** também é contrato com o consumidor:

- **Shape do payload versionado.** Campo `version: "1.0"` no envelope. Mudança breaking → bump de versão.
- **Assinatura HMAC obrigatória** — header `X-Signature` com HMAC-SHA256 do body usando secret compartilhado por consumidor. Padrão Stripe.
- **Header `X-Event-Id`** com ID único pra cada evento — permite idempotência no consumidor.
- **Header `X-Event-Type`** com tipo do evento (`subscription.updated`, `process.completed`).
- **Header `X-Timestamp`** com momento do envio — protege contra replay attack (consumidor rejeita evento > 5min).
- **Retry policy documentada:** quantas tentativas, com qual backoff, até quando desiste. Padrão: exponential 1m → 5m → 30m → 2h → 12h → desiste.
- **Timeout do consumidor declarado:** "esperamos resposta em ≤ 10s, senão retentamos".
- **Status code esperado:** 2xx = sucesso, 4xx = não retentar (erro de cliente), 5xx = retentar.
- **Dashboard de webhooks failing** pra admin do consumidor reagir.
- **Endpoint de teste** (`POST /webhooks/test`) pra cliente validar setup.
- **Disable automático** após N falhas consecutivas + notificação ao admin.

Auditar: se o Tablix vai enviar webhooks (ex: notificar consumidor quando processamento termina), TUDO acima é obrigatório.

## Documentação como contrato

- `/docs` (Swagger UI) é gerado automaticamente do schema Zod via `fastify-type-provider-zod`. Se a documentação está errada, o schema está errado.
- Toda rota nova tem `schema.tags`, `schema.summary`, `schema.description`. Sem isso, a rota fica órfã no Swagger.
- Exemplos de request/response no schema quando o shape não for óbvio.
- Rota interna que não é parte do contrato público: marcar com `schema.hide: true` ou tag dedicada (`internal`).

## OpenAPI components — reusabilidade obrigatória

- Schemas reutilizados (ex: `User`, `Pagination`, `Error`) ficam em `components/schemas` do OpenAPI, **não inline em cada rota**.
- Inline duplicado quebra geração de SDK (cria 30 tipos `User1`, `User2`, ...) e dificulta diff de breaking change em CI.
- Em Fastify + Zod, isso é feito via `$ref` ou registrando schemas globais com `addSchema`.
- Auditar: se o mesmo shape aparece literal em 2+ rotas, é finding **MÉDIO**.

## SDK generation discipline

Se há SDK gerado a partir do OpenAPI (Speakeasy, Stainless, openapi-generator, openapi-typescript):

- **Rename de field é mais doloroso** — quebra typing de todos os clientes em todas as linguagens. Versionar com cuidado extra.
- **`operationId` estável** em cada rota — vira nome de método no SDK. Mudar = breaking de API client.
- **Tags consistentes** — viram namespaces no SDK (`client.users.list()`).
- **Required vs optional rigoroso** — SDK gerado reflete diretamente. Tornar required em response = breaking se cliente esperava optional.
- **`nullable: true` explícito** quando aplicável — SDK gera `T | null`, não `T | undefined`.
- **`discriminator` em unions** pra SDK gerar narrowing correto.

## Gate de breaking change em CI

- Diff de OpenAPI entre PR e `main` deve rodar em CI usando `oasdiff`, `openapi-diff` ou equivalente.
- Breaking change detectado bloqueia merge — só passa com label explícito (`breaking-change-approved`) e justificativa em PR description.
- **Snapshot do OpenAPI commitado no repo** (`docs/openapi.json`), regenerado em build, diff visível em PR como qualquer outro código.
- Sem esse gate, breaking change passa silencioso até consumidor reclamar — finding **ALTO** durante auditoria.

## Contract testing (consumer-driven)

- Quando há consumer interno relevante (frontend mantido pelo mesmo time), considerar **Pact** ou contract testing equivalente.
- Frontend declara expectativa de shape; CI do backend roda os contratos do frontend antes de merge.
- Quebra de contrato é caught em CI, não em runtime no usuário.
- Não é obrigatório desde o início, mas **deve estar planejado** quando o número de consumidores cresce.

## API design review — antes da implementação

Toda rota nova ou mudança não-trivial **deve ter design review antes de qualquer linha de código**:

- **Proposta documentada** em PR de spec (`docs/api/proposals/`) ou no card do Trello: path, método, schema, status codes, semântica de erros, paginação, idempotência, rate limit, auth.
- **Discussão antes de implementar** — pegar bug de design em texto custa minutos; pegar depois de implementado custa retrabalho + possível breaking change pra corrigir.
- **Aprovação registrada** — designer da API, owner do consumidor (frontend), e @reviewer dão OK antes de o card sair pra implementação.
- Pra mudança trivial (adicionar campo opcional, fix de typo no description) o review pode ser implícito no PR. Pra rota nova, é obrigatório.

## Proibições

- **NÃO** mudar response shape de rota existente sem nova versão ou deprecação formal.
- **NÃO** retornar entidade do Prisma direto — sempre DTO mapeado.
- **NÃO** usar `request.body as any` ou `request.query as any` — quebra do contrato.
- **NÃO** declarar schema inline na rota — isolar em `*.schema.ts`.
- **NÃO** misturar `snake_case` e `camelCase` na mesma API. **Padrão do projeto: `camelCase`** em todos os campos JSON (request e response). Consistente com o frontend React e convenção JS/TS.
- **NÃO** expor IDs sequenciais autoincrement.
- **NÃO** retornar timestamp em formato local — sempre ISO 8601 UTC `Z`.
- **NÃO** retornar dinheiro como `number` — sempre string em centavos.
- **NÃO** retornar IDs grandes (snowflake, bigserial) como `number`.
- **NÃO** retornar `null` em listagem vazia — sempre `[]`.
- **NÃO** depender de `message` de erro — só `code` é parte do contrato.
- **NÃO** remover endpoint sem `Sunset` + janela de deprecação.
- **NÃO** mergear PR com breaking change sem label explícito + plano de migração.
- **NÃO** implementar rota nova sem design review prévio.
- **NÃO** filtrar campos por role de forma silenciosa — declarar field-level permissions no schema.
- **NÃO** mudar rate limit pra menor sem versão nova ou aviso prévio.

## Categorias de findings (para o pipeline QA)

Quando o `@reviewer`, `@security` ou `@devops` auditar contrato de API, usar estas categorias no `reproval_reasons`:

- `contract-breaking-change` — mudança breaking sem versionamento
- `contract-shape-leak` — entidade interna vazando em response
- `contract-missing-schema` — rota sem schema completo de request/response
- `contract-naming-inconsistency` — naming convention violada
- `contract-missing-pagination-envelope` — listagem sem envelope padrão
- `contract-missing-idempotency` — mutação arriscada sem suporte a `Idempotency-Key`
- `contract-missing-deprecation-headers` — endpoint marcado deprecated sem `Sunset`/`Deprecation`
- `contract-error-format` — formato de erro divergente do padrão
- `contract-missing-versioning-plan` — breaking change sem plano de versão
- `contract-missing-version-matrix` — múltiplas versões vivas sem matriz de suporte
- `contract-missing-ci-gate` — projeto sem detecção de breaking change em CI
- `contract-numeric-precision` — dinheiro/ID grande como `number` em vez de string
- `contract-missing-etag` — recurso editável sem ETag/If-Match (lost update silencioso)
- `contract-empty-state` — listagem vazia retornando `null` em vez de `[]`
- `contract-missing-discriminator` — polymorphic response sem discriminator estável
- `contract-patch-semantics` — PATCH sem semântica documentada
- `contract-bulk-semantics` — bulk operation sem semântica all-or-nothing vs partial documentada
- `contract-missing-lro-pattern` — operação > 5s segurando conexão HTTP
- `contract-field-level-permission-leak` — campo sensível filtrado no UI mas vazando na response
- `contract-auth-method-change` — mudança de método de auth sem versão
- `contract-rate-limit-undeclared` — rate limit não documentado no contrato
- `contract-webhook-outbound-missing` — webhook enviado sem assinatura/versionamento/retry
- `contract-missing-design-review` — rota nova implementada sem design review prévio
- `contract-sdk-breaking` — mudança que quebra SDK gerado sem versionamento
- `contract-array-encoding-ambiguous` — múltiplos formatos de array em querystring aceitos
