import { z } from 'zod'
import { errorResponseSchema } from '../../schemas/common.schema'

// ============================================
// POST /billing/create-checkout
// ============================================

export const createCheckoutBodySchema = z.object({
  email: z
    .string()
    .email('Email inválido')
    .describe('Email do cliente para o checkout'),
  plan: z
    .enum(['monthly', 'yearly'])
    .default('monthly')
    .describe('Tipo de plano: mensal ou anual'),
  currency: z
    .enum(['BRL', 'USD', 'EUR'])
    .default('BRL')
    .describe('Moeda do checkout: BRL, USD ou EUR'),
})

export const createCheckoutResponseSchema = z.object({
  clientSecret: z
    .string()
    .describe('Client secret para o Stripe Embedded Checkout'),
  sessionId: z.string().describe('ID da sessão de checkout'),
})

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>
export type CreateCheckoutResponse = z.infer<
  typeof createCheckoutResponseSchema
>

// ============================================
// POST /billing/portal
// ============================================

export const createPortalBodySchema = z.object({
  returnUrl: z
    .string()
    .url('URL de retorno inválida')
    .optional()
    .describe('URL para redirecionar após sair do portal'),
})

export const createPortalResponseSchema = z.object({
  url: z.string().url().describe('URL do Stripe Customer Portal'),
})

export type CreatePortalBody = z.infer<typeof createPortalBodySchema>
export type CreatePortalResponse = z.infer<typeof createPortalResponseSchema>

// ============================================
// GET /billing/prices
// ============================================

const priceInfoSchema = z.object({
  available: z.boolean().describe('Se o preço está configurado'),
})

const currencyPricesSchema = z.object({
  currency: z.string().describe('Código da moeda (BRL, USD, EUR)'),
  monthly: priceInfoSchema,
  yearly: priceInfoSchema,
})

export const pricesResponseSchema = z.object({
  currencies: z
    .array(currencyPricesSchema)
    .describe('Preços disponíveis por moeda'),
})

export type PricesResponse = z.infer<typeof pricesResponseSchema>

// ============================================
// SHARED ERROR SCHEMAS
// ============================================

export { errorResponseSchema }

// Backwards compatibility
export const createCheckoutSchema = createCheckoutBodySchema
export const createPortalSchema = createPortalBodySchema
export type CreateCheckoutInput = CreateCheckoutBody
export type CreatePortalInput = CreatePortalBody
