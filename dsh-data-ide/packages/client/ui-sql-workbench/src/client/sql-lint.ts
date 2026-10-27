/**
 * Diagnostics for the SQL editor, without `@codemirror/lint`.
 *
 * The repo does not ship `@codemirror/lint` (one more dependency for a wavy line
 * was not worth it), so the same result is built from `@codemirror/view`:
 * `computeDiagnostics` is pure and testable, and `sqlLintExtension` turns its
 * output into `Decoration.mark` ranges with a wavy underline themed through
 * `--dsw-*` tokens.
 *
 * What it reports, and — more importantly — what it refuses to report:
 *  - **syntax errors** come from the Lezer MySQL parser already in the bundle
 *    (`lang-sql`'s own tree), so they agree with the highlighter;
 *  - **unknown tables** after `FROM`/`JOIN`/`UPDATE`/`INTO`, only when the name
 *    cannot be found under *any* database in the snapshot — a table that exists
 *    in two databases is ambiguous, not unknown;
 *  - **unknown `alias.column`** only when the alias resolves to a real table in
 *    the same statement and that table has a known column list. Views reported
 *    without columns (`columns: []`, the SHOW fallback) are never checked, which
 *    is what keeps Doris views quiet;
 *  - **UPDATE/DELETE without WHERE**, as a warning, because it is legal SQL that
 *    usually means an accident.
 *
 * CTE names are collected before the checks so `WITH c AS (…) SELECT * FROM c`
 * does not report `c`. Subqueries and derived tables are skipped by the same
 * scanner the completion uses (`scanTableRefs`).
 */

import { MySQL } from '@codemirror/lang-sql'
import { EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

import type { SchemaIndex, SchemaTable } from './completion.ts'
import { resolveQualified, resolveTableRef, scanTableRefs } from './expand-star.ts'
import type { TableRef } from './expand-star.ts'
import { tokenizeSql } from './sql-format.ts'
import type { SqlToken } from './sql-format.ts'

/** One diagnostic, in document offsets. */
export interface SqlDiagnostic {
  readonly from: number
  readonly to: number
  readonly severity: 'error' | 'warning'
  /** Chinese message, shown on hover and used as the lint tooltip text. */
  readonly message: string
}

export interface DiagnosticsOptions {
  /**
   * Only check what the snapshot can resolve.
   *
   * Set when the snapshot may be partial (a truncated introspection or the SHOW
   * fallback): an unknown table is then a missing row rather than a typo, so
   * only columns of resolved tables are checked.
   */
  readonly knownTablesOnly?: boolean
}

/** Databases whose objects the snapshot never contains (metadata.ts skips them). */
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  'information_schema', 'mysql', '__internal_schema', 'sys', 'performance_schema',
])

/** Ceiling on diagnostic count; a broken paste must not paint the whole document. */
export const MAX_DIAGNOSTICS = 200

/** The tree parser behind `lang-sql`'s MySQL dialect. */
const parser = MySQL.language.parser

/** A statement's tokens, split on `;` tokens (strings and comments cannot hold one). */
function statementGroups(tokens: readonly SqlToken[]): SqlToken[][] {
  const groups: SqlToken[][] = []
  let current: SqlToken[] = []
  for (const token of tokens) {
    if (token.kind === 'punct' && token.text === ';') {
      groups.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  groups.push(current)
  return groups
}

/** Syntax errors from the Lezer tree, as document ranges. */
function syntaxDiagnostics(sql: string): SqlDiagnostic[] {
  const diagnostics: SqlDiagnostic[] = []
  if (sql.length === 0) return diagnostics
  const seen = new Set<string>()
  const tree = parser.parse(sql)
  tree.iterate({
    enter(node) {
      if (!node.type.isError) return
      let from = node.from
      let to = node.to
      if (to <= from) {
        // Lezer reports a missing token as a zero-length error at the gap; widen
        // it to one character so there is something to underline.
        from = Math.max(0, Math.min(from, sql.length - 1))
        to = Math.max(from + 1, Math.min(sql.length, node.from + 1))
      }
      const key = `${String(from)}:${String(to)}`
      if (seen.has(key)) return
      seen.add(key)
      diagnostics.push({ from, to, severity: 'error', message: '语法错误：此处无法被解析' })
    },
  })
  return diagnostics
}

/** Names declared by a `WITH` clause, so references to them are not "unknown". */
function cteNames(tokens: readonly SqlToken[]): Set<string> {
  const names = new Set<string>()
  const withIndex = tokens.findIndex(token => token.kind === 'word' && token.text.toUpperCase() === 'WITH')
  if (withIndex === -1) return names
  let depth = 0
  for (let index = withIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    /* v8 ignore next -- index is bounded by tokens.length */
    if (token === undefined) break
    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1
      else if (token.text === ')') depth -= 1
      continue
    }
    if (depth !== 0) continue
    // The main statement starts at the first SELECT at the outer level.
    if (token.kind === 'word' && token.text.toUpperCase() === 'SELECT') break
    if (token.kind !== 'word' && token.kind !== 'quoted') continue
    if (token.kind === 'word' && /^(AS|RECURSIVE)$/i.test(token.text)) continue
    names.add(token.value.toLowerCase())
  }
  return names
}

/** The first word of a statement, ignoring comments. */
function firstKeyword(tokens: readonly SqlToken[]): SqlToken | undefined {
  return tokens.find(token => token.kind === 'word')
}

/** Whether the statement has a WHERE at its own level (not only in a subquery). */
function hasOuterWhere(tokens: readonly SqlToken[]): boolean {
  let depth = 0
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.text === '(') depth += 1
      else if (token.text === ')') depth -= 1
      continue
    }
    if (depth === 0 && token.kind === 'word' && token.text.toUpperCase() === 'WHERE') return true
  }
  return false
}

/** A table the snapshot knows, compared case-insensitively like MySQL does. */
function knownTable(schema: SchemaIndex, ref: TableRef): boolean {
  return schema.tables.some(table =>
    table.name.toLowerCase() === ref.name.toLowerCase() &&
    (ref.schemaName === undefined || (table.schema ?? '').toLowerCase() === ref.schemaName.toLowerCase()))
}

/** FIND the column of a table by name, case-insensitively. */
function hasColumn(table: SchemaTable, name: string): boolean {
  const wanted = name.toLowerCase()
  return table.columns.some(column => column.name.toLowerCase() === wanted)
}

/** Unknown tables, skipping CTEs, derived tables and system catalogs. */
function unknownTableDiagnostics(
  refs: readonly TableRef[],
  tokens: readonly SqlToken[],
  schema: SchemaIndex,
): SqlDiagnostic[] {
  const ctes = cteNames(tokens)
  const diagnostics: SqlDiagnostic[] = []
  for (const ref of refs) {
    if (ref.derived || ref.name === '') continue
    if (ref.schemaName !== undefined && SYSTEM_SCHEMAS.has(ref.schemaName.toLowerCase())) continue
    if (ctes.has(ref.name.toLowerCase())) continue
    if (knownTable(schema, ref)) continue
    diagnostics.push({
      from: ref.from,
      to: ref.to,
      severity: 'error',
      message: `未找到表：${ref.path.join('.')}`,
    })
  }
  return diagnostics
}

/** Alias → table for the statement; `null` means "mentioned but not resolvable". */
function aliasMap(refs: readonly TableRef[], schema: SchemaIndex): Map<string, SchemaTable | null> {
  const map = new Map<string, SchemaTable | null>()
  for (const ref of refs) {
    if (ref.derived) continue
    const table = resolveTableRef(schema, ref)
    map.set(ref.alias.toLowerCase(), table)
  }
  return map
}

/** Identifiers separated by dots, as the column checks need them. */
interface Chain {
  readonly first: string
  readonly second: string
  readonly third?: string
  /** Offset of the first token of the chain. */
  readonly from: number
  /** Offset just past the last token of the chain. */
  readonly to: number
  /** Index of the first token after the chain, for the caller to continue from. */
  readonly next: number
}

/** Read a `a.b` / `a.b.c` chain starting at `index`, or `null`. */
function readChain(tokens: readonly SqlToken[], index: number): Chain | null {
  const first = tokens[index]
  const dot = tokens[index + 1]
  const second = tokens[index + 2]
  if (first === undefined || second === undefined || dot === undefined) return null
  if (first.kind !== 'word' && first.kind !== 'quoted') return null
  if (dot.kind !== 'punct' || dot.text !== '.') return null
  if (second.kind !== 'word' && second.kind !== 'quoted') return null
  const dot2 = tokens[index + 3]
  const third = tokens[index + 4]
  if (dot2 === undefined || third === undefined || dot2.kind !== 'punct' || dot2.text !== '.') {
    return { first: first.value, second: second.value, from: first.start, to: second.end, next: index + 3 }
  }
  if (third.kind !== 'word' && third.kind !== 'quoted') {
    return { first: first.value, second: second.value, from: first.start, to: second.end, next: index + 3 }
  }
  return {
    first: first.value,
    second: second.value,
    third: third.value,
    from: first.start,
    to: third.end,
    next: index + 5,
  }
}

/**
 * Unknown `alias.column` / `schema.table.column` references.
 *
 * Only aliases that resolve to a real table in this statement are checked, and
 * only when the snapshot knows the table's columns: anything else (a CTE, a
 * derived table, a view the catalogue could not describe, an ambiguous name)
 * would be a guess.
 */
function unknownColumnDiagnostics(
  tokens: readonly SqlToken[],
  refs: readonly TableRef[],
  schema: SchemaIndex,
): SqlDiagnostic[] {
  const aliases = aliasMap(refs, schema)
  const diagnostics: SqlDiagnostic[] = []
  let index = 0
  while (index < tokens.length) {
    const chain = readChain(tokens, index)
    if (chain === null) {
      index += 1
      continue
    }
    // `db.fn(x)` is a function call, not a column reference.
    const after = tokens[chain.next]
    if (after !== undefined && after.kind === 'punct' && after.text === '(') {
      index = chain.next
      continue
    }
    const table = chain.third === undefined
      ? aliases.get(chain.first.toLowerCase())
      : resolveQualified(schema, [chain.first, chain.second])
    index = chain.next
    if (table === undefined || table === null || table.columns.length === 0) continue
    const column = chain.third ?? chain.second
    if (hasColumn(table, column)) continue
    const qualifiedName = chain.third === undefined
      ? `${chain.first}.${chain.second}`
      : `${chain.first}.${chain.second}.${chain.third}`
    diagnostics.push({ from: chain.from, to: chain.to, severity: 'error', message: `列不存在：${qualifiedName}` })
  }
  return diagnostics
}

/** `UPDATE`/`DELETE` that would hit the whole table. */
function missingWhereDiagnostics(tokens: readonly SqlToken[]): SqlDiagnostic[] {
  const first = firstKeyword(tokens)
  if (first === undefined) return []
  const keyword = first.text.toUpperCase()
  if (keyword !== 'UPDATE' && keyword !== 'DELETE') return []
  if (hasOuterWhere(tokens)) return []
  let to = first.end
  for (const token of tokens) {
    if (token.kind !== 'comment') to = token.end
  }
  return [{
    from: first.start,
    to,
    severity: 'warning',
    message: `${keyword} 没有 WHERE 条件，会作用于整张表`,
  }]
}

/**
 * All diagnostics for one document.
 *
 * @param sql - Whole editor contents.
 * @param schema - Schema snapshot, if the connection has one.
 * @param options - See {@link DiagnosticsOptions}.
 */
export function computeDiagnostics(
  sql: string,
  schema: SchemaIndex | undefined,
  options: DiagnosticsOptions = {},
): SqlDiagnostic[] {
  const diagnostics = syntaxDiagnostics(sql)
  const groups = statementGroups(tokenizeSql(sql))
  for (const tokens of groups) {
    if (!tokens.some(token => token.kind !== 'comment')) continue
    const first = tokens[0]
    const last = tokens[tokens.length - 1]
    /* v8 ignore next -- a group with a non-comment token has both ends */
    if (first === undefined || last === undefined) continue
    const range = { start: first.start, end: last.end }
    const refs = scanTableRefs(tokens, range)
    if (schema !== undefined && schema.tables.length > 0) {
      if (options.knownTablesOnly !== true) diagnostics.push(...unknownTableDiagnostics(refs, tokens, schema))
      diagnostics.push(...unknownColumnDiagnostics(tokens, refs, schema))
    }
    diagnostics.push(...missingWhereDiagnostics(tokens))
  }
  diagnostics.sort((left, right) => left.from - right.from)
  return diagnostics.slice(0, MAX_DIAGNOSTICS)
}

/** Decorations for one editor state. */
function buildDecorations(state: EditorState, options: SqlLintConfiguration): DecorationSet {
  const diagnostics = computeDiagnostics(state.doc.toString(), options.schema, {
    knownTablesOnly: options.knownTablesOnly ?? false,
  })
  const marks = diagnostics.map(diagnostic => Decoration
    .mark({ class: diagnostic.severity === 'error' ? 'cm-sql-diag-error' : 'cm-sql-diag-warning' })
    .range(diagnostic.from, diagnostic.to))
  return Decoration.set(marks, true)
}

/** Options for the editor extension; mirrors {@link DiagnosticsOptions}. */
export interface SqlLintConfiguration {
  readonly schema?: SchemaIndex
  readonly knownTablesOnly?: boolean
}

/** Wavy underlines, in the shell's semantic colours. */
const sqlLintTheme = EditorView.theme({
  '.cm-sql-diag-error': {
    textDecoration: 'underline wavy var(--dsw-alias-state-error-primary)',
    textUnderlineOffset: '2px',
  },
  '.cm-sql-diag-warning': {
    textDecoration: 'underline wavy var(--dsw-alias-state-warn-primary)',
    textUnderlineOffset: '2px',
  },
})

/**
 * The lint extension: recompute on document changes, paint wavy underlines.
 *
 * `schema` is read through a closure — when a new snapshot arrives the owner
 * reconfigures the language compartment with a freshly built extension (see
 * `buildExtrasExtension`), so there is no second source of truth to keep in sync.
 */
export function sqlLintExtension(options: SqlLintConfiguration): Extension {
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, options)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.decorations = buildDecorations(update.state, options)
      }
    }, { decorations: plugin => plugin.decorations }),
    sqlLintTheme,
  ]
}
