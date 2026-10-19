/**
 * Layout state for the workbench: which sessions sit in which panels, in reading order.
 *
 * Pure data + pure operations. No React, no DOM, no host services — that is what makes
 * it testable (`tests/layout.test.mjs`) and what keeps the invariant "one session, one
 * panel" enforceable in a single place.
 *
 * Invariants
 *  - a `sessionId` appears at most once (F12/F02: one session, one editable presentation);
 *  - the first panel always exists and is the one the workbench shows when it takes the
 *    main content host (it is the session the user was already looking at);
 *  - panel order is the reading order used for focus cycling and persistence.
 */

/** One panel: a geometry identity plus the session it presents. */
export interface PanelRecord {
  /** Stable geometry id (never derived from focus or position). */
  readonly id: string
  readonly sessionId: string
}

export interface LayoutState {
  readonly panels: readonly PanelRecord[]
  readonly focusedId: string | null
  /** Monotonic counter for minting panel ids; not persisted. */
  readonly nonce: number
}

export function emptyLayout(): LayoutState {
  return { panels: [], focusedId: null, nonce: 0 }
}

/** Reading order, with the focused panel defaulting to the first one. */
export function focusOf(state: LayoutState): string | null {
  if (state.panels.length === 0) return null
  if (state.focusedId !== null && state.panels.some((panel) => panel.id === state.focusedId)) return state.focusedId
  return state.panels[0].id
}



function mintId(state: LayoutState, sessionId: string): { id: string; nonce: number } {
  const nonce = state.nonce + 1
  return { id: 'panel-' + sessionId + '-' + nonce, nonce }
}

/** Internal helper: the panel currently presenting a session, if any. */
function panelOfSession(state: LayoutState, sessionId: string): PanelRecord | null {
  return state.panels.find((panel) => panel.sessionId === sessionId) ?? null
}

/**
 * Add `sessionId` in a new panel, or focus the panel that already shows it.
 *
 * `at` places the panel after the reference panel (reading order); without it the panel
 * is appended. The caller decides the geometric direction — Dockview owns geometry.
 */
export function place(
  state: LayoutState,
  sessionId: string,
  options: { at?: number } = {},
): { state: LayoutState; id: string; created: boolean } {
  const existing = panelOfSession(state, sessionId)
  if (existing !== null) return { state: { ...state, focusedId: existing.id }, id: existing.id, created: false }

  const minted = mintId(state, sessionId)
  const record: PanelRecord = { id: minted.id, sessionId }
  const index = options.at === undefined ? state.panels.length : Math.max(0, Math.min(options.at, state.panels.length))
  const panels = [...state.panels.slice(0, index), record, ...state.panels.slice(index)]
  return { state: { panels, focusedId: record.id, nonce: minted.nonce }, id: record.id, created: true }
}

/** Remove a panel. Returns the surviving state and the panel that should take focus. */
export function close(state: LayoutState, id: string): { state: LayoutState; focus: string | null } {
  const index = state.panels.findIndex((panel) => panel.id === id)
  if (index === -1) return { state, focus: focusOf(state) }
  const panels = state.panels.filter((panel) => panel.id !== id)
  const next = panels.length === 0 ? null : panels[Math.min(index, panels.length - 1)].id
  return { state: { ...state, panels, focusedId: next }, focus: next }
}

export function focus(state: LayoutState, id: string): LayoutState {
  if (!state.panels.some((panel) => panel.id === id)) return state
  return { ...state, focusedId: id }
}

/** Cycle focus in reading order (`step` = +1 / -1), wrapping. */
export function cycle(state: LayoutState, step: number): LayoutState {
  const count = state.panels.length
  if (count === 0) return state
  const current = focusOf(state)
  const index = current === null ? -1 : state.panels.findIndex((panel) => panel.id === current)
  const next = (((index + step) % count) + count) % count
  return { ...state, focusedId: state.panels[next].id }
}

/** Move a panel to another reading position (the DOM host moves, not the conversation). */
export function move(state: LayoutState, id: string, toIndex: number): LayoutState {
  const from = state.panels.findIndex((panel) => panel.id === id)
  if (from === -1) return state
  const clamped = Math.max(0, Math.min(toIndex, state.panels.length - 1))
  if (from === clamped) return state
  const panels = [...state.panels]
  const [moved] = panels.splice(from, 1)
  panels.splice(clamped, 0, moved)
  return { ...state, panels }
}

/** Bring a session's panel to front-of-focus without creating one (sidebar click semantics). */
export function reveal(state: LayoutState, sessionId: string): LayoutState {
  const existing = panelOfSession(state, sessionId)
  return existing === null ? state : focus(state, existing.id)
}

/* ------------------------------------------------------------- persistence -- */

export interface StoredLayout {
  readonly schemaVersion: 1
  readonly panels: readonly PanelRecord[]
  readonly focusedId: string | null
}

/**
 * Serialise for storage. `nonce` is deliberately dropped: panel ids are stable across
 * reloads, the counter only mints new ones.
 */
export function serialize(state: LayoutState): StoredLayout {
  return { schemaVersion: 1, panels: state.panels.map((panel) => ({ id: panel.id, sessionId: panel.sessionId })), focusedId: focusOf(state) }
}

/** Parse stored data defensively: anything malformed or duplicated is dropped. */
export function deserialize(raw: unknown): LayoutState {
  if (raw === null || typeof raw !== 'object') return emptyLayout()
  const candidate = raw as { schemaVersion?: unknown; panels?: unknown; focusedId?: unknown; nonce?: unknown }
  // Only the current schema is accepted; a future version is refused wholesale.
  if (candidate.schemaVersion !== 1) return emptyLayout()
  if (!Array.isArray(candidate.panels)) return emptyLayout()
  const seenSessions = new Set<string>()
  const seenIds = new Set<string>()
  const panels: PanelRecord[] = []
  for (const entry of candidate.panels) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; sessionId?: unknown }
    if (typeof record.id !== 'string' || record.id === '' || typeof record.sessionId !== 'string' || record.sessionId === '') continue
    if (seenIds.has(record.id) || seenSessions.has(record.sessionId)) continue
    seenIds.add(record.id)
    seenSessions.add(record.sessionId)
    panels.push({ id: record.id, sessionId: record.sessionId })
  }
  const focusedId = typeof candidate.focusedId === 'string' && seenIds.has(candidate.focusedId) ? candidate.focusedId : null
  const nonce = typeof candidate.nonce === 'number' && Number.isFinite(candidate.nonce) ? candidate.nonce : panels.length
  return { panels, focusedId, nonce: Math.max(nonce, panels.length) }
}
