/**
 * Tabela central de limites por plano.
 *
 * Fonte da verdade para limites de uso mensal, número de arquivos por unificação,
 * tamanho de arquivo, etc. — consumida por auth.service (retorno de /auth/me),
 * process.service (validação de limites) e qualquer outro módulo que precise.
 *
 * Card 1.11: eliminar hardcode de `40` / `5` espalhado pelo código. Quando
 * ENTERPRISE existir, basta adicionar a entrada aqui — NENHUM lugar do código
 * deve ter literal numérico para limite de plano.
 *
 * @see prisma/schema.prisma — enum Plan (PRO hoje; FREE/ENTERPRISE no futuro)
 */

import type { Plan } from '@prisma/client'
import { logger } from '../lib/logger'

export interface PlanLimits {
  /** Unificações permitidas por mês */
  unificationsPerMonth: number
  /** Máximo de arquivos de entrada por unificação */
  maxInputFiles: number
  /** Máximo de linhas por arquivo individual */
  maxRows: number
  /** Máximo de linhas totais somando todos os arquivos da unificação */
  maxTotalRows: number
  /** Máximo de colunas selecionáveis no merge */
  maxColumns: number
  /** Tamanho máximo de arquivo individual (bytes) */
  maxFileSize: number
  /** Tamanho máximo total somando todos os arquivos da unificação (bytes) */
  maxTotalSize: number
}

/**
 * Plano implícito para usuários sem Token ativo.
 * Usuários FREE existem no schema (User.role) mas não têm entrada em Token.
 *
 * Fonte da verdade: `tablix-front/.claude/commands/tablix.md` (spec FREE).
 * Na prática o back raramente é acionado no FREE — arquivos <10MB rodam
 * 100% client-side no front. Ainda assim validamos aqui porque o servidor
 * é a única barreira real (ver .claude/rules/security.md).
 *
 * Nota: no FREE `maxFileSize` e `maxTotalSize` colapsam em 1MB — o limite
 * é sobre a soma dos arquivos, não por arquivo individual. Isso é
 * intencional e bate com o contrato do front.
 */
export const FREE_LIMITS: PlanLimits = {
  unificationsPerMonth: 1,
  maxInputFiles: 3,
  maxRows: 500,
  maxTotalRows: 500,
  maxColumns: 3,
  maxFileSize: 1 * 1024 * 1024, // 1 MB
  maxTotalSize: 1 * 1024 * 1024, // 1 MB (soma total dos 3 arquivos)
}

/**
 * Plano PRO — fonte: D.1 (decisão fechada 2026-04-09).
 * Valores alinhados com `tablix-front/.claude/commands/tablix.md` (spec PRO),
 * exceto `unificationsPerMonth` que no front ainda está desatualizado (diz 40).
 * Follow-up: sincronizar tablix.md do front para 30/mês.
 */
export const PRO_LIMITS: PlanLimits = {
  unificationsPerMonth: 30,
  maxInputFiles: 15,
  maxRows: 5_000,
  maxTotalRows: 75_000,
  maxColumns: 10,
  maxFileSize: 2 * 1024 * 1024, // 2 MB
  maxTotalSize: 30 * 1024 * 1024, // 30 MB (soma total)
}

/**
 * ENTERPRISE intencionalmente NÃO entra aqui. O fluxo atual é manual:
 * cliente envia e-mail, operação humana. Se virar plano real no futuro,
 * adicionar entrada aqui + linha no enum Plan do schema.prisma.
 */

/**
 * Mapa Plan → PlanLimits.
 *
 * Tipado como `Record<Plan, PlanLimits>`: adicionar um valor novo ao enum
 * `Plan` no schema.prisma sem adicionar entrada aqui vira erro de compilação
 * — fail-fast no build, não em runtime.
 *
 * Quando ENTERPRISE entrar no schema, adicionar a entrada aqui.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  PRO: PRO_LIMITS,
}

/**
 * Resolve limites a partir de um Plan do Prisma ou `null` (sem token ativo).
 *
 * - `null` / `undefined` → FREE_LIMITS (usuário sem token ativo é FREE).
 * - `plan` presente em PLAN_LIMITS → retorno direto.
 * - `plan` ausente em PLAN_LIMITS → fallback FREE **com warn em log**.
 *   Esse branch só é alcançável se o tipo TS for burlado em runtime
 *   (ex: valor vindo de dados migrados de outro schema, mock mal configurado,
 *   ou novo valor adicionado ao enum Prisma sem rebuild). Warn é sinal de
 *   drift — deve ser corrigido, não silenciado.
 */
export function getLimitsForPlan(plan: Plan | null | undefined): PlanLimits {
  if (!plan) {
    return FREE_LIMITS
  }
  const limits = PLAN_LIMITS[plan]
  if (!limits) {
    logger.warn(
      { plan, module: 'plan-limits' },
      '[plan-limits] Plan sem entrada em PLAN_LIMITS — fallback para FREE. ' +
        'Drift entre enum Plan (schema.prisma) e PLAN_LIMITS. ' +
        'Adicionar a entrada é mandatório.',
    )
    return FREE_LIMITS
  }
  return limits
}
