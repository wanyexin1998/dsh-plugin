/**
 * "Send to chat" bridge (SQL-405).
 *
 * The host conversation plugin owns the composer, but it publishes each
 * Session's composer actions (`captureInsertion` / `insertText` /
 * `persistDraft`) as standard props to Session-scoped slots. One invisible
 * entry in `conversation.input.dock` captures those actions here, keyed by
 * session id, so the rest of the workbench can hand SQL or errors to the chat
 * input without reaching into the conversation plugin.
 *
 * The host only inserts plain text: the `@path` mention grammar is text the
 * composer recognizes on send, so no structured reference chip is available to
 * a plugin. When no composer is mounted, {@link sendToChat} degrades to the
 * clipboard and says so — it never throws and never loses the text silently.
 */

import { useLayoutEffect } from 'react'

import { copyText } from './clipboard.ts'

/** One caret or selection in the host composer's draft. */
export interface ChatInsertionSpan {
  readonly draftRev: number
  readonly start: number
  readonly end: number
}

/** The subset of the host's per-Session composer actions this bridge uses. */
export interface ChatInputActions {
  /** Capture the draft selection and its revision; `null` while not editable. */
  readonly captureInsertion: () => ChatInsertionSpan | null
  /** Insert plain text at the captured span; `true` when it applied. */
  readonly insertText: (text: string, span: ChatInsertionSpan) => boolean
  /** Persist the modified draft (host-owned, best effort). */
  readonly persistDraft?: () => void
  /** Return keyboard focus to the composer (host-owned, best effort). */
  readonly focus?: () => void
}

/** The standard props the host passes to a `conversation.input.dock` entry. */
export interface ChatInputBridgeProps {
  readonly sessionId?: string
  /** Host-typed as `InputActions`; validated at registration. */
  readonly inputActions?: unknown
}

/** Clipboard seam, so tests and non-browser callers can inject a writer. */
export interface ChatClipboard {
  readonly writeText: (text: string) => Promise<void>
}

/** Where the text ended up. */
export type ChatSendMode = 'chat' | 'clipboard'

/** Outcome of {@link sendToChat}. */
export interface ChatSendResult {
  readonly mode: ChatSendMode
  /** `true` when the text was inserted or copied. */
  readonly ok: boolean
  /** Human-readable fallback or failure reason; Chinese, shown by the panel. */
  readonly reason?: string
}

/** Options for {@link sendToChat}. */
export interface SendToChatOptions {
  /** Target composer; defaults to the most recently registered Session. */
  readonly sessionId?: string
  /** Override the clipboard writer (tests, non-browser hosts). */
  readonly clipboard?: ChatClipboard
}

/** Live composer action faces, keyed by Session id. */
const inputs = new Map<string, ChatInputActions>()

/** Most recently registered Session, used when the caller omits one. */
let lastSessionId: string | undefined

/**
 * Narrow an untyped host prop to the composer action face.
 *
 * @param value - host-provided value.
 * @returns the usable face, or `undefined` when the host did not provide one.
 */
function toActions(value: unknown): ChatInputActions | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<ChatInputActions>
  if (typeof candidate.captureInsertion !== 'function') return undefined
  if (typeof candidate.insertText !== 'function') return undefined
  return candidate as ChatInputActions
}

/**
 * Publish one Session's composer actions.
 *
 * @param sessionId - Session whose composer is on screen.
 * @param actions - host-provided action face; invalid values are ignored.
 * @returns a disposer that removes exactly this registration.
 */
export function registerChatInput(sessionId: string | undefined, actions: unknown): () => void {
  if (typeof sessionId !== 'string' || sessionId === '') return () => {}
  const face = toActions(actions)
  if (face === undefined) return () => {}
  inputs.set(sessionId, face)
  lastSessionId = sessionId
  return () => {
    // A newer registration for the same Session must survive this stale disposer.
    if (inputs.get(sessionId) === face) {
      inputs.delete(sessionId)
      if (lastSessionId === sessionId) lastSessionId = undefined
    }
  }
}

/** Whether one Session currently has a live composer. */
export function hasChatInput(sessionId: string): boolean {
  return inputs.has(sessionId)
}

/**
 * Insert plain text at the composer caret, never overwriting a selection.
 *
 * @param sessionId - Session whose composer should receive the text.
 * @param text - plain text (SQL, SQL fence, error text); empty is a no-op.
 * @returns `true` only when the host accepted the edit.
 */
export function insertChatText(sessionId: string, text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  const actions = inputs.get(sessionId)
  if (actions === undefined) return false
  try {
    const span = actions.captureInsertion()
    if (span === null) return false
    if (
      typeof span.draftRev !== 'number' ||
      typeof span.start !== 'number' ||
      typeof span.end !== 'number'
    ) {
      return false
    }
    // Collapse a user selection to its end: a background action must not delete
    // what the user typed.
    const target: ChatInsertionSpan =
      span.start === span.end ? span : { draftRev: span.draftRev, start: span.end, end: span.end }
    const insert = target.start > 0 ? ` ${text}` : text
    if (actions.insertText(insert, target) !== true) return false
    try {
      actions.persistDraft?.()
    } catch {
      // Draft persistence is a host nicety; the insertion already happened.
    }
    try {
      actions.focus?.()
    } catch {
      // Focusing is best effort too.
    }
    return true
  } catch {
    // A composer that throws (unmounted mid-edit) must read as "not inserted".
    return false
  }
}

/**
 * Put text into the chat composer, or copy it when no composer is available.
 *
 * @param text - SQL, SQL fence, or error text to hand to the agent.
 * @param options - target Session and an optional clipboard override.
 * @returns where the text went; never rejects.
 */
export async function sendToChat(text: string, options: SendToChatOptions = {}): Promise<ChatSendResult> {
  if (typeof text !== 'string' || text.trim() === '') {
    return { mode: 'clipboard', ok: false, reason: '没有可发送到聊天框的内容' }
  }

  const sessionId = options.sessionId ?? lastSessionId
  if (sessionId !== undefined && insertChatText(sessionId, text)) {
    return { mode: 'chat', ok: true }
  }

  const clipboard = options.clipboard
  if (clipboard !== undefined) {
    try {
      await clipboard.writeText(text)
      return { mode: 'clipboard', ok: true, reason: '聊天输入框不可用，已复制到剪贴板' }
    } catch {
      return { mode: 'clipboard', ok: false, reason: '聊天输入框不可用，且剪贴板写入失败' }
    }
  }

  try {
    const copied = await copyText(text)
    return copied
      ? { mode: 'clipboard', ok: true, reason: '聊天输入框不可用，已复制到剪贴板' }
      : { mode: 'clipboard', ok: false, reason: '聊天输入框不可用，且剪贴板不可用' }
  } catch {
    // copyText owns its own failures; this only guards an unexpected rejection.
    return { mode: 'clipboard', ok: false, reason: '聊天输入框不可用，且剪贴板不可用' }
  }
}

/**
 * Invisible `conversation.input.dock` entry: publishes the host composer face.
 *
 * The slot passes standard props; unmounting (or a Session switch) disposes the
 * registration so a stale composer is never targeted.
 *
 * @param props - host standard props for a Session-scoped slot.
 * @returns nothing; this entry draws no UI.
 */
export function ChatInputBridge(props: ChatInputBridgeProps): null {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
  useLayoutEffect(() => registerChatInput(sessionId, props.inputActions), [sessionId, props.inputActions])
  return null
}
