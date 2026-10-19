// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { selectSql, setSql } from './support/editor.ts'
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(executeScript).toHaveBeenCalledWith({ connId, sql: 'SELECT 1; SELECT 2', pageSize: 500 })
    const tabs = [...container.querySelectorAll('[data-sql-script] [role="tab"]')]
    expect(tabs).toHaveLength(2)
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    click(tabs[0])
    expect(container.querySelectorAll('[data-sql-script] [role="tab"]')[0]?.getAttribute('aria-selected')).toBe('true')
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })

    click(byText('button', '下一页'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 1', offset: 500 }))

    click(byText('button', 'v'))
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

    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('未知连接')
  })

  it('reports a transport failure as a script error', async () => {
    const api = apiDouble({ executeScript: vi.fn(async () => Promise.reject(new Error('网络断了'))) })
    await mountWithScript(api, 'SELECT 1; SELECT 2')

    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
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
    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })
    // The button is disabled while running; clicking again must not start another run.
    const button = container.querySelector('[aria-label="执行"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(executeScript).toHaveBeenCalledTimes(1)
    release?.()
    await act(async () => {
      await Promise.resolve()
    })
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

    click(container.querySelector('[aria-label="执行"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })
    click(container.querySelector('[aria-label="刷新结果"]'))
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

    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })
    click(container.querySelector('[aria-label="刷新结果"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.execute).toHaveBeenCalledTimes(2)
  })
})

