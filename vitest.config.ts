import { defineConfig } from 'vitest/config'

/**
 * Vitest config — escopo e thresholds.
 *
 * **Include de coverage (whitelist explícita):** só módulos com testes
 * maduros entram na medição. Expandir para src/lib/** ou src/modules/** é
 * responsabilidade do Card 3.2 (#31, unit) e 3.3 (#32, integração), após o
 * scaffold de testes do Card #30 estar pronto. Expandir antes quebra o
 * threshold e cria ruído sem ganho.
 *
 * **Threshold 90/85/90/90:** intencional — libs críticas (jwt, health,
 * sanitizer, merger, parser, stripe service, webhook handler) são gate de
 * produção. Qualquer regressão aqui é finding ALTO.
 *
 * **Timeouts:** 30s test / 60s hook — preparados para Testcontainers no
 * Card 3.1b (subida de Postgres efêmero em beforeAll leva ~5-15s).
 * Para unit puros, 30s é folgado de proposito; nunca teste unitário deveria
 * chegar perto disso. Se chegou, é smell (I/O real vazando).
 *
 * @owner: @tester
 */
export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      // Integration tests rodam em config próprio (vitest.integration.config.ts)
      // com globalSetup de Testcontainers. Excluir aqui evita dupla execução.
      'tests/**/*.integration.test.ts',
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/config/plan-limits.ts',
        'src/lib/jwt.ts',
        'src/modules/auth/auth.service.ts',
        'src/middleware/auth.middleware.ts',
        'src/middleware/rate-limit.middleware.ts',
        // Card #219 — cap de concorrência por-rota (backstop de memória do
        // /process/sync). Gate de produção: sem ele, burst de uploads → OOM kill.
        // 100% unit (counter+WeakSet são puros); o wiring preHandler/onResponse
        // é provado por fastify.inject no mesmo arquivo de teste.
        'src/middleware/concurrency-limit.middleware.ts',
        'src/errors/app-error.ts',
        'src/http/controllers/billing.controller.ts',
        'src/http/controllers/webhook.controller.ts',
        'src/modules/billing/stripe.service.ts',
        'src/modules/billing/webhook.handler.ts',
        // Card #189 — orquestrador idempotente RECEIVED → PROCESSED
        'src/modules/billing/webhook-idempotency.ts',
        'src/lib/spreadsheet/sanitizer.ts',
        'src/lib/spreadsheet/merger.ts',
        'src/lib/spreadsheet/parser.ts',
        'src/modules/process/process.service.ts',
        // Card 2.3 — health check modules (libs críticas, sujeitas ao threshold)
        'src/lib/health/check-db.ts',
        'src/lib/health/check-redis.ts',
        'src/lib/health/orchestrator.ts',
        'src/http/routes/health.routes.ts',
        // Card 3.2 (#31) — libs puras de src/lib/ incluídas na whitelist
        // quando têm testes unitários maduros (≥90% target).
        'src/lib/token-generator.ts',
        'src/lib/trust-proxy.ts',
        'src/lib/email.ts',
        'src/lib/logger.ts',
        'src/lib/parse-selected-columns.ts',
        'src/lib/security/webhook-circuit-breaker.ts',
        'src/lib/audit/audit.service.ts',
        // Card #147 (5.2c) F3 — cron handler com testes unit 90%+
        'src/jobs/quota-alert.job.ts',
        'src/lib/sleep.ts',
        // Card 6.4 — núcleo do worker async + parse isolado em thread.
        // process-worker.ts: handler `processJob` coberto por unit (stmts/lines
        // ~98%); o factory `createProcessWorker` é só fronteira BullMQ, exercido
        // por integração (não instrumentável aqui). parse-in-thread.ts: runInThread/
        // parseInWorkerThread/timeout/rebuildError cobertos; o ramo prod `.js`
        // (resolveParseWorkerFile/WORKER_EXEC_ARGV) é inalcançável em runtime .ts.
        // Esses 5 pontos não-unitáveis baixam o `functions` LOCAL destes 2 files
        // (~66%/~81%), mas o gate é GLOBAL (90/85/90/90) e o pool absorve: com
        // estes incluídos o agregado fica em ~96% funcs / ~96% lines. Por isso NÃO
        // é preciso istanbul-ignore no código de produção nem override per-file.
        // NÃO se inclui parse-worker.thread.ts (roda em worker_thread, fora do
        // instrumentador).
        'src/lib/queue/process-worker.ts',
        'src/lib/spreadsheet/parse-in-thread.ts',
        // Card 6.5 — controller do polling do LRO (read path). 100% cobertura
        // unit (stmts/branch/funcs/lines); o ownership real é provado no
        // process-status.integration.test.ts contra Postgres. Gate de produção
        // do endpoint que o front consome em loop.
        'src/http/controllers/process-status.controller.ts',
        // Card 6.3 — controller do POST /process/async (write path, cria Job +
        // enfileira). Fecha o débito de gate apontado pelo @tester do 6.5: o
        // read path (6.5) estava gateado mas o write path (mais crítico) não.
        'src/http/controllers/process-async.controller.ts',
        // Card 6.6 — controller do GET /process/download (entrega única). Claim
        // atômico downloaded_at + remove output pós-entrega. 100% cobertura unit
        // (stmts/branch/funcs/lines); a invariante de entrega única real (claim
        // sob race + ownership) é provada no process-download.integration.test.ts
        // contra Postgres. Fecha o fluxo LRO (status 6.5 → download 6.6).
        'src/http/controllers/process-download.controller.ts',
        // Card 6.7 (+ #197) — crons de cleanup async. sweepOrphanJobs (#197 +
        // 6.7b) + purgeAsyncJobStorage (6.7a). Lógica de transição de status +
        // refund + purga idempotente coberta por unit (mocks de prisma/queue/
        // storage); a anti-race real (sweeper×worker) é provada no integration
        // contra Postgres. Gate de quota (vaza receita) + LGPD (resíduo de PII).
        'src/jobs/async-cleanup.job.ts',
      ],
      exclude: [
        // Entrypoints — testados via smoke/integration, não unitários
        'src/server.ts',
        'src/instrument.ts',
        'src/app.ts',
        // Config validada no boot real, não unitário (Zod + superRefine)
        'src/config/env.ts',
        // Schemas Zod — não têm lógica a cobrir além dos próprios types
        '**/*.schema.ts',
        // Types puros (interfaces/declarações)
        '**/types.ts',
        '**/*.d.ts',
        // Barrel files
        '**/index.ts',
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
