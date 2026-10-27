/**
 * Deterministic SQL formatting, and the scanner everything else in the editor
 * extras builds on.
 *
 * Why a hand-written formatter rather than a library: the repo ships no SQL
 * formatter dependency and adding one for a single button is not a trade the
 * spec allows (no new npm deps). What the button needs is narrow — break the
 * statement at its clauses, indent nesting, leave literals and comments exactly
 * as typed — so a ~300-line token scanner plus a layout pass covers it, and is
 * directly testable without an editor.
 *
 * The scanner is exported because three other extras modules (`completion-extra`,
 * `expand-star`, `sql-lint`) need the same token stream: one lexer that is
 * correct beats four that almost are. Nothing here imports CodeMirror.
 *
 * Invariants the formatter keeps:
 *  - **idempotent**: layout depends only on the token stream, never on the
 *    whitespace it starts with, so `format(format(x)) === format(x)`;
 *  - **verbatim literals**: strings, quoted identifiers and comments are copied
 *    from the source; only the requested keyword case changes token text;
 *  - **semantics unchanged**: the token sequence of the output equals the token
 *    sequence of the input (modulo keyword casing).
 */

import { isSqlFunction } from './sql-functions.ts'

/** One lexical token of the SQL text. */
export type SqlTokenKind = 'word' | 'quoted' | 'string' | 'number' | 'comment' | 'punct' | 'operator'

export interface SqlToken {
  readonly kind: SqlTokenKind
  /** Exact source text of the token. */
  readonly text: string
  /** Identifier content without its quotes; equal to `text` for other kinds. */
  readonly value: string
  /** Offset of the first character. */
  readonly start: number
  /** Offset just past the last character. */
  readonly end: number
}

/**
 * Keywords the formatter knows by name.
 *
 * Used for two things only: keyword casing, and deciding whether `name(` is a
 * function call (no space) or a clause followed by a parenthesised expression
 * (space). It is deliberately not a complete grammar — a word missing here only
 * costs it `upperCaseKeywords` treatment.
 */
const KEYWORDS: readonly string[] = [
  'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CREATE', 'CROSS', 'CUBE',
  'CURRENT', 'DATABASE', 'DELETE', 'DESC', 'DISTINCT', 'DIV', 'DROP', 'DUPLICATE', 'ELSE',
  'END', 'ESCAPE', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FALSE', 'FIRST', 'FOLLOWING', 'FOR',
  'FROM', 'FULL', 'GROUP', 'GROUPING', 'HAVING', 'IGNORE', 'IN', 'INNER', 'INSERT',
  'INTERSECT', 'INTERVAL', 'INTO', 'IS', 'JOIN', 'KEY', 'LAST', 'LATERAL', 'LEFT', 'LIKE',
  'LIMIT', 'MINUS', 'NATURAL', 'NOT', 'NULL', 'NULLS', 'OFFSET', 'ON', 'OR', 'ORDER',
  'OUTER', 'OVER', 'PARTITION', 'PRECEDING', 'PRIMARY', 'QUALIFY', 'RANGE', 'REPLACE',
  'RIGHT', 'ROLLUP', 'ROW', 'ROWS', 'SCHEMA', 'SELECT', 'SET', 'SHOW', 'STRAIGHT_JOIN',
  'TABLE', 'THEN', 'TRUE', 'TRUNCATE', 'UNBOUNDED', 'UNION', 'UNIQUE', 'UPDATE', 'USING',
  'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH',
]

const KEYWORD_SET: ReadonlySet<string> = new Set(KEYWORDS)

/** True when `word` is one of the words the formatter treats as a keyword. */
export function isSqlKeyword(word: string): boolean {
  return KEYWORD_SET.has(word.toUpperCase())
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/
const DIGIT = /[0-9]/
const SPACE = /\s/

/**
 * Multi-character operators, longest first so `<=>` wins over `<=` and `<`.
 *
 * Grouping them matters for the formatter: a greedy `[=<>-]+` run would swallow
 * `=-` in `a=-1` as one token and the unary minus would lose its operand.
 */
const OPERATORS: readonly string[] = ['<=>', '->>', '<<', '>>', '<=', '>=', '<>', '!=', ':=', '||', '&&', '->']

/** End offset of the quoted run starting at `start` (exclusive; EOF when unterminated). */
function scanQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1
  while (index < sql.length) {
    const char = sql[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      // A doubled quote is an escaped quote, not the end of the run.
      if (sql[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index += 1
  }
  return sql.length
}

/** End offset of a line comment body starting after its marker. */
function lineEnd(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start)
  return newline === -1 ? sql.length : newline
}

/** Consume a numeric literal; returns the end offset. */
function scanNumber(sql: string, start: number): number {
  let index = start
  if (sql[index] === '0' && (sql[index + 1] === 'x' || sql[index + 1] === 'X')) {
    index += 2
    while (index < sql.length && /[0-9a-fA-F]/.test(sql.charAt(index))) index += 1
    return index
  }
  while (index < sql.length && DIGIT.test(sql.charAt(index))) index += 1
  if (sql[index] === '.' && DIGIT.test(sql.charAt(index + 1))) {
    index += 1
    while (index < sql.length && DIGIT.test(sql.charAt(index))) index += 1
  }
  const exponent = sql[index]
  if (exponent === 'e' || exponent === 'E') {
    let after = index + 1
    if (sql[after] === '+' || sql[after] === '-') after += 1
    if (DIGIT.test(sql.charAt(after))) {
      index = after
      while (index < sql.length && DIGIT.test(sql.charAt(index))) index += 1
    }
  }
  return index
}

/** Unquote a backtick identifier (doubled backticks mean one backtick). */
function quoteInner(text: string): string {
  const inner = text.length > 1 && text.endsWith('`') ? text.slice(1, -1) : text.slice(1)
  return inner.replace(/``/g, '`')
}

/**
 * Split SQL text into tokens, dropping whitespace.
 *
 * Comments are tokens (the formatter must place them back verbatim), and so are
 * string literals — which is why a `;` inside `'a;b'` cannot fool statement
 * splitting.
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql.charAt(index)
    if (SPACE.test(char)) {
      index += 1
      continue
    }
    const start = index
    let kind: SqlTokenKind

    if ((char === '-' && sql[index + 1] === '-') || char === '#') {
      index = lineEnd(sql, char === '#' ? index + 1 : index + 2)
      kind = 'comment'
    } else if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      kind = 'comment'
    } else if (char === "'" || char === '"' || char === '`') {
      index = scanQuoted(sql, index, char)
      kind = char === '`' ? 'quoted' : 'string'
    } else if (DIGIT.test(char)) {
      index = scanNumber(sql, index)
      kind = 'number'
    } else if (WORD_START.test(char)) {
      index += 1
      while (index < sql.length && WORD_PART.test(sql.charAt(index))) index += 1
      kind = 'word'
    } else if (char === '(' || char === ')' || char === ',' || char === ';' || char === '.') {
      index += 1
      kind = 'punct'
    } else {
      const operator = OPERATORS.find(candidate => sql.startsWith(candidate, index))
      index += operator === undefined ? 1 : operator.length
      kind = 'operator'
    }

    const text = sql.slice(start, index)
    tokens.push({
      kind,
      text,
      // Only a quoted identifier has a written form that differs from its name.
      value: kind === 'quoted' ? quoteInner(text) : text,
      start,
      end: index,
    })
  }
  return tokens
}

/** Half-open character range in the document. */
export interface SqlRange {
  readonly start: number
  readonly end: number
}

/** Clamp `offset` into `[0, length]`. */
function clampOffset(offset: number, length: number): number {
  if (Number.isNaN(offset)) return 0
  return Math.max(0, Math.min(Math.trunc(offset), length))
}

/**
 * The statement a caret offset belongs to, as the text between two `;` tokens.
 *
 * Deliberately raw ranges: completion wants the whole statement text (including
 * a trailing comment) while lint wants to highlight it. Statement splitting for
 * execution lives in `execute/split.ts`; this one only ever needs the bounds of
 * the statement the caret is in.
 */
export function statementRange(tokens: readonly SqlToken[], offset: number, docLength: number): SqlRange {
  const at = clampOffset(offset, docLength)
  let start = 0
  let end = docLength
  for (const token of tokens) {
    if (token.kind !== 'punct' || token.text !== ';') continue
    if (token.end <= at) {
      start = token.end
      continue
    }
    end = token.start
    break
  }
  return { start, end }
}

/** Keyword casing strategies for {@link formatSql}. */
export type KeywordCase = 'upper' | 'lower' | 'preserve'

export interface FormatOptions {
  /** How to case the keywords the formatter recognises. Default `upper`. */
  readonly keywordCase?: KeywordCase
  /** Spaces per nesting level. Default 2. */
  readonly indent?: number
}

/** Multi-word clause openers, matched as one unit so `LEFT JOIN` breaks once. */
const PHRASES: readonly (readonly string[])[] = [
  ['LEFT', 'OUTER', 'JOIN'],
  ['RIGHT', 'OUTER', 'JOIN'],
  ['FULL', 'OUTER', 'JOIN'],
  ['NATURAL', 'LEFT', 'JOIN'],
  ['NATURAL', 'RIGHT', 'JOIN'],
  ['GROUP', 'BY'],
  ['ORDER', 'BY'],
  ['UNION', 'ALL'],
  ['LEFT', 'JOIN'],
  ['RIGHT', 'JOIN'],
  ['INNER', 'JOIN'],
  ['CROSS', 'JOIN'],
  ['FULL', 'JOIN'],
  ['NATURAL', 'JOIN'],
  ['INSERT', 'INTO'],
  ['DELETE', 'FROM'],
]

/** Clause openers that start a new line at the current nesting level. */
const BREAK_KEYS: ReadonlySet<string> = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
  'UNION', 'UNION ALL', 'WITH', 'INSERT INTO', 'UPDATE', 'DELETE', 'DELETE FROM',
  'SET', 'VALUES', 'JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'NATURAL LEFT JOIN',
  'RIGHT JOIN', 'RIGHT OUTER JOIN', 'NATURAL RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN',
  'FULL JOIN', 'FULL OUTER JOIN', 'NATURAL JOIN', 'STRAIGHT_JOIN',
])

/** Join openers; `ON`/`USING` indent one level deeper when the last clause was one. */
const JOIN_KEYS: ReadonlySet<string> = new Set([
  'JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'NATURAL LEFT JOIN', 'RIGHT JOIN',
  'RIGHT OUTER JOIN', 'NATURAL RIGHT JOIN', 'INNER JOIN', 'CROSS JOIN', 'FULL JOIN',
  'FULL OUTER JOIN', 'NATURAL JOIN', 'STRAIGHT_JOIN',
])
/** One matched clause opener: how many tokens it spans and its normalised key. */
interface PhraseMatch {
  readonly key: string
  readonly length: number
}

/** Match a multi-word opener at `index`; `null` when the tokens are not one. */
function matchPhrase(tokens: readonly SqlToken[], index: number): PhraseMatch | null {
  for (const words of PHRASES) {
    let matches = true
    for (let offset = 0; offset < words.length; offset += 1) {
      const token = tokens[index + offset]
      if (token === undefined || token.kind !== 'word' || token.text.toUpperCase() !== words[offset]) {
        matches = false
        break
      }
    }
    if (matches) return { key: words.join(' '), length: words.length }
  }
  return null
}

/** Operators that only take one operand; the space after them is not a space. */
const UNARY_OPERATORS: ReadonlySet<string> = new Set(['-', '+', '!', '~'])

/**
 * Operand-openers after which a `-`/`+`/`!` is unary rather than binary.
 *
 * `WHERE -1` and `AND -x` are unary; `a - 1` is binary. The distinction is the
 * only reason `a=-1` formats as `a = -1` and not `a = - 1`.
 */
const UNARY_AFTER_KEYWORDS: ReadonlySet<string> = new Set([
  'AND', 'OR', 'NOT', 'WHERE', 'THEN', 'ELSE', 'WHEN', 'ON', 'SELECT', 'SET', 'BY',
  'HAVING', 'LIMIT', 'VALUES', 'IN', 'BETWEEN', 'LIKE', 'IS', 'INTO', 'FROM', 'RETURN',
])

/** Operators that are a sigil for the token after them (`@a`, `:name`). */
const SIGIL_OPERATORS: ReadonlySet<string> = new Set(['@', ':'])

/**
 * Format one SQL script.
 *
 * @param sql - Source text; may contain several `;`-separated statements.
 * @param options - Keyword casing and indent width.
 */
export function formatSql(sql: string, options: FormatOptions = {}): string {
  const tokens = tokenizeSql(sql)
  const size = Math.max(0, Math.trunc(options.indent ?? 2))
  const keywordCase = options.keywordCase ?? 'upper'

  const lines: string[] = []
  let current = ''
  let blockDepth = 0
  /** Innermost-first paren stack: `true` marks a subquery block. */
  const frames: boolean[] = []
  /** Open CASE expressions: where their `WHEN`/`END` align, and whether to break. */
  const cases: { readonly base: number; readonly block: boolean }[] = []
  let lastClause = ''
  /** Open `BETWEEN` count, so its `AND` does not look like a predicate joiner. */
  let between = 0
  let previous: SqlToken | undefined
  let unaryLast = false

  const indentOf = (depth: number): string => ' '.repeat(Math.max(0, depth) * size)
  const style = (word: string): string =>
    keywordCase === 'upper' ? word.toUpperCase() : keywordCase === 'lower' ? word.toLowerCase() : word
  const render = (token: SqlToken): string =>
    token.kind === 'word' && KEYWORD_SET.has(token.text.toUpperCase()) ? style(token.text) : token.text
  const isBlockNow = (): boolean => frames.length === 0 || frames[frames.length - 1] === true

  const write = (text: string, spaceBefore: boolean): void => {
    if (spaceBefore && current.trim() !== '') current += ' '
    current += text
  }
  /** End the current line, starting the next one at `depth`. */
  const breakLine = (depth: number): void => {
    if (current.trim() !== '') lines.push(current.trimEnd())
    current = indentOf(depth)
  }

  /** Whether a space belongs between the previous token and this one. */
  const spaceBefore = (token: SqlToken): boolean => {
    if (previous === undefined) return false
    if (token.kind === 'punct') {
      // `count(` hugs because the catalogue knows the name; `FROM (`, `IN (` and
      // `t (` (a column list) get a space. `t.col` hugs as well.
      if (token.text === '(') {
        if (previous.kind === 'quoted') return false
        return previous.kind !== 'word' || !isSqlFunction(previous.text)
      }
      return false
    }
    if (previous.kind === 'punct' && (previous.text === '(' || previous.text === '.')) return false
    if (previous.kind === 'operator' && unaryLast) return false
    // `@a` / `@@global.x` / `:name` are single lexical units with a sigil; a
    // space after the sigil would not parse as the same token.
    if (previous.kind === 'operator' && SIGIL_OPERATORS.has(previous.text)) return false
    return true
  }

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    /* v8 ignore next -- index is bounded by tokens.length */
    if (token === undefined) break

    if (token.kind === 'comment') {
      write(token.text, true)
      // A line comment owns the rest of its line; a block comment does not.
      if (token.text.startsWith('--') || token.text.startsWith('#')) breakLine(blockDepth)
      previous = token
      index += 1
      continue
    }

    if (token.kind === 'punct' && token.text === '(') {
      write('(', spaceBefore(token))
      const next = tokens[index + 1]
      const block = next !== undefined && next.kind === 'word' && /^(SELECT|WITH)$/i.test(next.text)
      frames.push(block)
      if (block) blockDepth += 1
      previous = token
      index += 1
      continue
    }

    if (token.kind === 'punct' && token.text === ')') {
      const block = frames.pop() === true
      if (block) {
        blockDepth -= 1
        breakLine(blockDepth)
      }
      write(')', false)
      previous = token
      index += 1
      continue
    }

    if (token.kind === 'punct' && token.text === ';') {
      write(';', false)
      breakLine(0)
      // A malformed statement may leave frames/case open; the next statement
      // starts level whatever the parser thought.
      frames.length = 0
      cases.length = 0
      blockDepth = 0
      lastClause = ''
      between = 0
      previous = token
      index += 1
      continue
    }

    if (token.kind === 'word') {
      const upper = token.text.toUpperCase()
      const phrase = matchPhrase(tokens, index)
      const key = phrase === null ? upper : phrase.key

      // CASE bookkeeping happens before the token is written: `END` dedents its
      // own line, `WHEN` indents against the CASE it belongs to.
      if (key === 'CASE') {
        cases.push({ base: blockDepth, block: isBlockNow() })
      } else if (key === 'WHEN' || key === 'ELSE') {
        const open = cases[cases.length - 1]
        if (open !== undefined && open.block) breakLine(open.base + 1)
      } else if (key === 'END') {
        const open = cases.pop()
        if (open !== undefined && open.block) breakLine(open.base)
      }

      if (phrase !== null) {
        // Every multi-word opener in PHRASES is a clause break; a phrase that
        // appears inside a function's argument list stays inline.
        if (isBlockNow()) {
          breakLine(blockDepth)
          lastClause = key
        }
      } else if ((key === 'ON' || key === 'USING') && isBlockNow() && JOIN_KEYS.has(lastClause)) {
        breakLine(blockDepth + 1)
      } else if (key === 'AND' || key === 'OR') {
        if (key === 'AND' && between > 0) {
          between -= 1
        } else if (isBlockNow()) {
          // A predicate inside a CASE condition indents past its WHEN line.
          const open = cases[cases.length - 1]
          breakLine(blockDepth + (open?.block === true ? 2 : 1))
        }
      } else if (BREAK_KEYS.has(key) && isBlockNow()) {
        breakLine(blockDepth)
        lastClause = key
      }

      if (key === 'BETWEEN') between += 1

      if (phrase === null) {
        write(render(token), spaceBefore(token))
        unaryLast = false
        previous = token
        index += 1
        continue
      }

      for (let offset = 0; offset < phrase.length; offset += 1) {
        const word = tokens[index + offset]
        /* v8 ignore next -- phrase matching guarantees every word is present */
        if (word === undefined) break
        write(render(word), offset === 0 ? spaceBefore(word) : true)
        previous = word
      }
      unaryLast = false
      index += phrase.length
      continue
    }

    // Number, string, quoted identifier, operator or punctuation.
    const operator = token.kind === 'operator' ? token.text : ''
    const unary =
      operator !== '' &&
      UNARY_OPERATORS.has(operator) &&
      (previous === undefined ||
        previous.kind === 'operator' ||
        (previous.kind === 'punct' && (previous.text === '(' || previous.text === ',')) ||
        (previous.kind === 'word' && UNARY_AFTER_KEYWORDS.has(previous.text.toUpperCase())))
    write(token.text, spaceBefore(token))
    unaryLast = unary
    previous = token
    index += 1
  }

  breakLine(0)
  return lines.join('\n')
}
