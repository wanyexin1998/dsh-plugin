/**
 * Schema tools for the agent (docs/09 B1).
 *
 * The panel has had `GET /dsh-data-ide/schema` all along; the agent did not, so it
 * had to `SELECT * … LIMIT 1` and guess columns. These two tools are thin
 * formatters over the *same* reader the panel uses (`host/metadata.ts`), so the
 * agent and the tree cannot disagree about what exists.
 *
 * Kept free of SDK imports, like `tools.ts`, so both are unit-testable.
 */

import type { SchemaTable } from '../src/client/completion.ts'
import type { SchemaSnapshot } from '../src/host/metadata.ts'

export const GET_SCHEMA = 'get_schema'
export const LIST_TABLES = 'list_tables'

/** One table as `list_tables` reports it: names only, cheap on context. */
export interface TableSummary {
  readonly schema?: string
  readonly kind?: 'table' | 'view'
  readonly name: string
  readonly columns: number
}

export interface TableList {
  readonly ok: true
  readonly source: SchemaSnapshot['source']
  readonly truncated: boolean
  readonly tables: readonly TableSummary[]
  readonly note?: string
}

export interface SchemaDump {
  readonly ok: true
  readonly source: SchemaSnapshot['source']
  readonly truncated: boolean
  readonly fetchedAt: string
  readonly tables: readonly SchemaTable[]
  readonly note?: string
}

/** `schema.table` when the namespace is known, bare name otherwise. */
function qualified(table: SchemaTable): string {
  return table.schema === undefined ? table.name : `${table.schema}.${table.name}`
}

/** True when `filter` names this table, with or without its schema. */
function matches(table: SchemaTable, filter: string): boolean {
  return table.name === filter || qualified(table) === filter
}

/** Compact listing: names, kind and column count. */
export function formatTableList(snapshot: SchemaSnapshot): TableList {
  return {
    ok: true,
    source: snapshot.source,
    truncated: snapshot.truncated,
    tables: snapshot.tables.map(table => ({
      ...(table.schema === undefined ? {} : { schema: table.schema }),
      ...(table.kind === undefined ? {} : { kind: table.kind }),
      name: table.name,
      columns: table.columns.length,
    })),
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
  }
}

/**
 * Full columns, optionally narrowed to one table.
 *
 * The filter is what keeps this usable inside a context window: a warehouse has
 * hundreds of tables, and an agent almost always wants one of them.
 */
export function formatSchema(snapshot: SchemaSnapshot, filter?: string): SchemaDump {
  const tables = filter === undefined ? snapshot.tables : snapshot.tables.filter(table => matches(table, filter))
  return {
    ok: true,
    source: snapshot.source,
    truncated: snapshot.truncated,
    fetchedAt: snapshot.fetchedAt,
    tables,
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
  }
}
