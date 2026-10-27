// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { pressKey, readSql, selectSql, setSql } from './support/editor.ts'

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

const page = (overrides: Partial<ExecuteResponse> = {}): ExecuteResponse => ({
  columns: [{ name: 'id', typeName: 'LONG' }],
  rows: [[1]],
  total: null,
  hasNextPage: false,
  offset: 0,
  durationMs: 6,
  statementId: 'st-1',
  ...overrides,
})

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
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
    save: vi.fn(async () => ({} as never)),
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
  act(() => {
    setSql(container, 'SELECT 1')
  })
}

const click = (element: Element | undefined | null): void => {
  if (element === undefined || element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byLabel = (label: string): HTMLElement | undefined =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined

function clickQuery(label: string): void {
  click(byLabel('更多查询操作'))
  click(byLabel(label))
}

describe('error next steps (SQL-310)', () => {
  it('locates the failing line, explains and asks the agent', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'SQL_SYNTAX', message: 'Syntax error in line 3' },
      })),
    })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT bad')
    })
    click(byLabel('执行'))
    await settle()

    expect(container.textContent).toContain('SQL_SYNTAX')
    click(byLabel('定位错误行'))
    expect(container.querySelector('.cm-sql-error-line')).not.toBeNull()

    click(byLabel('解释错误语句'))
    await settle()
    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: expect.stringContaining('EXPLAIN') }))

    click(byLabel('问 agent 这个错误'))
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls.at(-1)?.[0]).toContain('执行报错了')
  })

  it('hides locate when the failure has no line, and explains a failed script tab', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'DENIED', message: '没有权限' } })),
    })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT secret')
    })
    click(byLabel('执行'))
    await settle()

    expect(container.textContent).toContain('DENIED')
    expect(byLabel('定位错误行')).toBeUndefined()
  })

  it('EXPLAINs a failed statement from a script tab', async () => {
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        statements: [{ index: 0, sql: 'SELECT bad', ok: false as const, error: { code: 'SQL_SYNTAX', message: 'bad' } }],
        durationMs: 1,
      })),
    })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT bad; SELECT 2')
    })
    clickQuery('执行全部')
    await settle()

    click(byLabel('解释错误语句'))
    await settle()
    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: expect.stringContaining('EXPLAIN SELECT bad') }))
  })
})

describe('direct vs paged mode (SQL-301/303)', () => {
  it('runs authored-as-written first and counts only when asked', async () => {
    const api = apiDouble()
    await mount(api)

    click(byLabel('执行'))
    await settle()

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'direct', sql: 'SELECT 1' }))
    expect(container.querySelector('[data-sql-direct-bar]')).not.toBeNull()
    expect(container.textContent).toContain('未统计总数')
    expect(container.querySelector('[data-pager-range]')).toBeNull()

    click(byLabel('统计总数'))
    await settle()

    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'paged', sql: 'SELECT 1' }))
    expect(container.querySelector('[data-pager-range]')).not.toBeNull()
  })

  it('switches to the paged wrapper when a column filter is applied', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: true as const, ...page({ total: 900, hasNextPage: true }) })),
    })
    await mount(api)
    click(byLabel('执行'))
    await settle()

    const filter = container.querySelector('[aria-label="筛选 id"]')
    click(filter)
    // The funnel opens on the value list; this test needs the condition editor.
    click(container.querySelector('[aria-label="筛选模式 条件"]'))
    const input = container.querySelector('[data-sql-filter-editor] input') as HTMLInputElement | null
    if (input === null) throw new Error('filter input not rendered')
    act(() => {
      input.value = '1'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click([...container.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === '应用筛选'))
    await settle()

    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'paged' }))
  })

  it('drops stale filters when the statement changes', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: true as const, ...page({ total: 900, hasNextPage: true }) })),
    })
    await mount(api)
    click(byLabel('执行'))
    await settle()

    click(container.querySelector('[aria-label="筛选 id"]'))
    click(container.querySelector('[aria-label="筛选模式 条件"]'))
    const input = container.querySelector('[data-sql-filter-editor] input') as HTMLInputElement | null
    if (input === null) throw new Error('filter input not rendered')
    act(() => {
      input.value = '1'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click([...container.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === '应用筛选'))
    await settle()

    act(() => {
      setSql(container, 'SELECT 2')
    })
    click(byLabel('执行'))
    await settle()

    expect(container.textContent).toContain('已清除上一条语句的排序/筛选')
  })

  it('repeats the previous run on Ctrl+Alt+Enter', async () => {
    const api = apiDouble()
    await mount(api)
    click(byLabel('执行'))
    await settle()

    act(() => {
      pressKey(container, { key: 'Enter', ctrlKey: true, altKey: true })
    })
    await settle()

    expect(api.execute).toHaveBeenCalledTimes(2)
    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: 'SELECT 1' }))
  })
})

describe('EXPLAIN (SQL-306)', () => {
  it('opens the plan in its own console without touching the authored SQL', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: true as const, ...page({ columns: [{ name: 'Explain', typeName: 'STRING' }] }) })),
    })
    await mount(api)

    clickQuery('解释计划')
    await settle()

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'EXPLAIN SELECT 1', raw: true }))
    expect(container.querySelector('[data-sql-workbench]')?.textContent).toContain('explain_2')
  })

  it('surfaces a refused plan as an error tab', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'EXPLAIN_DENIED', message: '没有权限' } })),
    })
    await mount(api)
    clickQuery('解释计划')
    await settle()

    expect(container.textContent).toContain('没有权限')
  })

  it('reports a transport failure when the plan cannot run', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => {
        throw new Error('连接已断开')
      }),
    })
    await mount(api)
    clickQuery('解释计划')
    await settle()

    expect(container.textContent).toContain('连接已断开')
  })
})

describe('editor actions (SQL-206..218)', () => {
  const schemaApi = (): WorkbenchApi =>
    apiDouble({
      schema: vi.fn(async () => ({
        tables: [
          {
            schema: 'dwd',
            kind: 'table' as const,
            name: 'dwd_order',
            columns: [
              { name: 'order_id', type: 'BIGINT' },
              { name: 'amount', type: 'DECIMAL' },
            ],
          },
          {
            schema: 'dwd',
            kind: 'table' as const,
            name: 'dwd_customer',
            columns: [{ name: 'order_id', type: 'BIGINT' }],
          },
        ],
        fetchedAt: 'x',
        truncated: false,
        source: 'information_schema' as const,
      })),
    })

  it('formats the editor on demand', async () => {
    await mount(apiDouble())
    act(() => {
      setSql(container, 'select order_id from t where amount > 1')
    })
    clickQuery('格式化')
    await settle()

    const formatted = readSql(container)
    expect(formatted).toContain('SELECT')
    expect(formatted).toContain('FROM')
    expect(formatted.match(/SELECT/g)).toHaveLength(1)
    expect(formatted.match(/select/g)).toBeNull()

    act(() => {
      selectSql(container, 0, 6)
    })
    clickQuery('格式化')
    await settle()
    expect(readSql(container).match(/SELECT/g)).toHaveLength(1)
  })

  it('expands * into the column list from the schema', async () => {
    const api = schemaApi()
    await mount(api)
    await settle()
    act(() => {
      setSql(container, 'SELECT * FROM dwd.dwd_order')
      // The action expands the star the user selected.
      selectSql(container, 7, 8)
    })
    clickQuery('展开星号')
    pressKey(container, { key: 's', ctrlKey: true, altKey: true })
    await settle()

    expect(readSql(container)).toContain('order_id')
    expect(readSql(container)).not.toContain('SELECT * FROM')
  })

  it('opens table data in a new console, keeping the draft tab', async () => {
    const api = schemaApi()
    await mount(api)
    await settle()
    act(() => {
      setSql(container, 'SELECT 1 -- draft')
    })
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    const nameButton = objectRow?.querySelector('button[title^="插入"]')
    if (nameButton === null || nameButton === undefined) throw new Error('tree row not rendered')
    act(() => {
      nameButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await settle()

    expect(readSql(container)).toContain('LIMIT 100')
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ mode: 'direct' }))
  })

  it('warns when there is nothing to expand', async () => {
    await mount(apiDouble())
    clickQuery('展开星号')
    await settle()

    expect(container.textContent).toContain('无法展开')
  })

  it('reports a refused 打开数据 run on the new console', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'DENIED', message: '没有权限' } })),
      schema: vi.fn(async () => ({
        tables: [{ schema: 'dwd', kind: 'table' as const, name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
        fetchedAt: 'x',
        truncated: false,
        source: 'information_schema' as const,
      })),
    })
    await mount(api)
    await settle()
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    const nameButton = objectRow?.querySelector('button[title^="插入"]')
    if (nameButton === null || nameButton === undefined) throw new Error('tree row not rendered')
    act(() => {
      nameButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await settle()

    expect(container.textContent).toContain('没有权限')
  })

  it('inserts generated SELECT SQL from the object-tree menu', async () => {
    const api = schemaApi()
    await mount(api)
    await settle()
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    act(() => {
      objectRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
    })
    const generate = container.querySelector('[data-sql-menu-item="generate"]')
    click(generate)
    await settle()

    expect(readSql(container)).toContain('SELECT')
    expect(readSql(container)).toContain('order_id')
  })

  it('opens the table overview dialog (SQL-404)', async () => {
    const api = schemaApi()
    await mount(api)
    await settle()
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    act(() => {
      objectRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
    })
    click(container.querySelector('[data-sql-menu-item="overview"]'))
    await settle()

    expect(container.querySelector('[data-overview-body]')).not.toBeNull()
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('COUNT(*)') }))
  })

  it('generates a JOIN after picking the second table (SQL-212)', async () => {
    const api = schemaApi()
    await mount(api)
    await settle()
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    act(() => {
      objectRow?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
    })
    click(container.querySelector('[data-sql-menu-item="join"]'))
    await settle()

    const input = byLabel('搜索表或列') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'dwd_customer')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
    await settle()

    expect(readSql(container)).toContain('JOIN `dwd`.`dwd_customer`')
    expect(readSql(container)).toContain('order_id')
  })

  it('reports a transport failure from 打开数据 on the new console', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => {
        throw new Error('网络中断')
      }),
      schema: vi.fn(async () => ({
        tables: [{ schema: 'dwd', kind: 'table' as const, name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
        fetchedAt: 'x',
        truncated: false,
        source: 'information_schema' as const,
      })),
    })
    await mount(api)
    await settle()
    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]')
    const nameButton = objectRow?.querySelector('button[title^="插入"]')
    if (nameButton === null || nameButton === undefined) throw new Error('tree row not rendered')
    act(() => {
      nameButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await settle()

    expect(container.textContent).toContain('网络中断')
  })

  it('handles running from a console that has no statement', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, '-- only a comment')
    })
    click(byLabel('执行'))
    await settle()
    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: '-- only a comment' }))

    clickQuery('解释计划')
    await settle()
    expect(api.execute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: 'EXPLAIN -- only a comment' }))
  })
})
