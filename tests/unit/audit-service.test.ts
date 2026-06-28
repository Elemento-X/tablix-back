/**
 * Unit tests para src/lib/audit/audit.service.ts (Card 2.4).
 *
 * Cobre:
 *   - emitAuditEvent: fire-and-forget (retorna void), nunca lança
 *   - Triple redundância: Prisma create + Sentry breadcrumb + pino log
 *   - Truncate defensivo em actor/ip/userAgent (COLUMN_LIMITS)
 *   - prepareMetadata: scrubObject aplicado, cap 4KB, placeholder
 *   - Breadcrumb level: info quando success, warning quando falha
 *   - Persist fail-handling: error log + Sentry error breadcrumb, nunca throw
 *   - Sentry.addBreadcrumb em try/catch (sem DSN não explode)
 *   - Todas as 11 AuditAction passam pelo serviço
 *
 * Estratégia: mocka prisma.auditLog.create, Sentry.addBreadcrumb e logger
 * pra não depender de infra real. scrubObject real é reusado (sub-dep do
 * sentry.ts) — garantia de SSOT com REDACT_PATHS.
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// SUT + tipos. Importamos aqui no topo porque `vi.mock` é auto-hoistado
// pelo Vitest (as declarações abaixo correm ANTES destes imports em runtime).
// eslint-disable-next-line import/order
import { emitAuditEvent, __testing } from '../../src/lib/audit/audit.service'
// eslint-disable-next-line import/order
import { AuditAction } from '../../src/lib/audit/audit.types'

// Mock do env ANTES de importar módulos que dependem dele.
vi.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SENTRY_DSN: '',
    SENTRY_ENVIRONMENT: 'test',
    SENTRY_RELEASE: '',
    SENTRY_TRACES_SAMPLE_RATE: 0,
    SENTRY_PROFILES_SAMPLE_RATE: 0,
    LOG_LEVEL: 'silent',
  },
}))

// Mock do Sentry SDK — addBreadcrumb é a API usada pelo audit service.
const addBreadcrumbMock = vi.fn()
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: (...args: unknown[]) => addBreadcrumbMock(...args),
}))
vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({ name: 'ProfilingIntegration' }),
}))

// Mock do Prisma — interessa só o auditLog.create.
const auditLogCreateMock = vi.fn()
vi.mock('../../src/lib/prisma', () => ({
  prisma: {
    auditLog: {
      create: (...args: unknown[]) => auditLogCreateMock(...args),
    },
  },
}))

// Mock do logger — capturar calls de info/error.
const loggerInfoMock = vi.fn()
const loggerErrorMock = vi.fn()
vi.mock('../../src/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => loggerInfoMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

const {
  prepareMetadata,
  truncateString,
  stripCrlf,
  sanitizeIp,
  METADATA_MAX_BYTES,
  COLUMN_LIMITS,
} = __testing

// Card #223 (decisão #218 / WV-2026-010): `prepareMetadata` carimba a origem do
// ambiente (`env`) em TODO metadata, vindo de `env.SENTRY_ENVIRONMENT`. Aqui o
// `vi.mock('../../src/config/env')` acima fixa `SENTRY_ENVIRONMENT: 'test'`,
// então o valor carimbado é determinístico e igual a 'test'. Centralizado pra
// evitar hardcode espalhado — se o mock mudar, muda só aqui.
const ENV_TAG = 'test'

beforeEach(() => {
  addBreadcrumbMock.mockReset()
  auditLogCreateMock.mockReset()
  auditLogCreateMock.mockResolvedValue(undefined)
  loggerInfoMock.mockReset()
  loggerErrorMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

/**
 * Aguarda o término do fire-and-forget do emitAuditEvent. A função dispara
 * `persist().then()/catch()` em background; aqui esperamos até o Prisma.create
 * resolver OU o logger.error ser chamado (caminho de falha). Usa `vi.waitFor`
 * pra ser determinístico — polling com timeout em vez de contar microtasks.
 *
 * Drop-in replacement de `flushMicrotasks()`: todas as asserções subsequentes
 * continuam válidas porque entramos após o background terminar.
 */
async function waitForPersist({
  timeout = 1000,
  interval = 2,
} = {}): Promise<void> {
  await vi.waitFor(
    () => {
      const settled =
        auditLogCreateMock.mock.calls.length > 0 ||
        loggerErrorMock.mock.calls.length > 0
      if (!settled) throw new Error('audit persist pending')
    },
    { timeout, interval },
  )
}

describe('truncateString', () => {
  it('retorna null para null/undefined', () => {
    expect(truncateString(null, 10)).toBe(null)
    expect(truncateString(undefined, 10)).toBe(null)
  })

  it('retorna string intacta quando cabe', () => {
    expect(truncateString('abc', 10)).toBe('abc')
  })

  it('trunca quando excede max', () => {
    expect(truncateString('abcdefghij', 5)).toBe('abcde')
  })

  it('retorna string vazia intacta', () => {
    expect(truncateString('', 10)).toBe('')
  })

  it('boundary: length igual ao max não trunca', () => {
    expect(truncateString('abcde', 5)).toBe('abcde')
  })

  it('strip CRLF antes do truncate', () => {
    expect(truncateString('ab\r\ncd\0ef', 10)).toBe('abcdef')
  })
})

describe('stripCrlf', () => {
  it('remove CR, LF e NUL', () => {
    expect(stripCrlf('a\rb\nc\0d')).toBe('abcd')
  })

  it('retorna string sem CRLF inalterada', () => {
    expect(stripCrlf('abc')).toBe('abc')
  })

  it('retorna vazia quando só tem CRLF', () => {
    expect(stripCrlf('\r\n\0')).toBe('')
  })
})

describe('sanitizeIp', () => {
  it('aceita IPv4 válido', () => {
    expect(sanitizeIp('192.168.0.1')).toBe('192.168.0.1')
    expect(sanitizeIp('10.0.0.1')).toBe('10.0.0.1')
  })

  it('aceita IPv6 válido', () => {
    expect(sanitizeIp('::1')).toBe('::1')
    expect(sanitizeIp('2001:db8::1')).toBe('2001:db8::1')
  })

  it('retorna null para IP inválido', () => {
    expect(sanitizeIp('999.999.999.999')).toBe(null)
    expect(sanitizeIp('not-an-ip')).toBe(null)
    expect(sanitizeIp('192.168.0')).toBe(null)
  })

  it('retorna null para null/undefined/vazio', () => {
    expect(sanitizeIp(null)).toBe(null)
    expect(sanitizeIp(undefined)).toBe(null)
    expect(sanitizeIp('')).toBe(null)
  })

  it('strip CRLF antes de validar — log injection', () => {
    // Atacante injeta "\r\nInjected-Log" esperando que passe. Após strip vira
    // "192.168.0.1Injected-Log", que é inválido → retorna null.
    expect(sanitizeIp('192.168.0.1\r\nInjected')).toBe(null)
    // Mas se o strip deixa IP válido, mantém
    expect(sanitizeIp('192.168.0.1\n')).toBe('192.168.0.1')
  })
})

describe('prepareMetadata', () => {
  it('retorna objeto só com env quando input é undefined (#223)', () => {
    // Antes do #223 retornava undefined. Agora SEMPRE retorna objeto carimbado
    // com a origem do ambiente — base da identificação/purga de dados staging.
    expect(prepareMetadata(undefined)).toEqual({ env: ENV_TAG })
  })

  it('passa objeto pequeno inalterado + carimba env (#223)', () => {
    const out = prepareMetadata({ foo: 'bar', count: 42 })
    expect(out).toEqual({ foo: 'bar', count: 42, env: ENV_TAG })
  })

  it('aplica scrubObject — redacta campo sensível', () => {
    // password está em REDACT_PATHS via wildcard → scrubObject redacta
    const out = prepareMetadata({ password: 'hunter2', user: 'bob' }) as Record<
      string,
      unknown
    >
    expect(out.password).toBe('[REDACTED]')
    expect(out.user).toBe('bob')
  })

  it('redacta campo aninhado sensível', () => {
    const out = prepareMetadata({
      nested: { authorization: 'Bearer xxx', ok: true },
    }) as { nested: Record<string, unknown> }
    expect(out.nested.authorization).toBe('[REDACTED]')
    expect(out.nested.ok).toBe(true)
  })

  it('substitui por placeholder quando > 4KB', () => {
    // Gera string que serializada excede o cap
    const big = 'x'.repeat(METADATA_MAX_BYTES + 100)
    const out = prepareMetadata({ blob: big }) as Record<string, unknown>
    expect(out._truncated).toBe(true)
    expect(out._limitBytes).toBe(METADATA_MAX_BYTES)
    expect(typeof out._originalBytes).toBe('number')
    expect(out._originalBytes as number).toBeGreaterThan(METADATA_MAX_BYTES)
    // Não persiste o conteúdo original
    expect(out.blob).toBeUndefined()
  })

  it('boundary: exatamente no limite passa sem placeholder', () => {
    // #223: o objeto serializado agora inclui o env tag, então o overhead é o de
    // {"k":"","env":"<valor>"}. Calcula o payload que deixa o total no limite.
    const overhead = JSON.stringify({ k: '', env: ENV_TAG }).length
    const payload = 'a'.repeat(METADATA_MAX_BYTES - overhead)
    const out = prepareMetadata({ k: payload }) as Record<string, unknown>
    expect(JSON.stringify(out).length).toBe(METADATA_MAX_BYTES)
    expect(out._truncated).toBeUndefined()
    expect(out.k).toBe(payload)
    expect(out.env).toBe(ENV_TAG)
  })
})

describe('prepareMetadata — Card #223 env stamp', () => {
  it('carimba env mesmo sem metadata do caller', () => {
    expect(prepareMetadata(undefined)).toEqual({ env: ENV_TAG })
  })

  it('env é autoritativo — caller não sobrescreve (anti-forja)', () => {
    // Atacante/caller bugado tenta forjar a origem passando env próprio.
    // O tag autoritativo é aplicado POR ÚLTIMO no spread → vence sempre.
    const out = prepareMetadata({
      env: 'forjado-pelo-caller',
      foo: 'bar',
    }) as Record<string, unknown>
    expect(out.env).toBe(ENV_TAG)
    expect(out.foo).toBe('bar')
  })

  it('scrub do caller + carimbo de env coexistem', () => {
    // PII/secret do caller continua redactado (defesa em profundidade) e o env
    // é carimbado no mesmo objeto.
    const out = prepareMetadata({
      password: 'hunter2',
      user: 'bob',
    }) as Record<string, unknown>
    expect(out.password).toBe('[REDACTED]')
    expect(out.user).toBe('bob')
    expect(out.env).toBe(ENV_TAG)
  })

  it('truncamento preserva env — evento permanece purgável', () => {
    // O placeholder de truncamento é o caminho mais crítico pro #223: sem env
    // aqui, dados grandes de origem staging ficariam órfãos e não-purgáveis.
    const big = 'x'.repeat(METADATA_MAX_BYTES + 500)
    const out = prepareMetadata({ blob: big }) as Record<string, unknown>
    expect(out._truncated).toBe(true)
    expect(out.env).toBe(ENV_TAG)
    expect(out.blob).toBeUndefined()
  })

  it('truncamento ignora env forjado pelo caller', () => {
    // Mesmo no caminho de truncamento, o env é hardcoded da fonte autoritativa,
    // não derivado do metadata do caller.
    const big = 'x'.repeat(METADATA_MAX_BYTES + 500)
    const out = prepareMetadata({ blob: big, env: 'forjado' }) as Record<
      string,
      unknown
    >
    expect(out._truncated).toBe(true)
    expect(out.env).toBe(ENV_TAG)
  })
})

describe('emitAuditEvent — fire-and-forget', () => {
  it('retorna void (não Promise) — força não-await', () => {
    const result = emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
    })
    expect(result).toBeUndefined()
  })

  it('não lança mesmo com persist rejeitando', async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error('db down'))
    expect(() =>
      emitAuditEvent({
        action: AuditAction.LOGOUT,
        actor: 'user-1',
        success: true,
      }),
    ).not.toThrow()
    await waitForPersist()
    // Falha foi logada como error
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    const errCall = loggerErrorMock.mock.calls[0]
    expect((errCall[0] as Record<string, unknown>).audit).toBe(true)
    expect(errCall[1]).toBe('audit.persist_failed')
  })

  it('não lança mesmo quando Sentry.addBreadcrumb throw (não inicializado)', () => {
    addBreadcrumbMock.mockImplementationOnce(() => {
      throw new Error('not initialized')
    })
    expect(() =>
      emitAuditEvent({
        action: AuditAction.TOKEN_VALIDATE_SUCCESS,
        actor: 'user-1',
        success: true,
      }),
    ).not.toThrow()
  })
})

describe('emitAuditEvent — camada Prisma', () => {
  it('persiste evento com todos os campos', async () => {
    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_SUCCESS,
      actor: 'user-42',
      ip: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      success: true,
      metadata: { tokenId: 'tok-xyz' },
    })
    await waitForPersist()
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1)
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(call.data.action).toBe('TOKEN_VALIDATE_SUCCESS')
    expect(call.data.actor).toBe('user-42')
    expect(call.data.ip).toBe('10.0.0.1')
    expect(call.data.userAgent).toBe('Mozilla/5.0')
    expect(call.data.success).toBe(true)
    // #223: metadata do caller + env carimbado.
    expect(call.data.metadata).toEqual({ tokenId: 'tok-xyz', env: ENV_TAG })
  })

  it('persiste null em actor/ip/userAgent quando ausentes', async () => {
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: null,
      success: false,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(call.data.actor).toBe(null)
    expect(call.data.ip).toBe(null)
    expect(call.data.userAgent).toBe(null)
  })

  it('persiste metadata só com env quando caller não fornece (#223)', async () => {
    // Antes do #223 persistia undefined. Agora SEMPRE persiste o env tag — é o
    // que torna o evento identificável/purgável no audit_log compartilhado.
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(call.data.metadata).toEqual({ env: ENV_TAG })
  })

  it('trunca actor > 255 chars (COLUMN_LIMITS.actor)', async () => {
    const longActor = 'a'.repeat(300)
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: longActor,
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { actor: string }
    }
    expect(call.data.actor).toHaveLength(COLUMN_LIMITS.actor)
  })

  it('grava null quando IP é inválido (sanitizeIp gate)', async () => {
    const longIp = '1'.repeat(100) // não é IP válido
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      ip: longIp,
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { ip: string | null }
    }
    expect(call.data.ip).toBe(null)
  })

  it('grava IPv4 válido intacto', async () => {
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      ip: '192.168.1.1',
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { ip: string | null }
    }
    expect(call.data.ip).toBe('192.168.1.1')
  })

  it('grava IPv6 válido intacto (cabe em COLUMN_LIMITS.ip)', async () => {
    const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
    expect(ipv6.length).toBeLessThanOrEqual(COLUMN_LIMITS.ip)
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      ip: ipv6,
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { ip: string | null }
    }
    expect(call.data.ip).toBe(ipv6)
  })

  it('trunca userAgent > 512 chars (COLUMN_LIMITS.userAgent)', async () => {
    const longUa = 'u'.repeat(1000)
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      userAgent: longUa,
      success: true,
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { userAgent: string }
    }
    expect(call.data.userAgent).toHaveLength(COLUMN_LIMITS.userAgent)
  })

  it('aplica scrubObject em metadata antes de persistir', async () => {
    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_FAILURE,
      actor: null,
      success: false,
      metadata: { token: 'secret-leak', reason: 'invalidToken' },
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> }
    }
    expect(call.data.metadata.token).toBe('[REDACTED]')
    expect(call.data.metadata.reason).toBe('invalidToken')
  })

  it('substitui metadata grande por placeholder', async () => {
    const big = 'x'.repeat(METADATA_MAX_BYTES + 500)
    emitAuditEvent({
      action: AuditAction.WEBHOOK_PROCESSED,
      actor: 'stripe',
      success: true,
      metadata: { payload: big },
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> }
    }
    expect(call.data.metadata._truncated).toBe(true)
    expect(call.data.metadata._limitBytes).toBe(METADATA_MAX_BYTES)
  })
})

describe('emitAuditEvent — camada Sentry breadcrumb', () => {
  it('adiciona breadcrumb com level info quando success=true', () => {
    emitAuditEvent({
      action: AuditAction.SESSION_REFRESH,
      actor: 'user-1',
      success: true,
    })
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(1)
    const crumb = addBreadcrumbMock.mock.calls[0][0] as Record<string, unknown>
    expect(crumb.category).toBe('audit')
    expect(crumb.level).toBe('info')
    expect(crumb.message).toBe('SESSION_REFRESH')
    expect((crumb.data as Record<string, unknown>).actor).toBe('user-1')
    expect((crumb.data as Record<string, unknown>).success).toBe(true)
  })

  it('adiciona breadcrumb com level warning quando success=false', () => {
    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_FAILURE,
      actor: null,
      success: false,
    })
    const crumb = addBreadcrumbMock.mock.calls[0][0] as Record<string, unknown>
    expect(crumb.level).toBe('warning')
  })

  it('inclui metadata no breadcrumb quando presente', () => {
    emitAuditEvent({
      action: AuditAction.PAYMENT_FAILED,
      actor: 'user-1',
      success: false,
      metadata: { invoiceId: 'inv_123' },
    })
    const crumb = addBreadcrumbMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(crumb.data.metadata).toEqual({ invoiceId: 'inv_123', env: ENV_TAG })
  })

  it('inclui metadata só com env no breadcrumb quando caller não passa (#223)', () => {
    // Antes do #223 a chave metadata era omitida do breadcrumb. Agora sempre
    // presente carregando o env tag — origem rastreável na timeline do Sentry.
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
    })
    const crumb = addBreadcrumbMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(crumb.data.metadata).toEqual({ env: ENV_TAG })
  })
})

describe('emitAuditEvent — camada pino log', () => {
  it('emite logger.info com estrutura canônica', () => {
    emitAuditEvent({
      action: AuditAction.FINGERPRINT_BOUND,
      actor: 'user-1',
      ip: '10.0.0.1',
      userAgent: 'ua/1.0',
      success: true,
      metadata: { tokenId: 't1' },
    })
    expect(loggerInfoMock).toHaveBeenCalledTimes(1)
    const [payload, msg] = loggerInfoMock.mock.calls[0]
    expect(msg).toBe('audit_event')
    const obj = payload as Record<string, unknown>
    expect(obj.audit).toBe(true)
    expect(obj.action).toBe('FINGERPRINT_BOUND')
    expect(obj.actor).toBe('user-1')
    expect(obj.success).toBe(true)
    expect(obj.metadata).toEqual({ tokenId: 't1', env: ENV_TAG })
  })

  it('inclui metadata só com env no log quando caller não passa (#223)', () => {
    // Antes do #223 a chave metadata era omitida do log. Agora sempre presente
    // com o env tag — origem rastreável no log aggregator (Logtail/Datadog).
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
    })
    const [payload] = loggerInfoMock.mock.calls[0]
    expect((payload as Record<string, unknown>).metadata).toEqual({
      env: ENV_TAG,
    })
  })

  it('log reflete success=false em evento de falha', () => {
    emitAuditEvent({
      action: AuditAction.WEBHOOK_SIGNATURE_FAILED,
      actor: 'stripe',
      success: false,
      metadata: { signaturePresent: true },
    })
    const [payload] = loggerInfoMock.mock.calls[0]
    const obj = payload as Record<string, unknown>
    expect(obj.success).toBe(false)
    expect(obj.action).toBe('WEBHOOK_SIGNATURE_FAILED')
  })
})

describe('emitAuditEvent — Card #223 env stamp end-to-end', () => {
  it('as 3 camadas carregam env mesmo sem metadata do caller', async () => {
    // Garante consistência do tag nas três cópias forenses (Prisma, breadcrumb,
    // pino) — sem isso, uma camada poderia perder a origem e quebrar a purga.
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
    })
    // breadcrumb + pino são síncronos
    const crumb = addBreadcrumbMock.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(crumb.data.metadata).toEqual({ env: ENV_TAG })
    const [logPayload] = loggerInfoMock.mock.calls[0]
    expect((logPayload as Record<string, unknown>).metadata).toEqual({
      env: ENV_TAG,
    })
    // Prisma persist é fire-and-forget
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { metadata: unknown }
    }
    expect(call.data.metadata).toEqual({ env: ENV_TAG })
  })

  it('caller forjando env não vence em nenhuma camada', async () => {
    emitAuditEvent({
      action: AuditAction.LOGOUT,
      actor: 'user-1',
      success: true,
      metadata: { env: 'forjado', k: 'v' },
    })
    const crumb = addBreadcrumbMock.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> }
    }
    expect(crumb.data.metadata.env).toBe(ENV_TAG)
    expect(crumb.data.metadata.k).toBe('v')
    const [logPayload] = loggerInfoMock.mock.calls[0]
    const logMeta = (logPayload as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >
    expect(logMeta.env).toBe(ENV_TAG)
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> }
    }
    expect(call.data.metadata.env).toBe(ENV_TAG)
    expect(call.data.metadata.k).toBe('v')
  })

  it('secret do caller redactado e env carimbado na mesma persistência', async () => {
    emitAuditEvent({
      action: AuditAction.TOKEN_VALIDATE_FAILURE,
      actor: null,
      success: false,
      metadata: { token: 'secret-leak', reason: 'invalidToken' },
    })
    await waitForPersist()
    const call = auditLogCreateMock.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> }
    }
    expect(call.data.metadata.token).toBe('[REDACTED]')
    expect(call.data.metadata.reason).toBe('invalidToken')
    expect(call.data.metadata.env).toBe(ENV_TAG)
  })
})

describe('emitAuditEvent — falha de persistência', () => {
  it('logger.error registra falha + action + actor + success', async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error('connection refused'))
    emitAuditEvent({
      action: AuditAction.WEBHOOK_DUPLICATE,
      actor: 'stripe',
      success: true,
      metadata: { eventId: 'evt_1' },
    })
    await waitForPersist()
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
    const [payload, msg] = loggerErrorMock.mock.calls[0]
    expect(msg).toBe('audit.persist_failed')
    const obj = payload as Record<string, unknown>
    expect(obj.audit).toBe(true)
    expect(obj.action).toBe('WEBHOOK_DUPLICATE')
    expect(obj.actor).toBe('stripe')
    expect(obj.success).toBe(true)
    expect(obj.err).toBeInstanceOf(Error)
  })

  it('Sentry recebe breadcrumb de erro quando persist falha', async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error('db down'))
    emitAuditEvent({
      action: AuditAction.PAYMENT_FAILED,
      actor: 'user-1',
      success: false,
    })
    await waitForPersist()
    // Primeiro breadcrumb foi o info/warning da emissão; segundo é do erro
    expect(addBreadcrumbMock).toHaveBeenCalledTimes(2)
    const errorCrumb = addBreadcrumbMock.mock.calls[1][0] as Record<
      string,
      unknown
    >
    expect(errorCrumb.category).toBe('audit')
    expect(errorCrumb.level).toBe('error')
    expect(errorCrumb.message).toBe('audit.persist_failed')
  })

  it('Sentry.addBreadcrumb no catch não propaga erro quando throw (noop)', async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error('db down'))
    // Primeira chamada (emissão) ok; segunda (error crumb) throw
    addBreadcrumbMock
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('sentry offline')
      })
    expect(() =>
      emitAuditEvent({
        action: AuditAction.LOGOUT_ALL,
        actor: 'user-1',
        success: true,
      }),
    ).not.toThrow()
    await waitForPersist()
    // logger.error ainda deve ter sido chamado
    expect(loggerErrorMock).toHaveBeenCalledTimes(1)
  })
})

describe('emitAuditEvent — cobertura dos 15 AuditAction', () => {
  const allActions = Object.values(AuditAction)

  it('tem exatamente 15 eventos (11 iniciais + FINGERPRINT_MISMATCH + ACCOUNT_CREATED + ROLE_CHANGED + PROCESS_DOWNLOAD)', () => {
    expect(allActions).toHaveLength(15)
  })

  for (const action of Object.values(AuditAction)) {
    it(`aceita e propaga action=${action}`, async () => {
      emitAuditEvent({
        action,
        actor: 'actor-x',
        success: true,
      })
      await waitForPersist()
      const call = auditLogCreateMock.mock.calls[0][0] as {
        data: { action: string }
      }
      expect(call.data.action).toBe(action)
    })
  }
})

describe('contrato COLUMN_LIMITS', () => {
  it('actor=255, ip=45 (IPv6 max), userAgent=512', () => {
    expect(COLUMN_LIMITS.actor).toBe(255)
    expect(COLUMN_LIMITS.ip).toBe(45)
    expect(COLUMN_LIMITS.userAgent).toBe(512)
  })
})

describe('contrato METADATA_MAX_BYTES', () => {
  it('é 1024 (cabe inline abaixo do TOAST_TUPLE_THRESHOLD real de ~2032 bytes)', () => {
    expect(METADATA_MAX_BYTES).toBe(1024)
  })
})
