// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScriptResults } from '../src/client/components/ScriptResults.tsx'
import type { ScriptTab } from '../src/client/components/ScriptResults.tsx'
import type { ExecuteResponse } from '../src/execute/core.ts'

const page = (rows: number[][], total: number, durationMs = 12): ExecuteResponse => ({
  columns: [{ name: 'v', typeName: 'INT' }],
  rows,
  total,
  hasNextPage: false,
  offset: 0,
  durationMs,
  statementId: 'st-1',
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(tabs: ScriptTab[], active = 0) {
  const calls = { active: [] as number[], sort: [] as string[], page: [] as number[], pageSize: [] as number[] }
  act(() => {
    root.render(
      <ScriptResults
        tabs={tabs}
        active={active}
        running={false}
        pageSize={500}
        onActive={index => calls.active.push(index)}
        onSort={column => calls.sort.push(column)}
        onPage={offset => calls.page.push(offset)}
        onPageSize={size => calls.pageSize.push(size)}
      />,
    )
  })
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  return { calls, buttons }
}

const tabs: ScriptTab[] = [
  { sql: 'SELECT 1', result: page([[1]], 1, 5) },
  { sql: 'SELECT 2', result: page([[2]], 2, 7) },
]

describe('script result tabs', () => {
  it('lists one tab per statement with rows and duration', () => {
    render(tabs)

    const labels = [...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)
    expect(labels).toEqual(['语句 11 行 · 5ms', '语句 22 行 · 7ms'])
  })

  it('marks the active tab and switches on click', () => {
    const view = render(tabs, 1)

    expect(container.querySelectorAll('[role="tab"]')[1]?.getAttribute('aria-selected')).toBe('true')

    act(() => {
      container.querySelectorAll('[role="tab"]')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(view.calls.active).toEqual([0])
  })

  it('shows the error of a failed statement instead of a grid', () => {
    render([{ sql: 'DELETE FROM t', result: null, error: { code: 'WRITE_DISABLED', message: '写操作未开启' } }])

    expect(container.textContent).toContain('写操作未开启')
  })

  it('labels a statement that has not run yet', () => {
    render([{ sql: 'SELECT 1', result: null }])

    expect(container.querySelector('[role="tab"]')?.textContent).toContain('—')
  })

  it('forwards sort, paging and page-size from the grid and pager', () => {
    const view = render([{ sql: 'SELECT 1', result: { ...page([[1]], 1000), hasNextPage: true } }])

    act(() => {
      view.buttons().find(button => button.textContent === 'v')?.click()
    })
    const pager = view.buttons().filter(button => ['上一页', '下一页', '首页', '末页'].includes(button.textContent ?? ''))
    act(() => {
      pager.find(button => button.textContent === '下一页')?.click()
    })

    expect(view.calls.sort).toEqual(['v'])
    expect(view.calls.page).toEqual([500])
  })
})

describe('script result tabs: edges', () => {
  it('falls back to the row count when the total is unknown', () => {
    render([{ sql: 'SELECT 1', result: { ...page([[1], [2]], 0), total: null } }])

    expect(container.querySelector('[role="tab"]')?.textContent).toContain('2 行')
  })

  it('falls back to the first tab when the active index is stale', () => {
    render(tabs, 9)

    expect(container.textContent).toContain('语句 1')
  })

  it('renders nothing but the tab strip when there are no statements', () => {
    render([])

    expect(container.querySelector('[data-sql-script]')).not.toBeNull()
    expect(container.querySelector('[role="tab"]')).toBeNull()
  })
})
