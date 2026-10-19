import { describe, expect, it } from 'vitest'

import type { QueryField } from '../src/execute/core.ts'
import {
  AGGREGATES,
  aggregate,
  describeRange,
  displayCharset,
  firstNumericColumn,
  isNumericKind,
  numericSamples,
  readStat,
  rowsInBox,
} from '../src/client/stats.ts'

const columns: QueryField[] = [
  { name: 'customer', typeName: 'VARCHAR' },
  { name: 'amount', typeName: 'DECIMAL' },
  { name: 'qty', typeName: 'LONG' },
]

describe('aggregate functions', () => {
  it('offers DataGrip’s set, SUM first', () => {
    expect(AGGREGATES).toEqual(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'DISTINCT'])
  })

  it('computes each function', () => {
    const samples = [1, 2, 2, 6]
    expect(aggregate(samples, 'SUM')).toBe(11)
    expect(aggregate(samples, 'AVG')).toBeCloseTo(2.75)
    expect(aggregate(samples, 'MIN')).toBe(1)
    expect(aggregate(samples, 'MAX')).toBe(6)
    expect(aggregate(samples, 'COUNT')).toBe(4)
    expect(aggregate(samples, 'DISTINCT')).toBe(3)
  })

  it('answers nothing for an empty range', () => {
    for (const fn of AGGREGATES) expect(aggregate([], fn)).toBeNull()
  })
})

describe('numeric samples', () => {
  const rows: unknown[][] = [
    [1, '10.5'],
    [2, null],
    [3, ''],
    [4, 'n/a'],
    [5, '7'],
  ]

  it('keeps numbers and numeric strings, drops NULL and junk', () => {
    // A blank or a label must not drag an average to zero.
    expect(numericSamples(rows, [0, 1, 2, 3, 4], 1)).toEqual([10.5, 7])
  })

  it('reads only the rows it is given, and tolerates out-of-range indexes', () => {
    expect(numericSamples(rows, [0, 4], 1)).toEqual([10.5, 7])
    expect(numericSamples(rows, [9], 1)).toEqual([])
    expect(numericSamples(rows, [0], 9)).toEqual([])
  })

  it('classifies columns for the aggregator', () => {
    expect(isNumericKind('number')).toBe(true)
    expect(isNumericKind('text')).toBe(false)
    expect(columns.map(column => firstNumericColumn([column]))).toEqual([null, 0, 0])
    expect(firstNumericColumn(columns)).toBe(1)
    expect(firstNumericColumn([{ name: 'c', typeName: 'VARCHAR' }])).toBeNull()
  })
})

describe('rowsInBox', () => {
  it('covers the whole page without a selection', () => {
    expect(rowsInBox(null, 3)).toEqual([0, 1, 2])
  })

  it('normalises a backwards drag and clamps to the page', () => {
    expect(rowsInBox({ fromRow: 3, toRow: 1 }, 5)).toEqual([1, 2, 3])
    expect(rowsInBox({ fromRow: -5, toRow: 99 }, 4)).toEqual([0, 1, 2, 3])
  })

  it('yields nothing when the page is empty', () => {
    expect(rowsInBox(null, 0)).toEqual([])
    expect(rowsInBox({ fromRow: 0, toRow: 0 }, 0)).toEqual([])
    // A backwards box is normalised, not dropped.
    expect(rowsInBox({ fromRow: 2, toRow: 1 }, 3)).toEqual([1, 2])
  })
})

describe('describeRange', () => {
  it('describes the page when nothing is selected', () => {
    expect(describeRange(null, 100, 6)).toBe('整页 100 行 × 6 列')
  })

  it('describes the rectangle when something is', () => {
    expect(describeRange({ fromRow: 0, fromColumn: 0, toRow: 2, toColumn: 1 }, 100, 6)).toBe('选区 3 行 × 2 列')
    expect(describeRange({ fromRow: 4, fromColumn: 3, toRow: 1, toColumn: 0 }, 100, 6)).toBe('选区 4 行 × 4 列')
  })
})

describe('readStat', () => {
  const rows: unknown[][] = [
    ['a', '1000', 2],
    ['b', '2500.5', 3],
    ['c', null, 5],
  ]

  it('labels the aggregate with the column it ran on', () => {
    const stat = readStat(rows, columns, [0, 1, 2], 1, 'SUM')
    expect(stat.label).toBe('SUM(amount)')
    // Grouped the way the cells are, so the two agree visually.
    expect(stat.text).toBe('3,500.5')
    expect(stat.value).toBeCloseTo(3500.5)
    expect(stat.column).toBe('amount')
  })

  it('falls back to the first numeric column when none is chosen', () => {
    expect(readStat(rows, columns, [0, 1], null, 'MAX').label).toBe('MAX(amount)')
  })

  it('respects the chosen column', () => {
    expect(readStat(rows, columns, [0, 1, 2], 2, 'SUM').text).toBe('10')
  })

  it('shows a dash when there is no numeric column at all', () => {
    const textOnly: QueryField[] = [{ name: 'customer', typeName: 'VARCHAR' }]
    const stat = readStat([['a']], textOnly, [0], null, 'SUM')

    expect(stat).toEqual({ fn: 'SUM', column: null, value: null, label: 'SUM', text: '—' })
  })

  it('shows a dash when the range has no numbers', () => {
    const stat = readStat([['a', null, 1]], columns, [0], 1, 'AVG')
    expect(stat.text).toBe('—')
    expect(stat.value).toBeNull()
  })
})

describe('displayCharset', () => {
  it('reports the document encoding in upper case', () => {
    expect(displayCharset('utf-8')).toBe('UTF-8')
    expect(displayCharset(undefined)).toBe('UTF-8')
  })
})
