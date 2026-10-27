// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { SchemaSnapshot } from '../src/host/metadata.ts'
import { createDataSource } from '../src/datasource/model.ts'
import { readSql } from './support/editor.ts'
import { findButtonText } from './support/labeled.ts'

const connA = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connA, name: 'doris', dbms: 'doris', host: 'h1', username: 'u' })

const snapshot: SchemaSnapshot = {
  fetchedAt: '2026-10-19T00:00:00.000Z',
  truncated: false,
  source: 'information_schema',
  tables: [
    { schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] },
    { schema: 'dwd', kind: 'view', name: 'v_daily', columns: [{ name: 'day', type: 'DATE' }] },
  ],
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
  vi.restoreAllMocks()
})

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connA),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => doris),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => snapshot),
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

const click = (element: Element | null | undefined): void => {
  if (element === null || element === undefined) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const rightClick = (element: Element | null | undefined): void => {
  if (element === null || element === undefined) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
  })
}

/** Open the object browser and right-click the table node. */
async function openTree(api: WorkbenchApi): Promise<void> {
  await mount(api)
  await act(async () => {
    await Promise.resolve()
  })
  rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
}

const menuItem = (id: string): HTMLElement | null =>
  container.querySelector(`[data-sql-menu-item="${id}"]`) as HTMLElement | null

const executeMock = (api: WorkbenchApi): { mock: { calls: [{ sql: string; connId: string }][] } } =>
  api.execute as unknown as { mock: { calls: [{ sql: string; connId: string }][] } }

describe('panel object browser', () => {
  it('shows the hierarchy and summarises库/对象/视图 in the toolbar', async () => {
    await mount(apiDouble())
      await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()
    expect(container.querySelector('[data-sql-schema="dwd"]')).not.toBeNull()
    expect(container.textContent).toContain('数据源 · doris')
    const summary = container.querySelector('[data-sql-panel-meta="objects"]')
    expect(summary?.textContent).toContain('2 个对象')
    expect(summary?.textContent).toContain('含 1 视图')
  })

  it('runs Edit Data into the console that opened it', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: true as const,
        columns: [{ name: 'order_id', typeName: 'BIGINT' }],
        rows: [[1]],
        total: 1,
        hasNextPage: false,
        offset: 0,
        durationMs: 3,
        statementId: 's1',
      })),
    })
    await openTree(api)

    await act(async () => {
      menuItem('data')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const call = executeMock(api).mock.calls[0]?.[0]
    expect(call?.sql).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 100')
    expect(call?.connId).toBe(connA)
    expect(readSql(container)).toBe('SELECT * FROM `dwd`.`dwd_order` LIMIT 100')
  })

  it('shows the DDL of the object through Go to DDL', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: true as const,
        columns: [{ name: 'Table', typeName: 'VARCHAR' }, { name: 'Create Table', typeName: 'VARCHAR' }],
        rows: [['dwd_order', 'CREATE TABLE `dwd_order` (order_id BIGINT)']],
        total: 1,
        hasNextPage: false,
        offset: 0,
        durationMs: 4,
        statementId: 'ddl',
      })),
    })
    await openTree(api)

    await act(async () => {
      menuItem('ddl')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(executeMock(api).mock.calls[0]?.[0].sql).toBe('SHOW CREATE TABLE `dwd`.`dwd_order`')
    // The DDL opens in its own console tab, the way DataGrip's Go to DDL does.
    const tab = [...container.querySelectorAll('[role="tab"]')].at(-1)
    expect(tab?.textContent).toContain('ddl_dwd_order')
    expect(readSql(container)).toBe('CREATE TABLE `dwd_order` (order_id BIGINT)')
    // Reading a DDL must not run it: the grid stays idle.
    expect(container.querySelector('[data-grid-state]')?.getAttribute('data-grid-state')).not.toBe('loading')
  })

  it('turns a transport-thrown refusal into a readable sentence', async () => {
    // The HTTP transport throws on 5xx instead of returning `ok:false`; the DDL
    // dialog must still explain a denied SHOW VIEW in words (users saw
    // `INTERNAL: errCode = 2, detailMessage = …` before).
    const api = apiDouble({
      execute: vi.fn(async () => {
        throw new Error("INTERNAL: errCode = 2, detailMessage = SHOW CREATE TABLE command denied to user 'ai_reader'@'172.26.200.108' for table 'dwd: dwd_trade_order_all_v'")
      }),
    })
    await openTree(api)

    await act(async () => {
      menuItem('ddl')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const notice = container.querySelector('[data-sql-notice]')
    const text = notice?.textContent ?? ''
    expect(text).toContain('没有查看 dwd.dwd_trade_order_all_v 的权限')
    expect(text).toContain('ai_reader')
    expect(text).not.toContain('errCode')
  })

  it('warns instead of stacking a 9th tab, and the notice can be dismissed', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: true as const,
        columns: [{ name: 'Table', typeName: 'VARCHAR' }, { name: 'Create Table', typeName: 'VARCHAR' }],
        rows: [['dwd_order', 'CREATE TABLE `dwd_order` (id BIGINT)']],
        total: 1,
        hasNextPage: false,
        offset: 0,
        durationMs: 1,
        statementId: 'ddl',
      })),
    })
    await openTree(api)

    // Fill the strip to MAX_TABS (8) through the UI, then ask for a DDL.
    for (let index = 0; index < 7; index += 1) {
      act(() => {
        container.querySelector('[aria-label="新建查询标签"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(8)
    // The menu has to be re-opened: creating a tab re-renders the tree.
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    expect(menuItem('ddl')).not.toBeNull()

    await act(async () => {
      menuItem('ddl')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const notice = container.querySelector('[data-sql-notice]')
    expect(notice?.textContent).toContain('标签已满')
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(8)

    act(() => {
      notice?.querySelector('[aria-label="关闭提示"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-sql-notice]')).toBeNull()
  })

  it('surfaces a refusal from the database', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'DENIED', message: '没有 SHOW 权限' } })),
    })
    await openTree(api)

    await act(async () => {
      menuItem('ddl')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('没有 SHOW 权限')
  })

  it('says so when the database returns an empty DDL', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: true as const,
        columns: [{ name: 'Table', typeName: 'VARCHAR' }],
        rows: [['dwd_order']],
        total: 1,
        hasNextPage: false,
        offset: 0,
        durationMs: 2,
        statementId: 'ddl',
      })),
    })
    await openTree(api)

    await act(async () => {
      menuItem('ddl')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    // `SHOW CREATE` echoed the name only: that is not a statement, so say so.
    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('数据库没有返回 DDL')
  })

  it('drops the data-source caption when the connection behind the tab is gone', async () => {
    const zanmal = createDataSource({ id: 'b1', name: 'zanmal_read', dbms: 'mysql', host: 'h2', username: 'u' })
    const api = apiDouble({
      // Two sources at load; deleting doris leaves the tab pointing at a ghost.
      list: vi.fn()
        .mockResolvedValueOnce([doris, zanmal])
        .mockResolvedValue([zanmal]),
      remove: vi.fn(async () => true),
    })
    await mount(api)
      await act(async () => {
      await Promise.resolve()
    })
    expect(container.querySelector('[data-sql-schema-root]')?.textContent).toContain('doris')

    click(findButtonText('配置'))
    await act(async () => {
      await Promise.resolve()
    })
    click([...container.querySelectorAll('button')].find(button => button.textContent === '删除'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.remove).toHaveBeenCalledWith(connA)
    // The tab still renders its tree, but it can no longer name its data source.
    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()
    expect(container.querySelector('[data-sql-schema-root]')).toBeNull()
  })

  it('copies a reference through the clipboard port', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await openTree(apiDouble())

    act(() => {
      menuItem('copy')?.click()
    })

    expect(writeText).toHaveBeenCalledWith('`dwd`.`dwd_order`')
  })
})
