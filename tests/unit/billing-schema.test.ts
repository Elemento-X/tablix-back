/**
 * Unit tests for billing.schema.ts (Card 1.20)
 * Covers:
 *   - createCheckoutBodySchema: campo currency (default BRL, aceita BRL/USD/EUR, rejeita inválido)
 *   - createCheckoutBodySchema: campos email e plan não-regressivos
 *   - pricesResponseSchema: estrutura currencies[]
 *
 * @owner: @tester
 */
import { describe, it, expect } from 'vitest'
import {
  createCheckoutBodySchema,
  pricesResponseSchema,
} from '../../src/modules/billing/billing.schema'

describe('billing.schema.ts (Card 1.20)', () => {
  // =============================================
  // createCheckoutBodySchema — campo currency
  // =============================================
  describe('createCheckoutBodySchema — currency', () => {
    const baseValidBody = {
      email: 'user@example.com',
      plan: 'monthly' as const,
    }

    it('deve ter default BRL quando currency ausente', () => {
      const result = createCheckoutBodySchema.safeParse(baseValidBody)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.currency).toBe('BRL')
      }
    })

    it('deve aceitar currency BRL explícito', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 'BRL',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.currency).toBe('BRL')
      }
    })

    it('deve aceitar currency USD', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 'USD',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.currency).toBe('USD')
      }
    })

    it('deve aceitar currency EUR', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 'EUR',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.currency).toBe('EUR')
      }
    })

    it('deve rejeitar currency em minúsculo (brl)', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 'brl',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const currencyIssues = result.error.issues.filter((i) =>
          i.path.includes('currency'),
        )
        expect(currencyIssues.length).toBeGreaterThan(0)
      }
    })

    it('deve rejeitar currency inválido (GBP)', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 'GBP',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const currencyIssues = result.error.issues.filter((i) =>
          i.path.includes('currency'),
        )
        expect(currencyIssues.length).toBeGreaterThan(0)
      }
    })

    it('deve rejeitar currency como número', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: 840, // código ISO 4217 numérico de USD
      })

      expect(result.success).toBe(false)
    })

    it('deve rejeitar currency como string vazia', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: '',
      })

      expect(result.success).toBe(false)
    })

    it('deve rejeitar currency null explícito', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: null,
      })

      expect(result.success).toBe(false)
    })

    it('deve rejeitar currency como array', () => {
      const result = createCheckoutBodySchema.safeParse({
        ...baseValidBody,
        currency: ['BRL'],
      })

      expect(result.success).toBe(false)
    })
  })

  // =============================================
  // createCheckoutBodySchema — regressão email e plan
  // =============================================
  describe('createCheckoutBodySchema — regressão email e plan', () => {
    it('deve aceitar body completo com todas as currencies e plans', () => {
      const cases = [
        { email: 'a@b.com', plan: 'monthly', currency: 'BRL' },
        { email: 'a@b.com', plan: 'monthly', currency: 'USD' },
        { email: 'a@b.com', plan: 'monthly', currency: 'EUR' },
        { email: 'a@b.com', plan: 'yearly', currency: 'BRL' },
        { email: 'a@b.com', plan: 'yearly', currency: 'USD' },
        { email: 'a@b.com', plan: 'yearly', currency: 'EUR' },
      ]

      for (const c of cases) {
        const result = createCheckoutBodySchema.safeParse(c)
        expect(result.success).toBe(true)
      }
    })

    it('deve ter default plan monthly quando plan ausente', () => {
      const result = createCheckoutBodySchema.safeParse({
        email: 'user@example.com',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.plan).toBe('monthly')
        expect(result.data.currency).toBe('BRL')
      }
    })

    it('deve rejeitar email inválido', () => {
      const result = createCheckoutBodySchema.safeParse({
        email: 'nao-e-email',
        currency: 'BRL',
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        const emailIssues = result.error.issues.filter((i) =>
          i.path.includes('email'),
        )
        expect(emailIssues.length).toBeGreaterThan(0)
      }
    })

    it('deve rejeitar body sem email', () => {
      const result = createCheckoutBodySchema.safeParse({
        plan: 'monthly',
        currency: 'USD',
      })

      expect(result.success).toBe(false)
    })

    it('deve rejeitar plan inválido', () => {
      const result = createCheckoutBodySchema.safeParse({
        email: 'user@example.com',
        plan: 'weekly',
        currency: 'BRL',
      })

      expect(result.success).toBe(false)
    })
  })

  // =============================================
  // pricesResponseSchema — estrutura currencies[]
  // =============================================
  describe('pricesResponseSchema', () => {
    it('deve aceitar resposta com array currencies preenchido', () => {
      const validResponse = {
        currencies: [
          {
            currency: 'BRL',
            monthly: { available: true },
            yearly: { available: true },
          },
          {
            currency: 'USD',
            monthly: { available: true },
            yearly: { available: true },
          },
          {
            currency: 'EUR',
            monthly: { available: false },
            yearly: { available: false },
          },
        ],
      }

      const result = pricesResponseSchema.safeParse(validResponse)
      expect(result.success).toBe(true)
    })

    it('deve aceitar available false para moeda não configurada', () => {
      const result = pricesResponseSchema.safeParse({
        currencies: [
          {
            currency: 'EUR',
            monthly: { available: false },
            yearly: { available: false },
          },
        ],
      })

      expect(result.success).toBe(true)
    })

    it('deve aceitar currencies como array vazio', () => {
      const result = pricesResponseSchema.safeParse({ currencies: [] })
      expect(result.success).toBe(true)
    })

    it('deve rejeitar response sem campo currencies', () => {
      const result = pricesResponseSchema.safeParse({})
      expect(result.success).toBe(false)
    })

    it('deve rejeitar entrada em currencies sem campo monthly', () => {
      const result = pricesResponseSchema.safeParse({
        currencies: [
          {
            currency: 'BRL',
            yearly: { available: true },
            // monthly ausente
          },
        ],
      })

      expect(result.success).toBe(false)
    })

    it('deve rejeitar available como não-booleano', () => {
      const result = pricesResponseSchema.safeParse({
        currencies: [
          {
            currency: 'BRL',
            monthly: { available: 'yes' },
            yearly: { available: true },
          },
        ],
      })

      expect(result.success).toBe(false)
    })
  })
})
