// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResultGrid } from '../src/client/components/ResultGrid.tsx'
import { findLabeled } from './support/labeled.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'

const page = (rows: unknown[][], extra: Partial<ExecuteResponse> = {}): ExecuteResponse => ({
  columns: [
    { name: 'order_id', typeName: 'BIGINT' },
    { name: 'customer', typeName: 'VARCHAR' },
  ],
  rows,
  total: rows.length,
  hasNextPage: false,
  offset: 0,
  durationMs: 5,
  statementId: 'st-1',
  ...extra,
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

function render(result: ExecuteResponse) {
  act(() => {
    root.render(<ResultGrid result={result} sort={null} error={null} running={false} onSort={vi.fn()} />)
  })
  const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)
  const grid = (): HTMLElement => container.querySelector('[role="grid"]') as HTMLElement
  return { byLabel, grid }
}

const key = (element: Element, init: KeyboardEventInit): void => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

const setValue = (element: HTMLInputElement | HTMLSelectElement, value: string): void => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const selectCell = (row: number, column: number): void => {
  const cells = [...container.querySelectorAll('tbody td')]
  const index = row * 2 + column
  act(() => {
    cells[index]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    cells[index]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 1 }))
  })
}

describe('grid: find in results (B6)', () => {
  it('opens on Ctrl+F, counts and jumps matches, closes on Escape', () => {
    const view = render(page([[1, 'Alice'], [2, 'bob']]))
    key(view.grid(), { key: 'f', ctrlKey: true })
    expect(container.querySelector('[data-grid-find-bar]')).not.toBeNull()

    setValue(view.byLabel('查找输入') as HTMLInputElement, 'bob')
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('1/1')
    expect(container.querySelector('td[data-find-current]')?.textContent).toBe('bob')

    act(() => {
      view.byLabel('下一个匹配')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('1/1')

    key(view.byLabel('查找输入') as HTMLElement, { key: 'Escape' })
    expect(container.querySelector('[data-grid-find-bar]')).toBeNull()
  })

  it('caps collected matches and closes from the ✕ button', () => {
    const view = render(page(Array.from({ length: 501 }, (_value, index) => [index, 'a'])))
    key(view.grid(), { key: 'f', ctrlKey: true })
    setValue(view.byLabel('查找输入') as HTMLInputElement, 'a')
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('1/500')
    act(() => {
      view.byLabel('关闭查找')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-grid-find-bar]')).toBeNull()
  })

  it('shows 0/0 for no match and tolerates the toolbar buttons', () => {
    const view = render(page([[1, 'Alice']]))
    act(() => {
      view.byLabel('查找结果')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    setValue(view.byLabel('查找输入') as HTMLInputElement, 'zzz')
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('0/0')
    act(() => {
      view.byLabel('上一个匹配')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('0/0')
  })

  it('steps with Enter and closes on Escape from the grid', () => {
    const view = render(page([[1, 'a1'], [2, 'a2']]))
    key(view.grid(), { key: 'f', ctrlKey: true })
    const input = view.byLabel('查找输入') as HTMLInputElement
    setValue(input, 'a')
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('1/2')
    key(input, { key: 'Enter' })
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('2/2')
    key(input, { key: 'Enter', shiftKey: true })
    expect(container.querySelector('[data-grid-find-count]')?.textContent).toBe('1/2')
    key(view.grid(), { key: 'Escape' })
    expect(container.querySelector('[data-grid-find-bar]')).toBeNull()
  })
})

describe('grid: column visibility (B7)', () => {
  it('hides and restores columns, keeping at least one', () => {
    const view = render(page([[1, 'Alice']]))
    act(() => {
      view.byLabel('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const customer = view.byLabel('显示列 customer') as HTMLInputElement
    act(() => {
      customer.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('th')?.textContent).toContain('order_id')
    expect((container.querySelector('thead')?.textContent ?? '')).not.toContain('customer')

    // The last visible column cannot be hidden.
    const order = view.byLabel('显示列 order_id') as HTMLInputElement
    act(() => {
      order.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('th')?.textContent).toContain('order_id')

    act(() => {
      view.byLabel('重置列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('customer')
  })

  it('shows a hidden column again when it is re-checked', () => {
    const view = render(page([[1, 'Alice']]))
    act(() => {
      view.byLabel('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const customer = (): HTMLInputElement => view.byLabel('显示列 customer') as HTMLInputElement
    act(() => {
      customer().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('thead')?.textContent).not.toContain('customer')
    act(() => {
      customer().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('thead')?.textContent).toContain('customer')
  })

  it('drops a hidden column’s funnel and its share of the width floor', () => {
    const view = render(page([[1, 'Alice']]))
    expect(container.querySelectorAll('[data-grid-filter]')).toHaveLength(2)

    act(() => {
      view.byLabel('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      view.byLabel('显示列 customer')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.querySelector('[data-grid-filter-column="customer"]')).toBeNull()
    expect(container.querySelector('[data-grid-filter-column="order_id"]')).not.toBeNull()
    const table = container.querySelector('table') as HTMLTableElement
    // Only the BIGINT column is left, and numbers get the narrow default.
    expect(table.style.minWidth).toBe('120px')
  })
})

describe('grid: copy as SQL and exports (B8 / SQL-402)', () => {
  it('copies the selected column as a WHERE … IN clause', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(page([[1, 'Alice'], [2, 'bob']]))
    selectCell(0, 0)
    selectCell(1, 0)
    act(() => {
      view.byLabel('复制 IN 列表')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith('WHERE `order_id` IN (1, 2)')
  })

  it('copies the selected block as an INSERT skeleton', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(page([[1, 'Alice'], [2, 'bob']]))
    selectCell(0, 0)
    selectCell(1, 1)
    act(() => {
      view.byLabel('复制 INSERT')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls[0]?.[0]).toContain('INSERT INTO `result` (`order_id`, `customer`)')
  })

  it('copies the full column list from the column menu', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(page([[1, 'Alice']]))
    act(() => {
      view.byLabel('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      view.byLabel('复制列名')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith('`order_id`, `customer`')
  })

  it('exports INSERT and JSON in the chosen format', () => {
    const contents: string[] = []
    const RealBlob = globalThis.Blob
    Object.assign(URL, { createObjectURL: () => 'blob:mock', revokeObjectURL: () => undefined })
    class CapturingBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        contents.push(parts.map(part => String(part)).join(''))
      }
    }
    Object.defineProperty(globalThis, 'Blob', { value: CapturingBlob, configurable: true })
    const view = render(page([[1, 'Alice'], [2, null]]))

    setValue(view.byLabel('导出格式') as HTMLSelectElement, 'insert')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(contents[0]).toContain('INSERT INTO `result`')

    setValue(view.byLabel('导出格式') as HTMLSelectElement, 'json')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const json = JSON.parse(contents[1] ?? '[]') as unknown[]
    expect(json).toEqual([
      { order_id: 1, customer: 'Alice' },
      { order_id: 2, customer: null },
    ])
    Object.defineProperty(globalThis, 'Blob', { value: RealBlob, configurable: true })
  })

  it('exports TSV and JSON-safe special values', () => {
    const contents: string[] = []
    const RealBlob = globalThis.Blob
    Object.assign(URL, { createObjectURL: () => 'blob:mock', revokeObjectURL: () => undefined })
    class CapturingBlob extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options)
        contents.push(parts.map(part => String(part)).join(''))
      }
    }
    Object.defineProperty(globalThis, 'Blob', { value: CapturingBlob, configurable: true })
    const specialRows: unknown[][] = [[new Date('2026-10-01T00:00:00.000Z'), new Uint8Array([0xde, 0xad])]]
    specialRows.push([10n, 'x'])
    const special = page(specialRows)
    const view = render(special)

    setValue(view.byLabel('导出格式') as HTMLSelectElement, 'tsv')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(contents[0]).toContain('\t')

    setValue(view.byLabel('导出格式') as HTMLSelectElement, 'json')
    act(() => {
      view.byLabel('导出')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const json = JSON.parse(contents[1] ?? '[]') as Record<string, unknown>[]
    expect(json[0]?.order_id).toBe('2026-10-01T00:00:00.000Z')
    expect(json[0]?.customer).toBe('0xdead')
    expect(json[1]?.order_id).toBe('10')
    Object.defineProperty(globalThis, 'Blob', { value: RealBlob, configurable: true })
  })

  it('reports truncation when the IN list would copy too many values', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const big = page(Array.from({ length: 201 }, (_value, index) => [index, `c${String(index)}`]))
    const view = render(big)
    key(view.grid(), { key: 'a', ctrlKey: true })
    act(() => {
      view.byLabel('复制 IN 列表')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls[0]?.[0]).toContain('仅复制前 200 个值')
  })
})

describe('grid: error next steps (SQL-310)', () => {
  it('offers copy / locate / EXPLAIN / ask-agent on a failed statement', () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const onLocate = vi.fn()
    const onExplain = vi.fn()
    const onSendChat = vi.fn()
    act(() => {
      root.render(
        <ResultGrid
          result={null}
          sort={null}
          error={{ code: 'SQL_SYNTAX', message: '语法错误' }}
          running={false}
          onSort={vi.fn()}
          errorLine={3}
          onLocateLine={onLocate}
          onExplainError={onExplain}
          onSendChat={onSendChat}
        />,
      )
    })
    const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)

    expect(container.textContent).toContain('SQL_SYNTAX')
    expect(byLabel('定位错误行')?.textContent).toContain('第 3 行')
    act(() => {
      byLabel('定位错误行')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onLocate).toHaveBeenCalledWith(3)

    act(() => {
      byLabel('解释错误语句')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onExplain).toHaveBeenCalled()

    act(() => {
      byLabel('复制错误')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(writeText).toHaveBeenCalledWith('SQL_SYNTAX: 语法错误')

    act(() => {
      byLabel('问 agent 这个错误')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls.at(-1)?.[0]).toContain('下面这条 SQL 执行报错了')

    act(() => {
      byLabel('发到聊天框')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSendChat).toHaveBeenCalled()
  })
})

describe('grid: keyboard and viewer', () => {
  it('selects the whole page with Ctrl+A and extends with Shift+Arrow', () => {
    const view = render(page([[1, 'Alice'], [2, 'bob']]))
    key(view.grid(), { key: 'a', ctrlKey: true })
    expect(container.querySelector('[data-grid-range]')?.textContent).toBe('选区 2 行 × 2 列')
    key(view.grid(), { key: 'ArrowDown' })
    key(view.grid(), { key: 'ArrowRight', shiftKey: true })
    expect(container.querySelectorAll('td[data-selected]').length).toBeGreaterThan(0)
  })

  it('focuses the value viewer and closes it on Escape', () => {
    const view = render(page([[1, 'Alice']]))
    const first = container.querySelector('tbody td')
    act(() => {
      first?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const viewer = container.querySelector('[data-value-viewer]') as HTMLElement
    expect(viewer).not.toBeNull()
    expect(document.activeElement).toBe(viewer)
    key(viewer, { key: 'Escape' })
    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })

  it('closes the column menu on Escape', () => {
    const view = render(page([[1, 'Alice']]))
    act(() => {
      view.byLabel('列')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-grid-column-menu]')).not.toBeNull()
    key(view.grid(), { key: 'Escape' })
    expect(container.querySelector('[data-grid-column-menu]')).toBeNull()
  })

  it('closes the value viewer on Escape from the grid', () => {
    const view = render(page([[1, 'Alice']]))
    act(() => {
      container.querySelector('tbody td')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('[data-value-viewer]')).not.toBeNull()
    key(view.grid(), { key: 'Escape' })
    expect(container.querySelector('[data-value-viewer]')).toBeNull()
  })
})
