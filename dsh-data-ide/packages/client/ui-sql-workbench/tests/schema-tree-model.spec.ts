import { describe, expect, it } from 'vitest'

import type { SchemaTable } from '../src/client/completion.ts'
import {
  MENU_SIZE,
  ddlFromRow,
  ddlSql,
  ddlTitle,
  describeSchema,
  filterGroups,
  groupBySchema,
  groupKey,
  menuPosition,
  nullRateText,
  openDataSql,
  overviewSampleSql,
  overviewStatsSql,
  qualifiedName,
  quoteIdent,
  schemaKey,
  tableKey,
  columnKey,
} from '../src/client/schema-tree.ts'

const order: SchemaTable = { schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }
const customer: SchemaTable = { schema: 'dwd', kind: 'table', name: 'dwd_customer', columns: [{ name: 'customer_name', type: 'VARCHAR' }] }
const view: SchemaTable = { schema: 'dwd', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] }
const flat: SchemaTable = { name: 'loose', columns: [{ name: 'id', type: 'INT' }] }

describe('groupBySchema', () => {
  it('splits tables from views and sorts both by name', () => {
    const groups = groupBySchema([view, order, customer])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.schema).toBe('dwd')
    expect(groups[0]?.tables.map(table => table.name)).toEqual(['dwd_customer', 'dwd_order'])
    expect(groups[0]?.views.map(table => table.name)).toEqual(['v_daily'])
  })

  it('keeps separate schemas apart and sorts them', () => {
    const groups = groupBySchema([
      { schema: 'zzz', name: 'b', columns: [] },
      { schema: 'aaa', name: 'a', columns: [] },
    ])

    expect(groups.map(group => group.schema)).toEqual(['aaa', 'zzz'])
  })

  it('folds a snapshot without schema names into one unnamed group', () => {
    const groups = groupBySchema([flat])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.schema).toBe('')
  })

  it('treats an unknown kind as a table', () => {
    expect(groupBySchema([{ name: 'x', columns: [] }])[0]?.tables).toHaveLength(1)
  })
})

describe('filterGroups', () => {
  it('returns everything for a blank needle', () => {
    const groups = groupBySchema([order, view])
    expect(filterGroups(groups, '   ')).toBe(groups)
  })

  it('matches a table name and keeps the whole table', () => {
    const filtered = filterGroups(groupBySchema([order, customer]), 'customer')

    expect(filtered[0]?.tables.map(table => table.name)).toEqual(['dwd_customer'])
    expect(filtered[0]?.tables[0]?.columns.map(column => column.name)).toEqual(['customer_name'])
  })

  it('matches a column name and narrows the columns', () => {
    const wide: SchemaTable = {
      schema: 'dwd',
      name: 'dwd_order',
      columns: [{ name: 'order_id', type: 'BIGINT' }, { name: 'paid_at', type: 'DATETIME' }],
    }
    const filtered = filterGroups(groupBySchema([wide]), 'paid')

    expect(filtered[0]?.tables[0]?.name).toBe('dwd_order')
    expect(filtered[0]?.tables[0]?.columns.map(column => column.name)).toEqual(['paid_at'])
  })

  it('drops groups with nothing left', () => {
    expect(filterGroups(groupBySchema([order, customer]), 'nope')).toEqual([])
  })
})

describe('quoting', () => {
  it('quotes identifiers and doubles inner backticks', () => {
    expect(quoteIdent('order')).toBe('`order`')
    expect(quoteIdent('we`ird')).toBe('`we``ird`')
  })

  it('qualifies only when a schema is known', () => {
    expect(qualifiedName(order)).toBe('`dwd`.`dwd_order`')
    expect(qualifiedName(flat)).toBe('`loose`')
    expect(qualifiedName({ schema: '', name: 'x', columns: [] })).toBe('`x`')
  })
})

describe('statements', () => {
  it('builds the Edit Data statement with a page limit', () => {
    expect(openDataSql(order)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 100')
    expect(openDataSql(order, 10)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 10')
  })

  it('asks for a table or a view DDL', () => {
    expect(ddlSql({ schema: 'dwd', table: 'dwd_order' })).toBe('SHOW CREATE TABLE `dwd`.`dwd_order`')
    expect(ddlSql({ schema: 'dwd', table: 'v_daily', kind: 'view' })).toBe('SHOW CREATE VIEW `dwd`.`v_daily`')
    expect(ddlSql({ schema: '', table: 'loose' })).toBe('SHOW CREATE TABLE `loose`')
  })

  it('labels the DDL dialog with the target', () => {
    expect(ddlTitle({ schema: 'dwd', table: 'dwd_order' })).toBe('TABLE · dwd.dwd_order')
    expect(ddlTitle({ schema: 'dwd', table: 'v_daily', kind: 'view' })).toBe('VIEW · dwd.v_daily')
    expect(ddlTitle({ schema: '', table: 'loose' })).toBe('TABLE · loose')
  })

  it('picks the CREATE statement out of a SHOW CREATE row', () => {
    expect(ddlFromRow(['dwd_order', 'CREATE TABLE `dwd_order` (id int)'])).toContain('CREATE TABLE')
    // Doris: [View, Create View, character_set_client, collation_connection]
    expect(ddlFromRow(['v', 'CREATE VIEW v AS SELECT 1', 'utf8', 'utf8_general_ci'])).toContain('CREATE VIEW')
    // A row without a statement is not DDL.
    expect(ddlFromRow(['only-name'])).toBe('')
    expect(ddlFromRow([])).toBe('')
    expect(ddlFromRow(undefined)).toBe('')
  })
})

describe('node keys', () => {
  it('names each level distinctly, including the schema', () => {
    expect(schemaKey('dwd')).toBe('schema:dwd')
    expect(groupKey('dwd', 'view')).toBe('group:dwd:view')
    expect(tableKey(order)).toBe('table:dwd:dwd_order')
    expect(tableKey(flat)).toBe('table::loose')
    expect(columnKey(order, 'order_id')).toBe('column:dwd:dwd_order:order_id')
  })
})

describe('describeSchema', () => {
  it('summarises objects, schemas and views', () => {
    expect(describeSchema([])).toBe('0 个对象')
    expect(describeSchema([order, customer])).toBe('2 个对象')
    expect(describeSchema([order, view])).toBe('2 个对象 · 含 1 视图')
    expect(describeSchema([order, { schema: 'ads', name: 'a', columns: [] }])).toBe('2 个库 · 2 个对象')
  })
})

describe('menuPosition', () => {
  const viewport = { width: 1000, height: 800 }

  it('opens at the pointer by default', () => {
    expect(menuPosition({ x: 100, y: 200 }, MENU_SIZE, viewport)).toEqual({ left: 100, top: 200 })
  })

  it('flips left and up near the edges', () => {
    expect(menuPosition({ x: 900, y: 700 }, MENU_SIZE, viewport)).toEqual({
      left: 900 - MENU_SIZE.width,
      top: 700 - MENU_SIZE.height,
    })
  })

  it('never leaves a negative coordinate', () => {
    expect(menuPosition({ x: 2, y: 2 }, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 4, top: 4 })
  })
})

describe('overview helpers', () => {
  it('asks for the total plus one COUNT per column in a single statement', () => {
    expect(overviewStatsSql(order)).toBe(
      'SELECT COUNT(*) AS `总行数`,\n  COUNT(`order_id`) AS `n1`\nFROM `dwd`.`dwd_order`',
    )
    expect(
      overviewStatsSql({
        schema: 'dwd',
        name: 'wide',
        columns: [{ name: 'a', type: 'INT' }, { name: 'b', type: 'INT' }],
      }),
    ).toBe('SELECT COUNT(*) AS `总行数`,\n  COUNT(`a`) AS `n1`,\n  COUNT(`b`) AS `n2`\nFROM `dwd`.`wide`')
  })

  it('degrades to a bare COUNT when the object has no column metadata', () => {
    expect(overviewStatsSql({ name: 'empty', columns: [] })).toBe('SELECT COUNT(*) AS `总行数`\nFROM `empty`')
  })

  it('asks for a small sample page, clamped into a sane band', () => {
    expect(overviewSampleSql(order)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 20')
    expect(overviewSampleSql(order, 5)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 5')
    expect(overviewSampleSql(order, 0)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 1')
    expect(overviewSampleSql(order, 12.9)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 12')
    expect(overviewSampleSql(order, 5000)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 1000')
    expect(overviewSampleSql(order, Number.NaN)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 20')
    expect(overviewSampleSql(order, Number.POSITIVE_INFINITY)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 20')
  })

  it('renders a null rate with one decimal, folding the exact ends', () => {
    expect(nullRateText(100, 100)).toBe('0%')
    expect(nullRateText(0, 100)).toBe('100%')
    expect(nullRateText(90, 100)).toBe('10.0%')
    expect(nullRateText(1, 3)).toBe('66.7%')
    expect(nullRateText(150, 100)).toBe('0%')
    expect(nullRateText(-5, 100)).toBe('100%')
  })

  it('reports unknown null rates instead of inventing one', () => {
    expect(nullRateText(0, 0)).toBe('—')
    expect(nullRateText(10, 0)).toBe('—')
    expect(nullRateText(Number.NaN, 10)).toBe('—')
    expect(nullRateText(5, Number.NaN)).toBe('—')
  })
})
