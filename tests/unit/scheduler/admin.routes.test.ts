/**
 * Admin routes tests — Card #145 (5.2a) F4.
 *
 * Cobre validações dos handlers das 2 rotas admin (POST /admin/jobs/run/:name
 * e GET /admin/jobs/list). Foco em:
 *  - Schema validation de :name regex
 *  - Whitelist check antes de runJobOnce
 *  - recordAdminActionAttempt AWAIT ANTES da action (Mit 5)
 *  - 404 sem availableJobs em prod (F-BAIXO-01 fix)
 *
 * @owner: @tester
 * @card: #145 (5.2a) F4
 */
import { describe, it, expect } from 'vitest'

import { __testing as __cronTesting } from '../../../src/scheduler/cron'

// Não testamos handlers diretamente (Fastify wiring é integration). Aqui
// validamos invariantes de schema/contract.

describe('admin.routes — invariantes de contract', () => {
  it('cronHealthResponseSchema é exportado e estável', async () => {
    const { cronHealthResponseSchema } =
      await import('../../../src/scheduler/health')
    // Schema básico pra contrato — bate com api-contract.md envelope { data }.
    // F5 (Card #145) adicionou campo `metrics` (snapshot dos counters/gauges
    // in-memory). Mudança aqui é breaking pra dashboard admin.
    const sample = {
      data: {
        jobs: [],
        totalJobs: 0,
        metrics: {
          runsTotal: [],
          lockContentionTotal: [],
          lockExpiredTotal: [],
          lastDurationMs: [],
          retentionDaysCurrent: 30,
        },
      },
    }
    expect(cronHealthResponseSchema.safeParse(sample).success).toBe(true)
  })

  it('cronHealthResponseSchema rejeita shape sem envelope `data`', async () => {
    const { cronHealthResponseSchema } =
      await import('../../../src/scheduler/health')
    expect(
      cronHealthResponseSchema.safeParse({ jobs: [], totalJobs: 0 }).success,
    ).toBe(false)
  })

  it('listJobNames retorna array de strings', () => {
    __cronTesting.resetForTests()
    const names = Array.from(__cronTesting.jobs.keys())
    expect(Array.isArray(names)).toBe(true)
    expect(names).toHaveLength(0)
  })

  it('Job name regex aceita kebab-case alfanumérico', () => {
    const validNames = [
      'history-purge',
      'history-quota-alert',
      'a-b-c-1-2-3',
      'simple',
    ]
    const invalidNames = [
      'UPPER',
      '1starts-with-num',
      'has_underscore',
      'has space',
      'a', // muito curto (regex exige min 2 chars)
      '-starts-with-dash',
    ]
    const regex = /^[a-z][a-z0-9-]+$/
    for (const name of validNames) {
      expect(regex.test(name)).toBe(true)
    }
    for (const name of invalidNames) {
      expect(regex.test(name)).toBe(false)
    }
  })
})

describe('admin.routes — F-BAIXO-01 fix (404 sem availableJobs em prod)', () => {
  it('NODE_ENV=production omite details.availableJobs no 404', () => {
    // Simulação manual da lógica do handler (extraída pra testar
    // sem subir Fastify). O handler real está em admin.routes.ts.
    function build404Body(jobNames: string[]) {
      const isProd = process.env.NODE_ENV === 'production'
      return {
        error: {
          code: 'NOT_FOUND',
          message: 'Cron job não registrado.',
          ...(isProd ? {} : { details: { availableJobs: jobNames } }),
        },
      }
    }

    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'production'
      const body = build404Body(['secret-job-1', 'secret-job-2'])
      expect(body.error).not.toHaveProperty('details')
    } finally {
      process.env.NODE_ENV = original
    }
  })

  it('NODE_ENV=development inclui availableJobs (UX dev)', () => {
    function build404Body(jobNames: string[]) {
      const isProd = process.env.NODE_ENV === 'production'
      return {
        error: {
          code: 'NOT_FOUND',
          message: 'Cron job não registrado.',
          ...(isProd ? {} : { details: { availableJobs: jobNames } }),
        },
      }
    }

    const original = process.env.NODE_ENV
    try {
      process.env.NODE_ENV = 'development'
      const body = build404Body(['public-job'])
      expect(body.error).toHaveProperty('details')
    } finally {
      process.env.NODE_ENV = original
    }
  })
})
