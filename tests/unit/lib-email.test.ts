/**
 * Unit tests for src/lib/email.ts (Card 3.2 #31 — checklist item 3).
 *
 * Cobre os 3 senders (sendTokenEmail, sendCancellationEmail,
 * sendPaymentFailedEmail) com foco em:
 *   - Resend.emails.send é chamado com args corretos (from, to, subject, html, text)
 *   - Branches dos templates (expiresAt: Date vs null em sendCancellationEmail)
 *   - Conteúdo dos templates contém os dinâmicos esperados (token, data formatada)
 *   - Erros do client viram Errors.internal (sem vazar stack)
 *   - getResend lança quando RESEND_API_KEY não está configurada
 *
 * Não confundir com tests/unit/email-service.test.ts que pode testar
 * outra superfície. Este é dedicado exclusivamente a `src/lib/email.ts`
 * e resolve o finding F4 do @tester no Card #31 (coverage emprestada).
 *
 * @owner: @tester
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock do env ANTES do import do módulo
vi.mock('../../src/config/env', () => ({
  env: {
    RESEND_API_KEY: 're_test_fake_key_abc123',
    FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
    FRONTEND_URL: 'https://tablix.com.br',
  },
}))

// Mock do pacote resend — capturamos a chamada a emails.send.
// vi.hoisted é obrigatório porque vi.mock é hoisted pra cima dos imports;
// sem isso, `sendMock` seria "Cannot access before initialization".
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}))

// Import APÓS mocks para garantir que Resend() é construído com o mock.
// ESLint `import/first` ignorado intencionalmente: vi.mock é hoisted em
// runtime; mover os imports pra cima quebra a ordem real de inicialização.
/* eslint-disable import/first */
import {
  sendTokenEmail,
  sendCancellationEmail,
  sendPaymentFailedEmail,
} from '../../src/lib/email'
import { AppError } from '../../src/errors/app-error'
/* eslint-enable import/first */

describe('sendTokenEmail', () => {
  beforeEach(() => {
    sendMock.mockReset()
    sendMock.mockResolvedValue({ data: { id: 'em_abc' }, error: null })
  })

  afterEach(() => {
    sendMock.mockReset()
  })

  it('chama Resend.emails.send com from/to/subject corretos', async () => {
    await sendTokenEmail({ to: 'user@example.com', token: 'tbx_pro_xyz' })
    expect(sendMock).toHaveBeenCalledTimes(1)
    const call = sendMock.mock.calls[0][0]
    expect(call.from).toBe('Tablix <noreply@tablix.com.br>')
    expect(call.to).toBe('user@example.com')
    expect(call.subject).toBe('Seu token Pro do Tablix')
  })

  it('payload html contém o token renderizado', async () => {
    await sendTokenEmail({ to: 'user@example.com', token: 'tbx_pro_TOKEN123' })
    const { html } = sendMock.mock.calls[0][0]
    expect(html).toContain('tbx_pro_TOKEN123')
    expect(html).toContain('<code')
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('payload text (fallback plain) contém o token e a URL do frontend', async () => {
    await sendTokenEmail({ to: 'user@example.com', token: 'tbx_pro_ABC' })
    const { text } = sendMock.mock.calls[0][0]
    expect(text).toContain('tbx_pro_ABC')
    expect(text).toContain('https://tablix.com.br')
    expect(text).not.toContain('<')
  })

  it('lança AppError INTERNAL quando Resend retorna error', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', message: 'invalid to' },
    })
    await expect(
      sendTokenEmail({ to: 'invalid', token: 'tbx_pro_x' }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('mensagem do AppError é genérica (não vaza detalhes do Resend)', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', message: 'SECRETLEAK xyz' },
    })
    try {
      await sendTokenEmail({ to: 'x', token: 'y' })
    } catch (err) {
      const appErr = err as AppError
      expect(appErr.message).toBe('Erro ao enviar email')
      expect(appErr.message).not.toContain('SECRETLEAK')
    }
  })
})

describe('sendCancellationEmail', () => {
  beforeEach(() => {
    sendMock.mockReset()
    sendMock.mockResolvedValue({ data: { id: 'em_cancel' }, error: null })
  })

  afterEach(() => {
    sendMock.mockReset()
  })

  it('expiresAt=null: template usa "Seu acesso foi encerrado"', async () => {
    await sendCancellationEmail({ to: 'user@example.com', expiresAt: null })
    const { html, text } = sendMock.mock.calls[0][0]
    expect(html).toContain('Seu acesso foi encerrado')
    expect(text).toContain('Seu acesso foi encerrado')
    expect(html).not.toContain('ainda tera acesso ate')
  })

  it('expiresAt=Date: template formata data em pt-BR e cita "ainda tera acesso"', async () => {
    const date = new Date('2026-05-15T00:00:00Z')
    await sendCancellationEmail({ to: 'user@example.com', expiresAt: date })
    const { html, text } = sendMock.mock.calls[0][0]
    // toLocaleDateString('pt-BR') gera DD/MM/YYYY em locale pt-BR
    const expectedDate = date.toLocaleDateString('pt-BR')
    expect(html).toContain(expectedDate)
    expect(html).toContain('ainda tera acesso ate')
    expect(text).toContain(expectedDate)
    expect(html).not.toContain('Seu acesso foi encerrado')
  })

  it('subject e from corretos', async () => {
    await sendCancellationEmail({ to: 'user@example.com', expiresAt: null })
    const call = sendMock.mock.calls[0][0]
    expect(call.subject).toBe('Sua assinatura Tablix Pro foi cancelada')
    expect(call.from).toBe('Tablix <noreply@tablix.com.br>')
  })

  it('lança AppError INTERNAL com mensagem genérica quando Resend falha', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: 'rate_limit', message: 'too many requests' },
    })
    try {
      await sendCancellationEmail({ to: 'x', expiresAt: null })
      expect.unreachable('deveria ter lançado AppError')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).message).toBe('Erro ao enviar email')
    }
  })
})

describe('sendPaymentFailedEmail', () => {
  beforeEach(() => {
    sendMock.mockReset()
    sendMock.mockResolvedValue({ data: { id: 'em_fail' }, error: null })
  })

  afterEach(() => {
    sendMock.mockReset()
  })

  it('subject indica problema de pagamento', async () => {
    await sendPaymentFailedEmail({ to: 'user@example.com' })
    const { subject } = sendMock.mock.calls[0][0]
    expect(subject).toBe('Problema com seu pagamento - Tablix Pro')
  })

  it('html contém CTA de "Atualizar forma de pagamento" com link para FRONTEND_URL', async () => {
    await sendPaymentFailedEmail({ to: 'user@example.com' })
    const { html } = sendMock.mock.calls[0][0]
    expect(html).toContain('Atualizar forma de pagamento')
    expect(html).toContain('https://tablix.com.br')
    expect(html).toContain('<a ')
  })

  it('text (plain) contém URL e não tem HTML', async () => {
    await sendPaymentFailedEmail({ to: 'user@example.com' })
    const { text } = sendMock.mock.calls[0][0]
    expect(text).toContain('https://tablix.com.br')
    expect(text).not.toContain('<')
  })

  it('lança AppError INTERNAL quando Resend falha', async () => {
    sendMock.mockResolvedValueOnce({
      data: null,
      error: { name: 'auth_error', message: 'invalid key' },
    })
    await expect(
      sendPaymentFailedEmail({ to: 'user@example.com' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

// =============================================
// getResend — branch sem RESEND_API_KEY
// =============================================
describe('getResend — env sem RESEND_API_KEY', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../../src/config/env')
  })

  // Nota técnica: depois de vi.resetModules(), AppError é re-importado numa
  // nova identidade de classe. `toBeInstanceOf(AppError)` falha porque a
  // classe do topo do arquivo e a classe re-importada são refs distintas.
  // Asserimos por shape (código + statusCode + name) em vez de identidade.
  async function expectAppErrorShape(p: Promise<unknown>): Promise<void> {
    await expect(p).rejects.toMatchObject({
      name: 'AppError',
      statusCode: 500,
    })
  }

  it('sendTokenEmail lança AppError quando RESEND_API_KEY não está configurada', async () => {
    vi.resetModules()
    vi.doMock('../../src/config/env', () => ({
      env: {
        RESEND_API_KEY: undefined, // ← força resend === null
        FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
        FRONTEND_URL: 'https://tablix.com.br',
      },
    }))
    // Re-import APÓS mock atualizado
    const mod = await import('../../src/lib/email')
    await expectAppErrorShape(
      mod.sendTokenEmail({ to: 'user@example.com', token: 'tbx_pro_x' }),
    )
  })

  it('sendCancellationEmail também lança sem RESEND_API_KEY', async () => {
    vi.resetModules()
    vi.doMock('../../src/config/env', () => ({
      env: {
        RESEND_API_KEY: undefined,
        FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
        FRONTEND_URL: 'https://tablix.com.br',
      },
    }))
    const mod = await import('../../src/lib/email')
    await expectAppErrorShape(
      mod.sendCancellationEmail({ to: 'user@example.com', expiresAt: null }),
    )
  })

  it('sendPaymentFailedEmail também lança sem RESEND_API_KEY', async () => {
    vi.resetModules()
    vi.doMock('../../src/config/env', () => ({
      env: {
        RESEND_API_KEY: undefined,
        FROM_EMAIL: 'Tablix <noreply@tablix.com.br>',
        FRONTEND_URL: 'https://tablix.com.br',
      },
    }))
    const mod = await import('../../src/lib/email')
    await expectAppErrorShape(
      mod.sendPaymentFailedEmail({ to: 'user@example.com' }),
    )
  })
})
