// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { readSql, setSql } from './support/editor.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'

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

const page: ExecuteResponse = {
  columns: [{ name: 'id', typeName: 'LONG' }],
  rows: [[1]],
  total: 1,
  hasNextPage: false,
  offset: 0,
  durationMs: 2,
  statementId: 'st-1',
}

function apiDouble(): WorkbenchApi {
  return {
    list: vi.fn(async () => [
      {
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
      },
    ]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => ({}) as never),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: true as const, ...page })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({
      tables: [
        {
          schema: 'dwd',
          kind: 'table' as const,
          name: 'dwd_order',
          columns: [{ name: 'order_id', type: 'BIGINT' }],
        },
      ],
      fetchedAt: 'x',
      truncated: false,
      source: 'information_schema' as const,
    })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
  } as unknown as WorkbenchApi
}

async function mount(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const pressOnWindow = (init: KeyboardEventInit, target: EventTarget = window): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

const type = (label: string, value: string): void => {
  const input = byLabel(label) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('panel: command palette (SQL-213)', () => {
  it('opens on Ctrl+Shift+P and runs 格式化', async () => {
    await mount(apiDouble())
    act(() => {
      setSql(container, 'select order_id from t')
    })
    pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[data-command-palette]')).not.toBeNull()

    type('搜索命令', '格式化')
    pressOnWindow({ key: 'Enter' }, byLabel('搜索命令') as EventTarget)
    expect(readSql(container)).toContain('SELECT')
    expect(container.querySelector('[data-command-palette]')).toBeNull()
  })

  it('ignores the chord while a plain input has focus and closes on Esc', async () => {
    await mount(apiDouble())
    const input = document.createElement('input')
    container.append(input)
    pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true }, input)
    expect(container.querySelector('[data-command-palette]')).toBeNull()

    pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true })
    pressOnWindow({ key: 'Escape' }, byLabel('搜索命令') as EventTarget)
    expect(container.querySelector('[data-command-palette]')).toBeNull()
  })
})

describe('panel: global object search (SQL-214)', () => {
  it('opens on Ctrl+Shift+O and inserts the picked table', async () => {
    await mount(apiDouble())
    pressOnWindow({ key: 'o', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[data-object-search]')).not.toBeNull()

    type('搜索表或列', 'dwd_order')
    pressOnWindow({ key: 'Enter' }, byLabel('搜索表或列') as EventTarget)
    await act(async () => {
      await Promise.resolve()
    })
    expect(readSql(container)).toContain('`dwd`.`dwd_order`')
  })

  it('inserts a picked column and closes', async () => {
    await mount(apiDouble())
    pressOnWindow({ key: 'o', ctrlKey: true, shiftKey: true })
    type('搜索表或列', 'order_id')
    const row = container.querySelector('[data-object-id="dwd_order.order_id"]')
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(readSql(container)).toContain('order_id')
    expect(container.querySelector('[data-object-search]')).toBeNull()
  })

  it('still opens before the schema has loaded', async () => {
    const api = apiDouble()
    ;(api.schema as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => undefined))
    await mount(api)
    pressOnWindow({ key: 'o', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[data-object-search]')).not.toBeNull()
    expect(container.textContent).toContain('输入表名或列名开始搜索')
  })
})

describe('panel: every palette command runs (SQL-213)', () => {
  const runCommand = async (id: string): Promise<void> => {
    pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true })
    const item = container.querySelector(`[data-command-id="${id}"]`)
    expect(item).not.toBeNull()
    act(() => {
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('dispatches run/rerun/format/expand/explain/history/object-search', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'select 1')
    })
    act(() => {
      byLabel('执行')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    await runCommand('run-statement')
    await runCommand('run-all')
    await runCommand('rerun')
    await runCommand('format')
    await runCommand('expand-star')
    expect(container.textContent).toContain('无法展开')
    await runCommand('explain')

    await runCommand('history')
    expect(container.querySelector('[data-sql-history-overlay]')).not.toBeNull()
    act(() => {
      byLabel('关闭历史面板')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await runCommand('object-search')
    expect(container.querySelector('[data-object-search]')).not.toBeNull()
    pressOnWindow({ key: 'Escape' }, byLabel('搜索表或列') as EventTarget)
    expect(container.querySelector('[data-object-search]')).toBeNull()

    await runCommand('agent-explain')
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('请解释下面这条 SQL'))
    expect(container.textContent).toContain('已复制解释请求')
    await runCommand('agent-optimize')
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls.at(-1)?.[0]).toContain('请审查下面这条 SQL')

    await runCommand('help')
    expect(container.querySelector('[data-shortcuts-help]')).not.toBeNull()
    act(() => {
      byLabel('关闭快捷键说明')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(api.execute).toHaveBeenCalled()
  })

  it('opens the shortcut sheet with ? and closes on Esc', async () => {
    await mount(apiDouble())
    pressOnWindow({ key: '?' })
    expect(container.querySelector('[data-shortcuts-help]')).not.toBeNull()
    pressOnWindow({ key: 'Escape' }, container.querySelector('[data-shortcuts-overlay]') as EventTarget)
    expect(container.querySelector('[data-shortcuts-help]')).toBeNull()
  })

  it('toggles inline diagnostics from the palette (SQL-309)', async () => {
    await mount(apiDouble())
    await runCommand('lint-toggle')
    expect(container.textContent).toContain('诊断已关闭')
    await runCommand('lint-toggle')
    expect(container.textContent).toContain('诊断已开启')
  })

  it('cycles the formatting keyword case (SQL-209)', async () => {
    await mount(apiDouble())
    await runCommand('format-case')
    expect(container.textContent).toContain('格式化关键字：小写')
    await runCommand('format-case')
    expect(container.textContent).toContain('格式化关键字：保持原样')
    await runCommand('format-case')
    expect(container.textContent).toContain('格式化关键字：大写')
  })
})
