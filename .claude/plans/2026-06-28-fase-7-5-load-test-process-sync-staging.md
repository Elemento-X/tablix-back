# Plano — Fase 7.5: Load test NÃO-DESTRUTIVO de /process/sync (staging)

**Data:** 2026-06-28 · **Autor:** @planner + operador · **Tipo:** infra/calibração · **Tamanho:** M (janela 2–4 dias; execução ativa ~4–8h)

## Objetivo
Submeter `POST /process/sync` (PRO-only, multipart + parse SÍNCRONO no event loop do web) a carga controlada em staging pra **calibrar por evidência** (não por estimativa de 80B/célula):
1. Valor final de `PROCESS_SYNC_MAX_CONCURRENCY` (#219, default 3) ↔ `maxInputCells` (#225, 1.5M) por **RSS p95 real**.
2. Pico do `XLSX.read` na fixture adversarial largo-e-curto (F2/#225, sob WV-2026-009).
3. Event-loop lag (parse síncrono serializa).
4. Taxa de 503 (#219) + Retry-After jitter; taxa de cap-hit do maxInputCells (→ prioriza #227).
5. **Zero OOM** no pior caso legítimo.

## Constraint CRÍTICO (#218 / WV-2026-010)
Store dev/test COMPARTILHADO → load test **NÃO-DESTRUTIVO**: volume capado, dados env-tagged (`audit_log.metadata.env='staging'`, #223) e PURGÁVEIS. Janela coordenada obrigatória.

## 3 achados de código que reformulam o teste
1. **Guard per-user=2** (`process.controller.ts`, Redis INCR) < cap per-processo=3 → 1 usuário NUNCA satura o cap #219. **Precisa de pool de ~8 usuários PRO.**
2. **Quota 30/mês atômica roda ANTES do parse** (`validateAndIncrementUsage`) → após 30 syncs/user a request morre na quota, nunca toca memória. **Precisa reset de quota entre ondas + pool (8×30 headroom).**
3. **Rate-limit per-IP camada 1** (`rateLimitMiddleware.process`) roda antes do cap → carga de 1 IP toma 429 antes do #219 (R-8). **Verificar na Fase 2; multi-IP OU afrouxar limiter só em staging na janela.**
4. Round-robin 2 web machines mascara o cap + mistura RSS → **scale web a 1** nas ondas de calibração.
5. RSS por-request (pós-parse) ≠ pico simultâneo dos 3 em voo → **triangular** logs + `fly machine status` + OOM-watch.

## Decisões cravadas
- **D-1 Auth → Opção A:** pool de ~8 usuários PRO seedados via `token-generator` (entropia real, env-tagged, purgável); JWT pelo `/auth/validate-token` real. Único que viabiliza saturar o cap (guard per-user=2) + headroom de quota.
- **D-2 Ferramenta → k6:** multipart nativo, executores de concorrência, percentis + thresholds go/no-go.
- **D-3 Event-loop → canary-ping não-invasivo** (GET barato /health/live a cada ~500ms em paralelo; latência inflada = saturação do loop; ZERO código). Instrumentar `monitorEventLoopDelay` atrás de flag = follow-up opcional (precisa do dono).
- **D-4 Topologia → `fly scale count 1` (web)** nas ondas de calibração; restaurar a 2 no teardown.
- **D-5 Lever se RSS estourar:** concorrência 3→2 PRIMEIRO (preserva caps de input pro cliente legítimo); só mexer em maxInputCells se 2 ainda estourar.

## Fixtures (Fase 1)
- **FIX-TYPICAL** — médio realista (3 arq × 5k × 8 col).
- **FIX-LEGIT-MAX** — pior caso LEGÍTIMO de retenção ≈ maxInputCells (100 col × 5k × 3 arq = 1.5M, PASSA).
- **FIX-ADVERSARIAL-WIDE** — xlsx poucas linhas × milhares de colunas ≤2MB (rejeitado em maxInputColumns; mede pico do XLSX.read/decompressão).
- **FIX-CAP-HIT** — logo ACIMA de maxInputCells (100×5k×4 = 2M, rejeitado no loop incremental).

## Fases
- **0. Setup & safety rails:** aprovações do dono; seed do pool (revisado @security+@dba); baseline de counts (Task 0.3); instalar k6.
- **1. Fixtures** (paralelo).
- **2. Baseline 1-req + S-1 GATE:** provar que a carga CHEGA no parse (rejeitos = `concurrency.rejected`, não `rateLimited`/`limitExceeded`) + verificar R-8 (per-IP). **Bloqueia 3–5.**
- **3. Ramp + sustained (1 web):** RSS p95 triangulado + canary-ping; repetir com cap=2 se RSS≥410MB.
- **4. Burst/overload:** forçar 503, validar Retry-After ∈[2,5]s + release de slot + recuperação + zero OOM.
- **5. Adversarial + cap-hit:** pico XLSX.read; taxa de cap-hit (→ #227); onda de sanidade com 2 web.
- **6. Análise + teardown:** cravar valor (lever D-5) → `fly secrets set`; restaurar scale 2; **cleanup escopado** (dry-run @dba).

## Critérios de sucesso (go/no-go 7.6)
- RSS p95 sob FIX-LEGIT-MAX < ~410MB (80% de 512MB), triangulado, margem de GC.
- Zero OOM kill / restart não-provocado.
- Valor final de PROCESS_SYNC_MAX_CONCURRENCY por evidência, aplicado via secret, replicável no 7.6.
- 503 só sob burst (não carga legítima), Retry-After ∈[2,5]s, recuperação limpa.
- Cleanup verificado (counts == baseline); staging restaurado (2 web + secrets corretos).

## Cleanup não-destrutivo (Task 6.4)
1. Dry-run `SELECT COUNT` (revisado @dba) ANTES de qualquer DELETE.
2. `usage`: só `user_id IN (<pool>)`.
3. `audit_log`: só `metadata->>'env'='staging'` da janela. **NUNCA tocar `audit_log_legal`** (5 anos, #150).
4. Storage (defensivo): /sync não persiste; remover só env-tagged se houver.
5. Redis: `tablix:concurrency:<pool>` (TTL 120s auto-expira).
6. Pool: remover os 8 usuários+tokens sintéticos.
7. Verificar counts == baseline (Task 0.3).

## Riscos-chave
R-1 RSS por-req ≠ pico (triangular) · R-2 denial-of-store (janela+budget) · R-3 guard/quota estrangula (pool+reset+S-1) · R-4 round-robin mascara (scale 1) · R-5 k6/banda gargalo (medir http_req_sending) · R-6 cleanup apaga legítimo (escopo+dry-run) · R-7 esquecer teardown (checklist) · R-8 rate-limit per-IP (multi-IP/afrouxar).

## PRECISA DO DONO (gate de execução)
1. Aprovar **janela coordenada** de carga no store dev/test compartilhado + avisar consumidores.
2. Aprovar **`fly scale count 1` (web)** nas ondas de calibração (redundância reduzida na janela).
3. Autorizar **seed de ~8 usuários PRO sintéticos** no DB dev/test.
4. Decidir **D-3**: canary-ping só (zero código) OU também instrumentar monitorEventLoopDelay (1 deploy).

## Descobertas (cards)
- Doc /sync "40 unificações/mês" vs código 30 → BAIXO `from-plan`.
- D-3-B instrumentação event-loop → Decisões Pendentes (depende do dono).
