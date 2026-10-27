/**
 * Query-panel state machine: editing, running, paging, sorting, cancelling.
 *
 * Kept free of React (same reason as `connections.ts`): every transition is a
 * plain async function over an immutable state, so the interaction matrix in
 * docs/03 §5 — empty / running / error / result — is unit-testable without a DOM.
 */

import type { ExecuteRequest, ExecuteResponse, FilterSpec, SortSpec } from '../../execute/core.ts'
import { canWrapStatement } from '../../execute/core.ts'
import { readableDbError, userErrorLine } from '../db-error.ts'
import type { WorkbenchApi } from '../api.ts'

/** Page sizes the pager offers (docs/03 §6.4). */
export const PAGE_SIZES = [100, 500, 1000, 5000] as const
export const DEFAULT_PAGE_SIZE = 500

export type QueryStatus = 'idle' | 'running' | 'done' | 'error'

/** How a run reaches the server: authored-as-written (`direct`) or browsable page. */
export type QueryMode = 'direct' | 'paged'

export interface QueryState {
  readonly sql: string
  readonly status: QueryStatus
  /**
   * Default is `direct`: hand-written SQL runs as authored, with a probe limit
   * and no COUNT. Paging/sorting/filtering switches the same console to `paged`.
   */
  readonly mode: QueryMode
  /** Last successful page, kept while the next one loads so the grid does not blink. */
  readonly result: ExecuteResponse | null
  readonly error: { readonly code: string; readonly message: string; readonly line?: number } | null
  readonly pageSize: number
  readonly sort: SortSpec | null
  /** Server-side column filters (ANDed); applied to the wrapped statement. */
  readonly filters: readonly FilterSpec[]
  /** Known total from the first page; `null` means "总数未知" (docs/05 §7). */
  readonly total: number | null
  /** Id of the statement in flight, so cancel can reach it. */
  readonly statementId: string | null
}

export const INITIAL_QUERY: QueryState = {
  sql: '',
  status: 'idle',
  mode: 'direct',
  result: null,
  error: null,
  pageSize: DEFAULT_PAGE_SIZE,
  sort: null,
  filters: [],
  total: null,
  statementId: null,
}

let counter = 0

/** Mint a statement id; the panel cancels with it before the response lands. */
export function nextStatementId(): string {
  counter += 1
  return `ui-${counter}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Replace the column filters; the caller re-runs the statement afterwards. */
export function setFilters(state: QueryState, filters: readonly FilterSpec[]): QueryState {
  return { ...state, filters }
}

/** Update the statement text without touching the last result. */
export function setSql(state: QueryState, sql: string): QueryState {
  return { ...state, sql }
}

/** Change the page size; a new size only takes effect on the next run/page turn. */
export function setPageSize(state: QueryState, pageSize: number): QueryState {
  return { ...state, pageSize, mode: 'paged' }
}

/** Switch an existing console between authored-as-written and browsable modes. */
export function setMode(state: QueryState, mode: QueryMode): QueryState {
  return { ...state, mode }
}

/** The request every execute/fetch call shares. */
function request(state: QueryState, connId: string, statementId: string, offset?: number): ExecuteRequest {
  return {
    connId,
    sql: state.sql,
    pageSize: state.pageSize,
    statementId,
    mode: state.mode,
    ...(state.sort === null ? {} : { sort: state.sort }),
    ...(state.filters.length === 0 ? {} : { filters: state.filters }),
    ...(offset === undefined ? {} : { offset }),
  }
}

/** Run the editor contents (or `requestSql`) against the active connection. */
export async function run(
  api: WorkbenchApi,
  state: QueryState,
  connId: string,
  onStart?: (running: QueryState) => void,
  /** SQL actually executed when it differs from the editor text (run-at-cursor). */
  requestSql?: string,
): Promise<QueryState> {
  const statementId = state.statementId ?? nextStatementId()
  const running: QueryState = { ...state, status: 'running', statementId, error: null }
  // Publish before awaiting: the grid shows "正在执行…" and cancel has a target.
  onStart?.(running)
  try {
    const outcome = await api.execute({
      ...request(state, connId, statementId),
      ...(requestSql === undefined ? {} : { sql: requestSql }),
    })
    // Nothing is in flight once the answer arrives, so cancel has no target.
    if (!outcome.ok) return { ...running, status: 'error', error: failure(outcome.error, running, requestSql), result: null, total: null, statementId: null }
    return { ...running, status: 'done', result: outcome, total: outcome.total, statementId: null }
  } catch (error) {
    return { ...running, status: 'error', error: thrownFailure(error, running, requestSql), result: null, total: null, statementId: null }
  }
}

/** A refusal, in words the reader can act on. */
function failure(
  error: { readonly code: string; readonly message: string },
  state: QueryState,
  overrideSql?: string,
): { readonly code: string; readonly message: string; readonly line?: number } {
  const message = readableDbError(error)
  const sql = overrideSql ?? state.sql
  const offset = state.mode === 'paged' ? 1 : canWrapStatement(sql) ? 1 : 0
  const line = userErrorLine(error.message, offset)
  return { code: error.code, message, ...(line === null ? {} : { line }) }
}

/** A thrown transport failure carries no refusal code; still try to locate a line. */
function thrownFailure(error: unknown, state: QueryState, overrideSql?: string): { readonly code: string; readonly message: string; readonly line?: number } {
  const raw = describe(error)
  const offset = state.mode === 'paged' ? 1 : canWrapStatement(overrideSql ?? state.sql) ? 1 : 0
  const line = userErrorLine(raw, offset)
  return { code: 'UNKNOWN', message: readableDbError({ message: raw }), ...(line === null ? {} : { line }) }
}

/** Jump to another page of the same statement; the cached total survives. */
export async function goPage(
  api: WorkbenchApi,
  state: QueryState,
  connId: string,
  offset: number,
  onStart?: (running: QueryState) => void,
): Promise<QueryState> {
  if (offset < 0 || state.result === null) return state
  // Turning a page needs the real wrapper (OFFSET/ORDER BY/COUNT).
  const paged: QueryState = { ...state, mode: 'paged' }
  const statementId = paged.statementId ?? nextStatementId()
  const running: QueryState = { ...paged, status: 'running', statementId, error: null }
  onStart?.(running)
  try {
    const outcome = await api.fetchPage(request(paged, connId, statementId, offset))
    if (!outcome.ok) return { ...running, status: 'error', error: failure(outcome.error, running), statementId: null }
    return { ...running, status: 'done', result: outcome, statementId: null }
  } catch (error) {
    return { ...running, status: 'error', error: thrownFailure(error, running), statementId: null }
  }
}

/** Cycle a column header: none → ASC → DESC → none. */
export function nextSort(current: SortSpec | null, column: string): SortSpec | null {
  if (current === null || current.column !== column) return { column, direction: 'ASC' }
  return current.direction === 'ASC' ? { column, direction: 'DESC' } : null
}

/** Apply a header click: re-run page 1 under the new ordering. */
export async function sortBy(
  api: WorkbenchApi,
  state: QueryState,
  connId: string,
  column: string,
  onStart?: (running: QueryState) => void,
): Promise<QueryState> {
  return goPage(api, { ...state, sort: nextSort(state.sort, column) }, connId, 0, onStart)
}

/** Abort the statement in flight. */
export async function cancel(api: WorkbenchApi, state: QueryState): Promise<QueryState> {
  if (state.statementId === null) return state
  const statementId = state.statementId
  try {
    await api.cancel(statementId)
  } catch (error) {
    return { ...state, status: 'error', error: { code: 'UNKNOWN', message: describe(error) } }
  }
  return { ...state, status: 'error', statementId: null, error: { code: 'CANCELLED', message: '查询已取消' } }
}
