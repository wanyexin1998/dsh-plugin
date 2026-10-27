// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'
import { readSql, setSql } from './support/editor.ts'
import { findLabeled } from './support/labeled.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'

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
    executeScript: vi.fn(async () => ({
      statements: [{ sql: '', ok: true as const, result: page }],
      durationMs: 2,
    })),
  } as unknown as WorkbenchApi
}

async function mount(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const byLabel = (label: string): HTMLElement | undefined => findLabeled(label)

const click = (element: HTMLElement | undefined): void => {
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const type = (label: string, value: string): void => {
  const input = byLabel(label) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('named parameters (SQL-403)', () => {
  it('asks for :name values and runs the substituted statement', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'SELECT * FROM t WHERE id = :id AND name = :name')
    })
    click(byLabel('执行'))
    await settle()

    expect(container.querySelector('[data-params-form]')).not.toBeNull()
    type('参数 id', '42')
    type('参数 name', 'Bob')
    click(byLabel('执行带参数的语句'))
    await settle()

    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "SELECT * FROM t WHERE id = 42 AND name = 'Bob'" }),
    )
    expect(readSql(container)).toContain(':id')
  })

  it('substitutes before an EXPLAIN run', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'SELECT * FROM t WHERE id = :id')
    })
    click(byLabel('解释计划'))
    await settle()
    type('参数 id', '7')
    click(byLabel('执行带参数的语句'))
    await settle()

    expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'EXPLAIN SELECT * FROM t WHERE id = 7' }))
  })

  it('substitutes across a multi-statement script', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'SELECT :a; SELECT 2')
    })
    click(byLabel('执行全部'))
    await settle()
    type('参数 a', '5')
    click(byLabel('执行带参数的语句'))
    await settle()

    expect(api.executeScript).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 5; SELECT 2' }))
  })

  it('cancels without executing', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'SELECT * FROM t WHERE id = :id')
    })
    click(byLabel('执行'))
    await settle()
    click(byLabel('取消参数'))
    await settle()

    expect(container.querySelector('[data-params-form]')).toBeNull()
    expect(api.execute).not.toHaveBeenCalled()
  })

  it('runs parameter-free statements without opening the form', async () => {
    const api = apiDouble()
    await mount(api)
    act(() => {
      setSql(container, 'SELECT 1')
    })
    click(byLabel('执行'))
    await settle()

    expect(container.querySelector('[data-params-form]')).toBeNull()
    expect(api.execute).toHaveBeenCalled()
  })
})
