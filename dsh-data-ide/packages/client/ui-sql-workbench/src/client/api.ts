/**
 * The client half's view of the host service.
 *
 * The node half publishes `sqlWorkbench` (see `src/host/binding.ts`); the
 * browser half receives it through the same Cordis context that carries the
 * slot services, so the UI depends on this narrow port rather than on storage
 * or credential details (docs/02 §3).
 */

import type { ConnectionDraft, DataSource, TestState } from '../datasource/model.ts'
import type { ExecuteRequest } from '../execute/core.ts'
import type { ExecutionResult } from '../execute/envelope.ts'
import type { ScriptRequest, ScriptResponse } from '../execute/script.ts'
import type { SchemaSnapshot } from '../host/metadata.ts'

/** Re-export so panel code keeps importing its draft type from one place. */
export type { ConnectionDraft } from '../datasource/model.ts'

/** Three-state connection-test result plus the cached product facts. */
export interface TestResult {
  readonly state: TestState
  readonly info?: DataSource['databaseInfo']
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string }
  readonly durationMs: number
}

/** Draft a connection form produces; `id` is absent for a new connection. */
export type Draft = ConnectionDraft

/** Everything the panel needs from the host. */
export interface WorkbenchApi {
  list(): Promise<readonly DataSource[]>
  active(): Promise<string | null>
  setActive(connId: string | null): Promise<void>
  save(draft: ConnectionDraft): Promise<DataSource>
  remove(connId: string): Promise<boolean>
  /** Run the host-side three-state probe and cache its result. */
  test(connId: string): Promise<TestResult>
  /** Run a statement; the first page plus the total comes back. */
  execute(request: ExecuteRequest): Promise<ExecutionResult>
  /** Another page of the same statement, without re-counting. */
  fetchPage(request: ExecuteRequest): Promise<ExecutionResult>
  /** Abort a statement the panel started (the id it minted). */
  cancel(statementId: string): Promise<{ readonly cancelled: boolean }>
  /** Tables and columns for completion. */
  schema(connId: string, options?: { readonly refresh?: boolean }): Promise<SchemaSnapshot>
  /** Run a script; one result per statement. */
  executeScript(request: ScriptRequest): Promise<ScriptResponse | { readonly refusal: { readonly code: string; readonly message: string } }>
  /** Last saved layout document, unvalidated (the panel clamps it). */
  layout?(): Promise<unknown>
  /** Persist the layout; absent on hosts that do not store it. */
  saveLayout?(layout: unknown): Promise<void>
}

/** Service name published by the node half (only reachable in-process). */
export const SERVICE_NAME = 'sqlWorkbench'

/**
 * Read the host service from the client context, if the host provided one.
 *
 * In the web frontend the browser half runs in another process, so the service
 * is absent (and some host contexts throw on unknown property access) — the
 * caller falls back to the HTTP transport in `http-api.ts`.
 */
export function workbenchApi(ctx: { readonly [key: string]: unknown }): WorkbenchApi | undefined {
  try {
    return ctx[SERVICE_NAME] as WorkbenchApi | undefined
  } catch {
    return undefined
  }
}

/** Shown when the host side is missing (older harness, or node half failed). */
export const API_MISSING_HINT =
  'dsh-data-ide：宿主服务不可用（未注入 sqlWorkbench）。请确认插件的 node 半已激活。'
