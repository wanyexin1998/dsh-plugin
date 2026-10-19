/**
 * Status-bar statistics for the result grid.
 *
 * DataGrip keeps an *aggregator widget* in the data-editor status bar: it runs
 * the selected function (`SUM` by default, switchable by clicking the widget)
 * over the selected range, and `Ctrl+Shift+C` copies that value. This module is
 * the arithmetic half — no DOM — so the numbers are testable on their own.
 *
 * Numbers are read from the *raw* row values, not from the formatted cells:
 * the grid inserts thousands separators, and `Number('1,234')` is `NaN`.
 */

import type { QueryField } from '../execute/core.ts'
import { type ColumnKind, columnKind, formatNumber } from './format.ts'

/** Functions the aggregator offers; the order is the menu order. */
export const AGGREGATES = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'DISTINCT'] as const

export type AggregateFn = typeof AGGREGATES[number]

/** Column kinds an aggregate makes sense for. */
export function isNumericKind(kind: ColumnKind): boolean {
  return kind === 'number'
}

/** First column (by index) that aggregates; `null` when the page has none. */
export function firstNumericColumn(columns: readonly QueryField[]): number | null {
  const index = columns.findIndex(column => isNumericKind(columnKind(column.typeName)))
  return index === -1 ? null : index
}

/**
 * Numeric samples of one column over a set of row indexes.
 *
 * NULL, empty strings and anything that does not parse to a finite number are
 * skipped — an average must not be dragged to zero by a blank.
 *
 * @param rows - Page rows, raw values as the driver returned them.
 * @param rowIndexes - Which rows to read (the selection, or the whole page).
 * @param column - Column offset.
 */
export function numericSamples(
  rows: readonly (readonly unknown[])[],
  rowIndexes: readonly number[],
  column: number,
): number[] {
  const samples: number[] = []
  for (const rowIndex of rowIndexes) {
    const value = rows[rowIndex]?.[column]
    if (value === null || value === undefined || value === '') continue
    const numeric = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(numeric)) samples.push(numeric)
  }
  return samples
}

/**
 * Apply one aggregate.
 *
 * @returns The value, or `null` when there is nothing to aggregate (`COUNT`
 *   included: an aggregate over an empty range has no answer to show).
 */
export function aggregate(samples: readonly number[], fn: AggregateFn): number | null {
  if (samples.length === 0) return null
  if (fn === 'COUNT') return samples.length
  if (fn === 'DISTINCT') return new Set(samples).size
  if (fn === 'MIN') return Math.min(...samples)
  if (fn === 'MAX') return Math.max(...samples)
  const total = samples.reduce((sum, value) => sum + value, 0)
  return fn === 'SUM' ? total : total / samples.length
}

/** Row indexes a selection covers, clamped to what the page actually has. */
export function rowsInBox(
  box: { readonly fromRow: number; readonly toRow: number } | null,
  total: number,
): number[] {
  if (box === null) return Array.from({ length: total }, (_value, index) => index)
  const from = Math.max(0, Math.min(box.fromRow, box.toRow))
  const to = Math.min(total - 1, Math.max(box.fromRow, box.toRow))
  const rows: number[] = []
  for (let row = from; row <= to; row += 1) rows.push(row)
  return rows
}

/** The status-bar sentence for the current selection. */
export function describeRange(
  box: { readonly fromRow: number; readonly toRow: number; readonly fromColumn: number; readonly toColumn: number } | null,
  totalRows: number,
  totalColumns: number,
): string {
  if (box === null) return `整页 ${String(totalRows)} 行 × ${String(totalColumns)} 列`
  const rows = Math.abs(box.toRow - box.fromRow) + 1
  const columns = Math.abs(box.toColumn - box.fromColumn) + 1
  return `选区 ${String(rows)} 行 × ${String(columns)} 列`
}

/** One status-bar figure: what it is called, what it adds up to. */
export interface StatReadout {
  readonly fn: AggregateFn
  readonly column: string | null
  readonly value: number | null
  /** `SUM(amount)`, or just the function when there is no numeric column. */
  readonly label: string
  /** The formatted value, or `—`. */
  readonly text: string
}

/**
 * Compute what the status bar shows.
 *
 * @param rows - Page rows.
 * @param columns - Column metadata.
 * @param rowIndexes - Rows in scope (selection, or the whole page).
 * @param columnIndex - Column to aggregate; `null` falls back to the first
 *   numeric column so the widget still answers something useful.
 * @param fn - Chosen aggregate.
 */
export function readStat(
  rows: readonly (readonly unknown[])[],
  columns: readonly QueryField[],
  rowIndexes: readonly number[],
  columnIndex: number | null,
  fn: AggregateFn,
): StatReadout {
  const target = columnIndex ?? firstNumericColumn(columns)
  if (target === null || columns[target] === undefined) {
    return { fn, column: null, value: null, label: fn, text: '—' }
  }
  const column = columns[target] as QueryField
  const value = aggregate(numericSamples(rows, rowIndexes, target), fn)
  return {
    fn,
    column: column.name,
    value,
    label: `${fn}(${column.name})`,
    text: value === null ? '—' : formatNumber(value),
  }
}

/**
 * Charset the result was decoded with.
 *
 * The driver hands us JavaScript strings, so the wire charset is already gone;
 * what the status bar can honestly report is the document encoding the panel
 * renders in. DataGrip shows the connection charset here — we cannot, and
 * pretending otherwise would be a lie in the UI.
 */
export function displayCharset(charset: string | undefined): string {
  return (charset ?? 'utf-8').toUpperCase()
}
