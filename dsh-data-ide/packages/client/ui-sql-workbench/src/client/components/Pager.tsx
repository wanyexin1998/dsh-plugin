import * as React from 'react'

import type { ReactElement } from 'react'

import type { ExecuteResponse } from '../../execute/core.ts'
import { PAGE_SIZES } from '../state/query.ts'
import { classes as styles } from '../styles.ts'

export interface PagerProps {
  readonly result: ExecuteResponse | null
  readonly total: number | null
  readonly pageSize: number
  readonly running: boolean
  readonly onPage: (offset: number) => void
  readonly onPageSize: (size: number) => void
}

/** `第 1-500 行 / 共 103,572 行` — the shape drawn in docs/03 §4.3. */
function describeRange(offset: number, shown: number, total: number | null): string {
  if (shown === 0) return total === null ? '没有数据 · 总数未知' : `没有数据 · 共 ${total} 行`
  const from = offset + 1
  const to = offset + shown
  return total === null ? `第 ${from}-${to} 行 / 总数未知` : `第 ${from}-${to} 行 / 共 ${total} 行`
}

/**
 * Pagination bar: first / previous / next / last, page size menu, timing.
 *
 * `last` needs a known total; with a degraded COUNT it stays disabled rather
 * than guessing (docs/05 §7).
 */
export function Pager({ result, total, pageSize, running, onPage, onPageSize }: PagerProps): ReactElement | null {
  if (result === null) return null

  const offset = result.offset
  const shown = result.rows.length
  const hasPrev = offset > 0
  const hasNext = result.hasNextPage
  const lastOffset = total === null ? null : Math.max(0, Math.floor(Math.max(0, total - 1) / pageSize) * pageSize)

  return (
    <footer className={styles.pager}>
      <span className={styles.pagerRange} data-pager-range="">
        {describeRange(offset, shown, total)}
      </span>

      <div className={styles.pagerButtons}>
        <button type="button" className={styles.button} disabled={!hasPrev || running} onClick={() => { onPage(0) }}>
          首页
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!hasPrev || running}
          onClick={() => { onPage(Math.max(0, offset - pageSize)) }}
        >
          上一页
        </button>
        <button type="button" className={styles.button} disabled={!hasNext || running} onClick={() => { onPage(offset + pageSize) }}>
          下一页
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={lastOffset === null || lastOffset === offset || running}
          onClick={() => {
            if (lastOffset !== null) onPage(lastOffset)
          }}
        >
          末页
        </button>
      </div>

      <label className={styles.pagerSize}>
        页大小
        <select
          className={styles.select}
          value={pageSize}
          disabled={running}
          aria-label="页大小"
          onChange={event => {
            onPageSize(Number(event.target.value))
          }}
        >
          {PAGE_SIZES.map(size => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      <span className={styles.pagerMeta} data-pager-meta="">
        {shown} 行 · {result.durationMs}ms
        {result.truncated === undefined ? '' : ` · ${result.truncated.cells} 个值过大已截断`}
      </span>
    </footer>
  )
}
