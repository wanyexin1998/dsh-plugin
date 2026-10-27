import { describe, expect, it } from 'vitest'

import type { QueryField } from '../src/execute/core.ts'
import {
  RESULT_TABLE_PLACEHOLDER,
  columnList,
  insertSql,
  quoteSqlIdent,
  sqlLiteral,
  updateSql,
  whereIn,
} from '../src/client/result-actions.ts'

const columns: QueryField[] = [
  { name: 'order_id', typeName: 'BIGINT' },
  { name: 'customer', typeName: 'VARCHAR' },
]

describe('sqlLiteral', () => {
  it('renders numbers, booleans, dates and bytes as SQL literals', () => {
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral(Number.NaN)).toBe('NULL')
    expect(sqlLiteral(10n)).toBe('10')
    expect(sqlLiteral(true)).toBe('1')
    expect(sqlLiteral(false)).toBe('0')
    expect(sqlLiteral(new Date('2026-10-01T08:12:33.000Z'))).toBe("'2026-10-01 08:12:33'")
    expect(sqlLiteral(new Uint8Array([0xde, 0xad]))).toBe("X'dead'")
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(undefined)).toBe('NULL')
  })

  it('quotes and escapes strings', () => {
    expect(sqlLiteral("O'Hara")).toBe("'O''Hara'")
    expect(sqlLiteral('a\\b')).toBe("'a\\\\b'")
    expect(sqlLiteral({ toString: () => 'obj' } as unknown)).toBe("'obj'")
  })
})

describe('identifiers', () => {
  it('quotes with doubled backticks', () => {
    expect(quoteSqlIdent('order_id')).toBe('`order_id`')
    expect(quoteSqlIdent('we`ird')).toBe('`we``ird`')
  })

  it('builds a column list with an optional alias', () => {
    expect(columnList(columns)).toBe('`order_id`, `customer`')
    expect(columnList(columns, 'o')).toBe('`o`.`order_id`, `o`.`customer`')
    expect(columnList(columns, '')).toBe('`order_id`, `customer`')
  })
})

describe('whereIn', () => {
  it('dedupes values and skips NULL', () => {
    const page = [[1], [2], [1], [null]]
    expect(whereIn(page, 0, 'order_id')).toEqual({
      sql: 'WHERE `order_id` IN (1, 2)',
      count: 2,
      truncated: false,
    })
  })

  it('caps the number of copied values and reports truncation', () => {
    const page = Array.from({ length: 5 }, (_value, index) => [index])
    const outcome = whereIn(page, 0, 'id', 3)
    expect(outcome.count).toBe(3)
    expect(outcome.truncated).toBe(true)
    expect(outcome.sql).toBe('WHERE `id` IN (0, 1, 2)')
  })
})

describe('insertSql / updateSql', () => {
  const rows = [[1, "O'Hara"], [2, null]]

  it('wraps rows in one INSERT statement', () => {
    expect(insertSql(RESULT_TABLE_PLACEHOLDER, columns, rows)).toBe(
      "INSERT INTO `result` (`order_id`, `customer`)\nVALUES (1, 'O''Hara'),\n  (2, NULL)",
    )
  })

  it('uses the first column as the reviewable WHERE key', () => {
    const sql = updateSql('`orders`', columns, [7, 'Alice'])
    expect(sql).toContain('UPDATE `orders`')
    expect(sql).toContain('`customer` = \'Alice\'')
    expect(sql).toContain('WHERE `order_id` = 7')
    expect(sql).toContain('LIMIT 1')
  })

  it('degrades to a comment when there is no column', () => {
    expect(updateSql('t', [], [])).toContain('没有列')
  })
})
