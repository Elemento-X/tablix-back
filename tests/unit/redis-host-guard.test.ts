import { describe, expect, it } from 'vitest'
import { redisHostsCollide } from '../../src/config/redis-host-guard'

/**
 * Rede de regressão do guard F2 (Card 6.2 — @reviewer, fingerprint 7f3a9c2e1b04).
 *
 * Garante que o boot-assert de DB dedicado do BullMQ (D-1) não pode ser
 * removido/quebrado silenciosamente. O `env-validation.test.ts` testa uma
 * RÉPLICA do schema (não o env.ts real) e não cobre este guard — daí o
 * predicado puro testado diretamente aqui.
 */
describe('redisHostsCollide — guard de DB dedicado do BullMQ (D-1)', () => {
  const REST = 'https://willing-gull-133652.upstash.io'
  const SAME_TCP = 'rediss://default:senha@willing-gull-133652.upstash.io:6379'
  const OTHER_TCP = 'rediss://default:senha@other-db-999999.upstash.io:6379'

  it('COLIDE quando REST e TCP apontam para o mesmo host (protocolos diferentes)', () => {
    // Cenário que o guard existe pra barrar: mesmo database Upstash via dois
    // protocolos → noeviction vs TTL colidem → perda de job.
    expect(redisHostsCollide(SAME_TCP, REST)).toBe(true)
  })

  it('NÃO colide quando os hosts diferem (DB dedicado correto)', () => {
    expect(redisHostsCollide(OTHER_TCP, REST)).toBe(false)
  })

  it('NÃO colide quando REDIS_URL ausente (dev sem fila)', () => {
    expect(redisHostsCollide(undefined, REST)).toBe(false)
  })

  it('NÃO colide quando UPSTASH_REDIS_REST_URL ausente', () => {
    expect(redisHostsCollide(SAME_TCP, undefined)).toBe(false)
  })

  it('NÃO colide quando ambas ausentes', () => {
    expect(redisHostsCollide(undefined, undefined)).toBe(false)
  })

  it('comparação de host é case-insensitive', () => {
    expect(
      redisHostsCollide(
        'rediss://default:s@WILLING-GULL-133652.UPSTASH.IO:6379',
        'https://willing-gull-133652.upstash.io',
      ),
    ).toBe(true)
  })

  it('porta e path divergentes não afetam — compara só o host físico', () => {
    expect(
      redisHostsCollide(
        'rediss://default:s@willing-gull-133652.upstash.io:6379',
        'https://willing-gull-133652.upstash.io/some/rest/path',
      ),
    ).toBe(true)
  })

  it('URL inválida é tratada como não-comparável (não colide, não lança)', () => {
    expect(redisHostsCollide('not-a-url', REST)).toBe(false)
    expect(redisHostsCollide(SAME_TCP, 'not-a-url')).toBe(false)
  })

  it('hosts diferentes que compartilham sufixo upstash.io NÃO colidem', () => {
    // Defesa contra match por substring — só hostname exato colide.
    expect(
      redisHostsCollide(
        'rediss://default:s@db-a.upstash.io:6379',
        'https://db-b.upstash.io',
      ),
    ).toBe(false)
  })
})
