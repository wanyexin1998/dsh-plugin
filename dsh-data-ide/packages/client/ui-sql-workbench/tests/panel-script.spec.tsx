// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { editorView, pressKey, readSql, selectSql, setSql } from './support/editor.ts'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { ConnectionDraft, WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'doris.shcell.com', username: 'u' })

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

const page = (rows: number[][], total: number): ExecuteResponse => ({
  columns: [{ name: 'v', typeName: 'INT' }],
  rows,
  total,
  hasNextPage: total > rows.length,
  offset: 0,
  durationMs: 9,
  statementId: 'st-1',
})

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async (draft: ConnectionDraft) => createDataSource({ id: connId, name: draft.name, dbms: draft.dbms, host: draft.host, port: draft.port, username: draft.username })),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 3 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'execute' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'fetchPage' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  }
}

const click = (element: Element | undefined | null): void => {
  if (element === undefined || element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Open the overflow menu that holds a control, then click it. */
function clickLabel(label: string): void {
  const found = (): Element | null => document.querySelector(`[aria-label="${label}"]`)
  if (found() !== null) {
    click(found())
    return
  }
  for (const opener of ['更多查询操作', '更多结果操作', '连接操作']) {
    const button = document.querySelector(`[aria-label="${opener}"]`)
    if (button === null) continue
    click(button)
    if (found() !== null) {
      click(found())
      return
    }
    click(button)
  }
  click(found())
}

const byText = (selector: string, text: string): HTMLElement | undefined =>
  [...container.querySelectorAll(selector)].find(node => node.textContent?.includes(text) === true) as HTMLElement | undefined

/** Mount, wait for the connection list, and type the script. */
async function mountWithScript(api: WorkbenchApi, sql: string): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  act(() => {
    setSql(container, sql)
  })
}

describe('panel: multi-statement run', () => {
  it('shows one tab per statement and switches between them', async () => {
    const executeScript = vi.fn(async () => ({
      durationMs: 20,
      statements: [
        { index: 0, sql: 'SELECT 1', ok: true as const, response: page([[1]], 1) },
        { index: 1, sql: 'SELECT 2', ok: true as const, response: page([[2]], 2) },
      ],
    }))
    const api = apiDouble({ executeScript })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ connId, sql: 'SELECT 1; SELECT 2', pageSize: 500 }))
    // Result tabs only: the strip also carries 输出.
    const tabs = [...container.querySelectorAll('[data-sql-script] [role="tab"]:not([data-sql-output-tab])')]
    expect(tabs).toHaveLength(2)
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    click(tabs[0])
    expect(container.querySelectorAll('[data-sql-script] [role="tab"]:not([data-sql-output-tab])')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('cancels a running script by its statement ids (SQL-107)', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const executeScript = vi.fn(async () => {
      await gate
      return { statements: [], durationMs: 0 }
    })
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const api = apiDouble({ executeScript, cancel })
    await mountWithScript(api, 'SELECT 1; SELECT 2')
    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    clickLabel('取消')
    expect(cancel).toHaveBeenCalledTimes(2)

    release?.()
    await act(async () => {
      await gate
      await Promise.resolve()
    })
  })

  it('renames a result tab and keeps a pinned tab across the next run (SQL-314)', async () => {
    const executeScript = vi.fn(async () => ({
      durationMs: 5,
      statements: [
        { index: 0, sql: 'SELECT 1', ok: true as const, response: page([[1]], 1) },
        { index: 1, sql: 'SELECT 2', ok: true as const, response: page([[2]], 2) },
      ],
    }))
    const api = apiDouble({ executeScript })
    await mountWithScript(api, 'SELECT 1; SELECT 2')
    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    const tabList = (): Element[] => [...container.querySelectorAll('[data-sql-script] [role="tab"]:not([data-sql-output-tab])')]
    act(() => {
      tabList()[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const field = container.querySelector('[aria-label="重命名结果标签"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, '第一段')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
    expect(tabList()[0]?.textContent).toContain('第一段')

    // Right-click pins it; the next run keeps it and appends the new results.
    act(() => {
      tabList()[0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(tabList()[0]?.querySelector('[data-sql-tab-pinned]')).not.toBeNull()
    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    expect(tabList()).toHaveLength(3)
    expect(tabList()[0]?.textContent).toContain('第一段')
    expect(tabList()[0]?.querySelector('[data-sql-tab-pinned]')).not.toBeNull()
  })

  it('refetches the active statement for the next page and for a sort', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 5,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: { ...page([[1]], 1000), hasNextPage: true } }],
      })),
      fetchPage: vi.fn(async () => ({ ok: true as const, ...page([[2]], 1000) })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    click(byText('button', '下一页'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 1', offset: 500 }))

    // Target the column header explicitly: tab titles now carry the column name
    // (`v:int`), so a text match would hit the tab instead.
    click(container.querySelector('th button') as HTMLElement)
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ sql: 'SELECT 1', sort: { column: 'v', direction: 'ASC' } }))
  })

  it('marks a failed script as an error tab', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 4,
        statements: [{ index: 0, sql: 'DELETE FROM t', ok: false as const, error: { code: 'WRITE_DISABLED', message: '写操作未开启' } }],
      })),
    })
    await mountWithScript(api, 'SELECT 1; DELETE FROM t')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('写操作未开启')
  })

  it('shows a refusal returned for the whole script', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({ refusal: { code: 'CONN_NOT_FOUND', message: '未知连接' } })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('未知连接')
  })

  it('reports a transport failure as a script error', async () => {
    const api = apiDouble({ executeScript: vi.fn(async () => Promise.reject(new Error('网络断了'))) })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('网络断了')
  })

  it('reports a failed page fetch without losing the tab', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 5,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: { ...page([[1]], 1000), hasNextPage: true } }],
      })),
      fetchPage: vi.fn(async () => Promise.reject(new Error('分页失败'))),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    click(byText('button', '下一页'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('分页失败')
  })

  it('runs only the selection when one is made', async () => {
    const executeScript = vi.fn(async () => ({ durationMs: 1, statements: [] }))
    const api = apiDouble({ executeScript })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    act(() => {
      selectSql(container, 0, 8)
    })
    clickLabel('执行')
    await act(async () => {
      await Promise.resolve()
    })

    // A single statement goes down the plain execute path, not the script one.
    expect(executeScript).not.toHaveBeenCalled()
    expect(api.execute).toHaveBeenCalled()
  })
})

describe('panel: multi-statement edges', () => {
  it('shows a refusal from the page request as a tab error', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 5,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: { ...page([[1]], 1000), hasNextPage: true } }],
      })),
      fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'CONN_LOST', message: '连接已断开' } })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    click(byText('button', '下一页'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('连接已断开')
  })

  it('changes the page size while showing script results', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 5,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: page([[1]], 1) }],
      })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })

    const select = container.querySelector('select[aria-label="页大小"]') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, '1000')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(select.value).toBe('1000')
  })
})

describe('panel: hardening', () => {
  it('ignores a second Run while a script is still running', async () => {
    let release: (() => void) | undefined
    const executeScript = vi.fn(() => new Promise<{ durationMs: number; statements: never[] }>(resolve => {
      release = () => { resolve({ durationMs: 1, statements: [] }) }
    }))
    const api = apiDouble({ executeScript: executeScript as unknown as WorkbenchApi['executeScript'] })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    // While a script runs, the one control is Cancel, so it cannot start a second run.
    expect(container.querySelector('[aria-label="执行"]')).toBeNull()
    const button = container.querySelector('[aria-label="取消"]') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(executeScript).toHaveBeenCalledTimes(1)
    release?.()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('clears the console and explains a comment-only script from the more menu', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'EMPTY', message: 'empty' } })),
    })
    await mountWithScript(api, 'SELECT 1')
    clickLabel('清空')
    expect(readSql(container)).toBe('')

    await mountWithScript(api, '-- just a comment')
    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true })
      pressKey(container, { key: 'e', ctrlKey: true, shiftKey: true })
    })
    clickLabel('解释计划')
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.execute).toHaveBeenCalled()
  })

  it('handles run-all, rerun and history from the editor chords', async () => {
    const executeScript = vi.fn(async () => ({ durationMs: 1, statements: [] }))
    const api = apiDouble({ executeScript })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true, altKey: true })
      pressKey(container, { key: 'h', ctrlKey: true, shiftKey: true })
    })
    expect(container.querySelector('[data-sql-history-overlay]')).not.toBeNull()

    act(() => {
      selectSql(container, 0, 8)
      pressKey(container, { key: 'Enter', ctrlKey: true })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      selectSql(container, 0, 0)
      pressKey(container, { key: 'Enter', ctrlKey: true, shiftKey: true })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(executeScript).toHaveBeenCalledTimes(1)

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true, altKey: true })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(executeScript).toHaveBeenCalledTimes(2)

    act(() => {
      pressKey(container, { key: 'e', ctrlKey: true, shiftKey: true })
    })
    act(() => {
      setSql(container, 'select 1')
      pressKey(container, { key: 'l', ctrlKey: true, altKey: true })
    })
    expect(readSql(container)).toBe('SELECT 1')
  })

  it('does not cancel when 执行 is double-clicked', async () => {
    let release: () => void = () => undefined
    const execute = vi.fn(() => new Promise<ExecuteResponse>(resolve => {
      release = () => {
        resolve(page([[1]], 1))
      }
    }))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const api = apiDouble({ execute: execute as unknown as WorkbenchApi['execute'], cancel })
    await mountWithScript(api, 'SELECT 1')

    clickLabel('执行')
    const cancelButton = document.querySelector('[aria-label="取消"]')
    act(() => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    })
    expect(cancel).not.toHaveBeenCalled()

    click(cancelButton)
    expect(cancel).toHaveBeenCalledTimes(1)
    release()
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('renames the run button from the caret and the selection', async () => {
    const sql = 'SELECT 1;\nUPDATE t SET a = 1'
    await mountWithScript(apiDouble(), sql)
    const view = editorView(container)

    act(() => {
      view.dispatch({ selection: { anchor: 0 } })
    })
    expect(document.querySelector('[data-sql-run]')?.textContent).toBe('执行')

    const updateAt = sql.indexOf('UPDATE')
    act(() => {
      view.dispatch({ selection: { anchor: updateAt } })
    })
    expect(document.querySelector('[data-sql-run]')?.textContent).toBe('执行写入')

    act(() => {
      view.dispatch({ selection: { anchor: updateAt, head: updateAt + 6 } })
    })
    expect(document.querySelector('[data-sql-run]')?.textContent).toBe('执行写入')

    act(() => {
      view.dispatch({ selection: { anchor: 6, head: 7 } })
    })
    expect(document.querySelector('[data-sql-run]')?.textContent).toBe('执行')
  })

  it('names the run control after the statement at the caret', async () => {
    const api = apiDouble()
    await mountWithScript(api, '')
    expect(container.querySelector('[aria-label="执行"]')).not.toBeNull()

    await mountWithScript(api, 'UPDATE t SET a = 1')
    expect(container.querySelector('[aria-label="执行写入"]')?.textContent).toBe('执行写入')
  })

  it('drops script tabs and results when the connection changes', async () => {
    const other = createDataSource({ id: 'other-conn', name: 'other', dbms: 'doris', host: 'h2', username: 'u' })
    const api = apiDouble({
      list: vi.fn(async () => [doris, other]),
      executeScript: vi.fn(async () => ({
        durationMs: 3,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: page([[1]], 1) }],
      })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('[data-sql-script]')).not.toBeNull()

    const select = container.querySelector('select[id="sql-workbench-connection"]') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, other.id)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-script]')).toBeNull()
  })
})

describe('panel: refresh', () => {
  it('re-runs the statement from the grid toolbar in script mode', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 3,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true as const, response: page([[1]], 1) }],
      })),
      fetchPage: vi.fn(async () => ({ ok: true as const, ...page([[9]], 1) })),
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    clickLabel('刷新结果')
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 1' }))
  })

  it('re-runs the query from the grid toolbar in single-statement mode', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: true as const, ...page([[1]], 1) })),
    })
    await mountWithScript(api, 'SELECT 1')

    clickLabel('执行全部')
    await act(async () => {
      await Promise.resolve()
    })
    clickLabel('刷新结果')
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.execute).toHaveBeenCalledTimes(2)
  })
})


describe('panel: per-tab result state (R6)', () => {
  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  /** Result tabs only: the strip also carries 输出. */
  const resultTabs = (): Element[] => [
    ...container.querySelectorAll('[data-sql-script] [role="tab"]:not([data-sql-output-tab])'),
  ]
  /** Change the pager's page size; it is a `<select>`, not a row of buttons. */
  const setPageSize = (size: string): void => {
    const select = container.querySelector('[aria-label="页大小"]') as HTMLSelectElement
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, size)
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  async function mountTwoStatements(fetchPage: WorkbenchApi['fetchPage']): Promise<void> {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        durationMs: 5,
        statements: [
          { index: 0, sql: 'SELECT 1', ok: true as const, response: { ...page([[1]], 1000), hasNextPage: true } },
          { index: 1, sql: 'SELECT 2', ok: true as const, response: { ...page([[2]], 1000), hasNextPage: true } },
        ],
      })),
      fetchPage,
    })
    await mountWithScript(api, 'SELECT 1; SELECT 2')
    clickLabel('执行全部')
    await settle()
  }

  it('toggles the ordering within one statement tab', async () => {
    const fetchPage = vi.fn(async () => ({ ok: true as const, ...page([[9]], 1000) }))
    await mountTwoStatements(fetchPage)

    click(container.querySelector('th button'))
    await settle()
    click(container.querySelector('th button'))
    await settle()

    // A second click on the same header must flip to DESC. The old code derived
    // the baseline from the console-wide `query.sort`, which script sorting never
    // updated, so it stayed ASC forever.
    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { column: 'v', direction: 'DESC' } }),
    )
  })

  it('keeps one ordering per statement tab', async () => {
    const fetchPage = vi.fn(async () => ({ ok: true as const, ...page([[9]], 1000) }))
    await mountTwoStatements(fetchPage)

    // A run activates its last tab, so these clicks belong to statement 2.
    click(container.querySelector('th button'))
    await settle()
    click(container.querySelector('th button'))
    await settle()
    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: { column: 'v', direction: 'DESC' } }),
    )

    // Statement 1 has its own baseline: one click is ASC.
    click(resultTabs()[0])
    await settle()
    click(container.querySelector('th button'))
    await settle()
    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'SELECT 1', sort: { column: 'v', direction: 'ASC' } }),
    )

    // Back on statement 2, its DESC must still be the baseline: the next click
    // clears the ordering (none) instead of restarting at ASC.
    click(resultTabs()[1])
    await settle()
    click(container.querySelector('th button'))
    await settle()
    const last = fetchPage.mock.calls.at(-1) as unknown as [{ readonly sort?: unknown }] | undefined
    expect(last?.[0].sort).toBeUndefined()
  })

  it('remembers the page size per tab', async () => {
    const fetchPage = vi.fn(async () => ({ ok: true as const, ...page([[9]], 1000) }))
    await mountTwoStatements(fetchPage)

    // The active tab after a run is the last one; resize that one.
    setPageSize('1000')
    click(byText('button', '下一页'))
    await settle()
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ pageSize: 1000 }))

    // The first statement keeps the default: page size used to be console-wide.
    click(resultTabs()[0])
    await settle()
    click(byText('button', '下一页'))
    await settle()
    expect(fetchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'SELECT 1', pageSize: 500 }),
    )
  })
})
