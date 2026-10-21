import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createServer } from '../mcp/server.ts'
import { buildRegistry, writeConsoleRegistry } from '../src/host/console-registry.ts'
import { ownerOf, parseConsoleRegistry } from '../src/execute/console-registry.ts'
import type { QueryExecutor, QueryResult } from '../src/execute/core.ts'
import type { ConnectionSpec } from '../src/host/runtime-specs.ts'

const connId = 'ds-registry'
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

/** Executor that records what it was asked to run. */
function recordingExecutor(): { port: QueryExecutor; seen: string[] } {
  const seen: string[] = []
  const port: QueryExecutor = {
    query: async (_spec, sql): Promise<QueryResult> => {
      seen.push(sql)
      if (sql.includes('COUNT(*)')) return { fields: [{ name: 'c', typeName: 'LONGLONG' }], rows: [[1]] }
      return { fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] }
    },
    cancel: async () => undefined,
  }
  return { port, seen }
}

async function connect(consolesPath: string, outboxDir: string, execution: QueryExecutor) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer({ specs: async () => specs, execution, outboxDir, consolesPath })
  const client = new Client({ name: 'registry-test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>
}

describe('console registry', () => {
  let dir = ''

  afterEach(async () => {
    if (dir !== '') {
      await rm(dir, { recursive: true, force: true })
      dir = ''
    }
  })

  it('round-trips the document the host writes', () => {
    const registry = buildRegistry([
      { id: 'console_1', owner: 'user', title: 'console_1' },
      { id: 'agent-9', owner: 'agent', title: 'ai_月报', label: '月报' },
    ])

    const parsed = parseConsoleRegistry(JSON.parse(JSON.stringify(registry)))
    expect(parsed?.consoles).toHaveLength(2)
    expect(ownerOf(parsed, 'console_1')).toBe('user')
    expect(ownerOf(parsed, 'agent-9')).toBe('agent')
    // Unknown ids mean "new console", never "refuse".
    expect(ownerOf(parsed, 'nope')).toBeNull()
    expect(ownerOf(null, 'console_1')).toBeNull()
  })

  it('rejects malformed registry documents and filters malformed entries', () => {
    expect(parseConsoleRegistry(null)).toBeNull()
    expect(parseConsoleRegistry({ schemaVersion: 2, updatedAt: 'x' })).toBeNull()
    expect(parseConsoleRegistry({ schemaVersion: 1, updatedAt: 1 })).toBeNull()
    expect(parseConsoleRegistry({ schemaVersion: 1, updatedAt: 'x', consoles: 'nope' })?.consoles).toEqual([])

    const parsed = parseConsoleRegistry({
      schemaVersion: 1,
      updatedAt: 'x',
      consoles: [
        null,
        { id: '', owner: 'user', title: 'empty' },
        { id: 'x', owner: 'other', title: 'bad owner' },
        { id: 'x', owner: 'user', title: 1 },
        { id: 'ok', owner: 'agent', title: 'ai', label: 1 },
      ],
    })
    expect(parsed?.consoles).toEqual([{ id: 'ok', owner: 'agent', title: 'ai' }])
  })

  it('refuses to write into a user console without running anything', async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoles-'))
    const consolesPath = join(dir, 'consoles.json')
    const outboxDir = join(dir, 'outbox')
    await writeConsoleRegistry(consolesPath, [{ id: 'console_1', owner: 'user', title: 'console_1' }])

    const { port, seen } = recordingExecutor()
    const { client, server } = await connect(consolesPath, outboxDir, port)

    const payload = await callJson(client, 'execute_sql', {
      connId,
      sql: 'SELECT 1',
      label: '月报',
      consoleId: 'console_1',
    })

    expect(payload['ok']).toBe(false)
    expect((payload['error'] as { readonly code?: string }).code).toBe('CONSOLE_NOT_AGENT')
    // Nothing ran and nothing was delivered: the refusal happens before execution.
    expect(seen).toHaveLength(0)
    await expect(readdir(outboxDir).catch(() => [])).resolves.toHaveLength(0)

    await client.close()
    await server.close()
  })

  it('treats an unknown console id as a new console', async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoles-'))
    const consolesPath = join(dir, 'consoles.json')
    const outboxDir = join(dir, 'outbox')
    await writeConsoleRegistry(consolesPath, [{ id: 'console_1', owner: 'user', title: 'console_1' }])

    const { port } = recordingExecutor()
    const { client, server } = await connect(consolesPath, outboxDir, port)

    const payload = await callJson(client, 'execute_sql', {
      connId,
      sql: 'SELECT 1',
      label: '月报',
      consoleId: 'agent-unknown',
    })

    expect(payload['ok']).toBe(true)
    await expect(readdir(outboxDir)).resolves.toHaveLength(1)

    await client.close()
    await server.close()
  })

  it('ignores a registry that is missing or unreadable', async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoles-'))
    const { port } = recordingExecutor()
    const { client, server } = await connect(join(dir, 'absent.json'), join(dir, 'outbox'), port)

    const payload = await callJson(client, 'execute_sql', {
      connId,
      sql: 'SELECT 1',
      label: '月报',
      consoleId: 'console_1',
    })

    // Stale registry must not block the agent.
    expect(payload['ok']).toBe(true)

    await client.close()
    await server.close()
  })

  it('refuses execute_script for a user-owned console', async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoles-script-'))
    const consolesPath = join(dir, 'consoles.json')
    await writeConsoleRegistry(consolesPath, [{ id: 'console_1', owner: 'user', title: 'console_1' }])
    const { port, seen } = recordingExecutor()
    const { client, server } = await connect(consolesPath, join(dir, 'outbox'), port)

    const payload = await callJson(client, 'execute_script', {
      connId,
      sql: 'SELECT 1',
      label: '月报',
      consoleId: 'console_1',
    })
    expect(payload).toMatchObject({ ok: false, error: { code: 'CONSOLE_NOT_AGENT' } })
    expect(seen).toHaveLength(0)
    await client.close()
    await server.close()
  })

  it('keeps execution successful when delivery cannot be written', async () => {
    dir = await mkdtemp(join(tmpdir(), 'consoles-outbox-failure-'))
    const blocked = join(dir, 'file')
    await writeFile(blocked, 'x', 'utf8')
    const { port } = recordingExecutor()
    const { client, server } = await connect(join(dir, 'absent.json'), join(blocked, 'outbox'), port)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const payload = await callJson(client, 'execute_sql', { connId, sql: 'SELECT 1', label: '月报' })
    expect(payload['ok']).toBe(true)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('结果投递失败'))
    logged.mockRestore()
    await client.close()
    await server.close()
  })
})
