import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

/** Scripted mysql2 driver shared by the executor tests. */
const driver = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), destroy: vi.fn(), createConnection: vi.fn() }))
vi.mock('mysql2/promise', () => ({ createConnection: driver.createConnection }))

import { main, SPEC_PATH_FLAG } from '../mcp/server.ts'
import { createStatementRegistry } from '../src/execute/core.ts'
import type { QueryExecutor, QueryResult } from '../src/execute/core.ts'
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

const specs = { schemaVersion: 1 as const, generatedAt: 'x', connections: { [connId]: spec } }

/** Executor double recording every statement it is asked to run. */
function fakeExecutor(result: QueryResult = { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] }) {
  const seen: string[] = []
  const executor: QueryExecutor & { seen: string[] } = {
    seen,
    query: vi.fn(async (_spec, sql) => {
      seen.push(sql)
      return sql.includes('COUNT(*)') ? { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[3]] } : result
    }),
    cancel: vi.fn(async () => undefined),
  }
  return executor
}

/** Connect a client to a server booted exactly like the profile boots it. */
async function connect(executor: QueryExecutor, writeEnabled = false) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'execution-test', version: '0.0.0' })
  const resolved = { ...spec, writeEnabled }
  await main(serverTransport, [SPEC_PATH_FLAG, 'ignored']).catch(() => undefined)
  // Boot with the fake transport and injected pieces instead of a real file.
  const server = (await import('../mcp/server.ts')).createServer({
    specs: async () => ({ ...specs, connections: { [connId]: resolved } }),
    execution: executor,
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>
}

describe('execution tools over MCP', () => {
  it('execute_sql returns the first page with the count', async () => {
    const executor = fakeExecutor()
    const { client, server } = await connect(executor)

    const payload = await callJson(client, 'execute_sql', { connId, sql: 'SELECT a FROM t' })

    expect(payload).toMatchObject({
      ok: true,
      columns: [{ name: 'a', typeName: 'LONG' }],
      rows: [[1]],
      total: 3,
      hasNextPage: false,
    })
    expect(payload.statementId).toBeTypeOf('string')
    await client.close()
    await server.close()
  })

  it('execute_sql honours an explicit page size', async () => {
    const executor = fakeExecutor()
    const { client, server } = await connect(executor)

    await callJson(client, 'execute_sql', { connId, sql: 'SELECT a FROM t', pageSize: 25 })

    expect(executor.seen.some(sql => sql.includes('LIMIT 26'))).toBe(true)
    await client.close()
    await server.close()
  })

  it('fetch_page offsets without counting again', async () => {
    const executor = fakeExecutor()
    const { client, server } = await connect(executor)

    const payload = await callJson(client, 'fetch_page', { connId, sql: 'SELECT a FROM t', offset: 500, pageSize: 100 })
    const defaulted = await callJson(client, 'fetch_page', { connId, sql: 'SELECT a FROM t', offset: 0 })

    expect(payload).toMatchObject({ ok: true, offset: 500, total: null })
    expect(defaulted).toMatchObject({ ok: true, offset: 0 })
    expect(executor.seen).toHaveLength(2)
    expect(executor.seen[1]).toContain('LIMIT 501 OFFSET 0')
    await client.close()
    await server.close()
  })

  it('refuses a write on a read-only connection and allows it once enabled', async () => {
    const readOnly = fakeExecutor()
    const first = await connect(readOnly)
    expect(await callJson(first.client, 'execute_sql', { connId, sql: 'DELETE FROM t' })).toMatchObject({
      ok: false,
      error: { code: 'WRITE_NOT_ALLOWED' },
    })
    await first.client.close()
    await first.server.close()

    const writable = fakeExecutor()
    const second = await connect(writable, true)
    expect(await callJson(second.client, 'execute_sql', { connId, sql: 'DELETE FROM t' })).toMatchObject({ ok: true })
    await second.client.close()
    await second.server.close()
  })

  it('cancel_statement reaches the transport', async () => {
    const executor = fakeExecutor()
    const { client, server } = await connect(executor)

    expect(await callJson(client, 'cancel_statement', { statementId: 'stmt-9' })).toEqual({ cancelled: true })
    expect(executor.cancel).toHaveBeenCalledWith('stmt-9')
    await client.close()
    await server.close()
  })
})

describe('mysql executor', () => {
  it('opens a socket, maps fields and closes it', async () => {
    driver.query.mockReset().mockResolvedValue([[{ a: 1 }], [{ name: 'a' }, { name: 'b' }]])
    driver.end.mockReset().mockResolvedValue(undefined)
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockReset().mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })
    vi.resetModules()

    // `type: 3` is LONG (INT) and `type: 0xfd` is VAR_STRING in the MySQL wire
    // protocol; the grid formats by these names (docs/03 §6.5).
    driver.query.mockResolvedValue([[{ a: 1, b: 'x' }], [{ name: 'a', type: 3 }, { name: 'b', type: 0xfd }]])
    driver.end.mockResolvedValue(undefined)
    driver.createConnection.mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })

    const { createMysqlExecutor } = await import('../src/execute/mysql.ts')
    const executor = createMysqlExecutor()

    const result = await executor.query(spec, 'SELECT 1', 'stmt-1')

    expect(result.fields).toEqual([{ name: 'a', typeName: 'LONG' }, { name: 'b', typeName: 'VAR_STRING' }])
    expect(result.rows).toEqual([[1, 'x']])
    expect(driver.createConnection).toHaveBeenCalledWith(expect.objectContaining({ host: 'doris.shcell.com', port: 9030 }))
    expect(driver.end).toHaveBeenCalled()
  })

  it('cancels a live statement and ignores an unknown one', async () => {
    driver.end.mockReset().mockResolvedValue(undefined)
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockReset()

    driver.destroy.mockResolvedValue(undefined)
    driver.end.mockResolvedValue(undefined)
    let release: (() => void) | undefined
    driver.query.mockImplementation(() => new Promise(resolve => {
      release = () => resolve([[{ a: 1 }], [{ name: 'a', type: 3 }]])
    }))
    driver.createConnection.mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })

    const { createMysqlExecutor } = await import('../src/execute/mysql.ts')
    const executor = createMysqlExecutor()
    const running = executor.query(spec, 'SELECT SLEEP(10)', 'stmt-7')

    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function')
    })
    await executor.cancel('stmt-7')
    release?.()
    await expect(running).resolves.toMatchObject({ rows: [[1]] })

    await expect(executor.cancel('stmt-unknown')).resolves.toBeUndefined()
  })

  it('survives a driver that refuses to close', async () => {
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockReset()

    driver.query.mockResolvedValue([[], []])
    driver.end.mockRejectedValue(new Error('already closed'))
    driver.createConnection.mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })

    const { createMysqlExecutor } = await import('../src/execute/mysql.ts')

    await expect(createMysqlExecutor().query(spec, 'SELECT 1', 'stmt-2')).resolves.toEqual({ fields: [], rows: [] })
  })

  it('tolerates missing field metadata and null cells', async () => {
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.end.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockReset().mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })

    const { createMysqlExecutor } = await import('../src/execute/mysql.ts')
    const executor = createMysqlExecutor()

    // A non-SELECT acknowledgement carries no field list at all.
    driver.query.mockResolvedValue([[], undefined])
    await expect(executor.query(spec, 'UPDATE t SET a = 1', 'stmt-3')).resolves.toEqual({ fields: [], rows: [] })

    // A field without a name or a wire type must still land in column order.
    driver.query.mockResolvedValue([[{ '': null }], [{}]])
    await expect(executor.query(spec, 'SELECT 1', 'stmt-4')).resolves.toEqual({
      fields: [{ name: '', typeName: 'UNKNOWN' }],
      rows: [[null]],
    })

    // A type code outside the table degrades to UNKNOWN rather than undefined.
    driver.query.mockResolvedValue([[{ a: 1 }], [{ name: 'a', type: 0x99 }]])
    await expect(executor.query(spec, 'SELECT a FROM t', 'stmt-6')).resolves.toEqual({
      fields: [{ name: 'a', typeName: 'UNKNOWN' }],
      rows: [[1]],
    })

    // A missing value for a known column reads as NULL, not as undefined.
    driver.query.mockResolvedValue([[{}], [{ name: 'a', type: 3 }]])
    await expect(executor.query(spec, 'SELECT a FROM t', 'stmt-5')).resolves.toEqual({
      fields: [{ name: 'a', typeName: 'LONG' }],
      rows: [[null]],
    })
  })
})

describe('statement registry reuse', () => {
  it('issues a fresh id per statement', () => {
    const registry = createStatementRegistry()

    expect(registry.next()).not.toBe(registry.next())
  })
})
