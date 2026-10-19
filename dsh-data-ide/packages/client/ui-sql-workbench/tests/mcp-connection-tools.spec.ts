import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { buildRuntimeSpecs } from '../src/host/runtime-specs.ts'
import { main, SPEC_PATH_FLAG } from '../mcp/server.ts'

/** Fake mysql2 driver: scripted rows and failures, no network. */
const driver = vi.hoisted(() => ({
  query: vi.fn<(sql: string) => Promise<[unknown, unknown]>>(),
  end: vi.fn<() => Promise<void>>(),
  createConnection: vi.fn(),
}))

vi.mock('mysql2/promise', () => ({ createConnection: driver.createConnection }))

const connId = 'ds-f02da6e0'
let directory: string
let specFile: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-data-ide-mcp-'))
  const { document } = await buildRuntimeSpecs(
    [
      createDataSource({
        id: connId,
        name: 'doris.shcell.com',
        dbms: 'doris',
        host: 'doris.shcell.com',
        port: 9030,
        username: 'wanyexin',
      }),
    ],
    async () => 'hunter2',
  )
  specFile = join(directory, 'conn-specs.json')
  await writeFile(specFile, JSON.stringify(document), 'utf8')

  driver.query.mockReset()
  driver.end.mockReset().mockResolvedValue(undefined)
  driver.createConnection.mockReset().mockResolvedValue({ query: driver.query, end: driver.end })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Connect a client to a server booted the way the profile boots it. */
async function connectWithSpecFile() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'dsh-data-ide-e2e-test', version: '0.0.0' })
  await main(serverTransport, [SPEC_PATH_FLAG, specFile])
  await client.connect(clientTransport)
  return client
}

describe('test_connection over a real spec file', () => {
  it('reports YES with Doris product facts', async () => {
    driver.query
      .mockResolvedValueOnce([[{ 1: 1 }], []])
      .mockResolvedValueOnce([[{ version: '5.7.99', comment: 'Doris version doris-2.1.10-rc01' }], []])
      .mockResolvedValueOnce([[{ mode: '' }], []])
      .mockResolvedValueOnce([[{ lctn: '0' }], []])
    const client = await connectWithSpecFile()

    const result = await client.callTool({ name: 'test_connection', arguments: { connId } })
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text).payload

    expect(payload.state).toBe('YES')
    expect(payload.info).toMatchObject({ product: 'Doris', version: '5.7.99', identifierQuoteString: '`' })
    expect(payload.info.caseSensitivity).toEqual({ plain: 'lower', quoted: 'exact' })
    expect(driver.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'doris.shcell.com', port: 9030, user: 'wanyexin', password: 'hunter2' }),
    )
    await client.close()
  })

  it('tolerates a server that rejects the optional variable probes', async () => {
    driver.query
      .mockResolvedValueOnce([[{ 1: 1 }], []])
      .mockResolvedValueOnce([[{ version: '8.0.36', comment: null }], []])
      .mockRejectedValueOnce(Object.assign(new Error('Unknown system variable'), { code: 1193 }))
      .mockResolvedValueOnce([[{ lctn: '0' }], []])
    const client = await connectWithSpecFile()

    const result = await client.callTool({ name: 'test_connection', arguments: { connId } })
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text).payload

    expect(payload.state).toBe('YES')
    expect(payload.info.product).toBe('MySQL')
    expect('exactVersion' in payload.info).toBe(false)
    await client.close()
  })

  it('reports NO with a classified reason and always closes the socket', async () => {
    driver.query.mockRejectedValue(Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR' }))
    driver.createConnection.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    const client = await connectWithSpecFile()

    const payload = JSON.parse(
      ((await client.callTool({ name: 'test_connection', arguments: { connId } })).content as { text: string }[])[0]!.text,
    ).payload

    expect(payload).toMatchObject({ state: 'NO', error: { code: 'NETWORK_UNREACHABLE' } })
    await client.close()
  })

  it('closes the connection even when the version probe fails', async () => {
    driver.query.mockResolvedValueOnce([[{ 1: 1 }], []]).mockRejectedValue(new Error('boom'))
    const client = await connectWithSpecFile()

    const payload = JSON.parse(
      ((await client.callTool({ name: 'test_connection', arguments: { connId } })).content as { text: string }[])[0]!.text,
    ).payload

    expect(payload.state).toBe('NO')
    expect(driver.end).toHaveBeenCalled()
    await client.close()
  })

  it('reports a readable error when the spec file is gone', async () => {
    await rm(specFile, { force: true })
    const client = await connectWithSpecFile()

    const payload = JSON.parse(
      ((await client.callTool({ name: 'test_connection', arguments: { connId } })).content as { text: string }[])[0]!.text,
    )

    expect(payload).toMatchObject({ ok: false, error: { code: 'SPEC_UNAVAILABLE' } })
    await client.close()
  })
})

describe('database-info edge readings', () => {
  /** Boot a server whose spec file carries two connections. */
  async function connectWithExtra() {
    const { document } = await buildRuntimeSpecs(
      [
        createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'h', port: 9030, username: 'u' }),
        createDataSource({ id: 'ds-00000001', name: 'mysql', dbms: 'mysql', host: 'h2', port: 3306, username: 'u2' }),
      ],
      async () => 'p',
    )
    await writeFile(specFile, JSON.stringify(document), 'utf8')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'edge-test', version: '0.0.0' })
    await main(serverTransport, [SPEC_PATH_FLAG, specFile])
    await client.connect(clientTransport)
    return client
  }

  it('reports ANSI_QUOTES sessions and exact case folding when defaults come back empty', async () => {
    driver.query
      .mockResolvedValueOnce([[{ 1: 1 }], []])
      .mockResolvedValueOnce([[{}], []])
      .mockResolvedValueOnce([[{ mode: 'ANSI_QUOTES' }], []])
      .mockResolvedValueOnce([[{}], []])
    const client = await connectWithExtra()

    const payload = JSON.parse(
      ((await client.callTool({ name: 'test_connection', arguments: { connId } })).content as { text: string }[])[0]!.text,
    ).payload

    expect(payload.info).toMatchObject({ version: '', identifierQuoteString: '"' })
    expect(payload.info.caseSensitivity).toEqual({ plain: 'exact', quoted: 'exact' })
    await client.close()
  })

  it('connects without a default database when the connection has none', async () => {
    driver.query
      .mockResolvedValueOnce([[{ 1: 1 }], []])
      .mockResolvedValueOnce([[{ version: '8.0.36', comment: 'MySQL' }], []])
      .mockResolvedValueOnce([[{ mode: '' }], []])
      .mockResolvedValueOnce([[{ lctn: '1' }], []])
    const client = await connectWithExtra()

    await client.callTool({ name: 'test_connection', arguments: { connId: 'ds-00000001' } })

    expect(driver.createConnection).toHaveBeenCalledWith(expect.objectContaining({ database: undefined }))
    await client.close()
  })
})

describe('spec parsing resilience', () => {
  it('accepts a document with no connections key at all', async () => {
    const { parseRuntimeSpecs } = await import('../mcp/runtime-specs.ts')

    expect(parseRuntimeSpecs(JSON.stringify({ schemaVersion: 1, generatedAt: 'x' })).connections).toEqual({})
  })
})

describe('degenerate server readings', () => {
  it('survives empty result sets, null variables and a socket that refuses to close', async () => {
    driver.end.mockRejectedValue(new Error('already closed'))
    driver.query
      .mockResolvedValueOnce([[{ 1: 1 }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[{ lctn: null }], []])
    const client = await connectWithSpecFile()

    const payload = JSON.parse(
      ((await client.callTool({ name: 'test_connection', arguments: { connId } })).content as { text: string }[])[0]!.text,
    ).payload

    expect(payload.state).toBe('YES')
    expect(payload.info.version).toBe('')
    expect(payload.info.caseSensitivity.plain).toBe('exact')
    await client.close()
  })
})

describe('closing the socket', () => {
  it('never lets a failing close mask the probe verdict', async () => {
    const { closeQuietly } = await import('../mcp/probe-mysql.ts')

    await expect(
      closeQuietly(async () => {
        throw new Error('already closed')
      }),
    ).resolves.toBeUndefined()
  })

  it('closes normally when the driver behaves', async () => {
    const { closeQuietly } = await import('../mcp/probe-mysql.ts')
    let closed = false

    await closeQuietly(async () => {
      closed = true
    })

    expect(closed).toBe(true)
  })
})
