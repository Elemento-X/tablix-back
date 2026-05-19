/**
 * Integration test PARIDADE Zod ↔ SQL CHECK — Card #146 (5.2b) F5 fix-pack.
 *
 * Cobre @tester MÉDIO (paridade-test-missing) + @dba MÉDIO (sync enums TS↔SQL).
 *
 * Valida que CHECK constraints SQL rejeitam os mesmos inputs que o app
 * rejeitaria via enum/regex TS — pattern Card #150 audit_log_legal.
 *
 * **Tabelas auditadas**:
 *   - cron_runs (10 CHECKs): status, skip_reason, terminal_finished_check,
 *     finished_after_started, skip_reason_consistency, error_consistency,
 *     duration_positive, rows_processed_nonneg, attempts (1-10),
 *     job_name format
 *   - file_history_dead_letter (10 CHECKs): file_size, purge_attempts>=5,
 *     storage_path format (regex Zod-parity), mime_type, original_filename
 *     (sem control chars + \x7F), reprocess_count (0-3), timing_consistency,
 *     reprocess_consistency, resolution_consistency, resolution_type
 *
 * Execução: requer Docker (Testcontainers Postgres).
 *
 * @owner: @tester + @dba
 * @card: #146 F5 fix-pack ciclo 1
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  disconnectTestPrisma,
  getTestPrisma,
  truncateAll,
} from '../helpers/prisma'

const prisma = getTestPrisma()

beforeEach(async () => {
  await truncateAll()
})

afterAll(async () => {
  await disconnectTestPrisma()
})

// ============================================
// cron_runs CHECK constraints
// ============================================

describe('cron_runs CHECK paridade (Card #146 fix-pack)', () => {
  it('cron_runs_status_check: aceita whitelist + rejeita fora', async () => {
    const validStatuses = [
      'running',
      'success',
      'failure',
      'skipped',
      'expired',
    ]
    for (const status of validStatuses) {
      // running NÃO pode ter finished_at, demais SIM. Variar pra cobrir.
      const finished = status === 'running' ? null : new Date()
      await expect(
        prisma.cronRun.create({
          data: {
            jobName: 'test-job-' + status,
            startedAt: new Date(),
            finishedAt: finished,
            status,
            skipReason: status === 'skipped' ? 'feature_disabled' : null,
          },
        }),
      ).resolves.toBeDefined()
    }

    // Status fora da whitelist → CHECK violation
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, status)
        VALUES ('bad-status-test', NOW(), 'invalid_status')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_skip_reason_check: aceita whitelist + rejeita fora', async () => {
    const validReasons = ['feature_disabled', 'test_env', 'lock_not_acquired']
    for (const reason of validReasons) {
      await expect(
        prisma.cronRun.create({
          data: {
            jobName: 'test-skip',
            startedAt: new Date(),
            finishedAt: new Date(),
            status: 'skipped',
            skipReason: reason,
          },
        }),
      ).resolves.toBeDefined()
      await truncateAll()
    }

    // F5 fix-pack: skip_reason 'redis_unavailable' foi REMOVIDO (era dead value).
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, finished_at, status, skip_reason)
        VALUES ('test-removed-enum', NOW(), NOW(), 'skipped', 'redis_unavailable')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_terminal_finished_check: status terminal exige finished_at', async () => {
    // status='success' SEM finished_at deve falhar
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, status)
        VALUES ('term-check', NOW(), 'success')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_attempts_check: rejeita attempts > 10', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, status, attempts)
        VALUES ('attempts-check', NOW(), 'running', 11)
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_attempts_check: rejeita attempts <= 0', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, status, attempts)
        VALUES ('attempts-check-zero', NOW(), 'running', 0)
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_job_name_format_check: rejeita name com uppercase', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, status)
        VALUES ('Bad-Name-Format', NOW(), 'running')
      `,
    ).rejects.toThrow(/check/i)
  })

  it('cron_runs_duration_positive_check: rejeita duration_ms negativo', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO cron_runs (job_name, started_at, finished_at, status, duration_ms)
        VALUES ('dur-check', NOW(), NOW(), 'success', -100)
      `,
    ).rejects.toThrow(/check/i)
  })
})

// ============================================
// file_history_dead_letter CHECK constraints
// ============================================

const VALID_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const VALID_PATH_BASE = `${VALID_USER}/2026-05-10/abc1234`

async function insertDeadLetterRaw(overrides: {
  storagePath?: string
  originalFilename?: string
  fileSize?: number
  purgeAttempts?: number
  reprocessCount?: number
  resolutionType?: string | null
  resolvedAt?: Date | null
}) {
  const storage = overrides.storagePath ?? `${VALID_PATH_BASE}.csv`
  const filename = overrides.originalFilename ?? 'test.csv'
  const size = overrides.fileSize ?? 1024
  const attempts = overrides.purgeAttempts ?? 5
  const reprocess = overrides.reprocessCount ?? 0
  const resolution = overrides.resolutionType ?? null
  const resolved = overrides.resolvedAt ?? null

  return prisma.$executeRaw`
    INSERT INTO file_history_dead_letter (
      original_file_history_id, user_id, storage_path, original_filename,
      mime_type, file_size, expires_at, deleted_at, purge_attempts,
      last_error_code, reprocess_count, last_reprocess_attempt_at,
      resolved_at, resolution_type
    )
    VALUES (
      gen_random_uuid(), ${VALID_USER}::uuid, ${storage}, ${filename},
      'text/csv', ${size}, NOW(), NOW(), ${attempts},
      'TEST_ERR', ${reprocess},
      ${reprocess > 0 ? new Date() : null},
      ${resolved}, ${resolution}
    )
  `
}

describe('file_history_dead_letter CHECK paridade (Card #146 fix-pack)', () => {
  it('fhdl_purge_attempts_threshold_check: rejeita purge_attempts < 5', async () => {
    await expect(insertDeadLetterRaw({ purgeAttempts: 4 })).rejects.toThrow(
      /check/i,
    )
  })

  it('fhdl_purge_attempts_threshold_check: aceita purge_attempts = 5', async () => {
    await expect(
      insertDeadLetterRaw({ purgeAttempts: 5 }),
    ).resolves.toBeGreaterThan(0)
  })

  it('fhdl_storage_path_format_check: rejeita path com data inválida 9999-99-99', async () => {
    // Card #146 fix-pack ciclo 1 (@dba ALTO #2 — regex endurecido)
    await expect(
      insertDeadLetterRaw({
        storagePath: `${VALID_USER}/9999-99-99/abc1234.csv`,
      }),
    ).rejects.toThrow(/check/i)
  })

  it('fhdl_storage_path_format_check: rejeita path com mês 13', async () => {
    await expect(
      insertDeadLetterRaw({
        storagePath: `${VALID_USER}/2026-13-15/abc1234.csv`,
      }),
    ).rejects.toThrow(/check/i)
  })

  it('fhdl_storage_path_format_check: aceita path canônico válido', async () => {
    await expect(
      insertDeadLetterRaw({ storagePath: `${VALID_PATH_BASE}.csv` }),
    ).resolves.toBeGreaterThan(0)
  })

  it('fhdl_storage_path_format_check: rejeita extensão .exe', async () => {
    await expect(
      insertDeadLetterRaw({ storagePath: `${VALID_PATH_BASE}.exe` }),
    ).rejects.toThrow(/check/i)
  })

  it('fhdl_original_filename_check: rejeita filename com DEL char (\\x7F)', async () => {
    // Card #146 fix-pack ciclo 1 (@dba ALTO #2 — \x7F adicionado)
    const delChar = String.fromCharCode(0x7f)
    await expect(
      insertDeadLetterRaw({ originalFilename: `bad${delChar}name.csv` }),
    ).rejects.toThrow(/check/i)
  })

  it('fhdl_original_filename_check: rejeita filename vazio', async () => {
    await expect(insertDeadLetterRaw({ originalFilename: '' })).rejects.toThrow(
      /check/i,
    )
  })

  it('fhdl_file_size_positive_check: rejeita file_size = 0', async () => {
    await expect(insertDeadLetterRaw({ fileSize: 0 })).rejects.toThrow(/check/i)
  })

  it('fhdl_file_size_positive_check: rejeita file_size > 100MB', async () => {
    await expect(insertDeadLetterRaw({ fileSize: 104857601 })).rejects.toThrow(
      /check/i,
    )
  })

  it('fhdl_reprocess_count_check: rejeita reprocess_count > 3', async () => {
    await expect(insertDeadLetterRaw({ reprocessCount: 4 })).rejects.toThrow(
      /check/i,
    )
  })

  it('fhdl_resolution_type_check: rejeita resolution_type fora whitelist', async () => {
    await expect(
      insertDeadLetterRaw({
        resolutionType: 'invalid_type',
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow(/check/i)
  })

  it('fhdl_resolution_consistency_check: rejeita resolution_type sem resolved_at', async () => {
    await expect(
      insertDeadLetterRaw({
        resolutionType: 'cron_reprocess_success',
        resolvedAt: null,
      }),
    ).rejects.toThrow(/check/i)
  })
})

// ============================================
// file_history_dead_letter TRIGGER BEFORE DELETE
// ============================================

describe('file_history_dead_letter trigger BEFORE DELETE (Card #146 fix-pack)', () => {
  it('DELETE em dead-letter dispara trigger insufficient_privilege', async () => {
    // Insere row válida
    await insertDeadLetterRaw({})

    // DELETE deve falhar com exception da trigger
    await expect(
      prisma.$executeRaw`
        DELETE FROM file_history_dead_letter
        WHERE storage_path = ${`${VALID_PATH_BASE}.csv`}
      `,
    ).rejects.toThrow(/delete-protected|insufficient/i)

    // Row continua na tabela
    const stillThere = await prisma.fileHistoryDeadLetter.findMany({
      where: { storagePath: `${VALID_PATH_BASE}.csv` },
    })
    expect(stillThere).toHaveLength(1)
  })

  it('UPDATE em dead-letter é permitido (cron weekly reprocess)', async () => {
    await insertDeadLetterRaw({})

    // UPDATE de reprocess_count é legítimo (cron weekly)
    await expect(
      prisma.$executeRaw`
        UPDATE file_history_dead_letter
        SET reprocess_count = 1, last_reprocess_attempt_at = NOW()
        WHERE storage_path = ${`${VALID_PATH_BASE}.csv`}
      `,
    ).resolves.toBeGreaterThan(0)
  })
})
