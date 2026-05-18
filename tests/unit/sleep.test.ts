/**
 * Unit tests for src/lib/sleep.ts — Card #147 fix-pack ciclo 2.5.
 *
 * Cobre coverage gap apontado pelo @tester MÉDIO 7a8c4e1d3f60:
 *   - sleep.ts é mockado em outros tests (quota-alert-job, retention.job futuro)
 *     pra eliminar wall-clock real
 *   - Coverage report mostrava 0% — mock substitui antes do istanbul instrumentar
 *   - Este arquivo executa a implementação REAL com fake timers (sem wall-clock
 *     real), cobre branch único da função + valida comportamento esperado
 *     (setTimeout(resolve, ms) → resolve após N ms via advanceTimersByTime)
 *
 * @owner: @tester
 * @card: #147 fix-pack ciclo 2.5
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { sleep } from '../../src/lib/sleep'

afterEach(() => {
  vi.useRealTimers()
})

describe('sleep — implementação real com fake timers', () => {
  it('resolve após N ms (advanceTimersByTime exato)', async () => {
    vi.useFakeTimers()
    let resolved = false
    const promise = sleep(100).then(() => {
      resolved = true
    })

    // Antes de avançar: promise não resolveu
    expect(resolved).toBe(false)

    // Avança exatamente 99ms: ainda não resolveu
    await vi.advanceTimersByTimeAsync(99)
    expect(resolved).toBe(false)

    // Avança +1ms (totalizando 100ms): resolveu
    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(resolved).toBe(true)
  })

  it('sleep(0) resolve imediatamente após tick', async () => {
    vi.useFakeTimers()
    let resolved = false
    const promise = sleep(0).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(0)
    await promise
    expect(resolved).toBe(true)
  })

  it('múltiplos sleeps simultâneos resolvem independentemente', async () => {
    vi.useFakeTimers()
    const order: number[] = []

    const p1 = sleep(50).then(() => order.push(50))
    const p2 = sleep(100).then(() => order.push(100))
    const p3 = sleep(75).then(() => order.push(75))

    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([p1, p2, p3])

    // Ordem cronológica: 50 → 75 → 100
    expect(order).toEqual([50, 75, 100])
  })
})
