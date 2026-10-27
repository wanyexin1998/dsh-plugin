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
        onSort={(_index, column) => calls.sort.push(column)}
        onPage={(_index, offset) => calls.page.push(offset)}
        onPageSize={(_index, size) => calls.pageSize.push(size)}
      />,
    )
  })
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  /** Result tabs only: the strip also carries 输出. */
  const resultTabs = (): Element[] => [...container.querySelectorAll('[role="tab"]:not([data-sql-output-tab])')]
  return { calls, buttons, resultTabs }
}

const tabs: ScriptTab[] = [
  { sql: 'SELECT 1', result: page([[1]], 1, 5) },
  { sql: 'SELECT 2', result: page([[2]], 2, 7) },
]

describe('script result error next steps (SQL-310)', () => {
  it('binds locate / EXPLAIN to the failed tab', () => {
    const onExplain = vi.fn()
    const onLocate = vi.fn()
    act(() => {
      root.render(
        <ScriptResults
          tabs={[{ sql: 'SELECT bad', result: null, error: { code: 'SQL_SYNTAX', message: '语法错误' } }]}
          active={0}
          running={false}
          pageSize={500}
          onActive={vi.fn()}
          onSort={vi.fn()}
          onPage={vi.fn()}
          onPageSize={vi.fn()}
          errorActions={() => ({ line: 3, onLocate, onExplain })}
        />,
      )
    })
    const byLabel = (label: string): HTMLElement | undefined =>
      [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

    act(() => {
      byLabel('定位错误行')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onLocate).toHaveBeenCalledWith(3)
    act(() => {
      byLabel('解释错误语句')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onExplain).toHaveBeenCalled()
  })

  it('tolerates an error tab whose failure has no next steps', () => {
    act(() => {
      root.render(
        <ScriptResults
          tabs={[{ sql: 'SELECT bad', result: null, error: { code: 'X', message: '失败' } }]}
          active={0}
          running={false}
          pageSize={500}
          onActive={vi.fn()}
          onSort={vi.fn()}
          onPage={vi.fn()}
          onPageSize={vi.fn()}
          errorActions={() => ({})}
        />,
      )
    })
    expect(container.textContent).toContain('X')
    expect(container.querySelector('[aria-label="解释错误语句"]')).toBeNull()
    expect(container.querySelector('[aria-label="定位错误行"]')).toBeNull()
  })

  it('forwards the send-to-chat action for a failed tab (SQL-405)', () => {
    const onSendChat = vi.fn()
    act(() => {
      root.render(
        <ScriptResults
          tabs={[{ sql: 'SELECT bad', result: null, error: { code: 'X', message: '失败' } }]}
          active={0}
          running={false}
          pageSize={500}
          onActive={vi.fn()}
          onSort={vi.fn()}
          onPage={vi.fn()}
          onPageSize={vi.fn()}
          onSendChat={onSendChat}
        />,
      )
    })
    act(() => {
      container.querySelector('[aria-label="发到聊天框"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSendChat).toHaveBeenCalledWith(0)
  })
})

describe('script result tabs: rename and pin (SQL-314)', () => {
  function renderEditable(tabs: ScriptTab[], onRenameTab = vi.fn(), onPinTab = vi.fn()) {
    act(() => {
      root.render(
        <ScriptResults
          tabs={tabs}
          active={0}
          running={false}
          pageSize={500}
          onActive={vi.fn()}
          onSort={vi.fn()}
          onPage={vi.fn()}
          onPageSize={vi.fn()}
          onRenameTab={onRenameTab}
          onPinTab={onPinTab}
        />,
      )
    })
    const resultTabs = (): Element[] =>
      [...container.querySelectorAll('[role="tab"]:not([data-sql-output-tab])')]
    return { onRenameTab, onPinTab, resultTabs }
  }

  const input = (): HTMLInputElement | null => container.querySelector('[aria-label="重命名结果标签"]')

  const typeInto = (value: string): void => {
    const field = input() as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('renames on double-click + Enter and ignores an empty name', () => {
    const view = renderEditable(tabs)
    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(input()).not.toBeNull()
    typeInto('订单明细')
    act(() => {
      input()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
    expect(view.onRenameTab).toHaveBeenCalledWith(0, '订单明细')

    // Empty name keeps the old title.
    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    typeInto('   ')
    act(() => {
      input()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
    expect(view.onRenameTab).toHaveBeenCalledTimes(1)
  })

  it('cancels renaming on Escape and commits on blur', () => {
    const view = renderEditable(tabs)
    act(() => {
      view.resultTabs()[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    act(() => {
      input()?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    })
    expect(input()).toBeNull()

    act(() => {
      view.resultTabs()[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    typeInto('第二段')
    act(() => {
      input()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(view.onRenameTab).toHaveBeenCalledWith(1, '第二段')
  })

  it('pins from the context menu and shows the pin marker', () => {
    const view = renderEditable([{ ...tabs[0] as ScriptTab, pinned: true }, tabs[1] as ScriptTab])
    expect(container.querySelector('[data-sql-tab-pinned]')).not.toBeNull()
    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(view.onPinTab).toHaveBeenCalledWith(0)
  })

  it('does nothing for rename/pin when the panel passes no handlers', () => {
    const view = render(tabs)
    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(input()).toBeNull()
    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(view.resultTabs()).toHaveLength(2)
  })
})

describe('script result tabs', () => {
  it('names each tab after its first column and type, with rows and duration', () => {
    const view = render(tabs)

    const labels = view.resultTabs().map(tab => tab.textContent)
    expect(labels).toEqual(['v:int1 行 · 5ms', 'v:int (2)2 行 · 7ms'])
  })

  it('suffixes repeated column/type titles so two tabs never look identical', () => {
    const view = render([...tabs, { sql: 'SELECT 3', result: page([[3]], 3, 9) }])

    const labels = view.resultTabs().map(tab => tab.textContent)
    expect(labels[0]).toContain('v:int')
    expect(labels[2]).toContain('v:int (3)')
  })

  it('prefers an explicit table title over the column label (SQL-314)', () => {
    const view = render([{ sql: 'SELECT * FROM dwd_order', result: page([[1]], 1), title: 'dwd_order' }])
    expect(view.resultTabs()[0]?.textContent).toContain('dwd_order')
    expect(view.resultTabs()[0]?.textContent).not.toContain('v:int')
  })

  it('marks the active tab and switches on click', () => {
    const view = render(tabs, 1)

    expect(view.resultTabs()[1]?.getAttribute('aria-selected')).toBe('true')

    act(() => {
      view.resultTabs()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(view.calls.active).toEqual([0])
  })

  it('mirrors a failed statement into the output tab', () => {
    render([{ sql: 'DELETE FROM t', result: null, error: { code: 'WRITE_DISABLED', message: '写操作未开启' } }])

    // Immediate: the failing tab still explains itself.
    expect(container.textContent).toContain('写操作未开启')

    act(() => {
      container.querySelector('[data-sql-output-tab]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Traceable: 输出 carries the whole run's errors with their codes.
    expect(container.textContent).toContain('WRITE_DISABLED')
  })

  it('badges the output tab with the number of errors', () => {
    render([
      { sql: 'SELECT 1', result: page([[1]], 1) },
      { sql: 'DELETE FROM t', result: null, error: { code: 'WRITE_DISABLED', message: '写操作未开启' } },
    ])

    expect(container.querySelector('[data-sql-output-tab]')?.textContent).toContain('1 个错误')
  })

  it('labels a statement that has not run yet', () => {
    const view = render([{ sql: 'SELECT 1', result: null }])

    expect(view.resultTabs()[0]?.textContent).toContain('—')
  })

  it('names a result without columns after its statement number', () => {
    const view = render([{ sql: 'DO 1', result: { ...page([], 0), columns: [] } }])
    expect(view.resultTabs()[0]?.textContent).toContain('语句 1')
  })

  it('forwards sort, paging and page-size from the grid and pager', () => {
    const view = render([{ sql: 'SELECT 1', result: { ...page([[1]], 1000), hasNextPage: true } }])

    act(() => {
      // The header button now carries the name plus a sort indicator glyph.
      view.buttons().find(button => button.className.includes('sortHeader'))?.click()
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
    const view = render([{ sql: 'SELECT 1', result: { ...page([[1], [2]], 0), total: null } }])

    expect(view.resultTabs()[0]?.textContent).toContain('2 行')
  })

  it('falls back to the first tab when the active index is stale', () => {
    render(tabs, 9)

    expect(container.textContent).toContain('v:int')
  })

  it('renders only the output tab when there are no statements', () => {
    render([])

    expect(container.querySelector('[data-sql-script]')).not.toBeNull()
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(container.querySelector('[data-sql-output-tab]')).not.toBeNull()
  })

  it('explains that a successful run has no output lines', () => {
    render(tabs)
    act(() => {
      container.querySelector('[data-sql-output-tab]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('没有输出。')
  })
})
