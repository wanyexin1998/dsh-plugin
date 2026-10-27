// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HistoryPanel } from '../src/client/components/HistoryPanel.tsx'
import type { FavoriteEntry, QueryHistoryEntry } from '../src/client/state/history.ts'
import { formatTimestamp } from '../src/client/state/history.ts'

const NOW = new Date(2026, 9, 26, 15, 30).getTime()

const entry = (id: string, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id,
  connId: 'c1',
  sql: `SELECT ${id}`,
  at: NOW - 1_000,
  durationMs: 5,
  rowCount: 3,
  ok: true,
  ...overrides,
})

const favorite = (id: string, overrides: Partial<FavoriteEntry> = {}): FavoriteEntry => ({
  id: `fav-${id}`,
  connId: 'c1',
  name: `收藏 ${id}`,
  sql: `SELECT ${id}`,
  at: NOW - 1_000,
  ...overrides,
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

interface RenderOptions {
  readonly entries?: readonly QueryHistoryEntry[]
  readonly favorites?: readonly FavoriteEntry[]
  readonly connId?: string | null
  readonly initialTab?: 'history' | 'favorites'
  readonly onClose?: () => void
  readonly withPin?: boolean
  readonly withRemove?: boolean
  readonly withNow?: boolean
}

interface Calls {
  insert: string[]
  replace: string[]
  pin: QueryHistoryEntry[]
  remove: string[]
  close: number
}

function render(options: RenderOptions = {}) {
  const calls: Calls = { insert: [], replace: [], pin: [], remove: [], close: 0 }
  act(() => {
    root.render(
      <HistoryPanel
        entries={options.entries ?? []}
        favorites={options.favorites ?? []}
        connId={options.connId}
        initialTab={options.initialTab}
        onInsert={sql => calls.insert.push(sql)}
        onReplace={sql => calls.replace.push(sql)}
        {...(options.withPin === true ? { onPin: (item: QueryHistoryEntry) => calls.pin.push(item) } : {})}
        {...(options.withRemove === true ? { onRemoveFavorite: (id: string) => calls.remove.push(id) } : {})}
        {...(options.onClose === undefined ? {} : { onClose: options.onClose })}
        {...(options.withNow === false ? {} : { now: () => NOW })}
      />,
    )
  })
  const panel = (): HTMLElement => container.querySelector('[data-sql-history-panel]') as HTMLElement
  const input = (): HTMLInputElement => container.querySelector('[data-sql-history-search]') as HTMLInputElement
  const items = (selector = '[data-sql-history-item]'): HTMLElement[] =>
    [...container.querySelectorAll(selector)] as HTMLElement[]
  const byLabel = (label: string): HTMLElement | undefined =>
    [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === label) as HTMLElement | undefined

  const type = (value: string): void => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const key = (init: KeyboardEventInit, target: HTMLElement = panel()): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    })
  }

  const click = (target: Element | undefined | null): void => {
    act(() => {
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const doubleClick = (target: Element | undefined | null): void => {
    act(() => {
      target?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
  }

  return { calls, panel, input, items, byLabel, type, key, click, doubleClick }
}

describe('history panel: list rendering', () => {
  it('shows time, duration, row count and status for every run', () => {
    const view = render({
      entries: [
        entry('good', { durationMs: 5, rowCount: 3 }),
        entry('bad', {
          at: new Date(2026, 9, 25, 9, 5).getTime(),
          durationMs: 1_500,
          rowCount: null,
          ok: false,
          errorCode: 'ER_PARSE_ERROR',
        }),
      ],
    })

    const items = view.items()
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('2026-10-26 15:29:59')
    expect(items[0]?.textContent).toContain('5ms')
    expect(items[0]?.textContent).toContain('3 行')
    expect(items[0]?.textContent).toContain('成功')
    expect(items[1]?.textContent).toContain('2026-10-25 09:05:00')
    expect(items[1]?.textContent).toContain('1.5s')
    expect(items[1]?.textContent).toContain('行数未知')
    expect(items[1]?.textContent).toContain('失败')
    expect(view.byLabel('失败')?.getAttribute('title')).toBe('ER_PARSE_ERROR')
  })

  it('explains a failed run that carries no engine code', () => {
    const view = render({ entries: [entry('cancelled', { ok: false })] })

    expect(view.byLabel('失败')?.getAttribute('title')).toBe('执行失败')
    expect(view.byLabel('成功')).toBeUndefined()
  })

  it('marks the selected row and moves the mark with arrows', () => {
    const view = render({ entries: [entry('a'), entry('b'), entry('c')] })

    expect(view.items()[0]?.getAttribute('aria-selected')).toBe('true')
    view.key({ key: 'ArrowDown' })
    expect(view.items()[1]?.getAttribute('aria-selected')).toBe('true')
    view.key({ key: 'ArrowUp' })
    expect(view.items()[0]?.getAttribute('aria-selected')).toBe('true')
    view.key({ key: 'ArrowUp' })
    expect(view.items()[0]?.getAttribute('aria-selected')).toBe('true')
    view.key({ key: 'ArrowDown' })
    view.key({ key: 'ArrowDown' })
    view.key({ key: 'ArrowDown' })
    view.key({ key: 'ArrowDown' })
    expect(view.items()[2]?.getAttribute('aria-selected')).toBe('true')
  })

  it('renders the local timestamp when no clock seam is given', () => {
    const at = Date.now() - 1_000
    const view = render({ entries: [entry('recent', { at })], withNow: false })

    expect(view.items()[0]?.textContent).toContain(formatTimestamp(at))
  })

  it('filters by connection and search text', () => {
    const view = render({
      connId: 'c1',
      entries: [
        entry('order', { connId: 'c1', sql: 'SELECT * FROM dwd_order' }),
        entry('customer', { connId: 'c2', sql: 'SELECT * FROM dwd_customer' }),
        entry('update', { connId: 'c1', sql: 'UPDATE stats SET x = 1' }),
      ],
    })

    expect(view.items().map(item => item.getAttribute('data-entry-id'))).toEqual(['order', 'update'])
    view.type('order')
    expect(view.items().map(item => item.getAttribute('data-entry-id'))).toEqual(['order'])
    view.type('nothing-matches')
    expect(view.items()).toHaveLength(0)
    expect(container.textContent).toContain('没有匹配的查询')
  })

  it('shows all connections without a connection filter', () => {
    const view = render({
      entries: [entry('a', { connId: 'c1' }), entry('b', { connId: 'c2' })],
      connId: null,
    })

    expect(view.items()).toHaveLength(2)
  })
})

describe('history panel: empty states', () => {
  it('explains that no run has been recorded yet', () => {
    const view = render()

    expect(container.textContent).toContain('还没有查询历史')
    expect(view.items()).toHaveLength(0)
  })

  it('differs between "nothing yet" and "nothing matched"', () => {
    const view = render({ initialTab: 'favorites' })

    expect(container.textContent).toContain('还没有收藏的查询')
    view.type('missing')
    expect(container.textContent).toContain('没有匹配的收藏')
  })

  it('keeps Enter and arrows inert when the list is empty', () => {
    const view = render()

    view.key({ key: 'Enter' })
    view.key({ key: 'ArrowDown' })

    expect(view.calls.insert).toEqual([])
    expect(view.calls.replace).toEqual([])
  })
})

describe('history panel: insert and replace', () => {
  it('double-clicks a row to insert its SQL', () => {
    const view = render({ entries: [entry('a'), entry('b')] })

    view.doubleClick(view.items()[1])

    expect(view.calls.insert).toEqual(['SELECT b'])
  })

  it('inserts the selected row with Enter, and replaces with Ctrl/Cmd+Enter', () => {
    const view = render({ entries: [entry('a'), entry('b'), entry('c')] })

    view.key({ key: 'Enter' })
    view.key({ key: 'ArrowDown' })
    view.key({ key: 'Enter' })
    view.key({ key: 'Enter', ctrlKey: true })
    view.key({ key: 'Enter', metaKey: true })

    expect(view.calls.insert).toEqual(['SELECT a', 'SELECT b'])
    expect(view.calls.replace).toEqual(['SELECT b', 'SELECT b'])
  })

  it('offers a replace button on each row', () => {
    const view = render({ entries: [entry('a')] })

    view.click(view.byLabel('替换当前语句'))

    expect(view.calls.replace).toEqual(['SELECT a'])
  })

  it('pins a run from the list without inserting it', () => {
    const view = render({ entries: [entry('a', { sql: 'SELECT 1 FROM dual' })], withPin: true })

    view.click(view.byLabel('收藏这条查询'))

    expect(view.calls.pin).toHaveLength(1)
    expect(view.calls.pin[0]?.id).toBe('a')
    expect(view.calls.insert).toEqual([])
  })

  it('resets the selection when the search narrows the list', () => {
    const view = render({
      entries: [
        entry('a', { sql: 'SELECT alpha' }),
        entry('b', { sql: 'SELECT beta' }),
        entry('c', { sql: 'SELECT gamma' }),
      ],
    })

    view.click(view.items()[2])
    expect(view.items()[2]?.getAttribute('aria-selected')).toBe('true')

    view.type('beta')
    view.key({ key: 'Enter' })

    expect(view.calls.insert).toEqual(['SELECT beta'])
  })
})

describe('history panel: favorites', () => {
  it('switches to the favorites tab and shows named entries', () => {
    const view = render({
      favorites: [favorite('daily', { name: '每日订单', sql: 'SELECT * FROM dwd_order' })],
    })

    expect(container.querySelector('[data-sql-history-tab="favorites"]')?.getAttribute('aria-selected')).toBe('false')
    view.click(container.querySelector('[data-sql-history-tab="favorites"]'))
    expect(container.querySelector('[data-sql-history-tab="favorites"]')?.getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('每日订单')
    expect(view.items('[data-sql-favorite-item]')).toHaveLength(1)
  })

  it('starts on favorites when asked, with the tab marked active', () => {
    const view = render({ initialTab: 'favorites', favorites: [favorite('a')] })

    expect(container.querySelector('[data-sql-history-tab="favorites"]')?.getAttribute('aria-selected')).toBe('true')
    expect(view.items('[data-sql-favorite-item]')).toHaveLength(1)
  })

  it('inserts a favorite by double click and replaces it from the button', () => {
    const view = render({ initialTab: 'favorites', favorites: [favorite('a', { sql: 'SELECT fav' })] })

    view.doubleClick(view.items('[data-sql-favorite-item]')[0])
    view.click(view.byLabel('替换当前语句'))

    expect(view.calls.insert).toEqual(['SELECT fav'])
    expect(view.calls.replace).toEqual(['SELECT fav'])
  })

  it('selects a favorite with a click and inserts it with Enter', () => {
    const view = render({
      initialTab: 'favorites',
      favorites: [favorite('a', { sql: 'SELECT first' }), favorite('b', { sql: 'SELECT second' })],
    })

    view.click(view.items('[data-sql-favorite-item]')[1])
    expect(view.items('[data-sql-favorite-item]')[1]?.getAttribute('aria-selected')).toBe('true')
    view.key({ key: 'Enter' })

    expect(view.calls.insert).toEqual(['SELECT second'])
  })

  it('removes a favorite from the list', () => {
    const view = render({
      initialTab: 'favorites',
      favorites: [favorite('a', { name: '报表' })],
      withRemove: true,
    })

    view.click(view.byLabel('取消收藏 报表'))

    expect(view.calls.remove).toEqual(['fav-a'])
  })

  it('searches favorites by name and SQL', () => {
    const view = render({
      initialTab: 'favorites',
      favorites: [favorite('a', { name: '每日订单' }), favorite('b', { name: '客户' })],
    })

    view.type('订单')
    expect(view.items('[data-sql-favorite-item]').map(item => item.getAttribute('data-entry-id'))).toEqual(['fav-a'])
    view.type('客户')
    expect(view.items('[data-sql-favorite-item]').map(item => item.getAttribute('data-entry-id'))).toEqual(['fav-b'])
  })

  it('switches back to history from the favorites tab', () => {
    const view = render({ initialTab: 'favorites', entries: [entry('a')] })

    view.click(container.querySelector('[data-sql-history-tab="history"]'))

    expect(view.items()).toHaveLength(1)
    expect(container.querySelector('[data-sql-history-tab="history"]')?.getAttribute('aria-selected')).toBe('true')
  })
})

describe('history panel: keyboard and close', () => {
  it('asks the host to close on Escape', () => {
    const onClose = vi.fn()
    const view = render({ entries: [entry('a')], onClose })

    view.key({ key: 'Escape' })
    view.key({ key: 'Escape' }, view.input())

    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores Escape without a close handler', () => {
    const view = render({ entries: [entry('a')] })

    expect(() => {
      view.key({ key: 'Escape' })
    }).not.toThrow()
  })

  it('ignores unrelated keys', () => {
    const view = render({ entries: [entry('a')] })

    view.key({ key: 'a' })

    expect(view.calls.insert).toEqual([])
    expect(view.calls.replace).toEqual([])
  })

  it('hides the close button without a close handler and shows it with one', () => {
    const without = render({ entries: [entry('a')] })
    expect(without.byLabel('关闭历史面板')).toBeUndefined()

    act(() => {
      root.unmount()
    })
    root = createRoot(container)
    const onClose = vi.fn()
    render({ entries: [entry('a')], onClose })
    act(() => {
      container.querySelector('[aria-label="关闭历史面板"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('counts entries and favorites in the tab labels', () => {
    render({ entries: [entry('a'), entry('b')], favorites: [favorite('a')] })

    expect(container.querySelector('[data-sql-history-tab="history"]')?.textContent).toContain('历史 2')
    expect(container.querySelector('[data-sql-history-tab="favorites"]')?.textContent).toContain('收藏 1')
  })
})
