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
    // Card #86: INCR+EXPIRE atômico via EVAL — substitui par incr/expire
    eval: vi.fn(),
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
    it('chama EVAL atômico (INCR+EXPIRE+ban) na primeira falha', async () => {
      // Lua agora retorna [count, banApplied]
      redisMock.eval.mockResolvedValue([1, 0])
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.eval).toHaveBeenCalledTimes(1)
      const [script, keys, args] = redisMock.eval.mock.calls[0]
      // Script atômico contém INCR, EXPIRE e SET (ban) — fechando todos os 3 races
      expect(script).toContain("redis.call('INCR'")
      expect(script).toContain("redis.call('EXPIRE'")
      expect(script).toContain("redis.call('SET'")
      // KEYS[1]=failKey, KEYS[2]=banKey
      expect(keys).toEqual([
        'tablix:webhook-sig:fails:1.2.3.4',
        'tablix:webhook-sig:ban:1.2.3.4',
      ])
      // ARGV: window, MAX_FAILURES, BAN_DURATION (todos string-encoded)
      expect(args).toEqual([
        String(WEBHOOK_CIRCUIT_BREAKER_CONFIG.FAILURE_WINDOW_SECONDS),
        String(WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES),
        String(WEBHOOK_CIRCUIT_BREAKER_CONFIG.BAN_DURATION_SECONDS),
      ])
      // SET ban acontece DENTRO do EVAL — controller não chama set diretamente
      expect(redisMock.set).not.toHaveBeenCalled()
    })

    it('EVAL único em incrementos subsequentes (sem chamadas extras)', async () => {
      redisMock.eval.mockResolvedValue([3, 0])
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.eval).toHaveBeenCalledTimes(1)
      expect(redisMock.set).not.toHaveBeenCalled()
    })

    it('loga ban quando EVAL retorna banApplied=1 (only-once por IP)', async () => {
      redisMock.eval.mockResolvedValue([
        WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES,
        1,
      ])
      await recordWebhookSignatureFailure('1.2.3.4')
      // SET é dentro do Lua — controller não chama redis.set diretamente
      expect(redisMock.set).not.toHaveBeenCalled()
      // Log de ban dispara
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          ip: '1.2.3.4',
          failures: WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES,
        }),
        expect.stringContaining('IP banido'),
      )
    })

    it('NÃO loga ban quando count > MAX_FAILURES (banApplied=0, only-once)', async () => {
      // Cenário: ban já aplicado em falha anterior; falha extra não re-loga
      redisMock.eval.mockResolvedValue([
        WEBHOOK_CIRCUIT_BREAKER_CONFIG.MAX_FAILURES + 2,
        0,
      ])
      await recordWebhookSignatureFailure('1.2.3.4')
      // Log de ban NÃO dispara (banApplied=0) — fix log noise
      expect(loggerWarn).not.toHaveBeenCalled()
    })

    it('não lança se Redis EVAL falha (fire-and-forget)', async () => {
      redisMock.eval.mockRejectedValue(new Error('redis down'))
      await expect(
        recordWebhookSignatureFailure('1.2.3.4'),
      ).resolves.toBeUndefined()
      expect(loggerWarn).toHaveBeenCalled()
    })

    it('shape inesperado do EVAL (ex: null) é logado e tratado como no-op', async () => {
      redisMock.eval.mockResolvedValue(null)
      await expect(
        recordWebhookSignatureFailure('1.2.3.4'),
      ).resolves.toBeUndefined()
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '1.2.3.4', result: null }),
        expect.stringContaining('shape inesperado'),
      )
      // Não dispara ban nem set
      expect(redisMock.set).not.toHaveBeenCalled()
    })

    it('Card #86 — atomicidade: 1 EVAL fecha TOCTOU INCR+EXPIRE+SET ban', async () => {
      // Guard arquitetural: 3 races fechados num único script.
      // Reintrodução de incr/expire/set separados quebra esse teste.
      redisMock.eval.mockResolvedValue([1, 0])
      await recordWebhookSignatureFailure('1.2.3.4')
      expect(redisMock.eval).toHaveBeenCalledTimes(1)
      // SET ban está dentro do Lua — controller não emite SET fora do EVAL
      expect(redisMock.set).not.toHaveBeenCalled()
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
