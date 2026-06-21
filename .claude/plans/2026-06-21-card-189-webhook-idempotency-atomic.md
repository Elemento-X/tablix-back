# Plano — Card #189: Fix idempotência atômica do webhook Stripe

**Data:** 2026-06-21 · **Autor:** @planner v2.1 · **Tipo:** fix CRÍTICO + refactor estrutural · **Tamanho:** G (450-650 LoC, 2-4 dias, planejar 2 ciclos de pipeline)

## Bug
`webhook.controller.ts` registra `event.id` em `stripe_events` (autocommit) ANTES do handler. Falha transitória → row gravada → retry do Stripe bate P2002 → `duplicate` sem reprocessar → cliente paga e nunca recebe token. Empírico: 7 stripe_events / 0 tokens no smoke 6.1.

## Decisões (resolvidas)
- **D-1 — threadar `tx` nos handlers (Opção ii).** Assinatura aditiva `(obj, tx): Promise<WebhookSideEffects>`. Razão: `connection_limit=5` + pgbouncer transaction mode tornam a alternativa "handlers inalterados" frágil (pool exhaustion + tx ociosa babá de lock). É o Idempotent Consumer canônico: writes + flip PROCESSED atômicos numa unidade de trabalho; I/O externo (email/audit) pós-commit.
- **D-2 — advisory try-lock em AMBOS os caminhos.** INSERT serializa o *dedup* (status); `pg_try_advisory_xact_lock(hashtext('stripe_event:'||id))` serializa o *processamento*. Elimina janela de dupla execução. Custo nulo.
- **D-3 — side-effects pós-commit.** Handlers retornam `{ emails: closures, audits: [] }`. Orquestrador executa após COMMIT. Nada de I/O na tx. Lock não-adquirido e não-PROCESSED → throw 500 (Stripe redelivera). NUNCA 200 sem PROCESSED confirmado.
- **received_at:** nullable na EXPAND (decisão @dba, gate de schema). Código passa `receivedAt` explícito no insert. NOT NULL+default fica pro CONTRACT.

## Arquivos
**Criar:** `src/modules/billing/webhook-idempotency.ts` (orquestrador `processStripeEvent`), `src/modules/billing/webhook.types.ts`, `tests/unit/webhook-idempotency.test.ts`, migration (✅ feita).
**Alterar:** `webhook.controller.ts` (emagrece), `webhook.handler.ts` (4 handlers: tx + side-effects, sem email/audit/$transaction interno), `prisma/schema.prisma` (✅ feito), `tests/unit/webhook.test.ts`, `tests/integration/webhook.integration.test.ts`.
**Precedente advisory lock:** `src/modules/history/history.service.ts` (softDeleteAll).

## Fases (INVEST)
1. **Migration expand** — ✅ APLICADA (status/received_at/processed_at-nullable + CHECK + idx parcial).
2. **Tipos + orquestrador** — `webhook.types.ts` (WebhookSideEffects/WebhookOutcome) + `webhook-idempotency.ts` (processStripeEvent + runHandler + advisory lock).
3. **Refactor 4 handlers** — aceitam tx, escrevem via tx, retornam side-effects; removem email/audit inline + `$transaction` interno do `handleSubscriptionUpdated`.
4. **Costura no controller** — stripeWebhook fino: signature/circuit-breaker + delega ao processStripeEvent.
5. **Testes (unit + integração Docker) + pipeline** — pre-merge gate Docker OBRIGATÓRIO (mock não exercita lock/tx). Cenários: novo, duplicata-PROCESSED, reprocesso-RECEIVED órfão (prova do fix), atomicidade (falha → zero efeito parcial), concorrência (Promise.all → 1 token).

## Riscos-chave
- R-1 ordem de deploy: migration ANTES do código (✅ migration já aplicada).
- R-2 I/O na tx → pool exhaustion: regra dura, email/audit sempre fora da tx.
- R-4 lock não-adquirido: throw 500, nunca 200 sem PROCESSED.
- R-6 mock não exercita lock: pre-merge Docker obrigatório.

## Pseudo-código do fluxo (processStripeEvent)
1. INSERT RECEIVED (catch P2002 → isNew=false).
2. Se !isNew: SELECT status. PROCESSED → audit DUPLICATE + return 'duplicate'. RECEIVED → log reprocesso, segue.
3. `$transaction(tx)`: `SET LOCAL lock_timeout='3s'` → `pg_try_advisory_xact_lock` → se !locked return null → double-check status PROCESSED → `runHandler(event, tx)` → `update status PROCESSED, processedAt` → return side-effects.
4. Se null: re-SELECT status. PROCESSED → duplicate. Senão → throw 500.
5. Pós-commit: audits + emails (fire-and-forget) + WEBHOOK_PROCESSED.

## Oportunidades (cards separados — ✅ criados)
- #190 reconciliação one-time · #191 replay tolerance (O-1) · #192 observabilidade RECEIVED preso (O-2). O-3 outbox real de emails → Backlog baixa prioridade.

Relacionado: card #189 (5rGmrHVZ), [[project-card189-webhook-idempotency]].
