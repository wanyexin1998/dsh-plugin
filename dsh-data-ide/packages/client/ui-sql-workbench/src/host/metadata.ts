/**
 * Schema introspection for completion — one query, cached per connection.
 *
 * docs/01 N4 rated a PSI-grade parser out of scope, but a column list is not a
 * parser: `information_schema.COLUMNS` answers it for both MySQL and Doris, and
 * five minutes of caching keeps typing from hammering the server.
 *
 * The reader is a port so the route layer and the tests do not need a database:
 * `query` is the same executor the panel's statements go through.
 */

import type { SchemaIndex, SchemaTable } from '../client/completion.ts'
import type { QueryExecutor } from '../execute/core.ts'
import type { ConnectionSpec } from './runtime-specs.ts'

/** What the editor receives: tables with columns, plus freshness facts. */
export interface SchemaSnapshot {
  readonly tables: readonly SchemaTable[]
  readonly fetchedAt: string
  /** True when the row ceiling cut the answer short. */
  readonly truncated: boolean
  /** Where the listing came from; `show` means the catalogue was not readable. */
  readonly source: 'information_schema' | 'show'
  /** Human-readable explanation when the answer is empty or partial. */
  readonly note?: string
}

export interface SchemaReader {
  schema(connId: string, options?: { readonly refresh?: boolean }): Promise<SchemaSnapshot>
}

export interface SchemaReaderDeps {
  /**
   * The *same* resolver the execute path uses.
   *
   * Reading credentials here directly was the bug: execution resolves through
   * the published in-memory spec document, and a second, hand-rolled lookup
   * drifted from it — SQL ran while the schema route claimed "no password".
   * One resolver, two callers.
   */
  readonly resolve: (connId: string) => Promise<ConnectionSpec | undefined>
  readonly executor: QueryExecutor
  readonly now?: () => number
  /** Cache lifetime; completion may be a little stale, but not per keystroke. */
  readonly ttlMs?: number
  /** Row ceiling for one introspection (a warehouse has thousands of columns). */
  readonly maxRows?: number
  /** Table ceiling for the SHOW fallback (one round trip per table). */
  readonly showTables?: number
}

export const SCHEMA_TTL_MS = 5 * 60 * 1000
export const SCHEMA_MAX_ROWS = 20000

/** Quote one SQL string literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** System catalogs nobody wants in a tree. */
const SYSTEM_SCHEMAS = "'information_schema', 'mysql', '__internal_schema', 'sys', 'performance_schema'"

/**
 * Build the introspection statement.
 *
 * @param database - Schema to restrict to, when the connection names one.
 * @param maxRows - Row ceiling.
 */
export function schemaQuery(database: string | undefined, maxRows: number): string {
  const filter = database === undefined ? '' : `\n  AND TABLE_SCHEMA = ${quote(database)}`
  return `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})${filter}
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
LIMIT ${String(maxRows)}`
}

/**
 * Object kinds, so the tree can group Tables and Views the way DataGrip does.
 *
 * A second statement rather than a join: `information_schema` joins are the
 * least portable thing in the catalogue world, and both answers are cached for
 * the same five minutes.
 */
export function kindsQuery(database: string | undefined): string {
  const filter = database === undefined ? '' : `\n  AND TABLE_SCHEMA = ${quote(database)}`
  return `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS})${filter}`
}

/** Fold a `TABLE_TYPE` into the two kinds the tree renders. */
export function toKind(type: unknown): 'table' | 'view' {
  return typeof type === 'string' && /view/i.test(type) ? 'view' : 'table'
}

/** Key one object across schemas: the same name may exist in two databases. */
export function objectKey(schema: string | undefined, name: string): string {
  return `${schema ?? ''}\u0000${name}`
}

/**
 * Fold column rows into the table list the editor and the tree want.
 *
 * Rows are `[schema, table, column, type]`; a snapshot without the schema
 * column (older host build) still folds, just into one namespace.
 */
export function foldSchema(rows: readonly unknown[][], maxRows: number): { tables: SchemaTable[]; truncated: boolean } {
  const tables = new Map<string, { schema?: string; name: string; columns: SchemaTable['columns'][number][] }>()
  for (const row of rows) {
    // Accept both shapes: [schema, table, column, type] and [table, column, type].
    const wide = row.length >= 4
    const schema = wide ? row[0] : undefined
    const table = wide ? row[1] : row[0]
    const column = wide ? row[2] : row[1]
    const type = wide ? row[3] : row[2]
    if (typeof table !== 'string' || typeof column !== 'string') continue
    const key = objectKey(typeof schema === 'string' ? schema : undefined, table)
    const entry = tables.get(key) ?? {
      ...(typeof schema === 'string' ? { schema } : {}),
      name: table,
      columns: [],
    }
    entry.columns.push({ name: column, type: typeof type === 'string' ? type : 'UNKNOWN' })
    tables.set(key, entry)
  }
  return {
    tables: [...tables.values()].map(entry => ({
      name: entry.name,
      columns: entry.columns,
      ...(entry.schema === undefined ? {} : { schema: entry.schema }),
    })),
    truncated: rows.length >= maxRows,
  }
}

/** Attach `kind` to folded tables from a `TABLES` answer. */
export function attachKinds(
  tables: readonly SchemaTable[],
  rows: readonly unknown[][],
): SchemaTable[] {
  const kinds = new Map<string, 'table' | 'view'>()
  for (const row of rows) {
    const [schema, name, type] = row
    if (typeof name !== 'string') continue
    kinds.set(objectKey(typeof schema === 'string' ? schema : undefined, name), toKind(type))
  }
  return tables.map(table => {
    const kind = kinds.get(objectKey(table.schema, table.name))
    return kind === undefined ? table : { ...table, kind }
  })
}

/** Cap on the SHOW fallback: one round trip per table, so keep it small. */
export const SHOW_FALLBACK_TABLES = 60

/** List tables and columns with SHOW, for accounts that cannot read the catalogue. */
async function viaShow(
  executor: QueryExecutor,
  spec: ConnectionSpec,
  database: string,
  connId: string,
  limit: number,
): Promise<{ tables: SchemaTable[]; truncated: boolean; note?: string }> {
  const quoted = `\`${database.replace(/`/g, '')}\``
  // `SHOW FULL TABLES` also reports BASE TABLE vs VIEW; Doris does not implement
  // it, so an error falls back to the plain listing and the kinds stay unknown.
  let names: string[] = []
  const kinds = new Map<string, 'table' | 'view'>()
  try {
    const listing = await executor.query(spec, `SHOW FULL TABLES FROM ${quoted}`, `schema-show-${connId}`)
    for (const row of listing.rows) {
      const name = row[0]
      if (typeof name !== 'string') continue
      names.push(name)
      kinds.set(name, toKind(row[1]))
    }
  } catch {
    const listing = await executor.query(spec, `SHOW TABLES FROM ${quoted}`, `schema-show-${connId}`)
    names = listing.rows
      .map(row => row[0])
      .filter((value): value is string => typeof value === 'string')
  }
  const capped = names.slice(0, limit)

  const tables: SchemaTable[] = []
  for (const name of capped) {
    const quotedName = `\`${name.replace(/`/g, '')}\``
    const columns = await executor.query(spec, `SHOW FULL COLUMNS FROM ${quoted}.${quotedName}`, `schema-show-${connId}`)
    const kind = kinds.get(name)
    tables.push({
      name,
      schema: database,
      ...(kind === undefined ? {} : { kind }),
      columns: columns.rows
        .map(row => ({ name: String(row[0] ?? ''), type: String(row[1] ?? 'UNKNOWN') }))
        .filter(column => column.name !== ''),
    })
  }
  return {
    tables,
    truncated: names.length > limit,
    ...(names.length > limit ? { note: `SHOW 回退只展开了前 ${limit} 张表` } : {}),
  }
}

/** Build the reader over the shared executor, with a per-connection cache. */
export function createSchemaReader(deps: SchemaReaderDeps): SchemaReader {
  const ttl = deps.ttlMs ?? SCHEMA_TTL_MS
  const maxRows = deps.maxRows ?? SCHEMA_MAX_ROWS
  const now = deps.now ?? Date.now
  const cache = new Map<string, { readonly at: number; readonly snapshot: SchemaSnapshot }>()

  return {
    async schema(connId, options = {}) {
      const cached = cache.get(connId)
      if (options.refresh !== true && cached !== undefined && now() - cached.at < ttl) return cached.snapshot

      const spec = await deps.resolve(connId)
      if (spec === undefined) {
        // The execute path resolves the same way, so this means the connection
        // vanished or its password is gone — say both, not just "no password".
        throw new Error('无法读取表结构：连接不存在或没有可用密码（与执行走同一条解析路径）；请在「配置」里重新填写密码后再试')
      }

      const result = await deps.executor.query(spec, schemaQuery(spec.database, maxRows), `schema-${connId}`)
      const folded = foldSchema(result.rows, maxRows)
      let kindsNote: string | undefined
      if (folded.tables.length > 0) {
        try {
          const kinds = await deps.executor.query(spec, kindsQuery(spec.database), `schema-kinds-${connId}`)
          folded.tables = attachKinds(folded.tables, kinds.rows)
        } catch {
          // Grouping is a presentation nicety; the columns are still right.
          kindsNote = '读不到 information_schema.TABLES：表与视图暂不分组'
        }
      }

      // Doris/MySQL hide tables the account cannot SELECT, so an empty catalogue
      // is ambiguous: it may mean "no tables" or "no grants". Ask SHOW next —
      // that path reports the tables of the schema itself.
      let tables = folded.tables
      let truncated = folded.truncated
      let schemaSource: SchemaSnapshot['source'] = 'information_schema'
      let note: string | undefined = kindsNote
      if (tables.length === 0 && spec.database !== undefined) {
        try {
          const fallback = await viaShow(deps.executor, spec, spec.database, connId, deps.showTables ?? SHOW_FALLBACK_TABLES)
          tables = fallback.tables
          truncated = fallback.truncated
          schemaSource = 'show'
          note = fallback.note
        } catch (error) {
          note = `SHOW 回退失败：${(error as Error).message}`
        }
      }
      if (tables.length === 0 && note === undefined) {
        note = '读不到任何表：information_schema 与 SHOW 都是空的，通常是该账号缺少 SELECT 授权'
      }

      const snapshot: SchemaSnapshot = {
        tables,
        fetchedAt: new Date(now()).toISOString(),
        truncated,
        source: schemaSource,
        ...(note === undefined ? {} : { note }),
      }
      cache.set(connId, { at: now(), snapshot })
      return snapshot
    },
  }
}

/** The completion engine's view of a snapshot. */
export function toSchemaIndex(snapshot: SchemaSnapshot): SchemaIndex {
  return { tables: snapshot.tables }
}
