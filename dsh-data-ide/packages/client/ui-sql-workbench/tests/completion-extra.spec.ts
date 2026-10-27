import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import { sqlCompletionExtras, sqlFunctionCompletions } from '../src/client/completion-extra.ts'

const schema: SchemaIndex = {
  tables: [
    {
      schema: 'dwd',
      kind: 'table',
      name: 'dwd_order',
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'amount', type: 'DECIMAL' },
        { name: 'dt', type: 'DATE' },
        { name: 'order', type: 'VARCHAR' },
        { name: 'full name', type: 'VARCHAR' },
      ],
    },
    { schema: 'ads', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] },
    { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
    { schema: 'ads', kind: 'view', name: 'v_empty', columns: [] },
    { schema: 'db1', name: 'dup', columns: [{ name: 'a', type: 'INT' }] },
    { schema: 'db2', name: 'dup', columns: [{ name: 'b', type: 'INT' }] },
  ],
}

/** A real CompletionContext, the way CodeMirror hands one to a source. */
function ctx(doc: string, pos: number = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc, selection: { anchor: pos } }), pos, true)
}

/** Run one source and return its labels (or null when it declines). */
function labels(source: ReturnType<typeof sqlCompletionExtras>, doc: string, pos?: number): readonly string[] | null {
  const result = source(ctx(doc, pos))
  if (result === null || result instanceof Promise) return null
  return result.options.map(option => option.label)
}

/** All options of one source, for the cases that inspect apply/detail. */
function options(source: ReturnType<typeof sqlCompletionExtras>, doc: string, pos?: number) {
  const result = source(ctx(doc, pos))
  if (result === null || result instanceof Promise) throw new Error('no completion result')
  return result.options
}

/** Source over the shared schema unless a test needs another one. */
function extras(snapshot: SchemaIndex | undefined = schema) {
  return sqlCompletionExtras(snapshot)
}

describe('sqlCompletionExtras: tables', () => {
  it('offers every table after FROM, with the database as detail', () => {
    const result = extras()(ctx('SELECT * FROM '))
    expect(result).not.toBeNull()
    if (result === null || result instanceof Promise) return
    expect(result.from).toBe('SELECT * FROM '.length)
    expect(result.options.map(option => option.label)).toEqual(
      ['dwd_order', 'v_daily', 'loose', 'v_empty', 'dup', 'dup'],
    )
    const order = result.options.find(option => option.label === 'dwd_order')
    expect(order?.detail).toBe('dwd')
    expect(order?.apply).toBe('dwd_order')
    expect(result.options.find(option => option.label === 'loose')?.detail).toBe('表')
  })

  it('qualifies a table name that exists in more than one database', () => {
    const dup = options(extras(), 'SELECT * FROM ').filter(option => option.label === 'dup')
    expect(dup.map(option => option.apply)).toEqual(['db1.dup', 'db2.dup'])
  })

  it('offers tables after JOIN, UPDATE, INTO and TABLE', () => {
    for (const doc of [
      'SELECT * FROM a JOIN ',
      'UPDATE ',
      'INSERT INTO ',
      'ALTER TABLE ',
      'SELECT * FROM a STRAIGHT_JOIN ',
    ]) {
      expect(labels(extras(), doc)).toContain('dwd_order')
    }
  })

  it('continues a FROM list after a comma', () => {
    expect(labels(extras(), 'SELECT * FROM dwd_order, ')).toContain('v_daily')
  })

  it('quotes the inserted name when the user is typing inside backticks', () => {
    const doc = 'SELECT * FROM `dwd_o'
    const [first] = options(extras(), doc)
    expect(first?.label).toBe('dwd_order')
    expect(first?.apply).toBe('`dwd_order`')
  })
})

describe('sqlCompletionExtras: columns', () => {
  it('offers the columns of the one table in the statement, with their types', () => {
    const result = extras()(ctx('SELECT * FROM dwd_order WHERE '))
    expect(result).not.toBeNull()
    if (result === null || result instanceof Promise) return
    expect(result.options.map(option => option.label)).toEqual(['order_id', 'amount', 'dt', 'order', 'full name'])
    expect(result.options.find(option => option.label === 'amount')?.detail).toBe('DECIMAL')
    // A keyword or spaced name has to be quoted to parse; a plain one must not be.
    expect(result.options.find(option => option.label === 'order')?.apply).toBe('`order`')
    expect(result.options.find(option => option.label === 'full name')?.apply).toBe('`full name`')
    expect(result.options.find(option => option.label === 'amount')?.apply).toBe('amount')
  })

  it('qualifies with the alias the statement declared', () => {
    const document = 'SELECT * FROM dwd_order o WHERE '
    expect(labels(extras(), document)).toEqual(['o.order_id', 'o.amount', 'o.dt', 'o.order', 'o.full name'])
    const option = options(extras(), document)[3]
    expect(option?.label).toBe('o.order')
    expect(option?.apply).toBe('o.`order`')
  })

  it('qualifies every column when several tables are in play, and dedupes repeats', () => {
    const joined = labels(extras(), 'SELECT * FROM dwd.dwd_order o JOIN ads.v_daily v ON ')
    expect(joined).toContain('o.order_id')
    expect(joined).toContain('v.day')
    const repeated = labels(extras(), 'SELECT * FROM dwd_order, dwd_order WHERE ')
    expect(repeated).toEqual(['dwd_order.order_id', 'dwd_order.amount', 'dwd_order.dt', 'dwd_order.order', 'dwd_order.full name'])
  })

  it('works in every expression position', () => {
    for (const doc of [
      'UPDATE dwd_order SET ',
      'SELECT * FROM dwd_order WHERE dt = 1 AND ',
      'SELECT * FROM dwd_order WHERE dt = 1 OR ',
      'SELECT * FROM dwd_order GROUP BY ',
      'SELECT * FROM dwd_order ORDER BY ',
      'SELECT * FROM dwd_order WHERE dt IN (SELECT dt, ',
    ]) {
      expect(labels(extras(), doc)).toContain('dt')
    }
  })

  it('declines where it cannot be useful', () => {
    expect(labels(extras(), 'SELECT ')).toBeNull()
    expect(labels(extras(), 'SELECT *')).toBeNull()
    expect(labels(extras(), 'SELECT * FROM dwd_order ')).toBeNull()
    // A comma inside a function or IN-list is not an expression list.
    expect(labels(extras(), 'SELECT * FROM dwd_order WHERE id IN (1, ')).toBeNull()
    // Nothing before the caret at all, and a comma with no clause before it.
    expect(labels(extras(), 'S')).toBeNull()
    expect(labels(extras(), ', ')).toBeNull()
    // A function's closing parenthesis is skipped while walking back to the clause.
    expect(labels(extras(), 'SELECT COUNT(*), ')).toBeNull()
    expect(labels(extras(), 'SELECT * FROM dwd_order WHERE (amount = 1), ')).toContain('dt')
    // Views the catalogue could not describe offer no columns.
    expect(labels(extras(), 'SELECT * FROM v_empty WHERE ')).toBeNull()
  })

  it('offers columns of the real tables in a statement that also has a subquery', () => {
    expect(labels(extras(), 'SELECT * FROM (SELECT 1) x JOIN dwd_order o ON ')).toContain('o.order_id')
  })
})

describe('sqlCompletionExtras: members after a dot', () => {
  it('completes columns after an alias, a table name and a qualified table', () => {
    expect(labels(extras(), 'SELECT * FROM dwd.dwd_order o WHERE o.')).toContain('order_id')
    expect(labels(extras(), 'SELECT * FROM dwd_order WHERE dwd_order.')).toContain('amount')
    expect(labels(extras(), 'SELECT * FROM dwd.dwd_order.')).toContain('dt')
  })

  it('lists a database\'s tables after the database name', () => {
    const [option] = options(extras(), 'SELECT * FROM dwd.')
    expect(option?.label).toBe('dwd_order')
    expect(option?.detail).toBe('dwd')
    // The database part is already typed, so only the table name is inserted.
    expect(option?.apply).toBe('dwd_order')
  })

  it('quotes a column when the user is inside backticks', () => {
    const doc = 'SELECT * FROM dwd.dwd_order o WHERE o.`am'
    const option = options(extras(), doc).find(candidate => candidate.label === 'amount')
    expect(option?.apply).toBe('`amount`')
  })

  it('declines an unknown qualifier', () => {
    expect(labels(extras(), 'SELECT * FROM dwd_order WHERE x.')).toBeNull()
    expect(labels(extras(), 'SELECT * FROM nope.')).toBeNull()
    expect(labels(extras(), 'SELECT * FROM nope.nope.')).toBeNull()
    // A dot that does not follow an identifier is not a qualifier.
    expect(labels(extras(), 'SELECT .')).toBeNull()
  })
})

describe('sqlCompletionExtras: robustness', () => {
  it('declines without a schema snapshot', () => {
    expect(labels(sqlCompletionExtras(undefined), 'SELECT * FROM ')).toBeNull()
    expect(labels(sqlCompletionExtras({ tables: [] }), 'SELECT * FROM ')).toBeNull()
  })

  it('returns null instead of throwing when the editor state is broken', () => {
    const broken = {
      get state(): never {
        throw new Error('broken state')
      },
    } as unknown as CompletionContext
    expect(extras()(broken)).toBeNull()
  })
})

describe('sqlFunctionCompletions', () => {
  const functions = sqlFunctionCompletions()

  it('offers functions by prefix with their signatures', () => {
    const result = functions(ctx('SELECT su'))
    expect(result).not.toBeNull()
    if (result === null || result instanceof Promise) throw new Error('no result')
    expect(result.from).toBe('SELECT '.length)
    const labels = result.options.map(option => option.label)
    expect(labels).toContain('SUM')
    expect(labels).toContain('SUBSTR')
    expect(labels).toContain('SUBSTRING')
    expect(result.options.find(option => option.label === 'SUM')?.detail).toBe('SUM(expr)')
    expect(result.options.every(option => option.type === 'function')).toBe(true)
  })

  it('declines without a typed prefix, in table positions, and inside quotes', () => {
    expect(functions(ctx('SELECT '))).toBeNull()
    expect(functions(ctx('SELECT * FROM su'))).toBeNull()
    expect(functions(ctx('SELECT `su'))).toBeNull()
    expect(functions(ctx('SELECT zzzz'))).toBeNull()
  })

  it('respects the limit and offers functions in expression positions', () => {
    const limited = sqlFunctionCompletions(1)(ctx('SELECT s'))
    if (limited === null || limited instanceof Promise) throw new Error('no result')
    expect(limited.options).toHaveLength(1)
    expect(labels(functions, 'SELECT * FROM t WHERE co')).toContain('COALESCE')
  })

  it('returns null instead of throwing when the editor state is broken', () => {
    const broken = {
      get state(): never {
        throw new Error('broken state')
      },
    } as unknown as CompletionContext
    expect(functions(broken)).toBeNull()
  })
})
