/**
 * The second completion source: tables, columns, aliases and functions.
 *
 * `@codemirror/lang-sql` already ships a schema source, but it is deliberately
 * conservative — it works from the syntax tree and only offers an answer when
 * there is something typed or the completion was requested explicitly. This
 * source adds the parts that make a 300px pane feel like an IDE:
 *
 *  - tables right after `FROM`/`JOIN`/`UPDATE`/`INTO` (and after a comma in a
 *    table list), including the `schema.table` form when a name is ambiguous;
 *  - columns in expression positions (`SELECT`, `WHERE`, `ON`, `GROUP BY`, …),
 *    qualified with the alias the statement declared;
 *  - `alias.` / `schema.` / `schema.table.` member completion;
 *  - function calls with a snippet for the argument list.
 *
 * It is an *additional* source (added through `EditorState.languageData`), never
 * an `override`, so the dialect's own suggestions keep working.
 *
 * Everything is a heuristic over `sql-format`'s token stream: no parser, no
 * scope resolution. The worst case is a suggestion that is merely not useful —
 * the source never throws (CodeMirror disables a source that does).
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { snippetCompletion } from '@codemirror/autocomplete'

import type { SchemaColumn, SchemaIndex, SchemaTable } from './completion.ts'
import { resolveQualified, resolveTableRef, scanTableRefs } from './expand-star.ts'
import type { TableRef } from './expand-star.ts'
import { functionSnippet, matchSqlFunctions } from './sql-functions.ts'
import { isSqlKeyword, statementRange, tokenizeSql } from './sql-format.ts'
import type { SqlToken } from './sql-format.ts'

/** Keywords after which a table name is expected. */
const TABLE_POSITIONS: ReadonlySet<string> = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO', 'TABLE'])

/** Keywords after which an expression (and therefore columns) is expected. */
const EXPRESSION_POSITIONS: ReadonlySet<string> = new Set([
  'SELECT', 'WHERE', 'ON', 'HAVING', 'SET', 'BY', 'AND', 'OR', 'NOT', 'IN', 'IS', 'LIKE',
  'BETWEEN', 'WHEN', 'THEN', 'ELSE', 'DISTINCT',
])

/** Clause openers whose comma-separated list is a table list. */
const TABLE_CLAUSES: ReadonlySet<string> = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO'])

/** Clause openers whose comma-separated list is an expression list. */
const COLUMN_CLAUSES: ReadonlySet<string> = new Set([
  'SELECT', 'WHERE', 'ON', 'HAVING', 'SET', 'BY', 'GROUP', 'ORDER', 'WHEN', 'THEN', 'ELSE',
])

/** A plausible SQL identifier when written without quotes. */
const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The word being typed, and where it starts. */
interface CaretWord {
  readonly text: string
  /** Offset completion replaces from; includes an opening backtick when typed. */
  readonly from: number
  /** True when the caret sits inside an unterminated backtick identifier. */
  readonly quoted: boolean
}

/** Where in the statement the caret sits, as far as suggestions care. */
type Position = 'table' | 'column' | null

/** Quote one identifier for SQL, escaping embedded backticks. */
function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/** Render an identifier the way the user is typing it. */
function renderIdentifier(name: string, quoted: boolean): string {
  return quoted || !PLAIN_IDENTIFIER.test(name) || isSqlKeyword(name) ? quoteIdentifier(name) : name
}

/** The partial word (and its backtick, if any) ending at `pos`. */
function caretWord(doc: string, pos: number): CaretWord {
  let start = pos
  while (start > 0 && /[A-Za-z0-9_$]/.test(doc.charAt(start - 1))) start -= 1
  const quoted = start > 0 && doc.charAt(start - 1) === '`'
  return { text: doc.slice(start, pos), from: quoted ? start - 1 : start, quoted }
}

/**
 * The dotted qualifier written immediately before `from`, unquoted.
 *
 * `FROM dwd.` → `['dwd']`, `WHERE o.` → `['o']`, `dwd.t.` → `['dwd', 't']`.
 */
function qualifierBefore(doc: string, from: number): string[] | null {
  if (doc.charAt(from - 1) !== '.') return null
  const head = doc.slice(0, from - 1)
  const match = /(?:`[^`]*`|[A-Za-z_$][\w$]*)(?:\s*\.\s*(?:`[^`]*`|[A-Za-z_$][\w$]*))*$/.exec(head)
  if (match === null) return null
  return match[0].split('.').map(part => part.trim().replace(/^`|`$/g, ''))
}

/**
 * Classify the caret from the tokens before it.
 *
 * `offset` is the start of the partial word: everything that ends before it is
 * the context. Only the tokens of the current statement count, so a previous
 * statement cannot make `FROM` look like the nearest clause.
 */
function positionAt(tokens: readonly SqlToken[], statementStart: number, offset: number): Position {
  const before = tokens.filter(token => token.start >= statementStart && token.end <= offset)
  const previous = before[before.length - 1]
  if (previous === undefined) return null
  if (previous.kind === 'word') {
    const word = previous.text.toUpperCase()
    if (TABLE_POSITIONS.has(word)) return 'table'
    if (EXPRESSION_POSITIONS.has(word)) return 'column'
  }
  if (previous.kind === 'punct' && previous.text === ',') return nearestClause(before)
  return null
}

/** Which kind of list the nearest clause opener belongs to. */
function nearestClause(before: readonly SqlToken[]): Position {
  let depth = 0
  for (const token of [...before].reverse()) {
    if (token.kind === 'punct') {
      if (token.text === ')') depth += 1
      else if (token.text === '(') {
        // Leaving the parenthesis the caret is in: the outer clause is not ours.
        depth -= 1
        if (depth < 0) return null
      }
      continue
    }
    if (depth !== 0) continue
    const word = token.kind === 'word' ? token.text.toUpperCase() : ''
    if (TABLE_CLAUSES.has(word)) return 'table'
    if (COLUMN_CLAUSES.has(word)) return 'column'
  }
  return null
}

/** One table suggestion: label is the name, detail the database. */
function tableOption(table: SchemaTable, ambiguous: boolean, word: CaretWord): Completion {
  let apply = renderIdentifier(table.name, word.quoted)
  if (table.schema !== undefined && ambiguous) {
    // Two databases hold the same name: a bare name would bind to whichever one
    // the connection defaults to, so write out the qualified form.
    apply = `${renderIdentifier(table.schema, false)}.${renderIdentifier(table.name, word.quoted)}`
  }
  return {
    label: table.name,
    detail: table.schema ?? '表',
    type: 'type',
    apply,
  }
}

/** Names that occur more than once in the snapshot (same table in two databases). */
function ambiguousNames(tables: readonly SchemaTable[]): Set<string> {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const table of tables) {
    if (seen.has(table.name)) repeated.add(table.name)
    else seen.add(table.name)
  }
  return repeated
}

/** All tables of the snapshot, for a `FROM`-style position. */
function tableOptions(schema: SchemaIndex, word: CaretWord): Completion[] {
  const repeated = ambiguousNames(schema.tables)
  return schema.tables.map(table => tableOption(table, repeated.has(table.name), word))
}

/** One column suggestion for a position that already names its table. */
function columnOption(column: SchemaColumn, word: CaretWord): Completion {
  return {
    label: column.name,
    detail: column.type,
    type: 'property',
    apply: renderIdentifier(column.name, word.quoted),
  }
}

/**
 * Columns of the tables the statement has mentioned so far.
 *
 * Qualified with the alias when the statement has one (or when several tables
 * are in play), plain otherwise — the way a `SELECT` list is read by a person.
 * Columns whose table cannot be resolved are skipped, which is what keeps views
 * with unknown columns and cross-database snapshots quiet.
 */
function columnOptions(statementRefs: readonly TableRef[], schema: SchemaIndex, word: CaretWord): Completion[] | null {
  const resolved: { ref: TableRef; table: SchemaTable }[] = []
  for (const ref of statementRefs) {
    if (ref.derived) continue
    const table = resolveTableRef(schema, ref)
    if (table !== null) resolved.push({ ref, table })
  }
  if (resolved.length === 0) return null
  const qualified = resolved.length > 1 || resolved.some(entry => entry.ref.explicitAlias)
  const options: Completion[] = []
  const seen = new Set<string>()
  for (const { ref, table } of resolved) {
    for (const column of table.columns) {
      const label = qualified ? `${ref.alias}.${column.name}` : column.name
      if (seen.has(label)) continue
      seen.add(label)
      options.push(qualified
        ? {
            label,
            detail: column.type,
            type: 'property',
            apply: `${renderIdentifier(ref.alias, word.quoted)}.${renderIdentifier(column.name, word.quoted)}`,
          }
        : columnOption(column, word))
    }
  }
  return options.length === 0 ? null : options
}

/**
 * Member completion after a dot: `alias.`, `table.`, `schema.`, `schema.table.`.
 *
 * An alias wins over a table name (that is what aliases are for), a schema name
 * lists that database's tables, and anything unresolved yields `null` so the
 * popup closes instead of guessing.
 */
function memberOptions(
  parts: readonly string[],
  schema: SchemaIndex,
  statementRefs: readonly TableRef[],
  word: CaretWord,
): Completion[] | null {
  if (parts.length === 1) {
    const name = parts.join('.')
    const alias = statementRefs.find(ref =>
      !ref.derived && ref.alias.toLowerCase() === name.toLowerCase())
    const table = alias !== undefined ? resolveTableRef(schema, alias) : resolveQualified(schema, parts)
    if (table !== null) return table.columns.map(column => columnOption(column, word))
    const tables = schema.tables.filter(candidate => candidate.schema === name)
    if (tables.length === 0) return null
    // Within one database a table name is unique, so only the name is inserted.
    return tables.map(candidate => ({
      ...tableOption(candidate, false, word),
      apply: renderIdentifier(candidate.name, word.quoted),
    }))
  }
  const table = resolveQualified(schema, parts)
  return table === null ? null : table.columns.map(column => columnOption(column, word))
}

/** Shared shape of a completion result for this module. */
function result(from: number, options: readonly Completion[]): CompletionResult | null {
  if (options.length === 0) return null
  return { from, options, validFor: /^[\w$`]*$/ }
}

/** The schema-aware extra source, additive to the dialect's own source. */
export function sqlCompletionExtras(schema: SchemaIndex | undefined): CompletionSource {
  return context => {
    try {
      return completeSchema(context, schema)
    } catch {
      // Contract: a source that throws is disabled by CodeMirror for the rest of
      // the session. Losing a suggestion is always better than losing completion.
      return null
    }
  }
}

/** Implementation of {@link sqlCompletionExtras}; may throw (the wrapper catches). */
function completeSchema(context: CompletionContext, schema: SchemaIndex | undefined): CompletionResult | null {
  if (schema === undefined || schema.tables.length === 0) return null
  const doc = context.state.doc.toString()
  const pos = context.pos
  const word = caretWord(doc, pos)
  const tokens = tokenizeSql(doc)
  const statement = statementRange(tokens, pos, doc.length)
  const statementRefs = scanTableRefs(tokens, statement)

  const qualifier = qualifierBefore(doc, word.from)
  if (qualifier !== null) return result(word.from, memberOptions(qualifier, schema, statementRefs, word) ?? [])

  const position = positionAt(tokens, statement.start, word.from)
  if (position === 'table') return result(word.from, tableOptions(schema, word))
  if (position === 'column') {
    // Only tables declared before the caret: a `SELECT ©` with the FROM still to
    // come has nothing to offer, and guessing from the rest of the statement
    // would suggest columns the user cannot see yet.
    const declared = scanTableRefs(tokens, { start: statement.start, end: pos })
    return result(word.from, columnOptions(declared, schema, word) ?? [])
  }
  return null
}

/** The function-name source: snippets for the argument list. */
export function sqlFunctionCompletions(limit = 80): CompletionSource {
  return context => {
    try {
      return completeFunctions(context, limit)
    } catch {
      // Same contract as the schema source: suggestions may fail, typing may not.
      return null
    }
  }
}

/** Implementation of {@link sqlFunctionCompletions}; may throw. */
function completeFunctions(context: CompletionContext, limit: number): CompletionResult | null {
  const doc = context.state.doc.toString()
  const pos = context.pos
  const word = caretWord(doc, pos)
  // Without a prefix every function would be offered on every space, which
  // buries the keywords the user is actually typing.
  if (word.text === '' || word.quoted) return null
  const tokens = tokenizeSql(doc)
  const statement = statementRange(tokens, pos, doc.length)
  if (positionAt(tokens, statement.start, word.from) === 'table') return null
  const matches = matchSqlFunctions(word.text, limit)
  if (matches.length === 0) return null
  return {
    from: word.from,
    options: matches.map(fn => snippetCompletion(functionSnippet(fn), {
      label: fn.name,
      detail: fn.signature,
      type: 'function',
    })),
    validFor: /^[\w$]*$/,
  }
}
