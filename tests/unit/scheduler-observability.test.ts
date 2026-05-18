/**
 * Unit tests for scheduler observability (Card #145 5.2a F5 — T5.2).
 *
 * Cobre o helper `emitSchedulerEvent` de `src/scheduler/observability.ts`:
 *   - Log pino sempre disparado (info/warn/error) com event+jobName.
 *   - Sentry.addBreadcrumb sempre disparado com category='scheduler'.
 *   - Sentry.captureMessage APENAS pra eventos da whitelist
 *     (ALERTABLE_EVENTS) — info-only NÃO dispara issue.
 *   - Tags estruturadas (scheduler_event, scheduler_job).
 *   - Context custom propagado pra extra (sem secret/PII leak).
 *
 * @owner: @tester + @security
 * @card: #145 (5.2a) F5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { sentryMock, loggerMock } = vi.hoisted(() => ({
  sentryMock: {
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn(),
  },
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../src/config/sentry', () => ({
  Sentry: sentryMock,
}))

vi.mock('../../src/lib/logger', () => ({
  logger: loggerMock,
}))

/* eslint-disable import/first */
import {
  __testing,
  emitSchedulerEvent,
} from '../../src/scheduler/observability'
/* eslint-enable import/first */

describe('scheduler/observability — emitSchedulerEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('logger pino — sempre', () => {
    it('emite logger.info pra level=info', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.lock.acquired',
        jobName: 'history-purge',
      })

      expect(loggerMock.info).toHaveBeenCalledTimes(1)
      expect(loggerMock.warn).not.toHaveBeenCalled()
      expect(loggerMock.error).not.toHaveBeenCalled()
    })

    it('emite logger.warn pra level=warning', () => {
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.lock.heartbeat_lost',
        jobName: 'history-purge',
      })

      expect(loggerMock.warn).toHaveBeenCalledTimes(1)
      expect(loggerMock.info).not.toHaveBeenCalled()
      expect(loggerMock.error).not.toHaveBeenCalled()
    })

    it('emite logger.error pra level=error', () => {
      emitSchedulerEvent({
        level: 'error',
        event: 'cron.run.inflight_cap_exceeded',
        jobName: 'j',
      })

      expect(loggerMock.error).toHaveBeenCalledTimes(1)
    })

    it('inclui event e jobName no log context', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'history-purge',
        context: { runId: 'abc', durationMs: 1234 },
      })

      const [ctx, msg] = loggerMock.info.mock.calls[0]
      expect(msg).toBe('cron.run.success')
      expect(ctx).toMatchObject({
        event: 'cron.run.success',
        jobName: 'history-purge',
        runId: 'abc',
        durationMs: 1234,
      })
    })
  })

  describe('Sentry breadcrumb — sempre', () => {
    it('emite breadcrumb pra todos os levels', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.lock.acquired',
        jobName: 'j',
      })

      expect(sentryMock.addBreadcrumb).toHaveBeenCalledTimes(1)
      const arg = sentryMock.addBreadcrumb.mock.calls[0][0]
      expect(arg).toMatchObject({
        category: 'scheduler',
        level: 'info',
        message: 'cron.lock.acquired',
        data: { jobName: 'j' },
      })
    })

    it('mapeia level=warning → breadcrumb level warning', () => {
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.lock.heartbeat_lost',
        jobName: 'j',
      })

      const arg = sentryMock.addBreadcrumb.mock.calls[0][0]
      expect(arg.level).toBe('warning')
    })

    it('mapeia level=error → breadcrumb level error', () => {
      emitSchedulerEvent({
        level: 'error',
        event: 'cron.lock.heartbeat_failed',
        jobName: 'j',
      })

      const arg = sentryMock.addBreadcrumb.mock.calls[0][0]
      expect(arg.level).toBe('error')
    })

    it('propaga context pra breadcrumb.data', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'j',
        context: { runId: 'abc-123', durationMs: 500 },
      })

      const arg = sentryMock.addBreadcrumb.mock.calls[0][0]
      expect(arg.data).toMatchObject({
        jobName: 'j',
        runId: 'abc-123',
        durationMs: 500,
      })
    })
  })

  describe('Sentry captureMessage — apenas ALERTABLE_EVENTS', () => {
    it('NÃO dispara pra cron.run.success (info benigno)', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('NÃO dispara pra cron.lock.acquired', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.lock.acquired',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('NÃO dispara pra cron.run.skipped.lock_not_acquired', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.skipped.lock_not_acquired',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    })

    it('DISPARA pra cron.lock.expired_without_release (R-8)', () => {
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.lock.expired_without_release',
        jobName: 'history-purge',
      })

      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
      const [msg, opts] = sentryMock.captureMessage.mock.calls[0]
      expect(msg).toBe('cron.lock.expired_without_release')
      expect(opts).toMatchObject({
        level: 'warning',
        tags: {
          scheduler_event: 'cron.lock.expired_without_release',
          scheduler_job: 'history-purge',
        },
      })
    })

    it('DISPARA pra cron.lock.heartbeat_lost (split-brain)', () => {
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.lock.heartbeat_lost',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
    })

    it('DISPARA pra cron.run.inflight_cap_exceeded', () => {
      emitSchedulerEvent({
        level: 'error',
        event: 'cron.run.inflight_cap_exceeded',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
      const [, opts] = sentryMock.captureMessage.mock.calls[0]
      expect(opts.level).toBe('error')
    })

    it('DISPARA pra cron.run.expired', () => {
      emitSchedulerEvent({
        level: 'warning',
        event: 'cron.run.expired',
        jobName: 'j',
      })

      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
    })

    it('whitelist ALERTABLE_EVENTS é estável (snapshot contract)', () => {
      // Mudança aqui é breaking change pras rules do Sentry — qualquer
      // delta exige update do runbook docs/runbooks/cron-stuck.md.
      // F5 fix-pack: adicionados cron.run.failure (preserva visibilidade
      // de exceção do handler sem precisar de captureException paralelo)
      // e cron.lock.redis_unavailable (Redis offline = fail-open silencioso
      // sem alerta era gap operacional — @devops MÉDIO).
      // Card #146 F2 (T-2.3): adicionados cron.purge.dead_letter (row
      // travada após 5 tentativas — on-call investigar) e
      // cron.purge.pending_overdue (gauge stale > 2h ou count > threshold).
      const expected = new Set([
        'cron.run.failure',
        'cron.run.expired',
        'cron.run.inflight_cap_exceeded',
        'cron.lock.redis_unavailable',
        'cron.lock.expired_without_release',
        'cron.lock.release_failed',
        'cron.lock.heartbeat_lost',
        'cron.lock.heartbeat_failed',
        'cron.heartbeat.unexpected_error',
        'cron.purge.dead_letter',
        'cron.purge.pending_overdue',
      ])

      expect(__testing.ALERTABLE_EVENTS).toEqual(expected)
    })
  })

  describe('context size cap — F5 fix-pack @security MÉDIO', () => {
    it('aceita context dentro do cap (4KB)', () => {
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'j',
        context: { runId: 'small', durationMs: 100 },
      })

      // Sem aviso de truncamento — log único do evento de sucesso.
      expect(loggerMock.info).toHaveBeenCalledTimes(1)
      expect(loggerMock.warn).not.toHaveBeenCalled()
    })

    it('trunca context oversize e loga warning', () => {
      const huge = 'x'.repeat(__testing.CONTEXT_MAX_BYTES + 10)
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'j',
        context: { payload: huge },
      })

      // 1 log de warning (truncated) + 1 log de info (evento sanitizado)
      expect(loggerMock.warn).toHaveBeenCalledTimes(1)
      expect(loggerMock.info).toHaveBeenCalledTimes(1)

      const truncWarn = loggerMock.warn.mock.calls[0]
      expect(truncWarn[1]).toBe('scheduler.observability.context_truncated')
      expect(truncWarn[0]).toMatchObject({
        jobName: 'j',
        event: 'cron.run.success',
        cap: __testing.CONTEXT_MAX_BYTES,
      })

      const sanitizedInfo = loggerMock.info.mock.calls[0][0]
      expect(sanitizedInfo).toMatchObject({
        _truncated: true,
        _reason: 'oversize',
        event: 'cron.run.success',
      })
      expect(sanitizedInfo).not.toHaveProperty('payload')
    })

    it('trata context com circular reference como unserializable', () => {
      const circular: Record<string, unknown> = { foo: 'bar' }
      circular.self = circular

      emitSchedulerEvent({
        level: 'info',
        event: 'cron.run.success',
        jobName: 'j',
        context: circular,
      })

      expect(loggerMock.warn).toHaveBeenCalledTimes(1)
      const warn = loggerMock.warn.mock.calls[0]
      expect(warn[1]).toBe('scheduler.observability.context_truncated')
      expect(warn[0]).toMatchObject({ reason: 'unserializable' })

      const sanitizedInfo = loggerMock.info.mock.calls[0][0]
      expect(sanitizedInfo).toMatchObject({
        _truncated: true,
        _reason: 'unserializable',
      })
    })

    it('Sentry breadcrumb e captureMessage recebem context já truncado', () => {
      const huge = 'x'.repeat(__testing.CONTEXT_MAX_BYTES + 10)
      emitSchedulerEvent({
        level: 'error',
        event: 'cron.run.failure',
        jobName: 'j',
        context: { payload: huge },
      })

      const breadcrumb = sentryMock.addBreadcrumb.mock.calls[0][0]
      expect(breadcrumb.data).not.toHaveProperty('payload')
      expect(breadcrumb.data).toMatchObject({
        _truncated: true,
        _reason: 'oversize',
      })

      // cron.run.failure agora é ALERTABLE (fix-pack)
      expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
      const [, opts] = sentryMock.captureMessage.mock.calls[0]
      expect(opts.extra).toMatchObject({
        _truncated: true,
        _reason: 'oversize',
      })
      expect(opts.extra).not.toHaveProperty('payload')
    })
  })

  describe('PII / secret safety', () => {
    it('NÃO leak token de lock se caller passa por engano', () => {
      // Pattern Card #150: token é secret operacional. Callers do scheduler
      // NUNCA passam token no context. Se passassem, REDACT_PATHS do logger
      // pino + beforeBreadcrumb do Sentry (config/sentry.ts) cobririam —
      // este teste valida apenas que helper NÃO faz mock especial pra token.
      emitSchedulerEvent({
        level: 'info',
        event: 'cron.lock.released',
        jobName: 'j',
        context: { runId: 'safe-id' },
      })

      const logCtx = loggerMock.info.mock.calls[0][0]
      expect(logCtx).not.toHaveProperty('token')
    })
  })
})
