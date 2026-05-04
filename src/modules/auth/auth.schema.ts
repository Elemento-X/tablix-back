import { z } from 'zod'
import {
  errorResponseSchema,
  usageSchema,
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
  accessToken: z.string().describe('JWT de sessão (15min)'),
  refreshToken: z.string().describe('Refresh token (30d)'),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: planSchema,
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
    .describe('Refresh token para renovação'),
})

export const refreshResponseSchema = z.object({
  accessToken: z.string().describe('Novo JWT de sessão (15min)'),
  refreshToken: z.string().describe('Novo refresh token (30d)'),
})

export type RefreshBody = z.infer<typeof refreshBodySchema>
export type RefreshResponse = z.infer<typeof refreshResponseSchema>

// ============================================
// GET /auth/me
// ============================================

export const meResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: planSchema,
    usage: usageSchema,
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
// POST /auth/logout-all
// ============================================

export const logoutAllResponseSchema = z.object({
  success: z.literal(true),
  sessionsRevoked: z.number().int().min(0),
})

export type LogoutAllResponse = z.infer<typeof logoutAllResponseSchema>

// ============================================
// SHARED ERROR SCHEMAS
// ============================================

export { errorResponseSchema }
