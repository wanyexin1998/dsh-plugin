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
