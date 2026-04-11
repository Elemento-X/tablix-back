/**
 * Unit tests for src/errors/app-error.ts
 * Covers: AppError class, ErrorCodes enum, Errors factory functions, toJSON serialization
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import { AppError, ErrorCodes, Errors } from '../../src/errors/app-error'

describe('app-error.ts', () => {
  // =============================================
  // AppError class
  // =============================================
  describe('AppError', () => {
    it('deve criar instancia com code, message, statusCode', () => {
      const err = new AppError(ErrorCodes.UNAUTHORIZED, 'Nao autorizado', 401)

      expect(err).toBeInstanceOf(AppError)
      expect(err).toBeInstanceOf(Error)
      expect(err.code).toBe('UNAUTHORIZED')
      expect(err.message).toBe('Nao autorizado')
      expect(err.statusCode).toBe(401)
      expect(err.name).toBe('AppError')
    })

    it('deve usar statusCode 400 como default', () => {
      const err = new AppError(ErrorCodes.VALIDATION_ERROR, 'Campo invalido')

      expect(err.statusCode).toBe(400)
    })

    it('deve incluir details quando fornecido', () => {
      const details = { field: 'email', reason: 'duplicated' }
      const err = new AppError(ErrorCodes.VALIDATION_ERROR, 'Erro de validacao', 400, details)

      expect(err.details).toEqual(details)
    })

    it('deve omitir details quando nao fornecido', () => {
      const err = new AppError(ErrorCodes.INTERNAL_ERROR, 'Erro interno', 500)

      expect(err.details).toBeUndefined()
    })

    it('deve ter stack trace valido', () => {
      const err = new AppError(ErrorCodes.INTERNAL_ERROR, 'teste', 500)

      expect(err.stack).toBeDefined()
      expect(err.stack).toContain('AppError')
    })

    describe('toJSON', () => {
      it('deve serializar com envelope error contendo code e message', () => {
        const err = new AppError(ErrorCodes.NOT_FOUND, 'Recurso nao encontrado', 404)
        const json = err.toJSON()

        expect(json).toEqual({
          error: {
            code: 'NOT_FOUND',
            message: 'Recurso nao encontrado',
          },
        })
      })

      it('deve incluir details no JSON quando presente', () => {
        const err = new AppError(ErrorCodes.LIMIT_EXCEEDED, 'Limite excedido', 400, {
          limit: '5',
          actual: '6',
        })
        const json = err.toJSON()

        expect(json.error.details).toEqual({ limit: '5', actual: '6' })
      })

      it('nao deve incluir details no JSON quando ausente', () => {
        const err = new AppError(ErrorCodes.UNAUTHORIZED, 'Nao autorizado', 401)
        const json = err.toJSON()

        expect(json.error).not.toHaveProperty('details')
      })

      it('nao deve incluir stack trace no JSON (information disclosure)', () => {
        const err = new AppError(ErrorCodes.INTERNAL_ERROR, 'Erro', 500)
        const json = JSON.stringify(err.toJSON())

        expect(json).not.toContain('stack')
        expect(json).not.toContain('at ')
      })
    })
  })

  // =============================================
  // Errors factory functions
  // =============================================
  describe('Errors factories', () => {
    it('invalidToken deve retornar 401 com INVALID_TOKEN', () => {
      const err = Errors.invalidToken()

      expect(err.code).toBe('INVALID_TOKEN')
      expect(err.statusCode).toBe(401)
      expect(err.message).toBeTruthy()
    })

    it('invalidToken deve aceitar mensagem customizada', () => {
      const err = Errors.invalidToken('Token inválido ou expirado')

      expect(err.message).toBe('Token inválido ou expirado')
    })

    it('tokenAlreadyUsed deve retornar 403 com TOKEN_ALREADY_USED', () => {
      const err = Errors.tokenAlreadyUsed()

      expect(err.code).toBe('TOKEN_ALREADY_USED')
      expect(err.statusCode).toBe(403)
    })

    it('subscriptionExpired deve retornar 403 com SUBSCRIPTION_EXPIRED', () => {
      const err = Errors.subscriptionExpired()

      expect(err.code).toBe('SUBSCRIPTION_EXPIRED')
      expect(err.statusCode).toBe(403)
    })

    it('unauthorized deve retornar 401 com UNAUTHORIZED', () => {
      const err = Errors.unauthorized()

      expect(err.code).toBe('UNAUTHORIZED')
      expect(err.statusCode).toBe(401)
    })

    it('forbidden deve retornar 403 com FORBIDDEN', () => {
      const err = Errors.forbidden()

      expect(err.code).toBe('FORBIDDEN')
      expect(err.statusCode).toBe(403)
    })

    it('limitExceeded deve retornar 400 com details de limit e actual', () => {
      const err = Errors.limitExceeded('5', '10', 'data.csv')

      expect(err.code).toBe('LIMIT_EXCEEDED')
      expect(err.statusCode).toBe(400)
      expect(err.details).toEqual({
        limit: '5',
        actual: '10',
        file: 'data.csv',
      })
    })

    it('limitExceeded sem file deve omitir campo file', () => {
      const err = Errors.limitExceeded('5', '10')

      expect(err.details).toEqual({ limit: '5', actual: '10' })
      expect(err.details).not.toHaveProperty('file')
    })

    it('rateLimited deve retornar 429 com RATE_LIMITED', () => {
      const err = Errors.rateLimited()

      expect(err.code).toBe('RATE_LIMITED')
      expect(err.statusCode).toBe(429)
    })

    it('processingFailed deve retornar 500', () => {
      const err = Errors.processingFailed()

      expect(err.code).toBe('PROCESSING_FAILED')
      expect(err.statusCode).toBe(500)
    })

    it('jobNotFound deve retornar 404 com jobId nos details', () => {
      const err = Errors.jobNotFound('job-abc-123')

      expect(err.code).toBe('JOB_NOT_FOUND')
      expect(err.statusCode).toBe(404)
      expect(err.details).toEqual({ jobId: 'job-abc-123' })
    })

    it('checkoutFailed deve retornar 500', () => {
      const err = Errors.checkoutFailed()

      expect(err.code).toBe('CHECKOUT_FAILED')
      expect(err.statusCode).toBe(500)
    })

    it('webhookFailed deve retornar 500', () => {
      const err = Errors.webhookFailed()

      expect(err.code).toBe('WEBHOOK_FAILED')
      expect(err.statusCode).toBe(500)
    })

    it('portalFailed deve retornar 500', () => {
      const err = Errors.portalFailed()

      expect(err.code).toBe('PORTAL_FAILED')
      expect(err.statusCode).toBe(500)
    })

    it('validationError deve retornar 400 com details opcionais', () => {
      const err = Errors.validationError('Campo obrigatorio', {
        field: 'email',
      })

      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.statusCode).toBe(400)
      expect(err.message).toBe('Campo obrigatorio')
      expect(err.details).toEqual({ field: 'email' })
    })

    it('notFound deve retornar 404 com nome do recurso na mensagem', () => {
      const err = Errors.notFound('Usuario')

      expect(err.code).toBe('NOT_FOUND')
      expect(err.statusCode).toBe(404)
      expect(err.message).toContain('Usuario')
    })

    it('internal deve retornar 500 com INTERNAL_ERROR', () => {
      const err = Errors.internal()

      expect(err.code).toBe('INTERNAL_ERROR')
      expect(err.statusCode).toBe(500)
    })
  })

  // =============================================
  // ErrorCodes enum completeness
  // =============================================
  describe('ErrorCodes', () => {
    it('deve ter todos os codigos documentados', () => {
      const expectedCodes = [
        'INVALID_TOKEN',
        'TOKEN_ALREADY_USED',
        'SUBSCRIPTION_EXPIRED',
        'UNAUTHORIZED',
        'FORBIDDEN',
        'LIMIT_EXCEEDED',
        'RATE_LIMITED',
        'PROCESSING_FAILED',
        'JOB_NOT_FOUND',
        'CHECKOUT_FAILED',
        'WEBHOOK_FAILED',
        'PORTAL_FAILED',
        'VALIDATION_ERROR',
        'NOT_FOUND',
        'INTERNAL_ERROR',
      ]

      const actualCodes = Object.values(ErrorCodes)

      for (const code of expectedCodes) {
        expect(actualCodes).toContain(code)
      }
    })
  })
})
