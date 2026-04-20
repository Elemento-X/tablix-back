/**
 * Unit tests for webhook circuit breaker (Card 2.4 fix — @security CRÍTICO F-1)
 *
 * Cobre:
 *   - isWebhookSignatureBanned: retorna false sem Redis, false se chave
 *     não existe, true se existe.
 *   - recordWebhookSignatureFailure: incrementa, seta TTL na primeira
 *     falha, aplica ban ao atingir threshold.
 *   - Fail-open: erros de Redis não propagam nem bloqueiam.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isWebhookSignatureBanned,
  recordWebhookSignatureFailure,
  WEBHOOK_CIRCUIT_BREAKER_CONFIG,
} from '../../src/lib/security/webhook-circuit-breaker'

const { redisMock, loggerWarn } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
  },
  loggerWarn: vi.fn(),
}))

vi.mock('../../src/config/redis', () => ({
  redis: redisMock,
}))

vi.mock('../../src/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

describe('Webhook circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isWebhookSignatureBanned', () => {
    it('retorna false quando a chave de ban não existe', async () => {
      redisMock.get.mockResolvedValue(null)
      const banned = await isWebhookSignatureBanned('1.2.3.4')
      expect(banned).toBe(false)
      expect(redisMock.get).toHaveBeenCalledWith(
        'tablix:webhook-sig:ban:1.2.3.4',
      )
    })

    it('retorna true quando a chave de ban existe', async () => {
      redisMock.get.mockResolvedValue('1')
      const banned = await isWebhookSignatureBanned('1.2.3.4')
      expect(banned).toBe(true)
    })

    it('retorna false se Redis lança (fail-open, loga warning)', async () => {
      redisMock.get.mockRejectedValue(new Error('redis timeout'))
      const banned = await isWebhookSignatureBanned('1.2.3.4')
      expect(banned).toBe(false)
      expect(loggerWarn).toHaveBeenCalled()
    })
  })

  describe('recordWebhookSignatureFailure', () => {
    it('incrementa e seta TTL na primeira falha', async () => {
      redisMock.incr.mockResolvedValue(1)
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.incr).toHaveBeenCalledWith(
        'tablix:webhook-sig:fails:1.2.3.4',
      )
      expect(redisMock.expire).toHaveBeenCalledWith(
        'tablix:webhook-sig:fails:1.2.3.4',
        WEBHOOK_CIRCUIT_BREAKER_CONFIG.FAILURE_WINDOW_SECONDS,
      )
      expect(redisMock.set).not.toHaveBeenCalled()
    })

    it('não seta TTL em incrementos subsequentes', async () => {
      redisMock.incr.mockResolvedValue(3)
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.expire).not.toHaveBeenCalled()
      expect(redisMock.set).not.toHaveBeenCalled()
    })

    it('aplica ban ao atingir MAX_FAILURES', async () => {
      redisMock.incr.mockResolvedValue(
        WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES,
      )
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.set).toHaveBeenCalledWith(
        'tablix:webhook-sig:ban:1.2.3.4',
        '1',
        { ex: WEBHOOK_CIRCUIT_BREAKER_CONFIG.BAN_DURATION_SECONDS },
      )
      expect(loggerWarn).toHaveBeenCalled()
    })

    it('aplica ban quando falhas excedem MAX_FAILURES', async () => {
      redisMock.incr.mockResolvedValue(
        WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES + 2,
      )
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.set).toHaveBeenCalled()
    })

    it('não lança se Redis falha (fire-and-forget)', async () => {
      redisMock.incr.mockRejectedValue(new Error('redis down'))
      await expect(
        recordWebhookSignatureFailure('1.2.3.4'),
      ).resolves.toBeUndefined()
      expect(loggerWarn).toHaveBeenCalled()
    })
  })

  describe('configuração', () => {
    it('usa defaults seguros', () => {
      expect(WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES).toBe(5)
      expect(WEBHOOK_CIRCUIT_BREAKER_CONFIG.FAILURE_WINDOW_SECONDS).toBe(60)
      expect(WEBHOOK_CIRCUIT_BREAKER_CONFIG.BAN_DURATION_SECONDS).toBe(900)
    })
  })
})
