# Plano — Fase 6: espinha do processamento assíncrono (6.2→6.6)

**Data:** 2026-06-21 · **Autor:** @planner v2.1 · **Tamanho:** G (5 cards M + 1 spike; 9-16 dias úteis)

## Demanda
Caminho async (LRO) pra payloads grandes que estouram o requestTimeout do Fastify: upload → persiste inputs no Supabase Storage → cria Job → enfileira BullMQ → 202+jobId. Worker em processo separado consome, reusa `lib/spreadsheet`, sobe output, atualiza Job. Front faz polling em /status e baixa em /download (entrega única). Sync (`/process/sync`) permanece intacto.

## Decisões (recomendações do @planner)
- **D-1 (CENTRAL — Redis TCP):** **Upstash DB DEDICADO (TCP, `noeviction`)** só pra BullMQ, separado do rate-limit. Razão: BullMQ exige `noeviction`; rate-limit quer TTL/cache (políticas incompatíveis no mesmo DB) + budget de comandos compartilhado pode derrubar o rate-limit que protege billing/auth. ioredis com `maxRetriesPerRequest:null`. **Validar via SPIKE S-1.** (Alternativas: reusar TCP do Upstash atual = $0 mas tecnicamente errado; Redis self-hosted Fly = over-engineering pré-go-live.)
- **D-2 (worker):** processo SEPARADO (`src/worker.ts`, Fly process group) — isola memória/crash (OOM do parse não derruba auth/billing). + worker_thread interno (6.10) pro XLSX.
- **D-3 (quota):** reservar atômica no ENQUEUE (6.3, reusa `validateAndIncrementUsage`), NÃO no worker — senão bypass de quota por mass-enqueue.
- **D-4 (download):** stream via backend (não signed-URL redirect) — habilita audit + entrega única (claim atômico).
- **D-5 (jobId storage-safe):** `Job.id` é UUID com hífen; `JOB_ID_REGEX` rejeita hífen → derivar `storageKey = uuid.replaceAll('-','')` via helper único.

## Ambiguidades pendentes (decisão do dono)
- **A-LIMITS:** cap do async — elevar bytes/arquivo até 30MB mantendo limites de LINHA (recomendado, anti-DoS real é linha) vs manter 2MB/arquivo só pelo total.
- **A-QUOTA:** reservar no enqueue (recomendado) — fecha bypass.
- **A-REFUND:** Job FAILED NÃO devolve unificação (recomendado, consistente com sync).

## Blockers concretos achados no código
- **G-1:** `src/lib/storage/key-builder.ts:46` `JOB_ID_REGEX=/^[a-z0-9]{7,64}$/` rejeita UUID → D-5.
- **G-2:** `StorageAdapter` (`storage/types.ts`) NÃO tem método de download — worker (6.4) e download (6.6) precisam. Adicionar no 6.2.
- **G-3:** path `{userId}/{date}/{jobId}.{ext}` = 1 objeto por job; um job tem N inputs → colidem. Variante de path por-input.
- **G-4:** multipart global 2MB na registração (app.ts) → override por-request (R-7).
- **G-5:** dois `PRO_LIMITS` (config/plan-limits SSOT + lib/spreadsheet alias) — async usa o SSOT.

## SPIKE S-1 (bloqueia 6.2)
Validar BullMQ sobre Upstash TCP: ioredis conecta no `rediss://`? blocking commands OK? medir comandos consumidos (1h idle + 10 jobs) vs teto free tier? `noeviction` setável? cabe 2º DB? **Output: fecha D-1 + go/no-go infra.** Timebox 4h.

## Fases (INVEST)
- **6.2** Setup BullMQ + Redis TCP: deps bullmq+ioredis, `config/redis-tcp.ts`, adapter.download (G-2), key-builder multi-input + jobId-safe (G-1/G-3/D-5), Queue + smoke.
- **6.3** POST /process/async: migration expand Job (downloadedAt/outputSize/inputsPurgedAt/expiresAt/bullJobId + idx), schemas Zod, async.service (persist inputs + create Job + quota atômica + enqueue), controller+rota+rate limit+global cap+multipart override. Flag `ASYNC_PROCESSING_ENABLED`.
- **6.4** Worker (ALTO+SEGURANÇA): process-job.service (download→parse/merge→upload→update, inputs deletados em finally), worker entrypoint + graceful shutdown + Sentry/pino + concurrency=1 + timeout + backoff, isolamento parse (6.10).
- **6.5** GET /status/:jobId: ownership `WHERE id AND userId` (404 não-dono), DTO, no-cache.
- **6.6** GET /download/:jobId: claim atômico `UPDATE downloaded_at WHERE ... IS NULL RETURNING` (entrega única, R-5), stream + audit + delete, 410 na 2ª.

## Riscos H
- **R-1 OOM worker** (Fly 256MB + payload 30MB): sequencial + concurrency=1 + cap + máquina maior.
- **R-2 conexões Postgres** (2º pool + pooler limit=5): worker pool pequeno (connection_limit=2).
- **R-3 denial-of-wallet budget Upstash**: Redis dedicado (D-1) isola + alerta.
- **R-4 IDOR status/download**: ownership por JWT + 404 + testes.
- **R-5 race entrega única**: claim atômico.
- **R-6 Storage lixão órfão**: 6.7 cron (ELEVADO a pré-requisito de go-live) + delete em finally + expiresAt.

## Sequência
S-1 → 6.2 → 6.3 → 6.4 → (6.5 ‖ 6.6). Checkpoints: pós-S-1 (D-1 + ambiguidades), pós-6.3 (congelar contrato LRO pro front 6.8), pós-6.4 (deploy D-2 → Fase 7).

## Cross-fase
- Fase 7: fly.toml process group worker + provisioning Redis + secrets. Deploy do worker depende disso (dev/staging não).
- 6.7 cron cleanup: pré-requisito de go-live (R-6).
- 6.8 front: depende do contrato LRO congelado pós-6.3 (board do front).
- 6.10 worker-thread XLSX: hardening do 6.4, antes do go-live (WV-2026-003).

## Rollout
Flag `ASYNC_PROCESSING_ENABLED` (default off) → dark launch → staging → canary PRO → 100%. Sync intacto toda a janela. Kill: flag off.

Relacionado: [[project-hosting-fly-free]], cards Trello 6.2-6.6.
