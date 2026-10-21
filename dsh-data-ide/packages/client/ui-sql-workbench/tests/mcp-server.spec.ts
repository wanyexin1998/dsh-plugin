import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'

import { createServer, main, SERVER_INFO, SPEC_PATH_FLAG } from '../mcp/server.ts'

/** Connect a real MCP client to a real server over an in-memory pipe. */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer()
  const client = new Client({ name: 'dsh-data-ide-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

describe('MCP server', () => {
  it('identifies itself so the host can log the instance', async () => {
    const { client, server } = await connect()

    expect(SERVER_INFO.name).toBe('dsh-data-ide')
    expect(server).toBeDefined()
    await client.close()
    await server.close()
  })

  it('lists the connection tools (AC-5: the agent must see mcp__sql__ping)', async () => {
    const { client, server } = await connect()

    const listed = await client.listTools()

    expect(listed.tools.map(tool => tool.name)).toEqual([
      'ping',
      'list_datasources',
      'test_connection',
      'get_schema',
      'list_tables',
      'execute_sql',
      'execute_script',
      'fetch_page',
      'cancel_statement',
    ])
    expect(listed.tools[0]?.inputSchema).toMatchObject({ type: 'object' })
    await client.close()
    await server.close()
  })

  it('answers a ping call with the probe payload', async () => {
    const { client, server } = await connect()

    const result = await client.callTool({ name: 'ping', arguments: {} })

    expect(result.isError).toBeFalsy()
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, pong: 'pong', server: 'dsh-data-ide' })
    await client.close()
    await server.close()
  })

  it('answers list_datasources from the host-published specs', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'dsh-data-ide-list-test', version: '0.0.0' })
    await createServer({
      specs: async () => ({
        schemaVersion: 1,
        generatedAt: 'x',
        connections: {
          'ds-1': {
            name: 'doris',
            dbms: 'doris',
            host: 'h',
            port: 9030,
            username: 'u',
            password: 'p',
            driverProperties: {},
            writeEnabled: false,
          },
        },
      }),
    }).connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({ name: 'list_datasources', arguments: {} })
    const content = result.content as { type: string; text: string }[]

    expect(JSON.parse(content[0]!.text).payload.datasources[0]).toMatchObject({ id: 'ds-1', host: 'h' })
    expect(content[0]!.text).not.toContain('"password"')
    await client.close()
  })

  it('refuses to serve connection tools without a spec source', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'dsh-data-ide-nospec-test', version: '0.0.0' })
    await createServer().connect(serverTransport)
    await client.connect(clientTransport)

    const result = await client.callTool({ name: 'list_datasources', arguments: {} })

    expect(JSON.stringify(result.content)).toContain(SPEC_PATH_FLAG)
    await client.close()
  })

  it('serves over whatever transport the host hands it', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'dsh-data-ide-main-test', version: '0.0.0' })

    await main(serverTransport)
    await client.connect(clientTransport)
    const listed = await client.listTools()

    expect(listed.tools.map(tool => tool.name)).toContain('ping')
    await client.close()
  })
})
