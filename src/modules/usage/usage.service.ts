/**
 * Usage service — Card 4.1 (#33).
 *
 * Single source of truth para leitura de uso mensal e exposição de limites
 * por plano. Substitui as funções `getCurrentPeriod` / `getCurrentUsage`
 * que viviam em `process.service.ts` (movidas pra cá pra evitar duplicação
 * e preparar terreno pro Card 4.2 — atomic quota enforcement).
 *
 * Contrato:
 *  - Funções **read-only** (getUserUsage, getLimitsForPlanResponse)
 *  - DTOs alinhados com api-contract.md (envelope `{ data }` é
 *    responsabilidade do controller; service retorna o objeto interno)
 *  - `period` é YYYY-MM em UTC (mesmo cálculo do process.service legado)
 *  - `resetAt` é o início do próximo mês em UTC, ISO 8601
 *
 * Card 4.2 (próximo) adicionará `validateAndIncrementUsage()` atômico
 * neste arquivo — fecha o waiver WV-2026-002 (TOCTOU em validateProLimits).
 *
 * @owner: @planner + @dba
 * @card: 4.1 (#33)
 */
import type { Plan } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { getLimitsForPlan } from '../../config/plan-limits'
import type { LimitsWithPlan, UsageWithReset } from './usage.schema'

/**
 * Tipo público que aceita os 2 estados que vêm do JWT (`role: 'FREE' | 'PRO'`)
 * e o `null` (sem token ativo). O enum `Plan` do Prisma só lista `PRO` —
 * `FREE` é o "implícito" e mapeia pra `null` no `getLimitsForPlan`.
 */
type PlanLike = Plan | 'FREE' | null

function toPrismaPlan(plan: PlanLike): Plan | null {
  // 'FREE' do JWT é o estado "sem token ativo" do schema → null
  if (plan === 'FREE' || plan === null) return null
  return plan
}

/**
 * Retorna o período atual no formato YYYY-MM em UTC.
 * UTC pra evitar drift de timezone — usuário em UTC-3 que faz unificação
 * às 23h do dia 31 não pode "ganhar" um mês a mais por trocar de timezone.
 */
export function getCurrentPeriod(date: Date = new Date()): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

/**
 * Calcula o instante de reset do contador (início do próximo período UTC).
 * Cliente usa esse timestamp pra mostrar countdown na UI.
 */
export function getNextResetAt(date: Date = new Date()): Date {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  // Date.UTC(yyyy, mm, 1) → primeiro dia do mês `mm` (zero-indexed).
  // Passar `month + 1` resolve corretamente o rollover de dezembro
  // pra janeiro do ano seguinte (mês 12 vira mês 0 do ano+1).
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0))
}

/**
 * Lê o uso atual do usuário no período corrente. Se não existir registro,
 * retorna `unificationsCount = 0` (caso comum: primeiro acesso do usuário
 * no mês ainda não acionou o incremento).
 *
 * Não cria registro — escrita é responsabilidade exclusiva do
 * incrementUsage (process.service hoje, validateAndIncrementUsage no Card 4.2).
 */
export async function getCurrentUsage(userId: string): Promise<number> {
  const period = getCurrentPeriod()
  const usage = await prisma.usage.findUnique({
    where: {
      userId_period: { userId, period },
    },
  })
  return usage?.unificationsCount ?? 0
}

/**
 * Compose o DTO completo de /usage: lê count + resolve limite do plano +
 * calcula `remaining` e `resetAt`. Saturated em zero (`remaining` nunca
 * negativo — se o usuário ultrapassou via condição de corrida pré-Card 4.2,
 * UI ainda funciona).
 */
export async function getUserUsage(
  userId: string,
  plan: PlanLike,
): Promise<UsageWithReset> {
  const [current, period, resetAt] = await Promise.all([
    getCurrentUsage(userId),
    Promise.resolve(getCurrentPeriod()),
    Promise.resolve(getNextResetAt()),
  ])

  const { unificationsPerMonth: limit } = getLimitsForPlan(toPrismaPlan(plan))
  const remaining = Math.max(0, limit - current)

  return {
    current,
    limit,
    remaining,
    period,
    resetAt: resetAt.toISOString(),
  }
}

/**
 * Mapeia `PlanLimits` (interface interna) → DTO público de /limits.
 * Decisão de produto: FREE tem watermark no output, PRO não.
 *
 * `hasWatermark` é derivado do plan, não armazenado em PlanLimits — pra
 * evitar duplicar a regra em 2 lugares (interface interna + DTO público).
 *
 * Plan resolvido server-side a partir do JWT do usuário autenticado.
 * Cliente NUNCA decide o plano (security: a única barreira real é o server).
 */
export function getLimitsForPlanResponse(plan: PlanLike): LimitsWithPlan {
  const limits = getLimitsForPlan(toPrismaPlan(plan))
  // `Plan` enum no Prisma só tem PRO atualmente; FREE é o "implícito"
  // (usuário sem token ativo). Em response, distinguimos pra UI.
  const resolvedPlan: 'FREE' | Plan = plan ?? 'FREE'
  const hasWatermark = resolvedPlan === 'FREE'

  return {
    plan: resolvedPlan,
    limits: {
      unificationsPerMonth: limits.unificationsPerMonth,
      maxInputFiles: limits.maxInputFiles,
      maxFileSize: limits.maxFileSize,
      maxTotalSize: limits.maxTotalSize,
      maxRowsPerFile: limits.maxRows,
      maxTotalRows: limits.maxTotalRows,
      maxColumns: limits.maxColumns,
      hasWatermark,
    },
  }
}
