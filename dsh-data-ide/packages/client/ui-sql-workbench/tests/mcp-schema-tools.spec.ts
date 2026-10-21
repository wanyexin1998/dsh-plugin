import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { createServer } from '../mcp/server.ts'
import type { QueryExecutor, QueryResult } from '../src/execute/core.ts'
import type { SchemaReader, SchemaSnapshot } from '../src/host/metadata.ts'
import type { ConnectionSpec } from '../src/host/runtime-specs.ts'

const connId = 'ds-schema'
const spec: ConnectionSpec = {
  name: 'doris',
  dbms: 'doris',
  host: 'h',
  port: 9030,
  username: 'u',
  password: 'p',
  driverProperties: {},
  writeEnabled: false,
}
const specs = { schemaVersion: 1 as const, generatedAt: 'x', connections: { [connId]: spec } }

const snapshot: SchemaSnapshot = {
  fetchedAt: '2026-10-21T00:00:00.000Z',
  truncated: false,
  source: 'information_schema',
  tables: [
    { schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] },
    { schema: 'dwd', kind: 'view', name: 'v_all', columns: [{ name: 'id', type: 'BIGINT' }] },
  ],
}

function executor(): QueryExecutor {
  return {
    query: async (_spec, sql): Promise<QueryResult> =>
      sql.includes('COUNT(*)')
        ? { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[1]] }
        : { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] },
    cancel: async () => undefined,
  }
}

async function connect(reader: SchemaReader) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer({ specs: async () => specs, execution: executor(), schemaReader: reader })
  const client = new Client({ name: 'schema-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>
}

const reader: SchemaReader = { schema: async () => snapshot }

describe('schema tools over MCP (09 B1)', () => {
  it('get_schema returns tables with their columns', async () => {
    const { client, server } = await connect(reader)

    const payload = await callJson(client, 'get_schema', { connId })
    const tables = payload['tables'] as { readonly name: string; readonly columns: unknown[] }[]

    expect(payload['ok']).toBe(true)
    expect(payload['source']).toBe('information_schema')
    expect(tables.map(table => table.name)).toEqual(['dwd_order', 'v_all'])
    expect(tables[0]?.columns).toHaveLength(1)

    await client.close()
    await server.close()
  })

  it('get_schema narrows to one table by bare or qualified name', async () => {
    const { client, server } = await connect(reader)

    const bare = await callJson(client, 'get_schema', { connId, table: 'dwd_order' })
    const qualified = await callJson(client, 'get_schema', { connId, table: 'dwd.v_all' })
    const refreshed = await callJson(client, 'get_schema', { connId, table: 'missing', refresh: true })

    expect((bare['tables'] as unknown[]).map((table: unknown) => (table as { name: string }).name)).toEqual(['dwd_order'])
    expect((qualified['tables'] as unknown[]).map((table: unknown) => (table as { name: string }).name)).toEqual(['v_all'])
    expect(refreshed['tables']).toEqual([])

    await client.close()
    await server.close()
  })

  it('list_tables reports names and column counts, not the columns', async () => {
    const { client, server } = await connect(reader)

    const payload = await callJson(client, 'list_tables', { connId })
    const tables = payload['tables'] as { readonly name: string; readonly columns: number; readonly kind?: string }[]

    expect(tables).toHaveLength(2)
    expect(tables[0]).toEqual({ schema: 'dwd', kind: 'table', name: 'dwd_order', columns: 1 })
    expect(payload['tables']).not.toBeUndefined()

    await client.close()
    await server.close()
  })

  it('turns a read failure into a structured refusal', async () => {
    const failing: SchemaReader = {
      schema: async () => {
        throw new Error('连接不存在或没有可用密码')
      },
    }
    const { client, server } = await connect(failing)

    const payload = await callJson(client, 'get_schema', { connId })

    expect(payload['ok']).toBe(false)
    expect((payload['error'] as { readonly code?: string }).code).toBe('SCHEMA_UNAVAILABLE')

    await client.close()
    await server.close()
  })

  it('turns non-Error list failures into structured refusals', async () => {
    const failing: SchemaReader = {
      schema: async () => Promise.reject('schema offline'),
    }
    const { client, server } = await connect(failing)

    const payload = await callJson(client, 'list_tables', { connId, refresh: true })
    expect(payload).toMatchObject({ ok: false, error: { code: 'SCHEMA_UNAVAILABLE', message: 'schema offline' } })

    await client.close()
    await server.close()
  })

  it('preserves optional snapshot notes and tables without schema metadata', async () => {
    const sparse: SchemaSnapshot = {
      fetchedAt: '2026-10-21T00:00:00.000Z',
      truncated: true,
      source: 'information_schema',
      note: '只返回部分表',
      tables: [{ name: 'bare_table', columns: [] }],
    }
    const { client, server } = await connect({ schema: async () => sparse })

    const listed = await callJson(client, 'list_tables', { connId })
    const dumped = await callJson(client, 'get_schema', { connId, table: 'bare_table' })
    const missing = await callJson(client, 'get_schema', { connId, table: 'other' })
    expect(listed).toMatchObject({ note: '只返回部分表', tables: [{ name: 'bare_table', columns: 0 }] })
    expect(dumped).toMatchObject({ note: '只返回部分表', tables: [{ name: 'bare_table' }] })
    expect(missing['tables']).toEqual([])

    await client.close()
    await server.close()
  })

  it('builds its default schema reader from runtime specs', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createServer({ specs: async () => specs, execution: executor() })
    const client = new Client({ name: 'schema-default-reader', version: '0.0.0' })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const payload = await callJson(client, 'get_schema', { connId })
    expect(payload['ok']).toBe(true)

    await client.close()
    await server.close()
  })
})
