// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentDelivery } from '../src/execute/agent-delivery.ts'

const stream = vi.hoisted(() => ({
  listener: undefined as ((delivery: unknown) => void) | undefined,
  publish: vi.fn(async () => undefined),
}))

vi.mock('../src/client/agent-stream.ts', () => ({
  AGENT_STREAM_ROUTES: {
    events: '/dsh-data-ide/agent-events',
    results: '/dsh-data-ide/agent-results',
    consoles: '/dsh-data-ide/agent-consoles',
  },
  subscribeAgentDeliveries: vi.fn((listener: (delivery: unknown) => void) => {
    stream.listener = listener
    return () => {
      stream.listener = undefined
    }
  }),
  publishConsoles: stream.publish,
}))

import type { WorkbenchApi } from '../src/client/api.ts'
import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import { findLabeled } from './support/labeled.ts'
import { createDataSource } from '../src/datasource/model.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'h', username: 'u' })

function apiDouble(): WorkbenchApi {
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
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
  }
}

function delivery(label: string, sql = `select '${label}'`): AgentDelivery {
  return {
    schema: 1,
    id: `delivery-${label}-${sql}`,
    label,
    connId,
    consoleId: null,
    sql,
    kind: 'single',
    at: '2026-10-21T00:00:00.000Z',
    single: {
      ok: true,
      columns: [{ name: 'v', typeName: 'VARCHAR' }],
      rows: [[label]],
      total: 1,
      hasNextPage: false,
      offset: 0,
      durationMs: 1,
      statementId: `s-${label}`,
    },
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount(api: WorkbenchApi = apiDouble()): Promise<void> {
  await act(async () => {
    root.render(<SqlWorkbenchPanel sessionId="agent-test" api={api} />)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function emit(value: AgentDelivery): Promise<void> {
  await act(async () => {
    stream.listener?.(value)
    await Promise.resolve()
  })
}

function click(element: Element | null): void {
  if (element === null) throw new Error('element not found')
  act(() => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('panel agent deliveries', () => {
  it('updates, archives and restores agent consoles without stealing focus', async () => {
    await mount()
    const userTab = container.querySelector('[role="tab"]') as HTMLElement

    await emit(delivery('批次一'))
    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('ai_批次一 已出结果')
    expect(userTab.getAttribute('aria-selected')).toBe('true')

    await emit(delivery('批次一'))
    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('ai_批次一 已更新')

    for (const label of ['批次一', '批次二', '批次三', '批次四']) {
      if (label !== '批次一') await emit(delivery(label))
      const tab = [...container.querySelectorAll('[role="tab"]')].find(entry => entry.textContent?.includes(`ai_${label}`))
      click(tab ?? null)
      click([...container.querySelectorAll('[role="tab"]')].find(entry => entry.textContent?.includes('console_1')) ?? null)
    }

    await emit(delivery('批次五'))
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('AI 控制台已达 4 个')

    const history = container.querySelector('[data-sql-agent-history]')
    expect(history?.textContent).toContain('AI 历史 1')
    click(history)
    const archived = document.querySelector('[data-sql-agent-history-menu] [role="menuitem"]')
    const restoredTitle = archived?.textContent
    click(archived)

    expect(restoredTitle).toContain('ai_')
    const restored = [...container.querySelectorAll('[role="tab"]')].find(entry => entry.textContent?.includes(restoredTitle ?? ''))
    expect(restored?.getAttribute('aria-selected')).toBe('true')
    expect(restored?.querySelector('[aria-label="有新结果"]')).toBeNull()
  })

  it('supports switching, sorting, refreshing and filtering an agent script delivery', async () => {
    const fetchPage = vi.fn<WorkbenchApi['fetchPage']>(async () => ({
      ok: true as const,
      columns: [{ name: 'v', typeName: 'INT' }],
      rows: [[9]],
      total: 1,
      hasNextPage: false,
      offset: 0,
      durationMs: 1,
      statementId: 'refetched',
    }))
    const api = { ...apiDouble(), fetchPage }
    await mount(api)

    const base = delivery('脚本')
    await emit({
      ...base,
      kind: 'script',
      single: undefined,
      script: [
        {
          index: 0,
          sql: 'select 1 as v',
          ok: true,
          response: {
            columns: [{ name: 'v', typeName: 'INT' }],
            rows: [[1]],
            total: 1,
            hasNextPage: false,
            offset: 0,
            durationMs: 1,
            statementId: 'a',
          },
        },
        {
          index: 1,
          sql: 'select 2 as v',
          ok: false,
          error: { code: 'FAILED', message: '失败' },
        },
      ],
    })

    click([...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.includes('ai_脚本')) ?? null)
    const resultTabs = [...container.querySelectorAll('[data-sql-script] [role="tab"]:not([data-sql-output-tab])')]
    click(resultTabs[1] ?? null)
    click(resultTabs[0] ?? null)

    click(container.querySelector('th button'))
    await flush()
    click(findLabeled('刷新结果') ?? null)
    await flush()

    click(container.querySelector('[aria-label="筛选 v"]'))
    // The funnel opens on the local value list; this test drives the operator editor.
    click(container.querySelector('[aria-label="筛选模式 条件"]'))
    const input = container.querySelector('[aria-label="筛选值 v"]') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '7')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(container.querySelector('[aria-label="应用筛选"]'))
    await flush()
    click(container.querySelector('[aria-label="清除筛选"]'))
    await flush()

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sort: { column: 'v', direction: 'ASC' } }))
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ column: 'v', op: 'contains', value: '7', numeric: true }],
    }))
    expect(fetchPage.mock.calls.at(-1)?.[0]).not.toHaveProperty('filters')
  })

  it('reports a non-Error failure while following an agent console connection', async () => {
    const api = { ...apiDouble(), setActive: vi.fn(async () => Promise.reject('switch offline')) }
    await mount(api)
    await emit({ ...delivery('跨库'), connId: 'other-connection' })

    click([...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.includes('ai_跨库')) ?? null)
    await flush()

    expect(container.querySelector('[data-sql-notice]')?.textContent).toContain('switch offline')
  })
})
