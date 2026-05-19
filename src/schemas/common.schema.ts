import { z } from 'zod'

// ============================================
// ERROR RESPONSE
// ============================================

export const errorDetailSchema = z.object({
  code: z
    .string()
    .describe('Código do erro (ex: INVALID_TOKEN, LIMIT_EXCEEDED)'),
  message: z.string().describe('Mensagem legível do erro'),
  details: z
    .record(z.unknown())
    .optional()
    .describe('Detalhes adicionais do erro'),
})

export const errorResponseSchema = z.object({
  error: errorDetailSchema,
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

// ============================================
// SUCCESS RESPONSES
// ============================================

export const messageResponseSchema = z.object({
  message: z.string(),
})

export type MessageResponse = z.infer<typeof messageResponseSchema>

// ============================================
// USAGE & LIMITS
// ============================================

export const usageSchema = z.object({
  current: z.number().int().min(0).describe('Unificações usadas no período'),
  limit: z.number().int().min(0).describe('Limite de unificações do plano'),
  remaining: z.number().int().min(0).describe('Unificações restantes'),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .describe('Período no formato YYYY-MM'),
})

export type Usage = z.infer<typeof usageSchema>

export const limitsSchema = z.object({
  unificationsPerMonth: z.number().int().describe('Unificações por mês'),
  maxInputFiles: z
    .number()
    .int()
    .describe('Máximo de planilhas por unificação'),
  maxFileSize: z.number().int().describe('Tamanho máximo por arquivo (bytes)'),
  maxTotalSize: z.number().int().describe('Tamanho total máximo (bytes)'),
  maxRowsPerFile: z.number().int().describe('Máximo de linhas por planilha'),
  maxTotalRows: z.number().int().describe('Máximo de linhas totais no merge'),
  maxColumns: z.number().int().describe('Máximo de colunas selecionáveis'),
  hasWatermark: z.boolean().describe("Se aplica marca d'água"),
})

export type Limits = z.infer<typeof limitsSchema>

// ============================================
// PLAN & USER
// ============================================

export const planSchema = z.enum(['FREE', 'PRO'])

export type Plan = z.infer<typeof planSchema>

export const userInfoSchema = z.object({
  email: z.string().email(),
  plan: planSchema,
  status: z.enum(['ACTIVE', 'CANCELLED', 'EXPIRED']),
  usage: usageSchema,
  limits: limitsSchema,
})

export type UserInfo = z.infer<typeof userInfoSchema>

// ============================================
// ACCESS TOKEN PAYLOAD
// ============================================

export const accessTokenPayloadSchema = z.object({
  sub: z.string().uuid().describe('Session ID'),
  userId: z.string().uuid(),
  email: z.string().email(),
  role: planSchema,
  iat: z.number().optional(),
  exp: z.number().optional(),
})

export type AccessTokenPayloadSchema = z.infer<typeof accessTokenPayloadSchema>
