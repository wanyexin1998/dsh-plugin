/**
 * Multi-statement execution.
 *
 * DataGrip runs a whole script and gives every statement its own result tab
 * (docs/03 §4.3). This module is that behaviour on the node side: split, run in
 * order on the same connection, stop at the first failure, and report per
 * statement so the grid can show which one produced which rows.
 *
 * The single-statement paths (`executeSql` / `fetchPage`) are untouched: the MCP
 * tools and the pager keep using them, so an agent's `SELECT` and the panel's
 * page-2 request behave exactly as before.
 */

import { type ExecuteResponse, type ExecutionDeps, type Refusal, executeSql } from './core.ts'
import { splitStatements } from './split.ts'

export interface ScriptRequest {
  readonly connId: string
  /** Whole script, or the editor selection. */
  readonly sql: string
  readonly pageSize?: number
  /**
   * Cap on the number of statements. The MCP tool passes one so an agent cannot
   * queue an unbounded script; the panel leaves it undefined (unchanged).
   */
  readonly maxStatements?: number
}

export interface ScriptStatementOk {
  readonly index: number
  readonly sql: string
  readonly ok: true
  readonly response: ExecuteResponse
}

export interface ScriptStatementFailed {
  readonly index: number
  readonly sql: string
  readonly ok: false
  readonly error: Refusal
}

export type ScriptStatement = ScriptStatementOk | ScriptStatementFailed

export interface ScriptResponse {
  readonly statements: readonly ScriptStatement[]
  /** Wall-clock time for the whole script. */
  readonly durationMs: number
  /** Set when the run stopped early (the failing statement is the last entry). */
  readonly stopped?: boolean
}

/**
 * Run every statement in order.
 *
 * Stops at the first refusal or driver error — DataGrip's default — so a failed
 * statement cannot be followed by a destructive one that the user never saw run.
 *
 * @param deps - Execution ports (specs, executor, registry).
 * @param request - Script plus connection.
 */
export async function executeScript(
  deps: ExecutionDeps,
  request: ScriptRequest,
): Promise<ScriptResponse | { readonly refusal: Refusal }> {
  const now = deps.now ?? Date.now
  const started = now()
  const statements = splitStatements(request.sql)

  if (statements.length === 0) {
    return { refusal: { code: 'EMPTY_SQL', message: '没有可执行的语句' } }
  }

  if (request.maxStatements !== undefined && statements.length > request.maxStatements) {
    // Reject rather than silently truncate: the agent must know it lost work.
    return {
      refusal: {
        code: 'TOO_MANY_STATEMENTS',
        message: `脚本包含 ${statements.length} 条语句，超过上限 ${request.maxStatements} 条`,
      },
    }
  }

  const results: ScriptStatement[] = []
  let stopped = false

  for (const [index, statement] of statements.entries()) {
    let outcome: Awaited<ReturnType<typeof executeSql>>
    try {
      outcome = await executeSql(deps, {
        connId: request.connId,
        sql: statement.text,
        ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
      })
    } catch (error) {
      // A driver failure belongs to this statement, not to the whole script.
      results.push({
        index,
        sql: statement.text,
        ok: false,
        error: { code: 'EXEC_ERROR', message: error instanceof Error ? error.message : String(error) },
      })
      stopped = true
      break
    }

    if ('refusal' in outcome) {
      results.push({ index, sql: statement.text, ok: false, error: outcome.refusal })
      stopped = true
      break
    }

    results.push({ index, sql: statement.text, ok: true, response: outcome })
  }

  return {
    statements: results,
    durationMs: now() - started,
    ...(stopped ? { stopped } : {}),
  }
}
