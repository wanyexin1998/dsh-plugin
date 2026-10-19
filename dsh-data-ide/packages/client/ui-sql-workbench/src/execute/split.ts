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
      if (statements.length < limit) statements.push({ text, start: start + leading })
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

