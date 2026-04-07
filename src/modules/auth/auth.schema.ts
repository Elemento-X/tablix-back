import { z } from 'zod'
import {
  errorResponseSchema,
  usageSchema,
  limitsSchema,
  planSchema,
} from '../../schemas/common.schema'

// ============================================
// POST /auth/validate-token
// ============================================

export const validateTokenBodySchema = z.object({
  token: z
    .string()
    .min(1, 'Token é obrigatório')
    .regex(/^tbx_pro_[A-Za-z0-9_-]+$/, 'Formato de token inválido')
    .describe('Token Pro recebido por email (formato: tbx_pro_xxx)'),
  fingerprint: z
    .string()
    .min(1, 'Fingerprint é obrigatório')
    .max(64, 'Fingerprint muito longo')
    .describe('Identificador único do dispositivo'),
})

export const validateTokenResponseSchema = z.object({
  jwt: z.string().describe('JWT de sessão para usar em requests autenticados'),
  user: z.object({
    email: z.string().email(),
    plan: planSchema,
    status: z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED']),
  }),
})

export type ValidateTokenBody = z.infer<typeof validateTokenBodySchema>
export type ValidateTokenResponse = z.infer<typeof validateTokenResponseSchema>

// ============================================
// POST /auth/refresh
// ============================================

export const refreshBodySchema = z.object({
  refreshToken: z
    .string()
    .min(1, 'Refresh token é obrigatório')
    .describe('JWT expirado para renovação'),
})

export const refreshResponseSchema = z.object({
  jwt: z.string().describe('Novo JWT de sessão'),
})

export type RefreshBody = z.infer<typeof refreshBodySchema>
export type RefreshResponse = z.infer<typeof refreshResponseSchema>

// ============================================
// GET /auth/me
// ============================================

export const meResponseSchema = z.object({
  user: z.object({
    email: z.string().email(),
    plan: planSchema,
    status: z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED']),
    usage: usageSchema,
    limits: limitsSchema,
  }),
})

export type MeResponse = z.infer<typeof meResponseSchema>

// ============================================
// POST /auth/logout
// ============================================

export const logoutResponseSchema = z.object({
  success: z.literal(true),
})

export type LogoutResponse = z.infer<typeof logoutResponseSchema>

// ============================================
// SHARED ERROR SCHEMAS
// ============================================

export { errorResponseSchema }

// Backwards compatibility
export const validateTokenSchema = validateTokenBodySchema
export const refreshTokenSchema = refreshBodySchema
export type ValidateTokenInput = ValidateTokenBody
export type RefreshTokenInput = RefreshBody
