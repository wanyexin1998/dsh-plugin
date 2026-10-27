import { describe, expect, it } from 'vitest'

import type { SchemaIndex } from '../src/client/completion.ts'
import { expandStar, resolveQualified, resolveTableRef, scanTableRefs } from '../src/client/expand-star.ts'
import { tokenizeSql } from '../src/client/sql-format.ts'

const schema: SchemaIndex = {
  tables: [
    {
      schema: 'dwd',
      kind: 'table',
      name: 'dwd_order',
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'amount', type: 'DECIMAL(10,2)' },
        { name: 'dt', type: 'DATE' },
        { name: 'order', type: 'VARCHAR(20)' },
        { name: 'full name', type: 'VARCHAR(20)' },
      ],
    },
    { schema: 'ads', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] },
    { schema: 'ads', kind: 'view', name: 'v_empty', columns: [] },
    { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
    { schema: 'db1', name: 'dup', columns: [{ name: 'a', type: 'INT' }] },
    { schema: 'db2', name: 'dup', columns: [{ name: 'b', type: 'INT' }] },
  ],
}

/** All refs of the whole document. */
function refsOf(sql: string) {
  const tokens = tokenizeSql(sql)
  return scanTableRefs(tokens, { start: 0, end: sql.length })
}

/** Caret at the end of `marker` (first occurrence), then `expandStar`. */
function expandAt(sql: string, marker: string, hint?: string): string | null {
  const index = sql.indexOf(marker)
  expect(index).toBeGreaterThanOrEqual(0)
  return expandStar(sql, { from: index + marker.length, to: index + marker.length }, schema, hint)
}

describe('scanTableRefs', () => {
  it('finds FROM and JOIN references with their aliases', () => {
    const refs = refsOf('select * from dwd.dwd_order o join ads.v_daily v on o.id = v.id')
    expect(refs.map(ref => ({ path: ref.path, alias: ref.alias, derived: ref.derived }))).toEqual([
      { path: ['dwd', 'dwd_order'], alias: 'o', derived: false },
      { path: ['ads', 'v_daily'], alias: 'v', derived: false },
    ])
  })

  it('reads a declared alias, and falls back to the table name', () => {
    const refs = refsOf('select * from t1 x, t2 where 1 = 1')
    expect(refs.map(ref => ref.alias)).toEqual(['x', 't2'])
    expect(refsOf('select * from dwd.dwd_order as o').map(ref => ref.alias)).toEqual(['o'])
    expect(refs[0]?.path).toEqual(['t1'])
  })

  it('continues a FROM list over commas but not over a WHERE keyword', () => {
    const refs = refsOf('select * from a, b, c where x = 1')
    expect(refs.map(ref => ref.path.join('.'))).toEqual(['a', 'b', 'c'])
    expect(refsOf("select * from a where b like '%x%'").map(ref => ref.path.join('.'))).toEqual(['a'])
    // A keyword after the alias is not an alias.
    expect(refsOf('select * from a where x = 1')[0]?.alias).toBe('a')
  })

  it('finds the tables of UPDATE, INSERT INTO and STRAIGHT_JOIN', () => {
    expect(refsOf('update a, b set x = 1').map(ref => ref.path.join('.'))).toEqual(['a', 'b'])
    expect(refsOf('insert into t (a) values (1)').map(ref => ref.path.join('.'))).toEqual(['t'])
    expect(refsOf('select * from a straight_join b').map(ref => ref.path.join('.'))).toEqual(['a', 'b'])
  })

  it('skips DERIVED tables, recording their alias only', () => {
    const refs = refsOf('select * from (select 1) x join real_t y on 1 = 1')
    expect(refs.map(ref => ({ path: ref.path, alias: ref.alias, derived: ref.derived }))).toEqual([
      { path: [], alias: 'x', derived: true },
      { path: ['real_t'], alias: 'y', derived: false },
    ])
  })

  it('ignores keywords inside function parentheses', () => {
    const refs = refsOf('select extract(year from dt), substring(name from 2) from t')
    expect(refs.map(ref => ref.path.join('.'))).toEqual(['t'])
    // A subquery parenthesis is not a function call, so its FROM still counts.
    expect(refsOf('select * from t where id in (select id from u)').map(ref => ref.path.join('.')))
      .toEqual(['t', 'u'])
  })

  it('ignores the UPDATE of ON DUPLICATE KEY UPDATE and INTO OUTFILE', () => {
    expect(refsOf('insert into t values (1) on duplicate key update a = 2').map(ref => ref.path.join('.')))
      .toEqual(['t'])
    expect(refsOf("select * into outfile '/tmp/x' from t").map(ref => ref.path.join('.'))).toEqual(['t'])
    expect(refsOf('select * into dumpfile "/tmp/x" from t').map(ref => ref.path.join('.'))).toEqual(['t'])
  })

  it('reads backtick-quoted names and keeps their unquoted value', () => {
    const refs = refsOf('select * from `my db`.`my table` t')
    expect(refs[0]?.path).toEqual(['my db', 'my table'])
    expect(refs[0]?.alias).toBe('t')
  })

  it('only scans the requested statement range', () => {
    const sql = 'select * from a; select * from b'
    const tokens = tokenizeSql(sql)
    expect(scanTableRefs(tokens, { start: 0, end: 16 }).map(ref => ref.alias)).toEqual(['a'])
    expect(scanTableRefs(tokens, { start: 16, end: sql.length }).map(ref => ref.alias)).toEqual(['b'])
  })

  it('records the token range of each reference', () => {
    const sql = 'select * from dwd.t x'
    const [ref] = refsOf(sql)
    expect(sql.slice(ref?.from, ref?.to)).toBe('dwd.t')
  })

  it('survives an unbalanced parenthesis without inventing a reference', () => {
    expect(refsOf('select * from (select 1')).toEqual([])
    // A stray close paren is ignored; the real reference after it still counts.
    expect(refsOf('select * from t)').map(ref => ref.path.join('.'))).toEqual(['t'])
    expect(refsOf('select 1')).toEqual([])
  })

  it('tolerates incomplete or malformed references', () => {
    expect(refsOf('select * from')).toEqual([])
    expect(refsOf('select * from 1')).toEqual([])
    expect(refsOf('select * from `t`').map(ref => ref.path.join('.'))).toEqual(['t'])
    // A trailing dot is a broken path but must not swallow the next token.
    expect(refsOf('select * from t.').map(ref => ref.path.join('.'))).toEqual(['t'])
    expect(refsOf('select * from t.1').map(ref => ref.path.join('.'))).toEqual(['t'])
    expect(refsOf('select * from t.`c`').map(ref => ref.path.join('.'))).toEqual(['t.c'])
    // AS with nothing usable after it leaves the table's own name as alias.
    expect(refsOf('select * from t as')[0]?.alias).toBe('t')
    expect(refsOf('select * from t as 1')[0]?.alias).toBe('t')
    expect(refsOf('select * from t as `a`')[0]?.alias).toBe('a')
    // `select * from (select 1)` has no alias to record.
    expect(refsOf('select * from (select 1)')[0]).toMatchObject({ derived: true, alias: '' })
  })
})

describe('expandStar', () => {
  it('expands a bare star into the columns of the only table', () => {
    expect(expandAt('SELECT * FROM dwd_order', '*')).toBe([
      'order_id,',
      '       amount,',
      '       dt,',
      '       `order`,',
      '       `full name`',
    ].join('\n'))
  })

  it('keeps a qualified star and lines the columns up under it', () => {
    const sql = 'SELECT o.* FROM dwd.dwd_order o'
    expect(expandStar(sql, { from: 10, to: 10 }, schema)).toBe([
      'o.order_id,',
      '         o.amount,',
      '         o.dt,',
      '         o.`order`,',
      '         o.`full name`',
    ].join('\n'))
  })

  it('expands a selected `alias.*` and preserves the qualifier as written', () => {
    const sql = 'SELECT `o`.* FROM dwd.dwd_order `o`'
    const from = sql.indexOf('`o`.*')
    const to = from + '`o`.*'.length
    expect(expandStar(sql, { from, to }, schema)).toBe([
      '`o`.order_id,',
      '           `o`.amount,',
      '           `o`.dt,',
      '           `o`.`order`,',
      '           `o`.`full name`',
    ].join('\n'))
  })

  it('expands a selected bare star', () => {
    const sql = 'SELECT * FROM loose'
    const from = sql.indexOf('*')
    expect(expandStar(sql, { from, to: from + 1 }, schema)).toBe('id')
  })

  it('accepts a schema-qualified hint, and honours it for a bare star', () => {
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, 'dwd.dwd_order'))
      .toBe('order_id,\n       amount,\n       dt,\n       `order`,\n       `full name`')
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, '`dwd`.`dwd_order`'))
      .toContain('order_id')
    // Unknown hints are ignored rather than guessed.
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, 'nope')).toBeNull()
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, 'dwd.nope')).toBeNull()
  })

  it('resolves a table that exists in two schemas only when the path is qualified', () => {
    expect(expandAt('SELECT * FROM dup', '*')).toBeNull()
    expect(expandAt('SELECT * FROM db1.dup', '*')).toBe('a')
    expect(expandAt('SELECT * FROM db2.dup', '*')).toBe('b')
  })

  it('resolves a dotted three-part star through the table name', () => {
    expect(expandAt('SELECT dwd.dwd_order.* FROM dwd.dwd_order', '*', undefined))
      .toContain('dwd.dwd_order.order_id')
  })

  it('returns null for every ambiguity or unknown target', () => {
    expect(expandAt('SELECT * FROM dwd_order o JOIN ads.v_daily v ON o.id = v.id', '*')).toBeNull()
    expect(expandAt('SELECT * FROM nope', '*')).toBeNull()
    expect(expandAt('SELECT * FROM v_empty', '*')).toBeNull()
    expect(expandAt('SELECT * FROM dwd_order', '*') === null).toBe(false)
    // Alias that resolves to nothing, or to a derived table, is not expanded.
    expect(expandAt('SELECT x.* FROM dwd_order', '*')).toBeNull()
    expect(expandAt('SELECT x.* FROM (SELECT 1) x', '*')).toBeNull()
    // No FROM at all: nothing to expand.
    expect(expandAt('SELECT *', '*')).toBeNull()
  })

  it('ignores a star that is not a wildcard', () => {
    // Multiplication is not a star reference.
    expect(expandAt('SELECT amount * 2 FROM dwd_order', '*')).toBeNull()
    // A star inside COUNT(*) is an argument, not a projection.
    expect(expandAt('SELECT COUNT(*) FROM dwd_order', '*')).toBeNull()
    // The caret is simply not on a star.
    expect(expandAt('SELECT a FROM dwd_order', 'a')).toBeNull()
  })

  it('refuses a selection that is more than the star expression', () => {
    const sql = 'SELECT * FROM dwd_order'
    expect(expandStar(sql, { from: 0, to: sql.length }, schema)).toBeNull()
    expect(expandStar(sql, { from: 7, to: 8 }, schema)).not.toBeNull()
    expect(expandStar('SELECT * FROM dwd_order', { from: 7, to: 8 }, undefined)).toBeNull()
  })

  it('aligns continuation lines with a star on an indented line', () => {
    expect(expandAt('SELECT\n  *\nFROM dwd_order', '*')).toBe([
      'order_id,',
      '  amount,',
      '  dt,',
      '  `order`,',
      '  `full name`',
    ].join('\n'))
  })

  it('keeps a star without a table when no hint is given', () => {
    expect(expandStar('SELECT * FROM', { from: 7, to: 7 }, schema)).toBeNull()
  })

  it('returns null for qualifier shapes it cannot resolve', () => {
    // A bare qualifier is looked up as a table name; `db` is no table here.
    expect(expandAt('SELECT db.* FROM dwd_order', '*')).toBeNull()
    expect(expandAt('SELECT db.t.* FROM dwd_order', '*')).toBeNull()
    // `1.*` is a number, not an identifier; `a b.*` has no valid qualifier chain.
    expect(expandAt('SELECT 1.* FROM dwd_order', '*')).toBeNull()
    expect(expandAt('SELECT 1.a.* FROM dwd_order', '*')).toBeNull()
    expect(expandAt('SELECT a b.* FROM dwd_order', '*')).toBeNull()
    // A document that starts with a star has no preceding wildcard position.
    expect(expandStar('* FROM t', { from: 0, to: 0 }, schema)).toBeNull()
  })

  it('rejects a selection holding two stars, or extra tokens', () => {
    const twoStars = 'SELECT *, *'
    expect(expandStar(twoStars, { from: 0, to: twoStars.length }, schema)).toBeNull()
    expect(expandStar('SELECT x, o.* FROM dwd.dwd_order o', { from: 'SELECT x, o.* FROM dwd.dwd_order o'.indexOf('x'), to: 44 }, schema))
      .toBeNull()
    expect(expandStar('SELECT * FROM loose', { from: 0, to: 8 }, schema)).toBeNull()
    // A valid three-part selection expands; one extra token invalidates it.
    const sql = 'SELECT dwd.dwd_order.* FROM dwd.dwd_order'
    const from = sql.indexOf('dwd.dwd_order.*')
    expect(expandStar(sql, { from, to: from + 'dwd.dwd_order.*'.length }, schema))
      .toContain('dwd.dwd_order.order_id')
    expect(expandStar(sql, { from: 0, to: from + 'dwd.dwd_order.*'.length }, schema)).toBeNull()
  })

  it('ignores empty or malformed hints', () => {
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, '')).toBeNull()
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, 'dwd.')).toBeNull()
    expect(expandStar('SELECT *', { from: 7, to: 7 }, schema, 'dwd_order')).toContain('order_id')
  })
})

describe('table resolution helpers', () => {
  const ref = {
    path: ['dwd', 'dwd_order'],
    name: 'dwd_order',
    schemaName: 'dwd',
    alias: 'o',
    explicitAlias: true,
    derived: false,
    from: 0,
    to: 3,
  }

  it('resolves a FROM/JOIN reference through the shared snapshot rules', () => {
    expect(resolveTableRef(schema, ref)?.name).toBe('dwd_order')
    expect(resolveTableRef(undefined, ref)).toBeNull()
  })

  it('resolves dotted paths, skipping empty segments', () => {
    expect(resolveQualified(schema, ['dwd', 'dwd_order'])?.name).toBe('dwd_order')
    expect(resolveQualified(schema, ['dwd', '', 'dwd_order'])?.name).toBe('dwd_order')
    expect(resolveQualified(schema, ['dwd_order'])?.name).toBe('dwd_order')
    expect(resolveQualified(schema, [])).toBeNull()
    expect(resolveQualified(undefined, ['dwd_order'])).toBeNull()
  })
})
