import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = resolve(packageRoot, 'lib/mcp/server.js')

/**
 * End-to-end check of the shape the profile's `mcp-sql` row uses: spawn the
 * built server over stdio with the host's own node binary, then discover and
 * call its tools (AC-5).
 */
describe('spawned MCP server', () => {
  it('answers tools/list and tools/call over stdio', async () => {
    expect(
      existsSync(serverEntry),
      `built server missing at ${serverEntry} — run \`pnpm build\` before the tests`,
    ).toBe(true)

    const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry] })
    const client = new Client({ name: 'dsh-data-ide-spawn-test', version: '0.0.0' })
    await client.connect(transport)

    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toContain('ping')

    const result = await client.callTool({ name: 'ping', arguments: {} })
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, pong: 'pong' })

    await client.close()
    // Spawning a real node process is ~10x slower under v8 coverage on this
    // host; the default 5s budget is a flake, not a signal.
  }, 30_000)
})
