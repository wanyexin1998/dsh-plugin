// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import { createDataSource } from '../src/datasource/model.ts'
import { readSql, setSql } from './support/editor.ts'

const connA = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const connB = '9c1b8b7a-1111-4222-8333-944455556666'
const doris = createDataSource({ id: connA, name: 'doris', dbms: 'doris', host: 'h1', username: 'u' })
const zanmal = createDataSource({ id: connB, name: 'zanmal_read', dbms: 'mysql', host: 'h2', username: 'u' })

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

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => [doris, zanmal]),
    active: vi.fn(async () => connA),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => doris),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  }
}

async function mount(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const tabs = (): HTMLElement[] => [...container.querySelectorAll('[data-sql-documents] [role="tab"]')] as HTMLElement[]
const click = (element: Element | undefined | null): void => {
  if (element === undefined || element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
/** Type into the CodeMirror document (see tests/support/editor.ts). */
const type = (sql: string): void => {
  act(() => {
    setSql(container, sql)
  })
}
const sqlText = (): string => readSql(container)

describe('panel documents', () => {
  it('starts with one console bound to the active connection', async () => {
    await mount(apiDouble())

    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]?.textContent).toContain('console_1')
    expect(tabs()[0]?.querySelector('[title]')?.getAttribute('title')).toContain('doris')
  })

  it('creates a tab, keeps each console’s SQL, and closes back down', async () => {
    await mount(apiDouble())

    type('SELECT 1')
    click(container.querySelector('[aria-label="新建查询标签"]'))
    expect(tabs()).toHaveLength(2)
    expect(sqlText()).toBe('')

    type('SELECT 2')
    click(tabs()[0])
    expect(sqlText()).toBe('SELECT 1')

    click(container.querySelector('[aria-label="关闭 console_1"]'))
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]?.textContent).toContain('console_2')
  })

  it('switches the active connection when a tab belongs to another one', async () => {
    const api = apiDouble()
    await mount(api)

    click(container.querySelector('[aria-label="新建查询标签"]'))
    // Bind the second tab to the other connection through the connection bar.
    const select = container.querySelector('select[id="sql-workbench-connection"]') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, connB)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    click(tabs()[0])
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.setActive).toHaveBeenCalled()
  })

  // Reported 2026-10-19: "我在 console2 执行的查询结果还是在 console1 的查询区页面".
  // The write used to resolve against whichever tab was active when the response
  // arrived, so switching consoles mid-flight moved the rows.
  it('keeps a slow result in the console that started the run', async () => {
    let release: (value: unknown) => void = () => undefined
    const pending = new Promise<unknown>(resolve => {
      release = resolve
    })
    const api = apiDouble({
      execute: vi.fn(async () => (await pending) as never),
    })
    await mount(api)

    click(container.querySelector('[aria-label="新建查询标签"]'))
    type('SELECT slow')
    click(container.querySelector('[aria-label="执行"]'))

    // Still in flight: the user moves back to console_1.
    click(tabs()[0])
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      release({
        ok: true,
        columns: [{ name: 'n', typeName: 'INT' }],
        rows: [[4242]],
        total: 1,
        hasNextPage: false,
        offset: 0,
        durationMs: 5,
        statementId: 'ui-1',
      })
      await pending
      await Promise.resolve()
      await Promise.resolve()
    })

    // console_1 never ran anything, so it must stay empty.
    expect(container.textContent).not.toContain('4242')

    click(tabs()[1])
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('4242')
  })

  it('follows the surviving console’s connection when the active one is closed', async () => {
    const api = apiDouble()
    await mount(api)

    click(container.querySelector('[aria-label="新建查询标签"]'))
    const select = container.querySelector('select[id="sql-workbench-connection"]') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, connB)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Back to console_1, then close it: the neighbour lives on zanmal_read, so
    // the bar has to follow or the next run looks like it went to doris.
    click(tabs()[0])
    await act(async () => {
      await Promise.resolve()
    })
    const calls = (api.setActive as unknown as { mock: { calls: [string][] } }).mock.calls
    const before = calls.length

    click(container.querySelector('[aria-label="关闭 console_1"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(calls.length).toBeGreaterThan(before)
    expect(calls[calls.length - 1]?.[0]).toBe(connB)
  })

  it('runs a console against its own connection, not the globally selected one', async () => {
    const api = apiDouble()
    await mount(api)

    // console_2 is opened on doris, then rebound to zanmal_read via the toolbar.
    click(container.querySelector('[aria-label="新建查询标签"]'))
    const select = container.querySelector('select[id="sql-workbench-connection"]') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, connB)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Back to console_1 (still doris) and run there.
    click(tabs()[0])
    await act(async () => {
      await Promise.resolve()
    })
    type('SELECT 1')
    click(container.querySelector('[aria-label="执行"]'))
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.execute).toHaveBeenCalledTimes(1)
    expect((api.execute as unknown as { mock: { calls: [{ connId: string }][] } }).mock.calls[0]?.[0].connId).toBe(connA)
  })
})
