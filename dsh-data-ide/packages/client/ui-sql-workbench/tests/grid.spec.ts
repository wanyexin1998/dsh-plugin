import { describe, expect, it } from 'vitest'

import type { QueryField } from '../src/execute/core.ts'
import {
  cellText,
  formatRows,
  inSelection,
  normalizeSelection,
  selectionToTsv,
  toCsv,
} from '../src/client/grid.ts'

const columns: QueryField[] = [
  { name: 'order_id', typeName: 'BIGINT' },
  { name: 'customer', typeName: 'VARCHAR' },
]

const rows: readonly (readonly unknown[])[] = [
  [1, 'Alice'],
  [2, 'bob'],
  [3, null],
]

describe('formatRows', () => {
  it('formats every cell once and keeps a lower-cased copy for filtering', () => {
    const cells = formatRows([[1, 'Alice']], columns)

    expect(cells[0]?.[0]).toMatchObject({ text: '1', lower: '1' })
    expect(cells[0]?.[1]).toMatchObject({ text: 'Alice', lower: 'alice' })
  })

  it('marks NULL cells', () => {
    expect(formatRows([[3, null]], columns)[0]?.[1]).toMatchObject({ text: 'NULL', isNull: true })
  })
})

describe('selection', () => {
  it('normalises a drag in any direction', () => {
    expect(normalizeSelection({ fromRow: 2, fromColumn: 1, toRow: 0, toColumn: 0 })).toEqual({
      fromRow: 0,
      fromColumn: 0,
      toRow: 2,
      toColumn: 1,
    })
  })

  it('reports whether a cell is inside', () => {
    const selection = { fromRow: 0, fromColumn: 0, toRow: 1, toColumn: 1 }
    expect(inSelection(selection, 1, 1)).toBe(true)
    expect(inSelection(selection, 2, 0)).toBe(false)
  })

  it('copies the selected rectangle as TSV', () => {
    expect(selectionToTsv(rows, columns, { fromRow: 0, fromColumn: 0, toRow: 1, toColumn: 1 })).toBe(
      '1\tAlice\n2\tbob',
    )
  })

  it('handles a single cell and a missing row', () => {
    expect(selectionToTsv(rows, columns, { fromRow: 2, fromColumn: 1, toRow: 2, toColumn: 1 })).toBe('NULL')
    expect(selectionToTsv(rows, columns, { fromRow: 9, fromColumn: 0, toRow: 9, toColumn: 1 })).toBe('')
  })
})

describe('toCsv', () => {
  it('writes a header and CRLF rows', () => {
    expect(toCsv(columns, [[1, 'Alice']])).toBe('order_id,customer\r\n1,Alice')
  })

  it('quotes fields with commas, quotes or newlines', () => {
    expect(toCsv(columns, [[1, 'a,b'], [2, 'say "hi"'], [3, 'two\nlines']])).toBe(
      'order_id,customer\r\n1,"a,b"\r\n2,"say ""hi"""\r\n3,"two\nlines"',
    )
  })

  it('renders NULL as the grid does', () => {
    expect(toCsv(columns, [[3, null]])).toBe('order_id,customer\r\n3,NULL')
  })
})

describe('cellText', () => {
  it('matches the rendered cell text', () => {
    expect(cellText([1, 'Alice'], columns[0] as QueryField, 0)).toBe('1')
    expect(cellText([3, null], columns[1] as QueryField, 1)).toBe('NULL')
  })
})

describe('selection outside the column range', () => {
  it('renders an empty cell rather than throwing', () => {
    expect(selectionToTsv(rows, columns, { fromRow: 0, fromColumn: 0, toRow: 0, toColumn: 5 })).toBe('1\tAlice\t\t\t\t')
  })
})
