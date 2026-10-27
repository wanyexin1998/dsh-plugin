/**
 * Expand `*` / `alias.*` into the real column list, and the FROM/JOIN scanner
 * that makes it possible.
 *
 * The scanner (`scanTableRefs`) is shared with completion and lint on purpose:
 * all three need to answer "which tables does this statement mention, and under
 * which aliases?" and three slightly different answers would mean completion
 * offering a column while lint calls it unknown.
 *
 * Not a parser, and honest about it: no scope resolution, no CTE tracking, no
 * type inference. It reads the token stream from `sql-format.ts`, so strings and
 * comments cannot invent table names.
 */

import type { SchemaIndex, SchemaTable } from './completion.ts'
import { isSqlFunction } from './sql-functions.ts'
import { isSqlKeyword, statementRange, tokenizeSql } from './sql-format.ts'
import type { SqlRange, SqlToken } from './sql-format.ts'

/** A selection or caret range, in document offsets (rom may equal 	o). */
export interface SelectionRange {
  readonly from: number
  readonly to: number
}

/** One table mentioned by a statement. */
export interface TableRef {
  /** Dotted path as written, unquoted; empty for a derived table. */
  readonly path: readonly string[]
  /** Last path segment: the table name (empty for a derived table). */
  readonly name: string
  /** Database/schema part when the statement qualifies the name. */
  readonly schemaName?: string
  /**
   * Name the statement lets you use for it: the explicit alias, or the table's
   * own name when no alias is given.
   */
  readonly alias: string
  /** True when the statement names it explicitly (o in FROM t o). */
  readonly explicitAlias: boolean
  /** True for `FROM (SELECT …) x` — a subquery, not a catalogue object. */
  readonly derived: boolean
  /** Offset of the first token of the reference. */
  readonly from: number
  /** Offset just past the last token of the reference (before any alias). */
  readonly to: number
}

/** Keywords that introduce a table reference. */
const TABLE_KEYWORDS: ReadonlySet<string> = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO'])

/** `INTO` targets that are not tables (SELECT … INTO OUTFILE). */
const INTO_NON_TABLES: ReadonlySet<string> = new Set(['OUTFILE', 'DUMPFILE', 'VARIABLE'])

/** One parsed reference plus the index of the next unconsumed token. */
interface ParsedRef {
  readonly ref: TableRef
  readonly next: number
}

/** A dotted identifier chain read from the token stream. */
interface ReadPath {
  readonly path: string[]
  readonly name: string
  readonly schemaName?: string
  readonly lastToken: SqlToken
  readonly next: number
}

/** Read a dotted identifier chain (`dwd`.`dwd_order`), unquoting each part. */
function readPath(tokens: readonly SqlToken[], first: SqlToken, after: number): ReadPath {
  const path = [first.value]
  let name = first.value
  let schemaName: string | undefined
  let lastToken = first
  let next = after
  while (true) {
    const dot = tokens[next]
    if (dot === undefined || dot.kind !== 'punct' || dot.text !== '.') break
    const part = tokens[next + 1]
    if (part === undefined) break
    if (part.kind !== 'word' && part.kind !== 'quoted') break
    schemaName = name
    name = part.value
    path.push(part.value)
    lastToken = part
    next += 2
  }
  return { path, name, ...(schemaName === undefined ? {} : { schemaName }), lastToken, next }
}

/**
 * Read the alias after a reference, if the statement gives one.
 *
 * `AS name` is explicit; a bare identifier counts too, unless it is a keyword —
 * `FROM t WHERE` must not read `WHERE` as an alias.
 */
function readAlias(tokens: readonly SqlToken[], index: number): { alias: string; next: number } | null {
  const token = tokens[index]
  if (token === undefined) return null
  if (token.kind === 'word' && token.text.toUpperCase() === 'AS') {
    const name = tokens[index + 1]
    if (name === undefined) return null
    if (name.kind !== 'word' && name.kind !== 'quoted') return null
    return { alias: name.value, next: index + 2 }
  }
  if (token.kind !== 'word' && token.kind !== 'quoted') return null
  if (token.kind === 'word' && isSqlKeyword(token.text)) return null
  return { alias: token.value, next: index + 1 }
}

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchingParen(tokens: readonly SqlToken[], open: number): number {
  let depth = 0
  for (const [offset, token] of tokens.slice(open).entries()) {
    if (token.kind !== 'punct') continue
    if (token.text === '(') depth += 1
    else if (token.text === ')') {
      depth -= 1
      if (depth === 0) return open + offset
    }
  }
  return -1
}

/** Parse one table reference starting at `index`, or `null` when there is none. */
function parseRef(tokens: readonly SqlToken[], index: number): ParsedRef | null {
  const start = tokens[index]
  if (start === undefined) return null

  if (start.kind === 'punct' && start.text === '(') {
    // Derived table: skip its body, then read the alias it needs for reference.
    const close = matchingParen(tokens, index)
    if (close === -1) return null
    const alias = readAlias(tokens, close + 1)
    if (alias === null) {
      return {
        ref: { path: [], name: '', alias: '', explicitAlias: false, derived: true, from: start.start, to: start.end },
        next: close + 1,
      }
    }
    return {
      ref: { path: [], name: '', alias: alias.alias, explicitAlias: true, derived: true, from: start.start, to: start.end },
      next: alias.next,
    }
  }

  if (start.kind !== 'word' && start.kind !== 'quoted') return null
  const path = readPath(tokens, start, index + 1)
  const alias = readAlias(tokens, path.next)
  return {
    ref: {
      path: path.path,
      name: path.name,
      ...(path.schemaName === undefined ? {} : { schemaName: path.schemaName }),
      alias: alias === null ? path.name : alias.alias,
      explicitAlias: alias !== null,
      derived: false,
      from: start.start,
      to: path.lastToken.end,
    },
    next: alias === null ? path.next : alias.next,
  }
}

/**
 * Collect the tables a statement mentions.
 *
 * `FROM`/`UPDATE` lists (`FROM a, b`) continue over commas; `JOIN` and `INTO`
 * take one reference. Keywords inside a function call's parentheses are ignored,
 * because `EXTRACT(YEAR FROM dt)` is not a table reference.
 *
 * @param tokens - Full token stream of the document.
 * @param range - Offset range to scan (one statement, usually).
 */
export function scanTableRefs(tokens: readonly SqlToken[], range: SqlRange): TableRef[] {
  const refs: TableRef[] = []
  /** Paren frames: `true` when the parenthesis belongs to a function call. */
  const frames: boolean[] = []
  let previous: SqlToken | undefined

  for (const [index, token] of tokens.entries()) {
    if (token.kind === 'punct' && token.text === '(') {
      frames.push(previous !== undefined && previous.kind === 'word' && isSqlFunction(previous.value))
      previous = token
      continue
    }
    if (token.kind === 'punct' && token.text === ')') {
      frames.pop()
      previous = token
      continue
    }
    const inFunction = frames.some(frame => frame)
    const keyword = token.kind === 'word' ? token.text.toUpperCase() : ''
    const skip = token.start < range.start || token.start >= range.end
    const before = previous
    previous = token
    if (skip || inFunction || !TABLE_KEYWORDS.has(keyword)) continue

    // `ON DUPLICATE KEY UPDATE a = 1` names a column, not a table.
    const updateTail = keyword === 'UPDATE' && before !== undefined &&
      before.kind === 'word' && /^(KEY|DUPLICATE)$/i.test(before.text)
    const nextValue = tokens[index + 1]?.value.toUpperCase() ?? ''
    const nonTableInto = keyword === 'INTO' && INTO_NON_TABLES.has(nextValue)
    if (updateTail || nonTableInto) continue

    let next = index + 1
    while (true) {
      const parsed = parseRef(tokens, next)
      if (parsed === null) break
      refs.push(parsed.ref)
      next = parsed.next
      const comma = tokens[next]
      if (keyword !== 'FROM' && keyword !== 'UPDATE') break
      if (comma === undefined || comma.kind !== 'punct' || comma.text !== ',') break
      next += 1
    }
  }
  return refs
}

/** What `expandStar` replaces: the statement's star, and the qualifier before it. */
interface StarTarget {
  /** Offset of the `*` token. */
  readonly start: number
  /** Parts written before the dot (`o` in `o.*`); absent for a bare star. */
  readonly qualifier?: Qualifier
}

/** One written part of a qualifier: its source text and its unquoted name. */
interface QualifierPart {
  readonly text: string
  readonly value: string
}

/** A written qualifier: the table name, plus the schema before it when given. */
interface Qualifier {
  readonly table: QualifierPart
  readonly schema?: QualifierPart
}

/** Qualifier parts written immediately before the star, as written. */
function qualifierBefore(tokens: readonly SqlToken[], star: number): Qualifier | null {
  const near = tokens[star - 2]
  const dot = tokens[star - 1]
  if (near === undefined) return null
  if (dot === undefined || dot.kind !== 'punct' || dot.text !== '.') return null
  if (near.kind !== 'word' && near.kind !== 'quoted') return null
  const table: QualifierPart = { text: near.text, value: near.value }

  const far = tokens[star - 4]
  const farDot = tokens[star - 3]
  if (far === undefined || farDot === undefined) return { table }
  if (farDot.kind !== 'punct' || farDot.text !== '.') return { table }
  if (far.kind !== 'word' && far.kind !== 'quoted') return { table }
  return { schema: { text: far.text, value: far.value }, table }
}

/** True when `previous` is a position that accepts a bare wildcard. */
function acceptsWildcard(previous: SqlToken | undefined): boolean {
  if (previous === undefined) return false
  if (previous.kind === 'word') return /^(SELECT|DISTINCT)$/i.test(previous.text)
  return previous.kind === 'punct' && previous.text === ','
}

/** Locate the star a selection or caret points at; `null` when it is not one. */
function starTarget(tokens: readonly SqlToken[], selection: SelectionRange): StarTarget | null {
  if (selection.from !== selection.to) {
    // A selection must be exactly a star expression: `*`, `o.*`, `db.t.*`.
    // Selecting the whole query and invoking "expand" must not grab a random `*`.
    const selected = tokens.filter(token => token.start >= selection.from && token.end <= selection.to)
    const last = selected[selected.length - 1]
    if (last === undefined || last.kind !== 'operator' || last.text !== '*') return null
    if (selected.filter(token => token.kind === 'operator' && token.text === '*').length !== 1) return null
    const starIndex = tokens.indexOf(last)
    const qualifier = qualifierBefore(tokens, starIndex)
    // Parts, the dots between them and the star itself: `o.*` is three tokens.
    const expected = qualifier === null ? 1 : qualifier.schema === undefined ? 3 : 5
    if (selected.length !== expected) return null
    return qualifier === null ? { start: last.start } : { start: last.start, qualifier }
  }

  const index = tokens.findIndex(token =>
    token.kind === 'operator' && token.text === '*' &&
    (token.start === selection.from || token.end === selection.from))
  const star = tokens[index]
  if (star === undefined) return null
  const qualifier = qualifierBefore(tokens, index)
  if (qualifier !== null) return { start: star.start, qualifier }
  return acceptsWildcard(tokens[index - 1]) ? { start: star.start } : null
}

/**
 * Resolve one table by name, with the schema part when the statement gave one.
 *
 * A bare name that exists in two databases is **ambiguous**, not resolved: the
 * two may have different columns, and guessing would show the wrong ones.
 */
function resolveTable(
  schema: SchemaIndex,
  name: string,
  schemaName?: string,
): SchemaTable | null {
  const matches = schema.tables.filter(table =>
    table.name === name && (schemaName === undefined || table.schema === schemaName))
  return matches.length === 1 ? (matches[0] as SchemaTable) : null
}

/** Resolve one FROM/JOIN reference against the snapshot. */
export function resolveTableRef(schema: SchemaIndex | undefined, ref: TableRef): SchemaTable | null {
  return schema === undefined ? null : resolveTable(schema, ref.name, ref.schemaName)
}

/**
 * Resolve a dotted `schema.table` / `table` path against the snapshot.
 *
 * Used by completion and lint as well as here, so `o.` in the editor and the
 * unknown-column check in lint agree on which table is meant.
 */
export function resolveQualified(schema: SchemaIndex | undefined, parts: readonly string[]): SchemaTable | null {
  if (schema === undefined) return null
  let name = ''
  let schemaName: string | undefined
  for (const part of parts) {
    if (part === '') continue
    schemaName = name === '' ? undefined : name
    name = part
  }
  return name === '' ? null : resolveTable(schema, name, schemaName)
}

/** The table a qualified star points at, trying the alias first, then the name. */
function tableForQualifier(
  schema: SchemaIndex,
  qualifier: Qualifier,
  refs: readonly TableRef[],
): SchemaTable | null {
  const byAlias = refs.find(ref =>
    !ref.derived && ref.alias.toLowerCase() === qualifier.table.value.toLowerCase())
  if (byAlias !== undefined) return resolveTableRef(schema, byAlias)
  return resolveQualified(schema, qualifier.schema === undefined
    ? [qualifier.table.value]
    : [qualifier.schema.value, qualifier.table.value])
}

/** The only table of the statement, or `null` when there is not exactly one. */
function singleTable(statementRefs: readonly TableRef[], schema: SchemaIndex): SchemaTable | null {
  const concrete = statementRefs.filter(ref => !ref.derived && ref.path.length > 0)
  if (concrete.length !== 1) return null
  return resolveTableRef(schema, concrete[0] as TableRef)
}

/** Split a `schema.table` / `table` hint, trimming and unquoting each part. */
function hintParts(qualifiedName: string): string[] {
  return qualifiedName
    .split('.')
    .map(part => part.trim().replace(/^`|`$/g, ''))
    .filter(part => part !== '')
}

/** Identifiers that would need backticks to survive as a column name. */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Quote a column name only when the bare form would not parse as it. */
function renderIdentifier(name: string): string {
  return SAFE_IDENTIFIER.test(name) && !isSqlKeyword(name) ? name : `\`${name.replace(/`/g, '``')}\``
}

/** Indentation that lines the expanded columns up under the original star. */
function starIndent(sql: string, start: number): string {
  const lineStart = sql.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  return ' '.repeat(Math.max(0, start - lineStart))
}

/**
 * Expand the `*` (or `alias.*`) under the selection into its column list.
 *
 * The returned text replaces the star itself: columns are separated by a comma
 * and a newline, each continuation line padded so the list aligns under where
 * the star used to be. A qualified star keeps its qualifier (`o.order_id, …`).
 *
 * Returns `null` — and the caller should do nothing — when there is no star, the
 * table is unknown, the statement names several tables (ambiguous), or the
 * snapshot has no columns for it (views in the SHOW fallback).
 *
 * @param sql - Whole editor contents.
 * @param selection - Selection or caret range, in document offsets.
 * @param schema - Current schema snapshot, if any.
 * @param qualifiedName - Optional target (`dwd.dwd_order`), for callers that know
 *   the table from outside the SQL (the object tree's "expand star").
 */
export function expandStar(
  sql: string,
  selection: SelectionRange,
  schema: SchemaIndex | undefined,
  qualifiedName?: string,
): string | null {
  if (schema === undefined) return null
  const tokens = tokenizeSql(sql)
  const statement = statementRange(tokens, selection.from, sql.length)
  const target = starTarget(tokens, selection)
  if (target === null) return null

  const refs = scanTableRefs(tokens, statement)
  let table: SchemaTable | null
  if (target.qualifier !== undefined) {
    table = tableForQualifier(schema, target.qualifier, refs)
  } else if (qualifiedName !== undefined) {
    table = resolveQualified(schema, hintParts(qualifiedName))
  } else {
    table = singleTable(refs, schema)
  }
  if (table === null || table.columns.length === 0) return null

  const prefix = target.qualifier === undefined
    ? ''
    : `${[target.qualifier.schema?.text, target.qualifier.table.text].filter(part => part !== undefined).join('.')}.`
  const indent = starIndent(sql, target.start)
  return table.columns
    .map(column => `${prefix}${renderIdentifier(column.name)}`)
    .join(`,\n${indent}`)
}
