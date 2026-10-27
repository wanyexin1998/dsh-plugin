import { describe, expect, it } from 'vitest'

import { formatSql, isSqlKeyword, statementRange, tokenizeSql } from '../src/client/sql-format.ts'
import type { FormatOptions, SqlToken } from '../src/client/sql-format.ts'

/** Format with defaults, for the many cases that only exercise layout. */
function fmt(sql: string, options?: FormatOptions): string {
  return formatSql(sql, options)
}

/** `[kind, text]` pairs, which is what the scanner tests assert against. */
function kinds(sql: string): [string, string][] {
  return tokenizeSql(sql).map(token => [token.kind, token.text])
}

describe('tokenizeSql', () => {
  it('separates words, numbers, strings, quoted identifiers, comments and operators', () => {
    expect(kinds("select `a b`, 'it''s', 1.5e3 from t -- note\nwhere x <=> 0x1F # tail")).toEqual([
      ['word', 'select'],
      ['quoted', '`a b`'],
      ['punct', ','],
      ['string', "'it''s'"],
      ['punct', ','],
      ['number', '1.5e3'],
      ['word', 'from'],
      ['word', 't'],
      ['comment', '-- note'],
      ['word', 'where'],
      ['word', 'x'],
      ['operator', '<=>'],
      ['number', '0x1F'],
      ['comment', '# tail'],
    ])
  })

  it('keeps quoted identifiers unquoted as their value', () => {
    const [quoted] = tokenizeSql('`a``b`')
    expect(quoted?.kind).toBe('quoted')
    expect(quoted?.text).toBe('`a``b`')
    expect(quoted?.value).toBe('a`b')
    // An unterminated quote is still one token, with the leading backtick gone.
    expect(tokenizeSql('`abc')[0]?.value).toBe('abc')
    expect(tokenizeSql('`abc')[0]?.text).toBe('`abc')
    expect(tokenizeSql('`')[0]?.value).toBe('')
  })

  it('handles escapes, doubled quotes and unterminated strings/comments', () => {
    expect(kinds("'a\\'b'")).toEqual([['string', "'a\\'b'"]])
    expect(kinds("'a''b'")).toEqual([['string', "'a''b'"]])
    expect(kinds("'abc")).toEqual([['string', "'abc"]])
    expect(kinds('/* x y')).toEqual([['comment', '/* x y']])
    expect(kinds('/* x */ 1')).toEqual([['comment', '/* x */'], ['number', '1']])
    // A doubled backtick inside a string is just two quotes, not an escape.
    expect(kinds('"a""b"')).toEqual([['string', '"a""b"']])
  })

  it('scans numbers: integer, decimal, exponent and hex', () => {
    expect(kinds('1 1.5 1.5e3 1.5E-3 0xFF')).toEqual([
      ['number', '1'],
      ['number', '1.5'],
      ['number', '1.5e3'],
      ['number', '1.5E-3'],
      ['number', '0xFF'],
    ])
    // `1e` is not an exponent: the number ends before the `e`.
    expect(kinds('1e')).toEqual([['number', '1'], ['word', 'e']])
    // `1.` is not a decimal literal either — the dot stays a member access dot.
    expect(kinds('1.foo')).toEqual([['number', '1'], ['punct', '.'], ['word', 'foo']])
  })

  it('groups multi-character operators, and keeps sigils single', () => {
    expect(kinds('a<=>b')).toEqual([['word', 'a'], ['operator', '<=>'], ['word', 'b']])
    expect(kinds('a<=b')).toEqual([['word', 'a'], ['operator', '<='], ['word', 'b']])
    expect(kinds('a<>b')).toEqual([['word', 'a'], ['operator', '<>'], ['word', 'b']])
    expect(kinds('a||b')).toEqual([['word', 'a'], ['operator', '||'], ['word', 'b']])
    expect(kinds('@a')).toEqual([['operator', '@'], ['word', 'a']])
    expect(kinds('/ b')).toEqual([['operator', '/'], ['word', 'b']])
    expect(kinds('a / b')).toEqual([['word', 'a'], ['operator', '/'], ['word', 'b']])
  })

  it('treats `#` and `--` as comments and a single `-` as an operator', () => {
    expect(kinds('a - b')).toEqual([['word', 'a'], ['operator', '-'], ['word', 'b']])
    expect(kinds('a # b\nc')).toEqual([['word', 'a'], ['comment', '# b'], ['word', 'c']])
  })
})

describe('isSqlKeyword', () => {
  it('knows clause words in any case and nothing else', () => {
    expect(isSqlKeyword('select')).toBe(true)
    expect(isSqlKeyword('SELECT')).toBe(true)
    expect(isSqlKeyword('where')).toBe(true)
    // Functions are not keywords: that distinction decides `count(` vs `IN (`.
    expect(isSqlKeyword('count')).toBe(false)
    expect(isSqlKeyword('dwd_order')).toBe(false)
  })
})

describe('statementRange', () => {
  const sql = 'select 1; select 2;'
  const tokens: SqlToken[] = tokenizeSql(sql)

  it('returns the statement around the offset', () => {
    expect(statementRange(tokens, 3, sql.length)).toEqual({ start: 0, end: 8 })
    expect(statementRange(tokens, 12, sql.length)).toEqual({ start: 9, end: 18 })
  })

  it('clamps the offset into the document', () => {
    expect(statementRange(tokens, -5, sql.length)).toEqual({ start: 0, end: 8 })
    expect(statementRange(tokens, 999, sql.length)).toEqual({ start: 19, end: 19 })
    expect(statementRange(tokens, Number.NaN, sql.length)).toEqual({ start: 0, end: 8 })
  })

  it('returns the whole text when there is no separator', () => {
    expect(statementRange(tokenizeSql('select 1'), 4, 8)).toEqual({ start: 0, end: 8 })
  })

  it('does not split on a semicolon inside a string or comment', () => {
    const tricky = "select 'a;b' -- ;\n"
    expect(statementRange(tokenizeSql(tricky), 3, tricky.length)).toEqual({ start: 0, end: tricky.length })
  })
})

describe('formatSql layout', () => {
  it('breaks a simple statement at its clauses', () => {
    expect(fmt("select id, name from dwd_order where dt = '2026-10-01' and amount > 100 order by id limit 10")).toBe([
      'SELECT id, name',
      'FROM dwd_order',
      "WHERE dt = '2026-10-01'",
      '  AND amount > 100',
      'ORDER BY id',
      'LIMIT 10',
    ].join('\n'))
  })

  it('puts joins on their own lines and indents their ON clause', () => {
    expect(fmt("select o.id, v.day from dwd.dwd_order o left join ads.v_daily v on o.id = v.id where v.day = '2026-10-01'")).toBe([
      'SELECT o.id, v.day',
      'FROM dwd.dwd_order o',
      'LEFT JOIN ads.v_daily v',
      '  ON o.id = v.id',
      "WHERE v.day = '2026-10-01'",
    ].join('\n'))
  })

  it('indents subqueries inside parentheses', () => {
    expect(fmt('select * from t where id in (select id from u where x = 1)')).toBe([
      'SELECT *',
      'FROM t',
      'WHERE id IN (',
      '  SELECT id',
      '  FROM u',
      '  WHERE x = 1',
      ')',
    ].join('\n'))
  })

  it('keeps function arguments and column lists inline', () => {
    expect(fmt("insert into t (a, b) values (concat('x', 'y'), now())")).toBe([
      'INSERT INTO t (a, b)',
      "VALUES (concat('x', 'y'), now())",
    ].join('\n'))
  })

  it('lays out CASE expressions one WHEN per line', () => {
    expect(fmt("select case when a = 1 then 'x' when a = 2 then 'y' else 'z' end as c from t")).toBe([
      'SELECT CASE',
      "  WHEN a = 1 THEN 'x'",
      "  WHEN a = 2 THEN 'y'",
      "  ELSE 'z'",
      'END AS c',
      'FROM t',
    ].join('\n'))
  })

  it('indents a predicate inside a CASE condition past its WHEN', () => {
    expect(fmt('select case when a = 1 and b = 2 then 1 else 0 end from t')).toBe([
      'SELECT CASE',
      '  WHEN a = 1',
      '    AND b = 2 THEN 1',
      '  ELSE 0',
      'END',
      'FROM t',
    ].join('\n'))
  })

  it('leaves BETWEEN … AND … on one line and breaks the next predicate', () => {
    expect(fmt('select * from t where a between 1 and 2 and b = 3')).toBe([
      'SELECT *',
      'FROM t',
      'WHERE a BETWEEN 1 AND 2',
      '  AND b = 3',
    ].join('\n'))
  })

  it('keeps a CASE that sits inside a function call inline', () => {
    expect(fmt('select count(case when a = 1 then 1 end) from t')).toBe([
      'SELECT count(CASE WHEN a = 1 THEN 1 END)',
      'FROM t',
    ].join('\n'))
  })

  it('keeps a window spec inline', () => {
    expect(fmt('select row_number() over (partition by a order by b) as rn from t')).toBe([
      'SELECT row_number() OVER (PARTITION BY a ORDER BY b) AS rn',
      'FROM t',
    ].join('\n'))
  })

  it('formats UPDATE, DELETE, INSERT … SELECT and UNION scripts', () => {
    expect(fmt('update t set a = 1 where id = 2')).toBe('UPDATE t\nSET a = 1\nWHERE id = 2')
    expect(fmt('delete from t where id = 2')).toBe('DELETE FROM t\nWHERE id = 2')
    expect(fmt('insert into t select a from u')).toBe('INSERT INTO t\nSELECT a\nFROM u')
    expect(fmt('select 1 union all select 2')).toBe('SELECT 1\nUNION ALL\nSELECT 2')
    expect(fmt('select 1 union select 2')).toBe('SELECT 1\nUNION\nSELECT 2')
  })

  it('formats WITH clauses and their indented bodies', () => {
    expect(fmt('with c as (select 1 as x) select x from c')).toBe([
      'WITH c AS (',
      '  SELECT 1 AS x',
      ')',
      'SELECT x',
      'FROM c',
    ].join('\n'))
  })

  it('formats GROUP BY / HAVING / OFFSET and DESC', () => {
    expect(fmt('select a from t group by a having count(*) > 1 order by a desc limit 10 offset 20')).toBe([
      'SELECT a',
      'FROM t',
      'GROUP BY a',
      'HAVING count(*) > 1',
      'ORDER BY a DESC',
      'LIMIT 10',
      'OFFSET 20',
    ].join('\n'))
  })

  it('splits several statements but drops the blank lines between them', () => {
    expect(fmt('select 1;\n\nselect 2;')).toBe('SELECT 1;\nSELECT 2;')
  })

  it('returns an empty string when there is nothing to format', () => {
    expect(fmt('')).toBe('')
    expect(fmt('   \n\t ')).toBe('')
  })
})

describe('formatSql spacing', () => {
  it('handles unary and binary signs', () => {
    expect(fmt('select -1, a - 1, b = -2, -a from t')).toBe([
      'SELECT -1, a - 1, b = -2, -a',
      'FROM t',
    ].join('\n'))
    expect(fmt('-1')).toBe('-1')
  })

  it('normalises multi-character operators', () => {
    expect(fmt('select a<=>b, c<>d, e!=f from t')).toBe('SELECT a <=> b, c <> d, e != f\nFROM t')
  })

  it('keeps column lists spaced and call parentheses tight', () => {
    expect(fmt('select round(a,2), ifnull(b,0) from t')).toBe('SELECT round(a, 2), ifnull(b, 0)\nFROM t')
    expect(fmt('select * from t where a = (select 1)')).toBe('SELECT *\nFROM t\nWHERE a = (\n  SELECT 1\n)')
  })

  it('does not put spaces inside a quoted function name', () => {
    expect(fmt('select `fn` (1) from t')).toBe('SELECT `fn`(1)\nFROM t')
  })

  it('keeps sigils attached to their variable', () => {
    expect(fmt('set @a = 1, @@global.x = :name')).toBe('SET @a = 1, @@global.x = :name')
  })

  it('only indents ON after a join, not a stray one', () => {
    expect(fmt('select * from t on 1 = 1')).toBe('SELECT *\nFROM t ON 1 = 1')
  })

  it('leaves AND/OR inline inside an expression parenthesis', () => {
    expect(fmt('select * from t where (a = 1 and b = 2) or c = 3')).toBe([
      'SELECT *',
      'FROM t',
      'WHERE (a = 1 AND b = 2)',
      '  OR c = 3',
    ].join('\n'))
  })

  it('keeps the ON DUPLICATE tail on the VALUES line and breaks at UPDATE', () => {
    expect(fmt('insert into t values (1) on duplicate key update a = 2')).toBe([
      'INSERT INTO t',
      'VALUES (1) ON DUPLICATE KEY',
      'UPDATE a = 2',
    ].join('\n'))
  })
})

describe('formatSql literals and comments', () => {
  it('keeps string literals byte for byte, including newlines', () => {
    const sql = 'select \'a;b\nc\', "d" from t'
    expect(fmt(sql)).toBe('SELECT \'a;b\nc\', "d"\nFROM t')
    expect(fmt('select * from t where name like \'%x%\'')).toBe("SELECT *\nFROM t\nWHERE name LIKE '%x%'")
  })

  it('keeps quoted identifiers as typed', () => {
    expect(fmt('select `a b`, `c` from `my table`')).toBe('SELECT `a b`, `c`\nFROM `my table`')
  })

  it('keeps comments verbatim and pushes a line comment onto its own line', () => {
    expect(fmt('select a -- keep\nfrom t')).toBe('SELECT a -- keep\nFROM t')
    expect(fmt('# note\nselect 1')).toBe('# note\nSELECT 1')
    expect(fmt('select /* keep  me */ a from t')).toBe('SELECT /* keep  me */ a\nFROM t')
    expect(fmt('select /* x')).toBe('SELECT /* x')
  })
})

describe('formatSql options', () => {
  it('cases keywords upper by default, lower on request, and preserves on request', () => {
    expect(fmt('select A from T')).toBe('SELECT A\nFROM T')
    expect(fmt('SELECT A FROM T', { keywordCase: 'lower' })).toBe('select A\nfrom T')
    expect(fmt('SeLeCt A FROM T', { keywordCase: 'preserve' })).toBe('SeLeCt A\nFROM T')
    expect(fmt('SeLeCt A FROM T', { keywordCase: 'upper' })).toBe('SELECT A\nFROM T')
  })

  it('honours the indent width and clamps negatives to zero', () => {
    expect(fmt('select * from t where a = 1 and b = 2', { indent: 4 })).toBe([
      'SELECT *',
      'FROM t',
      'WHERE a = 1',
      '    AND b = 2',
    ].join('\n'))
    expect(fmt('select * from t where a = 1 and b = 2', { indent: 0 })).toBe([
      'SELECT *',
      'FROM t',
      'WHERE a = 1',
      'AND b = 2',
    ].join('\n'))
    expect(fmt('select * from t where a = 1 and b = 2', { indent: -3 })).toBe([
      'SELECT *',
      'FROM t',
      'WHERE a = 1',
      'AND b = 2',
    ].join('\n'))
  })
})

describe('formatSql invariants', () => {
  const sample = [
    "with recent as (select o.id, sum(o.amount) as total from dwd.dwd_order o where o.dt >= date_sub(now(), interval 7 day) group by o.id)",
    "select r.id, case when r.total > 100 then 'big' else 'small' end as size,",
    "  row_number() over (partition by r.size order by r.total desc) as rn",
    'from recent r left join ads.v_daily v on v.id = r.id',
    "where r.total between 10 and 1000 and v.day = '2026-10-01'",
    'order by r.total desc limit 100;',
    'delete from dwd.tmp_order',
    '-- trailing note',
  ].join('\n')

  /** What must not change: the token stream, with keywords compared case-blind. */
  function tokenSignature(sql: string): string[] {
    return tokenizeSql(sql).map(token =>
      token.kind === 'word' && isSqlKeyword(token.text)
        ? `word:${token.text.toUpperCase()}`
        : `${token.kind}:${token.value}`)
  }

  it('is idempotent', () => {
    const once = fmt(sample)
    expect(fmt(once)).toBe(once)
  })

  it('changes layout only, never the token stream', () => {
    const formatted = fmt(sample)
    expect(tokenSignature(formatted)).toEqual(tokenSignature(sample))
    // And a second pass through the options does not diverge either.
    expect(tokenSignature(fmt(formatted, { keywordCase: 'lower' }))).toEqual(tokenSignature(sample))
  })

  it('stays idempotent for awkward inputs', () => {
    for (const sql of ['select (1)', 'select ((select 1)) x', 'select 1;;select 2', ';', '-- only a comment']) {
      const once = fmt(sql)
      expect(fmt(once)).toBe(once)
    }
  })
})
