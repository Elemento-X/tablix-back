/**
 * Load test CLEANUP (Card #229 / Fase 7.5) — purga NÃO-DESTRUTIVO do que o load test
 * criou no store COMPARTILHADO. DRY-RUN por default (só CONTA); `--apply` executa.
 *
 * ⚠️ GATED: rodar o DRY-RUN e validar os counts com @dba ANTES do `--apply`.
 * NUNCA toca `audit_log_legal` (#150, retenção legal 5 anos). Escopo estrito ao pool.
 *
 * Escopo: usuários `loadtest-pro-%@staging.invalid` + suas linhas. Ordem respeita as
 * FKs Restrict (Usage/Token antes do User; Session é Cascade mas apagamos explícito).
 * audit_log apagado por `actor IN pool` (os eventos forenses dos usuários sintéticos).
 *
 * Uso: tsx loadtest/cleanup.ts            (dry-run — só conta)
 *      tsx loadtest/cleanup.ts --apply    (executa — DEPOIS do review @dba)
 */
import { prisma } from '../src/lib/prisma'

const APPLY = process.argv.includes('--apply')

// @dba: logar o host do DB que ESTE script apaga — confirme na janela que é o mesmo
// do app staging e do seed (senão o --apply roda no DB errado).
function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host || '(desconhecido)'
  } catch {
    return '(DATABASE_URL não parseável)'
  }
}

async function main(): Promise<void> {
  console.log(`[cleanup] db=${dbHost()} (confirme == app staging)`)
  const users = await prisma.user.findMany({
    // @dba/@security: ancorar nos DOIS lados (prefixo + domínio reservado .invalid,
    // RFC 2606/6761, nunca um email real) pra NUNCA colidir com dado de outro dev no
    // store compartilhado — `startsWith` sozinho pegaria 'loadtest-pro-x@gmail.com'.
    where: {
      AND: [
        { email: { startsWith: 'loadtest-pro-' } },
        { email: { endsWith: '@staging.invalid' } },
      ],
    },
    select: { id: true, email: true },
  })
  const ids = users.map((u) => u.id)
  console.log(
    `[cleanup] ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${users.length} usuários do pool`,
  )
  if (ids.length === 0) {
    console.log('[cleanup] nada a limpar.')
    await prisma.$disconnect()
    return
  }

  // @dba: contar TAMBÉM as filhas Cascade (job/fileHistory/quotaAlertSent) — somem
  // junto do user no --apply; contá-las torna a prova de "baseline restaurado" completa.
  const [usageN, tokenN, sessionN, auditN, jobN, histN, alertN] =
    await Promise.all([
      prisma.usage.count({ where: { userId: { in: ids } } }),
      prisma.token.count({ where: { userId: { in: ids } } }),
      prisma.session.count({ where: { userId: { in: ids } } }),
      prisma.auditLog.count({ where: { actor: { in: ids } } }),
      prisma.job.count({ where: { userId: { in: ids } } }),
      prisma.fileHistory.count({ where: { userId: { in: ids } } }),
      prisma.quotaAlertSent.count({ where: { userId: { in: ids } } }),
    ])
  console.log(
    `[cleanup] ALVOS: usage=${usageN} token=${tokenN} session=${sessionN} ` +
      `audit_log=${auditN} | CASCADE(via user): job=${jobN} fileHistory=${histN} ` +
      `quotaAlertSent=${alertN} | users=${ids.length}`,
  )
  console.log('[cleanup] NUNCA toca audit_log_legal (#150).')

  if (!APPLY) {
    console.log(
      '[cleanup] DRY-RUN — nada apagado. Valide os counts com @dba e rode --apply.',
    )
    await prisma.$disconnect()
    return
  }

  // @dba: $transaction array — ATÔMICO (all-or-nothing) e mantém a ORDEM (filhos com
  // FK Restrict — usage/token — antes do User; session/job/fileHistory/quotaAlertSent
  // são Cascade no delete do user). Sem estado parcial visível a outros devs.
  const [d1, d2, d3, d4, d5] = await prisma.$transaction([
    prisma.usage.deleteMany({ where: { userId: { in: ids } } }),
    prisma.token.deleteMany({ where: { userId: { in: ids } } }),
    prisma.session.deleteMany({ where: { userId: { in: ids } } }),
    prisma.auditLog.deleteMany({ where: { actor: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ])
  console.log(
    `[cleanup] APLICADO: usage=${d1.count} token=${d2.count} session=${d3.count} ` +
      `audit=${d4.count} user=${d5.count} (job/fileHistory/quotaAlertSent via CASCADE)`,
  )
  console.log(
    '[cleanup] Verifique: counts devem voltar ao baseline (Task 0.3).',
  )
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('[cleanup] FALHOU:', e)
  await prisma.$disconnect()
  process.exit(1)
})
