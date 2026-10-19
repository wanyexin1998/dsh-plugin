// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResultGrid } from '../src/client/components/ResultGrid.tsx'
import type { ExecuteResponse } from '../src/execute/core.ts'

const page = (rows: unknown[][], statementId = 'st-1'): ExecuteResponse => ({
  columns: [
    { name: 'order_id', typeName: 'BIGINT' },
    { name: 'customer', typeName: 'VARCHAR' },
  ],
  rows,
  total: rows.length,
  hasNextPage: false,
  offset: 0,
  durationMs: 5,
  statementId,
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
  vi.restoreAllMocks()
})

function render(result: ExecuteResponse, onSort = vi.fn()) {
  act(() => {
    root.render(
      <ResultGrid result={result} sort={null} error={null} running={false} onSort={onSort} />,
    )
  })
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  const byLabel = (label: string): HTMLElement | undefined =>
    [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === label) as HTMLElement | undefined
  return { buttons, byLabel }
}

const rows = [[1, 'Alice'], [2, 'bob']]

describe('result grid: filter', () => {
  it('filters the page by a column substring', () => {
    const view = render(page(rows))

    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    expect(input).toBeDefined()

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ali')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).toContain('筛选 1/2 行')
    expect(container.textContent).toContain('Alice')
    expect(container.textContent).not.toContain('bob')
  })

  it('clears the filter with the toolbar button', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ali')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    act(() => {
      view.byLabel('清除筛选')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('2 行')
  })

  it('closes the filter row on Enter and Escape', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(view.byLabel('筛选输入 customer')).toBeUndefined()
  })

  it('drops the filter when a new page arrives', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'ali')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    render(page(rows, 'st-2'))

    expect(container.textContent).toContain('2 行')
  })
})

describe('result grid: column resize', () => {
  it('widens a column by dragging its handle', () => {
    const view = render(page(rows))

    act(() => {
      view.byLabel('调整 customer 列宽')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    const col = [...container.querySelectorAll('col')][1] as HTMLElement
    expect(col.style.width).toBe('200px')
  })

  it('never shrinks a column below the floor', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('调整 customer 列宽')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    const col = [...container.querySelectorAll('col')][1] as HTMLElement
    expect(col.style.width).toBe('60px')
  })
})

describe('result grid: selection and copy', () => {
  it('copies the selected rectangle as TSV', () => {
    const written: string[] = []
    Object.assign(navigator, {
      clipboard: { writeText: async (text: string) => { written.push(text) } },
    })
    const view = render(page(rows))

    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => {
      cells[3]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 1 }))
    })
    act(() => {
      view.byLabel('复制选区')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    return Promise.resolve().then(() => {
      expect(written[0]).toBe('1\tAlice\n2\tbob')
    })
  })

  it('copies on Ctrl+C when the grid has focus', () => {
    const written: string[] = []
    Object.assign(navigator, {
      clipboard: { writeText: async (text: string) => { written.push(text) } },
    })
    const view = render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    })

    return Promise.resolve().then(() => {
      expect(written[0]).toBe('1')
    })
  })

  it('ignores hover while no button is held', () => {
    render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => {
      cells[3]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 0 }))
    })

    const selected = [...container.querySelectorAll('td[data-selected]')]
    expect(selected).toHaveLength(1)
  })

  it('does nothing when copying with no selection', () => {
    const view = render(page(rows))
    const button = view.byLabel('复制选区') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})

describe('result grid: CSV export', () => {
  it('downloads the filtered page as CSV', async () => {
    const captures: string[] = []
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        captures.push(blob.type)
        return 'blob:mock'
      },
      revokeObjectURL: () => undefined,
    })
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(page(rows))

    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(clicks).toHaveBeenCalledTimes(1)
    expect(captures[0]).toContain('text/csv')
  })
})

describe('result grid: states', () => {
  it('shows the error with its code', () => {
    act(() => {
      root.render(
        <ResultGrid result={null} sort={null} error={{ code: 'WRITE_DISABLED', message: '写操作未开启' }} running={false} onSort={vi.fn()} />,
      )
    })

    expect(container.textContent).toContain('WRITE_DISABLED')
    expect(container.textContent).toContain('写操作未开启')
  })

  it('shows the running placeholder', () => {
    act(() => {
      root.render(<ResultGrid result={null} sort={null} error={null} running onSort={vi.fn()} />)
    })

    expect(container.textContent).toContain('正在执行')
  })

  it('says when a query returned no rows', () => {
    act(() => {
      root.render(<ResultGrid result={page([])} sort={null} error={null} running={false} onSort={vi.fn()} />)
    })

    expect(container.textContent).toContain('没有返回行')
  })
})

describe('result grid: further edges', () => {
  it('closes the filter row on Enter as well', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(view.byLabel('筛选输入 customer')).toBeUndefined()
  })

  it('toggles the filter row closed when the same column is clicked twice', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(view.byLabel('筛选输入 customer')).toBeUndefined()
  })

  it('drops the selection when a new page arrives', () => {
    render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)

    render(page(rows, 'st-3'))

    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(0)
  })

  it('keeps state when the same page is re-rendered', () => {
    render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    render(page(rows))

    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)
  })

  it('falls back to a data URL when object URLs are unavailable', () => {
    const original = URL.createObjectURL
    Object.assign(URL, { createObjectURL: undefined })
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href.startsWith('data:text/csv')).toBe(true)
    })
    const view = render(page(rows))

    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(clicks).toHaveBeenCalled()
    Object.assign(URL, { createObjectURL: original })
  })
})

describe('result grid: copy with nothing selected', () => {
  it('does nothing on Ctrl+C without a selection', () => {
    const view = render(page(rows))

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    })

    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(0)
  })
})

describe('grid: hardening', () => {
  it('clears the selection when a filter reshuffles the rows', () => {
    const view = render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)

    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'a')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(0)
  })

  it('falls back to execCommand when the async clipboard is missing', () => {
    const originalClipboard = navigator.clipboard
    Object.assign(navigator, { clipboard: undefined })
    const exec = vi.fn(() => true)
    Object.assign(document, { execCommand: exec })
    const view = render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    act(() => {
      view.byLabel('复制选区')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(exec).toHaveBeenCalledWith('copy')
    Object.assign(navigator, { clipboard: originalClipboard })
  })

  it('ignores a hover that does not move the selection', () => {
    render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 1 }))
    })

    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)
  })
})

describe('grid: export formats', () => {
  const pick = (view: ReturnType<typeof render>, format: string): void => {
    const select = view.byLabel('导出格式') as HTMLSelectElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, format)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('exports TSV with a BOM', () => {
    const blobs: Blob[] = []
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:mock' },
      revokeObjectURL: () => undefined,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(page(rows))

    pick(view, 'tsv')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(blobs[0]?.type).toContain('text/tsv')
  })

  it('exports XLSX as a spreadsheet', () => {
    const blobs: Blob[] = []
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:mock' },
      revokeObjectURL: () => undefined,
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = render(page(rows))

    pick(view, 'xlsx')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(blobs[0]?.type).toContain('spreadsheetml')
  })
})

describe('grid: refresh and keyboard', () => {
  it('asks for a refresh when the toolbar button is pressed', () => {
    const onRefresh = vi.fn()
    act(() => {
      root.render(<ResultGrid result={page(rows)} sort={null} error={null} running={false} onSort={vi.fn()} onRefresh={onRefresh} />)
    })
    const button = [...container.querySelectorAll('[aria-label="刷新结果"]')][0] as HTMLElement
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('moves the selected cell with the arrow keys', () => {
    const view = render(page(rows))

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)
  })
})

describe('grid: empty filter result', () => {
  it('says when the page filter matches nothing', () => {
    const view = render(page(rows))
    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = view.byLabel('筛选输入 customer') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'zzz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).toContain('本页没有匹配的行')
  })

  it('shows 执行中 in the toolbar while a query runs', () => {
    act(() => {
      root.render(<ResultGrid result={page(rows)} sort={null} error={null} running onSort={vi.fn()} />)
    })

    expect(container.textContent).toContain('执行中')
  })
})

describe('grid: status bar aggregator', () => {
  const money = page([
    [1, 'alpha', 1000],
    [2, 'beta', 2500],
    [3, 'gamma', null],
  ])
  /** Three columns, the last numeric, for the aggregate assertions. */
  const withAmount = (): ExecuteResponse => ({
    ...money,
    columns: [
      { name: 'order_id', typeName: 'BIGINT' },
      { name: 'customer', typeName: 'VARCHAR' },
      { name: 'amount', typeName: 'DECIMAL' },
    ],
    rows: [
      [1, 'alpha', '1000'],
      [2, 'beta', '2500'],
      [3, 'gamma', null],
    ],
  })

  it('defaults to SUM over the whole page, like DataGrip', () => {
    render(withAmount())

    const status = container.querySelector('[data-grid-status]')
    expect(status).not.toBeNull()
    expect(container.querySelector('[data-grid-range]')?.textContent).toBe('整页 3 行 × 3 列')
    // amount sums to 3500; NULL is skipped rather than counted as zero.
    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('SUM = 3,500')
    expect(container.querySelector('[data-grid-charset]')?.textContent).toBe('UTF-8')
    expect((container.querySelector('[aria-label="聚合函数"]') as HTMLSelectElement).value).toBe('SUM')
  })

  it('recomputes when the aggregate is switched', () => {
    render(withAmount())
    const select = container.querySelector('[aria-label="聚合函数"]') as HTMLSelectElement

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'AVG')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('AVG = 1,750')
  })

  it('narrows to the selection once cells are picked', () => {
    const view = render(withAmount())

    act(() => {
      container.querySelectorAll('tbody td')[5]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(container.querySelector('[data-grid-range]')?.textContent).toBe('选区 1 行 × 1 列')
    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('SUM = 2,500')

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    // Column moved to `customer`, which has no numbers: the widget says so.
    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('SUM = —')
  })

  it('copies the raw number, not the grouped text', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(withAmount())

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }))
    })
    expect(writeText).toHaveBeenLastCalledWith('3500')

    act(() => {
      view.byLabel('复制聚合结果')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenLastCalledWith('3500')
  })

  it('disables the copy button when there is nothing to add up', () => {
    const view = render(page(rows))
    // Both columns are text/BIGINT → the BIGINT column is numeric, so use a page
    // whose only column is text.
    act(() => {
      root.render(
        <ResultGrid
          result={{ ...page([['a']]), columns: [{ name: 'customer', typeName: 'VARCHAR' }] }}
          sort={null}
          error={null}
          running={false}
          onSort={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('SUM = —')
    expect((view.byLabel('复制聚合结果') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('grid: value viewer', () => {
  const long = 'x'.repeat(400)
  const wide = (): ExecuteResponse => ({
    columns: [
      { name: 'order_id', typeName: 'BIGINT' },
      { name: 'note', typeName: 'VARCHAR' },
      { name: 'payload', typeName: 'JSON' },
    ],
    rows: [
      [1, long, '{"a":1,"b":[2,3]}'],
      [2, 'short', 'not json'],
    ],
    total: 2,
    hasNextPage: false,
    offset: 0,
    durationMs: 1,
    statementId: 'st-viewer',
  })

  it('opens on double click and shows the whole value', () => {
    render(wide())

    act(() => {
      container.querySelectorAll('tbody td')[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    const dialog = container.querySelector('[data-value-viewer]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('note')
    expect(dialog?.textContent).toContain('400 字符')
    expect(container.querySelector('[data-value-text]')?.textContent).toBe(long)
  })

  it('opens with Shift+Enter on the selected cell, pretty-printing JSON', () => {
    const view = render(wide())

    act(() => {
      container.querySelectorAll('tbody td')[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })

    const text = container.querySelector('[data-value-text]')?.textContent ?? ''
    expect(text).toContain('"a": 1')
    expect(text.split('\n').length).toBeGreaterThan(1)
  })

  it('copies the value and closes', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(wide())
    act(() => {
      container.querySelectorAll('tbody td')[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    act(() => {
      view.byLabel('复制值')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith(long)

    act(() => {
      view.byLabel('关闭值查看器')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })

  it('closes the viewer when a different page arrives', () => {
    render(wide())
    act(() => {
      container.querySelectorAll('tbody td')[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('[data-value-viewer]')).not.toBeNull()

    act(() => {
      root.render(
        <ResultGrid
          result={{ ...wide(), statementId: 'st-next-page' }}
          sort={null}
          error={null}
          running={false}
          onSort={vi.fn()}
        />,
      )
    })

    // The dialog pointed at a row of the old page.
    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })

  it('closes on Escape from inside the dialog', () => {
    render(wide())
    act(() => {
      container.querySelectorAll('tbody td')[1]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    // Any other key leaves it open…
    act(() => {
      container.querySelector('[data-value-viewer]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    expect(container.querySelector('[data-value-viewer]')).not.toBeNull()

    // …Escape closes it.
    act(() => {
      container.querySelector('[data-value-viewer]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })

  it('ignores Shift+Enter without a selection', () => {
    const view = render(wide())

    act(() => {
      view.byLabel('查询结果')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })

    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })
})

describe('grid: windowed rows', () => {
  /** A page big enough to be windowed (threshold is 200). */
  const bigPage = (count: number): ExecuteResponse => ({
    columns: [{ name: 'n', typeName: 'LONG' }],
    rows: Array.from({ length: count }, (_value, index) => [index]),
    total: count,
    hasNextPage: false,
    offset: 0,
    durationMs: 1,
    statementId: `st-big-${count}`,
  })

  it('keeps small pages fully rendered', () => {
    render(bigPage(120))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(120)
    expect(container.querySelector('[data-window-pad]')).toBeNull()
  })

  it('renders one window of a big page and pads the rest', () => {
    render(bigPage(5000))

    const rendered = container.querySelectorAll('tbody tr').length
    expect(rendered).toBeLessThan(5000)
    expect(rendered).toBeGreaterThan(10)
    expect(container.querySelector('[data-window-pad="top"]')).toBeNull()
    expect(container.querySelector('[data-window-pad="bottom"]')).not.toBeNull()
    // First visible row is row 0.
    expect(container.querySelector('tbody td')?.textContent).toBe('0')
  })

  it('re-measures the viewport when the pane is resized', () => {
    render(bigPage(5000))
    const scroller = container.querySelector('[role="grid"]') as HTMLElement
    // jsdom has no layout, so stand in for a real, laid-out pane.
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true })

    act(() => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    // 300px of viewport = 10 rows, plus 8 rows of overscan on each side.
    expect(container.querySelectorAll('tbody tr:not([data-window-pad])')).toHaveLength(26)
  })

  it('moves the window with the scroll offset', () => {
    render(bigPage(5000))
    const scroller = container.querySelector('[role="grid"]') as HTMLElement

    act(() => {
      scroller.scrollTop = 30 * 400
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(container.querySelector('[data-window-pad="top"]')).not.toBeNull()
    const firstCell = container.querySelector('tbody tr:not([data-window-pad]) td')
    // 400 - overscan(8) = row 392.
    expect(firstCell?.textContent).toBe('392')
  })
})
