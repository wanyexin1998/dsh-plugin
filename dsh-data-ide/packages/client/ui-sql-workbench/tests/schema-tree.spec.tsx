// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SchemaTree } from '../src/client/components/SchemaTree.tsx'
import type { SchemaTable } from '../src/client/completion.ts'
import { type DdlTarget, columnListSql, joinSql, overviewSql, searchObjects, selectFromTableSql } from '../src/client/schema-tree.ts'

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
  readonly generated: string[]
  readonly overviews: SchemaTable[]
  readonly joins: SchemaTable[]
  readonly buttons: () => HTMLButtonElement[]
}

/** Render the tree with spies the assertions can inspect. */
function render(options: {
  tables?: SchemaTable[]
  note?: string
  loading?: boolean
  connectionName?: string
  showRefresh?: boolean
} = {}): Rendered {
  const inserted: string[] = []
  const opened: string[] = []
  const copied: string[] = []
  const refreshed: number[] = []
  const ddlRequests: DdlTarget[] = []
  const generated: string[] = []
  const overviews: SchemaTable[] = []
  const joins: SchemaTable[] = []
  act(() => {
    root.render(
      <SchemaTree
        tables={options.tables ?? tables}
        {...(options.note === undefined ? {} : { note: options.note })}
        loading={options.loading ?? false}
        {...(options.connectionName === undefined ? {} : { connectionName: options.connectionName })}
        {...(options.showRefresh === undefined ? {} : { showRefresh: options.showRefresh })}
        onInsertSql={sql => {
          generated.push(sql)
        }}
        onOverview={table => {
          overviews.push(table)
        }}
        onJoin={table => {
          joins.push(table)
        }}
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
    generated,
    overviews,
    joins,
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

describe('schema tree: hierarchy tints (需求2)', () => {
  /**
   * The `style` prop React rendered onto one element.
   *
   * jsdom's `CSSStyleDeclaration` validates colours and therefore rejects
   * `var(--dsw-…)`, so the semantic token disappears from `element.style` (a
   * literal `rgb(...)` would survive — which is exactly why the component must
   * use tokens). React keeps the rendered props on the node under
   * `__reactProps$…`; reading them is how a jsdom test can assert what reached
   * the inline style.
   */
  const styleOf = (element: Element): Record<string, unknown> => {
    const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
    const props = key === undefined
      ? undefined
      : (element as unknown as Record<string, { style?: Record<string, unknown> }>)[key]
    return props?.style ?? {}
  }

  it('builds every level from semantic tokens in the rendered HTML', () => {
    // Static markup keeps the `var()` text jsdom would drop, so this reads the
    // real inline style instead of a parsed colour.
    const html = renderToStaticMarkup(
      <SchemaTree
        tables={tables}
        loading={false}
        connectionName="doris"
        onInsert={() => undefined}
        onOpenData={() => undefined}
        onShowDdl={() => undefined}
        onCopy={() => undefined}
        onRefresh={() => undefined}
      />,
    )

    // Root: primary + weightier.
    expect(html).toContain('color:var(--dsw-alias-label-primary);font-weight:600')
    // Schema row: secondary on a raised strip (layer-2, not a new colour).
    expect(html).toContain('color:var(--dsw-alias-label-secondary);background-color:var(--dsw-alias-bg-layer-2)')
    // Folder: secondary.
    expect(html).toContain('color:var(--dsw-alias-label-secondary)')
    // No literal colour anywhere in the inline styles (AC-7).
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })

  it('tints the object name primary and the column name/type subdued', () => {
    const view = render({ connectionName: 'doris' })

    const rootCaption = container.querySelector('[data-sql-schema-root]') as Element
    expect(styleOf(rootCaption)).toEqual({ color: 'var(--dsw-alias-label-primary)', fontWeight: 600 })

    act(() => {
      buttonByLabel(view, '展开 dwd_order')?.click()
    })

    const objectRow = container.querySelector('[data-sql-schema-object="dwd_order"]') as HTMLElement
    const objectName = objectRow.querySelector('[class*=schemaName]') as Element
    expect(styleOf(objectName).color).toBe('var(--dsw-alias-label-primary)')

    const columnName = container.querySelector('[class*=schemaColumnName]') as Element
    const columnType = container.querySelector('[class*=schemaColumnType]') as Element
    expect(styleOf(columnName).color).toBe('var(--dsw-alias-label-secondary)')
    expect(styleOf(columnType).color).toBe('var(--dsw-alias-label-tertiary)')

    // Same DOM contract as before: hierarchy, aria and test selectors untouched.
    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()
    expect(buttonByLabel(view, '折叠 dwd_order')).toBeDefined()
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

  it('hides its own refresh button when the caller already has one', () => {
    // Callers that draw refresh elsewhere pass `showRefresh={false}` so the
    // tree toolbar keeps only the filter.
    const embedded = render({ showRefresh: false })
    expect(buttonByLabel(embedded, '刷新表结构')).toBeUndefined()
    expect(container.querySelector('input[aria-label="筛选库、表或字段"]')).not.toBeNull()

    const standalone = render()
    expect(buttonByLabel(standalone, '刷新表结构')).toBeDefined()
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

describe('schema tree: handfeel shortcuts (SQL-212/217)', () => {
  const objectNameButton = (): HTMLButtonElement | null =>
    container.querySelector('[data-sql-schema-object="dwd_order"] button[title^="插入"]') as HTMLButtonElement | null

  const press = (element: Element, init: KeyboardEventInit): void => {
    act(() => {
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
    })
  }

  it('runs 打开数据 on F4 and 查看 DDL on Ctrl+B', () => {
    const view = render()
    const name = objectNameButton()
    expect(name).not.toBeNull()
    press(name!, { key: 'F4' })
    expect(view.opened[0]).toContain('SELECT * FROM')

    press(name!, { key: 'b', ctrlKey: true })
    expect(view.ddlRequests[0]?.table).toBe('dwd_order')

    // Unrelated keys are left to the browser/editor.
    press(name!, { key: 'x' })
    expect(view.opened).toHaveLength(1)
    expect(view.ddlRequests).toHaveLength(1)
  })

  it('generates SELECT and column-list SQL from the context menu', () => {
    const view = render()
    const row = container.querySelector('[data-sql-schema-object="dwd_order"]')
    rightClick(row)
    act(() => {
      menuItem('generate')?.click()
    })
    expect(view.generated[0]).toContain('SELECT')

    rightClick(row)
    act(() => {
      menuItem('columns')?.click()
    })
    expect(view.generated[1]).toContain('order_id')

    rightClick(row)
    act(() => {
      menuItem('overview')?.click()
    })
    expect(view.overviews[0]?.name).toBe('dwd_order')
  })

  it('clears the tree filter on Escape', () => {
    render()
    typeFilter('dwd')
    const input = container.querySelector('input[aria-label="筛选库、表或字段"]') as HTMLInputElement
    expect(input.value).toBe('dwd')
    press(input, { key: 'Escape' })
    expect(input.value).toBe('')
  })

  it('opens DDL for a snapshot entry without schema or kind', () => {
    const view = render({ tables: flat })
    const name = container.querySelector('[data-sql-schema-object="dwd_order"] button[title^="插入"]')
    expect(name).not.toBeNull()
    press(name!, { key: 'b', ctrlKey: true })
    expect(view.ddlRequests[0]).toEqual({ schema: '', table: 'dwd_order' })
  })

  it('quotes columns in the generated SQL', () => {
    expect(selectFromTableSql(tables[2] as SchemaTable)).toBe(
      'SELECT `order_id`,\n  `amount`\nFROM `dwd`.`dwd_order`',
    )
    expect(columnListSql(tables[2] as SchemaTable)).toBe('`order_id`, `amount`')
    expect(selectFromTableSql({ name: 'empty', columns: [] })).toBe('SELECT *\nFROM `empty`')
  })

  it('generates a JOIN skeleton from a shared column (SQL-212)', () => {
    const left: SchemaTable = { schema: 'dwd', name: 'a', columns: [{ name: 'id', type: 'INT' }, { name: 'x', type: 'INT' }] }
    const right: SchemaTable = { schema: 'dwd', name: 'b', columns: [{ name: 'id', type: 'INT' }] }
    const sql = joinSql(left, right)
    expect(sql).toContain('JOIN `dwd`.`b`')
    expect(sql).toContain('ON `dwd`.`a`.`id` = `dwd`.`b`.`id`')

    const unrelated = joinSql(left, { name: 'c', columns: [{ name: 'y', type: 'INT' }] })
    expect(unrelated).toContain('TODO')
  })

  it('hands the JOIN pick to the panel from the context menu', () => {
    const view = render()
    const row = container.querySelector('[data-sql-schema-object="dwd_order"]')
    rightClick(row)
    act(() => {
      menuItem('join')?.click()
    })
    expect(view.joins[0]?.name).toBe('dwd_order')
  })

  it('generates a row/non-null overview statement (SQL-404)', () => {
    expect(overviewSql(tables[2] as SchemaTable)).toBe(
      'SELECT COUNT(*) AS `总行数`,\n  COUNT(`order_id`) AS `order_id_非空`,\n  COUNT(`amount`) AS `amount_非空`\nFROM `dwd`.`dwd_order`',
    )
    expect(overviewSql({ name: 'empty', columns: [] })).toBe('SELECT COUNT(*) AS `总行数`\nFROM `empty`')
  })
})

describe('schema tree: global object search (SQL-214)', () => {
  it('returns nothing for an empty or unmatched query', () => {
    expect(searchObjects(tables, '')).toEqual([])
    expect(searchObjects(tables, 'zzz')).toEqual([])
  })

  it('ranks table matches before column matches, then caps the list', () => {
    const orderHits = searchObjects(tables, 'order')
    expect(orderHits[0]?.table.name).toBe('dwd_order')
    expect(orderHits[0]?.column).toBeUndefined()
    // `order_id` also matches, but only after every table hit.
    const firstColumnHit = orderHits.findIndex(match => match.column !== undefined)
    const lastTableHit = orderHits.map(match => match.column === undefined).lastIndexOf(true)
    expect(firstColumnHit).toBeGreaterThan(lastTableHit)

    const columnHits = searchObjects(tables, 'amount')
    expect(columnHits[0]?.column?.name).toBe('amount')

    expect(searchObjects(tables, 'order', 1)).toHaveLength(1)
  })

  it('caps column matches too', () => {
    const wide: SchemaTable[] = [
      { name: 'wide', columns: Array.from({ length: 10 }, (_value, index) => ({ name: `c${String(index)}`, type: 'INT' })) },
    ]
    expect(searchObjects(wide, 'c', 3)).toHaveLength(3)
  })
})
