/**
 * Cell formatting for the result grid (docs/03 §6.5).
 *
 * The engine ships `typeName` (the driver's wire type name) precisely so the
 * grid can decide alignment and representation here instead of guessing from
 * the value: numbers get thousands separators and right alignment, dates render
 * ISO-ish, binary gets a size placeholder rather than a megabyte of escapes.
 *
 * Pure functions with no React and no locale API, so the rendering is identical
 * on every host and directly testable.
 */

/** How a column is rendered; derived from the driver's wire type name. */
export type ColumnKind = 'number' | 'date' | 'time' | 'binary' | 'json' | 'text' | 'unknown'

const NUMBER_TYPES = new Set(['DECIMAL', 'NEWDECIMAL', 'TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'FLOAT', 'DOUBLE', 'YEAR'])
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

/** `2026-10-17 08:12:33` for dates, verbatim text otherwise. */
function formatDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ')
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
    const text = value.toISOString()
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
