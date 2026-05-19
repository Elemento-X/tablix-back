/**
 * Unit tests for scheduler metrics (Card #145 5.2a F5 — T5.1).
 *
 * Cobre os counters/gauges in-memory de `src/scheduler/metrics.ts`:
 *   - incRunsTotal: por (jobName, status), idempotente, cria entry.
 *   - incLockContention / incLockExpired: por jobName, monotônico.
 *   - setLastDurationMs: gauge, rejeita NaN/negativo.
 *   - getSchedulerMetrics: snapshot estável, shape espelha schema Zod
 *     de scheduler/health.ts.
 *   - retentionDaysCurrent: lê env.PRO_RETENTION_DAYS (mocked).
 *
 * @owner: @tester
 * @card: #145 (5.2a) F5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock env ANTES do import — metrics.ts lê env.PRO_RETENTION_DAYS no
// snapshot. Pinning aqui evita dependência de .env real do CI. vi.mock
// é hoisted automaticamente pelo Vitest (independente da posição); o
// eslint não infere isso, daí o disable abaixo.
vi.mock('../../src/config/env', () => ({
  env: {
    PRO_RETENTION_DAYS: 30,
  },
}))

/* eslint-disable import/first */
import {
  __testing,
  getSchedulerMetrics,
  incLockContention,
  incLockExpired,
  incRunsTotal,
  setLastDurationMs,
  setPurgePendingCount,
} from '../../src/scheduler/metrics'
/* eslint-enable import/first */

describe('scheduler/metrics', () => {
  beforeEach(() => {
    __testing.resetForTests()
  })

  describe('incRunsTotal', () => {
    it('incrementa counter por (jobName, status)', () => {
      incRunsTotal('history-purge', 'success')
      incRunsTotal('history-purge', 'success')
      incRunsTotal('history-purge', 'failure')

      const snapshot = getSchedulerMetrics()
      const successEntry = snapshot.runsTotal.find(
        (r) => r.jobName === 'history-purge' && r.status === 'success',
      )
      const failureEntry = snapshot.runsTotal.find(
        (r) => r.jobName === 'history-purge' && r.status === 'failure',
      )

      expect(successEntry?.count).toBe(2)
      expect(failureEntry?.count).toBe(1)
    })

    it('isola counters por jobName diferente', () => {
      incRunsTotal('history-purge', 'success')
      incRunsTotal('quota-alert', 'success')

      const snapshot = getSchedulerMetrics()
      const purge = snapshot.runsTotal.find(
        (r) => r.jobName === 'history-purge',
      )
      const alert = snapshot.runsTotal.find((r) => r.jobName === 'quota-alert')

      expect(purge?.count).toBe(1)
      expect(alert?.count).toBe(1)
    })

    it('aceita todos os 4 status terminais', () => {
      incRunsTotal('j', 'success')
      incRunsTotal('j', 'failure')
      incRunsTotal('j', 'skipped')
      incRunsTotal('j', 'expired')

      const snapshot = getSchedulerMetrics()
      const entries = snapshot.runsTotal.filter((r) => r.jobName === 'j')
      expect(entries).toHaveLength(4)
      const statuses = new Set(entries.map((e) => e.status))
      expect(statuses).toEqual(
        new Set(['success', 'failure', 'skipped', 'expired']),
      )
    })
  })

  describe('incLockContention', () => {
    it('incrementa counter por jobName monotônico', () => {
      incLockContention('history-purge')
      incLockContention('history-purge')
      incLockContention('history-purge')

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lockContentionTotal.find(
        (e) => e.jobName === 'history-purge',
      )
      expect(entry?.count).toBe(3)
    })

    it('mantém entradas separadas por job', () => {
      incLockContention('a')
      incLockContention('b')
      incLockContention('a')

      const snapshot = getSchedulerMetrics()
      expect(snapshot.lockContentionTotal).toHaveLength(2)
    })
  })

  describe('incLockExpired', () => {
    it('incrementa counter de releases pós-TTL', () => {
      incLockExpired('history-purge')
      incLockExpired('history-purge')

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lockExpiredTotal.find(
        (e) => e.jobName === 'history-purge',
      )
      expect(entry?.count).toBe(2)
    })

    it('é independente de lockContention', () => {
      incLockExpired('j')
      incLockContention('j')

      const snapshot = getSchedulerMetrics()
      const expired = snapshot.lockExpiredTotal.find((e) => e.jobName === 'j')
      const contention = snapshot.lockContentionTotal.find(
        (e) => e.jobName === 'j',
      )

      expect(expired?.count).toBe(1)
      expect(contention?.count).toBe(1)
    })
  })

  describe('setLastDurationMs', () => {
    it('seta gauge da última duração com sucesso', () => {
      setLastDurationMs('history-purge', 1234)
      setLastDurationMs('history-purge', 5678)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lastDurationMs.find(
        (e) => e.jobName === 'history-purge',
      )
      // Gauge = sobrescreve (last value), não acumula.
      expect(entry?.durationMs).toBe(5678)
    })

    it('rejeita NaN sem atualizar gauge', () => {
      setLastDurationMs('j', 1000)
      setLastDurationMs('j', Number.NaN)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lastDurationMs.find((e) => e.jobName === 'j')
      expect(entry?.durationMs).toBe(1000)
    })

    it('rejeita valor negativo sem atualizar gauge', () => {
      setLastDurationMs('j', 500)
      setLastDurationMs('j', -100)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lastDurationMs.find((e) => e.jobName === 'j')
      expect(entry?.durationMs).toBe(500)
    })

    it('rejeita Infinity sem atualizar gauge', () => {
      setLastDurationMs('j', 500)
      setLastDurationMs('j', Number.POSITIVE_INFINITY)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lastDurationMs.find((e) => e.jobName === 'j')
      expect(entry?.durationMs).toBe(500)
    })

    it('trunca duração fracionária para inteiro (Prometheus convention)', () => {
      setLastDurationMs('j', 1234.567)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.lastDurationMs.find((e) => e.jobName === 'j')
      expect(entry?.durationMs).toBe(1234)
    })
  })

  describe('setPurgePendingCount — Card #146 F2 T-2.2', () => {
    it('seta gauge + lastUpdatedAt em ISO 8601', () => {
      setPurgePendingCount('history-purge', 42)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.purgePendingCount.find(
        (e) => e.jobName === 'history-purge',
      )
      expect(entry?.count).toBe(42)
      expect(entry?.lastUpdatedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      )
    })

    it('sobrescreve gauge em chamadas sucessivas (last value)', () => {
      setPurgePendingCount('history-purge', 10)
      setPurgePendingCount('history-purge', 5)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.purgePendingCount.find(
        (e) => e.jobName === 'history-purge',
      )
      expect(entry?.count).toBe(5)
    })

    it('rejeita NaN sem atualizar gauge', () => {
      setPurgePendingCount('j', 100)
      setPurgePendingCount('j', Number.NaN)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.purgePendingCount.find((e) => e.jobName === 'j')
      expect(entry?.count).toBe(100)
    })

    it('rejeita valor negativo sem atualizar gauge', () => {
      setPurgePendingCount('j', 50)
      setPurgePendingCount('j', -1)

      const snapshot = getSchedulerMetrics()
      const entry = snapshot.purgePendingCount.find((e) => e.jobName === 'j')
      expect(entry?.count).toBe(50)
    })

    it('isolamento entre jobs', () => {
      setPurgePendingCount('history-purge', 10)
      setPurgePendingCount('dead-letter-reprocess', 3)

      const snapshot = getSchedulerMetrics()
      expect(snapshot.purgePendingCount).toHaveLength(2)
      const hp = snapshot.purgePendingCount.find(
        (e) => e.jobName === 'history-purge',
      )
      const dl = snapshot.purgePendingCount.find(
        (e) => e.jobName === 'dead-letter-reprocess',
      )
      expect(hp?.count).toBe(10)
      expect(dl?.count).toBe(3)
    })
  })

  describe('getSchedulerMetrics', () => {
    it('retorna snapshot vazio quando reset', () => {
      const snapshot = getSchedulerMetrics()
      expect(snapshot.runsTotal).toEqual([])
      expect(snapshot.lockContentionTotal).toEqual([])
      expect(snapshot.lockExpiredTotal).toEqual([])
      expect(snapshot.lastDurationMs).toEqual([])
      expect(snapshot.purgePendingCount).toEqual([])
      expect(snapshot.retentionDaysCurrent).toBe(30)
    })

    it('retornaretentionDaysCurrent do env (gauge fixo)', () => {
      const snapshot = getSchedulerMetrics()
      expect(snapshot.retentionDaysCurrent).toBe(30)
    })

    it('não muta estado interno', () => {
      incRunsTotal('j', 'success')
      const snap1 = getSchedulerMetrics()
      const snap2 = getSchedulerMetrics()

      expect(snap1).toEqual(snap2)
    })
  })
})
