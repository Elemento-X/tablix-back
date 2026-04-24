/**
 * Testes das funções puras do drift detector de schema.
 *
 * Cobre canonicalize/fingerprint/diff/format SEM precisar de banco real —
 * essas funções operam sobre o `SchemaModel` e são determinísticas.
 *
 * Por que testar isso aparte dos integration tests:
 *  - Integration tests garantem que a INTROSPECTION funciona contra Postgres
 *    real (queries pg_catalog/information_schema).
 *  - Estes testes garantem que a LÓGICA de comparação é robusta a ordem,
 *    espaço em branco e casos vazios — sem precisar Docker.
 *
 * Se o fingerprint mudar de forma "legítima" (por exemplo, mudamos o
 * algoritmo de canonicalize), todos os snapshots em produção precisam ser
 * regerados. Por isso o canonicalize é coberto por testes que lockaram
 * propriedades semânticas (idempotência, ordem-invariância) — não bytewise.
 *
 * @owner: @dba + @tester
 * @card: 3.1b — Fase 2
 */
import { describe, it, expect } from 'vitest'
import {
  canonicalize,
  fingerprint,
  diffModels,
  isEmptyDiff,
  formatDiff,
  type SchemaModel,
  type ColumnModel,
} from '../../scripts/dump-test-schema'

const col = (
  name: string,
  type = 'text',
  nullable = false,
  defaultVal: string | null = null,
): ColumnModel => ({ name, type, nullable, default: defaultVal })

const baseModel: SchemaModel = {
  extensions: ['pgcrypto'],
  enums: [
    { name: 'Plan', values: ['FREE', 'PRO'] },
    { name: 'Role', values: ['FREE', 'PRO', 'ADMIN'] },
  ],
  tables: [
    {
      name: 'users',
      columns: [col('id', 'uuid'), col('email', 'text')],
      reloptions: ['toast_tuple_target=4096'],
    },
    {
      name: 'sessions',
      columns: [col('id', 'uuid'), col('user_id', 'uuid')],
      reloptions: [],
    },
  ],
  indexes: [
    {
      table: 'users',
      name: 'users_email_key',
      definition:
        'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)',
    },
  ],
  constraints: [
    {
      table: 'users',
      name: 'users_pkey',
      type: 'p',
      definition: 'PRIMARY KEY (id)',
    },
  ],
}

describe('schema-drift — canonicalize', () => {
  it('é determinístico (mesmo input → mesmo output)', () => {
    const a = canonicalize(baseModel)
    const b = canonicalize(baseModel)
    expect(a).toBe(b)
  })

  it('é invariante à ordem das listas', () => {
    const reordered: SchemaModel = {
      extensions: [...baseModel.extensions].reverse(),
      enums: [...baseModel.enums].reverse(),
      tables: [...baseModel.tables].reverse().map((t) => ({
        ...t,
        columns: [...t.columns].reverse(),
        reloptions: [...t.reloptions].reverse(),
      })),
      indexes: [...baseModel.indexes].reverse(),
      constraints: [...baseModel.constraints].reverse(),
    }
    expect(canonicalize(reordered)).toBe(canonicalize(baseModel))
  })

  it('é invariante a whitespace nas definitions', () => {
    const noisy: SchemaModel = {
      ...baseModel,
      indexes: [
        {
          ...baseModel.indexes[0],
          definition:
            '   CREATE   UNIQUE   INDEX   users_email_key   ON   public.users   USING   btree   (email)   ',
        },
      ],
      constraints: [
        {
          ...baseModel.constraints[0],
          definition: '  PRIMARY    KEY    (id)  ',
        },
      ],
    }
    expect(canonicalize(noisy)).toBe(canonicalize(baseModel))
  })

  it('é sensível ao ADD de coluna (drift real)', () => {
    const withNewColumn: SchemaModel = {
      ...baseModel,
      tables: baseModel.tables.map((t) =>
        t.name === 'users'
          ? { ...t, columns: [...t.columns, col('created_at', 'timestamp')] }
          : t,
      ),
    }
    expect(canonicalize(withNewColumn)).not.toBe(canonicalize(baseModel))
  })

  it('é sensível à mudança de tipo de coluna', () => {
    const typeChanged: SchemaModel = {
      ...baseModel,
      tables: baseModel.tables.map((t) =>
        t.name === 'users'
          ? {
              ...t,
              columns: t.columns.map((c) =>
                c.name === 'id' ? { ...c, type: 'integer' } : c,
              ),
            }
          : t,
      ),
    }
    expect(canonicalize(typeChanged)).not.toBe(canonicalize(baseModel))
  })

  it('é sensível à mudança de nullable', () => {
    const nullableChanged: SchemaModel = {
      ...baseModel,
      tables: baseModel.tables.map((t) =>
        t.name === 'users'
          ? {
              ...t,
              columns: t.columns.map((c) =>
                c.name === 'email' ? { ...c, nullable: true } : c,
              ),
            }
          : t,
      ),
    }
    expect(canonicalize(nullableChanged)).not.toBe(canonicalize(baseModel))
  })
})

describe('schema-drift — fingerprint', () => {
  it('produz hash hex de 64 chars (SHA-256)', () => {
    const fp = fingerprint(baseModel)
    expect(fp).toMatch(/^[a-f0-9]{64}$/)
  })

  it('é idêntico para inputs canonicamente equivalentes', () => {
    const reordered: SchemaModel = {
      ...baseModel,
      enums: [...baseModel.enums].reverse(),
    }
    expect(fingerprint(reordered)).toBe(fingerprint(baseModel))
  })

  it('muda quando o schema muda', () => {
    const changed: SchemaModel = {
      ...baseModel,
      extensions: ['pgcrypto', 'uuid-ossp'],
    }
    expect(fingerprint(changed)).not.toBe(fingerprint(baseModel))
  })
})

describe('schema-drift — diffModels', () => {
  it('retorna diff vazio para models idênticos', () => {
    const diff = diffModels(baseModel, baseModel)
    expect(isEmptyDiff(diff)).toBe(true)
  })

  it('detecta extension adicionada', () => {
    const next: SchemaModel = {
      ...baseModel,
      extensions: ['pgcrypto', 'uuid-ossp'],
    }
    const diff = diffModels(baseModel, next)
    expect(diff.extensions.added).toEqual(['uuid-ossp'])
    expect(diff.extensions.removed).toEqual([])
    expect(isEmptyDiff(diff)).toBe(false)
  })

  it('detecta extension removida', () => {
    const next: SchemaModel = { ...baseModel, extensions: [] }
    const diff = diffModels(baseModel, next)
    expect(diff.extensions.removed).toEqual(['pgcrypto'])
  })

  it('detecta enum adicionado', () => {
    const next: SchemaModel = {
      ...baseModel,
      enums: [
        ...baseModel.enums,
        { name: 'JobStatus', values: ['PENDING', 'DONE'] },
      ],
    }
    const diff = diffModels(baseModel, next)
    expect(diff.enums.added).toEqual(['JobStatus'])
    expect(diff.enums.changed).toEqual([])
  })

  it('detecta enum com valor novo (changed)', () => {
    const next: SchemaModel = {
      ...baseModel,
      enums: baseModel.enums.map((e) =>
        e.name === 'Plan' ? { ...e, values: [...e.values, 'ENTERPRISE'] } : e,
      ),
    }
    const diff = diffModels(baseModel, next)
    expect(diff.enums.changed).toEqual(['Plan'])
    expect(diff.enums.added).toEqual([])
  })

  it('detecta tabela com coluna nova (changed)', () => {
    const next: SchemaModel = {
      ...baseModel,
      tables: baseModel.tables.map((t) =>
        t.name === 'users'
          ? { ...t, columns: [...t.columns, col('created_at', 'timestamp')] }
          : t,
      ),
    }
    const diff = diffModels(baseModel, next)
    expect(diff.tables.changed).toEqual(['users'])
  })

  it('detecta tabela removida', () => {
    const next: SchemaModel = {
      ...baseModel,
      tables: baseModel.tables.filter((t) => t.name !== 'sessions'),
    }
    const diff = diffModels(baseModel, next)
    expect(diff.tables.removed).toEqual(['sessions'])
  })

  it('detecta índice novo escopado por tabela', () => {
    const next: SchemaModel = {
      ...baseModel,
      indexes: [
        ...baseModel.indexes,
        {
          table: 'sessions',
          name: 'idx_sessions_user',
          definition:
            'CREATE INDEX idx_sessions_user ON public.sessions USING btree (user_id)',
        },
      ],
    }
    const diff = diffModels(baseModel, next)
    expect(diff.indexes.added).toEqual(['sessions.idx_sessions_user'])
  })

  it('detecta índice com definition mudada (changed, não added+removed)', () => {
    const next: SchemaModel = {
      ...baseModel,
      indexes: baseModel.indexes.map((i) =>
        i.name === 'users_email_key'
          ? {
              ...i,
              definition:
                'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (lower(email))',
            }
          : i,
      ),
    }
    const diff = diffModels(baseModel, next)
    expect(diff.indexes.changed).toEqual(['users.users_email_key'])
    expect(diff.indexes.added).toEqual([])
    expect(diff.indexes.removed).toEqual([])
  })

  it('detecta constraint com tipo mudado', () => {
    const next: SchemaModel = {
      ...baseModel,
      constraints: baseModel.constraints.map((c) =>
        c.name === 'users_pkey' ? { ...c, type: 'u' as const } : c,
      ),
    }
    const diff = diffModels(baseModel, next)
    expect(diff.constraints.changed).toEqual(['users.users_pkey'])
  })

  it('NÃO detecta drift por whitespace nas definitions', () => {
    const next: SchemaModel = {
      ...baseModel,
      indexes: [
        {
          ...baseModel.indexes[0],
          definition:
            '   CREATE   UNIQUE   INDEX   users_email_key   ON   public.users   USING   btree   (email)',
        },
      ],
      constraints: [
        {
          ...baseModel.constraints[0],
          definition: ' PRIMARY  KEY  (id) ',
        },
      ],
    }
    const diff = diffModels(baseModel, next)
    expect(isEmptyDiff(diff)).toBe(true)
  })
})

describe('schema-drift — formatDiff', () => {
  it('retorna mensagem clara para diff vazio', () => {
    const diff = diffModels(baseModel, baseModel)
    expect(formatDiff(diff)).toBe('(sem diferenças)')
  })

  it('lista seções com mudanças', () => {
    const next: SchemaModel = {
      ...baseModel,
      extensions: ['pgcrypto', 'uuid-ossp'],
      tables: baseModel.tables.map((t) =>
        t.name === 'users'
          ? { ...t, columns: [...t.columns, col('created_at', 'timestamp')] }
          : t,
      ),
    }
    const diff = diffModels(baseModel, next)
    const out = formatDiff(diff)
    expect(out).toContain('[extensions]')
    expect(out).toContain('+ adicionados: uuid-ossp')
    expect(out).toContain('[tables]')
    expect(out).toContain('~ alterados:   users')
  })

  it('omite seções sem mudanças', () => {
    const next: SchemaModel = { ...baseModel, extensions: [] }
    const diff = diffModels(baseModel, next)
    const out = formatDiff(diff)
    expect(out).toContain('[extensions]')
    expect(out).not.toContain('[enums]')
    expect(out).not.toContain('[tables]')
    expect(out).not.toContain('[indexes]')
    expect(out).not.toContain('[constraints]')
  })

  it('mostra added/removed/changed prefixados de modo distinguível', () => {
    const next: SchemaModel = {
      ...baseModel,
      enums: [
        { name: 'Plan', values: ['FREE', 'PRO', 'ENTERPRISE'] }, // changed
        { name: 'JobStatus', values: ['PENDING'] }, // added
        // Role removed
      ],
    }
    const diff = diffModels(baseModel, next)
    const out = formatDiff(diff)
    expect(out).toMatch(/\+\s+adicionados:.*JobStatus/)
    expect(out).toMatch(/-\s+removidos:.*Role/)
    expect(out).toMatch(/~\s+alterados:.*Plan/)
  })
})
