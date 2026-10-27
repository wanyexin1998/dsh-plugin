import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PAGE_SIZE,
  MAX_CELL_BYTES,
  MAX_PAGE_SIZE,
  buildCountQuery,
  buildPagedQuery,
  filterClause,
  checkPermission,
  createStatementRegistry,
  executeSql,
  fetchPage,
  firstStatement,
  normalizePageSize,
  truncateRow,
} from '../src/execute/core.ts'
import { runExecuteSql, runFetchPage, cancelStatement } from '../src/execute/envelope.ts'
import type { ConnectionSpec } from '../src/host/runtime-specs.ts'

const connId = 'ds-f02da6e0'
const spec: ConnectionSpec = {
  name: 'doris',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  username: 'wanyexin',
  password: 'p',
  driverProperties: {},
  writeEnabled: false,
}

/** Executor double that answers the page query and the count query separately. */
function fakeExecutor(page: { fields?: string[]; rows: unknown[][] }, count?: unknown[][]) {
  const calls: string[] = []
  return {
    calls,
    cancel: vi.fn(async () => undefined),
    query: vi.fn(async (_spec: ConnectionSpec, sql: string) => {
      calls.push(sql)
      if (sql.includes('COUNT(*)')) return { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: count ?? [[0]] }
      return { fields: (page.fields ?? ['a', 'b']).map(name => ({ name, typeName: 'LONG' })), rows: page.rows }
    }),
  }
}

function deps(executor: ReturnType<typeof fakeExecutor>, writeEnabled = false, now = () => 0) {
  return {
    specs: async () => ({ schemaVersion: 1 as const, generatedAt: 'x', connections: { [connId]: { ...spec, writeEnabled } } }),
    executor,
    registry: createStatementRegistry(),
    now,
  }
}

describe('permission gate', () => {
  it('allows reads', () => {
    expect(checkPermission('SELECT 1', false)).toBeUndefined()
    expect(checkPermission('  with t as (select 1) select * from t ', false)).toBeUndefined()
  })

  it('refuses writes until a human enables them', () => {
    expect(checkPermission('UPDATE t SET a = 1', false)).toMatchObject({ code: 'WRITE_NOT_ALLOWED' })
    expect(checkPermission('insert into t values (1)', false)).toMatchObject({ code: 'WRITE_NOT_ALLOWED' })
    expect(checkPermission('UPDATE t SET a = 1', true)).toBeUndefined()
  })

  it('refuses DDL even with writes enabled', () => {
    for (const sql of ['DROP TABLE t', 'truncate t', 'ALTER TABLE t ADD c INT', 'GRANT ALL ON *.* TO u']) {
      expect(checkPermission(sql, true)).toMatchObject({ code: 'DDL_FORBIDDEN' })
    }
  })

  it('refuses an empty statement', () => {
    expect(checkPermission('   ', true)).toMatchObject({ code: 'EMPTY_SQL' })
  })
})

describe('paging sql', () => {
  it('wraps the statement and asks for one probe row beyond the page', () => {
    expect(buildPagedQuery('SELECT a FROM t', { limit: 501, offset: 0 })).toBe(
      'SELECT * FROM (\nSELECT a FROM t\n) AS t LIMIT 501 OFFSET 0',
    )
  })

  it('counts over the same statement', () => {
    expect(buildCountQuery('SELECT a FROM t')).toBe('SELECT COUNT(*) AS c FROM (\nSELECT a FROM t\n) AS t')
  })

  it('applies a server-side sort on the wrapper', () => {
    expect(buildPagedQuery('SELECT a FROM t', { limit: 10, offset: 20, sort: { column: 'created_at', direction: 'DESC' } })).toContain(
      'ORDER BY `created_at` DESC LIMIT 10 OFFSET 20',
    )
  })

  it('rejects a sort column that is not a plain identifier', () => {
    expect(() => buildPagedQuery('SELECT 1', { limit: 1, offset: 0, sort: { column: 'a; drop table t', direction: 'ASC' } })).toThrow(
      /非法排序列名/,
    )
  })

  it('accepts the column labels Doris actually returns', () => {
    // Chinese labels and qualified names are routine in this warehouse; only
    // characters that could escape a quoted identifier are refused (docs/03 §6.3).
    expect(buildPagedQuery('SELECT 1', { limit: 1, offset: 0, sort: { column: '订单日期', direction: 'DESC' } })).toContain(
      'ORDER BY `订单日期` DESC',
    )
    expect(buildPagedQuery('SELECT 1', { limit: 1, offset: 0, sort: { column: 't.created_at', direction: 'ASC' } })).toContain(
      'ORDER BY `t.created_at` ASC',
    )
    for (const column of ['', '  ', 'a b', 'a`b', "a'b", 'a"b', 'a--b', 'a/*b']) {
      expect(() => buildPagedQuery('SELECT 1', { limit: 1, offset: 0, sort: { column, direction: 'ASC' } })).toThrow(/非法排序列名/)
    }
  })

  it('runs only the first statement of a batch', () => {
    expect(firstStatement('SELECT 1; DROP TABLE t')).toBe('SELECT 1')
    expect(firstStatement('  ')).toBe('')
  })

  it('clamps page sizes into the supported band', () => {
    expect(normalizePageSize()).toBe(DEFAULT_PAGE_SIZE)
    expect(normalizePageSize(0)).toBe(1)
    expect(normalizePageSize(9999)).toBe(MAX_PAGE_SIZE)
    expect(normalizePageSize(1000)).toBe(1000)
  })
})

describe('value protection', () => {
  it('leaves ordinary cells alone', () => {
    expect(truncateRow(['a', 1, null, true], 0)).toEqual({ row: ['a', 1, null, true], truncated: 0 })
  })

  it('clips an oversized cell and counts it', () => {
    const huge = 'x'.repeat(MAX_CELL_BYTES + 1)

    const clipped = truncateRow([huge], 0)

    expect(clipped.truncated).toBe(1)
    expect(String(clipped.row[0])).toContain('值过大')
  })

  it('accumulates the count across rows', () => {
    const huge = 'x'.repeat(MAX_CELL_BYTES + 1)

    expect(truncateRow([huge], 3).truncated).toBe(4)
  })

  it('measures binary cells in bytes, not characters', () => {
    const huge = Buffer.alloc(MAX_CELL_BYTES + 1, 0x61)

    const clipped = truncateRow([huge], 0)

    expect(clipped.truncated).toBe(1)
  })

  it('leaves a binary cell under the ceiling untouched', () => {
    const small = Buffer.from('abc', 'utf8')

    expect(truncateRow([small], 0)).toEqual({ row: [small], truncated: 0 })
  })
})

describe('execute', () => {
  it('returns the page, the probe verdict and the count', async () => {
    const executor = fakeExecutor({ rows: [[1, 'a']] }, [[42]])
    let clock = 0
    const result = await executeSql(deps(executor, false, () => (clock += 7)), { connId, sql: 'SELECT a, b FROM t' })

    expect(result).toMatchObject({
      columns: [{ name: 'a', typeName: 'LONG' }, { name: 'b', typeName: 'LONG' }],
      rows: [[1, 'a']],
      total: 42,
      hasNextPage: false,
      offset: 0,
      durationMs: 7,
    })
    expect('statementId' in result && result.statementId).toBe('stmt-1')
  })

  it('reports the next page when the probe row arrives', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => [index])
    const result = await executeSql(deps(fakeExecutor({ rows }, [[900]])), { connId, sql: 'SELECT a FROM t' })

    expect(result).toMatchObject({ total: 900, hasNextPage: true })
    expect('rows' in result && result.rows).toHaveLength(500)
  })

  it('carries filters into fetchPage as well', async () => {
    const executor = fakeExecutor({ rows: [[1]] }, [[1]])

    await fetchPage(deps(executor), {
      connId,
      sql: 'SELECT a FROM t',
      offset: 100,
      filters: [{ column: 'a', op: 'eq', value: 'x' }],
    })

    expect(executor.calls[0]).toContain(" WHERE `a` = 'x'")
  })

  it('applies column filters to both the page and the count', async () => {
    const executor = fakeExecutor({ rows: [[1]] }, [[1]])

    await executeSql(deps(executor), {
      connId,
      sql: 'SELECT a FROM t',
      filters: [{ column: 'a', op: 'gt', value: '10', numeric: true }],
    })

    expect(executor.calls).toHaveLength(2)
    for (const sql of executor.calls) expect(sql).toContain(' WHERE `a` > 10')
  })

  it('runs the page and the count in parallel against the same statement', async () => {
    const executor = fakeExecutor({ rows: [[1]] }, [[1]])

    await executeSql(deps(executor), { connId, sql: 'SELECT a FROM t', pageSize: 10, offset: 30 })

    expect(executor.calls).toHaveLength(2)
    expect(executor.calls.some(sql => sql.includes('LIMIT 11 OFFSET 30'))).toBe(true)
    expect(executor.calls.some(sql => sql.includes('COUNT(*)'))).toBe(true)
  })

  it('degrades to an unknown total when the count fails', async () => {
    const executor = fakeExecutor({ rows: [[1]] })
    executor.query.mockImplementation(async (_spec: ConnectionSpec, sql: string) => {
      if (sql.includes('COUNT(*)')) throw new Error('count timeout')
      return { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] }
    })

    const result = await executeSql(deps(executor), { connId, sql: 'SELECT a FROM t' })

    expect(result).toMatchObject({ total: null })
  })

  it('refuses a write before touching the driver', async () => {
    const executor = fakeExecutor({ rows: [] })

    const result = await executeSql(deps(executor), { connId, sql: 'DELETE FROM t' })

    expect(result).toMatchObject({ refusal: { code: 'WRITE_NOT_ALLOWED' } })
    expect(executor.query).not.toHaveBeenCalled()
  })

  it('refuses an unknown connection', async () => {
    const result = await executeSql(deps(fakeExecutor({ rows: [] })), { connId: 'nope', sql: 'SELECT 1' })

    expect(result).toMatchObject({ refusal: { code: 'CONN_NOT_FOUND' } })
  })

  it('marks truncated cells in the response', async () => {
    const huge = 'x'.repeat(MAX_CELL_BYTES + 1)
    const result = await executeSql(deps(fakeExecutor({ rows: [[huge, 1]] })), { connId, sql: 'SELECT a FROM t' })

    expect(result).toMatchObject({ truncated: { cells: 1 } })
  })

  it('applies an explicit sort to the first page', async () => {
    const executor = fakeExecutor({ rows: [[1]] })

    await executeSql(deps(executor), { connId, sql: 'SELECT a FROM t', sort: { column: 'a', direction: 'DESC' } })

    // The count is issued first now; the sorted page query is what matters here.
    expect(executor.calls.some(sql => sql.includes('ORDER BY `a` DESC'))).toBe(true)
  })

  it('reports a zero total when the count comes back empty', async () => {
    const result = await executeSql(deps(fakeExecutor({ rows: [] }, [])), { connId, sql: 'SELECT a FROM t' })

    expect(result).toMatchObject({ total: 0 })
  })

  it('runs under a caller-chosen statement id so the panel can cancel it', async () => {
    const executor = fakeExecutor({ rows: [[1]] })

    const result = await executeSql(deps(executor), { connId, sql: 'SELECT a FROM t', statementId: 'ui-7' })

    expect(result).toMatchObject({ statementId: 'ui-7' })
    expect(executor.calls).toHaveLength(2)
  })
})

describe('fetch page', () => {
  it('skips the count and reports an unknown total', async () => {
    const executor = fakeExecutor({ rows: [[1]] })

    const result = await fetchPage(deps(executor), { connId, sql: 'SELECT a FROM t', offset: 1000, pageSize: 100 })

    expect(result).toMatchObject({ total: null, offset: 1000 })
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]).toContain('LIMIT 101 OFFSET 1000')
  })

  it('clamps a negative offset', async () => {
    const executor = fakeExecutor({ rows: [] })

    await fetchPage(deps(executor), { connId, sql: 'SELECT 1', offset: -5 })

    expect(executor.calls[0]).toContain('OFFSET 0')
  })

  it('applies the sort, keeps the probe row out and counts clipped cells', async () => {
    const huge = 'x'.repeat(MAX_CELL_BYTES + 1)
    const executor = fakeExecutor({ rows: [[huge, 0], [huge, 1], [huge, 2]] })

    const result = await fetchPage(deps(executor), {
      connId,
      sql: 'SELECT a FROM t',
      offset: 0,
      pageSize: 2,
      sort: { column: 'created_at', direction: 'ASC' },
    })

    expect(executor.calls[0]).toContain('ORDER BY `created_at` ASC LIMIT 3 OFFSET 0')
    expect(result).toMatchObject({ hasNextPage: true, offset: 0, total: null, truncated: { cells: 2 } })
    expect('rows' in result && result.rows).toHaveLength(2)
  })

  it('defaults a missing offset to the first page', async () => {
    const executor = fakeExecutor({ rows: [] })

    const result = await fetchPage(deps(executor), { connId, sql: 'SELECT 1' })

    expect(result).toMatchObject({ offset: 0 })
    expect(executor.calls[0]).toContain('OFFSET 0')
  })

  it('refuses an unknown connection before touching the driver', async () => {
    const executor = fakeExecutor({ rows: [] })

    const result = await fetchPage(deps(executor), { connId: 'nope', sql: 'SELECT 1', offset: 0 })

    expect(result).toMatchObject({ refusal: { code: 'CONN_NOT_FOUND' } })
    expect(executor.query).not.toHaveBeenCalled()
  })
})

describe('tool envelopes', () => {
  it('wraps a success and a refusal the same way', async () => {
    const ok = await runExecuteSql(deps(fakeExecutor({ rows: [[1]] })), { connId, sql: 'SELECT 1' })
    const refused = await runFetchPage(deps(fakeExecutor({ rows: [] })), { connId, sql: 'DROP TABLE t' })

    expect(ok).toMatchObject({ ok: true, rows: [[1]] })
    expect(refused).toMatchObject({ ok: false, error: { code: 'DDL_FORBIDDEN' } })
  })

  it('cancels through the transport and forgets the statement', async () => {
    const executor = fakeExecutor({ rows: [] })

    expect(await cancelStatement(deps(executor), 'stmt-1')).toEqual({ cancelled: true })
    expect(executor.cancel).toHaveBeenCalledWith('stmt-1')
  })
})

describe('statement registry', () => {
  it('hands out unique ids and forgets on request', () => {
    const registry = createStatementRegistry()

    expect(registry.next()).toBe('stmt-1')
    expect(registry.next()).toBe('stmt-2')
    expect(registry.forget('stmt-1')).toBeUndefined()
  })
})

describe('count timeout', () => {
  it('returns the page even when COUNT is slow', async () => {
    const executor = {
      cancel: vi.fn(async () => undefined),
      query: vi.fn(async (_spec: ConnectionSpec, sql: string) => {
        if (sql.includes('COUNT(*)')) return new Promise<never>(() => undefined)
        return { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] }
      }),
    }
    const started = Date.now()
    const result = await executeSql(
      { ...deps(executor as never), countTimeoutMs: 30 },
      { connId, sql: 'SELECT a FROM big' },
    )

    expect(Date.now() - started).toBeLessThan(1000)
    expect('columns' in result && result.rows).toEqual([[1]])
    expect('columns' in result && result.total).toBeNull()
  })

  it('keeps the total when COUNT answers in time', async () => {
    const executor = fakeExecutor({ rows: [[1]] }, [[123456]])
    const result = await executeSql(deps(executor), { connId, sql: 'SELECT a FROM t' })

    expect('total' in result && result.total).toBe(123456)
  })
})

describe('raw statements', () => {
  it('runs SHOW CREATE as written, without a wrapper or a count', async () => {
    const run = fakeExecutor({ fields: ['Table', 'Create Table'], rows: [['t', 'CREATE TABLE `t` (id INT)']] })
    const outcome = await executeSql(deps(run), {
      connId,
      sql: 'SHOW CREATE TABLE `dwd`.`t`',
      pageSize: 1,
      raw: true,
    })

    expect(run.calls).toEqual(['SHOW CREATE TABLE `dwd`.`t`'])
    expect('refusal' in outcome).toBe(false)
    if (!('refusal' in outcome)) {
      expect(outcome.rows[0]?.[1]).toContain('CREATE TABLE')
      expect(outcome.total).toBeNull()
    }
  })

  it('still refuses a write on a read-only connection when raw', async () => {
    const run = fakeExecutor({ rows: [[]] })
    const outcome = await executeSql(deps(run), {
      connId,
      sql: 'DELETE FROM t',
      raw: true,
    })

    expect('refusal' in outcome && outcome.refusal.code).toBe('WRITE_NOT_ALLOWED')
    expect(run.calls).toEqual([])
  })
})

describe('column filters (server-side)', () => {
  it('builds a WHERE into the paging wrapper, before ORDER BY and LIMIT', () => {
    const sql = buildPagedQuery('SELECT * FROM t', {
      limit: 10,
      offset: 20,
      sort: { column: 'created_at', direction: 'DESC' },
      filters: [{ column: 'customer', op: 'contains', value: 'ali' }],
    })

    expect(sql).toContain('`customer` LIKE \'%ali%\'')
    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('ORDER BY'))
    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('LIMIT'))
    expect(sql).toContain('LIMIT 10 OFFSET 20')
  })

  it('ANDs several conditions and counts with the same WHERE', () => {
    const filters = [
      { column: 'customer', op: 'eq' as const, value: 'Alice' },
      { column: 'amount', op: 'gt' as const, value: '100', numeric: true },
    ]

    expect(filterClause(filters)).toBe(" WHERE `customer` = 'Alice' AND `amount` > 100")
    expect(buildCountQuery('SELECT * FROM t', filters)).toContain("WHERE `customer` = 'Alice' AND `amount` > 100")
  })

  it('covers every operator', () => {
    expect(filterClause([{ column: 'c', op: 'notContains', value: 'x' }])).toBe(" WHERE `c` NOT LIKE '%x%'")
    expect(filterClause([{ column: 'c', op: 'ne', value: 'x' }])).toBe(" WHERE `c` <> 'x'")
    expect(filterClause([{ column: 'c', op: 'ge', value: 'x' }])).toBe(" WHERE `c` >= 'x'")
    expect(filterClause([{ column: 'c', op: 'lt', value: 'x' }])).toBe(" WHERE `c` < 'x'")
    expect(filterClause([{ column: 'c', op: 'le', value: 'x' }])).toBe(" WHERE `c` <= 'x'")
    expect(filterClause([{ column: 'c', op: 'isNull' }])).toBe(' WHERE `c` IS NULL')
    expect(filterClause([{ column: 'c', op: 'notNull' }])).toBe(' WHERE `c` IS NOT NULL')
  })

  it('never emits a dangling WHERE for an operator this host does not know', () => {
    // Reproduces a stale node half receiving the newer client's `in` filter:
    // before the guard the wrapper became `) AS t WHERE  LIMIT 5001 OFFSET 0`.
    const unknown = [{ column: 'c', op: 'futureOp' as unknown as 'eq', values: ['a'] }]
    expect(filterClause(unknown)).toBe('')
    expect(buildPagedQuery('SELECT * FROM t', { limit: 5000, offset: 0, filters: unknown }))
      .toBe('SELECT * FROM (\nSELECT * FROM t\n) AS t LIMIT 5000 OFFSET 0')
    // A known condition next to the unknown one survives; the unknown one drops.
    expect(filterClause([{ column: 'c', op: 'eq', value: 'x' }, ...unknown])).toBe(" WHERE `c` = 'x'")
  })

  it('keeps an empty value-list selection as a valid never-matching predicate', () => {
    expect(filterClause([{ column: 'c', op: 'in', values: [] }])).toBe(' WHERE 1=0')
  })

  it('escapes quotes and backslashes instead of breaking out of the literal', () => {
    expect(filterClause([{ column: 'c', op: 'eq', value: "O'Brien" }])).toBe(" WHERE `c` = 'O''Brien'")
    expect(filterClause([{ column: 'c', op: 'eq', value: 'a\\b' }])).toBe(" WHERE `c` = 'a\\\\b'")
    // A long paste is truncated rather than sent as a megabyte of WHERE.
    const long = filterClause([{ column: 'c', op: 'eq', value: 'x'.repeat(500) }])
    expect(long.length).toBeLessThan(230)
  })

  it('leaves a numeric column unquoted only when the value really is numeric', () => {
    expect(filterClause([{ column: 'n', op: 'gt', value: '42', numeric: true }])).toBe(' WHERE `n` > 42')
    expect(filterClause([{ column: 'n', op: 'gt', value: 'abc', numeric: true }])).toBe(" WHERE `n` > 'abc'")
  })

  it('rejects a column name that could break out of the identifier', () => {
    expect(() => filterClause([{ column: 'c; DROP TABLE t', op: 'eq', value: 'x' }])).toThrow('非法排序列名')
  })

  it('treats a missing value as an empty string', () => {
    // `eq` with no value cannot happen through the UI, but the builder must not
    // emit `= undefined` if a caller omits it.
    expect(filterClause([{ column: 'c', op: 'eq' }])).toBe(" WHERE `c` = ''")
  })

  it('adds nothing when there is no filter', () => {
    expect(filterClause(undefined)).toBe('')
    expect(filterClause([])).toBe('')
    expect(buildPagedQuery('SELECT 1', { limit: 5, offset: 0 })).not.toContain('WHERE')
  })
})

describe('value-list IN filters', () => {
  it('quotes and escapes every string literal in the list', () => {
    expect(filterClause([{ column: 'c', op: 'in', values: ['Alice', "O'Brien"] }]))
      .toBe(" WHERE `c` IN ('Alice', 'O''Brien')")
    expect(filterClause([{ column: 'c', op: 'in', values: ['a\\b'] }])).toBe(" WHERE `c` IN ('a\\\\b')")
  })

  it('emits numeric columns raw and only for real numbers', () => {
    expect(filterClause([{ column: 'n', op: 'in', values: ['1', '2.5', '-3'], numeric: true }]))
      .toBe(' WHERE `n` IN (1, 2.5, -3)')
    // A value list is built from display text; a non-numeric item must not be
    // pasted into the SQL unquoted even when the column is numeric.
    expect(filterClause([{ column: 'n', op: 'in', values: ['abc'], numeric: true }]))
      .toBe(" WHERE `n` IN ('abc')")
    expect(filterClause([{ column: 'n', op: 'in', values: [' 42 '], numeric: true }]))
      .toBe(' WHERE `n` IN (42)')
  })

  it('matches nothing for an empty selection, including a missing values array', () => {
    expect(filterClause([{ column: 'c', op: 'in', values: [] }])).toBe(' WHERE 1=0')
    expect(filterClause([{ column: 'c', op: 'in' }])).toBe(' WHERE 1=0')
  })

  it('ANDs an IN list with the other conditions in page and count queries', () => {
    const filters = [
      { column: 'customer', op: 'eq' as const, value: 'Alice' },
      { column: 'order_id', op: 'in' as const, values: ['1', '2'], numeric: true },
    ]
    expect(filterClause(filters)).toBe(" WHERE `customer` = 'Alice' AND `order_id` IN (1, 2)")
    expect(buildCountQuery('SELECT * FROM t', filters)).toContain("WHERE `customer` = 'Alice' AND `order_id` IN (1, 2)")
    expect(buildPagedQuery('SELECT * FROM t', { limit: 10, offset: 0, filters }))
      .toContain("WHERE `customer` = 'Alice' AND `order_id` IN (1, 2)")
  })

  it('runs the IN column name through the same identifier gate', () => {
    expect(() => filterClause([{ column: 'c; DROP TABLE t', op: 'in', values: ['x'] }])).toThrow('非法排序列名')
  })

  it('truncates an over-long list item instead of sending a megabyte of WHERE', () => {
    const clause = filterClause([{ column: 'c', op: 'in', values: ['x'.repeat(500)] }])
    expect(clause.length).toBeLessThan(230)
  })
})
