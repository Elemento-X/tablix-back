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
  priceId: z.string().nullable().describe('ID do preço no Stripe'),
  available: z.boolean().describe('Se o preço está configurado'),
})

export const pricesResponseSchema = z.object({
  monthly: priceInfoSchema,
  yearly: priceInfoSchema,
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
