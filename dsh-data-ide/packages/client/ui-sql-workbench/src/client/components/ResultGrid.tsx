import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse, FilterOp, FilterSpec, QueryField, SortSpec } from '../../execute/core.ts'
import { copyText } from '../clipboard.ts'
import { columnKind, formatCell, fullValue } from '../format.ts'
import {
  type GridCell,
  type GridSelection,
  formatRows,
  inSelection,
  normalizeSelection,
  selectionToTsv,
  toCsv,
} from '../grid.ts'
import { RESULT_TABLE_PLACEHOLDER, columnList, insertSql, whereIn } from '../result-actions.ts'
import { errorSqlPrompt } from '../agent-prompts.ts'
import { ROW_HEIGHT, rowWindow, scrollTopForRow } from '../rowwindow.ts'
import { OverflowMenu } from './OverflowMenu.tsx'
import { AGGREGATES, type AggregateFn, describeRange, displayCharset, readStat, rowsInBox } from '../stats.ts'
import { classes as styles } from '../styles.ts'
import { toXlsx } from '../xlsx.ts'

export interface ResultGridProps {
  readonly result: ExecuteResponse | null
  readonly sort: SortSpec | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly running: boolean
  readonly onSort: (column: string) => void
  /** Server-side column filters, already applied to the current page. */
  readonly filters?: readonly FilterSpec[]
  /** Add / replace / remove one column's condition; the panel re-runs the query. */
  readonly onFilter?: (column: string, filter: FilterSpec | null) => void
  readonly onClearFilters?: () => void
  /**
   * Show the column-filter funnel.
   *
   * Script results turn it off: a multi-statement run keeps one result per
   * statement, so a filter would belong to a statement rather than a console.
   */
  readonly filterEnabled?: boolean
  /** Re-run whatever produced this page (DataGrip's refresh in the grid toolbar). */
  readonly onRefresh?: () => void
  /** Line the failure points at, when the driver gave one (SQL-310). */
  readonly errorLine?: number | null
  /** Jump the editor to the failing line and highlight it. */
  readonly onLocateLine?: (line: number) => void
  /** EXPLAIN the statement that failed, in a fresh plan console. */
  readonly onExplainError?: () => void
  /** Send the failure to the chat composer (SQL-405). */
  readonly onSendChat?: () => void
}

/** `aria-sort` for the current column (docs/03 §7). */
function ariaSort(sort: SortSpec | null, column: string): 'ascending' | 'descending' | 'none' {
  if (sort === null || sort.column !== column) return 'none'
  return sort.direction === 'ASC' ? 'ascending' : 'descending'
}

/** Column-filter operators, in the order the menu shows them. */
const FILTER_OPS: readonly { readonly op: FilterOp; readonly label: string }[] = [
  { op: 'contains', label: '包含' },
  { op: 'notContains', label: '不包含' },
  { op: 'eq', label: '等于' },
  { op: 'ne', label: '不等于' },
  { op: 'gt', label: '大于' },
  { op: 'ge', label: '大于等于' },
  { op: 'lt', label: '小于' },
  { op: 'le', label: '小于等于' },
  { op: 'isNull', label: '为空' },
  { op: 'notNull', label: '非空' },
]

const MIN_WIDTH = 60
/** Default width of a free-text column, before the user drags its handle. */
const DEFAULT_WIDTH = 160
/** Numbers are short: they do not need the room a text column does. */
const NUMBER_WIDTH = 120

/**
 * Default width for one column (SQL-7).
 *
 * Every column gets a concrete width so the table can be laid out with
 * `table-layout: fixed`: the browser then sizes columns from these numbers and
 * ignores their content, which is what stops a single 100KB cell from stretching
 * its row (or the whole grid) sideways.
 */
function defaultColumnWidth(column: QueryField): number {
  return columnKind(column.typeName) === 'number' ? NUMBER_WIDTH : DEFAULT_WIDTH
}

/**
 * Funnel glyph for the per-column filter button (SQL-8).
 *
 * Inline SVG rather than a font character: an emoji/dingbat renders at a
 * different size on every platform, and this button must stay `22px` in a
 * 300px-wide panel.
 */
function FilterIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 3h12l-4.4 5.1v4.2l-3.2 1.5V8.1L2 3z" fill="currentColor" />
    </svg>
  )
}

/**
 * The two ways a column filter can be expressed (DataGrip has the same split).
 *
 * `values` is the local value list — the default, because ticking the values you
 * can see is how people actually narrow a result; `condition` keeps the original
 * operator editor for ranges/NULL/LIKE.
 */
type FilterMode = 'values' | 'condition'

/** How many distinct values the value list keeps (a wide column can have 5000). */
const FILTER_VALUE_LIMIT = 200

/** One tickable row of the value list: display text, server literal, page count. */
interface FilterValueEntry {
  readonly text: string
  readonly literal: string
  readonly count: number
}

/** Sort glyph per state: unsorted, ascending, descending. */
const SORT_ICONS = { none: '⇅', ascending: '↑', descending: '↓' } as const


/** Trigger a client-side download of text or bytes. */
function download(name: string, content: string | Uint8Array, type: string): void {
  /* v8 ignore next -- download only exists in a browser */
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type })
  // Data URLs are the fallback where object URLs are unavailable (older WebViews).
  const url = typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    /* v8 ignore next -- data URLs only carry text; binary export needs object URLs */
    : `data:${type},${encodeURIComponent(typeof content === 'string' ? content : '')}`
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url)
}

/**
 * Result grid: sticky header, server-side sort and column filters, column
 * resizing, rectangle selection with TSV copy, CSV/TSV/XLSX export.
 *
 * Column filters are **server-side** (2026-10-20): they go into the WHERE of the
 * paging wrapper, so they act on the whole statement rather than the loaded
 * page — which is what DataGrip's column filter does, and the only reading of
 * "find this row" that makes sense when a page is 100–5000 rows.
 */
type ExportFormat = 'tsv' | 'csv' | 'xlsx' | 'insert' | 'json'

/** JSON-safe form of one driver value for the JSON export. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `0x${[...value].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function ResultGrid({
  result,
  sort,
  error,
  running,
  onSort,
  onRefresh,
  filters = [],
  onFilter,
  onClearFilters,
  filterEnabled = true,
  errorLine,
  onLocateLine,
  onExplainError,
  onSendChat,
}: ResultGridProps): ReactElement {
  const [format, setFormat] = React.useState<ExportFormat>('csv')
  const [openFilter, setOpenFilter] = React.useState<string | null>(null)
  /** Value list or condition editor — the funnel opens on the value list. */
  const [filterMode, setFilterMode] = React.useState<FilterMode>('values')
  /** Value-list search; filters the rendered list only, never the data. */
  const [valueSearch, setValueSearch] = React.useState('')
  /** Ticked values, keyed by the literal sent to the server (see FilterValueEntry). */
  const [checkedValues, setCheckedValues] = React.useState<ReadonlySet<string>>(new Set())
  /** Draft of the condition being edited; committed by 应用. */
  const [draftOp, setDraftOp] = React.useState<FilterOp>('contains')
  const [draftValue, setDraftValue] = React.useState('')
  const [widths, setWidths] = React.useState<Record<string, number>>({})
  const [selection, setSelection] = React.useState<GridSelection | null>(null)
  /** Status-bar aggregator, `SUM` like DataGrip's default. */
  const [aggregate, setAggregate] = React.useState<AggregateFn>('SUM')
  /** Windowed rendering inputs; the DOM only ever holds one screenful. */
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(0)
  const [viewer, setViewer] = React.useState<{ readonly row: number; readonly column: number } | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<HTMLDivElement | null>(null)
  /** Columns the user hid from the grid (B7). */
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set())
  const [columnMenu, setColumnMenu] = React.useState(false)
  /** Find-in-page state (B6); the scope is the currently loaded page only. */
  const [findOpen, setFindOpen] = React.useState(false)
  const [findQuery, setFindQuery] = React.useState('')
  const [findIndex, setFindIndex] = React.useState(0)

  // The viewer is focused so Escape reaches its own handler.
  React.useEffect(() => {
    if (viewer !== null) viewerRef.current?.focus()
  }, [viewer])

  // A filter reshuffles the rows, so a rectangle would point at different cells.
  const filterKey = filters
    .map(filter => `${filter.column}:${filter.op}:${filter.value ?? ''}:${filter.values?.join(',') ?? ''}`)
    .join('\u0000')
  const lastFilter = React.useRef(filterKey)
  if (lastFilter.current !== filterKey) {
    lastFilter.current = filterKey
    if (selection !== null) setSelection(null)
  }

  // Derived data is computed before any early return: hooks cannot be skipped.
  const columns = result?.columns ?? []
  const cells = React.useMemo(
    () => (result === null ? [] : formatRows(result.rows, columns)),
    [result, columns],
  )
  // The server already applied the filters; every row of the page is visible.
  const visibleIndexes = React.useMemo(() => cells.map((_row, index) => index), [cells])

  // Status-bar scope: the selection when there is one, otherwise the whole page
  // (after the page filter), which is what DataGrip's aggregator reports.
  const statRows = React.useMemo(
    () => (selection === null ? [...visibleIndexes] : rowsInBox(selection, cells.length)),
    [selection, visibleIndexes, cells.length],
  )
  const stat = React.useMemo(
    () => readStat(result?.rows ?? [], columns, statRows, selection === null ? null : selection.toColumn, aggregate),
    [result, columns, statRows, selection, aggregate],
  )
  const rangeText = React.useMemo(
    () => describeRange(selection, visibleIndexes.length, columns.length),
    [selection, visibleIndexes.length, columns.length],
  )
  const charset = displayCharset(document.characterSet)

  // Rows in the DOM: one window, not the whole page (see rowwindow.ts).
  const win = React.useMemo(
    () => rowWindow(visibleIndexes.length, scrollTop, viewportHeight),
    [visibleIndexes.length, scrollTop, viewportHeight],
  )

  /** Columns still visible after the B7 hide menu, with their original index. */
  const shownColumns = React.useMemo(
    () => columns.map((column, index) => ({ column, index })).filter(entry => !hidden.has(entry.column.name)),
    [columns, hidden],
  )

  /** Width of one shown column: the user's drag when there is one, else the default. */
  const columnWidth = (column: QueryField): number => widths[column.name] ?? defaultColumnWidth(column)
  /**
   * The table's width floor.
   *
   * `table-layout: fixed` keeps every column at its declared width; when their sum
   * exceeds the pane the table must grow and let `.gridScroll` scroll sideways,
   * instead of squeezing the other columns to nothing (SQL-7).
   */
  const gridWidth = shownColumns.reduce((total, entry) => total + columnWidth(entry.column), 0)

  /**
   * Column whose filter panel is open; `undefined` when closed.
   *
   * Derived from the *visible* columns so hiding the column also closes its
   * panel — a filter editor with no header to point at is a dead end.
   */
  const filterColumn = openFilter === null
    ? undefined
    : shownColumns.find(entry => entry.column.name === openFilter)?.column

  /**
   * Value list for the open column: one row per distinct value on the *loaded
   * page*, with its page count, sorted by count.
   *
   * Counts are page counts by design (DataGrip's local filter does the same and
   * says so): computing a true distinct-count would need a separate server
   * query per column, and the whole point of this popover is to be instant.
   * Numbers are shown formatted (`103,572`) but filtered with their raw literal.
   */
  const valueEntries = React.useMemo<readonly FilterValueEntry[]>(() => {
    if (filterColumn === undefined) return []
    const index = columns.indexOf(filterColumn)
    const numeric = columnKind(filterColumn.typeName) === 'number'
    const counts = new Map<string, { text: string; literal: string; count: number }>()
    for (const rowIndex of visibleIndexes) {
      const cell = (cells[rowIndex] as readonly GridCell[])[index] as GridCell
      // NULL is not a value to tick: IN ('NULL') would match the four-letter
      // string, not the absence of one. 为空 lives in the condition editor.
      if (cell.isNull) continue
      const literal = numeric ? cell.text.replace(/,/g, '') : cell.text
      const known = counts.get(cell.text)
      if (known === undefined) counts.set(cell.text, { text: cell.text, literal, count: 1 })
      else known.count += 1
    }
    return [...counts.values()]
      .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text))
      .slice(0, FILTER_VALUE_LIMIT)
  }, [filterColumn, columns, cells, visibleIndexes])

  /** Value list narrowed by the search box (display only — nothing is removed). */
  const valueNeedle = valueSearch.trim().toLowerCase()
  const visibleValues = valueNeedle === ''
    ? valueEntries
    : valueEntries.filter(entry => entry.text.toLowerCase().includes(valueNeedle))

  /** Cells matching the find query, in reading order (current page only). */
  const findMatches = React.useMemo(() => {
    const needle = findQuery.trim().toLowerCase()
    if (!findOpen || needle === '') return [] as { readonly row: number; readonly column: number }[]
    const matches: { row: number; column: number }[] = []
    for (const rowIndex of visibleIndexes) {
      const row = cells[rowIndex] as readonly GridCell[]
      for (const entry of shownColumns) {
        if ((row[entry.index] as GridCell).lower.includes(needle)) matches.push({ row: rowIndex, column: entry.index })
        if (matches.length >= 500) return matches
      }
    }
    return matches
  }, [findOpen, findQuery, cells, visibleIndexes, shownColumns])
  const findKeys = React.useMemo(
    () => new Set(findMatches.map(match => `${String(match.row)}:${String(match.column)}`)),
    [findMatches],
  )
  const currentMatch = findMatches[Math.min(findIndex, findMatches.length - 1)]

  // Measure once per result: the pane may have been collapsed when it arrived.
  React.useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    setViewportHeight(node.clientHeight)
  }, [result])

  // A new result invalidates the page filter and the selection.
  const resultKey = result === null ? 'none' : `${result.statementId}:${result.offset}:${result.total ?? 'null'}`
  const lastKey = React.useRef(resultKey)
  if (lastKey.current !== resultKey) {
    lastKey.current = resultKey
    if (selection !== null) setSelection(null)
    // The dialog points at a row of the old page; drop it with the page.
    if (viewer !== null) setViewer(null)
  }

  if (error !== null) {
    return (
      <div className={styles.grid} role="alert" data-grid-state="error">
        <div className={styles.gridError}>
          <strong>{error.code}</strong>
          <span>{error.message}</span>
          <div className={styles.gridErrorActions}>
            <button
              type="button"
              className={styles.button}
              aria-label="复制错误"
              onClick={() => {
                copyText(`${error.code}: ${error.message}`)
              }}
            >
              复制错误
            </button>
            {errorLine === undefined || errorLine === null || onLocateLine === undefined ? null : (
              <button
                type="button"
                className={styles.button}
                aria-label="定位错误行"
                onClick={() => {
                  onLocateLine(errorLine)
                }}
              >
                定位到第 {errorLine} 行
              </button>
            )}
            {onExplainError === undefined ? null : (
              <button type="button" className={styles.button} aria-label="解释错误语句" onClick={onExplainError}>
                EXPLAIN
              </button>
            )}
            {onSendChat === undefined ? null : (
              <button type="button" className={styles.button} aria-label="发到聊天框" onClick={onSendChat}>
                发到聊天
              </button>
            )}
            <button
              type="button"
              className={styles.button}
              aria-label="问 agent 这个错误"
              title="复制一段带错误信息的提问到剪贴板"
              onClick={() => {
                copyText(errorSqlPrompt(error))
              }}
            >
              问 agent
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (result === null) {
    return (
      <div className={styles.grid} data-grid-state={running ? 'loading' : 'empty'}>
        <div className={styles.gridPlaceholder}>
          {running ? '正在执行…' : '执行查询查看结果（Ctrl/Cmd+Enter）'}
        </div>
      </div>
    )
  }

  // Zero rows with a filter must still render the toolbar: otherwise "no match"
  // is a dead end with no way to clear the condition that caused it.
  if (result.rows.length === 0 && filters.length === 0) {
    return (
      <div className={styles.grid} data-grid-state="empty">
        <div className={styles.gridPlaceholder}>查询成功，没有返回行</div>
      </div>
    )
  }

  const filtering = filters.length > 0
  /** The condition editor hides the value box for the two NULL operators. */
  const conditionNeedsValue = draftOp !== 'isNull' && draftOp !== 'notNull'

  /** Commit the draft condition for the column whose header opened the editor. */
  const apply = (column: QueryField): void => {
    onFilter?.(column.name, {
      column: column.name,
      op: draftOp,
      ...(conditionNeedsValue ? { value: draftValue } : {}),
      ...(columnKind(column.typeName) === 'number' ? { numeric: true } : {}),
    })
    setOpenFilter(null)
  }

  /**
   * Open (or close) the filter panel for one column.
   *
   * The mode follows the filter already on the column: an `in` list reopens as
   * the value list with its ticks restored, an operator filter reopens as the
   * condition editor. A column with no filter opens on the value list, which is
   * the common case.
   */
  const openColumnFilter = (column: QueryField): void => {
    if (openFilter === column.name) {
      setOpenFilter(null)
      return
    }
    const existing = filters.find(filter => filter.column === column.name)
    const list = existing?.op === 'in'
    setFilterMode(existing !== undefined && !list ? 'condition' : 'values')
    setValueSearch('')
    setCheckedValues(new Set(list ? existing.values ?? [] : []))
    setDraftOp(list || existing === undefined ? 'contains' : existing.op)
    setDraftValue(existing?.value ?? '')
    setOpenFilter(column.name)
  }

  /** Tick / untick one value in the list. */
  const toggleValue = (literal: string): void => {
    setCheckedValues(current => {
      const next = new Set(current)
      if (next.has(literal)) next.delete(literal)
      else next.add(literal)
      return next
    })
  }

  /** Commit the ticked values as a server-side IN filter. */
  const applyValues = (column: QueryField): void => {
    onFilter?.(column.name, {
      column: column.name,
      op: 'in',
      values: [...checkedValues],
      ...(columnKind(column.typeName) === 'number' ? { numeric: true } : {}),
    })
    setOpenFilter(null)
  }

  /** Start a column resize drag. */
  const startResize = (name: string, event: React.MouseEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[name] ?? DEFAULT_WIDTH
    const move = (moveEvent: MouseEvent): void => {
      const next = Math.max(MIN_WIDTH, startWidth + (moveEvent.clientX - startX))
      setWidths(current => ({ ...current, [name]: next }))
    }
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }

  /** Export the visible page in the chosen format. */
  const exportPage = (): void => {
    /* v8 ignore next -- the toolbar only renders with a result */
    if (result === null) return
    const shown = shownColumns.map(entry => entry.column)
    const rows = visibleIndexes.map(index => cells[index] as readonly GridCell[])
    if (format === 'xlsx') {
      const bytes = toXlsx({
        name: 'query-result',
        columns: shown.map(column => column.name),
        rows: rows.map(row => shownColumns.map(entry => (row[entry.index] as GridCell).text)),
      })
      download('query-result.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      return
    }
    if (format === 'insert') {
      const text = insertSql(RESULT_TABLE_PLACEHOLDER, shown, rawRowsFor(shownColumns.map(entry => entry.index)))
      download('query-result.sql', `\uFEFF${text}\n`, 'text/plain;charset=utf-8')
      return
    }
    if (format === 'json') {
      const objects = visibleIndexes.map(index => Object.fromEntries(
        shownColumns.map(entry => [entry.column.name, jsonSafe(result.rows[index]?.[entry.index])]),
      ))
      download('query-result.json', JSON.stringify(objects, null, 2), 'application/json;charset=utf-8')
      return
    }
    const text = format === 'tsv'
      ? rows.map(row => shownColumns.map(entry => (row[entry.index] as GridCell).text).join('\t')).join('\n')
      : toCsv(shown, rows.map(row => shownColumns.map(entry => (row[entry.index] as GridCell).text)))
    // BOM keeps Excel from mangling UTF-8 in CSV/TSV.
    download(`query-result.${format}`, `\uFEFF${text}`, `text/${format};charset=utf-8`)
  }

  /** Raw values for the shown columns, in page order (exports/copy-as-SQL). */
  const rawRowsFor = (indexes: readonly number[]): readonly (readonly unknown[])[] => {
    /* v8 ignore next -- export only renders with a result */
    if (result === null) return []
    return visibleIndexes.map(rowIndex => indexes.map(columnIndex => result.rows[rowIndex]?.[columnIndex]))
  }

  const copySelection = (): void => {
    if (selection === null) return
    copyText(selectionToTsv(result.rows, columns, selection))
  }

  /** Hide/show one column; the last visible column cannot be hidden (B7). */
  const toggleColumn = (name: string): void => {
    setHidden(current => {
      if (!current.has(name)) {
        if (columns.length - current.size <= 1) return current
        const next = new Set(current)
        next.add(name)
        return next
      }
      const next = new Set(current)
      next.delete(name)
      return next
    })
  }

  /** Move the find cursor and scroll that cell into view (B6). */
  const stepFind = (delta: number): void => {
    if (findMatches.length === 0) return
    const next = (findIndex + delta + findMatches.length) % findMatches.length
    setFindIndex(next)
    const match = findMatches[next]
    const node = scrollRef.current
    /* v8 ignore next -- a match implies a rendered grid */
    if (match === undefined || node === null) return
    const top = scrollTopForRow(match.row, node.scrollTop, node.clientHeight)
    if (top !== node.scrollTop) node.scrollTop = top
  }

  /** Copy the selected column's values as a `WHERE … IN (…)` clause (SQL-402). */
  const copyInList = (): void => {
    /* v8 ignore next -- the button is disabled without a selection */
    if (selection === null) return
    const box = normalizeSelection(selection)
    const column = columns[box.fromColumn]
    /* v8 ignore next -- the button only renders for a selection inside the grid */
    if (column === undefined) return
    const outcome = whereIn(rawRowsFor([box.fromColumn]).slice(box.fromRow, box.toRow + 1), 0, column.name)
    copyText(outcome.truncated ? `${outcome.sql} /* 仅复制前 ${String(outcome.count)} 个值 */` : outcome.sql)
  }

  /** Copy the selected block as an INSERT skeleton (SQL-402). */
  const copyInsert = (): void => {
    /* v8 ignore next -- the button is disabled without a selection */
    if (selection === null) return
    const box = normalizeSelection(selection)
    const indexes: number[] = []
    for (let index = box.fromColumn; index <= box.toColumn; index += 1) indexes.push(index)
    const shown = indexes.map(index => columns[index]).filter((column): column is QueryField => column !== undefined)
    copyText(insertSql(RESULT_TABLE_PLACEHOLDER, shown, rawRowsFor(indexes).slice(box.fromRow, box.toRow + 1)))
  }

  const rowCount = running
    ? '执行中…'
    : filtering
      ? `${String(result.rows.length)} 行（已筛选）`
      : `${String(result.rows.length)} 行`

  return (
    <div className={styles.grid} data-grid-state={running ? 'loading' : 'ready'}>
      {columnMenu ? (
        <div className={styles.columnMenu} data-grid-column-menu="">
          <span className={styles.columnMenuTitle}>显示列</span>
          {columns.map(column => (
            <label key={column.name} className={styles.columnMenuItem}>
              <input
                type="checkbox"
                checked={!hidden.has(column.name)}
                aria-label={`显示列 ${column.name}`}
                onChange={() => {
                  toggleColumn(column.name)
                }}
              />
              {column.name}
            </label>
          ))}
          <div className={styles.columnMenuActions}>
            <button
              type="button"
              className={styles.button}
              aria-label="重置列"
              onClick={() => {
                setHidden(new Set())
              }}
            >
              重置
            </button>
            <button
              type="button"
              className={styles.button}
              aria-label="复制列名"
              onClick={() => {
                copyText(columnList(columns))
              }}
            >
              复制列名
            </button>
          </div>
        </div>
      ) : null}
      {findOpen ? (
        <div className={styles.gridFindBar} data-grid-find-bar="">
          <input
            autoFocus
            className={styles.gridFindInput}
            aria-label="查找输入"
            placeholder="查找本页…"
            value={findQuery}
            onChange={event => {
              setFindQuery(event.target.value)
              setFindIndex(0)
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') setFindOpen(false)
              if (event.key === 'Enter') {
                event.preventDefault()
                stepFind(event.shiftKey ? -1 : 1)
              }
            }}
          />
          <span className={styles.gridFindCount} data-grid-find-count="">
            {findMatches.length === 0 ? '0/0' : `${String(findIndex + 1)}/${String(findMatches.length)}`}
          </span>
          <button type="button" className={styles.button} aria-label="上一个匹配" onClick={() => { stepFind(-1) }}>
            ↑
          </button>
          <button type="button" className={styles.button} aria-label="下一个匹配" onClick={() => { stepFind(1) }}>
            ↓
          </button>
          <span className={styles.gridFindScope}>仅当前页</span>
          <button type="button" className={styles.button} aria-label="关闭查找" onClick={() => { setFindOpen(false) }}>
            ×
          </button>
        </div>
      ) : null}
      {filterColumn === undefined ? null : (
        <div className={styles.filterPanel} data-sql-filter-editor="" data-filter-mode={filterMode}>
          <div className={styles.filterPanelHead}>
            <span className={styles.filterEditorColumn}>{filterColumn.name}</span>
            <div className={styles.filterModes} role="group" aria-label="筛选模式">
              <button
                type="button"
                className={filterMode === 'values' ? styles.filterModeActive : styles.filterMode}
                aria-label="筛选模式 值列表"
                aria-pressed={filterMode === 'values'}
                onClick={() => {
                  setFilterMode('values')
                }}
              >
                值列表
              </button>
              <button
                type="button"
                className={filterMode === 'condition' ? styles.filterModeActive : styles.filterMode}
                aria-label="筛选模式 条件"
                aria-pressed={filterMode === 'condition'}
                onClick={() => {
                  setFilterMode('condition')
                }}
              >
                条件
              </button>
            </div>
            <span className={styles.filterHint}>本页计数 · 应用后服务端筛选</span>
          </div>
          {filterMode === 'values' ? (
            <>
              <input
                autoFocus
                className={styles.filterSearch}
                aria-label={`搜索值 ${filterColumn.name}`}
                placeholder="搜索本页的值"
                value={valueSearch}
                onChange={event => {
                  setValueSearch(event.target.value)
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape') setOpenFilter(null)
                }}
              />
              <div className={styles.filterValueList} data-filter-value-list="">
                {visibleValues.length === 0 ? (
                  <span className={styles.filterEmpty}>本页没有可选值</span>
                ) : (
                  visibleValues.map(entry => (
                    <label key={entry.text} className={styles.filterValueItem} title={entry.text}>
                      <input
                        type="checkbox"
                        aria-label={`值 ${entry.text}`}
                        checked={checkedValues.has(entry.literal)}
                        onChange={() => {
                          toggleValue(entry.literal)
                        }}
                      />
                      <span className={styles.filterValueText}>{entry.text}</span>
                      <span className={styles.filterValueCount} data-filter-value-count="">{entry.count}</span>
                    </label>
                  ))
                )}
              </div>
              <div className={styles.filterActions}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  aria-label="应用筛选"
                  onClick={() => {
                    applyValues(filterColumn)
                  }}
                >
                  应用
                </button>
                <button
                  type="button"
                  className={styles.button}
                  aria-label="取消筛选"
                  onClick={() => {
                    setOpenFilter(null)
                  }}
                >
                  取消
                </button>
                {filters.some(filter => filter.column === filterColumn.name) ? (
                  <button
                    type="button"
                    className={styles.button}
                    aria-label="移除该列筛选"
                    onClick={() => {
                      onFilter?.(filterColumn.name, null)
                      setOpenFilter(null)
                    }}
                  >
                    移除
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className={styles.filterCondition}>
              <select
                className={styles.filterOp}
                aria-label="筛选条件"
                value={draftOp}
                onChange={event => {
                  setDraftOp(event.target.value as FilterOp)
                }}
              >
                {FILTER_OPS.map(option => (
                  <option key={option.op} value={option.op}>
                    {option.label}
                  </option>
                ))}
              </select>
              {conditionNeedsValue ? (
                <input
                  autoFocus
                  className={styles.filterInput}
                  value={draftValue}
                  placeholder="值"
                  aria-label={`筛选值 ${filterColumn.name}`}
                  onChange={event => {
                    setDraftValue(event.target.value)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Escape') setOpenFilter(null)
                    if (event.key === 'Enter') apply(filterColumn)
                  }}
                />
              ) : null}
              <button
                type="button"
                className={styles.primaryButton}
                aria-label="应用筛选"
                onClick={() => {
                  apply(filterColumn)
                }}
              >
                应用
              </button>
              <button
                type="button"
                className={styles.button}
                aria-label="取消筛选"
                onClick={() => {
                  setOpenFilter(null)
                }}
              >
                取消
              </button>
              {filters.some(filter => filter.column === filterColumn.name) ? (
                <button
                  type="button"
                  className={styles.button}
                  aria-label="移除该列筛选"
                  onClick={() => {
                    onFilter?.(filterColumn.name, null)
                    setOpenFilter(null)
                  }}
                >
                  移除
                </button>
              ) : null}
            </div>
          )}
        </div>
      )}
      <div
        className={styles.gridScroll}
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label="查询结果"
        onScroll={event => {
          const node = event.currentTarget
          setScrollTop(node.scrollTop)
          if (node.clientHeight !== viewportHeight) setViewportHeight(node.clientHeight)
        }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
            event.preventDefault()
            setFindOpen(true)
            setFindIndex(0)
            return
          }
          if (event.key === 'Escape') {
            if (findOpen) {
              event.preventDefault()
              setFindOpen(false)
              return
            }
            if (openFilter !== null) {
              event.preventDefault()
              setOpenFilter(null)
              return
            }
            if (columnMenu) {
              event.preventDefault()
              setColumnMenu(false)
              return
            }
            if (viewer !== null) {
              event.preventDefault()
              setViewer(null)
            }
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
            event.preventDefault()
            setSelection({ fromRow: 0, fromColumn: 0, toRow: visibleIndexes.length - 1, toColumn: columns.length - 1 })
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
            event.preventDefault()
            // DataGrip copies the aggregation with Ctrl+Shift+C, the cells with Ctrl+C.
            if (event.shiftKey) {
              if (stat.value !== null) copyText(String(stat.value))
            } else {
              copySelection()
            }
            return
          }
          // Value viewer, DataGrip's Shift+Enter.
          if (event.key === 'Enter' && event.shiftKey && selection !== null) {
            event.preventDefault()
            setViewer({ row: selection.toRow, column: selection.toColumn })
            return
          }
          const step: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
          }
          const delta = step[event.key]
          if (delta === undefined) return
          event.preventDefault()
          // Start at the top-left cell when nothing is selected yet.
          const base = selection ?? { fromRow: 0, fromColumn: 0, toRow: 0, toColumn: 0 }
          const row = Math.min(Math.max(0, base.toRow + delta[0]), visibleIndexes.length - 1)
          const column = Math.min(Math.max(0, base.toColumn + delta[1]), columns.length - 1)
          // Shift extends the rectangle from its anchor; a bare arrow collapses it.
          setSelection(
            event.shiftKey && selection !== null
              ? { fromRow: selection.fromRow, fromColumn: selection.fromColumn, toRow: row, toColumn: column }
              : { fromRow: row, fromColumn: column, toRow: row, toColumn: column },
          )
          // Keep the walk visible: a windowed grid would otherwise leave the
          // selection off-screen with nothing scrolled.
          const node = scrollRef.current
          if (node !== null) {
            const next = scrollTopForRow(row, node.scrollTop, node.clientHeight)
            if (next !== node.scrollTop) node.scrollTop = next
          }
        }}
      >
        <table className={styles.table} style={{ minWidth: `${String(gridWidth)}px` }}>
          <colgroup>
            {shownColumns.map(entry => (
              <col key={entry.column.name} style={{ width: `${String(columnWidth(entry.column))}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {shownColumns.map(entry => {
                const column = entry.column
                const direction = ariaSort(sort, column.name)
                const active = filters.some(filter => filter.column === column.name)
                return (
                  <th key={column.name} aria-sort={direction} data-sort={direction}>
                    {/* Sort first in the DOM (panel tests locate sorting with
                        `th button`), but the funnel is first *visually*: CSS
                        `order` swaps them inside the flex header cell. */}
                    <div className={styles.tableHeadCell}>
                      <button
                        type="button"
                        className={styles.sortHeader}
                        title="点击切换排序：升序 → 降序 → 取消"
                        onClick={() => { onSort(column.name) }}
                      >
                        <span className={styles.sortLabel}>{column.name}</span>
                        <span
                          className={direction === 'none' ? styles.sortIcon : `${styles.sortIcon} ${styles.sortIconActive}`}
                          data-sort-icon={direction}
                          aria-hidden="true"
                        >
                          {SORT_ICONS[direction]}
                        </span>
                      </button>
                      {filterEnabled ? (
                        <button
                          type="button"
                          className={active ? styles.filterButtonActive : styles.filterButton}
                          data-grid-filter=""
                          data-grid-filter-column={column.name}
                          aria-label={`筛选 ${column.name}`}
                          aria-pressed={active}
                          title="筛选该列"
                          onClick={() => { openColumnFilter(column) }}
                        >
                          <FilterIcon />
                        </button>
                      ) : null}
                    </div>
                    <span
                      className={styles.resizeHandle}
                      role="separator"
                      aria-label={`调整 ${column.name} 列宽`}
                      onMouseDown={event => { startResize(column.name, event) }}
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {visibleIndexes.length === 0 ? (
              <tr>
                <td className={styles.gridPlaceholder} colSpan={shownColumns.length}>
                  没有匹配的行
                </td>
              </tr>
            ) : null}
            {win.topPad > 0 ? (
              <tr aria-hidden="true" data-window-pad="top">
                <td colSpan={shownColumns.length} style={{ height: win.topPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {visibleIndexes.slice(win.start, win.end).map(sourceIndex => (
              <tr key={sourceIndex} style={{ height: ROW_HEIGHT }}>
                {shownColumns.map(entry => {
                  const columnIndex = entry.index
                  const column = entry.column
                  const cell = cells[sourceIndex]?.[columnIndex] as GridCell
                  const selected = selection !== null && inSelection(selection, sourceIndex, columnIndex)
                  const match = findKeys.has(`${String(sourceIndex)}:${String(columnIndex)}`)
                  const current = currentMatch !== undefined && currentMatch.row === sourceIndex && currentMatch.column === columnIndex
                  return (
                    <td
                      key={column.name}
                      data-align={cell.align}
                      data-null={cell.isNull ? '' : undefined}
                      data-selected={selected ? '' : undefined}
                      data-find-hit={match ? '' : undefined}
                      data-find-current={current ? '' : undefined}
                      title={cell.text}
                      onMouseDown={() => {
                        setSelection({ fromRow: sourceIndex, fromColumn: columnIndex, toRow: sourceIndex, toColumn: columnIndex })
                      }}
                      onDoubleClick={() => {
                        setViewer({ row: sourceIndex, column: columnIndex })
                      }}
                      onMouseOver={event => {
                        if (event.buttons !== 1 || selection === null) return
                        const next = normalizeSelection({ ...selection, toRow: sourceIndex, toColumn: columnIndex })
                        // Hover fires per cell; skip the re-render when nothing moved.
                        if (next.toRow === selection.toRow && next.toColumn === selection.toColumn) return
                        setSelection(next)
                      }}
                    >
                      {cell.text}
                    </td>
                  )
                })}
              </tr>
            ))}
            {win.bottomPad > 0 ? (
              <tr aria-hidden="true" data-window-pad="bottom">
                <td colSpan={shownColumns.length} style={{ height: win.bottomPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* One foot: counts, aggregator, and the actions that used to be a second toolbar. */}
      <div className={styles.gridFoot}>
      <div className={styles.gridStatus} data-grid-status="">
        <span className={styles.gridCount} data-grid-count="">
          {rowCount}
        </span>
        {filtering && onClearFilters !== undefined ? (
          <button type="button" className={styles.button} onClick={onClearFilters} aria-label="清除筛选">
            清除筛选（{filters.length}）
          </button>
        ) : null}
        <span className={styles.gridScope} data-grid-range="">
          {rangeText}
        </span>
        <select
          className={styles.aggregateSelect}
          value={aggregate}
          aria-label="聚合函数"
          onChange={event => {
            setAggregate(event.target.value as AggregateFn)
          }}
        >
          {AGGREGATES.map(name => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {/* The readout is the button: DataGrip has no separate copy control
            (Ctrl+Shift+C does it), and a 300px panel has no room for one. */}
        <button
          type="button"
          className={styles.gridStat}
          data-grid-stat=""
          title={stat.value === null ? stat.label : `${stat.label} = ${stat.text}（点击复制）`}
          disabled={stat.value === null}
          onClick={() => {
            /* v8 ignore next -- the control is disabled without a value */
            if (stat.value === null) return
            copyText(String(stat.value))
          }}
          aria-label="复制聚合结果"
        >
          {stat.fn} = {stat.text}
        </button>
        <span className={styles.gridCharset} data-grid-charset="" title="面板渲染编码">
          {charset}
        </span>
      </div>
      <OverflowMenu label="更多" ariaLabel="更多结果操作">
          <button
            type="button"
            className={styles.button}
            disabled={selection === null}
            onClick={copySelection}
            aria-label="复制选区"
          >
            复制
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={selection === null}
            onClick={copyInList}
            aria-label="复制 IN 列表"
            title="把选中列的值复制为 WHERE … IN (…)"
          >
            IN
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={selection === null}
            onClick={copyInsert}
            aria-label="复制 INSERT"
            title="把选中区域复制为 INSERT 骨架"
          >
            INSERT
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setColumnMenu(current => !current)
            }}
            aria-label="列"
            aria-expanded={columnMenu}
            title="显示/隐藏列"
          >
            列
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setFindOpen(true)
              setFindIndex(0)
            }}
            aria-label="查找结果"
            title="在当前页查找（Ctrl/Cmd+F）"
          >
            查找
          </button>
          {onRefresh === undefined ? null : (
            <button type="button" className={styles.button} onClick={onRefresh} disabled={running} aria-label="刷新结果">
              刷新
            </button>
          )}
          <select
            className={styles.exportFormat}
            value={format}
            aria-label="导出格式"
            onChange={event => {
              setFormat(event.target.value as ExportFormat)
            }}
          >
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="xlsx">XLSX</option>
            <option value="insert">INSERT</option>
            <option value="json">JSON</option>
          </select>
          <button type="button" className={styles.button} onClick={exportPage} aria-label="导出">
            导出
          </button>
      </OverflowMenu>
      </div>

      {viewer === null ? null : (
        <div
          ref={viewerRef}
          tabIndex={-1}
          className={styles.valueViewer}
          role="dialog"
          aria-label="值查看器"
          data-value-viewer=""
          onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            setViewer(null)
          }}
        >
          {(() => {
            // The viewer only opens on a rendered cell, so both indexes exist.
            const column = columns[viewer.column] as QueryField
            const value = (result.rows[viewer.row] as readonly unknown[])[viewer.column]
            const full = fullValue(value, columnKind(column.typeName))
            return (
              <>
                <div className={styles.valueViewerHead}>
                  <span className={styles.valueViewerTitle}>
                    {column.name} · 行 {viewer.row + 1} · {full.chars} 字符
                  </span>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      copyText(full.text)
                    }}
                    aria-label="复制值"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setViewer(null)
                    }}
                    aria-label="关闭值查看器"
                  >
                    关闭
                  </button>
                </div>
                <pre className={styles.valueViewerBody} data-value-text="">
                  {full.text}
                </pre>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
