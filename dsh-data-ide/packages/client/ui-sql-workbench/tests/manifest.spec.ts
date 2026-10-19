import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse, type ScalarTag } from 'yaml'
import { describe, expect, it } from 'vitest'

/**
 * The host parses `!!js` scalars into `{ __jsExpr }` nodes
 * (`packages/boot/app-boot/src/config-schema/projector.ts`), evaluated later
 * against the Loader context. Mirror that shape here so the assertions read the
 * same value the harness will.
 */
const jsExpressionTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: unknown) => ({ __jsExpr: String(value).trim() }),
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
  exports: Record<string, unknown>
  peerDependencies?: Record<string, string>
}
const patch = parse(readFileSync(resolve(packageRoot, manifest.dsh.bundle.patch), 'utf8'), {
  customTags: [jsExpressionTag],
}) as {
  insert: { id: string; name: string; config?: Record<string, unknown> }[]
}[]
const rows = patch.flatMap(entry => entry.insert)

describe('plugin manifest', () => {
  it('is an external plugin: bare name, bundle patch, web client half', () => {
    expect(manifest.name).toBe('dsh-data-ide')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    // The bundle only requires the shell's react/react-dom, so it must not list
    // package specifiers that vary between host versions (0.1.7 shipped
    // `dsh-client-ui-slots`; 0.2.1 does not) — an unknown row fails the graph.
    expect(manifest.dsh.client.inject).toEqual([])
  })

  it('exports a real ./client half, or the host scan throws', () => {
    expect(manifest.exports['./client']).toMatchObject({ default: './lib/client.js' })
    expect(manifest.exports['./mcp']).toMatchObject({ default: './lib/mcp/server.js' })
  })

  it('declares no @deepseek-ai peers, because dsh 0.1.7 hard-fails on mismatches', () => {
    // dsh skips an incompatible bundle outright (packages/boot/plugin-manager/src/index.ts:301-302);
    // an absent peerDependencies field is exempt (app-boot/src/plugin-compatibility.ts:69).
    expect(manifest.peerDependencies).toBeUndefined()
  })
})

describe('bundle patch', () => {
  it('inserts the plugin row under its own package name', () => {
    const row = rows.find(entry => entry.id === 'dsh-data-ide')

    expect(row?.name).toBe('dsh-data-ide')
  })

  it('inserts one mcp-sql instance with the agreed server identity and budget', () => {
    const row = rows.find(entry => entry.id === 'mcp-sql')

    expect(row?.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(row?.config).toMatchObject({ serverName: 'sql', transport: 'stdio' })
    expect(row?.config?.toolCallTimeoutMs).toBe(120000)
  })

  it('resolves the server entry through the profile instead of a machine path', () => {
    const row = rows.find(entry => entry.id === 'mcp-sql')
    const args = row?.config?.args as { __jsExpr: string }

    expect(args.__jsExpr).toContain('dsh-data-ide/lib/mcp/server.js')
    expect(args.__jsExpr).toContain('--profile')
    expect(args.__jsExpr).not.toMatch(/[A-Z]:\\/)
  })
})
