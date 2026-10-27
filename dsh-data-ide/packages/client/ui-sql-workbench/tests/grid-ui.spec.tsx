// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResultGrid } from '../src/client/components/ResultGrid.tsx'
import { findLabeled } from './support/labeled.ts'
import type { ExecuteResponse, FilterSpec, SortSpec } from '../src/execute/core.ts'

/**
 * The grid's layout contract lives in the stylesheet, and jsdom has no layout
 * engine, so the width rules are asserted against the real CSS source (SQL-7/8).
 * Vitest runs from the repo root (see vitest.config.ts), so the path is stable.
 */
const sheet = readFileSync(
  resolve('packages/client/ui-sql-workbench/src/client/components/sqlWorkbench.css'),
  'utf8',
)
/** Comments mention selectors (`the scroller is .gridScroll`), so drop them first. */
const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '')

/** One rule block from the stylesheet; our rules have no nesting. */
function cssRule(selector: string): string {
  const exact = css.indexOf(`${selector} {`)
  const start = exact >= 0 ? exact : css.indexOf(selector)
  expect(start, `stylesheet misses ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

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

function render(
  result: ExecuteResponse,
  onSort = vi.fn(),
  filters: readonly FilterSpec[] = [],
  onFilter = vi.fn(),
  onClearFilters = vi.fn(),
) {
  act(() => {
    root.render(
      <ResultGrid
        result={result}
        sort={null}
        error={null}
        running={false}
        onSort={onSort}
        filters={filters}
        onFilter={onFilter}
        onClearFilters={onClearFilters}
      />,
    )
  })
  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll('button')] as HTMLButtonElement[]
  const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)
  return { buttons, byLabel, onFilter, onClearFilters }
}

type Rendered = ReturnType<typeof render>

/** Click one element and let React flush the state update. */
function click(element: Element | null | undefined): void {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** The funnel opens on the value list; these tests want the operator editor. */
function openCondition(view: Rendered, column: string): void {
  click(view.byLabel(`筛选 ${column}`))
  click(view.byLabel('筛选模式 条件'))
}

/** Type into a controlled input/select the way a user would. */
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  act(() => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

const rows = [[1, 'Alice'], [2, 'bob']]

describe('result grid: column filter (server-side)', () => {
  it('opens the value list by default and the condition editor on demand', () => {
    const view = render(page(rows))

    click(view.byLabel('筛选 customer'))
    const panel = container.querySelector('[data-sql-filter-editor]')
    expect(panel).not.toBeNull()
    // DataGrip's funnel opens on the local value list.
    expect(panel?.getAttribute('data-filter-mode')).toBe('values')
    expect(view.byLabel('搜索值 customer')).toBeDefined()

    click(view.byLabel('筛选模式 条件'))
    expect(container.querySelector('[data-sql-filter-editor]')?.getAttribute('data-filter-mode')).toBe('condition')
    expect(view.byLabel('筛选条件')).toBeDefined()
    expect(view.byLabel('筛选值 customer')).toBeDefined()
  })

  it('commits a condition through onFilter (the panel re-runs the query)', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [], onFilter)

    openCondition(view, 'customer')
    const input = view.byLabel('筛选值 customer') as HTMLInputElement
    setValue(input, 'ali')
    click(view.byLabel('应用筛选'))

    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'contains', value: 'ali' })
    // The editor closes once the condition is committed.
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
  })

  it('marks a numeric column so the server does not quote the literal', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [], onFilter)

    openCondition(view, 'order_id')
    const op = view.byLabel('筛选条件') as HTMLSelectElement
    setValue(op, 'gt')
    const input = view.byLabel('筛选值 order_id') as HTMLInputElement
    setValue(input, '1')
    click(view.byLabel('应用筛选'))

    expect(onFilter).toHaveBeenCalledWith('order_id', { column: 'order_id', op: 'gt', value: '1', numeric: true })
  })

  it('omits the value for 为空 / 非空', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [], onFilter)

    openCondition(view, 'customer')
    const op = view.byLabel('筛选条件') as HTMLSelectElement
    setValue(op, 'isNull')
    expect(view.byLabel('筛选值 customer')).toBeUndefined()

    click(view.byLabel('应用筛选'))
    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'isNull' })
  })

  it('renders an 为空 condition without a value', () => {
    render(page(rows), vi.fn(), [{ column: 'customer', op: 'isNull' }])

    // The funnel for that column is marked active and the toolbar counts it.
    expect(container.textContent).toContain('清除筛选（1）')
    expect(container.querySelector('[aria-label="筛选 customer"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('hides the funnel when filters are disabled (script results)', () => {
    act(() => {
      root.render(
        <ResultGrid
          result={page(rows)}
          sort={null}
          error={null}
          running={false}
          onSort={vi.fn()}
          filterEnabled={false}
        />,
      )
    })

    expect(container.querySelector('[aria-label="筛选 customer"]')).toBeNull()
  })

  it('shows the active count and clears all conditions', () => {
    const onClearFilters = vi.fn()
    const filters: FilterSpec[] = [{ column: 'customer', op: 'contains', value: 'ali' }]
    const view = render(page(rows), vi.fn(), filters, vi.fn(), onClearFilters)

    expect(container.textContent).toContain('行（已筛选）')
    act(() => {
      view.byLabel('清除筛选')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClearFilters).toHaveBeenCalled()
  })

  it('prefills the editor from an existing condition and can remove it', () => {
    const onFilter = vi.fn()
    const filters: FilterSpec[] = [{ column: 'customer', op: 'eq', value: 'Alice' }]
    const view = render(page(rows), vi.fn(), filters, onFilter)

    act(() => {
      view.byLabel('筛选 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect((view.byLabel('筛选值 customer') as HTMLInputElement).value).toBe('Alice')

    act(() => {
      view.byLabel('移除该列筛选')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onFilter).toHaveBeenCalledWith('customer', null)
  })

  it('closes the editor on Escape', () => {
    const view = render(page(rows))
    openCondition(view, 'customer')
    const input = view.byLabel('筛选值 customer') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
  })

  it('closes the condition editor from 取消 without applying anything', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [], onFilter)
    openCondition(view, 'customer')

    click(view.byLabel('取消筛选'))

    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
    expect(onFilter).not.toHaveBeenCalled()
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
        <ResultGrid result={null} sort={null} error={{ code: 'WRITE_DISABLED', message: '写操作未开启' }} running={false} onSort={vi.fn()} filters={[]} onFilter={vi.fn()} onClearFilters={vi.fn()} />,
      )
    })

    expect(container.textContent).toContain('WRITE_DISABLED')
    expect(container.textContent).toContain('写操作未开启')
  })

  it('shows the running placeholder', () => {
    act(() => {
      root.render(<ResultGrid result={null} sort={null} error={null} running onSort={vi.fn()} filters={[]} onFilter={vi.fn()} onClearFilters={vi.fn()} />)
    })

    expect(container.textContent).toContain('正在执行')
  })

  it('says when a query returned no rows', () => {
    act(() => {
      root.render(<ResultGrid result={page([])} sort={null} error={null} running={false} onSort={vi.fn()} filters={[]} onFilter={vi.fn()} onClearFilters={vi.fn()} />)
    })

    expect(container.textContent).toContain('没有返回行')
  })
})

describe('result grid: further edges', () => {
  it('commits on Enter as well', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [], onFilter)
    openCondition(view, 'customer')
    const input = view.byLabel('筛选值 customer') as HTMLInputElement
    setValue(input, 'zzz')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'contains', value: 'zzz' })
  })

  it('toggles the filter panel closed when the same column is clicked twice', () => {
    const view = render(page(rows))
    click(view.byLabel('筛选 customer'))
    expect(container.querySelector('[data-sql-filter-editor]')).not.toBeNull()
    click(view.byLabel('筛选 customer'))

    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
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
    render(page(rows))
    const cells = [...container.querySelectorAll('tbody td')] as HTMLElement[]
    act(() => {
      cells[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(container.querySelectorAll('td[data-selected]')).toHaveLength(1)

    // A new filter set re-runs the query; the old rectangle no longer maps.
    act(() => {
      root.render(
        <ResultGrid
          result={page(rows)}
          sort={null}
          error={null}
          running={false}
          onSort={vi.fn()}
          filters={[{ column: 'customer', op: 'contains', value: 'a' }]}
          onFilter={vi.fn()}
          onClearFilters={vi.fn()}
        />,
      )
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
      root.render(<ResultGrid result={page(rows)} sort={null} error={null} running={false} onSort={vi.fn()} onRefresh={onRefresh} filters={[]} onFilter={vi.fn()} onClearFilters={vi.fn()} />)
    })
    const button = findLabeled('刷新结果') as HTMLElement
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
  it('says when a filtered query matches nothing', () => {
    render(page([]), vi.fn(), [{ column: 'customer', op: 'contains', value: 'zzz' }])

    // Zero rows comes back as a successful empty result, with the filter still
    // visible in the toolbar so the state is not mistaken for "table is empty".
    expect(container.textContent).toContain('0 行（已筛选）')
    // The way out stays on screen.
    expect(container.textContent).toContain('清除筛选（1）')
  })

  it('shows 执行中 in the toolbar while a query runs', () => {
    act(() => {
      root.render(<ResultGrid result={page(rows)} sort={null} error={null} running onSort={vi.fn()} filters={[]} onFilter={vi.fn()} onClearFilters={vi.fn()} />)
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
    // `order_id` is BIGINT, which now counts as numeric, and it is the first
    // numeric column — so the default aggregate runs on it.
    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('SUM = 6')
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

    expect(container.querySelector('[data-grid-stat]')?.textContent).toBe('AVG = 2')
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
    expect(writeText).toHaveBeenLastCalledWith('6')

    act(() => {
      view.byLabel('复制聚合结果')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenLastCalledWith('6')
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
          filters={[]}
          onFilter={vi.fn()}
          onClearFilters={vi.fn()}
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
          filters={[]}
          onFilter={vi.fn()}
          onClearFilters={vi.fn()}
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

describe('result grid: fixed column layout (SQL-7)', () => {
  it('lays columns out fixed and clips cells with an ellipsis', () => {
    expect(cssRule('.table')).toContain('table-layout: fixed')

    const cell = cssRule('.table td')
    expect(cell).toContain('overflow: hidden')
    expect(cell).toContain('text-overflow: ellipsis')
    expect(cell).toContain('white-space: nowrap')
    // A `max-width` on a table cell does not constrain anything; the column
    // width comes from `<col>` instead.
    expect(cell).not.toContain('max-width')
  })

  it('gives every column a concrete default width, numbers narrower than text', () => {
    render(page(rows))

    const widths = [...container.querySelectorAll('col')].map(node => (node as HTMLElement).style.width)
    expect(widths).toEqual(['120px', '160px'])
  })

  it('keeps the table at least as wide as its columns so a wide grid scrolls', () => {
    render(page(rows))

    const table = container.querySelector('table') as HTMLTableElement
    expect(table.style.minWidth).toBe('280px')
    // The scroller is what absorbs the excess width.
    expect(cssRule('.gridScroll')).toContain('overflow: auto')
  })

  it('does not let a long value widen its column', () => {
    const long = 'x'.repeat(4000)
    render(page([[1, long]]))

    const col = [...container.querySelectorAll('col')][1] as HTMLElement
    expect(col.style.width).toBe('160px')
    const cell = [...container.querySelectorAll('tbody td')][1] as HTMLElement
    // The full value stays reachable (title / value viewer); the cell clips it.
    expect(cell.getAttribute('title')).toBe(long)
    expect(cell.textContent).toBe(long)
  })

  it('recomputes the width floor when a column is dragged wider', () => {
    const view = render(page(rows))

    act(() => {
      view.byLabel('调整 customer 列宽')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140 }))
      window.dispatchEvent(new MouseEvent('mouseup'))
    })

    const table = container.querySelector('table') as HTMLTableElement
    // order_id 120 + customer (160 + 40 drag) = 320.
    expect(table.style.minWidth).toBe('320px')
  })

  it('keeps a one-row header: sort label, then the funnel, then the resize handle', () => {
    render(page(rows))

    const header = container.querySelector('th') as HTMLElement
    expect(header.querySelector('.tableHeadCell')).not.toBeNull()
    // The panel's own tests locate sorting with `th button`; keep it first.
    expect(header.querySelector('button')?.className).toContain('sortHeader')
    expect(header.querySelector('.resizeHandle')).not.toBeNull()
  })
})

describe('result grid: per-column funnel buttons (SQL-8)', () => {
  it('renders one explicit funnel button for every visible column', () => {
    render(page(rows))

    const funnels = [...container.querySelectorAll<HTMLButtonElement>('[data-grid-filter]')]
    expect(funnels).toHaveLength(2)
    expect(funnels.map(node => node.getAttribute('aria-label'))).toEqual(['筛选 order_id', '筛选 customer'])
    expect(funnels.map(node => node.getAttribute('title'))).toEqual(['筛选该列', '筛选该列'])
    // A drawing, not a dingbat: a font glyph changes size per platform.
    expect(funnels.every(node => node.querySelector('svg') !== null)).toBe(true)
  })

  it('opens the local value list from the funnel button', () => {
    const view = render(page(rows))

    click(view.byLabel('筛选 customer'))

    expect(container.querySelector('[data-sql-filter-editor]')).not.toBeNull()
    expect(container.querySelector('[data-sql-filter-editor]')?.getAttribute('data-filter-mode')).toBe('values')
    expect(view.byLabel('搜索值 customer')).toBeDefined()
  })

  it('highlights the funnel of a filtered column', () => {
    render(page(rows), vi.fn(), [{ column: 'customer', op: 'contains', value: 'a' }])

    const active = container.querySelector('[data-grid-filter-column="customer"]') as HTMLButtonElement
    expect(active.getAttribute('aria-pressed')).toBe('true')
    expect(active.className).toContain('filterButtonActive')

    const idle = container.querySelector('[data-grid-filter-column="order_id"]') as HTMLButtonElement
    expect(idle.getAttribute('aria-pressed')).toBe('false')
    expect(idle.className).toBe('filterButton')
  })

  it('stays visible in a narrow panel: fixed 22px box, no container-query hiding', () => {
    const button = cssRule('.filterButton')
    expect(button).toContain('flex: 0 0 auto')
    expect(button).toContain('width: 22px')
    expect(button).toContain('height: 22px')

    // Container queries trim the status bar; they must never eat the funnel.
    expect(css.slice(css.indexOf('@container'))).not.toContain('filterButton')
  })

  it('drops the funnel of a hidden column', () => {
    render(page(rows))
    act(() => {
      findLabeled('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      findLabeled('显示列 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-grid-filter-column="customer"]')).toBeNull()
    expect(container.querySelector('[data-grid-filter-column="order_id"]')).not.toBeNull()

    const table = container.querySelector('table') as HTMLTableElement
    expect(table.style.minWidth).toBe('120px')
  })
})

describe('result grid: table width follows the columns (SQL-7 second round)', () => {
  const singleColumn: ExecuteResponse = {
    columns: [{ name: 'sum_amount', typeName: 'DECIMAL' }],
    rows: [[42]],
    total: 1,
    hasNextPage: false,
    offset: 0,
    durationMs: 1,
    statementId: 'st-single-column',
  }

  it('does not stretch a single column to the whole pane', () => {
    render(singleColumn)

    const table = container.querySelector('table') as HTMLTableElement
    // Numbers default to 120px; the table tracks that instead of 100% width.
    expect(table.style.minWidth).toBe('120px')
    expect(table.style.width).toBe('')
    const rule = cssRule('.table')
    expect(rule).toContain('width: max-content')
    expect(rule).not.toContain('width: 100%')
  })

  it('lets the scroller absorb the overflow when the columns are wider than the pane', () => {
    render(page(rows))

    const table = container.querySelector('table') as HTMLTableElement
    expect(table.style.minWidth).toBe('280px')
    expect(cssRule('.gridScroll')).toContain('overflow: auto')
  })

  it('orders the header visually as funnel, then name + sort indicator', () => {
    // DOM keeps sort first (panel tests + keyboard order); CSS swaps them.
    expect(cssRule('.filterButton')).toContain('order: 1')
    expect(cssRule('.sortHeader')).toContain('order: 2')
    expect(cssRule('.sortHeader')).toContain('display: flex')
    expect(cssRule('.tableHeadCell')).toContain('display: flex')
  })
})

describe('result grid: three-state sort indicator (DataGrip)', () => {
  const renderSorted = (sort: SortSpec | null, onSort = vi.fn()): void => {
    act(() => {
      root.render(
        <ResultGrid
          result={page(rows)}
          sort={sort}
          error={null}
          running={false}
          onSort={onSort}
          filters={[]}
          onFilter={vi.fn()}
          onClearFilters={vi.fn()}
        />,
      )
    })
  }

  it('shows ⇅ when unsorted, ↑ ascending and ↓ descending, highlighting the active one', () => {
    renderSorted(null)
    expect(container.querySelector('[data-sort-icon="none"]')?.textContent).toBe('⇅')
    expect(container.querySelector('[data-sort-icon="none"]')?.className).not.toContain('sortIconActive')

    renderSorted({ column: 'customer', direction: 'ASC' })
    const ascending = container.querySelector('[data-sort-icon="ascending"]')
    expect(ascending?.textContent).toBe('↑')
    expect(ascending?.className).toContain('sortIconActive')
    expect(container.querySelectorAll('th')[1]?.getAttribute('aria-sort')).toBe('ascending')

    renderSorted({ column: 'customer', direction: 'DESC' })
    const descending = container.querySelector('[data-sort-icon="descending"]')
    expect(descending?.textContent).toBe('↓')
    expect(descending?.className).toContain('sortIconActive')
    expect(container.querySelectorAll('th')[1]?.getAttribute('aria-sort')).toBe('descending')
  })

  it('explains the three-state cycle in the tooltip and sorts on click', () => {
    const onSort = vi.fn()
    renderSorted(null, onSort)

    const button = container.querySelector('th button') as HTMLButtonElement
    const title = button.getAttribute('title') ?? ''
    expect(title).toContain('升序')
    expect(title).toContain('降序')
    expect(title).toContain('取消')

    click(button)
    expect(onSort).toHaveBeenCalledWith('order_id')
  })
})

describe('result grid: local value-list filter (DataGrip)', () => {
  /** Rendered value rows: display text plus its page count. */
  const valueRows = (): { text: string; count: string }[] =>
    [...container.querySelectorAll('[data-filter-value-list] label')].map(node => ({
      text: node.querySelector('span')?.textContent ?? '',
      count: node.querySelector('[data-filter-value-count]')?.textContent ?? '',
    }))

  const counted = page([[1, 'Alice'], [2, 'Alice'], [3, 'bob'], [4, null]])

  it('floats the panel over the grid instead of pushing the rows down', () => {
    const rule = cssRule('.filterPanel')
    expect(rule).toContain('position: absolute')
    expect(rule).toContain('max-height')
    expect(rule).toContain('overflow: auto')
  })

  it('lists page values with their page counts, most frequent first', () => {
    const view = render(counted)
    click(view.byLabel('筛选 customer'))

    // NULL is not a tickable value (it would become the string 'NULL').
    expect(valueRows()).toEqual([
      { text: 'Alice', count: '2' },
      { text: 'bob', count: '1' },
    ])
    // The panel says what the numbers are and what applying does.
    const hint = container.querySelector('[data-sql-filter-editor]')?.textContent ?? ''
    expect(hint).toContain('本页计数')
    expect(hint).toContain('服务端筛选')
  })

  it('filters the list with a case-insensitive search', () => {
    const view = render(counted)
    click(view.byLabel('筛选 customer'))

    setValue(view.byLabel('搜索值 customer') as HTMLInputElement, 'ALI')
    expect(valueRows()).toEqual([{ text: 'Alice', count: '2' }])

    // A search that matches nothing keeps the panel but shows the empty state.
    setValue(view.byLabel('搜索值 customer') as HTMLInputElement, 'zzz')
    expect(valueRows()).toHaveLength(0)
    expect(container.textContent).toContain('本页没有可选值')
  })

  it('turns the ticked values into a server-side IN filter', () => {
    const onFilter = vi.fn()
    const view = render(counted, vi.fn(), [], onFilter)
    click(view.byLabel('筛选 customer'))

    click(view.byLabel('值 Alice'))
    click(view.byLabel('应用筛选'))

    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'in', values: ['Alice'] })
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
  })

  it('keeps the tick order and can untick a value again', () => {
    const onFilter = vi.fn()
    const view = render(counted, vi.fn(), [], onFilter)
    click(view.byLabel('筛选 customer'))

    click(view.byLabel('值 bob'))
    click(view.byLabel('值 Alice'))
    click(view.byLabel('值 Alice'))
    click(view.byLabel('值 Alice'))
    click(view.byLabel('应用筛选'))

    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'in', values: ['bob', 'Alice'] })
  })

  it('filters a numeric column with its raw literal, not the grouped text', () => {
    const onFilter = vi.fn()
    const view = render(page([[103572, 'x']]), vi.fn(), [], onFilter)
    click(view.byLabel('筛选 order_id'))

    // The list shows the formatted number the grid shows…
    expect(valueRows()).toEqual([{ text: '103,572', count: '1' }])
    click(view.byLabel('值 103,572'))
    click(view.byLabel('应用筛选'))

    // …but the server receives the un-grouped literal with numeric:true.
    expect(onFilter).toHaveBeenCalledWith('order_id', {
      column: 'order_id',
      op: 'in',
      values: ['103572'],
      numeric: true,
    })
  })

  it('applies an empty selection as "match nothing"', () => {
    const onFilter = vi.fn()
    const view = render(page([[1, null]]), vi.fn(), [], onFilter)
    click(view.byLabel('筛选 customer'))

    expect(container.textContent).toContain('本页没有可选值')
    click(view.byLabel('应用筛选'))

    expect(onFilter).toHaveBeenCalledWith('customer', { column: 'customer', op: 'in', values: [] })
  })

  it('caps the list at 200 distinct values', () => {
    const distinct = page(Array.from({ length: 250 }, (_value, index) => [index, `v${String(index)}`]))
    const view = render(distinct)
    click(view.byLabel('筛选 customer'))

    expect(container.querySelectorAll('[data-filter-value-list] input[type="checkbox"]')).toHaveLength(200)
  })

  it('reopens an existing IN filter with its values ticked, and can remove it', () => {
    const onFilter = vi.fn()
    const view = render(page(rows), vi.fn(), [{ column: 'customer', op: 'in', values: ['Alice'] }], onFilter)

    click(view.byLabel('筛选 customer'))
    expect(container.querySelector('[data-sql-filter-editor]')?.getAttribute('data-filter-mode')).toBe('values')
    expect((view.byLabel('值 Alice') as HTMLInputElement).checked).toBe(true)
    expect((view.byLabel('值 bob') as HTMLInputElement).checked).toBe(false)

    click(view.byLabel('移除该列筛选'))
    expect(onFilter).toHaveBeenCalledWith('customer', null)
  })

  it('treats an IN filter with no values as an empty tick list', () => {
    const view = render(page(rows), vi.fn(), [{ column: 'customer', op: 'in' }])

    click(view.byLabel('筛选 customer'))

    expect(container.querySelector('[data-sql-filter-editor]')?.getAttribute('data-filter-mode')).toBe('values')
    const boxes = [...container.querySelectorAll('[data-filter-value-list] input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every(box => !box.checked)).toBe(true)
  })

  it('keeps ticks when switching to the condition editor and back', () => {
    const view = render(counted)
    click(view.byLabel('筛选 customer'))
    click(view.byLabel('值 Alice'))

    click(view.byLabel('筛选模式 条件'))
    expect(view.byLabel('筛选条件')).toBeDefined()
    click(view.byLabel('筛选模式 值列表'))

    expect((view.byLabel('值 Alice') as HTMLInputElement).checked).toBe(true)
  })

  it('closes from 取消, from Escape in the search box, and from Escape on the grid', () => {
    const view = render(counted)
    click(view.byLabel('筛选 customer'))
    click(view.byLabel('取消筛选'))
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()

    click(view.byLabel('筛选 customer'))
    const search = view.byLabel('搜索值 customer') as HTMLInputElement
    act(() => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()

    click(view.byLabel('筛选 customer'))
    const grid = container.querySelector('[role="grid"]') as HTMLElement
    act(() => {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
  })

  it('closes the panel when its column is hidden', () => {
    const view = render(counted)
    click(view.byLabel('筛选 customer'))
    expect(container.querySelector('[data-sql-filter-editor]')).not.toBeNull()

    click(view.byLabel('列'))
    click(view.byLabel('显示列 customer'))

    expect(container.querySelector('[data-sql-filter-editor]')).toBeNull()
  })
})
