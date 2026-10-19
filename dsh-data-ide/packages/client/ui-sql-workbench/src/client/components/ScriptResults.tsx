import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse } from '../../execute/core.ts'
import { Pager } from './Pager.tsx'
import { ResultGrid } from './ResultGrid.tsx'
import { classes as styles } from '../styles.ts'

/** One statement of a script: its text plus whatever came back. */
export interface ScriptTab {
  readonly sql: string
  readonly result: ExecuteResponse | null
  readonly error?: { readonly code: string; readonly message: string }
}

export interface ScriptResultsProps {
  readonly tabs: readonly ScriptTab[]
  readonly active: number
  readonly running: boolean
  readonly pageSize: number
  readonly onActive: (index: number) => void
  readonly onSort: (column: string) => void
  readonly onPage: (offset: number) => void
  readonly onPageSize: (size: number) => void
  readonly onRefresh?: () => void
}

/** Short label for the tab: "语句 3 · 500 行 · 87ms", or the failure. */
function describe(tab: ScriptTab): string {
  if (tab.error !== undefined) return '错误'
  if (tab.result === null) return '—'
  const rows = tab.result.total ?? tab.result.rows.length
  return `${rows} 行 · ${tab.result.durationMs}ms`
}

/**
 * Result tabs for a multi-statement run.
 *
 * DataGrip gives each statement its own result tab; the label carries the row
 * count and duration so the user can tell which statement did what without
 * clicking through them (§4.3 of the UI spec has the same layout in mind).
 */
export function ScriptResults({ tabs, active, running, pageSize, onActive, onSort, onPage, onPageSize, onRefresh }: ScriptResultsProps): ReactElement {
  const current = tabs[active] ?? tabs[0]

  return (
    <div className={styles.scriptResults} data-sql-script="">
      <div className={styles.scriptTabs} role="tablist" aria-label="语句结果">
        {tabs.map((tab, index) => (
          <button
            key={`${index}:${tab.sql.slice(0, 16)}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            className={index === active ? styles.scriptTabActive : styles.scriptTab}
            onClick={() => {
              onActive(index)
            }}
            title={tab.sql}
          >
            语句 {index + 1}
            <span className={styles.scriptTabMeta}>{describe(tab)}</span>
          </button>
        ))}
      </div>

      {current === undefined ? null : (
        <>
          <ResultGrid
            result={current.result}
            sort={null}
            error={current.error ?? null}
            running={running && current.result === null && current.error === undefined}
            onSort={onSort}
            {...(onRefresh === undefined ? {} : { onRefresh })}
          />
          <Pager
            result={current.result}
            total={current.result?.total ?? null}
            pageSize={pageSize}
            running={running}
            onPage={onPage}
            onPageSize={onPageSize}
          />
        </>
      )}
    </div>
  )
}
