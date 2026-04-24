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
        'src/errors/app-error.ts',
        'src/http/controllers/billing.controller.ts',
        'src/http/controllers/webhook.controller.ts',
        'src/modules/billing/stripe.service.ts',
        'src/modules/billing/webhook.handler.ts',
        'src/lib/spreadsheet/sanitizer.ts',
        'src/lib/spreadsheet/merger.ts',
        'src/lib/spreadsheet/parser.ts',
        'src/modules/process/process.service.ts',
        // Card 2.3 — health check modules (libs críticas, sujeitas ao threshold)
        'src/lib/health/check-db.ts',
        'src/lib/health/check-redis.ts',
        'src/lib/health/orchestrator.ts',
        'src/http/routes/health.routes.ts',
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
