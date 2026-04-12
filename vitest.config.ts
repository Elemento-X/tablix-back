import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
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
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
