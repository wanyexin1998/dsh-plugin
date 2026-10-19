import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse, QueryField, SortSpec } from '../../execute/core.ts'
import { copyText } from '../clipboard.ts'
import { columnKind, formatCell, fullValue } from '../format.ts'
import {
  type GridCell,
  type GridSelection,
  filterIndexes,
  formatRows,
  inSelection,
  normalizeSelection,
  selectionToTsv,
  toCsv,
} from '../grid.ts'
import { ROW_HEIGHT, rowWindow, scrollTopForRow } from '../rowwindow.ts'
import { AGGREGATES, type AggregateFn, describeRange, displayCharset, readStat, rowsInBox } from '../stats.ts'
import { classes as styles } from '../styles.ts'
import { toXlsx } from '../xlsx.ts'

export interface ResultGridProps {
  readonly result: ExecuteResponse | null
  readonly sort: SortSpec | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly running: boolean
  readonly onSort: (column: string) => void
  /** Re-run whatever produced this page (DataGrip's refresh in the grid toolbar). */
  readonly onRefresh?: () => void
}

/** `aria-sort` for the current column (docs/03 §7). */
function ariaSort(sort: SortSpec | null, column: string): 'ascending' | 'descending' | 'none' {
  if (sort === null || sort.column !== column) return 'none'
  return sort.direction === 'ASC' ? 'ascending' : 'descending'
}

const MIN_WIDTH = 60
const DEFAULT_WIDTH = 160

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
 * Result grid: sticky header, server-side sort, per-column page filter, column
 * resizing, rectangle selection with TSV copy, and CSV export.
 *
 * Filtering covers the loaded page, not the whole table: a server-side filter
 * would need a WHERE wrapper and could silently disagree with paging, so the
 * toolbar says 本页 and the boundary stays visible.
 */
type ExportFormat = 'tsv' | 'csv' | 'xlsx'

export function ResultGrid({ result, sort, error, running, onSort, onRefresh }: ResultGridProps): ReactElement {
  const [format, setFormat] = React.useState<ExportFormat>('csv')
  const [filters, setFilters] = React.useState<Record<string, string>>({})
  const [openFilter, setOpenFilter] = React.useState<string | null>(null)
  const [widths, setWidths] = React.useState<Record<string, number>>({})
  const [selection, setSelection] = React.useState<GridSelection | null>(null)
  /** Status-bar aggregator, `SUM` like DataGrip's default. */
  const [aggregate, setAggregate] = React.useState<AggregateFn>('SUM')
  /** Windowed rendering inputs; the DOM only ever holds one screenful. */
  const [scrollTop, setScrollTop] = React.useState(0)
  const [viewportHeight, setViewportHeight] = React.useState(0)
  const [viewer, setViewer] = React.useState<{ readonly row: number; readonly column: number } | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)

  // A filter reshuffles the rows, so a rectangle would point at different cells.
  const filterKey = Object.values(filters).join('\u0000')
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
  const visibleIndexes = React.useMemo(() => filterIndexes(cells, columns, filters), [cells, columns, filters])

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
    if (Object.keys(filters).length > 0) setFilters({})
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
        </div>
      </div>
    )
  }

  if (result === null) {
    return (
      <div className={styles.grid} data-grid-state={running ? 'loading' : 'empty'}>
        <div className={styles.gridPlaceholder}>{running ? '正在执行…' : '执行查询查看结果'}</div>
      </div>
    )
  }

  if (result.rows.length === 0) {
    return (
      <div className={styles.grid} data-grid-state="empty">
        <div className={styles.gridPlaceholder}>查询成功，没有返回行</div>
      </div>
    )
  }

  const filtering = Object.values(filters).some(value => value.trim() !== '')

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
    const rows = visibleIndexes.map(index => cells[index] as readonly GridCell[])
    if (format === 'xlsx') {
      const bytes = toXlsx({
        name: 'query-result',
        columns: columns.map(column => column.name),
        rows: rows.map(row => row.map(cell => cell.text)),
      })
      download('query-result.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      return
    }
    const text = format === 'tsv'
      ? rows.map(row => row.map(cell => cell.text).join('\t')).join('\n')
      : toCsv(columns, rows.map(row => row.map(cell => cell.text)))
    // BOM keeps Excel from mangling UTF-8 in CSV/TSV.
    download(`query-result.${format}`, `\uFEFF${text}`, `text/${format};charset=utf-8`)
  }

  const copySelection = (): void => {
    if (selection === null) return
    copyText(selectionToTsv(result.rows, columns, selection))
  }

  return (
    <div className={styles.grid} data-grid-state={running ? 'loading' : 'ready'}>
      <div className={styles.gridBar}>
        <span className={styles.gridCount} data-grid-count="">
          {running
            ? '执行中…'
            : filtering
              ? `筛选 ${String(visibleIndexes.length)}/${String(result.rows.length)} 行`
              : `${String(result.rows.length)} 行`}
        </span>
        {filtering ? (
          <button type="button" className={styles.button} onClick={() => { setFilters({}) }} aria-label="清除筛选">
            清除筛选
          </button>
        ) : null}
        <button
          type="button"
          className={styles.button}
          disabled={selection === null}
          onClick={copySelection}
          aria-label="复制选区"
        >
          复制
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
        </select>
        <button type="button" className={styles.button} onClick={exportPage} aria-label="导出">
          导出
        </button>
      </div>
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
          setSelection({ fromRow: row, fromColumn: column, toRow: row, toColumn: column })
          // Keep the walk visible: a windowed grid would otherwise leave the
          // selection off-screen with nothing scrolled.
          const node = scrollRef.current
          if (node !== null) {
            const next = scrollTopForRow(row, node.scrollTop, node.clientHeight)
            if (next !== node.scrollTop) node.scrollTop = next
          }
        }}
      >
        <table className={styles.table}>
          <colgroup>
            {columns.map(column => (
              <col
                key={column.name}
                style={widths[column.name] === undefined ? undefined : { width: `${widths[column.name]}px` }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map(column => {
                const direction = ariaSort(sort, column.name)
                const active = (filters[column.name] ?? '').trim() !== ''
                return (
                  <th key={column.name} aria-sort={direction}>
                    <button type="button" className={styles.sortHeader} onClick={() => { onSort(column.name) }}>
                      {column.name}
                      {direction === 'none' ? '' : direction === 'ascending' ? ' ▲' : ' ▼'}
                    </button>
                    <button
                      type="button"
                      className={active ? styles.filterButtonActive : styles.filterButton}
                      aria-label={`筛选 ${column.name}`}
                      aria-pressed={active}
                      onClick={() => { setOpenFilter(openFilter === column.name ? null : column.name) }}
                    >
                      ▽
                    </button>
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
            {openFilter === null ? null : (
              <tr className={styles.filterRow}>
                {columns.map(column => (
                  <th key={column.name}>
                    {openFilter === column.name ? (
                      <input
                        className={styles.filterInput}
                        autoFocus
                        value={filters[column.name] ?? ''}
                        placeholder="包含…"
                        aria-label={`筛选输入 ${column.name}`}
                        onChange={event => {
                          const value = event.target.value
                          setFilters(current => ({ ...current, [column.name]: value }))
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Escape' || event.key === 'Enter') setOpenFilter(null)
                        }}
                      />
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {visibleIndexes.length === 0 ? (
              <tr>
                <td className={styles.gridPlaceholder} colSpan={columns.length}>
                  本页没有匹配的行
                </td>
              </tr>
            ) : null}
            {win.topPad > 0 ? (
              <tr aria-hidden="true" data-window-pad="top">
                <td colSpan={columns.length} style={{ height: win.topPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
            {visibleIndexes.slice(win.start, win.end).map(sourceIndex => (
              <tr key={sourceIndex} style={{ height: ROW_HEIGHT }}>
                {columns.map((column, columnIndex) => {
                  const cell = cells[sourceIndex]?.[columnIndex] as GridCell
                  const selected = selection !== null && inSelection(selection, sourceIndex, columnIndex)
                  return (
                    <td
                      key={column.name}
                      data-align={cell.align}
                      data-null={cell.isNull ? '' : undefined}
                      data-selected={selected ? '' : undefined}
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
                <td colSpan={columns.length} style={{ height: win.bottomPad, padding: 0, border: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Status bar: range, aggregator, charset (DataGrip keeps the aggregator here). */}
      <div className={styles.gridStatus} data-grid-status="">
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

      {viewer === null ? null : (
        <div
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
