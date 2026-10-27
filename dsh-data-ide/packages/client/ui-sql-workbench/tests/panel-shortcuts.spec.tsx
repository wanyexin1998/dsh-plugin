// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { SHORTCUTS_STORAGE_KEY, loadSettings } from '../src/client/shortcut-settings.ts'
import { findLabeled } from './support/labeled.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  window.localStorage.clear()
})

const page: ExecuteResponse = {
  columns: [{ name: 'id', typeName: 'LONG' }],
  rows: [[1]],
  total: 1,
  hasNextPage: false,
  offset: 0,
  durationMs: 2,
  statementId: 'st-1',
}

function apiDouble(): WorkbenchApi {
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
    save: vi.fn(async () => ({}) as never),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 1 })),
    execute: vi.fn(async () => ({ ok: true as const, ...page })),
    fetchPage: vi.fn(async () => ({ ok: true as const, ...page })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: 'x', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
  } as unknown as WorkbenchApi
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={apiDouble()} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)

const pressOnWindow = (init: KeyboardEventInit, target: EventTarget = window): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

describe('panel: shortcut settings sheet (requirement 1)', () => {
  it('opens from the top-right icon and closes with its close button', async () => {
    await mount()
    act(() => {
      byLabel('快捷键设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-sql-shortcut-card]')).not.toBeNull()
    expect(container.textContent).toContain('执行光标所在语句')

    act(() => {
      byLabel('关闭快捷键设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[data-sql-shortcut-card]')).toBeNull()
  })

  it('records a new combo, saves it and applies it to the global palette key', async () => {
    await mount()
    act(() => {
      byLabel('快捷键设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Record a new palette chord: Ctrl+Alt+P.
    act(() => {
      byLabel('录制 命令面板')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    pressOnWindow({ key: 'p', ctrlKey: true, altKey: true })
    expect(container.textContent).toContain('快捷键已保存')
    expect(loadSettings().palette).toBe('Ctrl+Alt+P')

    // The new chord now opens the palette; the old one no longer does.
    act(() => {
      byLabel('关闭快捷键设置')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true })
    expect(container.querySelector('[data-command-palette]')).toBeNull()
    pressOnWindow({ key: 'p', ctrlKey: true, altKey: true })
    expect(container.querySelector('[data-command-palette]')).not.toBeNull()
  })

  it('reads persisted settings on mount', async () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ ...loadSettings(), palette: 'Ctrl+Alt+Q' }))
    await mount()
    pressOnWindow({ key: 'q', ctrlKey: true, altKey: true })
    expect(container.querySelector('[data-command-palette]')).not.toBeNull()
  })
})
