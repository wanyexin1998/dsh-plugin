/**
 * Runtime connection specs — the only channel by which a password reaches the
 * MCP server.
 *
 * The host owns configuration and credentials (docs/02 §3), while the MCP
 * server is stateless and its tools address connections by `connId` (docs/05
 * §3.1). dsh's MCP client cannot rewrite call arguments, so the host
 * materialises the resolved specs into a short-lived file and passes its path
 * in the server's argv (see `cordis.patch.yml`). The file is rewritten whenever
 * connections change and removed when the plugin unloads.
 *
 * 2026-10-17: this is a documented deviation from docs/04 §9 ("每次调用经 stdio
 * 传入") — the alternative (letting the server read the credential store) was
 * rejected because it grants a long-lived child process standing read access to
 * every secret instead of one file that exists only while the plugin runs.
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DataSource } from '../datasource/model.ts'
import type { Dbms } from '../datasource/model.ts'

/** Path segments under the harness home. */
export const RUNTIME_SPEC_SEGMENTS = ['data-ide-runtime', 'conn-specs.json'] as const

/** Everything the server needs to open a connection, resolved by the host. */
export interface ConnectionSpec {
  readonly name: string
  readonly dbms: Dbms
  readonly host: string
  readonly port: number
  readonly database?: string
  readonly username: string
  readonly password: string
  readonly driverProperties: Readonly<Record<string, string>>
  readonly writeEnabled: boolean
}

export interface RuntimeSpecDocument {
  readonly schemaVersion: 1
  readonly generatedAt: string
  /** Keyed by connection id. */
  readonly connections: Readonly<Record<string, ConnectionSpec>>
}

/** A connection without a resolvable password cannot be executed; skip it. */
export type SpecBuildOutcome =
  | { readonly included: readonly DataSource[]; readonly document: RuntimeSpecDocument; readonly missing: readonly string[] }

/**
 * Resolve stored connections into runtime specs.
 *
 * @param dataSources - Stored connections.
 * @param resolvePassword - Host-side secret lookup; returns `undefined` when absent.
 * @param now - Clock injection point for tests.
 */
export async function buildRuntimeSpecs(
  dataSources: readonly DataSource[],
  resolvePassword: (connId: string) => Promise<string | undefined>,
  now: () => number = Date.now,
): Promise<SpecBuildOutcome> {
  const connections: Record<string, ConnectionSpec> = {}
  const included: DataSource[] = []
  const missing: string[] = []

  for (const source of dataSources) {
    const password = await resolvePassword(source.id)
    if (password === undefined) {
      missing.push(source.id)
      continue
    }
    included.push(source)
    connections[source.id] = {
      name: source.name,
      dbms: source.dbms,
      host: source.host,
      port: source.port,
      ...(source.database === undefined ? {} : { database: source.database }),
      username: source.username,
      password,
      driverProperties: source.driverProperties,
      writeEnabled: source.writeEnabled,
    }
  }

  return {
    included,
    missing,
    document: { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), connections },
  }
}

/**
 * Write the spec file atomically with owner-only permissions.
 *
 * @param filePath - Absolute target path.
 * @param document - Specs to publish.
 */
export async function writeRuntimeSpecs(filePath: string, document: RuntimeSpecDocument): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, filePath)
  await chmod(filePath, 0o600)
}

/** Remove the spec file (and its temp sibling) when the plugin unloads. */
export async function removeRuntimeSpecs(filePath: string): Promise<void> {
  await rm(filePath, { force: true })
  await rm(`${filePath}.tmp`, { force: true })
}

/** Join the harness home with the runtime spec path. */
export function runtimeSpecPath(home: string): string {
  return join(home, ...RUNTIME_SPEC_SEGMENTS)
}
