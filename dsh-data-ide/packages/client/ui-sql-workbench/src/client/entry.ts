/**
 * Keyboard entry for the workbench (docs/09 B2).
 *
 * The page type is registered with `multiple: false`, so `openTab` both opens a
 * closed tab and focuses an open one — the shortcut only has to name the kind.
 * It also expands a collapsed right sidebar, which is the case the tab list
 * cannot cover.
 *
 * The predicate is a pure function so the binding is testable without a DOM.
 */

/** Shortcut: Ctrl/Cmd + Shift + L ("workbench"). */
export const OPEN_SHORTCUT = { key: 'l', shift: true } as const

export interface KeyLike {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * True when this event is the "open workbench" shortcut.
 *
 * `Ctrl` (Windows/Linux) and `Cmd` (macOS) are both accepted. `Alt` must be up so
 * we do not shadow any OS-level combination that also uses the letter.
 */
export function isOpenWorkbenchShortcut(event: KeyLike): boolean {
  if (event.altKey) return false
  if (!event.shiftKey) return false
  if (!event.ctrlKey && !event.metaKey) return false
  return event.key.toLowerCase() === OPEN_SHORTCUT.key
}

/**
 * Whether one keydown target is a text-editing surface.
 *
 * The workbench shortcut must yield to anything the user is typing in: the
 * CodeMirror editor binds `Ctrl+Shift+L` to "select all occurrences", and
 * opening the tab on the same chord fired both actions at once (reported
 * 2026-10-26). Inputs and contenteditable regions get the same deference.
 */
export function isEditingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const node = target as { closest?: unknown; tagName?: unknown; isContentEditable?: unknown }
  if (typeof node.closest === 'function') {
    try {
      if ((node.closest as (selector: string) => unknown)('.cm-editor') !== null) return true
    } catch {
      // A non-Element target (window, document) has no closest; treat as global.
    }
  }
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return node.isContentEditable === true
}

/**
 * Wire the shortcut to `open`.
 *
 * Returns a disposer, and is a no-op outside a DOM: the client half is also
 * loaded by non-jsdom harnesses, where touching `window` would throw during
 * registration and take the whole entry down.
 */
export function bindOpenShortcut(open: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isOpenWorkbenchShortcut(event)) return
    if (isEditingTarget(event.target)) return
    event.preventDefault()
    open()
  }
  window.addEventListener('keydown', onKeyDown)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
  }
}
