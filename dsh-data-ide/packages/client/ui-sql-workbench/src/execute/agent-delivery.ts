/**
 * Delivery envelope: how an agent-side execution reaches the panel.
 *
 * The MCP server is a separate stdio process with no host context, so it cannot
 * call the host's event bus. It writes this envelope into a spool directory, and
 * the host tails that directory and broadcasts it (docs/10 §13.1). Everything in
 * this module is pure so both halves can unit-test it without a filesystem.
 */

import type { ExecutionResult } from './envelope.ts'

/** Bumped only when the wire shape changes incompatibly. */
export const AGENT_DELIVERY_SCHEMA = 1 as const

/** One statement of a script delivery, mirroring `ExecuteResponse` + refusal. */
export interface AgentStatementResult {
  readonly index: number
  readonly sql: string
  readonly ok: boolean
  readonly response?: ExecuteResponseLike
  readonly error?: { readonly code: string; readonly message: string }
}

/** `ExecuteResponse` minus `ok`, kept loose so this file stays import-light. */
export interface ExecuteResponseLike {
  readonly columns: readonly { readonly name: string; readonly typeName: string }[]
  readonly rows: readonly unknown[][]
  readonly total: number | null
  readonly hasNextPage: boolean
  readonly offset: number
  readonly durationMs: number
  readonly statementId: string
  readonly truncated?: { readonly cells: number }
}

export interface AgentDelivery {
  readonly schema: typeof AGENT_DELIVERY_SCHEMA
  readonly id: string
  readonly label: string
  readonly connId: string
  /** Explicit target console; null means "new `ai_<label>`". */
  readonly consoleId: string | null
  readonly sql: string
  readonly kind: 'single' | 'script'
  readonly at: string
  readonly single?: ExecutionResult
  readonly script?: readonly AgentStatementResult[]
  /** Set when the payload was shrunk; the grid pages via `fetch-page`. */
  readonly previewRows?: number
}

/** A spool file larger than this is shrunk to a preview. */
export const MAX_DELIVERY_BYTES = 8 * 1024 * 1024

/** Rows kept when a payload is shrunk. */
export const PREVIEW_ROWS = 100

export const LABEL_MAX_LENGTH = 64

/** Chinese, ASCII letters, digits, `_` and `-` only — safe in a tab title. */
const LABEL_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/

/** True when `label` can become a tab title without escaping. */
export function isValidLabel(label: string): boolean {
  return label.length > 0 && label.length <= LABEL_MAX_LENGTH && LABEL_PATTERN.test(label)
}

/**
 * Collapse a query to a comparison key.
 *
 * Comments and whitespace are noise for the "same batch?" question, and case is
 * irrelevant in SQL identifiers here; two runs that differ only in those are the
 * same batch and update the same console (docs/10 §13.3).
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** True when two runs belong to the same logical batch. */
export function sameBatch(a: string, b: string): boolean {
  return normalizeSql(a) === normalizeSql(b)
}

/** Shrink one execution result to a preview page. */
function shrink(result: ExecutionResult): ExecutionResult {
  if (!result.ok) return result
  return { ...result, rows: result.rows.slice(0, PREVIEW_ROWS), hasNextPage: true }
}

/** UTF-8 byte length; `TextEncoder` exists in both Node and the browser. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Keep a delivery under the spool ceiling.
 *
 * A 500-row page is normally well under the cap; this only triggers on very wide
 * rows. The grid then treats the payload as a first page and pages through
 * `fetch-page` like any other result, so nothing is silently lost.
 */
export function fitDelivery(delivery: AgentDelivery): AgentDelivery {
  // Bytes, not UTF-16 code units: a Chinese payload is ~3× the `.length`
  // figure, which used to let the cap be exceeded by that factor (review §15 A7).
  if (utf8Bytes(JSON.stringify(delivery)) <= MAX_DELIVERY_BYTES) return delivery
  if (delivery.kind === 'script') {
    const script = (delivery.script ?? []).map(statement =>
      statement.response === undefined ? statement : { ...statement, response: shrink({ ok: true, ...statement.response }) as ExecuteResponseLike },
    )
    return { ...delivery, script, previewRows: PREVIEW_ROWS }
  }
  if (delivery.single === undefined) return delivery
  const single = shrink(delivery.single)
  return { ...delivery, single, previewRows: PREVIEW_ROWS }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A result page with the shape `ResultGrid` can actually render. */
function isResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value['columns']) &&
    value['columns'].every(column => isRecord(column) && typeof column['name'] === 'string') &&
    Array.isArray(value['rows'])
  )
}

/** `ExecutionResult`: a refusal, or an `ok` page. */
function isExecutionResult(value: unknown): value is ExecutionResult {
  if (!isRecord(value)) return false
  if (value['ok'] === false) return isRecord(value['error'])
  return value['ok'] === true && isResponse(value)
}

/** One script statement. */
function isStatement(value: unknown): value is AgentStatementResult {
  if (!isRecord(value)) return false
  if (typeof value['index'] !== 'number' || typeof value['sql'] !== 'string' || typeof value['ok'] !== 'boolean') {
    return false
  }
  return value['ok'] === true ? isResponse(value['response']) : isRecord(value['error'])
}

/**
 * Validate an envelope read from the spool.
 *
 * The spool is written by our own process, but a half-written, stale or
 * hand-edited file must never crash the host — an unvalidated payload used to
 * flow straight into `ResultGrid` (review §15 A8), so every field the grid reads
 * is checked and `null` means "drop it".
 */
export function parseDelivery(raw: unknown): AgentDelivery | null {
  if (!isRecord(raw)) return null
  if (raw['schema'] !== AGENT_DELIVERY_SCHEMA) return null
  const id = raw['id']
  const label = raw['label']
  const connId = raw['connId']
  const sql = raw['sql']
  const kind = raw['kind']
  const at = raw['at']
  if (typeof id !== 'string' || typeof label !== 'string' || typeof connId !== 'string') return null
  if (typeof sql !== 'string' || typeof at !== 'string') return null
  if (kind !== 'single' && kind !== 'script') return null
  if (!isValidLabel(label)) return null
  const consoleId = typeof raw['consoleId'] === 'string' ? raw['consoleId'] : null
  const single = isExecutionResult(raw['single']) ? raw['single'] : undefined
  const script = Array.isArray(raw['script'])
    ? (raw['script'] as unknown[]).filter(isStatement)
    : undefined
  // The declared kind has to match the payload, or the panel renders nothing.
  if (kind === 'single' && single === undefined) return null
  if (kind === 'script' && (script === undefined || script.length === 0)) return null
  const previewRows = typeof raw['previewRows'] === 'number' ? raw['previewRows'] : undefined
  return {
    schema: AGENT_DELIVERY_SCHEMA,
    id,
    label,
    connId,
    consoleId,
    sql,
    kind,
    at,
    ...(single === undefined ? {} : { single }),
    ...(script === undefined ? {} : { script }),
    ...(previewRows === undefined ? {} : { previewRows }),
  }
}
