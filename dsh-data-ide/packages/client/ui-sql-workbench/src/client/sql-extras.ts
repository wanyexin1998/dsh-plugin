/**
 * The single integration point for the editor-intelligence modules.
 *
 * `buildExtrasExtension({ schema })` returns one `Extension` the editor adds
 * next to the SQL dialect. It bundles three things:
 *
 *  1. **completion sources** (schema-aware tables/columns/aliases plus the
 *     function catalogue), added through `EditorState.languageData` so
 *     `lang-sql`'s own keyword and schema sources keep working;
 *  2. **lint decorations** (`sql-lint.ts`) — wavy underlines, no
 *     `@codemirror/lint` dependency;
 *  3. **hover cards** for tables, columns and functions, built on
 *     `hoverTooltip` from `@codemirror/view`.
 *
 * Wiring note for the assembler (`editor-cm.ts`): the schema snapshot arrives
 * asynchronously, and `buildExtensions` keeps the dialect in a `Compartment`.
 * Build this extension from the *same* snapshot and put it in that compartment:
 *
 * ```ts
 * options.language.of([sqlExtension(options.schema), buildExtrasExtension({ schema: options.schema })])
 * ```
 *
 * Reconfiguring then swaps the dialect, the completion sources and the lint
 * schema in one transaction, so nothing goes stale.
 */

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view'

import type { SchemaIndex, SchemaTable } from './completion.ts'
import { sqlCompletionExtras, sqlFunctionCompletions } from './completion-extra.ts'
import { resolveQualified, resolveTableRef, scanTableRefs } from './expand-star.ts'
import type { TableRef } from './expand-star.ts'
import { findSqlFunction } from './sql-functions.ts'
import type { SqlFunction, SqlFunctionCategory } from './sql-functions.ts'
import { sqlLintExtension } from './sql-lint.ts'
import { statementRange, tokenizeSql } from './sql-format.ts'
import type { SqlToken } from './sql-format.ts'

/** What the hover card says about one symbol. */
export interface SymbolInfo {
  /** First offset the card is about (used as the tooltip's anchor). */
  readonly from: number
  /** Offset just past the symbol. */
  readonly to: number
  /** What kind of object it is, in Chinese: 表 / 视图 / 列 / 函数. */
  readonly kind: string
  /** Name shown in the card's heading. */
  readonly title: string
  /** Detail rows under the heading. */
  readonly lines: readonly string[]
}

const CATEGORY_LABELS: Readonly<Record<SqlFunctionCategory, string>> = {
  aggregate: '聚合',
  window: '窗口',
  string: '字符串',
  date: '日期',
  numeric: '数值',
  conditional: '条件',
  conversion: '转换',
  json: 'JSON',
  system: '系统',
}

/** How many columns a table's hover card previews before saying "…". */
const COLUMN_PREVIEW = 6

/** One identifier token inside a dotted chain. */
interface ChainPart {
  readonly value: string
  readonly start: number
  readonly end: number
}

/** Is this token a name (plain or backticked)? */
function isName(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && (token.kind === 'word' || token.kind === 'quoted')
}

/**
 * The dotted chain around `pos`: `o.amount`, `dwd.dwd_order`, `t.*`…
 *
 * Returns `null` when the pointer is not on an identifier.
 */
function chainAround(tokens: readonly SqlToken[], pos: number): ChainPart[] | null {
  const anchor = tokens.findIndex(token =>
    token.start <= pos && pos <= token.end && isName(token))
  if (anchor === -1) return null
  let first = anchor
  let last = anchor
  while (tokens[first - 1]?.text === '.' && isName(tokens[first - 2])) first -= 2
  while (tokens[last + 1]?.text === '.' && isName(tokens[last + 2])) last += 2
  const parts: ChainPart[] = []
  for (let index = first; index <= last; index += 1) {
    const token = tokens[index]
    if (!isName(token)) continue
    parts.push({ value: token.value, start: token.start, end: token.end })
  }
  return parts
}

/** The hover card for one table. */
function tableInfo(table: SchemaTable): Omit<SymbolInfo, 'from' | 'to'> {
  const view = table.kind === 'view'
  const lines = [
    `数据库：${table.schema ?? '（连接默认库）'}`,
    `类型：${view ? '视图' : '表'}`,
    `列：${String(table.columns.length)} 个`,
  ]
  for (const column of table.columns.slice(0, COLUMN_PREVIEW)) {
    lines.push(`${column.name}  ${column.type}`)
  }
  if (table.columns.length > COLUMN_PREVIEW) lines.push('…')
  return { kind: view ? '视图' : '表', title: table.name, lines }
}

/** The hover card for one column of a known table, or null when it has no such column. */
function columnInfo(table: SchemaTable, columnName: string): Omit<SymbolInfo, 'from' | 'to'> | null {
  const column = table.columns.find(candidate => candidate.name.toLowerCase() === columnName.toLowerCase())
  if (column === undefined) return null
  const qualified = table.schema === undefined ? table.name : `${table.schema}.${table.name}`
  return { kind: '列', title: column.name, lines: [`类型：${column.type}`, `表：${qualified}`] }
}

/** The hover card for one function from the catalogue. */
function functionInfo(fn: SqlFunction): Omit<SymbolInfo, 'from' | 'to'> {
  return {
    kind: '函数',
    title: fn.name,
    lines: [`签名：${fn.signature}`, `类别：${CATEGORY_LABELS[fn.category]}`, fn.detail],
  }
}

/** Tables the statement mentions that the snapshot can resolve. */
function statementTables(
  tokens: readonly SqlToken[],
  pos: number,
  docLength: number,
  schema: SchemaIndex,
): { ref: TableRef; table: SchemaTable }[] {
  const statement = statementRange(tokens, pos, docLength)
  const tables: { ref: TableRef; table: SchemaTable }[] = []
  for (const ref of scanTableRefs(tokens, statement)) {
    if (ref.derived) continue
    const table = resolveTableRef(schema, ref)
    if (table !== null) tables.push({ ref, table })
  }
  return tables
}

/** Resolve a one-, two- or three-part chain to a symbol card. */
function describeChain(
  parts: readonly ChainPart[],
  tokens: readonly SqlToken[],
  pos: number,
  docLength: number,
  schema: SchemaIndex,
): Omit<SymbolInfo, 'from' | 'to'> | null {
  const from = parts[0] as ChainPart

  if (parts.length === 1) {
    const name = from.value
    // A word is a function only when it is called: `NOW` alone is a name.
    const anchorIndex = tokens.findIndex(token => token.start === from.start)
    const call = tokens[anchorIndex + 1]
    if (call !== undefined && call.kind === 'punct' && call.text === '(') {
      const fn = findSqlFunction(name)
      if (fn !== undefined) return functionInfo(fn)
    }
    const table = resolveQualified(schema, [name])
    if (table !== null) return tableInfo(table)
    const owners = statementTables(tokens, pos, docLength, schema)
      .filter(entry => entry.table.columns.some(column => column.name.toLowerCase() === name.toLowerCase()))
    // Exactly one table owns the name; two candidates would be a guess.
    return owners.length === 1 ? columnInfo((owners[0] as { table: SchemaTable }).table, name) : null
  }

  if (parts.length === 2) {
    const [first, second] = parts as [ChainPart, ChainPart]
    const ref = statementTables(tokens, pos, docLength, schema)
      .find(entry => entry.ref.alias.toLowerCase() === first.value.toLowerCase())
    if (ref !== undefined) return columnInfo(ref.table, second.value)
    const table = resolveQualified(schema, [first.value, second.value])
    return table === null ? null : tableInfo(table)
  }
  if (parts.length === 3) {
    const [first, second, third] = parts as [ChainPart, ChainPart, ChainPart]
    const table = resolveQualified(schema, [first.value, second.value])
    return table === null ? null : columnInfo(table, third.value)
  }
  return null
}

/**
 * The symbol under `pos`, or `null` when the pointer is over nothing useful.
 *
 * Pure on purpose: hover is the hardest thing in this file to test through the
 * DOM, so the resolution lives here where a spec can call it directly.
 */
export function symbolInfoAt(sql: string, pos: number, schema: SchemaIndex | undefined): SymbolInfo | null {
  if (schema === undefined) return null
  const tokens = tokenizeSql(sql)
  const parts = chainAround(tokens, pos)
  if (parts === null) return null
  const description = describeChain(parts, tokens, pos, sql.length, schema)
  if (description === null) return null
  const first = parts[0] as ChainPart
  const last = parts[parts.length - 1] as ChainPart
  return { from: first.start, to: last.end, ...description }
}

/** The DOM of one hover card. Kept separate so it can be asserted on directly. */
export function tooltipDom(info: SymbolInfo): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-sql-hover'
  const head = document.createElement('div')
  head.className = 'cm-sql-hover-head'
  head.textContent = `${info.kind} ${info.title}`
  dom.appendChild(head)
  for (const line of info.lines) {
    const row = document.createElement('div')
    row.className = 'cm-sql-hover-line'
    row.textContent = line
    dom.appendChild(row)
  }
  return dom
}

/** Hover card styling; colours come from the shell's tokens, like the editor. */
const sqlHoverTheme = EditorView.theme({
  '.cm-sql-hover': {
    padding: '4px 8px',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 'var(--dsw-font-s-12)',
    lineHeight: '1.5',
  },
  '.cm-sql-hover-head': {
    marginBottom: '2px',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: '600',
  },
  '.cm-sql-hover-line': { color: 'var(--dsw-alias-label-secondary)' },
})

/** Options for {@link buildExtrasExtension}. */
export interface ExtrasOptions {
  /** Current schema snapshot; everything degrades to nothing without it. */
  readonly schema?: SchemaIndex
  /** Wavy-underlined diagnostics. Default `true`. */
  readonly lint?: boolean
  /** Hover cards. Default `true`. */
  readonly hover?: boolean
  /** See {@link import('./sql-lint.ts').DiagnosticsOptions.knownTablesOnly}. */
  readonly knownTablesOnly?: boolean
  /** Hover delay in milliseconds. Default 300 (CodeMirror's own default). */
  readonly hoverTime?: number
}

/**
 * Build one extension with all editor extras.
 *
 * @param options - Schema and feature switches.
 */
export function buildExtrasExtension(options: ExtrasOptions = {}): Extension {
  // The sources must be created **once**: CodeMirror identifies an active source
  // by function identity, so a provider that builds a new source per query would
  // never keep its result and the popup would stay empty.
  const schemaSource = sqlCompletionExtras(options.schema)
  const functionSource = sqlFunctionCompletions()
  const extensions: Extension[] = [
    EditorState.languageData.of(() => [
      { autocomplete: schemaSource },
      { autocomplete: functionSource },
    ]),
  ]
  if (options.lint ?? true) {
    extensions.push(sqlLintExtension({
      schema: options.schema,
      knownTablesOnly: options.knownTablesOnly ?? false,
    }))
  }
  if (options.hover ?? true) {
    extensions.push(hoverTooltip((view, pos): Tooltip | null => {
      const info = symbolInfoAt(view.state.doc.toString(), pos, options.schema)
      return info === null ? null : { pos: info.from, end: info.to, create: () => ({ dom: tooltipDom(info) }) }
    }, { hoverTime: options.hoverTime ?? 300 }))
    extensions.push(sqlHoverTheme)
  }
  return extensions
}
