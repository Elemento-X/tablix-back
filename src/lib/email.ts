import { Resend } from 'resend'
import { env } from '../config/env'
import { Errors } from '../errors/app-error'

// Inicializa Resend apenas se a chave estiver configurada
const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

function getResend(): Resend {
  if (!resend) {
    throw Errors.internal()
  }
  return resend
}

// Remetente padrão (configurado via env, deve ser um domínio verificado no Resend)
const FROM_EMAIL = env.FROM_EMAIL

export interface SendTokenEmailParams {
  to: string
  token: string
}

export interface SendCancellationEmailParams {
  to: string
  expiresAt: Date | null
}

export interface SendPaymentFailedEmailParams {
  to: string
}

/**
 * Envia email com o token Pro para o cliente
 */
export async function sendTokenEmail(
  params: SendTokenEmailParams,
): Promise<void> {
  const client = getResend()
  const { to, token } = params

  const { error } = await client.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Seu token Pro do Tablix',
    html: generateTokenEmailHtml(token),
    text: generateTokenEmailText(token),
  })

  if (error) {
    throw Errors.internal('Erro ao enviar email')
  }
}

/**
 * Envia email notificando cancelamento da assinatura
 */
export async function sendCancellationEmail(
  params: SendCancellationEmailParams,
): Promise<void> {
  const client = getResend()
  const { to, expiresAt } = params

  const { error } = await client.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Sua assinatura Tablix Pro foi cancelada',
    html: generateCancellationEmailHtml(expiresAt),
    text: generateCancellationEmailText(expiresAt),
  })

  if (error) {
    throw Errors.internal('Erro ao enviar email')
  }
}

/**
 * Envia email notificando falha no pagamento
 */
export async function sendPaymentFailedEmail(
  params: SendPaymentFailedEmailParams,
): Promise<void> {
  const client = getResend()
  const { to } = params

  const { error } = await client.emails.send({
    from: FROM_EMAIL,
    to,
    subject: 'Problema com seu pagamento - Tablix Pro',
    html: generatePaymentFailedEmailHtml(),
    text: generatePaymentFailedEmailText(),
  })

  if (error) {
    throw Errors.internal('Erro ao enviar email')
  }
}

// ===========================================
// TEMPLATES DE EMAIL
// ===========================================

function generateTokenEmailHtml(token: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Seu Token Pro do Tablix</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: #18181b; padding: 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Tablix Pro</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <h2 style="margin: 0 0 16px; color: #18181b; font-size: 20px; font-weight: 600;">
                Bem-vindo ao Tablix Pro!
              </h2>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                Sua assinatura foi confirmada com sucesso. Use o token abaixo para ativar o plano Pro no Tablix:
              </p>

              <!-- Token Box -->
              <div style="background-color: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 16px; margin-bottom: 24px;">
                <p style="margin: 0 0 8px; color: #71717a; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
                  Seu Token Pro
                </p>
                <code style="display: block; background-color: #18181b; color: #22c55e; padding: 12px 16px; border-radius: 4px; font-family: 'SF Mono', Monaco, 'Courier New', monospace; font-size: 14px; word-break: break-all;">
                  ${token}
                </code>
              </div>

              <p style="margin: 0 0 16px; color: #52525b; font-size: 14px; line-height: 1.6;">
                <strong>Como usar:</strong>
              </p>

              <ol style="margin: 0 0 24px; padding-left: 20px; color: #52525b; font-size: 14px; line-height: 1.8;">
                <li>Acesse o Tablix em <a href="${env.FRONTEND_URL}" style="color: #2563eb; text-decoration: none;">${env.FRONTEND_URL}</a></li>
                <li>Clique em "Ativar Pro" ou no campo de token</li>
                <li>Cole o token acima e clique em "Ativar"</li>
                <li>Pronto! Seu plano Pro estara ativo</li>
              </ol>

              <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 0 4px 4px 0; margin-bottom: 24px;">
                <p style="margin: 0; color: #92400e; font-size: 14px;">
                  <strong>Importante:</strong> Seu token sera vinculado ao primeiro dispositivo que o utilizar. Guarde-o em local seguro e nao compartilhe.
                </p>
              </div>

              <p style="margin: 0; color: #71717a; font-size: 14px;">
                Se tiver qualquer duvida, responda este email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center;">
              <p style="margin: 0; color: #71717a; font-size: 12px;">
                Tablix - Unifique suas planilhas com facilidade
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

function generateTokenEmailText(token: string): string {
  return `
Bem-vindo ao Tablix Pro!

Sua assinatura foi confirmada com sucesso.

SEU TOKEN PRO:
${token}

COMO USAR:
1. Acesse o Tablix em ${env.FRONTEND_URL}
2. Clique em "Ativar Pro" ou no campo de token
3. Cole o token acima e clique em "Ativar"
4. Pronto! Seu plano Pro estara ativo

IMPORTANTE: Seu token sera vinculado ao primeiro dispositivo que o utilizar. Guarde-o em local seguro e nao compartilhe.

Se tiver qualquer duvida, responda este email.

---
Tablix - Unifique suas planilhas com facilidade
  `.trim()
}

function generateCancellationEmailHtml(expiresAt: Date | null): string {
  const expirationText = expiresAt
    ? `Voce ainda tera acesso ate <strong>${expiresAt.toLocaleDateString('pt-BR')}</strong>.`
    : 'Seu acesso foi encerrado.'

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Assinatura Cancelada - Tablix</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: #18181b; padding: 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Tablix</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <h2 style="margin: 0 0 16px; color: #18181b; font-size: 20px; font-weight: 600;">
                Sua assinatura foi cancelada
              </h2>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                Recebemos a confirmacao do cancelamento da sua assinatura Tablix Pro.
              </p>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                ${expirationText}
              </p>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                Sentiremos sua falta! Se mudar de ideia, voce pode reativar sua assinatura a qualquer momento em <a href="${env.FRONTEND_URL}" style="color: #2563eb; text-decoration: none;">${env.FRONTEND_URL}</a>
              </p>

              <p style="margin: 0; color: #71717a; font-size: 14px;">
                Se tiver qualquer duvida, responda este email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center;">
              <p style="margin: 0; color: #71717a; font-size: 12px;">
                Tablix - Unifique suas planilhas com facilidade
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

function generateCancellationEmailText(expiresAt: Date | null): string {
  const expirationText = expiresAt
    ? `Voce ainda tera acesso ate ${expiresAt.toLocaleDateString('pt-BR')}.`
    : 'Seu acesso foi encerrado.'

  return `
Sua assinatura foi cancelada

Recebemos a confirmacao do cancelamento da sua assinatura Tablix Pro.

${expirationText}

Sentiremos sua falta! Se mudar de ideia, voce pode reativar sua assinatura a qualquer momento em ${env.FRONTEND_URL}

Se tiver qualquer duvida, responda este email.

---
Tablix - Unifique suas planilhas com facilidade
  `.trim()
}

function generatePaymentFailedEmailHtml(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Problema com Pagamento - Tablix</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f4f4f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color: #dc2626; padding: 32px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">Tablix</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 32px;">
              <h2 style="margin: 0 0 16px; color: #18181b; font-size: 20px; font-weight: 600;">
                Problema com seu pagamento
              </h2>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                Nao conseguimos processar o pagamento da sua assinatura Tablix Pro.
              </p>

              <p style="margin: 0 0 24px; color: #52525b; font-size: 16px; line-height: 1.6;">
                Isso pode acontecer por varios motivos: cartao expirado, limite insuficiente ou dados desatualizados.
              </p>

              <div style="text-align: center; margin-bottom: 24px;">
                <a href="${env.FRONTEND_URL}" style="display: inline-block; background-color: #18181b; color: #ffffff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
                  Atualizar forma de pagamento
                </a>
              </div>

              <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 12px 16px; border-radius: 0 4px 4px 0; margin-bottom: 24px;">
                <p style="margin: 0; color: #991b1b; font-size: 14px;">
                  <strong>Importante:</strong> Se o problema persistir, sua assinatura podera ser suspensa.
                </p>
              </div>

              <p style="margin: 0; color: #71717a; font-size: 14px;">
                Se precisar de ajuda, responda este email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f4f4f5; padding: 24px 32px; text-align: center;">
              <p style="margin: 0; color: #71717a; font-size: 12px;">
                Tablix - Unifique suas planilhas com facilidade
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

function generatePaymentFailedEmailText(): string {
  return `
Problema com seu pagamento

Nao conseguimos processar o pagamento da sua assinatura Tablix Pro.

Isso pode acontecer por varios motivos: cartao expirado, limite insuficiente ou dados desatualizados.

Atualize sua forma de pagamento em: ${env.FRONTEND_URL}

IMPORTANTE: Se o problema persistir, sua assinatura podera ser suspensa.

Se precisar de ajuda, responda este email.

---
Tablix - Unifique suas planilhas com facilidade
  `.trim()
}
