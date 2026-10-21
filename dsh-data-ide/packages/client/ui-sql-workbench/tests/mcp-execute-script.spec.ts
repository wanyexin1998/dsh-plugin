import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'

import { createServer } from '../mcp/server.ts'
import type { QueryExecutor, QueryResult } from '../src/execute/core.ts'
import type { ConnectionSpec } from '../src/host/runtime-specs.ts'

const connId = 'ds-script-test'
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

/** Executor double: a count probe answers with one row, everything else with `a=1`. */
function fakeExecutor(): QueryExecutor {
  return {
    query: async (_spec, sql): Promise<QueryResult> => {
      if (sql.includes('COUNT(*)')) return { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[1]] }
      return { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] }
    },
    cancel: async () => undefined,
  }
}

async function connect(outboxDir: string | undefined, executor: QueryExecutor = fakeExecutor()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer({ specs: async () => specs, execution: executor, outboxDir })
  const client = new Client({ name: 'script-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

/** Executor that returns a wide page, to exercise the agent-side row budget. */
function bigExecutor(): QueryExecutor {
  return {
    query: async (_spec, sql): Promise<QueryResult> => {
      if (sql.includes('COUNT(*)')) return { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[400]] }
      return {
        fields: [{ name: 'a', typeName: 'LONG' }],
        rows: Array.from({ length: 400 }, (_, index) => [index]),
      }
    },
    cancel: async () => undefined,
  }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>
}

/** Envelopes currently sitting in the spool. */
async function deliveries(dir: string): Promise<Record<string, unknown>[]> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.json'))
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>))
}

describe('execute_script over MCP', () => {
  let dir = ''

  afterEach(async () => {
    if (dir !== '') {
      await rm(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  it('runs every statement and delivers one script envelope', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir)

    const payload = await callJson(client, 'execute_script', {
      connId,
      sql: 'SELECT 1; SELECT 2; SELECT 3',
      label: '三连',
      pageSize: 25,
    })

    expect(payload['ok']).toBe(true)
    expect(payload['statements']).toHaveLength(3)
    const written = await deliveries(dir)
    expect(written).toHaveLength(1)
    expect(written[0]?.['kind']).toBe('script')
    expect(written[0]?.['script']).toHaveLength(3)

    await client.close()
    await server.close()
  })

  it('stops at the first refused statement', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir)

    const payload = await callJson(client, 'execute_script', {
      connId,
      sql: 'SELECT 1; DELETE FROM t; SELECT 3',
      label: '遇错即停',
    })
    const statements = payload['statements'] as { readonly ok: boolean }[]

    // The refusal is the last entry: nothing after a failed statement runs.
    expect(statements).toHaveLength(2)
    expect(statements[1]?.ok).toBe(false)

    await client.close()
    await server.close()
  })

  it('rejects a script above maxStatements instead of truncating it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir)

    const payload = await callJson(client, 'execute_script', {
      connId,
      sql: 'SELECT 1; SELECT 2; SELECT 3',
      maxStatements: 2,
    })

    expect(payload['ok']).toBe(false)
    expect((payload['error'] as { readonly code?: string }).code).toBe('TOO_MANY_STATEMENTS')
    await expect(deliveries(dir)).resolves.toHaveLength(0)

    await client.close()
    await server.close()
  })

  it('clamps maxStatements instead of letting the caller raise the cap', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir)
    const sql = Array.from({ length: 21 }, (_, index) => `SELECT ${index + 1}`).join('; ')

    const payload = await callJson(client, 'execute_script', { connId, sql, maxStatements: 10_000 })

    // 21 > MAX_SCRIPT_STATEMENTS, so the clamped cap still refuses it (§15 A5).
    expect(payload['ok']).toBe(false)
    expect((payload['error'] as { readonly code?: string }).code).toBe('TOO_MANY_STATEMENTS')

    await client.close()
    await server.close()
  })

  it('caps the rows handed to the agent while delivering the full pages', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir, bigExecutor())

    const payload = await callJson(client, 'execute_script', {
      connId,
      sql: 'SELECT 1; SELECT 2',
      label: '宽结果',
    })
    const statements = payload['statements'] as {
      readonly ok: boolean
      readonly response?: { readonly rows: unknown[] }
      readonly rowsTruncated?: number
    }[]

    // Budget is 500 rows: the first keeps 400, the second only 100 (§15 A9).
    expect(statements[0]?.response?.rows).toHaveLength(400)
    expect(statements[1]?.response?.rows).toHaveLength(100)
    expect(statements[1]?.rowsTruncated).toBe(300)

    const written = await deliveries(dir)
    const delivered = written[0]?.['script'] as { readonly response?: { readonly rows: unknown[] } }[]
    // The panel still gets the whole first page.
    expect(delivered[1]?.response?.rows).toHaveLength(400)

    await client.close()
    await server.close()
  })

  it('does not deliver anything without a label', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const { client, server } = await connect(dir)

    const payload = await callJson(client, 'execute_script', { connId, sql: 'SELECT 1' })

    expect(payload['ok']).toBe(true)
    await expect(deliveries(dir)).resolves.toHaveLength(0)

    await client.close()
    await server.close()
  })

  it('keeps labelled execution successful when no outbox is configured', async () => {
    const { client, server } = await connect(undefined)

    const payload = await callJson(client, 'execute_sql', { connId, sql: 'SELECT 1', label: '月报' })
    expect(payload['ok']).toBe(true)

    await client.close()
    await server.close()
  })

  it('rejects invalid labels before executing SQL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'script-outbox-'))
    const seen: string[] = []
    const executor: QueryExecutor = {
      query: async (_spec, sql) => {
        seen.push(sql)
        return { fields: [], rows: [] }
      },
      cancel: async () => undefined,
    }
    const { client, server } = await connect(dir, executor)

    const script = await callJson(client, 'execute_script', { connId, sql: 'SELECT 1', label: 'bad label', pageSize: 25 })
    const single = await callJson(client, 'execute_sql', { connId, sql: 'SELECT 1', label: 'bad/label' })
    expect(script).toMatchObject({ ok: false, error: { code: 'BAD_LABEL' } })
    expect(single).toMatchObject({ ok: false, error: { code: 'BAD_LABEL' } })
    expect(seen).toHaveLength(0)

    await client.close()
    await server.close()
  })
})
