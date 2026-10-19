/**
 * Document tabs for the query panel.
 *
 * DataGrip keeps one console per tab, each bound to the connection it was opened
 * on, and the tab carries a colour so you can tell `console_17` (doris) from
 * `console_2` (zanmal_read) at a glance. This module is the state half of that:
 * pure functions over an immutable tab list, so opening, switching, closing and
 * editing are testable without React.
 */

import type { QueryState } from './query.ts'
import { INITIAL_QUERY } from './query.ts'
import type { ScriptTab } from '../components/ScriptResults.tsx'

/** One multi-statement run inside a tab. */
export interface ScriptRun {
  readonly tabs: readonly ScriptTab[]
  readonly active: number
  readonly running: boolean
}

export interface DocumentTab {
  readonly id: string
  /** Shown on the tab: `console_1`, `console_2`, … */
  readonly title: string
  /** Connection the tab was opened on; null until one is selected. */
  readonly connId: string | null
  readonly query: QueryState
  /** Non-null while this tab shows a multi-statement result. */
  readonly script: ScriptRun | null
  /** SQL text used by the last successful run, for the `*` marker. */
  readonly lastRunSql: string
}

/** DataGrip stops at a handful of consoles; so do we. */
export const MAX_TABS = 8

let counter = 0

/** Next free `console_N` title. */
export function nextTitle(tabs: readonly DocumentTab[]): string {
  const used = new Set(tabs.map(tab => tab.title))
  let index = 1
  while (used.has(`console_${index}`)) index += 1
  return `console_${index}`
}

/** Mint a new tab bound to `connId`. */
export function createTab(tabs: readonly DocumentTab[], connId: string | null): DocumentTab {
  counter += 1
  return {
    id: `doc-${counter}`,
    title: nextTitle(tabs),
    connId,
    query: INITIAL_QUERY,
    script: null,
    lastRunSql: '',
  }
}

/** Replace one tab, keeping order. */
export function patchTab(
  tabs: readonly DocumentTab[],
  id: string,
  patch: Partial<DocumentTab> | ((tab: DocumentTab) => Partial<DocumentTab>),
): readonly DocumentTab[] {
  return tabs.map(tab => (tab.id === id ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) } : tab))
}

/** The tab with `id`, or the first one (the list is never empty). */
export function activeTab(tabs: readonly DocumentTab[], id: string): DocumentTab {
  return tabs.find(tab => tab.id === id) ?? (tabs[0] as DocumentTab)
}

/**
 * Close a tab and choose the next active one.
 *
 * @param tabs - Current tabs.
 * @param id - Tab to remove.
 * @returns The remaining tabs and the id that should become active. Closing the
 *   last tab leaves a fresh empty one so the panel never has nothing to show.
 */
export function closeTab(
  tabs: readonly DocumentTab[],
  id: string,
): { readonly tabs: readonly DocumentTab[]; readonly activeId: string } {
  const index = tabs.findIndex(tab => tab.id === id)
  const remaining = tabs.filter(tab => tab.id !== id)
  if (remaining.length === 0) {
    const fresh = createTab([], null)
    return { tabs: [fresh], activeId: fresh.id }
  }
  const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)] as DocumentTab
  return { tabs: remaining, activeId: next.id }
}

/** True when the tab has unsaved-looking edits (DataGrip's `*`). */
export function isDirty(tab: DocumentTab): boolean {
  return tab.query.sql.trim() !== '' && tab.query.sql !== tab.lastRunSql
}

/** Palette slot for a connection, so the tab colour is stable across reloads. */
export function connectionColor(connId: string | null): 0 | 1 | 2 | 3 {
  if (connId === null) return 0
  let hash = 0
  for (const char of connId) hash = (hash * 31 + char.charCodeAt(0)) % 100000
  return (hash % 4) as 0 | 1 | 2 | 3
}
