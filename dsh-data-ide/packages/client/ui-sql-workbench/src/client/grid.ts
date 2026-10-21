/**
 * Result-grid data operations: filtering, selection and export.
 *
 * Kept as plain functions so the fiddly parts — index ranges, quoting, CRLF —
 * are testable without a DOM. The grid component owns the interaction state and
 * calls into these.
 */

import type { QueryField } from '../execute/core.ts'
import { columnKind, formatCell } from './format.ts'

/** One cell's rectangle in the current page. */
export interface GridSelection {
  readonly fromRow: number
  readonly fromColumn: number
  readonly toRow: number
  readonly toColumn: number
}

/** Inclusive bounds, normalised so a drag in any direction works. */
export function normalizeSelection(selection: GridSelection): GridSelection {
  return {
    fromRow: Math.min(selection.fromRow, selection.toRow),
    toRow: Math.max(selection.fromRow, selection.toRow),
    fromColumn: Math.min(selection.fromColumn, selection.toColumn),
    toColumn: Math.max(selection.fromColumn, selection.toColumn),
  }
}

/** True when the cell sits inside the selection. */
export function inSelection(selection: GridSelection, row: number, column: number): boolean {
  const box = normalizeSelection(selection)
  return row >= box.fromRow && row <= box.toRow && column >= box.fromColumn && column <= box.toColumn
}

/** Visible text of one cell, the same text the grid shows. */
export function cellText(row: readonly unknown[], column: QueryField, index: number): string {
  return formatCell(row[index], columnKind(column.typeName)).text
}

/** One cell as the grid renders it. */
export interface GridCell {
  readonly text: string
  readonly align: 'left' | 'right'
  readonly isNull: boolean
  /** Lower-cased text, kept for the page filter so it never re-lowercases per keystroke. */
  readonly lower: string
}

/**
 * Format the whole page once.
 *
 * Formatting is the expensive half of rendering (number grouping, dates,
 * binary); doing it per keystroke in the filter, and again per cell on every
 * render, is what made large pages feel heavy.
 *
 * @param rows - Page rows.
 * @param columns - Column metadata.
 */
export function formatRows(
  rows: readonly (readonly unknown[])[],
  columns: readonly QueryField[],
): readonly (readonly GridCell[])[] {
  return rows.map(row => columns.map((column, index) => {
    const cell = formatCell(row[index], columnKind(column.typeName))
    return { text: cell.text, align: cell.align, isNull: cell.isNull, lower: cell.text.toLowerCase() }
  }))
}

/** TSV of the selected rectangle, for the clipboard. */
export function selectionToTsv(
  rows: readonly (readonly unknown[])[],
  columns: readonly QueryField[],
  selection: GridSelection,
): string {
  const box = normalizeSelection(selection)
  const lines: string[] = []
  for (let row = box.fromRow; row <= box.toRow; row += 1) {
    const source = rows[row]
    if (source === undefined) continue
    const cells: string[] = []
    for (let column = box.fromColumn; column <= box.toColumn; column += 1) {
      const meta = columns[column]
      cells.push(meta === undefined ? '' : cellText(source, meta, column))
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/** Quote a CSV field per RFC 4180 when it needs it. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * CSV of the whole page, header included.
 *
 * @param columns - Column metadata (header labels).
 * @param rows - Rows to export, already filtered.
 */
export function toCsv(columns: readonly QueryField[], rows: readonly (readonly unknown[])[]): string {
  const header = columns.map(column => csvField(column.name)).join(',')
  const body = rows.map(row => columns.map((column, index) => csvField(cellText(row, column, index))).join(','))
  // CRLF: Excel on Windows is the common consumer of these files.
  return [header, ...body].join('\r\n')
}
