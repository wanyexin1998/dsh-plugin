// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clipboard = vi.hoisted(() => ({ copyText: vi.fn<(text: string) => Promise<boolean>>() }))

vi.mock('../src/client/clipboard.ts', () => ({ copyText: clipboard.copyText }))

import {
  ChatInputBridge,
  hasChatInput,
  insertChatText,
  registerChatInput,
  sendToChat,
  type ChatInputActions,
  type ChatInsertionSpan,
} from '../src/client/chat-bridge.ts'

/** Host-like action face; every method is a spy so call order is assertable. */
function makeActions(overrides: Partial<ChatInputActions> = {}): {
  readonly actions: ChatInputActions
  readonly insertText: ReturnType<typeof vi.fn>
  readonly persistDraft: ReturnType<typeof vi.fn>
  readonly focus: ReturnType<typeof vi.fn>
} {
  const insertText = vi.fn<(text: string, span: ChatInsertionSpan) => boolean>(() => true)
  const persistDraft = vi.fn<() => void>()
  const focus = vi.fn<() => void>()
  const actions: ChatInputActions = {
    captureInsertion: () => ({ draftRev: 3, start: 0, end: 0 }),
    insertText,
    persistDraft,
    focus,
    ...overrides,
  }
  return { actions, insertText, persistDraft, focus }
}

const caret: ChatInsertionSpan = { draftRev: 7, start: 0, end: 0 }

/** Registrations created by a test, disposed in reverse order afterwards. */
const disposers: Array<() => void> = []

/** Register and remember the disposer. */
function use(sessionId: string | undefined, actions: unknown): void {
  disposers.push(registerChatInput(sessionId, actions))
}

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  clipboard.copyText.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  if (root !== undefined) {
    act(() => {
      root?.unmount()
    })
    root = undefined
  }
  container?.remove()
  container = undefined
  while (disposers.length > 0) disposers.pop()?.()
})

describe('registerChatInput', () => {
  it('ignores an empty or missing session id', () => {
    const { actions } = makeActions()
    use('', actions)
    use(undefined, actions)
    expect(hasChatInput('')).toBe(false)
  })

  it('ignores host props that are not a composer action face', () => {
    use('bridge-invalid', undefined)
    use('bridge-invalid-2', {})
    use('bridge-invalid-3', { captureInsertion: () => caret })
    expect(hasChatInput('bridge-invalid')).toBe(false)
    expect(hasChatInput('bridge-invalid-2')).toBe(false)
    expect(hasChatInput('bridge-invalid-3')).toBe(false)
  })

  it('registers and disposes one Session composer', () => {
    const { actions } = makeActions()
    const dispose = registerChatInput('bridge-ok', actions)
    expect(hasChatInput('bridge-ok')).toBe(true)
    dispose()
    expect(hasChatInput('bridge-ok')).toBe(false)
  })

  it('keeps a newer registration alive when a stale disposer runs', () => {
    const { actions } = makeActions()
    const first = registerChatInput('bridge-restack', actions)
    use('bridge-restack', makeActions().actions)
    first()
    expect(hasChatInput('bridge-restack')).toBe(true)
  })
})

describe('insertChatText', () => {
  it('rejects empty text, non-string text and unknown Sessions', () => {
    use('insert-unknown', makeActions().actions)
    expect(insertChatText('insert-unknown', '')).toBe(false)
    expect(insertChatText('insert-unknown', 42 as unknown as string)).toBe(false)
    expect(insertChatText('insert-absent', 'SELECT 1')).toBe(false)
  })

  it('rejects a composer that cannot capture an insertion', () => {
    use('insert-null', makeActions({ captureInsertion: () => null }).actions)
    expect(insertChatText('insert-null', 'SELECT 1')).toBe(false)
  })

  it('rejects malformed insertion spans', () => {
    const badRev = makeActions({
      captureInsertion: () => ({ draftRev: 'x', start: 0, end: 0 } as unknown as ChatInsertionSpan),
    })
    use('insert-bad-rev', badRev.actions)
    expect(insertChatText('insert-bad-rev', 'SELECT 1')).toBe(false)

    const badStart = makeActions({
      captureInsertion: () => ({ draftRev: 1, end: 0 } as unknown as ChatInsertionSpan),
    })
    use('insert-bad-start', badStart.actions)
    expect(insertChatText('insert-bad-start', 'SELECT 1')).toBe(false)

    const badEnd = makeActions({
      captureInsertion: () => ({ draftRev: 1, start: 0, end: '2' } as unknown as ChatInsertionSpan),
    })
    use('insert-bad-end', badEnd.actions)
    expect(insertChatText('insert-bad-end', 'SELECT 1')).toBe(false)
  })

  it('inserts at the caret without a leading space and persists the draft', () => {
    const face = makeActions()
    use('insert-caret', face.actions)
    expect(insertChatText('insert-caret', 'SELECT 1')).toBe(true)
    expect(face.insertText).toHaveBeenCalledWith('SELECT 1', { draftRev: 3, start: 0, end: 0 })
    expect(face.persistDraft).toHaveBeenCalledTimes(1)
    expect(face.focus).toHaveBeenCalledTimes(1)
  })

  it('collapses a selection to its end and separates the inserted text', () => {
    const face = makeActions({ captureInsertion: () => ({ draftRev: 4, start: 2, end: 9 }) })
    use('insert-selection', face.actions)
    expect(insertChatText('insert-selection', 'SELECT 1')).toBe(true)
    expect(face.insertText).toHaveBeenCalledWith(' SELECT 1', { draftRev: 4, start: 9, end: 9 })
  })

  it('reports a refused insertion and never persists after it', () => {
    const face = makeActions({ insertText: vi.fn(() => false) })
    use('insert-refused', face.actions)
    expect(insertChatText('insert-refused', 'SELECT 1')).toBe(false)
    expect(face.persistDraft).not.toHaveBeenCalled()
  })

  it('turns a throwing composer into a plain false', () => {
    const face = makeActions({
      insertText: vi.fn(() => {
        throw new Error('composer unmounted')
      }),
    })
    use('insert-throws', face.actions)
    expect(insertChatText('insert-throws', 'SELECT 1')).toBe(false)
  })

  it('still succeeds when draft persistence or focusing throws', () => {
    const persisting = makeActions({
      persistDraft: vi.fn(() => {
        throw new Error('storage denied')
      }),
    })
    use('insert-persist-throws', persisting.actions)
    expect(insertChatText('insert-persist-throws', 'SELECT 1')).toBe(true)

    const focusing = makeActions({
      focus: vi.fn(() => {
        throw new Error('focus denied')
      }),
    })
    use('insert-focus-throws', focusing.actions)
    expect(insertChatText('insert-focus-throws', 'SELECT 1')).toBe(true)
  })

  it('works with a minimal host face that omits the optional methods', () => {
    use('insert-minimal', { ...makeActions().actions, persistDraft: undefined, focus: undefined })
    expect(insertChatText('insert-minimal', 'SELECT 1')).toBe(true)
  })
})

describe('sendToChat', () => {
  it('refuses blank or non-text payloads without touching the clipboard', async () => {
    await expect(sendToChat('')).resolves.toEqual({
      mode: 'clipboard',
      ok: false,
      reason: '没有可发送到聊天框的内容',
    })
    await expect(sendToChat('   ')).resolves.toMatchObject({ ok: false })
    await expect(sendToChat(42 as unknown as string)).resolves.toMatchObject({ ok: false })
    expect(clipboard.copyText).not.toHaveBeenCalled()
  })

  it('inserts into the requested Session composer', async () => {
    const face = makeActions()
    use('send-explicit', face.actions)
    await expect(sendToChat('SELECT 1', { sessionId: 'send-explicit' })).resolves.toEqual({ mode: 'chat', ok: true })
    expect(face.insertText).toHaveBeenCalledTimes(1)
    expect(clipboard.copyText).not.toHaveBeenCalled()
  })

  it('falls back to the most recently registered Session', async () => {
    const face = makeActions()
    use('send-last', face.actions)
    await expect(sendToChat('SELECT 1')).resolves.toEqual({ mode: 'chat', ok: true })
  })

  it('copies through the injected clipboard when no composer exists', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
    writeText.mockResolvedValue(undefined)
    await expect(sendToChat('SELECT 1', { clipboard: { writeText } })).resolves.toEqual({
      mode: 'clipboard',
      ok: true,
      reason: '聊天输入框不可用，已复制到剪贴板',
    })
    expect(writeText).toHaveBeenCalledWith('SELECT 1')
  })

  it('reports an injected clipboard rejection without throwing', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
    writeText.mockRejectedValue(new Error('denied'))
    await expect(sendToChat('SELECT 1', { clipboard: { writeText } })).resolves.toEqual({
      mode: 'clipboard',
      ok: false,
      reason: '聊天输入框不可用，且剪贴板写入失败',
    })
  })

  it('degrades to the panel clipboard helper when no composer is present', async () => {
    clipboard.copyText.mockResolvedValue(true)
    await expect(sendToChat('SELECT 1')).resolves.toEqual({
      mode: 'clipboard',
      ok: true,
      reason: '聊天输入框不可用，已复制到剪贴板',
    })

    clipboard.copyText.mockResolvedValue(false)
    await expect(sendToChat('SELECT 1')).resolves.toEqual({
      mode: 'clipboard',
      ok: false,
      reason: '聊天输入框不可用，且剪贴板不可用',
    })
  })

  it('reports an unexpected clipboard rejection as a failed copy', async () => {
    clipboard.copyText.mockRejectedValue(new Error('clipboard exploded'))
    await expect(sendToChat('SELECT 1')).resolves.toEqual({
      mode: 'clipboard',
      ok: false,
      reason: '聊天输入框不可用，且剪贴板不可用',
    })
  })
})

describe('ChatInputBridge', () => {
  it('publishes the composer face while mounted and removes it on unmount', () => {
    const { actions } = makeActions()
    act(() => {
      root?.render(React.createElement(ChatInputBridge, { sessionId: 'bridge-mount', inputActions: actions }))
    })
    expect(hasChatInput('bridge-mount')).toBe(true)

    act(() => {
      root?.unmount()
    })
    root = undefined
    expect(hasChatInput('bridge-mount')).toBe(false)
  })

  it('moves the registration when the Session changes and skips unknown props', () => {
    const first = makeActions().actions
    act(() => {
      root?.render(React.createElement(ChatInputBridge, { sessionId: 'bridge-a', inputActions: first }))
    })
    act(() => {
      root?.render(React.createElement(ChatInputBridge, { sessionId: 'bridge-b', inputActions: first }))
    })
    expect(hasChatInput('bridge-a')).toBe(false)
    expect(hasChatInput('bridge-b')).toBe(true)

    act(() => {
      root?.render(React.createElement(ChatInputBridge, { sessionId: undefined, inputActions: undefined }))
    })
    expect(hasChatInput('bridge-b')).toBe(false)
  })
})
