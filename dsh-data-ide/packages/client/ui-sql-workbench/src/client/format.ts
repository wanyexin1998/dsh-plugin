/**
 * Cell formatting for the result grid (docs/03 §6.5).
 *
 * The engine ships `typeName` (the driver's wire type name) precisely so the
 * grid can decide alignment and representation here instead of guessing from
 * the value: numbers get thousands separators and right alignment, dates render
 * as local `yyyy-mm-dd hh:mm:ss` (需求6), binary gets a size placeholder rather
 * than a megabyte of escapes.
 *
 * Pure functions with no React and no locale API, so the rendering is identical
 * on every host and directly testable.
 */

/** How a column is rendered; derived from the driver's wire type name. */
export type ColumnKind = 'number' | 'date' | 'time' | 'binary' | 'json' | 'text' | 'unknown'

// Driver wire names vary by server: MySQL-family reports TINY/SHORT/LONG/LONGLONG,
// Doris and MySQL 8 also report the SQL spellings (BIGINT, INT, …). Missing them
// meant BIGINT columns were left-aligned, ungrouped, and got a quoted literal in
// server-side filters.
const NUMBER_TYPES = new Set([
  'DECIMAL', 'NEWDECIMAL', 'NUMERIC',
  'TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'LARGEINT',
  'TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'INTEGER', 'BIGINT',
  'FLOAT', 'DOUBLE', 'REAL', 'YEAR',
])
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'TIMESTAMP', 'NEWDATE'])
const BINARY_TYPES = new Set(['TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BLOB', 'BIT', 'GEOMETRY', 'VECTOR'])
const TEXT_TYPES = new Set(['VARCHAR', 'VAR_STRING', 'STRING', 'ENUM', 'SET'])

/** Classify one column by its wire type name (unknown names degrade to text). */
export function columnKind(typeName: string): ColumnKind {
  const upper = typeName.toUpperCase()
  if (NUMBER_TYPES.has(upper)) return 'number'
  if (DATE_TYPES.has(upper)) return 'date'
  if (upper === 'TIME') return 'time'
  if (BINARY_TYPES.has(upper)) return 'binary'
  if (upper === 'JSON') return 'json'
  if (TEXT_TYPES.has(upper)) return 'text'
  return 'unknown'
}

/** One rendered cell. */
export interface CellView {
  readonly text: string
  readonly align: 'left' | 'right'
  /** Rendered as the weak `NULL` placeholder (docs/03 §6.5). */
  readonly isNull: boolean
}

/** Group the integer part with separators, keeping any fraction verbatim. */
function groupDigits(value: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value)
  if (match === null) return value
  const [, sign, whole, fraction] = match as unknown as [string, string, string, string | undefined]
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ?? ''}`
}

/**
 * Format a computed number for the status bar.
 *
 * Thousands separators like the cells, at most four decimals, and `-0` folded
 * into `0` so a sum of negatives does not read as `-0`.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const rounded = Math.abs(value) < 1e-12 ? 0 : Number(value.toFixed(4))
  return groupDigits(String(rounded))
}

/** Two-digit zero padding for month/day/hour/minute/second. */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/**
 * Local `yyyy-mm-dd hh:mm:ss` — the one time format the UI shows (需求6).
 *
 * Local, not UTC: a row reading `2026-10-17 08:12:33` means 8:12 on the user's
 * clock, which is what a person comparing it with their own actions expects.
 */
function formatLocalDateTime(date: Date): string {
  const day = `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * ISO date-*time* strings this module normalises.
 *
 * `2026-10-27T01:02:03`, `2026-10-27T01:02:03.000Z` and
 * `2026-10-27 01:02:03+08:00` all match; a **date-only** value deliberately does
 * not. `new Date('2026-10-27')` interprets the text as UTC, so normalising it
 * would flip the calendar day for users west of Greenwich — and the bare date is
 * already the shape everyone expects, so it passes through verbatim.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/

/** `2026-10-17 08:12:33` for dates, verbatim text otherwise. */
function formatDate(value: unknown): string {
  if (value instanceof Date) return formatLocalDateTime(value)
  if (typeof value === 'string' && ISO_DATE_TIME.test(value)) {
    const parsed = new Date(value)
    // An out-of-range component (`2026-13-45T99:99:99`) fails to parse; showing
    // the text as typed beats printing "Invalid Date".
    if (!Number.isNaN(parsed.getTime())) return formatLocalDateTime(parsed)
  }
  return String(value)
}

/** Byte sizes so a 1MB blob does not become a wall of base64. */
function describeBinary(value: unknown): string {
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} B>`
  return `<binary ${String(value).length} B>`
}

/**
 * Render one cell.
 *
 * @param value - Raw cell from the engine (already truncated at 1MB).
 * @param kind - Column classification from `columnKind`.
 */
export function formatCell(value: unknown, kind: ColumnKind): CellView {
  if (value === null || value === undefined) {
    return { text: 'NULL', align: kind === 'number' ? 'right' : 'left', isNull: true }
  }
  if (kind === 'number') return { text: groupDigits(String(value)), align: 'right', isNull: false }
  if (kind === 'date') return { text: formatDate(value), align: 'left', isNull: false }
  if (kind === 'binary') return { text: describeBinary(value), align: 'left', isNull: false }
  if (kind === 'json') return { text: typeof value === 'string' ? value : JSON.stringify(value), align: 'left', isNull: false }
  return { text: String(value), align: 'left', isNull: false }
}

/** What the value viewer shows for one cell. */
export interface FullValue {
  readonly text: string
  /** Characters (not bytes) of `text`; the honest unit for a JS string. */
  readonly chars: number
  /** Kind used for the label, so the dialog can say what it is looking at. */
  readonly kind: ColumnKind
}

/** Hex dump prefix for binary values, which have no readable form. */
const BINARY_PREVIEW_BYTES = 64

/** `0x0a1b…` for the first bytes of a blob, plus its total size. */
function binaryPreview(value: Uint8Array): string {
  const head = [...value.slice(0, BINARY_PREVIEW_BYTES)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join(' ')
  const more = value.byteLength > BINARY_PREVIEW_BYTES ? ' …' : ''
  return `${head}${more}\n\n<binary ${String(value.byteLength)} B>`
}

/**
 * The complete value of a cell, for the value viewer.
 *
 * The grid truncates with CSS and renders binary as a size placeholder; the
 * viewer is where you go to see the whole string. JSON is pretty-printed when
 * it parses, because that is the only reason to open a JSON cell.
 */
export function fullValue(value: unknown, kind: ColumnKind): FullValue {
  if (value === null || value === undefined) return { text: 'NULL', chars: 0, kind }
  if (value instanceof Uint8Array) {
    const text = binaryPreview(value)
    return { text, chars: text.length, kind }
  }
  if (value instanceof Date) {
    // Same local `yyyy-mm-dd hh:mm:ss` as the grid cell: the viewer must not
    // show a different (UTC) value than the cell the user clicked (需求6).
    const text = formatLocalDateTime(value)
    return { text, chars: text.length, kind }
  }
  if (kind === 'date' && typeof value === 'string') {
    const text = formatDate(value)
    return { text, chars: text.length, kind }
  }
  if (kind === 'json') {
    const source = typeof value === 'string' ? value : JSON.stringify(value)
    try {
      const pretty = JSON.stringify(JSON.parse(source), null, 2)
      return { text: pretty, chars: pretty.length, kind }
    } catch {
      const text = source
      return { text, chars: text.length, kind }
    }
  }
  const text = typeof value === 'string' ? value : String(value)
  return { text, chars: text.length, kind }
}
