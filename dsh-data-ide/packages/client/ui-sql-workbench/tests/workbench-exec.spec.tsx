// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import { pressKey, setSql } from './support/editor.ts'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'

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

function fill(input: HTMLTextAreaElement | HTMLSelectElement, value: string): void {
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


const button = (label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label) as HTMLButtonElement | undefined

function page(overrides: Partial<ExecuteResponse> = {}): ExecuteResponse {
  return {
    columns: [{ name: 'id', typeName: 'LONG' }, { name: '订单日期', typeName: 'DATE' }],
    rows: [[103572, new Date('2026-10-17T08:12:33.000Z')], [null, '2026-10-16']],
    total: 900,
    hasNextPage: true,
    offset: 0,
    durationMs: 42,
    statementId: 'ui-1',
    ...overrides,
  }
}

function apiDouble(overrides: Partial<WorkbenchApi> = {}) {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 12 })),
    execute: vi.fn(async () => ({ ok: true as const, ...page() })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page({ offset: 500, hasNextPage: false, total: null }) })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  } as unknown as WorkbenchApi
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

/** Render the panel with a live host double and settle the connection load. */
async function renderPanel(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await settle()
}

describe('editor and grid', () => {
  it('runs the editor contents and renders typed cells', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT id, 订单日期 FROM t')
    })
    click(button('执行'))
    await settle()

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT id, 订单日期 FROM t', connId }))
    const cells = [...container.querySelectorAll('tbody td')].map(node => node.textContent)
    expect(cells).toEqual(['103,572', '2026-10-17 08:12:33', 'NULL', '2026-10-16'])
    expect(container.querySelector('td[data-align="right"]')?.textContent).toBe('103,572')
    expect(container.querySelector('td[data-null]')?.textContent).toBe('NULL')
  })

  it('runs on Ctrl+Enter and cancels on Escape', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT 1')
      pressKey(container, { key: 'Enter', ctrlKey: true, bubbles: true })
    })
    await settle()
    expect(api.execute).toHaveBeenCalledTimes(1)

    // Cmd+Enter is the same shortcut on macOS.
    act(() => {
      pressKey(container, { key: 'Enter', metaKey: true, bubbles: true })
    })
    await settle()
    expect(api.execute).toHaveBeenCalledTimes(2)

    // A bare Enter is just a newline, and Escape with nothing in flight is a no-op.
    act(() => {
      pressKey(container, { key: 'Enter', bubbles: true })
      pressKey(container, { key: 'Escape', bubbles: true })
    })
    await settle()
    expect(api.execute).toHaveBeenCalledTimes(2)
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('keeps 执行 disabled until there is text', async () => {
    const api = apiDouble()
    await renderPanel(api)

    expect(button('执行')?.disabled).toBe(true)

    act(() => {
      setSql(container, '   ')
    })
    expect(button('执行')?.disabled).toBe(true)
  })

  it('shows the error banner for a refusal', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'WRITE_NOT_ALLOWED', message: '只允许 SELECT' } })),
    })
    await renderPanel(api)

    act(() => {
      setSql(container, 'DELETE FROM t')
    })
    click(button('执行'))
    await settle()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('WRITE_NOT_ALLOWED')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('只允许 SELECT')
  })

  it('says so when the query returns no rows', async () => {
    const api = apiDouble({ execute: vi.fn(async () => ({ ok: true as const, ...page({ rows: [], total: 0, hasNextPage: false }) })) })
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT 1 WHERE 1 = 0')
    })
    click(button('执行'))
    await settle()

    expect(container.textContent).toContain('查询成功，没有返回行')
  })
})

describe('pager', () => {
  it('shows the range, offers next/last and pages with the right offset', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    expect(container.querySelector('[data-pager-range]')?.textContent).toBe('第 1-2 行 / 共 900 行')
    expect(container.querySelector('[data-pager-meta]')?.textContent).toContain('2 行 · 42ms')
    expect(button('上一页')?.disabled).toBe(true)

    click(button('下一页'))
    await settle()
    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 500 }))

    // The cached total survives paging, so the range stays honest.
    expect(container.querySelector('[data-pager-range]')?.textContent).toBe('第 501-502 行 / 共 900 行')
    expect(button('上一页')?.disabled).toBe(false)
  })

  it('degrades to 总数未知 when the COUNT failed', async () => {
    const api = apiDouble({ execute: vi.fn(async () => ({ ok: true as const, ...page({ total: null }) })) })
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    expect(container.querySelector('[data-pager-range]')?.textContent).toBe('第 1-2 行 / 总数未知')
    expect(button('末页')?.disabled).toBe(true)
  })

  it('jumps to the last page from a known total', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()
    click(button('末页'))
    await settle()

    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }))
  })

  it('walks back to the first page', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    click(button('下一页'))
    await settle()
    expect(button('上一页')?.disabled).toBe(false)

    click(button('上一页'))
    await settle()
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))

    click(button('首页'))
    await settle()
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('reports an empty page with an unknown total', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: true as const, ...page({ rows: [], total: null, hasNextPage: false }) })),
    })
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    expect(container.querySelector('[data-pager-range]')?.textContent).toBe('没有数据 · 总数未知')
  })

  it('changes the page size for the next request', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    act(() => {
      fill(container.querySelector('select[aria-label="页大小"]') as HTMLSelectElement, '1000')
    })
    click(button('下一页'))
    await settle()

    expect(api.fetchPage).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 1000 }))
  })

  it('reports clipped cells and an empty page honestly', async () => {
    const api = apiDouble({
      execute: vi.fn(async () => ({
        ok: true as const,
        ...page({ rows: [], hasNextPage: false, truncated: { cells: 2 } }),
      })),
    })
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    expect(container.querySelector('[data-pager-range]')?.textContent).toBe('没有数据 · 共 900 行')
    expect(container.querySelector('[data-pager-meta]')?.textContent).toContain('2 个值过大已截断')
  })
})

describe('sorting', () => {
  it('cycles a column header and re-queries page one', async () => {
    const api = apiDouble()
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT * FROM t')
    })
    click(button('执行'))
    await settle()

    const header = (): HTMLButtonElement => [...container.querySelectorAll('th button')][0] as HTMLButtonElement
    expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('none')

    click(header())
    await settle()
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, sort: { column: 'id', direction: 'ASC' } }))
    expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('ascending')
    expect(header().textContent).toContain('▲')

    click(header())
    await settle()
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ sort: { column: 'id', direction: 'DESC' } }))
    expect(header().textContent).toContain('▼')

    click(header())
    await settle()
    expect(api.fetchPage).toHaveBeenLastCalledWith(expect.not.objectContaining({ sort: expect.anything() }))
    expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('none')
  })
})

describe('cancelling', () => {
  it('aborts the statement in flight', async () => {
    let release: ((value: { ok: true } & ExecuteResponse) => void) | undefined
    const api = apiDouble({
      execute: vi.fn(
        () =>
          new Promise<{ ok: true } & ExecuteResponse>(resolve => {
            release = resolve
          }),
      ),
    })
    await renderPanel(api)

    act(() => {
      setSql(container, 'SELECT SLEEP(10)')
    })
    click(button('执行'))
    await settle()

    expect(container.textContent).toContain('正在执行…')
    click(button('取消'))
    await settle()

    expect(api.cancel).toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('CANCELLED')

    release?.({ ok: true, ...page() })
    await settle()
  })
})
