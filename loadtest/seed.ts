/**
 * Load test SEED (Card #229 / Fase 7.5) — cria um POOL de N usuários PRO sintéticos
 * + tokens no DB dev/test COMPARTILHADO e minta JWTs pelo `/auth/validate-token` REAL.
 *
 * ⚠️ GATED: toca o store compartilhado (#218 / WV-2026-010). Rodar SÓ na janela
 * aprovada pelo dono, DEPOIS do review do @dba + @security. A saída (JWTs) NUNCA é
 * committada (loadtest/.gitignore).
 *
 * Por que POOL (não 1 usuário): o guard per-user=2 (< cap #219=3) impede um único
 * usuário de saturar o cap de concorrência; e a quota 30/mês curto-circuita o parse
 * ANTES da memória. 8 usuários × 30 = headroom pra ondas sustentadas.
 *
 * Marcador de CLEANUP: email `loadtest-pro-{n}@staging.invalid` (User/Token não têm
 * coluna env). `cleanup.ts` apaga por esse padrão + audit_log por `actor IN pool`.
 *
 * Fluxo fiel à produção: cria User(role=PRO) + Token(plaintext, ACTIVE, fingerprint=null)
 * e chama POST /auth/validate-token {token, fingerprint} → o backend vincula o
 * fingerprint e devolve o accessToken (JWT role=PRO).
 *
 * Uso: tsx loadtest/seed.ts   (lê DATABASE_URL do .env = dev/test compartilhado)
 */
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { generateProToken } from '../src/lib/token-generator'

const TARGET =
  process.env.LOADTEST_TARGET ?? 'https://tablix-back-staging.fly.dev'
const POOL_SIZE = Number(process.env.LOADTEST_POOL_SIZE ?? 8)
const EMAIL_PREFIX = 'loadtest-pro-'
const EMAIL_DOMAIN = '@staging.invalid'

interface SeedEntry {
  email: string
  userId: string
  jwt: string
}

async function main(): Promise<void> {
  console.log(`[seed] alvo=${TARGET} pool=${POOL_SIZE}`)
  const out: SeedEntry[] = []

  for (let i = 1; i <= POOL_SIZE; i++) {
    const email = `${EMAIL_PREFIX}${i}${EMAIL_DOMAIN}`
    const fingerprint = randomBytes(32).toString('hex') // 64 hex, único por usuário
    const token = generateProToken()

    const user = await prisma.user.upsert({
      where: { email },
      update: { role: 'PRO' },
      create: { email, role: 'PRO' },
    })

    // @dba: idempotência — pool sintético sem histórico a preservar. Remove tokens
    // anteriores do user antes de criar, pra re-rodar não acumular ACTIVE duplicado
    // (NULL != NULL no uq composto não bloqueia múltiplos `(user, NULL)`).
    await prisma.token.deleteMany({ where: { userId: user.id } })
    // Token ACTIVE não-vinculado (fingerprint=null → vincula na 1ª validação).
    // @security RR-1: expiresAt 24h → token se AUTO-CURA se o cleanup for esquecido
    // (não fica credencial PRO viva indefinidamente no store compartilhado).
    await prisma.token.create({
      data: {
        userId: user.id,
        token,
        plan: 'PRO',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })

    // Minta o JWT pelo fluxo REAL (vincula o fingerprint).
    const res = await fetch(`${TARGET}/auth/validate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, fingerprint }),
    })
    if (!res.ok) {
      throw new Error(
        `validate-token falhou p/ ${email}: HTTP ${res.status} ${await res.text()}`,
      )
    }
    const body = (await res.json()) as {
      data?: { accessToken?: string }
      accessToken?: string
    }
    const jwt = body.data?.accessToken ?? body.accessToken
    if (!jwt) {
      throw new Error(`sem accessToken p/ ${email}: ${JSON.stringify(body)}`)
    }
    out.push({ email, userId: user.id, jwt })
    console.log(`[seed] ${email} OK (userId=${user.id})`)
  }

  writeFileSync('loadtest/.jwts.json', JSON.stringify(out, null, 2))
  console.log(`[seed] ${out.length} JWTs → loadtest/.jwts.json (NÃO commitar)`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('[seed] FALHOU:', e)
  await prisma.$disconnect()
  process.exit(1)
})
