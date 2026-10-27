// @vitest-environment jsdom
import * as React from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkbenchPanel } from '../src/client/components/SqlWorkbenchPanel.tsx'
import { registerChatInput } from '../src/client/chat-bridge.ts'
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

function apiDouble(overrides: Partial<WorkbenchApi> = {}): WorkbenchApi {
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
    ...overrides,
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

const pressOnWindow = (init: KeyboardEventInit): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))
  })
}

const item = (id: string): HTMLElement | null => container.querySelector(`[data-command-id="${id}"]`)

const runCommand = async (id: string): Promise<void> => {
  pressOnWindow({ key: 'p', ctrlKey: true, shiftKey: true })
  const row = item(id)
  expect(row).not.toBeNull()
  act(() => {
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function fakeComposer() {
  const calls: { text: string; persisted: boolean }[] = []
  return {
    calls,
    actions: {
      captureInsertion: () => ({ start: 5, end: 5, draftRev: 3 }),
      insertText: (text: string) => {
        calls.push({ text, persisted: false })
        return true
      },
      persistDraft: () => {
        calls.push({ text: '', persisted: true })
      },
    },
  }
}

describe('panel: send to chat (SQL-405)', () => {
  it('inserts the statement into the live composer', async () => {
    const composer = fakeComposer()
    const dispose = registerChatInput('s1', composer.actions)
    try {
      await mount(apiDouble())
      act(() => {
        setSql(container, 'SELECT 1')
      })
      await runCommand('chat-send-sql')
      expect(composer.calls[0]?.text).toContain('SELECT 1')
      expect(composer.calls.some(call => call.persisted)).toBe(true)
      expect(container.textContent).toContain('已插入聊天输入框')
    } finally {
      dispose()
    }
  })

  it('falls back to the clipboard when no composer is mounted', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mount(apiDouble())
    act(() => {
      setSql(container, 'SELECT 42')
    })
    await runCommand('chat-send-sql')
    expect(writeText).toHaveBeenCalledWith('SELECT 42')
    expect(container.textContent).toContain('已复制到剪贴板')
  })

  it('sends the error details once a statement failed', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const api = apiDouble({
      execute: vi.fn(async () => ({ ok: false as const, error: { code: 'SQL_SYNTAX', message: '语法错误' } })),
    })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT bad')
    })
    act(() => {
      container.querySelector('[aria-label="执行"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    await runCommand('chat-send-error')
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls.at(-1)?.[0]).toContain('语法错误')
    expect(calls.at(-1)?.[0]).toContain('SELECT bad')

    // The error card exposes the same action without opening the palette.
    writeText.mockClear()
    act(() => {
      container.querySelector('[aria-label="发到聊天框"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalled()
  })

  it('explains that there is no error to send', async () => {
    await mount(apiDouble())
    await runCommand('chat-send-error')
    expect(container.textContent).toContain('当前没有错误可发送')
  })

  it('sends a failed script tab through the error card (SQL-405)', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const api = apiDouble({
      executeScript: vi.fn(async () => ({
        statements: [{ index: 0, sql: 'SELECT bad', ok: false as const, error: { code: 'SQL_SYNTAX', message: 'bad' } }],
        durationMs: 1,
      })),
    })
    await mount(api)
    act(() => {
      setSql(container, 'SELECT bad; SELECT 2')
    })
    act(() => {
      findLabeled('执行全部')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      container.querySelector('[aria-label="发到聊天框"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    const calls = writeText.mock.calls as unknown as unknown[][]
    expect(calls.at(-1)?.[0]).toContain('SQL 执行报错')
    expect(calls.at(-1)?.[0]).toContain('SELECT bad')
  })
})

describe('panel: agent diff proposal (SQL-406)', () => {
  it('reads a proposal from the clipboard and accepts it into the editor', async () => {
    const readText = vi.fn(async () => 'SELECT 2')
    Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
    await mount(apiDouble())
    act(() => {
      setSql(container, 'SELECT 1')
    })
    await runCommand('chat-diff-clipboard')
    expect(container.querySelector('[data-diff-proposal]')).not.toBeNull()

    act(() => {
      container.querySelector('[data-diff-accept]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(readSql(container)).toBe('SELECT 2')
    expect(container.textContent).toContain('已接受 Agent 提案')
  })

  it('rejects the proposal without touching the editor', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => 'SELECT 3') }, configurable: true })
    await mount(apiDouble())
    act(() => {
      setSql(container, 'SELECT 1')
    })
    await runCommand('chat-diff-clipboard')
    act(() => {
      container.querySelector('[data-diff-reject]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(readSql(container)).toBe('SELECT 1')
    expect(container.querySelector('[data-diff-proposal]')).toBeNull()
  })

  it('reports when the clipboard cannot be read', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => { throw new Error('no') }) }, configurable: true })
    await mount(apiDouble())
    await runCommand('chat-diff-clipboard')
    expect(container.textContent).toContain('读取剪贴板失败')
  })

  it('explains when the clipboard API is missing entirely', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    await mount(apiDouble())
    await runCommand('chat-diff-clipboard')
    expect(container.textContent).toContain('无法读取剪贴板')
  })
})
