/**
 * Object browser model: schema → tables/views → columns.
 *
 * DataGrip's Database Explorer is a four-level tree (data source → database or
 * schema → Tables/Views folders → object → columns), and the actions people
 * actually use hang off the object node: `Edit Data` (F4), `Jump to Query
 * Console`, `Go to DDL` (Ctrl+B), `Copy Reference`, `Refresh`. JetBrains'
 * explorer docs (2026-08) list those verbatim; this module is the pure half of
 * that: grouping, filtering, quoting and menu placement, all testable without a
 * DOM.
 */

import type { SchemaTable } from './completion.ts'

/** One database/schema and the objects inside it, already split by kind. */
export interface SchemaGroup {
  readonly schema: string
  readonly tables: readonly SchemaTable[]
  readonly views: readonly SchemaTable[]
}

/** A `SHOW CREATE …` request, addressed the way the tree shows it. */
export interface DdlTarget {
  readonly schema: string
  readonly table: string
  readonly kind?: 'table' | 'view'
}

/** What a node key looks like in the expansion set. */
export function schemaKey(schema: string): string {
  return `schema:${schema}`
}

export function groupKey(schema: string, kind: 'table' | 'view'): string {
  return `group:${schema}:${kind}`
}

export function tableKey(table: SchemaTable): string {
  return `table:${table.schema ?? ''}:${table.name}`
}

export function columnKey(table: SchemaTable, column: string): string {
  return `column:${table.schema ?? ''}:${table.name}:${column}`
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name, 'zh-Hans-CN')
}

/**
 * Fold the flat snapshot into the tree's shape.
 *
 * A snapshot without `schema` (old host build, or the SHOW fallback of a
 * connection that names its database) folds into one unnamed namespace, which
 * the caller renders without the extra level — no fake "default" node.
 */
export function groupBySchema(tables: readonly SchemaTable[]): readonly SchemaGroup[] {
  const groups = new Map<string, { tables: SchemaTable[]; views: SchemaTable[] }>()
  for (const table of tables) {
    const schema = table.schema ?? ''
    const group = groups.get(schema) ?? { tables: [], views: [] }
    if (table.kind === 'view') group.views.push(table)
    else group.tables.push(table)
    groups.set(schema, group)
  }
  return [...groups.entries()]
    .map(([schema, group]) => ({
      schema,
      tables: [...group.tables].sort(byName),
      views: [...group.views].sort(byName),
    }))
    .sort((left, right) => left.schema.localeCompare(right.schema, 'zh-Hans-CN'))
}

/**
 * Keep only what matches `needle`.
 *
 * A table survives when its own name matches, and also when one of its columns
 * does (then only the matching columns are kept): searching for a column and
 * landing on the table is the whole point of a filter in an object browser.
 */
export function filterGroups(groups: readonly SchemaGroup[], needle: string): readonly SchemaGroup[] {
  const lowered = needle.trim().toLowerCase()
  if (lowered === '') return groups
  const keep = (table: SchemaTable): SchemaTable | undefined => {
    if (table.name.toLowerCase().includes(lowered)) return table
    const columns = table.columns.filter(column => column.name.toLowerCase().includes(lowered))
    return columns.length === 0 ? undefined : { ...table, columns }
  }
  const fold = (list: readonly SchemaTable[]): SchemaTable[] =>
    list.map(keep).filter((table): table is SchemaTable => table !== undefined)
  return groups
    .map(group => ({ schema: group.schema, tables: fold(group.tables), views: fold(group.views) }))
    .filter(group => group.tables.length > 0 || group.views.length > 0)
}

/** One-line summary for the object toolbar: `2 个库 · 42 个对象 · 含 5 视图`. */
export function describeSchema(tables: readonly SchemaTable[]): string {
  if (tables.length === 0) return '0 个对象'
  const schemas = groupBySchema(tables).filter(group => group.schema !== '').length
  const views = tables.filter(table => table.kind === 'view').length
  const parts: string[] = []
  if (schemas > 1) parts.push(`${String(schemas)} 个库`)
  parts.push(`${String(tables.length)} 个对象`)
  if (views > 0) parts.push(`含 ${String(views)} 视图`)
  return parts.join(' · ')
}

/** Quote an identifier for MySQL/Doris (backticks, doubled inside). */export function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/** `schema`.`table`, or just the table when the snapshot had no schema. */
export function qualifiedName(table: SchemaTable): string {
  const name = quoteIdent(table.name)
  return table.schema === undefined || table.schema === '' ? name : `${quoteIdent(table.schema)}.${name}`
}

/** Rows `Edit Data` asks for: DataGrip's data editor pages too. */
export const OPEN_DATA_LIMIT = 100

/** The statement `Edit Data` runs here — a console is our data editor. */
export function openDataSql(table: SchemaTable, limit: number = OPEN_DATA_LIMIT): string {
  return `SELECT * FROM ${qualifiedName(table)} LIMIT ${String(limit)}`
}

/** Statement that reads an object's DDL. */
export function ddlSql(target: DdlTarget): string {
  const name = target.schema === '' ? quoteIdent(target.table) : `${quoteIdent(target.schema)}.${quoteIdent(target.table)}`
  return `SHOW CREATE ${target.kind === 'view' ? 'VIEW' : 'TABLE'} ${name}`
}

/**
 * `SELECT <columns> FROM <object>` for the object-tree generator.
 *
 * Columns are quoted the same way as the object name, so Chinese or otherwise
 * label-like column names survive the insertion.
 *
 * @param table - One table or view from the schema snapshot.
 */
export function selectFromTableSql(table: SchemaTable): string {
  const columns = table.columns.length === 0
    ? '*'
    : table.columns.map(column => quoteIdent(column.name)).join(',\n  ')
  return `SELECT ${columns}\nFROM ${qualifiedName(table)}`
}

/** Bare, quoted column list for templates and hand-written INSERTs. */
export function columnListSql(table: SchemaTable): string {
  return table.columns.map(column => quoteIdent(column.name)).join(', ')
}

/**
 * `SELECT` that summarises a table: total rows plus per-column non-null counts
 * (SQL-404, the lightweight "表概览").
 *
 * Row counts on huge tables are expensive but this is user-triggered and explicit;
 * an empty column list degrades to a bare COUNT so views without column metadata
 * still answer the headline number.
 *
 * @param table - Object to summarise.
 */
export function overviewSql(table: SchemaTable): string {
  const counts = table.columns.map(column => `  COUNT(${quoteIdent(column.name)}) AS ${quoteIdent(`${column.name}_非空`)}`)
  return `SELECT COUNT(*) AS ${quoteIdent('总行数')}${counts.length === 0 ? '' : `,\n${counts.join(',\n')}`}\nFROM ${qualifiedName(table)}`
}

/**
 * JOIN skeleton between two objects (SQL-212).
 *
 * Guesses ON from the first column name the two tables share (the common
 * `id`/`order_id` convention); without a shared name the ON clause is left as a
 * TODO so the generated statement is honest about needing a join key.
 *
 * @param left - Table already chosen in the tree.
 * @param right - Table picked for the join.
 */
export function joinSql(left: SchemaTable, right: SchemaTable): string {
  const rightNames = new Set(right.columns.map(column => column.name))
  const shared = left.columns.find(column => rightNames.has(column.name))
  const on = shared === undefined
    ? 'ON /* TODO: 没有同名列，请补 ON 条件 */'
    : `ON ${qualifiedName(left)}.${quoteIdent(shared.name)} = ${qualifiedName(right)}.${quoteIdent(shared.name)}`
  return `SELECT *\nFROM ${qualifiedName(left)}\nJOIN ${qualifiedName(right)} ${on}`
}

/** One hit of the global object search: a table, or one column of it. */
export interface ObjectMatch {
  readonly table: SchemaTable
  /** Present when the query matched a column name rather than the table. */
  readonly column?: { readonly name: string; readonly type: string }
}

/**
 * Fuzzy object search across every table and column (SQL-214).
 *
 * Table-name matches rank before column matches, and each kind keeps snapshot
 * order so repeated searches are deterministic. Case-insensitive substring
 * matching is enough here: identifiers are short and the list is capped.
 *
 * @param tables - Whole schema snapshot.
 * @param query - Search text; empty means "nothing to show" (the palette shows
 *   recent/all entries only when the caller passes an empty query).
 * @param limit - Safety cap (default 50).
 */
export function searchObjects(
  tables: readonly SchemaTable[],
  query: string,
  limit = 50,
): readonly ObjectMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const matches: ObjectMatch[] = []
  for (const table of tables) {
    if (table.name.toLowerCase().includes(needle)) {
      matches.push({ table })
      if (matches.length >= limit) return matches
    }
  }
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.name.toLowerCase().includes(needle)) {
        matches.push({ table, column })
        if (matches.length >= limit) return matches
      }
    }
  }
  return matches
}

/**
 * Pick the DDL out of a `SHOW CREATE …` row.
 *
 * MySQL returns `[table, ddl]`, Doris `[View, Create View, character_set_client,
 * collation_connection]` — the statement is the cell that starts with CREATE.
 * A row with no statement yields `''`: the caller then says the DDL is missing
 * instead of showing a bare table name as if it were one.
 */
export function ddlFromRow(row: readonly unknown[] | undefined): string {
  if (row === undefined) return ''
  const cells = row.filter((cell): cell is string => typeof cell === 'string')
  return cells.find(cell => /^\s*CREATE/i.test(cell)) ?? ''
}

/** `docs` column of the DDL dialog title, e.g. `SHOW CREATE TABLE · db.t`. */
export function ddlTitle(target: DdlTarget): string {
  const name = target.schema === '' ? target.table : `${target.schema}.${target.table}`
  return `${target.kind === 'view' ? 'VIEW' : 'TABLE'} · ${name}`
}

/** Place a context menu at a point, flipping away from the viewport edges. */
export function menuPosition(
  point: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const margin = 4
  const left = point.x + size.width + margin > viewport.width
    ? Math.max(margin, point.x - size.width)
    : Math.max(margin, point.x)
  const top = point.y + size.height + margin > viewport.height
    ? Math.max(margin, point.y - size.height)
    : Math.max(margin, point.y)
  return { left, top }
}

/** Menu item description, kept out of the component so tests can name them. */
export interface MenuItem {
  readonly id: string
  readonly label: string
  /** Right-hand hint, like DataGrip's shortcut column. */
  readonly hint?: string
  readonly run: () => void
}

/** Width/height the menu is laid out at; only used for edge flipping. */
export const MENU_SIZE = { width: 208, height: 232 } as const

/**
 * One statement that summarises a table: total rows plus one COUNT per column
 * (the statistics half of the table-overview dialog, SQL-404).
 *
 * The aliases (`n1`, `n2`, …) are read back by index, so the component does not
 * depend on the driver echoing Chinese aliases. Objects without column metadata
 * (Doris reports no columns for views) degrade to a bare COUNT — the dialog then
 * shows the headline number and says why the rest is missing.
 *
 * @param table - Object to summarise.
 */
export function overviewStatsSql(table: SchemaTable): string {
  const total = `SELECT COUNT(*) AS ${quoteIdent('总行数')}`
  const counts = table.columns.map((column, index) =>
    `  COUNT(${quoteIdent(column.name)}) AS ${quoteIdent(`n${String(index + 1)}`)}`,
  )
  const select = counts.length === 0 ? total : `${total},\n${counts.join(',\n')}`
  return `${select}\nFROM ${qualifiedName(table)}`
}

/** Default sample size of the table-overview dialog. */
export const OVERVIEW_SAMPLE_LIMIT = 20

/** Ceiling for the sample size; a hand-written call may not ask for the table. */
export const OVERVIEW_SAMPLE_LIMIT_MAX = 1000

/**
 * `SELECT * FROM <object> LIMIT n` — the sample half of the overview dialog.
 *
 * The limit is clamped into `[1, OVERVIEW_SAMPLE_LIMIT_MAX]`; a non-finite value
 * falls back to the default so a caller cannot accidentally ask for everything.
 *
 * @param table - Object to sample.
 * @param limit - Requested row count (default 20).
 */
export function overviewSampleSql(table: SchemaTable, limit: number = OVERVIEW_SAMPLE_LIMIT): string {
  const safe = Number.isFinite(limit)
    ? Math.min(OVERVIEW_SAMPLE_LIMIT_MAX, Math.max(1, Math.floor(limit)))
    : OVERVIEW_SAMPLE_LIMIT
  return `SELECT * FROM ${qualifiedName(table)} LIMIT ${String(safe)}`
}

/**
 * Null rate as the overview table shows it: `0%`, `100%`, or one decimal.
 *
 * The total comes from the same statement as the counts, so a rate is only
 * unknown when the statement itself answered nothing usable (`—`, never `NaN%`).
 *
 * @param nonNull - Non-null count of one column.
 * @param total - Row count of the object.
 */
export function nullRateText(nonNull: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(nonNull)) return '—'
  const nulls = Math.max(0, total - Math.max(0, nonNull))
  const rate = (nulls / total) * 100
  if (rate === 0) return '0%'
  if (rate === 100) return '100%'
  return `${rate.toFixed(1)}%`
}
