/**
 * Quota alert job — Card #147 (5.2c) F3.
 *
 * Handler `scanUsageAndAlert` executado pelo scheduler (Card #145 F4) diariamente
 * às 08:00 BRT (`'0 11 * * *'` UTC). Escaneia usuários PRO ativos, compara uso
 * atual do mês (`usage.service.getCurrentUsage`) contra `PRO_LIMITS` e dispara
 * email + Sentry warning ao cruzar 70%/90% da quota mensal.
 *
 * **Dedupe mensal**: tabela `quota_alerts_sent` com UNIQUE(user_id, threshold, period)
 * absorve retries via `INSERT ... ON CONFLICT DO NOTHING` (espelha pattern atomic
 * do Card 4.2). 1 alerta por threshold por mês por user. Reset implícito: nova
 * `period` (mês UTC) permite reenvio automaticamente.
 *
 * **Algoritmo (4 fases)**:
 *   FASE A — heartbeat + dry-run guard + recordRunStart
 *   FASE B — SELECT PRO ativos (Token.status='ACTIVE' AND expiresAt > now)
 *   FASE C — loop users:
 *     1. Calcular usagePercent = floor(count / limit * 100)
 *     2. Para cada threshold [90, 70] (ordem decrescente — critical primeiro):
 *        a. Se usagePercent >= threshold: tentar INSERT (atomic dedupe)
 *        b. Se INSERT criou row: enviar email + emit user_above_threshold
 *        c. Se P2002 (UNIQUE): emit dedupe_skip (não envia email)
 *        d. Sleep 100ms entre envios (rate limit interno Resend 10/s — A-7)
 *     3. Email falha (Resend 5xx) → INSERT MESMO ASSIM já aconteceu (A-8);
 *        emit email_failed (Sentry warning) — próximo run não duplica.
 *   FASE D — gauge + recordRunEnd
 *     - setUsersAboveThreshold(70, count70) + setUsersAboveThreshold(90, count90)
 *     - UPDATE cron_runs SET status='success' WHERE id = runId
 *
 * **Hard rules invioláveis**:
 *   - Logs sem PII: userId (UUID), usagePercent, threshold, period. NÃO logar
 *     email, count cru. Métricas agregadas bounded (70, 90 only).
 *   - Heartbeat antes do loop principal (split-brain protection).
 *   - Dry-run mode (env.CRON_DRY_RUN=true): loga + emite eventos, NÃO insere
 *     em quota_alerts_sent NEM envia email.
 *   - Audiência = PRO ativos via Token (decisão A-3); NÃO filtrar por User.historyOptIn
 *     (quota é Card 4.x, opt-in é Card 5.2a — independentes).
 *   - Trade-off A-8: Resend falha → INSERT no quota_alerts_sent acontece MESMO
 *     ASSIM. Justificativa: re-tentar email no próximo cron rodaria sobre dedupe
 *     existente (silencioso). NÃO inserir seria pior — usuário receberia 2 emails
 *     idênticos quando Resend voltar. 1 email perdido > 30 duplicados.
 *
 * **Idempotência**: handler é `CronJobDefinition.idempotent: true`. Reentry
 * após crash mid-loop é safe porque:
 *   - UNIQUE(user_id, threshold, period) garante anti-duplicação.
 *   - INSERT...ON CONFLICT DO NOTHING é atomic — sem race.
 *   - Email já enviado com INSERT registrado → próximo run skip via dedupe.
 *
 * @owner: @reviewer + @dba + @security
 * @card: #147 (5.2c) F3
 * @plan: .claude/plans/2026-05-18-card-147-5.2c-cron-alerta-quota.md §4
 */
import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'

import { env } from '../config/env'
import { sendQuotaCriticalEmail, sendQuotaWarningEmail } from '../lib/email'
import { logger } from '../lib/logger'
import { prisma } from '../lib/prisma'
import { sleep } from '../lib/sleep'
import { PRO_LIMITS } from '../config/plan-limits'
import {
  getCurrentPeriod,
  getCurrentUsage,
  getNextResetAt,
} from '../modules/usage/usage.service'
import { setUsersAboveThreshold } from '../scheduler/metrics'
import { emitSchedulerEvent } from '../scheduler/observability'
import type { LockHandle } from '../scheduler/types'

// ============================================
// CONSTANTES
// ============================================

const JOB_NAME = 'quota-alert'

/** Thresholds em ordem DECRESCENTE — critical (90) avaliado antes de warning (70). */
const THRESHOLDS: readonly [90, 70] = [90, 70]

/**
 * Sleep entre `client.emails.send` — rate limit interno Resend (A-7).
 * Resend free tier = 100 req/s; usamos 10% = ~10 emails/seg. Margem cobre
 * paralelismo com emails de auth/billing.
 */
const RESEND_SLEEP_MS = 100

// ============================================
// HELPERS LOCAIS
// ============================================

/**
 * Sanitiza err.message — cap 100 chars + split em `:` (anti Prisma SQL leak) +
 * replace CR/LF/TAB (anti log injection). Espelha pattern de retention.job
 * (#146 fix-pack ciclo 1).
 *
 * Duplicação consciente: não-refactor de retention.job pra preservar estabilidade
 * (já em produção). Card discovery futuro pode extrair em `_lib/sanitize-error.ts`
 * compartilhado.
 */
function sanitizeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const prefix = err.message.split(':')[0] ?? ''
    return prefix.slice(0, 100).replace(/[\r\n\t]/g, ' ')
  }
  return 'unknown error'
}

// Card #147 fix-pack ciclo 1 (@tester ALTO F2): `sleep` extraído pra
// `src/lib/sleep.ts` permite mock via vi.mock em testes (eliminando
// setTimeout wall-clock real que violava determinismo).

// ============================================
// CRON_RUNS LIFECYCLE
// ============================================

/**
 * INSERT em cron_runs com status='running'. Retorna runId pra UPDATE no fim.
 * Falha de write NÃO derruba o handler (degraded — log warning + segue).
 * Padrão Card #146 (retention.job).
 */
async function recordRunStart(): Promise<string> {
  const runId = randomUUID()
  try {
    await prisma.cronRun.create({
      data: {
        id: runId,
        jobName: JOB_NAME,
        startedAt: new Date(),
        status: 'running',
        attempts: 1,
      },
    })
  } catch (err) {
    logger.warn(
      {
        jobName: JOB_NAME,
        runId,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage: sanitizeErrorMessage(err),
      },
      'quota-alert.cron_runs.insert_failed_degraded',
    )
  }
  return runId
}

async function recordRunEnd(args: {
  runId: string
  status: 'success' | 'failure'
  startedAt: Date
  rowsProcessed: number
  errorCode?: string
  errorMessage?: string
}): Promise<void> {
  const finishedAt = new Date()
  try {
    await prisma.cronRun.update({
      where: { id: args.runId },
      data: {
        finishedAt,
        status: args.status,
        durationMs: finishedAt.getTime() - args.startedAt.getTime(),
        rowsProcessed: args.rowsProcessed,
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage ?? null,
      },
    })
  } catch (err) {
    logger.warn(
      {
        jobName: JOB_NAME,
        runId: args.runId,
        targetStatus: args.status,
        errCode: err instanceof Error ? err.name : 'unknown',
        errMessage: sanitizeErrorMessage(err),
      },
      'quota-alert.cron_runs.update_failed_degraded',
    )
  }
}

// ============================================
// TIPOS INTERNOS
// ============================================

interface ProUserRow {
  id: string
  email: string
}

interface AlertResult {
  usersScanned: number
  usersAboveWarning: number
  usersAboveCritical: number
  emailsSent: number
  emailsFailed: number
  dedupeSkips: number
}

// ============================================
// SELECT PRO ATIVOS
// ============================================

/**
 * SELECT usuários com Token PRO ativo (status='ACTIVE' AND (expiresAt IS NULL
 * OR expiresAt > NOW())). Distinct por user (1 user pode ter múltiplos tokens
 * históricos; pegamos só ID + email).
 *
 * Volume esperado pré-go-live: <100. Pós-launch fase 1: <10k. Direct SELECT
 * sem cursor cabe até ~50k (A-6); acima disso → discovery card cron-cursor-batching.
 *
 * @returns Array de users ÚNICOS com PRO ativo.
 */
async function selectActiveProUsers(): Promise<ProUserRow[]> {
  const now = new Date()
  // Card #147 fix-pack ciclo 1 (@dba MÉDIO): SET LOCAL statement_timeout +
  // lock_timeout defensivos espelham pattern de retention.job.ts (#146 F3).
  // Statement timeout global (5s no DATABASE_URL) já cobre, mas SET LOCAL
  // dentro de tx documenta a intenção e protege contra mudança futura de
  // env var sem reverificar este handler.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'")
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'")
    return tx.user.findMany({
      where: {
        tokens: {
          some: {
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        },
      },
      select: {
        id: true,
        email: true,
      },
    })
  })
}

// ============================================
// THRESHOLD EVALUATION (per user)
// ============================================

/**
 * Avalia um único usuário e dispara alertas se cruzou thresholds. Retorna
 * contadores parciais (somados pelo caller).
 *
 * Ordem de thresholds: DESCRESCENTE (90 antes de 70). Justificativa: se user
 * está a 95%, queremos enviar email critical primeiro. Warning ainda será
 * tentado (dedupe absorve se já enviado em run anterior).
 */
async function evaluateUser(
  user: ProUserRow,
  period: string,
  resetAtFormatted: string,
  limit: number,
  dryRun: boolean,
): Promise<{
  hitWarning: boolean
  hitCritical: boolean
  emailsSent: number
  emailsFailed: number
  dedupeSkips: number
}> {
  const count = await getCurrentUsage(user.id)
  const usagePercent = Math.floor((count / limit) * 100)

  let hitWarning = false
  let hitCritical = false
  let emailsSent = 0
  let emailsFailed = 0
  let dedupeSkips = 0

  for (const threshold of THRESHOLDS) {
    if (usagePercent < threshold) continue

    if (threshold === 90) hitCritical = true
    if (threshold === 70) hitWarning = true

    // Emit event (LGPD-safe: userId UUID + threshold int + period — sem PII)
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.quota_alert.user_above_threshold',
      jobName: JOB_NAME,
      context: {
        userId: user.id,
        threshold,
        period,
        usagePercent,
      },
    })

    if (dryRun) {
      // Dry-run: emite evento mas NÃO toca DB NEM envia email
      continue
    }

    // INSERT atomic com dedupe — pattern Card 4.2
    let insertedRow = false
    try {
      await prisma.quotaAlertSent.create({
        data: {
          userId: user.id,
          threshold,
          period,
        },
      })
      insertedRow = true
    } catch (err) {
      // P2002 = UNIQUE violation = já enviado este mês → dedupe esperado
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        dedupeSkips += 1
        emitSchedulerEvent({
          level: 'info',
          event: 'cron.quota_alert.dedupe_skip',
          jobName: JOB_NAME,
          context: { userId: user.id, threshold, period },
        })
        continue
      }
      // Erro de DB inesperado — log + escalar pro caller
      logger.error(
        {
          jobName: JOB_NAME,
          userId: user.id,
          threshold,
          period,
          errCode: err instanceof Error ? err.name : 'unknown',
          errMessage: sanitizeErrorMessage(err),
        },
        'quota-alert.insert_failed',
      )
      throw err
    }

    // INSERT criou row → tentar envio do email
    // Trade-off A-8: se Resend falhar, INSERT já aconteceu. Próximo run NÃO
    // duplica (UNIQUE absorve). Sentry warning permite diagnosticar perdidos.
    if (insertedRow) {
      const params = {
        to: user.email,
        usagePercent,
        unificationsCount: count,
        limit,
        remaining: Math.max(0, limit - count),
        resetAtFormatted,
      }
      try {
        if (threshold === 90) {
          await sendQuotaCriticalEmail(params)
        } else {
          await sendQuotaWarningEmail(params)
        }
        emailsSent += 1
      } catch (err) {
        emailsFailed += 1
        emitSchedulerEvent({
          level: 'warning',
          event: 'cron.quota_alert.email_failed',
          jobName: JOB_NAME,
          context: {
            userId: user.id,
            threshold,
            period,
            errCode: err instanceof Error ? err.name : 'unknown',
            errMessage: sanitizeErrorMessage(err),
          },
        })
      }
      // Rate limit interno entre envios (A-7)
      await sleep(RESEND_SLEEP_MS)
    }
  }

  return { hitWarning, hitCritical, emailsSent, emailsFailed, dedupeSkips }
}

// ============================================
// HANDLER PRINCIPAL
// ============================================

/**
 * Handler do scheduler. Lifecycle:
 *  1. Heartbeat — aborta gracefully se lock perdido
 *  2. Dry-run guard — emit event se CRON_DRY_RUN=true (Sentry warning em prod)
 *  3. recordRunStart → SELECT PRO ativos → loop users → recordRunEnd
 *  4. setUsersAboveThreshold(70, count70) + setUsersAboveThreshold(90, count90)
 *
 * Erros NÃO escalam — runner do scheduler (cron.ts) já trata via Promise.catch
 * (emit cron.run.failure). Aqui re-throw apenas erros de DB inesperados; falhas
 * de Resend são swallowed (emit warning + continua).
 */
export async function scanUsageAndAlert(lock: LockHandle): Promise<void> {
  if (!(await lock.heartbeat())) {
    logger.warn({ jobName: JOB_NAME }, 'quota-alert.heartbeat_lost_aborting')
    return
  }

  const dryRun = env.CRON_DRY_RUN === true
  if (dryRun) {
    emitSchedulerEvent({
      level: 'info',
      event: 'cron.quota_alert.dry_run.start',
      jobName: JOB_NAME,
    })
  }

  const startedAt = new Date()
  const runId = await recordRunStart()
  const period = getCurrentPeriod()
  const resetAtFormatted = getNextResetAt().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  })
  const limit = PRO_LIMITS.unificationsPerMonth

  const result: AlertResult = {
    usersScanned: 0,
    usersAboveWarning: 0,
    usersAboveCritical: 0,
    emailsSent: 0,
    emailsFailed: 0,
    dedupeSkips: 0,
  }

  try {
    const users = await selectActiveProUsers()
    result.usersScanned = users.length

    // Card #147 fix-pack ciclo 2 (@security BAIXO 7a3b9f2d4e81): contador
    // local incrementado a cada iteração concluída — substitui fórmula
    // matemática anterior que sempre retornava users.length (bug observability
    // mascarava count parcial em incidente real).
    let usersProcessed = 0

    for (const user of users) {
      // Card #147 fix-pack ciclo 1 (@security MÉDIO heartbeat-per-iteration):
      // Heartbeat por iteração espelha pattern de retention.job.ts (Card #146).
      // Sem isso, loop grande + sleep cumulativo podia exceder TTL do lock
      // (10min) sem detecção → split-brain teórico em escala pós-launch.
      // Custo: 1 GET Redis por user (irrelevante vs ganho de defesa).
      if (!(await lock.heartbeat())) {
        logger.warn(
          {
            jobName: JOB_NAME,
            runId,
            usersProcessedSoFar: usersProcessed,
            usersRemaining: users.length - usersProcessed,
          },
          'quota-alert.heartbeat_lost_mid_loop_aborting',
        )
        break
      }

      const userResult = await evaluateUser(
        user,
        period,
        resetAtFormatted,
        limit,
        dryRun,
      )
      if (userResult.hitWarning) result.usersAboveWarning += 1
      if (userResult.hitCritical) result.usersAboveCritical += 1
      result.emailsSent += userResult.emailsSent
      result.emailsFailed += userResult.emailsFailed
      result.dedupeSkips += userResult.dedupeSkips
      usersProcessed += 1
    }

    // Atualiza gauges (sempre, mesmo em dry-run — gauge reflete "agora")
    setUsersAboveThreshold(70, result.usersAboveWarning)
    setUsersAboveThreshold(90, result.usersAboveCritical)

    await recordRunEnd({
      runId,
      status: 'success',
      startedAt,
      rowsProcessed: result.usersScanned,
    })

    logger.info(
      {
        jobName: JOB_NAME,
        runId,
        period,
        dryRun,
        usersScanned: result.usersScanned,
        usersAboveWarning: result.usersAboveWarning,
        usersAboveCritical: result.usersAboveCritical,
        emailsSent: result.emailsSent,
        emailsFailed: result.emailsFailed,
        dedupeSkips: result.dedupeSkips,
      },
      'quota-alert.completed',
    )
  } catch (err) {
    const errCode = err instanceof Error ? err.name : 'unknown'
    const errMessage = sanitizeErrorMessage(err)
    await recordRunEnd({
      runId,
      status: 'failure',
      startedAt,
      rowsProcessed: result.usersScanned,
      errorCode: errCode,
      errorMessage: errMessage,
    })
    throw err
  }
}

/**
 * Internals expostos APENAS pra testes unitários. Não usar em produção.
 */
export const __testing = {
  JOB_NAME,
  THRESHOLDS,
  RESEND_SLEEP_MS,
  sanitizeErrorMessage,
  recordRunStart,
  recordRunEnd,
  selectActiveProUsers,
  evaluateUser,
}
