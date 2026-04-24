// Códigos de erro padronizados do Tablix
export const ErrorCodes = {
  // Autenticação
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_ALREADY_USED: 'TOKEN_ALREADY_USED',
  SUBSCRIPTION_EXPIRED: 'SUBSCRIPTION_EXPIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',

  // Limites
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  RATE_LIMITED: 'RATE_LIMITED',
  IP_UNRESOLVABLE: 'IP_UNRESOLVABLE',

  // Processamento
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',

  // Billing
  CHECKOUT_FAILED: 'CHECKOUT_FAILED',
  WEBHOOK_FAILED: 'WEBHOOK_FAILED',
  PORTAL_FAILED: 'PORTAL_FAILED',
  CURRENCY_UNAVAILABLE: 'CURRENCY_UNAVAILABLE',

  // Idempotency (Card #74)
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',

  // Geral
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

interface ErrorDetails {
  [key: string]: unknown
}

export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly statusCode: number
  public readonly details?: ErrorDetails

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 400,
    details?: ErrorDetails,
  ) {
    super(message)
    this.code = code
    this.statusCode = statusCode
    this.details = details
    this.name = 'AppError'

    // Mantém o stack trace correto
    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    }
  }
}

// Factory functions para erros comuns
export const Errors = {
  invalidToken: (message = 'Token inválido ou expirado') =>
    new AppError(ErrorCodes.INVALID_TOKEN, message, 401),

  tokenAlreadyUsed: (message = 'Token já vinculado a outro dispositivo') =>
    new AppError(ErrorCodes.TOKEN_ALREADY_USED, message, 403),

  subscriptionExpired: (message = 'Assinatura expirada') =>
    new AppError(ErrorCodes.SUBSCRIPTION_EXPIRED, message, 403),

  unauthorized: (message = 'Não autorizado') =>
    new AppError(ErrorCodes.UNAUTHORIZED, message, 401),

  forbidden: (message = 'Permissão insuficiente para este recurso') =>
    new AppError(ErrorCodes.FORBIDDEN, message, 403),

  limitExceeded: (limit: string, actual: string, file?: string) =>
    new AppError(ErrorCodes.LIMIT_EXCEEDED, 'Limite excedido', 400, {
      limit,
      actual,
      ...(file && { file }),
    }),

  rateLimited: (
    message = 'Muitas requisições. Tente novamente em alguns minutos.',
  ) => new AppError(ErrorCodes.RATE_LIMITED, message, 429),

  ipUnresolvable: (message = 'Requisição inválida') =>
    new AppError(ErrorCodes.IP_UNRESOLVABLE, message, 400),

  processingFailed: (message = 'Erro no processamento') =>
    new AppError(ErrorCodes.PROCESSING_FAILED, message, 500),

  jobNotFound: (jobId: string) =>
    new AppError(ErrorCodes.JOB_NOT_FOUND, 'Job não encontrado', 404, {
      jobId,
    }),

  checkoutFailed: (message = 'Erro ao criar checkout') =>
    new AppError(ErrorCodes.CHECKOUT_FAILED, message, 500),

  webhookFailed: (message = 'Erro ao processar webhook') =>
    new AppError(ErrorCodes.WEBHOOK_FAILED, message, 500),

  portalFailed: (message = 'Erro ao gerar portal') =>
    new AppError(ErrorCodes.PORTAL_FAILED, message, 500),

  currencyUnavailable: (currency: string, interval: string) =>
    new AppError(
      ErrorCodes.CURRENCY_UNAVAILABLE,
      'Plano não disponível para esta moeda',
      422,
      {
        currency,
        interval,
      },
    ),

  // Idempotency (Card #74) — mesma Idempotency-Key com body diferente.
  // Alinhado com Stripe spec (422 Unprocessable Entity).
  idempotencyConflict: (
    message = 'Idempotency-Key já usada com payload diferente',
  ) => new AppError(ErrorCodes.IDEMPOTENCY_CONFLICT, message, 422),

  // Outro worker já está processando a mesma key (lock detido).
  // Cliente deve retentar após alguns segundos (Retry-After header).
  idempotencyInProgress: (
    message = 'Requisição similar já está sendo processada',
  ) => new AppError(ErrorCodes.IDEMPOTENCY_IN_PROGRESS, message, 409),

  validationError: (message: string, details?: ErrorDetails) =>
    new AppError(ErrorCodes.VALIDATION_ERROR, message, 400, details),

  notFound: (resource: string) =>
    new AppError(ErrorCodes.NOT_FOUND, `${resource} não encontrado`, 404),

  internal: (message = 'Erro interno do servidor') =>
    new AppError(ErrorCodes.INTERNAL_ERROR, message, 500),
}
