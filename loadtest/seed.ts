/**
 * Load test SEED (Card #229 / Fase 7.5) — cria um POOL de N usuários PRO sintéticos
 * + tokens no DB dev/test COMPARTILHADO e minta um accessToken (JWT) pelo
 * `/auth/validate-token` REAL.
 *
 * ⚠️ GATED: toca o store compartilhado (#218 / WV-2026-010). Rodar SÓ na janela
 * aprovada pelo dono, DEPOIS do review do @dba + @security. A saída (JWTs) NUNCA é
 * committada (loadtest/.gitignore).
 *
 * Lifetimes (corrige doc anterior que dizia "24h"):
 *  - accessToken (JWT) escrito no .jwts.json: ~15min (generateAccessToken). Em ondas
 *    longas o k6 precisa re-mintar — ver plano (Decisão B).
 *  - Token no DB (token.expiresAt): 24h — backstop de AUTO-CURA se o cleanup for
 *    esquecido (não fica credencial PRO viva indefinidamente no store compartilhado).
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
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { generateProToken } from '../src/lib/token-generator'

const TARGET =
  process.env.LOADTEST_TARGET ?? 'https://tablix-back-staging.fly.dev'
const EMAIL_PREFIX = 'loadtest-pro-'
const EMAIL_DOMAIN = '@staging.invalid'

// Saída ancorada no diretório DESTE script (não no CWD) — @security F6: rodar de
// dentro de loadtest/ cairia em loadtest/loadtest/.jwts.json, fora do .gitignore.
const JWTS_PATH = join(__dirname, '.jwts.json')

// @security F2: clamp do pool. O env sem teto é foot-gun de denial-of-store no
// store COMPARTILHADO (LOADTEST_POOL_SIZE=10000 por typo criaria 10k PRO).
function resolvePoolSize(): number {
  const raw = Number(process.env.LOADTEST_POOL_SIZE ?? 8)
  if (!Number.isInteger(raw) || raw < 1 || raw > 50) {
    throw new Error(
      `LOADTEST_POOL_SIZE inválido: "${process.env.LOADTEST_POOL_SIZE}" ` +
        `(esperado inteiro em [1,50])`,
    )
  }
  return raw
}
const POOL_SIZE = resolvePoolSize()

// @security F1: /auth/validate-token tem rate-limit 5/min por IP. Mints sequenciais
// sem espaçamento → o 6º toma 429 e aborta deixando PRO sintético órfão. ~15s entre
// mints garante ≤4 anteriores em qualquer janela de 60s (folga p/ sliding window).
// Override (=0) só pra dev local sem limiter.
const MINT_DELAY_MS = Number(process.env.LOADTEST_MINT_DELAY_MS ?? 15_000)

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function dbHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').host || '(desconhecido)'
  } catch {
    return '(DATABASE_URL não parseável)'
  }
}

interface SeedEntry {
  email: string
  userId: string
  jwt: string
}

async function main(): Promise<void> {
  // @dba: logar o host do DB que ESTE script escreve — confirme na janela que é o
  // mesmo do app staging (senão o cleanup roda no DB errado e deixa órfão).
  console.log(
    `[seed] alvo=${TARGET} pool=${POOL_SIZE} db=${dbHost()} mintDelay=${MINT_DELAY_MS}ms`,
  )
  const out: SeedEntry[] = []

  try {
    for (let i = 1; i <= POOL_SIZE; i++) {
      // @security F1: espaça os mints pra respeitar o limiter 5/min (pula o 1º).
      if (i > 1 && MINT_DELAY_MS > 0) await sleep(MINT_DELAY_MS)

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

      // Minta o accessToken pelo fluxo REAL (vincula o fingerprint).
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
  } finally {
    // @security F1: SEMPRE persiste o que já mintou — mesmo abortando no meio, o
    // operador tem os ids/jwts parciais e SABE que precisa rodar o cleanup.
    if (out.length > 0) {
      writeFileSync(JWTS_PATH, JSON.stringify(out, null, 2))
      console.log(
        `[seed] ${out.length}/${POOL_SIZE} entradas → ${JWTS_PATH} (NÃO commitar)`,
      )
    }
    if (out.length < POOL_SIZE) {
      console.warn(
        `[seed] ⚠️ PARCIAL: ${out.length}/${POOL_SIZE} criados. RODE O CLEANUP ` +
          `(tsx loadtest/cleanup.ts --apply) pra não deixar PRO sintético órfão.`,
      )
    }
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error('[seed] FALHOU:', e)
  process.exit(1)
})
