/**
 * Drift detection do schema snapshot (`tests/fixtures/schema.sql`).
 *
 * Uso:
 *   npm run test:schema:verify              → compara, falha se drift
 *   npm run test:schema:verify -- --update  → atualiza fingerprint após mudança legítima
 *
 * **Por que fingerprint semântico, não diff de texto:**
 * O snapshot DDL é mantido por humanos (com formatação, comentários, ordem
 * estética). Recriar bytewise via introspection é frágil e cria drift falso.
 * Em vez disso, normalizamos o schema em um modelo canônico (ordem
 * lexicográfica em tudo), serializamos e calculamos SHA256. Mudança de
 * formatação no .sql não muda o fingerprint; mudança real (coluna nova,
 * índice removido, default alterado) muda.
 *
 * **Fonte da verdade:**
 *  - `tests/fixtures/schema.sql` é o DDL bonito, lido pelo container.
 *  - `tests/fixtures/schema.fingerprint.json` é o model canônico + hash,
 *    gerado pela última introspection sancionada.
 *  - Os dois DEVEM ser commitados juntos. Drift entre eles = bug.
 *
 * **Modos:**
 *  - Com `DATABASE_URL` ou `SCHEMA_DUMP_URL` setada → introspecta esse banco
 *    (use após `npm run db:migrate` local pra validar que sua migration
 *    bateu o snapshot).
 *  - Sem URL → sobe container Postgres efêmero, aplica `schema.sql`, e
 *    introspecta. Sanity-check do próprio snapshot (CI roda assim).
 *
 * **Quando regenerar o snapshot:**
 *  1. Aplicar a migration em local
 *  2. Regenerar `tests/fixtures/schema.sql` (via MCP Supabase ou `pg_dump --schema-only`)
 *  3. `npm run test:schema:verify -- --update` (atualiza o .fingerprint.json)
 *  4. Commit dos dois arquivos juntos
 *
 * Anti-prod: roteado pelo `safe-env-guard` — operação de "introspectar" é
 * read-only, mas conectar acidental contra prod ainda gera log/auditoria
 * indesejada e mistura ambientes. Bloqueado por padrão.
 *
 * @owner: @dba + @tester
 * @card: 3.1b — Fase 2
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { assertSafeEnvironment } from '../tests/helpers/safe-env-guard'
import {
  startPostgresContainer,
  stopPostgresContainer,
} from '../tests/helpers/testcontainers'

const FINGERPRINT_PATH = resolve(
  __dirname,
  '..',
  'tests',
  'fixtures',
  'schema.fingerprint.json',
)

// ---------------------------------------------------------------------------
// Tipos do model canônico
// ---------------------------------------------------------------------------

export interface EnumModel {
  name: string
  values: string[]
}

export interface ColumnModel {
  name: string
  type: string
  nullable: boolean
  default: string | null
}

export interface TableModel {
  name: string
  columns: ColumnModel[]
  reloptions: string[]
}

export interface IndexModel {
  table: string
  name: string
  definition: string
}

export interface ConstraintModel {
  table: string
  name: string
  type: 'p' | 'u' | 'f' | 'c' | 'x'
  definition: string
}

export interface SchemaModel {
  extensions: string[]
  enums: EnumModel[]
  tables: TableModel[]
  indexes: IndexModel[]
  constraints: ConstraintModel[]
}

export interface SchemaSnapshot {
  schemaVersion: 1
  generatedAt: string
  database: string
  fingerprint: string
  model: SchemaModel
}

// ---------------------------------------------------------------------------
// Funções puras (testáveis sem DB)
// ---------------------------------------------------------------------------

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name)

const byTableName = (
  a: { table: string; name: string },
  b: { table: string; name: string },
) => {
  const t = a.table.localeCompare(b.table)
  return t !== 0 ? t : a.name.localeCompare(b.name)
}

/**
 * Normaliza whitespace/case em definições retornadas pelo pg para que
 * diferenças cosméticas (ex: 2 espaços vs 1) não gerem drift falso.
 */
function normalizeDefinition(def: string): string {
  return def.replace(/\s+/g, ' ').trim()
}

function assertStringArray(value: unknown, ctx: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `[schema-drift] ${ctx} esperava array, recebeu ${typeof value} (${JSON.stringify(value).slice(0, 80)}). ` +
        'Provável bug de cast/parsing no introspectSchema — investigue antes de aceitar fingerprint inválido.',
    )
  }
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(
        `[schema-drift] ${ctx} contém item não-string: ${JSON.stringify(item)}`,
      )
    }
  }
  return value as readonly string[]
}

/**
 * Produz JSON estável (ordem lexicográfica em todas as listas) do model.
 * Usado para fingerprint e para diff legível.
 *
 * Garante que arrays vindos do pg driver realmente sejam arrays (e não
 * strings literal "{a,b,c}" — bug histórico com `name[]`). Falha explícita
 * em vez de hash silenciosamente errado.
 */
export function canonicalize(model: SchemaModel): string {
  const sorted: SchemaModel = {
    extensions: [
      ...assertStringArray(model.extensions, 'model.extensions'),
    ].sort(),
    enums: [...model.enums]
      .map((e) => ({
        ...e,
        values: [
          ...assertStringArray(e.values, `enum.${e.name}.values`),
        ].sort(),
      }))
      .sort(byName),
    tables: [...model.tables]
      .map((t) => ({
        ...t,
        columns: [...t.columns].sort(byName),
        reloptions: [
          ...assertStringArray(t.reloptions, `table.${t.name}.reloptions`),
        ].sort(),
      }))
      .sort(byName),
    indexes: [...model.indexes]
      .map((i) => ({ ...i, definition: normalizeDefinition(i.definition) }))
      .sort(byTableName),
    constraints: [...model.constraints]
      .map((c) => ({ ...c, definition: normalizeDefinition(c.definition) }))
      .sort(byTableName),
  }
  return JSON.stringify(sorted, null, 2)
}

export function fingerprint(model: SchemaModel): string {
  return createHash('sha256').update(canonicalize(model)).digest('hex')
}

export interface SchemaDiff {
  enums: { added: string[]; removed: string[]; changed: string[] }
  tables: { added: string[]; removed: string[]; changed: string[] }
  indexes: { added: string[]; removed: string[]; changed: string[] }
  constraints: { added: string[]; removed: string[]; changed: string[] }
  extensions: { added: string[]; removed: string[] }
}

function diffStringSets(prev: readonly string[], curr: readonly string[]) {
  const prevSet = new Set(prev)
  const currSet = new Set(curr)
  return {
    added: [...currSet].filter((x) => !prevSet.has(x)).sort(),
    removed: [...prevSet].filter((x) => !currSet.has(x)).sort(),
  }
}

function diffNamedItems<T extends { name: string }>(
  prev: T[],
  curr: T[],
  itemEquals: (a: T, b: T) => boolean,
) {
  const prevMap = new Map(prev.map((x) => [x.name, x]))
  const currMap = new Map(curr.map((x) => [x.name, x]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [name, item] of currMap) {
    const prevItem = prevMap.get(name)
    if (!prevItem) added.push(name)
    else if (!itemEquals(prevItem, item)) changed.push(name)
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) removed.push(name)
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  }
}

function diffTableScopedItems<T extends { table: string; name: string }>(
  prev: T[],
  curr: T[],
  itemEquals: (a: T, b: T) => boolean,
) {
  const key = (x: T) => `${x.table}.${x.name}`
  const prevMap = new Map(prev.map((x) => [key(x), x]))
  const currMap = new Map(curr.map((x) => [key(x), x]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [k, item] of currMap) {
    const prevItem = prevMap.get(k)
    if (!prevItem) added.push(k)
    else if (!itemEquals(prevItem, item)) changed.push(k)
  }
  for (const k of prevMap.keys()) {
    if (!currMap.has(k)) removed.push(k)
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  }
}

export function diffModels(prev: SchemaModel, curr: SchemaModel): SchemaDiff {
  return {
    extensions: diffStringSets(prev.extensions, curr.extensions),
    enums: diffNamedItems(
      prev.enums,
      curr.enums,
      (a, b) =>
        JSON.stringify([...a.values].sort()) ===
        JSON.stringify([...b.values].sort()),
    ),
    tables: diffNamedItems(prev.tables, curr.tables, (a, b) => {
      const colsA = JSON.stringify([...a.columns].sort(byName))
      const colsB = JSON.stringify([...b.columns].sort(byName))
      const optsA = JSON.stringify([...a.reloptions].sort())
      const optsB = JSON.stringify([...b.reloptions].sort())
      return colsA === colsB && optsA === optsB
    }),
    indexes: diffTableScopedItems(
      prev.indexes,
      curr.indexes,
      (a, b) =>
        normalizeDefinition(a.definition) === normalizeDefinition(b.definition),
    ),
    constraints: diffTableScopedItems(
      prev.constraints,
      curr.constraints,
      (a, b) =>
        a.type === b.type &&
        normalizeDefinition(a.definition) === normalizeDefinition(b.definition),
    ),
  }
}

export function isEmptyDiff(d: SchemaDiff): boolean {
  const sizes = [
    d.extensions.added.length,
    d.extensions.removed.length,
    d.enums.added.length,
    d.enums.removed.length,
    d.enums.changed.length,
    d.tables.added.length,
    d.tables.removed.length,
    d.tables.changed.length,
    d.indexes.added.length,
    d.indexes.removed.length,
    d.indexes.changed.length,
    d.constraints.added.length,
    d.constraints.removed.length,
    d.constraints.changed.length,
  ]
  return sizes.every((n) => n === 0)
}

export function formatDiff(diff: SchemaDiff): string {
  const lines: string[] = []
  const section = (
    title: string,
    items: { added?: string[]; removed?: string[]; changed?: string[] },
  ) => {
    const total =
      (items.added?.length ?? 0) +
      (items.removed?.length ?? 0) +
      (items.changed?.length ?? 0)
    if (total === 0) return
    lines.push(`\n  [${title}]`)
    if (items.added?.length)
      lines.push(`    + adicionados: ${items.added.join(', ')}`)
    if (items.removed?.length)
      lines.push(`    - removidos:   ${items.removed.join(', ')}`)
    if (items.changed?.length)
      lines.push(`    ~ alterados:   ${items.changed.join(', ')}`)
  }
  section('extensions', diff.extensions)
  section('enums', diff.enums)
  section('tables', diff.tables)
  section('indexes', diff.indexes)
  section('constraints', diff.constraints)
  return lines.join('\n').trim() || '(sem diferenças)'
}

// ---------------------------------------------------------------------------
// Introspection (impure — depende de pg client)
// ---------------------------------------------------------------------------

export async function introspectSchema(client: Client): Promise<SchemaModel> {
  const extensions = await client.query<{ extname: string }>(`
    SELECT extname FROM pg_extension
    WHERE extname NOT IN ('plpgsql')
    ORDER BY extname
  `)

  // Cast explícito pra text[]: pg driver não parseia name[] (tipo nativo do
  // pg_enum), retorna como string literal "{a,b,c}". Cast garante array JS.
  const enums = await client.query<{ enum_name: string; values: string[] }>(`
    SELECT t.typname AS enum_name,
           array_agg(e.enumlabel::text ORDER BY e.enumsortorder)::text[] AS values
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname
  `)

  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)

  const tableModels: TableModel[] = []
  for (const row of tables.rows) {
    const tableName = row.table_name
    const cols = await client.query<{
      column_name: string
      data_type: string
      udt_name: string
      is_nullable: string
      column_default: string | null
      character_maximum_length: number | null
      numeric_precision: number | null
      numeric_scale: number | null
      datetime_precision: number | null
    }>(
      `
      SELECT column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale,
             datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
      [tableName],
    )

    const reloptionsResult = await client.query<{
      reloptions: string[] | null
    }>(
      `
      SELECT c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
    `,
      [tableName],
    )
    const reloptions = reloptionsResult.rows[0]?.reloptions ?? []

    tableModels.push({
      name: tableName,
      columns: cols.rows.map((c) => ({
        name: c.column_name,
        type: formatColumnType(c),
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
      })),
      reloptions,
    })
  }

  const indexes = await client.query<{
    table_name: string
    index_name: string
    indexdef: string
  }>(`
    SELECT t.relname AS table_name,
           i.relname AS index_name,
           pg_get_indexdef(ix.indexrelid) AS indexdef
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relkind = 'r'
    ORDER BY t.relname, i.relname
  `)

  const constraints = await client.query<{
    table_name: string
    constraint_name: string
    contype: 'p' | 'u' | 'f' | 'c' | 'x'
    definition: string
  }>(`
    SELECT t.relname AS table_name,
           c.conname AS constraint_name,
           c.contype,
           pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.relname, c.conname
  `)

  return {
    extensions: extensions.rows.map((r) => r.extname),
    enums: enums.rows.map((r) => ({ name: r.enum_name, values: r.values })),
    tables: tableModels,
    indexes: indexes.rows.map((r) => ({
      table: r.table_name,
      name: r.index_name,
      definition: r.indexdef,
    })),
    constraints: constraints.rows.map((r) => ({
      table: r.table_name,
      name: r.constraint_name,
      type: r.contype,
      definition: r.definition,
    })),
  }
}

function formatColumnType(c: {
  data_type: string
  udt_name: string
  character_maximum_length: number | null
  numeric_precision: number | null
  numeric_scale: number | null
  datetime_precision: number | null
}): string {
  // udt_name é mais preciso para tipos custom (enums) e variações;
  // information_schema.data_type usa nomes "amigáveis" que perdem detalhe.
  // Para tipos básicos usamos data_type; para USER-DEFINED retornamos udt_name.
  if (c.data_type === 'USER-DEFINED') return c.udt_name
  if (c.data_type === 'ARRAY') return `${c.udt_name}[]`
  let base = c.data_type
  if (c.character_maximum_length) base += `(${c.character_maximum_length})`
  else if (c.numeric_precision != null && c.data_type === 'numeric') {
    base += `(${c.numeric_precision}${c.numeric_scale ? `,${c.numeric_scale}` : ''})`
  }
  return base
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function maskUrlForLog(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return 'unknown-host'
  }
}

async function getClientAndCleanup(): Promise<{
  client: Client
  source: string
  cleanup: () => Promise<void>
}> {
  const explicitUrl = process.env.SCHEMA_DUMP_URL ?? process.env.DATABASE_URL
  if (explicitUrl) {
    assertSafeEnvironment({
      context: 'schema-verify',
      urlEnvVars: ['SCHEMA_DUMP_URL', 'DATABASE_URL'],
    })
    const client = new Client({ connectionString: explicitUrl })
    await client.connect()
    return {
      client,
      source: maskUrlForLog(explicitUrl),
      cleanup: () => client.end(),
    }
  }

  // Sem URL → sobe container e aplica schema.sql. NODE_ENV gate ainda vale.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[schema-verify] NODE_ENV=production: recuso subir container.',
    )
  }
  console.log(
    '[schema-verify] Sem DATABASE_URL/SCHEMA_DUMP_URL — subindo container efêmero...',
  )
  const uri = await startPostgresContainer()
  const client = new Client({ connectionString: uri })
  await client.connect()
  return {
    client,
    source: 'container:postgres-17-alpine',
    cleanup: async () => {
      await client.end()
      await stopPostgresContainer()
    },
  }
}

function loadStoredSnapshot(): SchemaSnapshot | null {
  if (!existsSync(FINGERPRINT_PATH)) return null
  const raw = readFileSync(FINGERPRINT_PATH, 'utf8')
  const parsed = JSON.parse(raw) as SchemaSnapshot
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `[schema-verify] schema.fingerprint.json com schemaVersion=${parsed.schemaVersion} desconhecido (esperado: 1).`,
    )
  }
  return parsed
}

function writeSnapshot(snapshot: SchemaSnapshot): void {
  writeFileSync(
    FINGERPRINT_PATH,
    JSON.stringify(snapshot, null, 2) + '\n',
    'utf8',
  )
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const update = args.has('--update') || args.has('--write')

  const { client, source, cleanup } = await getClientAndCleanup()

  let liveModel: SchemaModel
  try {
    liveModel = await introspectSchema(client)
  } finally {
    await cleanup()
  }

  const liveFingerprint = fingerprint(liveModel)
  const snapshot: SchemaSnapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    database: source,
    fingerprint: liveFingerprint,
    model: liveModel,
  }

  const stored = loadStoredSnapshot()

  if (!stored) {
    if (!update) {
      console.error(
        `[schema-verify] schema.fingerprint.json não existe.\n` +
          `Rode com --update para gerar a partir do banco atual (${source}).`,
      )
      process.exit(1)
    }
    writeSnapshot(snapshot)
    console.log(
      `[schema-verify] Fingerprint inicial criado.\n` +
        `  origem: ${source}\n` +
        `  hash:   ${liveFingerprint.slice(0, 16)}...\n` +
        `  arquivo: ${FINGERPRINT_PATH}`,
    )
    process.exit(0)
  }

  if (stored.fingerprint === liveFingerprint) {
    console.log(
      `[schema-verify] OK — schema sincronizado.\n` +
        `  origem: ${source}\n` +
        `  hash:   ${liveFingerprint.slice(0, 16)}...`,
    )
    process.exit(0)
  }

  // Drift
  const diff = diffModels(stored.model, liveModel)
  console.error('[schema-verify] DRIFT DETECTADO')
  console.error(`  fingerprint esperado: ${stored.fingerprint.slice(0, 16)}...`)
  console.error(`  fingerprint atual:    ${liveFingerprint.slice(0, 16)}...`)
  console.error(`  origem: ${source}`)
  console.error(`  registrado em: ${stored.generatedAt} (${stored.database})`)
  console.error(`\nDiff:\n${formatDiff(diff)}`)
  console.error(
    `\nAção:\n` +
      `  1. Confirmar que a divergência é intencional (revisar diff acima)\n` +
      `  2. Regenerar tests/fixtures/schema.sql via MCP Supabase ou pg_dump\n` +
      `  3. Rodar: npm run test:schema:verify -- --update\n` +
      `  4. Commitar schema.sql + schema.fingerprint.json juntos`,
  )

  if (update) {
    writeSnapshot(snapshot)
    console.error(
      `\n[schema-verify] --update ATIVO: schema.fingerprint.json atualizado.\n` +
        `LEMBRE de regenerar tests/fixtures/schema.sql também — fingerprint sozinho não recria DDL.`,
    )
  }

  process.exit(1)
}

// Só roda CLI se for invocado direto (não em import via testes).
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
