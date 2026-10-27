import { describe, expect, it, vi } from 'vitest'

import {
  buildDirectQuery,
  createStatementRegistry,
  executeSql,
  headKeyword,
  canWrapStatement,
} from '../src/execute/core.ts'
import { driverErrorLine, userErrorLine } from '../src/client/db-error.ts'
import type { ConnectionSpec } from '../src/host/runtime-specs.ts'

const connId = 'ds-direct'
const spec: ConnectionSpec = {
  name: 'doris',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  username: 'u',
  password: 'p',
  driverProperties: {},
  writeEnabled: false,
}

function fakeExecutor(rows: unknown[][] = [[1, 'a']]) {
  const calls: string[] = []
  return {
    calls,
    cancel: vi.fn(async () => undefined),
    query: vi.fn(async (_spec: ConnectionSpec, sql: string) => {
      calls.push(sql)
      if (sql.includes('COUNT(*)')) return { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[10]] }
      return { fields: [{ name: 'id', typeName: 'LONG' }], rows }
    }),
  }
}

function deps(executor: ReturnType<typeof fakeExecutor>) {
  return {
    specs: async () => ({ schemaVersion: 1 as const, generatedAt: 'x', connections: { [connId]: spec } }),
    executor,
    registry: createStatementRegistry(),
    now: () => 0,
  }
}

describe('statement kind', () => {
  it('reads the first keyword past leading comments', () => {
    expect(headKeyword('SELECT 1')).toBe('select')
    expect(headKeyword('  -- note\n/* block */\n  SHOW TABLES')).toBe('show')
    expect(headKeyword('')).toBe('')
  })

  it('treats row-returning statements as wrapper-safe', () => {
    expect(canWrapStatement('SELECT 1')).toBe(true)
    expect(canWrapStatement('with t as (select 1) select * from t')).toBe(true)
    expect(canWrapStatement('VALUES ROW(1)')).toBe(true)
    expect(canWrapStatement('SHOW TABLES')).toBe(false)
    expect(canWrapStatement('UPDATE t SET a = 1')).toBe(false)
  })

  it('wraps with exactly one probe row beyond the page', () => {
    expect(buildDirectQuery('SELECT 1', 200)).toBe('SELECT * FROM (\nSELECT 1\n) AS t LIMIT 201')
  })
})

describe('direct mode', () => {
  it('runs a SELECT as authored with a probe limit and no COUNT', async () => {
    const executor = fakeExecutor()
    const response = await executeSql(deps(executor), { connId, sql: 'SELECT 1', pageSize: 200, mode: 'direct' })

    expect('ok' in response).toBe(false)
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]).toBe('SELECT * FROM (\nSELECT 1\n) AS t LIMIT 201')
    if ('refusal' in response) throw new Error('unexpected refusal')
    expect(response.mode).toBe('direct')
    expect(response.lineOffset).toBe(1)
    expect(response.total).toBeNull()
    expect(response.rows).toEqual([[1, 'a']])
  })

  it('runs metadata statements verbatim so SHOW/DESC/EXPLAIN work', async () => {
    const executor = fakeExecutor([[1]])
    const response = await executeSql(deps(executor), { connId, sql: 'SHOW TABLES', mode: 'direct' })

    expect(executor.calls).toEqual(['SHOW TABLES'])
    if ('refusal' in response) throw new Error('unexpected refusal')
    expect(response.mode).toBe('direct')
    expect(response.lineOffset).toBe(0)
  })

  it('keeps the paged contract when mode is omitted', async () => {
    const executor = fakeExecutor()
    const response = await executeSql(deps(executor), { connId, sql: 'SELECT 1' })

    expect(executor.calls).toHaveLength(2)
    expect(executor.calls[0]).toContain('COUNT(*)')
    if ('refusal' in response) throw new Error('unexpected refusal')
    expect(response.mode).toBe('paged')
    expect(response.total).toBe(10)
  })
})

describe('driver line mapping', () => {
  it('reads the line the driver reported', () => {
    expect(driverErrorLine('INTERNAL: errCode = 2, detailMessage = Syntax error in line 2')).toBe(2)
    expect(driverErrorLine('failed at line 7')).toBe(7)
    expect(driverErrorLine('no position here')).toBeNull()
    expect(driverErrorLine('line 0')).toBeNull()
  })

  it('subtracts the wrapper offset and clamps to line one', () => {
    expect(userErrorLine('Syntax error in line 2', 1)).toBe(1)
    expect(userErrorLine('Syntax error in line 3', 1)).toBe(2)
    expect(userErrorLine('Syntax error in line 3', 0)).toBe(3)
    expect(userErrorLine('nothing', 1)).toBeNull()
  })
})
