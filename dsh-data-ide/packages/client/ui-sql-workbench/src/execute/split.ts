/**
 * Script splitting for multi-statement execution.
 *
 * DataGrip's editor runs a whole script and shows one result tab per statement
 * (docs/03 §4.3 has the same shape in mind). Splitting has to respect strings
 * and comments — a `;` inside `'a;b'` is not a terminator — so this is a small
 * scanner rather than `split(';')`.
 *
 * It is deliberately not a parser: no DELIMITER blocks, no stored procedures.
 * Those are refused by the read-only policy anyway, and a wrong split inside a
 * procedure body is worse than refusing to split it.
 */

export interface SqlStatement {
  /** Statement text without the trailing semicolon, trimmed. */
  readonly text: string
  /** Offset of the first non-space character in the original script. */
  readonly start: number
  /** Offset just past the last character of `text` (exclusive); start ≤ end. */
  readonly end: number
}

/** Ceiling on statements per script; a runaway paste must not queue forever. */
export const MAX_SCRIPT_STATEMENTS = 50

/**
 * Split a script into statements.
 *
 * @param sql - Whole editor contents (or a selection).
 * @param limit - Statements kept; the rest are dropped.
 */
export function splitStatements(sql: string, limit: number = MAX_SCRIPT_STATEMENTS): SqlStatement[] {
  const statements: SqlStatement[] = []
  let start = 0
  let index = 0

  /** Push `[start, end)` if it holds more than whitespace. */
  const push = (end: number): void => {
    const raw = sql.slice(start, end)
    const text = raw.trim()
    if (text !== '') {
      const leading = raw.length - raw.trimStart().length
      if (statements.length < limit) {
        const begin = start + leading
        statements.push({ text, start: begin, end: begin + text.length })
      }
    }
    start = end + 1
  }

  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if ((char === '-' && next === '-') || char === '#') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2)
      index = close === -1 ? sql.length : close + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < sql.length) {
        if (sql[index] === '\\') {
          index += 2
          continue
        }
        if (sql[index] === char) {
          if (sql[index + 1] === char) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === ';') {
      push(index)
      index += 1
      continue
    }
    index += 1
  }

  push(sql.length)
  return statements
}

/** True when the script holds more than one statement. */
export function isScript(sql: string): boolean {
  return splitStatements(sql).length > 1
}

/**
 * Whether one chunk holds real SQL rather than comments/whitespace only.
 *
 * A script may end with a trailing `-- note`; running that alone is a syntax
 * error, so run-at-cursor treats such chunks as "no statement".
 */
function hasSql(text: string): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?:--|#)[^\n]*/g, ' ')
    .trim()
  return stripped !== ''
}

/**
 * The statement a caret offset belongs to.
 *
 * Picks the statement whose trimmed text contains the offset; an offset in the
 * whitespace/comments between two statements belongs to the one on its right
 * (the place the user is about to type into). Offsets past the last statement
 * fall back to the last one; an empty or comment-only script yields `null`.
 *
 * @param sql - Whole editor contents.
 * @param offset - Caret offset in `sql` (clamped to the document).
 */
export function statementAt(sql: string, offset: number): SqlStatement | null {
  // `limit` bounds how many statements are returned, not how far the scanner
  // reads — one statement is at least one character, so `sql.length + 1` keeps
  // every statement of a large script.
  const statements = splitStatements(sql, Math.max(1, sql.length + 1)).filter(statement => hasSql(statement.text))
  const first = statements[0]
  if (first === undefined) return null
  const position = Math.max(0, Math.min(Math.trunc(offset), sql.length))
  for (const statement of statements) {
    if (position <= statement.end) return statement
  }
  // Non-empty by the guard above; the fallback is the last statement when the
  // caret sits past every statement's trimmed end.
  return statements[statements.length - 1] as SqlStatement
}

