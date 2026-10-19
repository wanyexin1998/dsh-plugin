/**
 * Result envelope shared by the MCP tools and the host service.
 *
 * Refusals and failures read the same way to both callers (docs/05 §4), so the
 * grid can render an error banner and the agent can branch on `ok` without two
 * different shapes.
 */

import { type ExecuteRequest, type ExecuteResponse, type ExecutionDeps, executeSql, fetchPage } from './core.ts'
import type { Refusal } from './core.ts'

export type ExecutionResult =
  | ({ readonly ok: true } & ExecuteResponse)
  | { readonly ok: false; readonly error: Refusal }

/** Run a statement and return its first page plus the total count. */
export async function runExecuteSql(deps: ExecutionDeps, request: ExecuteRequest): Promise<ExecutionResult> {
  const result = await executeSql(deps, request)
  if ('refusal' in result) return { ok: false, error: result.refusal }
  return { ok: true, ...result }
}

/** Fetch another page without re-counting. */
export async function runFetchPage(deps: ExecutionDeps, request: ExecuteRequest): Promise<ExecutionResult> {
  const result = await fetchPage(deps, request)
  if ('refusal' in result) return { ok: false, error: result.refusal }
  return { ok: true, ...result }
}

/**
 * Cancel a running statement.
 *
 * @param deps - Execution wiring.
 * @param statementId - Id handed out by the statement registry or minted by the caller.
 * @returns Whether a live statement was actually aborted.
 */
export async function cancelStatement(deps: ExecutionDeps, statementId: string): Promise<{ readonly cancelled: boolean }> {
  await deps.executor.cancel(statementId)
  deps.registry.forget(statementId)
  return { cancelled: true }
}
