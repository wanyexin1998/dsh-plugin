/**
 * Document tabs for the query panel.
 *
 * DataGrip keeps one console per tab, each bound to the connection it was opened
 * on, and the tab carries a colour so you can tell `console_17` (doris) from
 * `console_2` (zanmal_read) at a glance. This module is the state half of that:
 * pure functions over an immutable tab list, so opening, switching, closing and
 * editing are testable without React.
 */

import type { ExecuteResponse } from '../../execute/core.ts'
import { type AgentDelivery, sameBatch } from '../../execute/agent-delivery.ts'
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
  /** `'agent'` marks a console the AI opened; absent means a user console. */
  readonly owner?: 'user' | 'agent'
  /** Batch name of an agent console; the title is `ai_<label>`. */
  readonly label?: string
  /** Unread dot: a delivery nobody has looked at yet. */
  readonly unread?: boolean
  /** Last delivery/edit; drives LRU eviction of agent consoles. */
  readonly lastActivityAt?: number
}

/** DataGrip stops at a handful of consoles; so do we. */
export const MAX_TABS = 8

/**
 * Agent consoles get their own budget (docs/10 §12 R4): sharing `MAX_TABS`
 * would let the AI evict the user's own consoles.
 */
export const MAX_AGENT_TABS = 4

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

/** True for a console the AI owns. */
export function isAgentTab(tab: DocumentTab): boolean {
  return tab.owner === 'agent'
}

/**
 * Result tabs for one delivery.
 *
 * A script delivery carries one entry per statement (Q10: one result tab each);
 * a single delivery carries exactly one, so both shapes converge here.
 */
export function tabsForDelivery(delivery: AgentDelivery): readonly ScriptTab[] {
  if (delivery.kind === 'script' && delivery.script !== undefined) {
    return delivery.script.map(statement => ({
      sql: statement.sql,
      result: statement.ok ? ((statement.response ?? null) as ExecuteResponse | null) : null,
      ...(statement.ok ? {} : { error: statement.error ?? { code: 'UNKNOWN', message: '执行失败' } }),
    }))
  }
  const single = delivery.single
  if (single === undefined) return [{ sql: delivery.sql, result: null }]
  if (!single.ok) {
    return [{ sql: delivery.sql, result: null, error: { code: single.error.code, message: single.error.message } }]
  }
  return [{ sql: delivery.sql, result: single }]
}

/** `ai_<label>`, suffixed when the label already names a different batch. */
function agentTitle(tabs: readonly DocumentTab[], label: string): string {
  const base = `ai_${label}`
  if (!tabs.some(tab => tab.title === base)) return base
  let index = 2
  while (tabs.some(tab => tab.title === `${base}#${index}`)) index += 1
  return `${base}#${index}`
}

/**
 * True when the agent console pool is at its soft limit.
 *
 * Consoles are **not** destroyed automatically: the "AI 历史" drawer that was
 * meant to hold evicted runs does not exist, so closing one silently threw the
 * result away (review §15 A3). Callers warn instead; the user decides.
 */
export function isAgentPoolFull(tabs: readonly DocumentTab[]): boolean {
  return tabs.filter(isAgentTab).length >= MAX_AGENT_TABS
}

/** How many closed agent consoles the history keeps. */
export const MAX_AGENT_HISTORY = 20

/**
 * Move one console into the history when the pool overflows.
 *
 * Only a **read** console is eligible: closing one the user has not looked at
 * would hide the result entirely, and an unread console is exactly what they are
 * about to open.
 */
export function archiveOverflow(
  tabs: readonly DocumentTab[],
  activeId: string,
): { readonly tabs: readonly DocumentTab[]; readonly archived: DocumentTab | null } {
  const agents = tabs.filter(isAgentTab)
  if (agents.length <= MAX_AGENT_TABS) return { tabs, archived: null }
  const victim = agents
    .filter(tab => tab.id !== activeId && tab.unread !== true)
    .sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0))[0]
  if (victim === undefined) return { tabs, archived: null }
  return { tabs: tabs.filter(tab => tab.id !== victim.id), archived: victim }
}

/** Prepend a closed console to the history, keeping it bounded. */
export function pushArchive(
  archive: readonly DocumentTab[],
  tab: DocumentTab | null,
): readonly DocumentTab[] {
  if (tab === null) return archive
  return [tab, ...archive].slice(0, MAX_AGENT_HISTORY)
}

/** Take one console back out of the history. */
export function takeArchived(
  archive: readonly DocumentTab[],
  id: string,
): { readonly archive: readonly DocumentTab[]; readonly tab: DocumentTab | null } {
  const tab = archive.find(entry => entry.id === id) ?? null
  if (tab === null) return { archive, tab: null }
  return { archive: archive.filter(entry => entry.id !== id), tab }
}

export interface AgentApply {
  readonly tabs: readonly DocumentTab[]
  /** Unchanged on purpose: a delivery must not steal focus (Q14). */
  readonly activeId: string
  readonly tabId: string
  readonly created: boolean
}

/**
 * Apply one agent delivery to the console list.
 *
 * Same label + equivalent SQL updates in place (Q11); a different query under
 * the same label becomes `ai_<label>#2`. The active console is never switched,
 * so a background delivery cannot yank the user's view.
 */
export function applyAgentDelivery(
  tabs: readonly DocumentTab[],
  activeId: string,
  delivery: AgentDelivery,
  now: number = Date.now(),
): AgentApply {
  const script = { tabs: tabsForDelivery(delivery), active: 0, running: false }
  const explicit =
    delivery.consoleId === null
      ? undefined
      : tabs.find(tab => tab.id === delivery.consoleId && tab.owner === 'agent')
  const sameLabel = tabs.find(tab => tab.owner === 'agent' && tab.label === delivery.label)
  const candidate = explicit ?? sameLabel
  /**
   * A different connection is a different result: reusing the console would show
   * connB's rows under connA's name and colour (review §15 A1).
   */
  const sameConnection = candidate !== undefined && (candidate.connId === null || candidate.connId === delivery.connId)
  const reuse =
    candidate !== undefined &&
    sameConnection &&
    (candidate.lastRunSql === '' || sameBatch(candidate.lastRunSql, delivery.sql))
      ? candidate
      : undefined

  if (reuse !== undefined) {
    // A reused console that arrives under a new label must not keep the old
    // title (review §15 A10).
    const relabel =
      reuse.label === delivery.label
        ? {}
        : { label: delivery.label, title: agentTitle(tabs.filter(tab => tab.id !== reuse.id), delivery.label) }
    const next = patchTab(tabs, reuse.id, {
      ...(reuse.connId === null ? { connId: delivery.connId } : {}),
      query: { ...reuse.query, sql: delivery.sql },
      script,
      lastRunSql: delivery.sql,
      unread: true,
      lastActivityAt: now,
      ...relabel,
    })
    return { tabs: next, activeId, tabId: reuse.id, created: false }
  }

  counter += 1
  const tab: DocumentTab = {
    id: `agent-${counter}`,
    title: agentTitle(tabs, delivery.label),
    connId: delivery.connId,
    query: { ...INITIAL_QUERY, sql: delivery.sql },
    script,
    lastRunSql: delivery.sql,
    owner: 'agent',
    label: delivery.label,
    unread: true,
    lastActivityAt: now,
  }
  return {
    tabs: [...tabs, tab],
    activeId,
    tabId: tab.id,
    created: true,
  }
}

/** Clear the unread dot when the user opens an agent console. */
export function markAgentRead(tabs: readonly DocumentTab[], id: string): readonly DocumentTab[] {
  return patchTab(tabs, id, { unread: false })
}
