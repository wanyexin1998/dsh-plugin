/**
 * Query history, favorites and console-workspace persistence — pure state logic.
 *
 * Three related concerns share this module because they share one storage
 * character: they are the panel's memory across a reload (docs/09 B4/B5,
 * SQL-201..205), they are small JSON documents the host writes through its
 * single-writer `KvStore`, and they must survive corrupt / hand-edited values
 * without throwing. Everything here is pure (or a thin parser over `unknown`),
 * so the clamping and fallback rules are testable without React, a host, or a
 * real storage backend.
 *
 * The shapes written to storage are intentionally boring: plain JSON objects
 * with a `schemaVersion`, no `undefined`, no `Map`, no result sets. Result sets
 * are never part of these documents — that is what keeps a reload affordable
 * (docs/04 §6: results live in memory only).
 */

import { DEFAULT_PAGE_SIZE } from './query.ts'
import { MAX_TABS, createTab } from './documents.ts'
import type { DocumentTab } from './documents.ts'

// ---------------------------------------------------------------------------
// Query history (SQL-203)
// ---------------------------------------------------------------------------

/** One recorded statement run; both human and agent runs have this shape. */
export interface QueryHistoryEntry {
  readonly id: string
  readonly connId: string
  readonly sql: string
  /** Epoch milliseconds of the run; `at` breaks ties after a reload. */
  readonly at: number
  readonly durationMs: number
  /** `null` when the statement never produced a count (failure or unknown). */
  readonly rowCount: number | null
  /** `false` for failed and cancelled runs. */
  readonly ok: boolean
  /** Driver/engine code of a failed run; absent when `ok` is `true`. */
  readonly errorCode?: string
}

/** Ring-buffer ceiling per connection (docs/04 §5). */
export const MAX_HISTORY = 200

/** Persisted layout: `{ schemaVersion, byConn: { [connId]: entries[] } }`. */
export interface HistoryDocument {
  readonly schemaVersion: 1
  readonly byConn: Readonly<Record<string, readonly QueryHistoryEntry[]>>
}

/** Document holding every connection's history; also the panel's fallback. */
export const EMPTY_HISTORY: HistoryDocument = { schemaVersion: 1, byConn: {} }

/** A filter the panel applies to its in-memory history list. */
export interface HistoryFilter {
  /** Only entries for this connection; `null`/absent means all connections. */
  readonly connId?: string | null
  /** Free-text search over the SQL; multiple words are ANDed. */
  readonly query?: string
}

/**
 * Add an entry as the newest history record.
 *
 * A repeated `id` replaces the old record in place (re-running a statement
 * updates its row instead of stacking duplicates), and the per-connection ring
 * is trimmed to {@link MAX_HISTORY}.
 */
export function insertHistory(
  entries: readonly QueryHistoryEntry[],
  entry: QueryHistoryEntry,
): readonly QueryHistoryEntry[] {
  return [entry, ...entries.filter(item => item.id !== entry.id)].slice(0, MAX_HISTORY)
}

/**
 * Update one history record in place, keeping its position.
 *
 * Used when a run is started and completed in two steps (an entry created at
 * start gets its duration/row count once the answer lands). Unknown ids are a
 * no-op, so a stale update cannot append a ghost row.
 */
export function replaceHistoryEntry(
  entries: readonly QueryHistoryEntry[],
  id: string,
  patch: Partial<Pick<QueryHistoryEntry, 'durationMs' | 'rowCount' | 'ok' | 'errorCode'>>,
): readonly QueryHistoryEntry[] {
  return entries.map(entry => (entry.id === id ? { ...entry, ...patch } : entry))
}

/** Split a search string into lower-case words; blanks are ignored. */
function queryWords(query: string): readonly string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word !== '')
}

/** True when every word occurs in `text` (case-insensitive AND search). */
function matchesWords(text: string, words: readonly string[]): boolean {
  const haystack = text.toLowerCase()
  return words.every(word => haystack.includes(word))
}

/**
 * Filter history by SQL text.
 *
 * An empty query returns the list untouched (the ring is already newest-first),
 * and multiple words are ANDed: `"order dt"` keeps only statements containing
 * both words, which is how people narrow a long history.
 */
export function searchHistory(
  entries: readonly QueryHistoryEntry[],
  query: string,
): readonly QueryHistoryEntry[] {
  const words = queryWords(query)
  if (words.length === 0) return entries
  return entries.filter(entry => matchesWords(entry.sql, words))
}

/** Apply the connection filter, then the text search. */
export function filterHistory(
  entries: readonly QueryHistoryEntry[],
  filter: HistoryFilter = {},
): readonly QueryHistoryEntry[] {
  const byConn =
    filter.connId == null ? entries : entries.filter(entry => entry.connId === filter.connId)
  return searchHistory(byConn, filter.query ?? '')
}

/** Read one connection's entries out of a parsed document. */
export function historyForConn(
  document: HistoryDocument,
  connId: string,
): readonly QueryHistoryEntry[] {
  return document.byConn[connId] ?? []
}

/** One-line preview of a statement, used by the history list and favorites. */
export function previewSql(sql: string, maxLength = 120): string {
  const compact = sql.trim().replace(/\s+/g, ' ')
  if (compact === '') return '(空查询)'
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

// ---------------------------------------------------------------------------
// Favorites (SQL-205)
// ---------------------------------------------------------------------------

/** A named pinned query; persisted so it survives restarts. */
export interface FavoriteEntry {
  readonly id: string
  readonly connId: string
  readonly name: string
  readonly sql: string
  readonly at: number
}

/** Ceiling for the favorites list; generous, because these are deliberate. */
export const MAX_FAVORITES = 100

/** Persisted layout: `{ schemaVersion, entries }`. */
export interface FavoritesDocument {
  readonly schemaVersion: 1
  readonly entries: readonly FavoriteEntry[]
}

export const EMPTY_FAVORITES: FavoritesDocument = { schemaVersion: 1, entries: [] }

/** Name derived from a statement when the user does not type one. */
export function defaultFavoriteName(sql: string): string {
  // `split` always yields at least one line, so the cast is honest; it keeps the
  // branch table free of an arm that can never be taken.
  const firstLine = sql.trim().split(/\r?\n/)[0] as string
  const compact = firstLine.trim().replace(/\s+/g, ' ')
  if (compact === '') return '未命名查询'
  return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact
}

/** Turn a history record into a favorite; the id is derived so re-pinning replaces. */
export function favoriteFromHistory(entry: QueryHistoryEntry, name?: string): FavoriteEntry {
  const typed = name?.trim() ?? ''
  return {
    id: `fav-${entry.id}`,
    connId: entry.connId,
    name: typed === '' ? defaultFavoriteName(entry.sql) : typed,
    sql: entry.sql,
    at: entry.at,
  }
}

/** Prepend a favorite; a repeated id replaces the old row and the list is capped. */
export function addFavorite(
  entries: readonly FavoriteEntry[],
  entry: FavoriteEntry,
): readonly FavoriteEntry[] {
  return [entry, ...entries.filter(item => item.id !== entry.id)].slice(0, MAX_FAVORITES)
}

/** Remove one favorite by id (unknown ids are a no-op). */
export function removeFavorite(
  entries: readonly FavoriteEntry[],
  id: string,
): readonly FavoriteEntry[] {
  return entries.filter(entry => entry.id !== id)
}

/** Search favorites over both the name and the SQL text. */
export function searchFavorites(
  entries: readonly FavoriteEntry[],
  query: string,
): readonly FavoriteEntry[] {
  const words = queryWords(query)
  if (words.length === 0) return entries
  return entries.filter(entry => matchesWords(`${entry.name} ${entry.sql}`, words))
}

/** Wrap the list in the persisted document shape. */
export function toFavoritesDocument(entries: readonly FavoriteEntry[]): FavoritesDocument {
  return { schemaVersion: 1, entries }
}

// ---------------------------------------------------------------------------
// Console workspace (SQL-201/202)
// ---------------------------------------------------------------------------

/** One tab as persisted: enough to rebuild the editor, never a result set. */
export interface ConsoleDocumentState {
  readonly id: string
  readonly title: string
  readonly connId: string | null
  readonly sql: string
  readonly pageSize: number
  /** Editor cursor offset (UTF-16 code units), clamped to the SQL length. */
  readonly cursor: number
}

/** Persisted layout: active tab id plus one record per console. */
export interface WorkspaceState {
  readonly schemaVersion: 1
  readonly activeDocId: string
  readonly docs: readonly ConsoleDocumentState[]
}

export const EMPTY_WORKSPACE: WorkspaceState = { schemaVersion: 1, activeDocId: '', docs: [] }

/**
 * Request-body ceiling shared with `web-routes.ts` (256KB) with headroom: a
 * payload above this is degraded to the active tab before it is sent.
 */
export const MAX_WORKSPACE_CHARS = 200 * 1024

/** What {@link restoreConsoleDocuments} hands back to the panel. */
export interface RestoredWorkspace {
  /** Fresh tabs (new ids) carrying the stored titles, SQL and page sizes. */
  readonly tabs: readonly DocumentTab[]
  readonly activeId: string
  /** Cursor offset per **new** tab id, for the editor adapter to apply. */
  readonly cursors: Readonly<Record<string, number>>
}

/** Keep a cursor offset inside the document it points at. */
function clampCursor(cursor: number, sql: string): number {
  if (!Number.isFinite(cursor) || cursor < 0) return 0
  return Math.min(Math.floor(cursor), sql.length)
}

/** Snapshot one tab for persistence. */
export function toConsoleDocumentState(tab: DocumentTab, cursor = 0): ConsoleDocumentState {
  return {
    id: tab.id,
    title: tab.title,
    connId: tab.connId,
    sql: tab.query.sql,
    pageSize: tab.query.pageSize,
    cursor: clampCursor(cursor, tab.query.sql),
  }
}

/** Snapshot every tab; cursor offsets are keyed by tab id. */
export function toWorkspaceState(
  tabs: readonly DocumentTab[],
  activeDocId: string,
  cursors: Readonly<Record<string, number>> = {},
): WorkspaceState {
  const docs = tabs.slice(0, MAX_TABS).map(tab => toConsoleDocumentState(tab, cursors[tab.id] ?? 0))
  const active = docs.some(doc => doc.id === activeDocId) ? activeDocId : firstDocId(docs)
  return { schemaVersion: 1, activeDocId: active, docs }
}

/** First tab id of a list, or `''` when there is none. */
function firstDocId(docs: readonly { readonly id: string }[]): string {
  const first = docs[0]
  return first === undefined ? '' : first.id
}

/**
 * Keep the payload under the request limit.
 *
 * A long session can accumulate eight statements of arbitrary size; when the
 * serialized document would exceed the route ceiling the acceptance rule is
 * "degrade to the active tab" (docs/09 B4-③) rather than dropping persistence
 * altogether. If the active tab alone is still too large the host refuses the
 * write and the panel keeps the live state; saves are best-effort by design.
 */
export function fitWorkspace(
  state: WorkspaceState,
  maxChars: number = MAX_WORKSPACE_CHARS,
): WorkspaceState {
  if (JSON.stringify(state).length <= maxChars) return state
  const active = state.docs.find(doc => doc.id === state.activeDocId) ?? state.docs[0]
  if (active === undefined) return state
  return { ...state, docs: [active] }
}

/** Rebuild live tabs from a persisted workspace, minting fresh ids. */
export function restoreConsoleDocuments(state: WorkspaceState): RestoredWorkspace | null {
  if (state.docs.length === 0) return null
  let tabs: DocumentTab[] = []
  const idMap = new Map<string, string>()
  const cursors: Record<string, number> = {}
  for (const doc of state.docs) {
    // Mint through `createTab` so ids never collide with a later `createTab`
    // call after the reload; the stored id only maps the active tab.
    const fresh = createTab(tabs, doc.connId)
    const tab: DocumentTab = {
      ...fresh,
      title: doc.title,
      query: { ...fresh.query, sql: doc.sql, pageSize: doc.pageSize },
    }
    tabs = [...tabs, tab]
    idMap.set(doc.id, tab.id)
    cursors[tab.id] = doc.cursor
  }
  const mapped = idMap.get(state.activeDocId)
  return { tabs, activeId: mapped ?? (tabs[0] as DocumentTab).id, cursors }
}

// ---------------------------------------------------------------------------
// Parsing stored documents
// ---------------------------------------------------------------------------

/** True for a plain JSON object; arrays and `null` are never documents. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow one stored history entry; unusable records are dropped, not fatal. */
function coerceHistoryEntry(value: unknown): QueryHistoryEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const connId = value['connId']
  const sql = value['sql']
  if (typeof id !== 'string' || id === '') return null
  if (typeof connId !== 'string' || connId === '') return null
  if (typeof sql !== 'string') return null
  const errorCode = value['errorCode']
  return {
    id,
    connId,
    sql,
    at: typeof value['at'] === 'number' ? value['at'] : 0,
    durationMs: typeof value['durationMs'] === 'number' ? value['durationMs'] : 0,
    rowCount: typeof value['rowCount'] === 'number' ? value['rowCount'] : null,
    ok: value['ok'] === true,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
  }
}

/**
 * Parse the history document the host returns.
 *
 * Anything unreadable falls back to empty history: a corrupt document must cost
 * the user their history, not the panel. Per-connection lists are re-trimmed so
 * a hand-edited document cannot grow without bound.
 */
export function parseHistoryDocument(raw: unknown): HistoryDocument {
  if (!isRecord(raw) || !isRecord(raw['byConn'])) return EMPTY_HISTORY
  const byConn: Record<string, readonly QueryHistoryEntry[]> = {}
  for (const [connId, value] of Object.entries(raw['byConn'])) {
    if (!Array.isArray(value)) continue
    byConn[connId] = value
      .map(item => coerceHistoryEntry(item))
      .filter((item): item is QueryHistoryEntry => item !== null)
      .slice(0, MAX_HISTORY)
  }
  return { schemaVersion: 1, byConn }
}

/** Narrow one stored favorite. */
function coerceFavorite(value: unknown): FavoriteEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  const connId = value['connId']
  const sql = value['sql']
  if (typeof id !== 'string' || id === '') return null
  if (typeof connId !== 'string' || connId === '') return null
  if (typeof sql !== 'string') return null
  const name = typeof value['name'] === 'string' ? value['name'].trim() : ''
  return {
    id,
    connId,
    name: name === '' ? defaultFavoriteName(sql) : name,
    sql,
    at: typeof value['at'] === 'number' ? value['at'] : 0,
  }
}

/** Parse the favorites document; same fallback rule as history. */
export function parseFavoritesDocument(raw: unknown): FavoritesDocument {
  if (!isRecord(raw) || !Array.isArray(raw['entries'])) return EMPTY_FAVORITES
  const entries = raw['entries']
    .map(item => coerceFavorite(item))
    .filter((item): item is FavoriteEntry => item !== null)
    .slice(0, MAX_FAVORITES)
  return { schemaVersion: 1, entries }
}

/** Narrow one stored console document. */
function coerceConsoleDocument(value: unknown): ConsoleDocumentState | null {
  if (!isRecord(value)) return null
  const id = value['id']
  if (typeof id !== 'string' || id === '') return null
  const sql = typeof value['sql'] === 'string' ? value['sql'] : ''
  const titleValue = value['title']
  const title = typeof titleValue === 'string' && titleValue !== '' ? titleValue : 'console'
  const connId = typeof value['connId'] === 'string' ? value['connId'] : null
  const pageSizeValue = value['pageSize']
  const pageSize =
    typeof pageSizeValue === 'number' && Number.isFinite(pageSizeValue) && pageSizeValue > 0
      ? pageSizeValue
      : DEFAULT_PAGE_SIZE
  const cursorValue = value['cursor']
  const cursor = typeof cursorValue === 'number' ? clampCursor(cursorValue, sql) : 0
  return { id, title, connId, sql, pageSize, cursor }
}

/**
 * Parse the workspace document.
 *
 * Every field is optional inside a stored tab so an older build's document (or
 * one written by hand) still restores partially; the cursor is clamped to the
 * SQL length and a missing/unknown active id falls back to the first tab
 * (SQL-202-③: dirty data must clamp, never throw).
 */
export function parseWorkspaceState(raw: unknown): WorkspaceState {
  if (!isRecord(raw) || !Array.isArray(raw['docs'])) return EMPTY_WORKSPACE
  const docs: ConsoleDocumentState[] = []
  for (const item of raw['docs']) {
    const doc = coerceConsoleDocument(item)
    if (doc !== null) docs.push(doc)
    if (docs.length >= MAX_TABS) break
  }
  if (docs.length === 0) return EMPTY_WORKSPACE
  const requestedValue = raw['activeDocId']
  const requested = typeof requestedValue === 'string' ? requestedValue : ''
  const activeId = docs.some(doc => doc.id === requested) ? requested : firstDocId(docs)
  return { schemaVersion: 1, activeDocId: activeId, docs }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Two-digit zero padding for month/day/hour/minute/second. */
function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value)
}

/**
 * The one timestamp format the panel shows: local `yyyy-mm-dd hh:mm:ss`.
 *
 * 需求6 unifies every user-visible time on this shape. Relative wording
 * ("刚刚"/"5 分钟前") reads well in a feed but makes two rows impossible to
 * compare and cannot be pasted into a ticket. Local time on purpose: a run at
 * 09:05 happened at 09:05 on the user's clock, not in UTC.
 *
 * @param at - Epoch milliseconds.
 */
export function formatTimestamp(at: number): string {
  const date = new Date(at)
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Kept for the history list's call site — now an absolute local timestamp.
 *
 * The name is historical: `HistoryPanel` still imports it (that file is outside
 * this task's write scope). `now` stays in the signature for source
 * compatibility with that call site; it no longer affects the answer. New code
 * should use {@link formatTimestamp}.
 */
export function formatRelativeTime(at: number, _now?: number): string {
  return formatTimestamp(at)
}

/** Compact duration: integer milliseconds below a second, seconds above. */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${String(Math.max(0, Math.round(durationMs)))}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}
