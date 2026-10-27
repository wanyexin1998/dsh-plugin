// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { readSql, setSql } from './support/editor.ts'
import { findLabeled } from './support/labeled.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = {
  id: connId,
  name: 'Doris',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  username: 'u',
  driverProperties: {},
  writeEnabled: false,
  createdAt: 'x',
  updatedAt: 'x',
  lastTestState: 'UNKNOWN',
}

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
  vi.useRealTimers()
})

const page = (): ExecuteResponse => ({
  columns: [{ name: 'id', typeName: 'LONG' }],
  rows: [[1]],
  total: 1,
  hasNextPage: false,
  offset: 0,
  durationMs: 7,
  statementId: 'st-1',
})

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => ({}) as never),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: true as const, ...page() })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page() })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: 'x', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  } as unknown as WorkbenchApi
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mount(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await settle()
  await settle()
}

const click = (element: Element | undefined | null): void => {
  if (element === undefined || element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)

describe('workspace persistence (SQL-201/202)', () => {
  it('restores the stored consoles and caret on mount', async () => {
    const api = apiDouble({
      loadWorkspaceState: vi.fn(async () => ({
        schemaVersion: 1,
        activeDocId: 'stored-1',
        docs: [{ id: 'stored-1', title: '订单排查', connId, sql: 'SELECT 42', pageSize: 1000, cursor: 9 }],
      })),
    })
    await mount(api)

    expect(readSql(container)).toBe('SELECT 42')
    expect(container.textContent).toContain('订单排查')
  })

  it('saves the workspace after the debounce, never result sets', async () => {
    const saveWorkspaceState = vi.fn(async () => undefined)
    const api = apiDouble({ saveWorkspaceState })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT 7')
    })

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 620))
    })

    expect(saveWorkspaceState).toHaveBeenCalled()
    const calls = saveWorkspaceState.mock.calls as unknown as unknown[][]
    const saved = calls.at(-1)?.[0] as { docs?: { sql?: string }[] }
    expect(JSON.stringify(saved)).toContain('SELECT 7')
    expect(JSON.stringify(saved)).not.toContain('"rows"')
  })
})

describe('query history (SQL-203/204/205)', () => {
  it('records a run and opens the drawer', async () => {
    const appendHistory = vi.fn(async () => undefined)
    const api = apiDouble({ appendHistory })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT 1')
    })
    click(byLabel('执行'))
    await settle()

    expect(appendHistory).toHaveBeenCalledWith(expect.objectContaining({ connId, sql: 'SELECT 1', ok: true }))

    click(byLabel('历史'))
    await settle()
    expect(container.querySelector('[data-sql-history-overlay]')).not.toBeNull()
    expect(container.textContent).toContain('SELECT 1')
  })

  it('inserts and replaces from the history drawer', async () => {
    const api = apiDouble({
      loadHistory: vi.fn(async () => ({
        schemaVersion: 1,
        byConn: {
          [connId]: [{ id: 'h1', connId, sql: 'SELECT 99', at: Date.now() - 1000, durationMs: 3, rowCount: 1, ok: true }],
        },
      })),
    })
    await mount(api)
    click(byLabel('历史'))
    await settle()

    const item = container.querySelector('[data-sql-history-item]')
    if (item === null) throw new Error('history row not rendered')
    act(() => {
      item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await settle()
    expect(readSql(container)).toContain('SELECT 99')
  })

  it('pins a history entry as a favorite', async () => {
    const saveFavorites = vi.fn(async () => undefined)
    const api = apiDouble({
      saveFavorites,
      loadHistory: vi.fn(async () => ({
        schemaVersion: 1,
        byConn: {
          [connId]: [{ id: 'h1', connId, sql: 'SELECT 5', at: Date.now() - 500, durationMs: 2, rowCount: 1, ok: true }],
        },
      })),
    })
    await mount(api)
    click(byLabel('历史'))
    await settle()

    click(byLabel('收藏这条查询'))
    await settle()

    expect(saveFavorites).toHaveBeenCalled()
  })

  it('replaces the console SQL from the drawer and closes it', async () => {
    const api = apiDouble({
      loadHistory: vi.fn(async () => ({
        schemaVersion: 1,
        byConn: {
          [connId]: [{ id: 'h1', connId, sql: 'SELECT 77', at: Date.now() - 100, durationMs: 2, rowCount: 1, ok: true }],
        },
      })),
    })
    await mount(api)
    click(byLabel('历史'))
    await settle()

    const replace = container.querySelector('[data-sql-history-replace]')
    click(replace)
    await settle()
    expect(readSql(container)).toContain('SELECT 77')
    expect(container.querySelector('[data-sql-history-overlay]')).toBeNull()

    click(byLabel('历史'))
    await settle()
    click(byLabel('关闭历史面板'))
    await settle()
    expect(container.querySelector('[data-sql-history-overlay]')).toBeNull()
  })

  it('removes a favorite from the favorites tab', async () => {
    const saveFavorites = vi.fn(async () => undefined)
    const api = apiDouble({
      saveFavorites,
      loadFavorites: vi.fn(async () => ({
        schemaVersion: 1,
        entries: [{ id: 'f1', name: '日报', sql: 'SELECT 1', at: Date.now(), connId }],
      })),
    })
    await mount(api)
    click(byLabel('历史'))
    await settle()
    const favoritesTab = container.querySelector('[data-sql-history-tab="favorites"]')
    click(favoritesTab)
    await settle()

    click(byLabel('取消收藏 日报'))
    await settle()

    expect(saveFavorites).toHaveBeenLastCalledWith({ schemaVersion: 1, entries: [] })
  })

  it('keeps the panel usable when the stored workspace cannot be read', async () => {
    const api = apiDouble({
      loadWorkspaceState: vi.fn(async () => {
        throw new Error('store unavailable')
      }),
    })
    await mount(api)

    expect(container.querySelector('[data-sql-workbench]')).not.toBeNull()
    expect(readSql(container)).toBe('')
  })
})
