/**
 * Sleep helper — promise-based setTimeout wrapper.
 *
 * **Por que módulo separado**: permite mock em testes via `vi.mock`. Funções
 * locais dentro de jobs/handlers não conseguem ser interceptadas, fazendo
 * tests gastarem wall-clock real em rate-limit sleeps (violação da hard rule
 * "tests devem ser determinísticos" do agente @tester).
 *
 * Extraído por Card #147 fix-pack ciclo 1 (@tester ALTO F2 —
 * non-deterministic-test). Discovery card opcional cobre adoção em
 * `retention.job.ts` (atualmente tem sleep local duplicado).
 *
 * @owner: @tester
 * @card: #147 fix-pack ciclo 1
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
