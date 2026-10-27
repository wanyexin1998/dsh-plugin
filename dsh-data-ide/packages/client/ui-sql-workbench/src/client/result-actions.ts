/**
 * Turning a result selection into SQL text (SQL-402).
 *
 * Pure and DOM-free: the grid owns the selection, these functions own the
 * literals. They are deliberately conservative — a copied statement should be
 * reviewable and runnable, not clever: identifiers are backtick-quoted, strings
 * are single-quoted with both `'` and `\` escaped, NULL stays NULL.
 */

import type { QueryField } from '../execute/core.ts'

/** SQL literal for one raw driver value. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
  if (value instanceof Uint8Array) {
    let hex = ''
    for (const byte of value) hex += byte.toString(16).padStart(2, '0')
    return `X'${hex}'`
  }
  const text = typeof value === 'string' ? value : String(value)
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** Backtick-quote one identifier, doubling embedded backticks. */
export function quoteSqlIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

/** `col1, col2` with optional `alias.` prefix. */
export function columnList(columns: readonly QueryField[], alias?: string): string {
  const prefix = alias === undefined || alias === '' ? '' : `${quoteSqlIdent(alias)}.`
  return columns.map(column => `${prefix}${quoteSqlIdent(column.name)}`).join(', ')
}

/**
 * `WHERE `col` IN (…), …` for the selected column.
 *
 * Values are de-duplicated and capped so a mis-drag cannot copy thousands of
 * literals; the count is reported through {@link inListResult}.
 *
 * @param rows - Raw page rows.
 * @param columnIndex - Column the selection spans.
 * @param columnName - Identifier to put on the left side.
 * @param maxValues - Safety cap (default 200).
 */
export function whereIn(
  rows: readonly (readonly unknown[])[],
  columnIndex: number,
  columnName: string,
  maxValues = 200,
): { readonly sql: string; readonly count: number; readonly truncated: boolean } {
  const seen = new Set<string>()
  let truncated = false
  for (const row of rows) {
    const literal = sqlLiteral(row[columnIndex])
    if (literal === 'NULL') continue
    if (!seen.has(literal)) {
      if (seen.size >= maxValues) {
        truncated = true
        break
      }
      seen.add(literal)
    }
  }
  return {
    sql: `WHERE ${quoteSqlIdent(columnName)} IN (${[...seen].join(', ')})`,
    count: seen.size,
    truncated,
  }
}

/**
 * `INSERT INTO `table` (`a`, `b`) VALUES (…), (…)`.
 *
 * @param table - Target table as written by the user/selection.
 * @param columns - Column metadata.
 * @param rows - Raw rows to insert (already the selection).
 */
export function insertSql(
  table: string,
  columns: readonly QueryField[],
  rows: readonly (readonly unknown[])[],
): string {
  const names = columns.map(column => quoteSqlIdent(column.name)).join(', ')
  const values = rows.map(row => `(${columns.map((_column, index) => sqlLiteral(row[index])).join(', ')})`).join(',\n  ')
  return `INSERT INTO ${table} (${names})\nVALUES ${values}`
}

/**
 * `UPDATE `table` SET … WHERE `firstColumn` = … LIMIT 1`.
 *
 * The first column doubles as the row key: grid rows carry no primary-key
 * metadata, so the generated statement is a **reviewable skeleton**, not a
 * guaranteed-unique match. The comment says so in the copied text.
 */
export function updateSql(
  table: string,
  columns: readonly QueryField[],
  row: readonly unknown[],
): string {
  const key = columns[0]
  if (key === undefined) return `-- 没有列可用于生成 UPDATE`
  const assignments = columns
    .slice(1)
    .map(column => `  ${quoteSqlIdent(column.name)} = ${sqlLiteral(row[columns.indexOf(column)])}`)
    .join(',\n')
  return `-- 确认 WHERE 条件唯一后再执行\nUPDATE ${table}\nSET\n${assignments}\nWHERE ${quoteSqlIdent(key.name)} = ${sqlLiteral(row[0])}\nLIMIT 1`
}

/** `INSERT` needs a table name; the grid has none, so this is the placeholder. */
export const RESULT_TABLE_PLACEHOLDER = '`result`'
