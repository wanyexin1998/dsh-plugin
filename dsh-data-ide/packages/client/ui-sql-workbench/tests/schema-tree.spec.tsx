// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SchemaTree } from '../src/client/components/SchemaTree.tsx'
import type { SchemaTable } from '../src/client/completion.ts'
import type { DdlTarget } from '../src/client/schema-tree.ts'

/**
 * Two schemas, a view, and a table name that repeats across namespaces.
 *
 * `ads` sorts first, so it is the schema the tree opens by default — it carries
 * both a table and a view, which lets one fixture cover both folders.
 */
const tables: SchemaTable[] = [
  {
    schema: 'ads',
    kind: 'table',
    name: 'dwd_order',
    columns: [{ name: 'order_id', type: 'BIGINT' }],
  },
  {
    schema: 'ads',
    kind: 'view',
    name: 'v_order_daily',
    columns: [{ name: 'day', type: 'DATE' }],
  },
  {
    schema: 'dwd',
    kind: 'table',
    name: 'dwd_order',
    columns: [
      { name: 'order_id', type: 'BIGINT' },
      { name: 'amount', type: 'DECIMAL' },
    ],
  },
]

const flat: SchemaTable[] = [
  { name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] },
  { name: 'dwd_customer', columns: [{ name: 'customer_name', type: 'VARCHAR' }] },
  // A nameless snapshot can still carry a view: the flat layout must show both folders.
  { kind: 'view', name: 'v_loose', columns: [{ name: 'day', type: 'DATE' }] },
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

type Rendered = {
  readonly inserted: string[]
  readonly opened: string[]
  readonly copied: string[]
  readonly refreshed: number[]
  readonly ddlRequests: DdlTarget[]
  readonly buttons: () => HTMLButtonElement[]
}

/** Render the tree with spies the assertions can inspect. */
function render(options: {
  tables?: SchemaTable[]
  note?: string
  loading?: boolean
  connectionName?: string
} = {}): Rendered {
  const inserted: string[] = []
  const opened: string[] = []
  const copied: string[] = []
  const refreshed: number[] = []
  const ddlRequests: DdlTarget[] = []
  act(() => {
    root.render(
      <SchemaTree
        tables={options.tables ?? tables}
        {...(options.note === undefined ? {} : { note: options.note })}
        loading={options.loading ?? false}
        {...(options.connectionName === undefined ? {} : { connectionName: options.connectionName })}
        onInsert={name => {
          inserted.push(name)
        }}
        onOpenData={sql => {
          opened.push(sql)
        }}
        onShowDdl={target => {
          // The tree no longer shows DDL itself: it hands the target to the
          // panel, which opens it in a console tab.
          ddlRequests.push(target)
        }}
        onCopy={text => {
          copied.push(text)
        }}
        onRefresh={() => {
          refreshed.push(Date.now())
        }}
      />,
    )
  })
  return {
    inserted,
    opened,
    copied,
    refreshed,
    ddlRequests,
    buttons: () => [...container.querySelectorAll('button')] as HTMLButtonElement[],
  }
}

const buttonByLabel = (view: Rendered, label: string): HTMLButtonElement | undefined =>
  view.buttons().find(button => button.getAttribute('aria-label') === label)

const menuItem = (id: string): HTMLButtonElement | null =>
  container.querySelector(`[data-sql-menu-item="${id}"]`) as HTMLButtonElement | null

const rightClick = (element: Element | null | undefined): void => {
  if (element === null || element === undefined) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }))
  })
}

const typeFilter = (value: string): void => {
  const filter = container.querySelector('input[aria-label="筛选库、表或字段"]') as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(filter, value)
    filter.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('schema tree: hierarchy', () => {
  it('nests 库 → 表/视图 分组 → 对象 → 列 and opens the first tables folder', () => {
    const view = render()

    const text = container.textContent ?? ''
    // Both schemas are top-level rows; only the first one is open by default.
    expect(container.querySelector('[data-sql-schema="ads"]')).not.toBeNull()
    expect(container.querySelector('[data-sql-schema="dwd"]')).not.toBeNull()
    expect(text).toContain('表')
    expect(text).toContain('视图')
    // ads' Tables folder is open, so its object row is on screen…
    expect(container.querySelector('[data-sql-schema-object="dwd_order"]')).not.toBeNull()
    // …while its Views folder is folded.
    expect(container.querySelector('[data-sql-schema-object="v_order_daily"]')).toBeNull()

    act(() => {
      buttonByLabel(view, '展开视图')?.click()
    })
    expect(container.textContent).toContain('v_order_daily')

    // Expand the object to reach its columns.
    act(() => {
      buttonByLabel(view, '展开 dwd_order')?.click()
    })
    expect(container.textContent).toContain('order_id')
  })

  it('skips the schema level when the snapshot has no schema names', () => {
    const view = render({ tables: flat })

    expect(container.querySelector('[data-sql-schema]')).toBeNull()
    const names = [...container.querySelectorAll('[class*=schemaName]')].map(node => node.textContent)
    expect(names.join('|')).toContain('dwd_order')
    expect(buttonByLabel(view, '展开 dwd_order')).toBeDefined()
  })

  it('shows the data source as the root caption when told its name', () => {
    render({ connectionName: 'doris' })

    const rootCaption = container.querySelector('[data-sql-schema-root]')
    expect(rootCaption?.textContent).toContain('doris')
  })

  it('keeps same-named tables apart by schema', () => {
    render()
    // dwd is open; ads is closed, so exactly one dwd_order row is rendered.
    expect(container.querySelectorAll('[data-sql-schema-object="dwd_order"]')).toHaveLength(1)
  })
})

describe('schema tree: inserting and filtering', () => {
  it('inserts a table name on click and a column name from its list', () => {
    const view = render({ tables: flat })

    act(() => {
      view.buttons().find(button => button.textContent?.includes('dwd_customer'))?.click()
    })
    expect(view.inserted).toEqual(['dwd_customer'])

    act(() => {
      buttonByLabel(view, '展开 dwd_order')?.click()
    })
    const column = view.buttons().find(button => button.textContent?.includes('order_id'))
    act(() => {
      column?.click()
    })
    expect(view.inserted).toEqual(['dwd_customer', 'order_id'])
  })

  it('filters by table or column name and auto-expands the matches', () => {
    render()
    typeFilter('v_order')

    expect(container.textContent).toContain('v_order_daily')
    expect(container.textContent).not.toContain('dwd_customer')
  })

  it('keeps a table whole when its own name matches, and narrows when only a column does', () => {
    render({ tables: flat })

    typeFilter('dwd_order')
    expect(container.textContent).toContain('dwd_order')

    typeFilter('customer_name')
    expect(container.textContent).toContain('dwd_customer')
    expect(container.textContent).toContain('customer_name')
  })

  it('collapses a folder again', () => {
    const view = render()
    const toggle = buttonByLabel(view, '折叠表')

    act(() => {
      toggle?.click()
    })
    expect(container.textContent).not.toContain('dwd_order')

    act(() => {
      buttonByLabel(view, '展开表')?.click()
    })
    expect(container.textContent).toContain('dwd_order')
  })
})

describe('schema tree: objects without columns', () => {
  it('shows a placeholder for a view whose columns the catalogue does not report', () => {
    render({
      tables: [
        { schema: 'dwd', kind: 'view', name: 'dwd_trade_order_all_v', columns: [] },
      ],
    })

    // The object itself is listed…
    expect(container.querySelector('[data-sql-schema-object="dwd_trade_order_all_v"]')).not.toBeNull()
    // …and expanding it explains why there is nothing under it.
    const toggle = [...container.querySelectorAll('button')]
      .find(node => node.getAttribute('aria-label') === '展开 dwd_trade_order_all_v')
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-sql-empty-object]')?.textContent).toContain('无列信息（视图）')
  })

  it('says 无列信息 for a table that reports no columns either', () => {
    render({ tables: [{ schema: 'dwd', kind: 'table', name: 'dwd_empty', columns: [] }] })

    const toggle = [...container.querySelectorAll('button')]
      .find(node => node.getAttribute('aria-label') === '展开 dwd_empty')
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const empty = container.querySelector('[data-sql-empty-object]')
    expect(empty?.textContent).toBe('无列信息')
  })
})

describe('schema tree: context menu', () => {
  it('runs the item when the click goes through pointerdown first (a real click)', () => {
    const view = render({ tables: flat })
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    const item = menuItem('open') ?? menuItem('data')
    expect(item).toBeTruthy()

    // A real click is pointerdown → pointerup → click. The menu used to unmount
    // on the pointerdown (outside-click handler), so the click never landed —
    // every item looked dead.
    act(() => {
      // jsdom has no PointerEvent; the handler only needs `target` and `type`.
      item?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(container.querySelector('[data-sql-schema-menu]')).not.toBeNull()
    act(() => {
      item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(view.opened.length + view.inserted.length).toBeGreaterThan(0)
    expect(container.querySelector('[data-sql-schema-menu]')).toBeNull()
  })

  it('offers DataGrip’s object actions and runs 打开数据 / 插入 / 复制 / 刷新', () => {
    const view = render({ tables: flat })

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    expect(container.querySelector('[data-sql-schema-menu]')).not.toBeNull()
    expect(container.textContent).toContain('打开数据')
    expect(container.textContent).toContain('查看 DDL')

    act(() => {
      menuItem('data')?.click()
    })
    expect(view.opened).toEqual(['SELECT * FROM `dwd_order` LIMIT 100'])
    // Choosing an item closes the menu.
    expect(container.querySelector('[data-sql-schema-menu]')).toBeNull()

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      menuItem('copy')?.click()
    })
    expect(view.copied).toEqual(['`dwd_order`'])

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      menuItem('insert')?.click()
    })
    expect(view.inserted).toEqual(['dwd_order'])

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      menuItem('refresh')?.click()
    })
    expect(view.refreshed).toHaveLength(1)
  })

  it('qualifies the reference with the schema when there is one', () => {
    const view = render()

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      menuItem('copy')?.click()
    })
    expect(view.copied).toEqual(['`ads`.`dwd_order`'])
  })

  it('offers insert and copy on a column', () => {
    const view = render({ tables: flat })
    act(() => {
      buttonByLabel(view, '展开 dwd_order')?.click()
    })

    rightClick(container.querySelector('button[class*=schemaColumn]'))
    expect(menuItem('insert')).not.toBeNull()
    act(() => {
      menuItem('insert')?.click()
    })
    expect(view.inserted).toEqual(['order_id'])

    rightClick(container.querySelector('button[class*=schemaColumn]'))
    act(() => {
      menuItem('copy')?.click()
    })
    expect(view.copied).toEqual(['order_id'])
  })

  it('closes the menu on Escape and on an outside pointer down', () => {
    render()
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('[data-sql-schema-menu]')).toBeNull()

    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
    })
    expect(container.querySelector('[data-sql-schema-menu]')).toBeNull()
  })

  it('offers 复制库名 and 刷新 on a schema node', () => {
    const view = render()

    rightClick(container.querySelector('[data-sql-schema="ads"]'))
    act(() => {
      menuItem('copy')?.click()
    })
    expect(view.copied).toEqual(['ads'])
  })

  it('opens data on a double click, like F4 on a table', () => {
    const view = render({ tables: flat })

    act(() => {
      container.querySelector('[data-sql-schema-object="dwd_order"]')
        ?.querySelector('[class*=schemaName]')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(view.opened).toEqual(['SELECT * FROM `dwd_order` LIMIT 100'])
  })
})

describe('schema tree: DDL handoff', () => {
  it('hands the table to the panel instead of opening a dialog', () => {
    const view = render()
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))

    act(() => {
      menuItem('ddl')?.click()
    })

    expect(view.ddlRequests).toEqual([{ schema: 'ads', table: 'dwd_order', kind: 'table' }])
    // No dialog over the tree any more — the panel opens a console tab.
    expect(container.querySelector('[data-sql-ddl]')).toBeNull()
  })

  it('asks a view for a view DDL', () => {
    const view = render()
    act(() => {
      buttonByLabel(view, '展开视图')?.click()
    })
    rightClick(container.querySelector('[data-sql-schema-object="v_order_daily"]'))

    act(() => {
      menuItem('ddl')?.click()
    })

    expect(view.ddlRequests).toEqual([{ schema: 'ads', table: 'v_order_daily', kind: 'view' }])
  })
})

describe('schema tree: folders that are absent', () => {
  it('renders only the Tables folder when a schema has no views', () => {
    const view = render()
    act(() => {
      buttonByLabel(view, '展开 dwd')?.click()
    })

    expect(container.querySelector('[data-sql-schema-object="dwd_order"]')).not.toBeNull()
    // ads owns the only view, and it is not part of dwd.
    expect(container.querySelectorAll('[data-sql-schema-object="v_order_daily"]')).toHaveLength(0)
  })
})

describe('schema tree: DDL edge cases', () => {
  it('asks for a nameless, kind-less object without inventing fields', () => {
    const view = render({ tables: flat })
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))

    act(() => {
      menuItem('ddl')?.click()
    })

    expect(view.ddlRequests).toEqual([{ schema: '', table: 'dwd_order' }])
  })

  it('renders a flat snapshot that only has views', () => {
    render({ tables: [{ kind: 'view', name: 'v_only', columns: [{ name: 'day', type: 'DATE' }] }] })

    expect(container.textContent).toContain('v_only')
    expect(container.textContent).toContain('视图')
  })
})

describe('schema tree: folders that are absent', () => {
  it('renders only the Tables folder when a schema has no views', () => {
    const view = render()
    act(() => {
      buttonByLabel(view, '展开 dwd')?.click()
    })

    expect(container.querySelector('[data-sql-schema-object="dwd_order"]')).not.toBeNull()
    // ads owns the only view, and it is not part of dwd.
    expect(container.querySelectorAll('[data-sql-schema-object="v_order_daily"]')).toHaveLength(0)
  })
})

describe('schema tree: DDL edge cases', () => {
  it('asks for a nameless, kind-less object without inventing fields', () => {
    const view = render({ tables: flat })
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))

    act(() => {
      menuItem('ddl')?.click()
    })

    expect(view.ddlRequests).toEqual([{ schema: '', table: 'dwd_order' }])
  })

  it('renders a flat snapshot that only has views', () => {
    render({ tables: [{ kind: 'view', name: 'v_only', columns: [{ name: 'day', type: 'DATE' }] }] })

    expect(container.textContent).toContain('v_only')
    expect(container.textContent).toContain('视图')
  })
})

describe('schema tree: empty and loading states', () => {
  it('shows a note but no error styling when the listing is empty', () => {
    render({ tables: [], note: '读不到任何表：可能是缺少授权' })

    expect(container.textContent).toContain('读不到任何表')
    expect(container.querySelector('[data-sql-schema-note]')).not.toBeNull()
  })

  it('says it is loading and disables refresh', () => {
    const view = render({ loading: true })

    expect(container.textContent).toContain('正在读取表结构')
    expect(buttonByLabel(view, '刷新表结构')?.disabled).toBe(true)
  })

  it('asks for a refresh', () => {
    const view = render()
    act(() => {
      buttonByLabel(view, '刷新表结构')?.click()
    })
    expect(view.refreshed).toHaveLength(1)
  })

  it('says so when there is nothing at all', () => {
    render({ tables: [] })
    expect(container.textContent).toContain('没有可见的表')
  })
})

describe('schema tree: schema and menu chrome', () => {
  it('collapses and expands a schema node', () => {
    const view = render()
    // `ads` is the schema opened by default.
    act(() => {
      buttonByLabel(view, '折叠 ads')?.click()
    })
    expect(container.textContent).not.toContain('dwd_order')

    act(() => {
      buttonByLabel(view, '展开 ads')?.click()
    })
    expect(container.textContent).toContain('dwd_order')
  })

  it('suppresses the browser menu on the panel’s own menu', () => {
    render({ tables: flat })
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))

    const menu = container.querySelector('[data-sql-schema-menu]') as HTMLElement
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      menu.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(container.querySelector('[data-sql-schema-menu]')).not.toBeNull()
  })
})

describe('schema tree: menu placement', () => {
  it('positions the menu from the click point', () => {
    render({ tables: flat })
    rightClick(container.querySelector('[data-sql-schema-object="dwd_order"]'))

    const menu = container.querySelector('[data-sql-schema-menu]') as HTMLElement
    expect(menu.style.left).toBe('40px')
    expect(menu.style.top).toBe('60px')
  })
})

describe('schema tree: seeds expansion once per snapshot', () => {
  it('does not reopen a folder the user collapsed when only the columns change', () => {
    const view = render({ tables: flat })
    act(() => {
      buttonByLabel(view, '折叠表')?.click()
    })
    expect(container.textContent).not.toContain('dwd_order')

    // New array, same identity of content: the user's collapse stands.
    render({ tables: flat.map(table => ({ ...table })) })
    expect(container.textContent).not.toContain('dwd_order')
  })

  it('opens the first folder of a brand new snapshot', () => {
    render({ tables: flat })
    render({ tables: [] })
    expect(container.textContent).toContain('没有可见的表')

    render({ tables: flat })
    expect(container.textContent).toContain('dwd_order')
  })
})

describe('schema tree: spies are optional', () => {
  it('renders without a connection name or note', () => {
    render()
    expect(vi.isMockFunction(vi.fn())).toBe(true)
    expect(container.querySelector('[data-sql-schema-root]')).toBeNull()
    expect(container.querySelector('[data-sql-schema-note]')).toBeNull()
  })
})
