// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import type { WorkbenchApi } from '../src/client/api.ts'
import type { ExecuteResponse } from '../src/execute/core.ts'

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

const schema = {
  tables: [
    {
      schema: 'dwd',
      kind: 'table' as const,
      name: 'dwd_order',
      columns: [
        { name: 'order_id', type: 'BIGINT' },
        { name: 'amount', type: 'DECIMAL' },
      ],
    },
  ],
  fetchedAt: 'x',
  truncated: false,
  source: 'information_schema' as const,
}

const statsPage: ExecuteResponse = {
  columns: [
    { name: 'total', typeName: 'LONG' },
    { name: 'order_id_nonnull', typeName: 'LONG' },
    { name: 'amount_nonnull', typeName: 'LONG' },
  ],
  rows: [[10, 10, 8]],
  total: 1,
  hasNextPage: false,
  offset: 0,
  durationMs: 2,
  statementId: 'st-1',
}

const samplePage: ExecuteResponse = {
  columns: [
    { name: 'order_id', typeName: 'BIGINT' },
    { name: 'amount', typeName: 'DECIMAL' },
  ],
  rows: [[1, 9.5]],
  total: 1,
  hasNextPage: false,
  offset: 0,
  durationMs: 1,
  statementId: 'st-2',
}

function apiDouble(execute: WorkbenchApi['execute']): WorkbenchApi {
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
    execute,
    fetchPage: vi.fn(async () => ({ ok: true as const, ...statsPage })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => schema),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
  } as unknown as WorkbenchApi
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

async function mount(api: WorkbenchApi): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="s1" api={api} />)
  })
  await settle()
}

const click = (element: Element | null | undefined): void => {
  if (element === null || element === undefined) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const byLabel = (label: string): HTMLElement | undefined =>
  [...container.querySelectorAll(`[aria-label="${label}"]`)][0] as HTMLElement | undefined

function openOverview(): void {
  const row = container.querySelector('[data-sql-schema-object="dwd_order"]')
  act(() => {
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
  })
  click(container.querySelector('[data-sql-menu-item="overview"]'))
}

describe('panel: table overview dialog (requirement 5)', () => {
  it('loads stats, sample and DDL, then closes', async () => {
    const execute = vi.fn(async (request: { sql: string }) => {
      if (request.sql.startsWith('SHOW CREATE')) {
        return {
          ok: true as const,
          columns: [
            { name: 'Table', typeName: 'VARCHAR' },
            { name: 'Create Table', typeName: 'VARCHAR' },
          ],
          rows: [['dwd_order', 'CREATE TABLE `dwd_order` (`order_id` bigint)']],
          total: 1,
          hasNextPage: false,
          offset: 0,
          durationMs: 1,
          statementId: 'ddl',
        }
      }
      if (request.sql.includes('LIMIT 20')) return { ok: true as const, ...samplePage }
      return { ok: true as const, ...statsPage }
    })
    const api = apiDouble(execute as unknown as WorkbenchApi['execute'])
    await mount(api)
    openOverview()
    await settle()

    expect(container.querySelector('[data-overview-body]')).not.toBeNull()
    expect(container.querySelector('[data-overview-stats]')).not.toBeNull()
    expect(container.textContent).toContain('20.0%')
    expect(container.querySelector('[data-overview-sample-scroll]')).not.toBeNull()
    expect(container.textContent).toContain('CREATE TABLE `dwd_order`')
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('SHOW CREATE') }))

    click(byLabel('关闭表概览'))
    expect(container.querySelector('[data-overview-body]')).toBeNull()
  })

  it('shows each section failure without breaking the dialog', async () => {
    const execute = vi.fn(async () => ({ ok: false as const, error: { code: 'DENIED', message: '没有权限' } }))
    const api = apiDouble(execute as unknown as WorkbenchApi['execute'])
    await mount(api)
    openOverview()
    await settle()

    expect(container.querySelector('[data-overview-body]')).not.toBeNull()
    expect(container.textContent).toContain('统计加载失败')
    expect(container.textContent).toContain('没有权限')
  })

  it('handles a flat snapshot entry without schema or kind', async () => {
    const execute = vi.fn(async (request: { sql: string }) => {
      if (request.sql.startsWith('SHOW CREATE')) {
        return {
          ok: true as const,
          columns: [
            { name: 'Table', typeName: 'VARCHAR' },
            { name: 'Create Table', typeName: 'VARCHAR' },
          ],
          rows: [['loose', 'CREATE TABLE `loose` (`id` int)']],
          total: 1,
          hasNextPage: false,
          offset: 0,
          durationMs: 1,
          statementId: 'ddl',
        }
      }
      return { ok: true as const, ...statsPage }
    })
    const api = apiDouble(execute as unknown as WorkbenchApi['execute'])
    ;(api.schema as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      tables: [{ name: 'loose', columns: [{ name: 'id', type: 'INT' }] }],
      fetchedAt: 'x',
      truncated: false,
      source: 'information_schema' as const,
    })
    await mount(api)
    const row = container.querySelector('[data-sql-schema-object="loose"]')
    act(() => {
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }))
    })
    click(container.querySelector('[data-sql-menu-item="overview"]'))
    await settle()

    expect(container.querySelector('[data-overview-body]')).not.toBeNull()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SHOW CREATE TABLE `loose`' }))
  })
})
