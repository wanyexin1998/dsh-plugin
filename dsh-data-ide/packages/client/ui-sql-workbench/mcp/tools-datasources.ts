/**
 * Connection-management tools (docs/05 §3.1): `list_datasources` and
 * `test_connection`.
 *
 * Both read the host's runtime spec file; neither ever returns a password.
 */

import type { DatabaseInfo } from '../src/datasource/model.ts'
import type { ConnectionProbe } from './probe.ts'
import { type RedactedDataSource, redactDataSources, resolveSpec } from './runtime-specs.ts'
import type { RuntimeSpecDocument } from '../src/host/runtime-specs.ts'

export const LIST_DATASOURCES = 'list_datasources'
export const TEST_CONNECTION = 'test_connection'

/** Raw shapes; the MCP layer wraps them into text content. */
export type ToolResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly hint?: string } }

export interface ListResult {
  readonly datasources: readonly RedactedDataSource[]
}

export interface TestResult {
  readonly state: 'YES' | 'NO' | 'UNSURE'
  readonly info?: DatabaseInfo
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string }
}

/** List every connection the host published, secrets stripped. */
export function listDatasources(document: RuntimeSpecDocument): ToolResult & { readonly payload: ListResult } {
  return { ok: true, payload: { datasources: redactDataSources(document) } }
}

/**
 * Test one connection and return the three-state outcome.
 *
 * @param document - Host specs.
 * @param connId - Connection under test.
 * @param probe - Transport; injected so the state machine is testable.
 */
export async function testConnection(
  document: RuntimeSpecDocument,
  connId: string,
  probe: ConnectionProbe,
): Promise<ToolResult & { readonly payload?: TestResult }> {
  const resolved = resolveSpec(document, connId)
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.message } }
  }

  const outcome = await probe(resolved.spec)
  if (outcome.state === 'YES') {
    return { ok: true, payload: { state: 'YES', info: outcome.info } }
  }
  return { ok: true, payload: { state: outcome.state, error: outcome.error } }
}
