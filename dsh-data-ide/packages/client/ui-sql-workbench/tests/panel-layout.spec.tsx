// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { SchemaSnapshot } from '../src/host/metadata.ts'
import { createDataSource } from '../src/datasource/model.ts'
import { EDITOR_HEIGHT_DEFAULT, TREE_WIDTH_DEFAULT } from '../src/client/split.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'h1', username: 'u' })

const snapshot: SchemaSnapshot = {
  fetchedAt: '2026-10-19T00:00:00.000Z',
  truncated: false,
  source: 'information_schema',
  tables: [{ schema: 'dwd', kind: 'table', name: 'dwd_order', columns: [{ name: 'order_id', type: 'BIGINT' }] }],
}

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

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => doris),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    fetchPage: vi.fn(async () => ({ ok: false as const, error: { code: 'X', message: 'x' } })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => snapshot),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  }
}

async function mount(api: WorkbenchApi = apiDouble()): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const workspace = (): HTMLElement => container.querySelector('[data-sql-workspace]') as HTMLElement
const column = (): HTMLElement => container.querySelector('[data-sql-pane-column]') as HTMLElement
const panel = (id: string): HTMLElement | null => container.querySelector(`[data-sql-panel="${id}"]`)
const sash = (orientation: 'vertical' | 'horizontal'): HTMLElement =>
  container.querySelector(`[data-sql-splitter="${orientation}"]`) as HTMLElement
const click = (element: Element | null | undefined): void => {
  if (element === null || element === undefined) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === label) as HTMLElement | undefined

/** Drag a sash from one pointer position to another. */
function drag(element: HTMLElement, from: number, to: number, axis: 'clientX' | 'clientY'): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, [axis]: from }))
    element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, [axis]: to }))
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
  })
}

describe('panel layout: three panes', () => {
  it('puts the object browser on the left and editor over results on the right', async () => {
    await mount()

    expect(panel('objects')).not.toBeNull()
    expect(panel('editor')).not.toBeNull()
    expect(panel('result')).not.toBeNull()
    // The rail is a grid column, the editor/result stack a grid of two rows.
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT)}px`)
  })

  it('collapses the object tree without reserving a column', async () => {
    await mount()
    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()

    click(byLabel('收起对象树'))
    expect(panel('objects')).toBeNull()
    expect(container.querySelector('[data-sql-schema-tree]')).toBeNull()
    // The whole point: no rail column and no sash gap left behind, so the editor
    // gets the full width instead of a squeezed one.
    expect(workspace().style.gridTemplateColumns).toBe('minmax(0, 1fr)')
    expect(workspace().getAttribute('data-tree')).toBe('closed')

    click(byLabel('展开对象树'))
    expect(panel('objects')).not.toBeNull()
    expect(container.querySelector('[data-sql-schema-tree]')).not.toBeNull()
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
  })

  it('names each pane in its header', async () => {
    await mount()

    const heads = [...container.querySelectorAll('[data-sql-panel] header')].map(head => head.textContent ?? '')
    expect(heads.join('|')).toContain('对象')
    expect(heads.join('|')).toContain('结果')
    // The editor is headless: its own toolbar already names the action.
    expect(panel('editor')?.querySelector('header')).toBeNull()
  })

  it('keeps the console tabs inside the editor pane', async () => {
    await mount()

    const strip = container.querySelector('[data-sql-documents]')
    expect(strip).not.toBeNull()
    // DataGrip puts `console_17 …` on the editor; the strip is part of that pane,
    // not a row spanning the whole workbench.
    expect(strip?.closest('[data-sql-panel]')?.getAttribute('data-sql-panel')).toBe('editor')
    expect(workspace().contains(strip)).toBe(true)
    expect(panel('editor')?.contains(strip)).toBe(true)
  })

  it('shows the object summary and source in the objects header', async () => {
    await mount()

    const meta = container.querySelector('[data-sql-panel-meta="objects"]')
    expect(meta?.textContent).toContain('1 个对象')
    expect(meta?.textContent).toContain('information_schema')
  })
})

describe('panel layout: sashes', () => {
  it('widens the object panel by dragging the vertical sash', async () => {
    await mount()

    drag(sash('vertical'), 300, 360, 'clientX')

    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT + 60)}px`)
  })

  it('clamps the object panel so the editor keeps room', async () => {
    await mount()

    drag(sash('vertical'), 300, 3000, 'clientX')

    // No layout in jsdom → the helper's fixed ceiling applies (default + 240).
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT + 240)}px`)
  })

  it('resizes the editor row by dragging the horizontal sash', async () => {
    await mount()

    drag(sash('horizontal'), 200, 260, 'clientY')

    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT + 60)}px`)
  })

  it('nudges with the arrow keys and resets on double click', async () => {
    await mount()
    const vertical = sash('vertical')

    act(() => {
      vertical.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT + 16)}px`)

    act(() => {
      vertical.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
  })

  it('ignores keys that are not on its axis', async () => {
    await mount()

    act(() => {
      sash('vertical').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
  })

  it('exposes the size it controls through aria', async () => {
    await mount()

    expect(sash('vertical').getAttribute('aria-valuenow')).toBe(String(TREE_WIDTH_DEFAULT))
    expect(sash('vertical').getAttribute('aria-orientation')).toBe('vertical')
    expect(sash('horizontal').getAttribute('aria-valuenow')).toBe(String(EDITOR_HEIGHT_DEFAULT))
  })

  it('marks itself while dragging and clears on pointer up', async () => {
    await mount()
    const vertical = sash('vertical')

    act(() => {
      vertical.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 300 }))
    })
    expect(vertical.hasAttribute('data-dragging')).toBe(true)

    act(() => {
      vertical.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(vertical.hasAttribute('data-dragging')).toBe(false)
  })
})

describe('panel layout: sash chrome', () => {
  it('nudges the editor row both ways and resets it', async () => {
    await mount()
    const horizontal = sash('horizontal')

    act(() => {
      horizontal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT + 16)}px`)

    act(() => {
      horizontal.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT)}px`)

    act(() => {
      horizontal.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    // 200 - 16, clamped at the editor minimum (96).
    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT - 16)}px`)
  })

  it('nudges the rail back with ArrowLeft', async () => {
    await mount()

    act(() => {
      sash('vertical').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT - 16)}px`)
  })

  it('captures the pointer when the platform offers it', async () => {
    await mount()
    const vertical = sash('vertical')
    const capture = vi.fn()
    Object.defineProperty(vertical, 'setPointerCapture', { value: capture, configurable: true })

    act(() => {
      vertical.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 200 }))
    })

    // The id comes from the real PointerEvent; jsdom's MouseEvent has none, so
    // only the call itself is asserted here.
    expect(capture).toHaveBeenCalledTimes(1)
  })
})

describe('panel layout: narrow sidebar', () => {
  it('re-clamps the rail when the workspace is measured', async () => {
    await mount()
    // jsdom reports 0; stand in for a 500px sidebar, where 244px is too wide.
    Object.defineProperty(workspace(), 'clientWidth', { value: 500, configurable: true })

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    // 500 - 320 (editor floor) - 8 (gap) = 172
    expect(workspace().style.gridTemplateColumns).toContain('172px')
  })

  it('leaves the rail alone when it already fits', async () => {
    await mount()
    Object.defineProperty(workspace(), 'clientWidth', { value: 2400, configurable: true })

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
  })
})

describe('panel layout: persistence (09 B3)', () => {
  it('restores the saved collapse', async () => {
    const layout = vi.fn(async () => ({ treeOpen: false, treeWidth: 320, editorHeight: 320 }))
    await mount(apiDouble({ layout }))

    expect(workspace().getAttribute('data-tree')).toBe('closed')
    expect(workspace().style.gridTemplateColumns).toBe('minmax(0, 1fr)')
  })

  it('restores the saved widths', async () => {
    const layout = vi.fn(async () => ({ treeOpen: true, treeWidth: 320, editorHeight: 300 }))
    await mount(apiDouble({ layout }))

    expect(workspace().style.gridTemplateColumns).toContain('320px')
    expect(column().style.gridTemplateRows).toContain('300px')
  })

  it('falls back to defaults for an unreadable document', async () => {
    const layout = vi.fn(async () => ({ treeWidth: 0, editorHeight: Number.POSITIVE_INFINITY }))
    await mount(apiDouble({ layout }))

    expect(workspace().style.gridTemplateColumns).toContain(`${String(TREE_WIDTH_DEFAULT)}px`)
    expect(column().style.gridTemplateRows).toContain(`${String(EDITOR_HEIGHT_DEFAULT)}px`)
  })

  it('becomes ready when loading the saved layout fails', async () => {
    const saveLayout = vi.fn(async () => undefined)
    await mount(apiDouble({ layout: vi.fn(async () => Promise.reject(new Error('bad layout'))), saveLayout }))

    click(byLabel('收起对象树'))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 450))
    })
    expect(saveLayout).toHaveBeenCalledWith(expect.objectContaining({ treeOpen: false }))
  })

  it('persists a collapse after the debounce', async () => {
    const saveLayout = vi.fn(async () => undefined)
    await mount(apiDouble({ saveLayout }))

    click(byLabel('收起对象树'))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 450))
    })

    expect(saveLayout).toHaveBeenCalledWith(expect.objectContaining({ treeOpen: false }))
  })
})
