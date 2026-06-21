/**
 * Unit tests — orquestrador idempotente `processStripeEvent` (Card #189).
 *
 * Cobre os ramos da máquina de estado RECEIVED → PROCESSED:
 *   (1) evento novo                          → processado
 *   (2) P2002 + status PROCESSED             → duplicata (sem handler)
 *   (3) P2002 + status RECEIVED              → reprocessa (tentativa anterior falhou)
 *   (4) lock não-adquirido + não-PROCESSED   → throw 500 (Stripe redelivera)
 *   (5) lock não-adquirido + virou PROCESSED → duplicata (holder concorrente concluiu)
 *   (6) lock adquirido + já PROCESSED (double-check dentro da tx) → duplicata
 *
 * INVARIANTE-ÂNCORA (R-2 / D-3): emails e audits SÓ rodam PÓS-COMMIT, NUNCA
 * dentro da `$transaction`. O teste prova isso medindo as chamadas no momento
 * em que o callback da tx retorna (ainda "dentro" do $transaction) vs depois.
 *
 * Estratégia de mock:
 *   - `prisma.*` (fora da tx): create/findUnique do gate de dedup + step 4.
 *   - `txMock` (objeto separado): o que o callback de `$transaction` recebe —
 *     $queryRaw (lock), stripeEvent.findUnique (double-check), stripeEvent.update
 *     e os models tocados pelos handlers reais. Separar tx de prisma evita
 *     colisão de sequência entre findUnique de dentro e de fora da tx.
 *
 * @owner: @tester
 * @card: #189
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

import { processStripeEvent } from '../../src/modules/billing/webhook-idempotency'
import { sendTokenEmail } from '../../src/lib/email'
import { AuditAction } from '../../src/lib/audit/audit.types'

// --- Mocks compartilhados (hoisted) ---
const { prismaMock, txMock } = vi.hoisted(() => {
  function model() {
    return {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    }
  }
  // Objeto recebido pelo callback de $transaction (Prisma.TransactionClient).
  const txMock = {
    $queryRaw: vi.fn(),
    stripeEvent: { findUnique: vi.fn(), update: vi.fn() },
    user: model(),
    token: model(),
  }
  // Cliente fora da transação.
  const prismaMock = {
    stripeEvent: { create: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(),
  }
  return { prismaMock, txMock }
})

vi.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/fakedb',
    JWT_SECRET: 'FAKE_TEST_KEY_aaaaaaaaaaaabbbbbbbbbbbbcccccccccccc',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  },
}))

vi.mock('../../src/lib/prisma', () => ({ prisma: prismaMock }))

vi.mock('../../src/lib/token-generator', () => ({
  generateProToken: vi.fn(() => 'tbx_pro_test_token_12345678901234567890'),
}))

vi.mock('../../src/lib/email', () => ({
  sendTokenEmail: vi.fn().mockResolvedValue(undefined),
  sendCancellationEmail: vi.fn().mockResolvedValue(undefined),
  sendPaymentFailedEmail: vi.fn().mockResolvedValue(undefined),
}))

const emitAuditEventMock = vi.fn()
vi.mock('../../src/lib/audit/audit.service', () => ({
  emitAuditEvent: (...args: unknown[]) => emitAuditEventMock(...args),
}))

// --- Helpers ---

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function makeCtx() {
  return {
    ip: '203.0.113.7',
    userAgent: 'Stripe/1.0',
    log: makeLog(),
  }
}

// ProcessContext.log espera FastifyBaseLogger; o mock cobre os métodos usados.
type Ctx = ReturnType<typeof makeCtx>
function asCtx(ctx: Ctx): Parameters<typeof processStripeEvent>[1] {
  return ctx as unknown as Parameters<typeof processStripeEvent>[1]
}

/** Evento sem handler de negócio (default → runHandler retorna {}). */
function makeUnhandledEvent(id = 'evt_unhandled_1') {
  return {
    id,
    type: 'customer.created',
    data: { object: { id: 'cus_x' } },
  } as never
}

/** checkout.session.completed (handler real cria user+token, retorna email). */
function makeCheckoutEvent(id = 'evt_checkout_1') {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        customer_email: 'buyer@test.com',
        customer_details: { email: 'buyer@test.com' },
        customer: 'cus_1',
        subscription: 'sub_1',
      },
    },
  } as never
}

function makeP2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.0.0',
  })
}

/** $transaction default: passa o txMock ao callback (interactive transaction). */
function wireTransactionPassthrough() {
  prismaMock.$transaction.mockImplementation(
    async (cb: (tx: typeof txMock) => unknown) => cb(txMock),
  )
}

function emittedActions() {
  return emitAuditEventMock.mock.calls.map(
    (c) => (c[0] as { action: string }).action,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  wireTransactionPassthrough()
  // Defaults felizes para o caminho de processamento dentro da tx.
  txMock.$queryRaw.mockResolvedValue([{ locked: true }])
  txMock.stripeEvent.findUnique.mockResolvedValue({ status: 'RECEIVED' })
  txMock.stripeEvent.update.mockResolvedValue({})
})

// ===========================================================================
// (1) Evento novo → processado
// ===========================================================================
describe('processStripeEvent — evento novo', () => {
  it('insere RECEIVED com status + receivedAt e marca PROCESSED ao fim', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})

    const outcome = await processStripeEvent(
      makeUnhandledEvent(),
      asCtx(makeCtx()),
    )

    expect(outcome).toBe('processed')
    // INSERT é o gate de dedup: status RECEIVED + received_at explícito.
    const createArg = prismaMock.stripeEvent.create.mock.calls[0]![0] as {
      data: { status: string; receivedAt: unknown; id: string }
    }
    expect(createArg.data.status).toBe('RECEIVED')
    expect(createArg.data.receivedAt).toBeInstanceOf(Date)
    // Flip atômico para PROCESSED dentro da tx.
    expect(txMock.stripeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    )
    // Não consulta findUnique externo (não houve P2002, lock OK).
    expect(prismaMock.stripeEvent.findUnique).not.toHaveBeenCalled()
    expect(emittedActions()).toContain(AuditAction.WEBHOOK_PROCESSED)
  })

  it('adquire advisory lock NÃO-bloqueante via pg_try_advisory_xact_lock', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})

    await processStripeEvent(makeUnhandledEvent(), asCtx(makeCtx()))

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// (2) P2002 + PROCESSED → duplicata
// ===========================================================================
describe('processStripeEvent — duplicata real (PROCESSED)', () => {
  it('P2002 no INSERT + status PROCESSED → duplicate sem rodar handler nem tx', async () => {
    prismaMock.stripeEvent.create.mockRejectedValue(makeP2002())
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ status: 'PROCESSED' })

    const outcome = await processStripeEvent(
      makeCheckoutEvent(),
      asCtx(makeCtx()),
    )

    expect(outcome).toBe('duplicate')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(txMock.token.create).not.toHaveBeenCalled()
    expect(emittedActions()).toContain(AuditAction.WEBHOOK_DUPLICATE)
    expect(emittedActions()).not.toContain(AuditAction.WEBHOOK_PROCESSED)
  })
})

// ===========================================================================
// (3) P2002 + RECEIVED → reprocessa (PROVA do fix — tentativa anterior falhou)
// ===========================================================================
describe('processStripeEvent — reprocessa RECEIVED órfão', () => {
  it('P2002 no INSERT + status RECEIVED → reprocessa e conclui PROCESSED', async () => {
    // Cenário do bug original: row gravada mas efeito nunca aconteceu. No retry,
    // o código antigo respondia "duplicate" e o cliente ficava sem token.
    prismaMock.stripeEvent.create.mockRejectedValue(makeP2002())
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ status: 'RECEIVED' })

    const ctx = makeCtx()
    const outcome = await processStripeEvent(makeUnhandledEvent(), asCtx(ctx))

    expect(outcome).toBe('processed')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(txMock.stripeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    )
    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt_unhandled_1' }),
      expect.stringContaining('reprocessando'),
    )
  })
})

// ===========================================================================
// (4) Lock não-adquirido + não-PROCESSED → throw 500
// ===========================================================================
describe('processStripeEvent — contention sem conclusão', () => {
  it('lock não-adquirido + ainda RECEIVED → throw (500 para redelivery)', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    txMock.$queryRaw.mockResolvedValue([{ locked: false }])
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ status: 'RECEIVED' })

    const ctx = makeCtx()
    await expect(
      processStripeEvent(makeUnhandledEvent(), asCtx(ctx)),
    ).rejects.toMatchObject({ statusCode: 500, code: 'WEBHOOK_FAILED' })

    // Nunca responde 200 para trabalho não confirmado (R-4).
    expect(txMock.stripeEvent.update).not.toHaveBeenCalled()
    expect(emittedActions()).not.toContain(AuditAction.WEBHOOK_PROCESSED)
    expect(ctx.log.warn).toHaveBeenCalled()
  })
})

// ===========================================================================
// (5) Lock não-adquirido + virou PROCESSED → duplicata
// ===========================================================================
describe('processStripeEvent — contention já concluída', () => {
  it('lock não-adquirido + status virou PROCESSED → duplicate (200)', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    txMock.$queryRaw.mockResolvedValue([{ locked: false }])
    // Holder concorrente concluiu entre o INSERT e a aquisição do lock.
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ status: 'PROCESSED' })

    const outcome = await processStripeEvent(
      makeUnhandledEvent(),
      asCtx(makeCtx()),
    )

    expect(outcome).toBe('duplicate')
    expect(emittedActions()).toContain(AuditAction.WEBHOOK_DUPLICATE)
    expect(txMock.stripeEvent.update).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// (6) Lock adquirido + double-check vê PROCESSED → duplicata
// ===========================================================================
describe('processStripeEvent — double-check dentro da tx', () => {
  it('lock adquirido mas status já PROCESSED → não roda handler, vira duplicate', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    txMock.$queryRaw.mockResolvedValue([{ locked: true }])
    // Concorrente virou PROCESSED entre nosso INSERT e a aquisição do lock.
    txMock.stripeEvent.findUnique.mockResolvedValue({ status: 'PROCESSED' })
    // Fora da tx (step 4), também PROCESSED.
    prismaMock.stripeEvent.findUnique.mockResolvedValue({ status: 'PROCESSED' })

    const outcome = await processStripeEvent(
      makeCheckoutEvent(),
      asCtx(makeCtx()),
    )

    expect(outcome).toBe('duplicate')
    expect(txMock.token.create).not.toHaveBeenCalled()
    expect(txMock.stripeEvent.update).not.toHaveBeenCalled()
    expect(emittedActions()).toContain(AuditAction.WEBHOOK_DUPLICATE)
  })
})

// ===========================================================================
// Invariante-âncora: side-effects SÓ pós-commit (R-2 / D-3)
// ===========================================================================
describe('processStripeEvent — side-effects pós-commit', () => {
  it('emails e audits NÃO rodam dentro da $transaction, só depois do commit', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    // Handler real de checkout: user novo + token novo → retorna email + audit.
    txMock.user.findUnique.mockResolvedValue(null)
    txMock.user.upsert.mockResolvedValue({
      id: 'user-1',
      email: 'buyer@test.com',
      role: 'PRO',
    })
    txMock.token.findFirst.mockResolvedValue(null)
    txMock.token.create.mockResolvedValue({ id: 'tok-1' })

    // Snapshot das chamadas no instante em que o callback da tx retorna
    // (ainda "dentro" do $transaction, antes do commit lógico).
    let emailsDuringTx = -1
    let auditsDuringTx = -1
    prismaMock.$transaction.mockImplementation(
      async (cb: (tx: typeof txMock) => unknown) => {
        const r = await cb(txMock)
        emailsDuringTx = vi.mocked(sendTokenEmail).mock.calls.length
        auditsDuringTx = emitAuditEventMock.mock.calls.length
        return r
      },
    )

    const outcome = await processStripeEvent(
      makeCheckoutEvent(),
      asCtx(makeCtx()),
    )

    expect(outcome).toBe('processed')
    // Durante a tx: zero I/O externo / zero auditoria.
    expect(emailsDuringTx).toBe(0)
    expect(auditsDuringTx).toBe(0)
    // Pós-commit: email enviado + audits emitidos.
    expect(sendTokenEmail).toHaveBeenCalledTimes(1)
    const actions = emittedActions()
    expect(actions).toContain(AuditAction.ACCOUNT_CREATED)
    expect(actions).toContain(AuditAction.WEBHOOK_PROCESSED)
  })

  it('falha de email pós-commit é LOGADA (não engolida em silêncio) sem afetar o outcome', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    txMock.user.findUnique.mockResolvedValue(null)
    txMock.user.upsert.mockResolvedValue({
      id: 'user-1',
      email: 'buyer@test.com',
      role: 'PRO',
    })
    txMock.token.findFirst.mockResolvedValue(null)
    txMock.token.create.mockResolvedValue({ id: 'tok-1' })
    vi.mocked(sendTokenEmail).mockRejectedValueOnce(new Error('Resend down'))

    const ctx = makeCtx()
    const outcome = await processStripeEvent(makeCheckoutEvent(), asCtx(ctx))

    // Webhook NÃO falha por causa do email — estado PROCESSED já é durável.
    expect(outcome).toBe('processed')
    expect(emittedActions()).toContain(AuditAction.WEBHOOK_PROCESSED)
    // Mas a falha NÃO é silenciosa: logada com contexto (irmão do CRÍTICO #189
    // — "token no DB mas email não entregue" precisa ser visível ao oncall).
    expect(ctx.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'evt_checkout_1',
        eventType: 'checkout.session.completed',
        err: expect.any(Error),
      }),
      expect.stringContaining('falha ao enviar email'),
    )
  })
})

// ===========================================================================
// Propagação de erros transitórios
// ===========================================================================
describe('processStripeEvent — erros transitórios', () => {
  it('erro não-P2002 no INSERT propaga (sem tocar a transação)', async () => {
    prismaMock.stripeEvent.create.mockRejectedValue(
      new Error('Connection lost'),
    )

    await expect(
      processStripeEvent(makeUnhandledEvent(), asCtx(makeCtx())),
    ).rejects.toThrow('Connection lost')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('erro do handler dentro da tx propaga (rollback → status fica RECEIVED)', async () => {
    prismaMock.stripeEvent.create.mockResolvedValue({})
    // Handler de checkout falha: user não resolvido na upsert.
    txMock.user.findUnique.mockResolvedValue(null)
    txMock.user.upsert.mockRejectedValue(new Error('deadlock detected'))

    await expect(
      processStripeEvent(makeCheckoutEvent(), asCtx(makeCtx())),
    ).rejects.toThrow('deadlock detected')
    // Nunca marcou PROCESSED nem emitiu sucesso.
    expect(txMock.stripeEvent.update).not.toHaveBeenCalled()
    expect(emittedActions()).not.toContain(AuditAction.WEBHOOK_PROCESSED)
  })
})
