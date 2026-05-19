/**
 * Card #150 — Tipos do dominio de auditoria LEGAL (LGPD 5y retention).
 *
 * Fonte unica da verdade dos eventos LGPD-relevantes (purge/consent/dsar).
 * SEPARADO de src/lib/audit/audit.types.ts (operacional, 90d).
 *
 * Decisoes irreversiveis (consultar plano antes de mudar):
 *  - .claude/plans/2026-04-28-card-150-audit-log-legal.md
 *
 *  (D-1) Service `recordLegalEvent` eh AWAIT (nao fire-and-forget).
 *        Falha de DB DEVE bloquear caller. LGPD nao tolera evento perdido.
 *
 *  (D-2/D-4) event_type, actor, outcome sao WHITELIST via `as const`
 *        + CHECK constraint SQL (defesa em profundidade). Adicionar valor
 *        exige migration nova + atualizar este arquivo + atualizar
 *        spec do agente @security.
 *
 *  (D-5) `userId` eh apenas string Uuid — sem FK na tabela. Evento legal
 *        precisa SOBREVIVER ao delete do user (essa eh a prova juridica).
 *
 *  (R-7) Cron de retencao 5 anos vive em card #152. NAO REUSAR cron 90d.
 *
 *  (resource_hash) Computado por src/lib/audit-hash.ts (FREEZED v1).
 *        SHA-256(userId:storagePath) em 32 bytes. NUNCA path real.
 *        Mudanca de formula = nova coluna resourceHashV2, NUNCA mutar v1.
 *
 * @owner: @security + @dba
 */

import { z } from 'zod'

// =============================================================================
// WHITELISTS (espelham CHECK constraints SQL)
// =============================================================================

/**
 * Tipos de eventos legais. Adicionar novo tipo exige:
 *   (1) atualizar este const
 *   (2) migration ALTER CONSTRAINT audit_log_legal_event_type_check
 *   (3) atualizar Zod schema abaixo (z.enum)
 *   (4) adicionar caso de teste em audit-legal.service.spec.ts
 *   (5) documentar no spec do @security
 */
export const LegalEventType = {
  /** Marcacao inicial da purga. Commitado ANTES do DELETE no Storage. */
  PURGE_PENDING: 'purge_pending',
  /** Confirmacao da purga apos DELETE Storage + DELETE row. Prova juridica. */
  PURGE_COMPLETED: 'purge_completed',
  /** Falha na purga apos N tentativas. Dispara dead-letter + alerta. */
  PURGE_FAILED: 'purge_failed',
  /** Usuario deu consentimento explicito (opt-in feature). */
  CONSENT_GIVEN: 'consent_given',
  /** Usuario revogou consentimento (opt-out). Triggera purga. */
  CONSENT_WITHDRAWN: 'consent_withdrawn',
  /** Data Subject Access Request recebido (LGPD Art. 18 — direito de acesso). */
  DSAR_REQUEST: 'dsar_request',
  /** DSAR atendido (export entregue ou negacao justificada). */
  DSAR_FULFILLED: 'dsar_fulfilled',
} as const

export type LegalEventType =
  (typeof LegalEventType)[keyof typeof LegalEventType]

/**
 * Quem disparou o evento. Whitelist fechada pra analise forense deterministica.
 */
export const LegalActor = {
  /** Cron worker de purga (Card #146 / 5.2b). */
  CRON_PURGE_WORKER: 'cron_purge_worker',
  /** Acao manual do proprio usuario via UI (DELETE individual/all). */
  USER_SELF_SERVICE: 'user_self_service',
  /** Acao manual do admin via panel interno (DSAR fulfillment). */
  ADMIN_PANEL: 'admin_panel',
} as const

export type LegalActor = (typeof LegalActor)[keyof typeof LegalActor]

/**
 * Resultado do evento. Apenas success/failure — eventos ambiguos sao bug.
 */
export const LegalOutcome = {
  SUCCESS: 'success',
  FAILURE: 'failure',
} as const

export type LegalOutcome = (typeof LegalOutcome)[keyof typeof LegalOutcome]

// =============================================================================
// CONSTANTES
// =============================================================================

/** Algoritmo do resource_hash. FREEZED v1. Versionavel via coluna do DB. */
export const RESOURCE_HASH_ALGO_V1 = 'sha256v1' as const

/** Tamanho exato do resource_hash em bytes (SHA-256 = 32 bytes). */
export const RESOURCE_HASH_SIZE_BYTES = 32

/** Cap do metadata serializado (mesmo pattern audit_log Card 2.4). */
export const METADATA_MAX_BYTES = 1024

// =============================================================================
// ZOD SCHEMA INPUT
// =============================================================================

/**
 * Schema de input do `recordLegalEvent`. Espelha CHECK constraints SQL e
 * adiciona validacoes de app:
 *  - eventId UUID v4 strict (idempotency-key fornecido pelo caller)
 *  - errorCode obrigatorio se outcome=failure (superRefine)
 *  - resource_hash exato 32 bytes ou ausente (Uint8Array/Buffer)
 *  - legal_basis snake_case lowercase length 3-60
 */
export const legalEventInputSchema = z
  .object({
    /**
     * UUID v4 fornecido pelo CALLER. Idempotency-key style: cron retenta sem
     * duplicar (P2002 → service faz lookup e retorna evento existente).
     */
    eventId: z.string().uuid(),

    /** Tipo do evento (whitelist espelhada do CHECK SQL). */
    eventType: z.enum([
      LegalEventType.PURGE_PENDING,
      LegalEventType.PURGE_COMPLETED,
      LegalEventType.PURGE_FAILED,
      LegalEventType.CONSENT_GIVEN,
      LegalEventType.CONSENT_WITHDRAWN,
      LegalEventType.DSAR_REQUEST,
      LegalEventType.DSAR_FULFILLED,
    ]),

    /** UUID do usuario alvo do evento. Sem FK no DB (D-5). */
    userId: z.string().uuid(),

    /** Tipo do recurso (ex: 'file_history', 'user'). */
    resourceType: z.string().min(3).max(40),

    /** ID do recurso afetado. */
    resourceId: z.string().min(1).max(64),

    /**
     * Base legal LGPD/CDC. snake_case lowercase, 3-60 chars.
     * Ex: 'retention_expired', 'user_request_art_18', 'consent_withdrawn'
     */
    legalBasis: z
      .string()
      .min(3)
      .max(60)
      .regex(/^[a-z_]+$/, 'legalBasis deve ser snake_case lowercase'),

    /** Quem disparou (whitelist). */
    actor: z.enum([
      LegalActor.CRON_PURGE_WORKER,
      LegalActor.USER_SELF_SERVICE,
      LegalActor.ADMIN_PANEL,
    ]),

    /**
     * Timestamp original do `expiresAt` que disparou a purga. Prova de que
     * o prazo de retencao foi respeitado (vs antecipado por bug).
     */
    expiresAtOriginal: z.date().optional(),

    /**
     * Hash do recurso (SHA-256(userId:storagePath) em 32 bytes).
     * Computado por src/lib/audit-hash.ts. NUNCA o path real.
     * Optional pra eventos sem recurso fisico (ex: CONSENT_GIVEN).
     */
    resourceHash: z
      .instanceof(Uint8Array)
      .refine(
        (b) => b.byteLength === RESOURCE_HASH_SIZE_BYTES,
        `resourceHash deve ter exatamente ${RESOURCE_HASH_SIZE_BYTES} bytes`,
      )
      .optional(),

    /** Resultado do evento. */
    outcome: z.enum([LegalOutcome.SUCCESS, LegalOutcome.FAILURE]),

    /**
     * Codigo de erro. Obrigatorio se outcome=failure (validado em superRefine).
     */
    errorCode: z.string().min(1).max(80).optional(),

    /**
     * Metadata adicional. Passa por scrubObject SSOT antes de persistir.
     * Cap 1024 bytes serializados (defesa contra metadata explodir).
     */
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((input, ctx) => {
    // errorCode obrigatorio se failure (defesa em app + CHECK no DB)
    if (input.outcome === LegalOutcome.FAILURE && !input.errorCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'errorCode obrigatorio quando outcome=failure',
        path: ['errorCode'],
      })
    }
    // errorCode proibido se success (evento de sucesso nao tem erro)
    if (input.outcome === LegalOutcome.SUCCESS && input.errorCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'errorCode nao deve ser fornecido quando outcome=success',
        path: ['errorCode'],
      })
    }
  })

/**
 * Tipo do input apos validacao Zod. Use este tipo no caller.
 */
export type LegalEventInput = z.infer<typeof legalEventInputSchema>
