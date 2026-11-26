/**
 * BOOP fixed entry, board icon and main-Session identity header (E04-01 batch 2).
 *
 * Slots used (all additive; verified against the rc.2.1 Slot catalog):
 *  - `sidebar.panellist` (root, list) — the BOOP entry above the workspaces;
 *  - `conversation.session.header.actions` (session, list) — identity chip on
 *    the BOOP main Session ONLY; an ordinary Session renders nothing
 *    (FE-01 zero pollution). Tasks, memory and settings live in the native
 *    right Sidebar.
 */
import React from 'react'
import { BoopMark } from './brand.tsx'
import { BoopApprovalBadge } from './control.tsx'
import type { ControlCall } from './control-model.ts'
import { mainSessionReasonText, mainSessionStatusLine, type MainSessionStore } from './main-session.ts'

export interface OpenOutcomeLike {
  ok: boolean
  message?: string
}

export interface BoopEntryButtonProps {
  /** Owner prop of `sidebar.footer.action`: false while the sidebar is a rail. */
  wide?: boolean
  observer?: MainSessionStore
  onOpen?: () => Promise<OpenOutcomeLike | void> | OpenOutcomeLike | void
}

export function useMainSessionState(observer: MainSessionStore | undefined): ReturnType<MainSessionStore['getSnapshot']> | null {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => (observer ? observer.subscribe(listener) : () => undefined),
      [observer],
    ),
    React.useCallback(() => observer?.getSnapshot() ?? null, [observer]),
    React.useCallback(() => null, []),
  )
}

export function BoopEntryButton({ wide, observer, onOpen }: BoopEntryButtonProps): React.ReactElement {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const state = useMainSessionState(observer)
  const status = state === null ? null : mainSessionStatusLine(state)
  const reason = state?.host?.reason ?? state?.error ?? null
  const reasonText = mainSessionReasonText(reason)

  const activate = (): void => {
    if (pending) return
    setPending(true)
    setError(null)
    void Promise.resolve()
      .then(() => onOpen?.())
      .then((outcome) => {
        setPending(false)
        if (outcome && typeof outcome === 'object' && outcome.ok === false) {
          setError(outcome.message ?? '打开主会话失败')
        }
      })
      .catch((cause: unknown) => {
        setPending(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <button
      type="button"
      data-boop-entry=""
      data-wide={wide === false ? 'false' : 'true'}
      data-pending={pending ? 'true' : 'false'}
      aria-label="打开 BOOP 主聊天"
      aria-busy={pending}
      title={error ?? reasonText ?? '打开 BOOP 主聊天（原生 Conversation）'}
      onClick={activate}
    >
      <BoopMark size={wide === false ? 18 : 16} />
      {wide === false ? null : (
        <>
          <span className="boop-entry-label">BOOP · 波波</span>
          {status ? (
            <span className="boop-entry-state" data-tone={status.tone}>
              {pending ? '正在打开' : status.text}
            </span>
          ) : null}
        </>
      )}
      {error !== null ? <span className="boop-entry-state" data-tone="bad">打开失败</span> : null}
    </button>
  )
}

export interface BoopPanelIconProps {
  /** Owner props of `sidebar.panellist`: square edge and the active state. */
  size?: number
  active?: boolean
}

export function BoopPanelIcon({ size = 16, active }: BoopPanelIconProps): React.ReactElement {
  return (
    <span data-boop-mark="" data-active={active === true ? 'true' : undefined}>
      <BoopMark size={size} />
    </span>
  )
}

export interface BoopMainHeaderProps {
  /** Standard session-scoped slot prop. */
  sessionId?: string
  observer?: MainSessionStore
  /** E04-03: the same authenticated call closure every BOOP surface uses. */
  call?: ControlCall
  onOpenBoard?: () => void
}

type Stampable = {
  closest?: (selector: string) => Stampable | null
  parentElement?: Stampable | null
  previousElementSibling?: Stampable | null
  querySelector?: (selector: string) => Stampable | null
  querySelectorAll?: (selector: string) => ArrayLike<Stampable>
  getAttribute?: (name: string) => string | null
  hasAttribute?: (name: string) => boolean
  setAttribute?: (name: string, value: string) => void
  removeAttribute?: (name: string) => void
  textContent?: string | null
}

function canStamp(node: Stampable | null | undefined): node is Stampable & {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
} {
  return node != null && typeof node.setAttribute === 'function' && typeof node.removeAttribute === 'function'
}

function sessionMatches(node: Stampable, sessionId: string | undefined): boolean {
  if (!sessionId || typeof node.getAttribute !== 'function') return true
  const marked = node.getAttribute('data-conversation-session')
  return marked == null || marked === sessionId
}

/**
 * Locate the native conversation body from the header chip.
 *
 * `conversation.session.header.actions` is a sibling of
 * `[data-conversation-content]`, not a descendant — `closest()` only hits when
 * tests nest the chip inside the body.
 */
export function findConversationContent(from: Stampable | null | undefined, sessionId?: string): (Stampable & {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}) | null {
  if (from == null) return null
  const nested = typeof from.closest === 'function' ? from.closest('[data-conversation-content]') : null
  if (canStamp(nested) && sessionMatches(nested, sessionId)) return nested
  let cursor: Stampable | null | undefined = from.parentElement
  while (cursor) {
    if (typeof cursor.querySelectorAll === 'function') {
      const nodes = cursor.querySelectorAll('[data-conversation-content]')
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        if (canStamp(node) && sessionMatches(node, sessionId)) return node
      }
    }
    cursor = cursor.parentElement
  }
  return null
}

function conversationPhaseRoot(from: Stampable | null | undefined): Stampable | null {
  let cursor: Stampable | null | undefined = from
  while (cursor) {
    const phase = typeof cursor.getAttribute === 'function' ? cursor.getAttribute('data-phase') : null
    if (phase === 'active' || phase === 'hero' || phase === 'settling') return cursor
    cursor = cursor.parentElement
  }
  return null
}

const HIDE_PRESET_ATTR = 'data-boop-hide-preset'
const SESSION_ATTR = 'data-boop-session'
export const BOOP_COMPOSER_MULTILINE_ATTR = 'data-boop-multiline'
export const BOOP_COMPOSER_MULTILINE_PX = 56

export function markComposerMultiline(card: Stampable, editorPx: number): boolean {
  const on = editorPx > BOOP_COMPOSER_MULTILINE_PX
  if (!canStamp(card)) return false
  if (on) card.setAttribute(BOOP_COMPOSER_MULTILINE_ATTR, '')
  else card.removeAttribute(BOOP_COMPOSER_MULTILINE_ATTR)
  return on
}

function composerEditorPx(card: Stampable): number {
  const input = typeof card.querySelector === 'function' ? card.querySelector('[data-composer-input]') : null
  const typed = input as { scrollHeight?: number } | null
  if (typed && typeof typed.scrollHeight === 'number' && typed.scrollHeight > 0) return typed.scrollHeight
  const scroll = typeof card.querySelector === 'function' ? card.querySelector('[data-input-scroll]') : null
  const box = scroll as { getBoundingClientRect?: () => { height: number } } | null
  if (box && typeof box.getBoundingClientRect === 'function') return box.getBoundingClientRect().height
  return 0
}

function isBoopHeaderNode(node: Stampable | null | undefined): boolean {
  if (node == null) return false
  if (typeof node.hasAttribute === 'function' && node.hasAttribute('data-boop-header')) return true
  if (typeof node.getAttribute === 'function' && node.getAttribute('data-boop-header') != null) return true
  return typeof node.querySelector === 'function' && node.querySelector('[data-boop-header]') != null
}

function looksLikeNativePresetChip(node: Stampable): boolean {
  if (isBoopHeaderNode(node)) return false
  const slot = typeof node.getAttribute === 'function' ? node.getAttribute('data-slot') : null
  if (slot === 'conversation.session.header.actions') return true
  const text = typeof node.textContent === 'string' ? node.textContent : ''
  return /标准模式|PTC模式|极简模式|创造模式/.test(text) && !/BOOP/.test(text)
}

/** Hide the native read-only AgentPresetLabel next to the BOOP header chip. */
function hidePeerHeaderActions(chip: Stampable): Array<Stampable & { removeAttribute: (name: string) => void }> {
  const marked: Array<Stampable & { removeAttribute: (name: string) => void }> = []
  const mark = (node: Stampable | null | undefined): void => {
    if (!canStamp(node) || !looksLikeNativePresetChip(node)) return
    node.setAttribute(HIDE_PRESET_ATTR, '')
    marked.push(node)
  }
  let cursor: Stampable | null | undefined = chip.previousElementSibling
  while (cursor) {
    mark(cursor)
    cursor = cursor.previousElementSibling
  }
  const parent = chip.parentElement
  const slot = typeof parent?.getAttribute === 'function' ? parent.getAttribute('data-slot') : null
  if (slot === 'conversation.session.header.actions') {
    let sibling: Stampable | null | undefined = parent?.previousElementSibling
    while (sibling) {
      mark(sibling)
      sibling = sibling.previousElementSibling
    }
  }
  return marked
}

function mutationObserverCtor(from: Stampable): (new (callback: () => void) => {
  observe: (target: Stampable, init: { childList: boolean; subtree?: boolean }) => void
  disconnect: () => void
}) | undefined {
  const doc = (from as { ownerDocument?: { defaultView?: { MutationObserver?: unknown } } }).ownerDocument
  const ctor = doc?.defaultView?.MutationObserver
  return typeof ctor === 'function' ? (ctor as new (callback: () => void) => {
    observe: (target: Stampable, init: { childList: boolean; subtree?: boolean }) => void
    disconnect: () => void
  }) : undefined
}

function resizeObserverCtor(from: Stampable): (new (callback: (entries: Array<{ target: Stampable }>) => void) => {
  observe: (target: Stampable) => void
  disconnect: () => void
}) | undefined {
  const doc = (from as { ownerDocument?: { defaultView?: { ResizeObserver?: unknown } } }).ownerDocument
  const ctor = doc?.defaultView?.ResizeObserver
  return typeof ctor === 'function' ? (ctor as new (callback: (entries: Array<{ target: Stampable }>) => void) => {
    observe: (target: Stampable) => void
    disconnect: () => void
  }) : undefined
}

function escapeAttrValue(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (id: string) => string } }).CSS
  if (css && typeof css.escape === 'function') return css.escape(value)
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Mark the native conversation body for the BOOP main Session even when the
 * header chip is hidden (blank / hero chrome). Ordinary Sessions never match.
 */
export function watchMainSessionChatSkin(observer: MainSessionStore): () => void {
  let stamped: (Stampable & { removeAttribute: (name: string) => void }) | null = null
  let stampedSession: (Stampable & { removeAttribute: (name: string) => void }) | null = null
  let markedCards: Array<Stampable & { removeAttribute: (name: string) => void }> = []
  let resize: { observe: (target: Stampable) => void; disconnect: () => void } | undefined
  const clearCards = (): void => {
    for (const card of markedCards) card.removeAttribute(BOOP_COMPOSER_MULTILINE_ATTR)
    markedCards = []
    resize?.disconnect()
    resize = undefined
  }
  const syncCard = (card: Stampable, bucket: Array<Stampable & { removeAttribute: (name: string) => void }>): void => {
    markComposerMultiline(card, composerEditorPx(card))
    if (canStamp(card) && !bucket.includes(card)) bucket.push(card)
  }
  const bindCards = (): void => {
    resize?.disconnect()
    resize = undefined
    if (!stamped || typeof stamped.querySelectorAll !== 'function') {
      clearCards()
      return
    }
    const next: Array<Stampable & { removeAttribute: (name: string) => void }> = []
    const cards = stamped.querySelectorAll('[data-composer-card]')
    const Resize = resizeObserverCtor(stamped)
    if (Resize !== undefined) {
      resize = new Resize((entries) => {
        for (const entry of entries) {
          let cursor: Stampable | null | undefined = entry.target
          while (cursor) {
            if (typeof cursor.getAttribute === 'function' && cursor.getAttribute('data-composer-card') != null) {
              syncCard(cursor, markedCards)
              break
            }
            cursor = cursor.parentElement
          }
        }
      })
    }
    for (let i = 0; i < cards.length; i += 1) {
      const card = cards[i]
      syncCard(card, next)
      const editor = typeof card.querySelector === 'function'
        ? (card.querySelector('[data-composer-input]') ?? card.querySelector('[data-input-scroll]') ?? card)
        : card
      resize?.observe(editor)
    }
    for (const card of markedCards) {
      if (!next.includes(card)) card.removeAttribute(BOOP_COMPOSER_MULTILINE_ATTR)
    }
    markedCards = next
  }
  const clear = (): void => {
    clearCards()
    stamped?.removeAttribute('data-boop-chat')
    stamped = null
    stampedSession?.removeAttribute(SESSION_ATTR)
    stampedSession = null
  }
  const apply = (): void => {
    const id = observer.getSnapshot()?.mainSessionId ?? null
    const doc = typeof document === 'undefined' ? null : document
    if (!id || doc == null || typeof doc.querySelector !== 'function') {
      clear()
      return
    }
    const node = doc.querySelector(`[data-conversation-content][data-conversation-session="${escapeAttrValue(id)}"]`)
    if (!canStamp(node)) {
      clear()
      return
    }
    if (stamped && stamped !== node) stamped.removeAttribute('data-boop-chat')
    node.setAttribute('data-boop-chat', '')
    stamped = node
    const phase = conversationPhaseRoot(node)
    if (canStamp(phase)) {
      if (stampedSession && stampedSession !== phase) stampedSession.removeAttribute(SESSION_ATTR)
      phase.setAttribute(SESSION_ATTR, '')
      stampedSession = phase
    } else if (stampedSession) {
      stampedSession.removeAttribute(SESSION_ATTR)
      stampedSession = null
    }
    bindCards()
  }
  const unsubscribe = observer.subscribe(apply)
  apply()
  const root = typeof document === 'undefined' ? null : document.documentElement
  const Observer = root != null ? mutationObserverCtor(root) : undefined
  let mutation: { disconnect: () => void } | undefined
  if (root != null && Observer !== undefined) {
    mutation = new Observer(apply)
    mutation.observe(root, { childList: true, subtree: true })
  }
  return () => {
    unsubscribe()
    mutation?.disconnect()
    clear()
  }
}

const HIDE_NAV_ATTR = 'data-boop-hide-nav'

function sessionIdFromRowKey(value: string | null): string | null {
  if (!value || !value.startsWith('session:')) return null
  const id = value.slice('session:'.length)
  return id === '' ? null : id
}

/**
 * Hide the BOOP main Session (and an otherwise-empty ungrouped group) from the
 * left workspace list. The panellist row above workspaces stays the only entry.
 */
export function watchMainSessionSidebarHide(observer: MainSessionStore): () => void {
  const marked = new Set<Stampable & { removeAttribute: (name: string) => void }>()
  const apply = (): void => {
    const snap = observer.getSnapshot()
    const ids = new Set<string>()
    if (typeof snap?.mainSessionId === 'string' && snap.mainSessionId !== '') ids.add(snap.mainSessionId)
    if (typeof snap?.activeSessionId === 'string' && snap.activeSessionId !== '') ids.add(snap.activeSessionId)
    const doc = typeof document === 'undefined' ? null : document
    for (const node of marked) node.removeAttribute(HIDE_NAV_ATTR)
    marked.clear()
    if (!doc || ids.size === 0 || typeof doc.querySelector !== 'function') return
    const mark = (node: Stampable | null | undefined): void => {
      if (!canStamp(node)) return
      node.setAttribute(HIDE_NAV_ATTR, '')
      marked.add(node)
    }
    for (const id of ids) {
      mark(doc.querySelector(`[data-row-key="session:${escapeAttrValue(id)}"]`) as Stampable | null)
    }
    const ungrouped = doc.querySelector('[data-row-key="workspace:"]') as Stampable | null
    if (ungrouped) {
      const section = ungrouped.parentElement
      const rows = typeof section?.querySelectorAll === 'function' ? section.querySelectorAll('[data-row-key^="session:"]') : []
      const list = Array.from({ length: rows.length }, (_, index) => rows[index])
      if (list.length > 0 && list.every((row) => {
        const id = sessionIdFromRowKey(typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') : null)
        return id !== null && ids.has(id)
      })) {
        mark(ungrouped)
        mark(section)
      }
    }
  }
  const unsubscribe = observer.subscribe(apply)
  apply()
  const root = typeof document === 'undefined' ? null : document.documentElement
  const Observer = root != null ? mutationObserverCtor(root) : undefined
  let mutation: { disconnect: () => void } | undefined
  if (root != null && Observer !== undefined) {
    mutation = new Observer(apply)
    mutation.observe(root, { childList: true, subtree: true })
  }
  return () => {
    unsubscribe()
    mutation?.disconnect()
    for (const node of marked) node.removeAttribute(HIDE_NAV_ATTR)
    marked.clear()
  }
}

export function BoopMainHeader({ sessionId, observer, call, onOpenBoard }: BoopMainHeaderProps): React.ReactElement | null {
  const state = useMainSessionState(observer)
  const mainSessionId = state?.mainSessionId ?? null
  const isMain = state !== null && mainSessionId !== null && sessionId !== undefined && sessionId === mainSessionId
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    if (!isMain) return
    const from = rootRef.current
    if (from == null) return
    let stamped: (Stampable & { removeAttribute: (name: string) => void }) | null = null
    let stampedSession: (Stampable & { removeAttribute: (name: string) => void }) | null = null
    let hiddenPreset: Array<Stampable & { removeAttribute: (name: string) => void }> = []
    const apply = (): void => {
      const node = findConversationContent(from, sessionId)
      if (canStamp(node)) {
        if (stamped && stamped !== node) stamped.removeAttribute('data-boop-chat')
        node.setAttribute('data-boop-chat', '')
        stamped = node
      }
      const phase = conversationPhaseRoot(from)
      if (canStamp(phase)) {
        if (stampedSession && stampedSession !== phase) stampedSession.removeAttribute(SESSION_ATTR)
        phase.setAttribute(SESSION_ATTR, '')
        stampedSession = phase
      }
      for (const el of hiddenPreset) el.removeAttribute(HIDE_PRESET_ATTR)
      hiddenPreset = hidePeerHeaderActions(from)
    }
    apply()
    const host = conversationPhaseRoot(from)
    const Observer = mutationObserverCtor(from)
    let observer: { disconnect: () => void } | undefined
    if (host != null && Observer !== undefined) {
      observer = new Observer(apply)
      observer.observe(host, { childList: true, subtree: true })
    }
    return () => {
      observer?.disconnect()
      stamped?.removeAttribute('data-boop-chat')
      stampedSession?.removeAttribute(SESSION_ATTR)
      for (const el of hiddenPreset) el.removeAttribute(HIDE_PRESET_ATTR)
    }
  }, [isMain, sessionId])
  if (!isMain || state === null) return null
  const status = mainSessionStatusLine(state)
  const reasonText = mainSessionReasonText(state.host?.reason ?? state.error ?? null)
  return (
    <div ref={rootRef} data-boop-header="" role="group" aria-label="BOOP 主聊天">
      <BoopMark size={18} />
      <span className="boop-header-name">BOOP · 波波</span>
      <span className="boop-header-mode">BOOP 模式</span>
      <span className="boop-header-status" data-tone={status.tone} title={reasonText ?? undefined}>
        {status.text}
      </span>
      {/* Additive pending-approval badge: only a real valid-pending count renders. */}
      {call ? <BoopApprovalBadge call={call} onOpenBoard={onOpenBoard} /> : null}
    </div>
  )
}
