// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ObjectSearch } from '../src/client/components/ObjectSearch.tsx'
import type { SchemaTable } from '../src/client/completion.ts'

const tables: SchemaTable[] = [
  {
    schema: 'dwd',
    kind: 'table',
    name: 'dwd_order',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'amount', type: 'DECIMAL' },
    ],
  },
  { name: 'loose', columns: [{ name: 'id', type: 'INT' }] },
  { schema: '', name: 'blank', columns: [{ name: 'amount', type: 'INT' }] },
]

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

const onPickTable = vi.fn()
const onPickColumn = vi.fn()

function render(open: boolean, onClose = vi.fn()): { onClose: () => void } {
  act(() => {
    root.render(
      <ObjectSearch
        open={open}
        tables={tables}
        onClose={onClose}
        onPickTable={onPickTable}
        onPickColumn={onPickColumn}
      />,
    )
  })
  return { onClose }
}

const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

const setInput = (value: string): void => {
  const input = byLabel('搜索表或列') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const key = (init: KeyboardEventInit): void => {
  act(() => {
    byLabel('搜索表或列')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

describe('ObjectSearch', () => {
  it('renders nothing while closed', () => {
    render(false)
    expect(container.querySelector('[data-object-search]')).toBeNull()
  })

  it('prompts for a query, explains no matches, and lists table/column hits', () => {
    render(true)
    expect(container.textContent).toContain('输入表名或列名开始搜索')
    setInput('zzz')
    expect(container.textContent).toContain('没有匹配的对象')

    setInput('order')
    expect(container.textContent).toContain('dwd_order')
    setInput('amount')
    expect(container.querySelector('[data-object-id="dwd_order.amount"]')).not.toBeNull()
    expect(container.textContent).toContain('DECIMAL')
  })

  it('picks a table on Enter and closes', () => {
    const onClose = vi.fn()
    onPickTable.mockClear()
    render(true, onClose)
    setInput('dwd_order')
    key({ key: 'Enter' })
    expect(onPickTable).toHaveBeenCalledWith('`dwd`.`dwd_order`')
    expect(onClose).toHaveBeenCalled()
  })

  it('picks a column by click (schema-less table shows its own name)', () => {
    onPickColumn.mockClear()
    render(true)
    setInput('id')
    const row = container.querySelector('[data-object-id="loose.id"]')
    expect(row?.textContent).toContain('INT')
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onPickColumn).toHaveBeenCalledWith(expect.objectContaining({ name: 'loose' }), 'id')
  })

  it('moves with arrows (wrapping) and Esc closes', () => {
    const onClose = vi.fn()
    render(true, onClose)
    setInput('order')
    key({ key: 'ArrowDown' })
    key({ key: 'ArrowUp' })
    key({ key: 'Enter' })
    expect(onPickTable).toHaveBeenCalled()
    key({ key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('selects a row on hover and tolerates Enter with no matches', () => {
    render(true)
    setInput('order')
    act(() => {
      container.querySelector('[data-object-id="dwd_order"]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(container.querySelector('[aria-selected="true"]')).not.toBeNull()
    setInput('zzz')
    key({ key: 'Enter' })
  })

  it('covers empty-schema details, other keys and arrows without rows', () => {
    render(true)
    setInput('blank')
    expect(container.textContent).toContain('列')
    setInput('zzz')
    key({ key: 'x' })
    key({ key: 'ArrowDown' })
    expect(container.textContent).toContain('没有匹配的对象')
  })
})
