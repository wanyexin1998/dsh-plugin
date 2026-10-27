// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { readSql } from './support/editor.ts'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { ConnectionDraft, WorkbenchApi } from '../src/client/api.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris.shcell.com', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' })

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

/** Let pending effects and promises settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Drive a controlled input the way a user would. */
function fill(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function click(element: Element | undefined | null): void {
  if (element === undefined || element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byText = (selector: string, text: string): HTMLElement | undefined => {
  const match = (root: ParentNode): HTMLElement | undefined =>
    [...root.querySelectorAll(selector)].find(node => node.textContent?.includes(text) === true) as HTMLElement | undefined
  const direct = match(document)
  if (direct !== undefined) return direct
  const opener = document.querySelector('[aria-label="连接操作"]')
  if (opener === null || opener.getAttribute('aria-expanded') === 'true') return undefined
  act(() => {
    opener.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return match(document)
}

function apiDouble(overrides: Partial<WorkbenchApi> = {}) {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async (draft: ConnectionDraft) =>
      createDataSource({ id: connId, name: draft.name, dbms: draft.dbms, host: draft.host, port: draft.port, username: draft.username }),
    ),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 12 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'execute' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'NOT_STUBBED', message: 'fetchPage' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  }
}

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

describe('panel against a live host double', () => {
  it('loads, tests, creates, edits and deletes a connection', async () => {
    const api = apiDouble()
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await settle()

    expect(container.querySelector('[data-phase="ready"]')).not.toBeNull()
    expect(byText('option', 'doris.shcell.com')).toBeDefined()

    // Test the active connection and see the verdict land in the bar.
    click(byText('button', '测试连接'))
    await settle()
    expect(api.test).toHaveBeenCalledWith(connId)
    expect(byText('span', '连接成功')).toBeDefined()

    // Switch the selection.
    const select = container.querySelector('select') as HTMLSelectElement
    fill(select, connId)
    await settle()

    // Create a connection through the dialog.
    click(byText('button', '新建'))
    await settle()
    const inputs = [...container.querySelectorAll('.ConnectionDialog input, [role="dialog"] input')] as HTMLInputElement[]
    const textInputs = inputs.filter(input => input.type === 'text' || input.type === '')
    fill(textInputs[0]!, 'new-conn')
    fill(textInputs[1]!, 'new-host')
    fill(textInputs[2]!, '9031')
    fill(textInputs[3]!, 'dwd')
    fill(textInputs[4]!, 'wanyexin')
    click(byText('button', '保存'))
    await settle()
    expect(api.save).toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    // Edit it and delete it.
    click(byText('button', '配置'))
    await settle()
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    click(byText('button', '删除'))
    await settle()
    expect(api.remove).toHaveBeenCalledWith(connId)
  })

  it('shows a field error when the draft is incomplete', async () => {
    const api = apiDouble()
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await settle()

    click(byText('button', '新建'))
    await settle()
    click(byText('button', '保存'))
    await settle()

    expect(container.textContent).toContain('名称不能为空')
    expect(api.save).not.toHaveBeenCalled()

    // 取消 exists in both the editor bar and the dialog; scope to the dialog.
    const dialogCancel = [...container.querySelectorAll('[role="dialog"] button')].find(node => node.textContent?.trim() === '取消')
    click(dialogCancel)
    await settle()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('surfaces a failed load without losing the panel', async () => {
    const api = apiDouble({ list: async () => Promise.reject(new Error('存储不可用')) })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await settle()

    expect(container.querySelector('[data-phase="error"]')).not.toBeNull()
    expect(container.textContent).toContain('存储不可用')
  })
})

describe('dialog controls', () => {
  it('edits the password, both switches and the engine', async () => {
    const api = apiDouble()
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await settle()

    click(byText('button', '配置'))
    await settle()

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    fill(dialog.querySelector('input[type="password"]') as HTMLInputElement, 'hunter2')
    const switches = [...dialog.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    click(switches[0]!)
    click(switches[1]!)
    fill(dialog.querySelector('select') as HTMLSelectElement, 'mysql')

    click(byText('button', '保存'))
    await settle()

    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ password: 'hunter2', writeEnabled: true, dbms: 'mysql' }))
  })
})

describe('panel without a usable connection list', () => {
  it('offers the empty state and a create affordance', async () => {
    const api = apiDouble({ list: async () => [], active: async () => null })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await settle()

    expect(container.textContent).toContain('还没有数据源')
    expect(byText('button', '新建')).toBeDefined()

    click(byText('button', '新建'))
    await settle()

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(byText('button', '删除')).toBeUndefined()
  })
})

describe('panel without a host service', () => {
  it('settles into the unavailable state after the effect runs', async () => {
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" />)
    })
    await settle()

    expect(container.querySelector('[data-phase="unavailable"]')).not.toBeNull()
    expect(container.textContent).toContain('sqlWorkbench')
  })
})

describe('panel with completion metadata', () => {
  it('still renders when the schema read fails', async () => {
    const api = apiDouble({ schema: vi.fn(async () => Promise.reject(new Error('no schema'))) })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-workbench]')).not.toBeNull()
  })
})

describe('panel chrome: splitter and object tree', () => {
  it('resizes the editor block when the splitter is dragged', async () => {
    const api = apiDouble({
      list: async () => [doris],
      active: async () => connId,
      schema: async () => ({
        tables: [{ name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
        fetchedAt: '2026-10-19T00:00:00.000Z',
        truncated: false,
        source: 'information_schema',
      }),
    })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const column = container.querySelector('[data-sql-pane-column]') as HTMLElement
    // Two sashes now: the vertical one sizes the rail, the horizontal one the editor.
    const splitter = container.querySelector('[data-sql-splitter="horizontal"]') as HTMLElement
    const before = column.style.gridTemplateRows

    act(() => {
      splitter.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }))
      splitter.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: 160 }))
      splitter.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })

    // The editor row starts at the component's default and follows the pointer.
    expect(before.startsWith('224px')).toBe(true)
    expect(column.style.gridTemplateRows.startsWith('284px')).toBe(true)
  })

  it('opens the object tree and inserts a column at the caret', async () => {
    const api = apiDouble({
      list: async () => [doris],
      active: async () => connId,
      schema: async () => ({
        tables: [{ name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
        fetchedAt: '2026-10-19T00:00:00.000Z',
        truncated: false,
        source: 'information_schema',
      }),
    })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-panel-meta="objects"]')?.textContent).toContain('1 个对象')

    // The object browser is the left column now, so it is already on screen.
    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()

    const table = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('dwd_order'))
    act(() => {
      table?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(readSql(container)).toContain('dwd_order')
  })

  it('reports a schema failure in the summary line instead of throwing', async () => {
    const api = apiDouble({
      list: async () => [doris],
      active: async () => connId,
      schema: async () => Promise.reject(new Error('没有可用密码')),
    })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-panel-meta="objects"]')?.textContent).toContain('没有可用密码')
  })
})

describe('panel chrome: schema refresh', () => {
  it('re-reads the schema from the tree refresh button', async () => {
    const schema = vi.fn(async () => ({
      tables: [{ name: 'dwd_order', columns: [] }],
      fetchedAt: '2026-10-19T00:00:00.000Z',
      truncated: false,
      source: 'show' as const,
      note: 'SHOW 回退只展开了前 60 张表',
    }))
    const api = apiDouble({ list: async () => [doris], active: async () => connId, schema })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-panel-meta="objects"]')?.textContent).toContain('SHOW')

    click([...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '刷新表结构'))

    await act(async () => {
      await Promise.resolve()
    })
    expect(schema).toHaveBeenLastCalledWith(connId, { refresh: true })
  })
})

describe('panel chrome: degraded schema', () => {
  it('shows a failed refresh and still opens the tree', async () => {
    const schema = vi.fn(async () => Promise.reject(new Error('权限不足')))
    const api = apiDouble({ list: async () => [doris], active: async () => connId, schema })
    await act(async () => {
      root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    click([...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '刷新表结构'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()
    expect(container.querySelector('[data-sql-panel-meta="objects"]')?.textContent).toContain('权限不足')
  })
})
