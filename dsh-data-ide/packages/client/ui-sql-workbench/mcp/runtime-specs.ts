/**
 * MCP-server side of the runtime spec channel: read the host's file, expose
 * redacted listings and resolve a connection for execution.
 *
 * The server never writes this file and never logs its contents.
 */

import { readFile } from 'node:fs/promises'

import type { ConnectionSpec, RuntimeSpecDocument } from '../src/host/runtime-specs.ts'

export type { ConnectionSpec, RuntimeSpecDocument }

/** Redacted view handed to the agent: no password, ever. */
export interface RedactedDataSource {
  readonly id: string
  readonly name: string
  readonly dbms: string
  readonly host: string
  readonly port: number
  readonly database?: string
  readonly writeEnabled: boolean
}

function isConnectionSpec(value: unknown): value is ConnectionSpec {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['host'] === 'string' &&
    typeof record['port'] === 'number' &&
    typeof record['username'] === 'string' &&
    typeof record['password'] === 'string'
  )
}

/** Parse a spec document, rejecting anything structurally unexpected. */
export function parseRuntimeSpecs(raw: string): RuntimeSpecDocument {
  const parsed = JSON.parse(raw) as Partial<RuntimeSpecDocument>
  if (parsed?.schemaVersion !== 1 || typeof parsed.generatedAt !== 'string') {
    throw new Error('runtime specs: unsupported schemaVersion')
  }
  const connections: Record<string, ConnectionSpec> = {}
  for (const [id, value] of Object.entries(parsed.connections ?? {})) {
    if (isConnectionSpec(value)) connections[id] = value
  }
  return { schemaVersion: 1, generatedAt: parsed.generatedAt, connections }
}

/** Read and validate the host's spec file. */
export async function loadRuntimeSpecs(filePath: string): Promise<RuntimeSpecDocument> {
  return parseRuntimeSpecs(await readFile(filePath, 'utf8'))
}

/** Strip secrets before anything reaches the model. */
export function redactDataSources(document: RuntimeSpecDocument): readonly RedactedDataSource[] {
  return Object.entries(document.connections).map(([id, spec]) => ({
    id,
    name: spec.name,
    dbms: spec.dbms,
    host: spec.host,
    port: spec.port,
    ...(spec.database === undefined ? {} : { database: spec.database }),
    writeEnabled: spec.writeEnabled,
  }))
}

/** Resolve one connection, or explain why it cannot run. */
export function resolveSpec(
  document: RuntimeSpecDocument,
  connId: string,
): { readonly ok: true; readonly spec: ConnectionSpec } | { readonly ok: false; readonly code: string; readonly message: string } {
  const spec = document.connections[connId]
  if (spec === undefined) {
    return { ok: false, code: 'CONN_NOT_FOUND', message: `未知连接 ${connId}；先调用 list_datasources 查看可用连接` }
  }
  return { ok: true, spec }
}
