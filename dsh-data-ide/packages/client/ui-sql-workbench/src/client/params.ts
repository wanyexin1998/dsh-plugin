/**
 * Named SQL parameters (SQL-403).
 *
 * A deliberately small dialect: `:name` placeholders are replaced with literals
 * **before** execution. That keeps the execution core unchanged (and the MCP
 * contract byte-identical), while giving the console a quick way to re-run a
 * query with different values. It is not server-side binding: values never leave
 * this module as text.
 */

/** One `:name` occurrence in the SQL text. */
export interface SqlParam {
  readonly name: string
  readonly start: number
  readonly end: number
}

/** True for characters that may continue an identifier. */
function isIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 || // _
    code === 36 // $
  )
}

/**
 * Find `:name` placeholders outside strings, quoted identifiers and comments.
 *
 * `::type` casts are skipped, as is a colon that follows an identifier character
 * (`a:b` is not a parameter in practice and treating it as one would corrupt
 * the statement).
 *
 * @param sql - Statement text.
 */
export function findSqlParams(sql: string): readonly SqlParam[] {
  const params: SqlParam[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]
    if (char === "'" || char === '"' || char === '`') {
      // Skip the quoted run, honouring doubled quotes.
      index += 1
      while (index < sql.length) {
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
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === ':' && next !== ':' && sql[index - 1] !== ':') {
      const previous = sql.charCodeAt(index - 1)
      if (!isIdentChar(previous)) {
        let end = index + 1
        while (end < sql.length && isIdentChar(sql.charCodeAt(end))) end += 1
        if (end > index + 1) {
          const name = sql.slice(index + 1, end)
          // A leading digit cannot start a name (`:1` is not `:name`).
          if (!/^\d/.test(name)) {
            params.push({ name, start: index, end })
            index = end
            continue
          }
        }
      }
    }
    index += 1
  }
  return params
}

/** Unique parameter names, in first-appearance order. */
export function paramNames(params: readonly SqlParam[]): readonly string[] {
  const names: string[] = []
  for (const param of params) {
    if (!names.includes(param.name)) names.push(param.name)
  }
  return names
}

/** One literal from what the user typed: numbers stay raw, everything else is quoted. */
export function paramLiteral(raw: string): string {
  const text = raw.trim()
  if (text === '' || /^null$/i.test(text)) return 'NULL'
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return text
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/**
 * Replace every placeholder with a literal from `values`.
 *
 * Missing names keep their placeholder (the driver then reports the mistake) —
 * better than silently running a different query.
 *
 * @param sql - Statement text.
 * @param values - Raw user input per parameter name.
 */
export function substituteSqlParams(sql: string, values: Readonly<Record<string, string>>): string {
  const params = findSqlParams(sql)
  let output = ''
  let cursor = 0
  for (const param of params) {
    const raw = values[param.name]
    if (raw === undefined) continue
    output += sql.slice(cursor, param.start) + paramLiteral(raw)
    cursor = param.end
  }
  return output + sql.slice(cursor)
}
