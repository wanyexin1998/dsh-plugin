/**
 * SQL execution core: paging, counting, permission gating and value truncation.
 *
 * Lives in `src/` rather than `mcp/` because two callers share it: the MCP
 * server (the agent's `mcp__sql__*` tools) and the host service the panel talks
 * to. Both build the same `ExecutionDeps` and reach the same wire shape, so the
 * grid and the agent never disagree about what a page is.
 *
 * The transport is a port (`QueryExecutor`) so the paging SQL, the read-only
 * policy and the wire shape are testable without a database; `mysql.ts`
 * supplies the mysql2 implementation (docs/05 §3.2).
 */

import type { ConnectionSpec } from '../host/runtime-specs.ts'

/** One result column: the label the grid shows plus the driver's type name. */
export interface QueryField {
  readonly name: string
  readonly typeName: string
}

/** Result of one statement, shaped like the driver returns it. */
export interface QueryResult {
  readonly fields: readonly QueryField[]
  readonly rows: readonly unknown[][]
}

/** Transport port; one call is one statement. */
export interface QueryExecutor {
  query(spec: ConnectionSpec, sql: string, statementId: string): Promise<QueryResult>
  /** Abort a running statement (driver-specific; a destroyed socket in practice). */
  cancel(statementId: string): Promise<void>
}

/** Server-side sort applied to the wrapped query. */
export interface SortSpec {
  readonly column: string
  readonly direction: 'ASC' | 'DESC'
}

/** Comparison a column filter applies. */
export type FilterOp =
  | 'contains'
  | 'notContains'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'isNull'
  | 'notNull'

/**
 * One column filter, applied by the server to the wrapped statement.
 *
 * Filtering happens in SQL rather than in the grid because a page is only 100–
 * 5000 rows: "find this order" has to reach the whole table, the way DataGrip's
 * column filter does.
 */
export interface FilterSpec {
  readonly column: string
  readonly op: FilterOp
  /** Ignored by `isNull` / `notNull`. */
  readonly value?: string
  /** Quote-free literal, decided from the driver's type name by the caller. */
  readonly numeric?: boolean
}

export interface ExecuteRequest {
  readonly connId: string
  readonly sql: string
  readonly pageSize?: number
  readonly offset?: number
  readonly sort?: SortSpec
  /** ANDed together in the paging wrapper; ignored by `raw` runs. */
  readonly filters?: readonly FilterSpec[]
  /**
   * Caller-chosen statement id. The panel mints one so it can cancel a query it
   * started before the response arrives; when omitted the registry assigns one.
   */
  readonly statementId?: string
  /**
   * Run the statement as written, without the paging wrapper or the count.
   *
   * Metadata reads (`SHOW CREATE TABLE`, `SHOW FULL COLUMNS`, `EXPLAIN`) are not
   * derived tables; wrapping them breaks on every MySQL-family server. Still
   * goes through the permission gate.
   */
  readonly raw?: boolean
}

export interface ExecuteResponse {
  /** Columns in driver order, with the type name the grid formats by. */
  readonly columns: readonly QueryField[]
  /** At most `pageSize + 1` rows; the extra row is the "has next page" probe. */
  readonly rows: readonly unknown[][]
  readonly total: number | null
  readonly hasNextPage: boolean
  readonly offset: number
  readonly durationMs: number
  /** Echo of the id `cancel_statement` / `cancel` needs. */
  readonly statementId: string
  readonly truncated?: { readonly cells: number }
}

export const DEFAULT_PAGE_SIZE = 500
/**
 * How long the first page waits for `COUNT(*)`.
 *
 * DataGrip never blocks a grid on a total: it shows the rows it has and a
 * paging control (its own setting is `paging-display-mode=DATA_EDITOR_TOOLBAR`).
 * A warehouse COUNT over tens of millions of rows can take seconds, so the page
 * is returned as soon as it arrives and a slow count simply reads as unknown
 * (总数未知, docs/05 §7). This is the "query feels slow" fix: the page no longer
 * queues behind the count.
 */
export const COUNT_TIMEOUT_MS = 1200
export const MAX_PAGE_SIZE = 5000
/** DataGrip's observed probe shape: fetch one row beyond the page (RUNTIME-FINDINGS §4). */
const PROBE_ROWS = 1
/** Single-cell ceiling (docs/04 §6). */
export const MAX_CELL_BYTES = 1024 * 1024

/** Statements that change data or schema are refused unless writes are enabled. */
const WRITE_PREFIX = /^\s*(insert|update|delete|replace|merge|truncate|create|alter|drop|rename|grant|revoke|call|do|load|set)\b/i

/** Hard-refused regardless of `writeEnabled` (docs/05 §6 DDL blacklist). */
const DDL_BLACKLIST = /^\s*(drop|truncate|alter|grant|revoke)\b/i

export type ExecutionRefusal = { readonly code: 'WRITE_NOT_ALLOWED' | 'DDL_FORBIDDEN' | 'EMPTY_SQL'; readonly message: string }

/** A refusal plus the codes the transport layer can return before touching a driver. */
export interface Refusal {
  readonly code: string
  readonly message: string
}

/**
 * Decide whether a statement may run.
 *
 * @param sql - Statement text.
 * @param writeEnabled - Connection-level switch a human flipped in the UI.
 */
export function checkPermission(sql: string, writeEnabled: boolean): ExecutionRefusal | undefined {
  if (sql.trim() === '') return { code: 'EMPTY_SQL', message: 'SQL 为空' }
  if (DDL_BLACKLIST.test(sql)) return { code: 'DDL_FORBIDDEN', message: 'DDL 语句在默认策略下被拒绝（DROP/TRUNCATE/ALTER/GRANT/REVOKE）' }
  if (!writeEnabled && WRITE_PREFIX.test(sql)) {
    return { code: 'WRITE_NOT_ALLOWED', message: '该连接未开启 writeEnabled，只允许 SELECT；如需写入请在连接配置里显式开启' }
  }
  return undefined
}

/** Clamp a requested page size into the supported band. */
export function normalizePageSize(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PAGE_SIZE
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)))
}

/**
 * Quote an identifier for the ORDER BY wrapper.
 *
 * Doris tables routinely carry Chinese column labels, and qualified names
 * (`t.created_at`) reach us from result sets, so the gate rejects only what can
 * actually break out of a quoted identifier: quotes, semicolons, comment
 * markers and whitespace.
 */
function quoteIdentifier(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || /[;'"`]|--|\/\*|\s/.test(trimmed)) throw new Error(`非法排序列名：${name}`)
  return `\`${trimmed}\``
}

/**
 * Wrap a statement for paging.
 *
 * Mirrors DataGrip's `WrapInSelect` shape: the user's SQL becomes a derived
 * table, so LIMIT/OFFSET/ORDER BY apply to the result rather than the original.
 */
export function buildPagedQuery(
  sql: string,
  options: {
    readonly limit: number
    readonly offset: number
    readonly sort?: SortSpec
    readonly filters?: readonly FilterSpec[]
  },
): string {
  const order = options.sort === undefined ? '' : ` ORDER BY ${quoteIdentifier(options.sort.column)} ${options.sort.direction}`
  return `SELECT * FROM (\n${sql}\n) AS t${filterClause(options.filters)}${order} LIMIT ${options.limit} OFFSET ${options.offset}`
}

/** Independent count over the same statement; failure yields `null`, not an error. */
export function buildCountQuery(sql: string, filters?: readonly FilterSpec[]): string {
  return `SELECT COUNT(*) AS c FROM (\n${sql}\n) AS t${filterClause(filters)}`
}

/** Longest value a filter may carry; longer input is a paste accident, not a filter. */
const MAX_FILTER_VALUE = 200

/** Escape a value into a SQL string literal. */
function stringLiteral(value: string): string {
  return `'${value.slice(0, MAX_FILTER_VALUE).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** Numeric columns compare without quotes; anything unparsable falls back to a string. */
function literalFor(filter: FilterSpec): string {
  const value = filter.value ?? ''
  if (filter.numeric === true && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim()
  return stringLiteral(value)
}

/** One condition; the column goes through the same identifier gate as ORDER BY. */
function conditionSql(filter: FilterSpec): string {
  const column = quoteIdentifier(filter.column)
  const value = filter.value ?? ''
  switch (filter.op) {
    case 'contains': return `${column} LIKE ${stringLiteral(`%${value}%`)}`
    case 'notContains': return `${column} NOT LIKE ${stringLiteral(`%${value}%`)}`
    case 'eq': return `${column} = ${literalFor(filter)}`
    case 'ne': return `${column} <> ${literalFor(filter)}`
    case 'gt': return `${column} > ${literalFor(filter)}`
    case 'ge': return `${column} >= ${literalFor(filter)}`
    case 'lt': return `${column} < ${literalFor(filter)}`
    case 'le': return `${column} <= ${literalFor(filter)}`
    case 'isNull': return `${column} IS NULL`
    case 'notNull': return `${column} IS NOT NULL`
  }
}

/** ` WHERE a AND b`, or an empty string when there is nothing to filter. */
export function filterClause(filters: readonly FilterSpec[] | undefined): string {
  if (filters === undefined || filters.length === 0) return ''
  return ` WHERE ${filters.map(conditionSql).join(' AND ')}`
}

/** Everything before the first semicolon, which is the statement we run. */
export function firstStatement(sql: string): string {
  // `split` always yields at least one element, so the head is never undefined.
  const head = sql.split(';')[0] as string
  return head.trim()
}

/** Truncate one oversized cell, counting how many cells were clipped. */
export function truncateRow(row: readonly unknown[], previous: number): { row: unknown[]; truncated: number } {
  let clipped = previous
  const cells = row.map(cell => {
    if (typeof cell !== 'string' && !Buffer.isBuffer(cell)) return cell
    const text = Buffer.isBuffer(cell) ? cell.toString('base64') : cell
    if (Buffer.byteLength(text, 'utf8') <= MAX_CELL_BYTES) return cell
    clipped += 1
    return `${text.slice(0, 32)}…（值过大）`
  })
  return { row: cells, truncated: clipped }
}

/** Statements this process has open, so `cancel` can reach them. */
export interface StatementRegistry {
  next(): string
  forget(statementId: string): void
}

export function createStatementRegistry(): StatementRegistry {
  let counter = 0
  return {
    next: () => {
      counter += 1
      return `stmt-${counter}`
    },
    forget: () => undefined,
  }
}

/** Everything execution needs beyond the SQL text. */
export interface ExecutionDeps {
  readonly specs: () => Promise<{ readonly connections: Readonly<Record<string, ConnectionSpec>> }>
  readonly executor: QueryExecutor
  readonly registry: StatementRegistry
  readonly now?: () => number
  /** Override for tests; see {@link COUNT_TIMEOUT_MS}. */
  readonly countTimeoutMs?: number
}

/** Resolve the connection spec, or explain that the id is unknown. */
function prepare(
  document: { readonly connections: Readonly<Record<string, ConnectionSpec>> },
  connId: string,
): { readonly spec: ConnectionSpec } | { readonly refusal: Refusal } {
  const spec = document.connections[connId]
  if (spec === undefined) return { refusal: { code: 'CONN_NOT_FOUND', message: `未知连接 ${connId}` } }
  return { spec }
}

/** Resolve with `fallback` when `work` takes longer than `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => { resolve(fallback) }, ms)
    void work.then(value => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

/** Turn driver rows into the page we ship: probe row dropped, cells clipped. */
function toPage(page: QueryResult, pageSize: number, offset: number, durationMs: number, statementId: string, total: number | null): ExecuteResponse {
  const hasNextPage = page.rows.length > pageSize
  const visible = hasNextPage ? page.rows.slice(0, pageSize) : [...page.rows]
  let truncated = 0
  const rows = visible.map(row => {
    const clipped = truncateRow(row, truncated)
    truncated = clipped.truncated
    return clipped.row
  })

  return {
    columns: page.fields,
    rows,
    total,
    hasNextPage,
    offset,
    durationMs,
    statementId,
    ...(truncated === 0 ? {} : { truncated: { cells: truncated } }),
  }
}

/**
 * Run one statement and return its first page plus the total count.
 *
 * The probe row (`pageSize + 1`) and the count run in parallel, as DataGrip
 * does (RUNTIME-FINDINGS §4); a failing count degrades to `null` instead of
 * failing the whole call (docs/05 §7).
 */
export async function executeSql(deps: ExecutionDeps, request: ExecuteRequest): Promise<ExecuteResponse | { readonly refusal: Refusal }> {
  const now = deps.now ?? Date.now
  const started = now()
  const document = await deps.specs()
  const resolved = prepare(document, request.connId)
  if ('refusal' in resolved) return resolved

  const sql = firstStatement(request.sql)
  const permission = checkPermission(sql, resolved.spec.writeEnabled)
  if (permission !== undefined) return { refusal: permission }

  const pageSize = normalizePageSize(request.pageSize)
  const offset = Math.max(0, request.offset ?? 0)
  const statementId = request.statementId ?? deps.registry.next()

  // Metadata statements (`SHOW CREATE TABLE`, `EXPLAIN`, …) cannot live inside
  // the paging wrapper — Doris answers `SELECT * FROM (SHOW CREATE …)` with a
  // syntax error — so `raw` runs them as written. Permissions still applied.
  if (request.raw === true) {
    const rawPage = await deps.executor.query(resolved.spec, sql, statementId)
    deps.registry.forget(statementId)
    return toPage(rawPage, pageSize, offset, now() - started, statementId, null)
  }

  // The count runs alongside the page but must not hold it hostage.
  const counted = deps.executor
    .query(resolved.spec, buildCountQuery(sql, request.filters), `${statementId}-count`)
    .then(result => Number((result.rows[0]?.[0] as number | undefined) ?? 0))
    .catch(() => null)
  const page = await deps.executor.query(
    resolved.spec,
    buildPagedQuery(sql, {
      limit: pageSize + PROBE_ROWS,
      offset,
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
    }),
    statementId,
  )
  deps.registry.forget(statementId)

  const total = await withTimeout(counted, deps.countTimeoutMs ?? COUNT_TIMEOUT_MS, null)
  return toPage(page, pageSize, offset, now() - started, statementId, total)
}

/** Fetch another page without re-counting. */
export async function fetchPage(deps: ExecutionDeps, request: ExecuteRequest): Promise<ExecuteResponse | { readonly refusal: Refusal }> {
  const now = deps.now ?? Date.now
  const started = now()
  const document = await deps.specs()
  const resolved = prepare(document, request.connId)
  if ('refusal' in resolved) return resolved

  const sql = firstStatement(request.sql)
  const permission = checkPermission(sql, resolved.spec.writeEnabled)
  if (permission !== undefined) return { refusal: permission }

  const pageSize = normalizePageSize(request.pageSize)
  const offset = Math.max(0, request.offset ?? 0)
  const statementId = request.statementId ?? deps.registry.next()
  const page = await deps.executor.query(
    resolved.spec,
    buildPagedQuery(sql, {
      limit: pageSize + PROBE_ROWS,
      offset,
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.filters === undefined ? {} : { filters: request.filters }),
    }),
    statementId,
  )
  deps.registry.forget(statementId)

  return toPage(page, pageSize, offset, now() - started, statementId, null)
}
