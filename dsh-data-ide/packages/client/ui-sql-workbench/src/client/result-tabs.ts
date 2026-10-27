/**
 * Result-tab naming from the statement text (SQL-314).
 *
 * A tab is easiest to find when it says what it reads: `dwd_order`, or
 * `dwd_order+dwd_customer` for a join. Only FROM/JOIN targets are considered;
 * a statement without one keeps the old "first column: type" label. This is a
 * label, not a parser: a FROM inside a string literal may still win, which is
 * why the fallback stays sane and the user can always read the SQL on hover.
 */

/** Quoted or bare identifier, with an optional `schema.` prefix. */
const TABLE_REF = /\b(?:from|join)\s+(`(?:[^`]|``)+`|[A-Za-z_][\w$]*)(?:\s*\.\s*(`(?:[^`]|``)+`|[A-Za-z_][\w$]*))?/gi

/** Strip backticks and unescape doubled ones. */
function cleanIdent(raw: string): string {
  if (!raw.startsWith('`')) return raw
  return raw.slice(1, -1).replace(/``/g, '`')
}

/**
 * Tab title from the first two FROM/JOIN targets, or `null` when there is none
 * (callers then fall back to the column label).
 *
 * @param sql - Statement text.
 */
export function parseTableTitle(sql: string): string | null {
  const names: string[] = []
  for (const match of sql.matchAll(TABLE_REF)) {
    // Group 2 is the table when a schema prefix was present; group 1 always
    // participates, so this is never undefined.
    const raw = (match[2] ?? match[1]) as string
    const name = cleanIdent(raw)
    if (!names.includes(name)) names.push(name)
    if (names.length === 2) break
  }
  return names.length === 0 ? null : names.join('+')
}
