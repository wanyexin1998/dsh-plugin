import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse } from '../../execute/core.ts'
import type { FilterSpec, SortSpec } from '../../execute/core.ts'
import { Pager } from './Pager.tsx'
import { ResultGrid } from './ResultGrid.tsx'
import { classes as styles } from '../styles.ts'

/** One statement of a script: its text plus whatever came back. */
export interface ScriptTab {
  readonly sql: string
  readonly result: ExecuteResponse | null
  readonly error?: { readonly code: string; readonly message: string }
  /**
   * Per-tab interaction state (docs/10 §14 R6).
   *
   * Sorting or paging one statement used to write into the console-wide
   * `QueryState`, so a second tab inherited the first one's ordering and a
   * refetch dropped it. These fields keep the intent on the tab it belongs to;
   * absent means "the strip's default".
   */
  readonly sort?: SortSpec | null
  readonly filters?: readonly FilterSpec[]
  readonly pageSize?: number
  readonly total?: number | null
}

/** One line of the console-level output tab. */
export interface OutputLine {
  readonly kind: 'error' | 'info'
  readonly text: string
}

/**
 * Errors belong to the console, not to a result tab (docs/10 §8): DataGrip puts
 * them in 输出, so a failed statement leaves its tab empty and the reason is one
 * click away instead of replacing a grid the user may still want to read.
 */
function outputLines(tabs: readonly ScriptTab[]): readonly OutputLine[] {
  const lines: OutputLine[] = []
  tabs.forEach((tab, index) => {
    if (tab.error === undefined) return
    const where = tabs.length > 1 ? `语句 ${index + 1}` : '执行失败'
    lines.push({ kind: 'error', text: `${where}：${tab.error.message}（${tab.error.code}）` })
  })
  return lines
}

export interface ScriptResultsProps {
  readonly tabs: readonly ScriptTab[]
  readonly active: number
  readonly running: boolean
  /** Fallback page size for tabs that never set one. */
  readonly pageSize: number
  readonly onActive: (index: number) => void
  readonly onSort: (index: number, column: string) => void
  readonly onPage: (index: number, offset: number) => void
  readonly onPageSize: (index: number, size: number) => void
  readonly onRefresh?: (index: number) => void
  /** Providing these turns on the server-side filter funnel for each tab. */
  readonly onFilter?: (index: number, column: string, filter: FilterSpec | null) => void
  readonly onClearFilters?: (index: number) => void
}

/** Short label for the tab: "语句 3 · 500 行 · 87ms", or the failure. */
function describe(tab: ScriptTab): string {
  if (tab.error !== undefined) return '错误'
  if (tab.result === null) return '—'
  const rows = tab.result.total ?? tab.result.rows.length
  return `${rows} 行 · ${tab.result.durationMs}ms`
}

/**
 * Tab title, the way DataGrip names a result: `a:int` from the first column.
 *
 * Two statements returning the same column and type would collide, so repeats
 * get a ` (2)` suffix — a title is the only handle the user has on a result.
 */
function titleOf(tab: ScriptTab, index: number, running: boolean): string {
  if (tab.error !== undefined) return '错误'
  if (tab.result === null) return running ? '执行中' : '—'
  const column = tab.result.columns[0]
  if (column === undefined) return `语句 ${index + 1}`
  return `${column.name}:${column.typeName.toLowerCase()}`
}

/** Titles for the whole strip, deduplicated in order. */
function tabTitles(tabs: readonly ScriptTab[], running: boolean): readonly string[] {
  const seen = new Map<string, number>()
  return tabs.map((tab, index) => {
    const base = titleOf(tab, index, running)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base} (${count})`
  })
}

/**
 * Result tabs for a multi-statement run.
 *
 * DataGrip gives each statement its own result tab; the label carries the row
 * count and duration so the user can tell which statement did what without
 * clicking through them (§4.3 of the UI spec has the same layout in mind).
 */
export function ScriptResults({
  tabs,
  active,
  running,
  pageSize,
  onActive,
  onSort,
  onPage,
  onPageSize,
  onRefresh,
  onFilter,
  onClearFilters,
}: ScriptResultsProps): ReactElement {
  const current = tabs[active] ?? tabs[0]
  /** The index callbacks must name; mirrors the `?? tabs[0]` fallback above. */
  const activeIndex = tabs[active] === undefined ? 0 : active
  const titles = tabTitles(tabs, running)
  const lines = outputLines(tabs)
  // Local, so callers keep using result indices; 输出 is a sibling of the result
  // tabs rather than +1 on every index.
  const [showOutput, setShowOutput] = React.useState(false)

  return (
    <div className={styles.scriptResults} data-sql-script="">
      <div className={styles.scriptTabs} role="tablist" aria-label="结果与输出">
        <button
          type="button"
          role="tab"
          aria-selected={showOutput}
          className={showOutput ? styles.scriptTabActive : styles.scriptTab}
          onClick={() => {
            setShowOutput(true)
          }}
          data-sql-output-tab=""
        >
          输出
          {lines.length === 0 ? null : (
            <span className={styles.scriptTabMeta}> · {lines.length} 个错误</span>
          )}
        </button>
        {tabs.map((tab, index) => (
          <button
            key={`${index}:${tab.sql.slice(0, 16)}`}
            type="button"
            role="tab"
            aria-selected={!showOutput && index === active}
            className={!showOutput && index === active ? styles.scriptTabActive : styles.scriptTab}
            onClick={() => {
              setShowOutput(false)
              onActive(index)
            }}
            title={tab.sql}
          >
            {titles[index]}
            <span className={styles.scriptTabMeta}>{describe(tab)}</span>
          </button>
        ))}
      </div>

      {showOutput ? (
        <div className={styles.scriptResults} data-sql-output="">
          {lines.length === 0 ? (
            <span className={styles.scriptTabMeta}>没有输出。</span>
          ) : (
            lines.map((line, index) => (
              <span key={`${index}:${line.text}`} className={styles.noticeText} data-output-kind={line.kind}>
                {line.text}
              </span>
            ))
          )}
        </div>
      ) : current === undefined ? null : (
        <>
          <ResultGrid
            result={current.result}
            sort={current.sort ?? null}
            // The reason stays on the failed tab (immediate) and is also logged
            // in 输出, which keeps the history of a whole run.
            error={current.error ?? null}
            running={running && current.result === null && current.error === undefined}
            onSort={column => {
              onSort(activeIndex, column)
            }}
            {...(onRefresh === undefined
              ? {}
              : {
                  onRefresh: () => {
                    onRefresh(activeIndex)
                  },
                })}
            {...(onFilter === undefined ? {} : { filters: current.filters ?? [] })}
            {...(onFilter === undefined
              ? {}
              : {
                  onFilter: (column: string, filter: FilterSpec | null) => {
                    onFilter(activeIndex, column, filter)
                  },
                })}
            {...(onClearFilters === undefined
              ? {}
              : {
                  onClearFilters: () => {
                    onClearFilters(activeIndex)
                  },
                })}
            filterEnabled={onFilter !== undefined}
          />
          <Pager
            result={current.result}
            total={current.total ?? current.result?.total ?? null}
            pageSize={current.pageSize ?? pageSize}
            running={running}
            onPage={offset => {
              onPage(activeIndex, offset)
            }}
            onPageSize={size => {
              onPageSize(activeIndex, size)
            }}
          />
        </>
      )}
    </div>
  )
}
