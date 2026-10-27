import { describe, expect, it } from 'vitest'

import type { DocumentTab } from '../src/client/state/documents.ts'
import { createTab } from '../src/client/state/documents.ts'
import { INITIAL_QUERY } from '../src/client/state/query.ts'
import {
  EMPTY_FAVORITES,
  EMPTY_HISTORY,
  EMPTY_WORKSPACE,
  MAX_FAVORITES,
  MAX_HISTORY,
  MAX_WORKSPACE_CHARS,
  addFavorite,
  defaultFavoriteName,
  favoriteFromHistory,
  filterHistory,
  fitWorkspace,
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  historyForConn,
  insertHistory,
  parseFavoritesDocument,
  parseHistoryDocument,
  parseWorkspaceState,
  previewSql,
  removeFavorite,
  replaceHistoryEntry,
  restoreConsoleDocuments,
  searchFavorites,
  searchHistory,
  toConsoleDocumentState,
  toFavoritesDocument,
  toWorkspaceState,
} from '../src/client/state/history.ts'

const entry = (id: string, overrides: Partial<Parameters<typeof insertHistory>[1]> = {}) => ({
  id,
  connId: 'c1',
  sql: `SELECT ${id}`,
  at: 1_000,
  durationMs: 5,
  rowCount: 1,
  ok: true,
  ...overrides,
})

const tab = (
  id: string,
  sql = '',
  options: { title?: string; connId?: string | null; pageSize?: number } = {},
): DocumentTab => ({
  id,
  title: options.title ?? `console_${id}`,
  connId: options.connId === undefined ? 'c1' : options.connId,
  query: { ...INITIAL_QUERY, sql, pageSize: options.pageSize ?? 500 },
  script: null,
  lastRunSql: '',
})

describe('history ring buffer', () => {
  it('prepends the newest entry', () => {
    const first = insertHistory([], entry('a'))
    const second = insertHistory(first, entry('b'))

    expect(second.map(item => item.id)).toEqual(['b', 'a'])
  })

  it('replaces a repeated id instead of stacking duplicates', () => {
    const restored = insertHistory([entry('a', { ok: false }), entry('b')], entry('a', { ok: true, durationMs: 9 }))

    expect(restored.map(item => item.id)).toEqual(['a', 'b'])
    expect(restored[0]).toMatchObject({ id: 'a', ok: true, durationMs: 9 })
  })

  it('drops the oldest entry once the ring is full', () => {
    const full = Array.from({ length: MAX_HISTORY }, (_, index) => entry(`e${index}`))

    const next = insertHistory(full, entry('newest'))

    expect(next).toHaveLength(MAX_HISTORY)
    expect(next[0]?.id).toBe('newest')
    expect(next[MAX_HISTORY - 1]?.id).toBe(`e${String(MAX_HISTORY - 2)}`)
  })

  it('patches one entry in place and ignores unknown ids', () => {
    const entries = [entry('a'), entry('b')]

    const patched = replaceHistoryEntry(entries, 'a', { ok: false, rowCount: null, durationMs: 12, errorCode: 'E1' })

    expect(patched[0]).toEqual(entry('a', { ok: false, rowCount: null, durationMs: 12, errorCode: 'E1' }))
    expect(patched[1]).toEqual(entries[1])
    expect(replaceHistoryEntry(entries, 'missing', { ok: false })).toEqual(entries)
  })
})

describe('history search and filters', () => {
  const entries = [
    entry('a', { sql: 'SELECT * FROM dwd_order WHERE dt = 1', connId: 'c1' }),
    entry('b', { sql: 'select count(*) from dwd_customer', connId: 'c2', ok: false }),
    entry('c', { sql: 'UPDATE stats SET x = 1', connId: 'c1', ok: false }),
  ]

  it('returns the list untouched for an empty query', () => {
    expect(searchHistory(entries, '')).toBe(entries)
    expect(searchHistory(entries, '   ')).toBe(entries)
  })

  it('matches case-insensitively and ANDs multiple words', () => {
    expect(searchHistory(entries, 'DWD_ORDER').map(item => item.id)).toEqual(['a'])
    expect(searchHistory(entries, 'dwd order').map(item => item.id)).toEqual(['a'])
    expect(searchHistory(entries, 'select dwd').map(item => item.id)).toEqual(['a', 'b'])
    expect(searchHistory(entries, 'nothing here')).toEqual([])
  })

  it('filters by connection, keeping all connections for null or absent', () => {
    expect(filterHistory(entries, { connId: 'c1' }).map(item => item.id)).toEqual(['a', 'c'])
    expect(filterHistory(entries, { connId: null }).map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(filterHistory(entries).map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('combines the connection and text filters', () => {
    expect(filterHistory(entries, { connId: 'c1', query: 'update' }).map(item => item.id)).toEqual(['c'])
    expect(filterHistory(entries, { connId: 'c1', query: '' }).map(item => item.id)).toEqual(['a', 'c'])
  })

  it('reads one connection out of a parsed document', () => {
    const document = { schemaVersion: 1 as const, byConn: { c1: [entry('a')] } }

    expect(historyForConn(document, 'c1')).toHaveLength(1)
    expect(historyForConn(document, 'missing')).toEqual([])
  })
})

describe('query preview', () => {
  it('collapses whitespace into one line', () => {
    expect(previewSql('  SELECT\n  a,\n\tb FROM t  ')).toBe('SELECT a, b FROM t')
  })

  it('marks an empty statement', () => {
    expect(previewSql('   \n ')).toBe('(空查询)')
  })

  it('truncates long statements with an ellipsis', () => {
    const preview = previewSql('x'.repeat(200))

    expect(preview).toHaveLength(121)
    expect(preview.endsWith('…')).toBe(true)
    expect(previewSql('x'.repeat(10), 5)).toBe('xxxxx…')
  })
})

describe('favorites', () => {
  it('derives a readable default name from the first line', () => {
    expect(defaultFavoriteName('  SELECT   a\nFROM t')).toBe('SELECT a')
    expect(defaultFavoriteName('')).toBe('未命名查询')
    expect(defaultFavoriteName('   ')).toBe('未命名查询')
    expect(defaultFavoriteName('y'.repeat(60))).toHaveLength(41)
  })

  it('turns a history entry into a favorite, naming it from the SQL', () => {
    const favorite = favoriteFromHistory(entry('a'))

    expect(favorite).toEqual({
      id: 'fav-a',
      connId: 'c1',
      name: 'SELECT a',
      sql: 'SELECT a',
      at: 1_000,
    })
  })

  it('uses an explicit name and falls back when it is blank', () => {
    expect(favoriteFromHistory(entry('a'), '  订单日报  ').name).toBe('订单日报')
    expect(favoriteFromHistory(entry('a'), '   ').name).toBe('SELECT a')
  })

  it('prepends, replaces by id and caps the list', () => {
    const two = addFavorite(addFavorite([], favoriteFromHistory(entry('a'))), favoriteFromHistory(entry('b')))
    expect(two.map(item => item.id)).toEqual(['fav-b', 'fav-a'])

    const replaced = addFavorite(two, { ...favoriteFromHistory(entry('a')), name: 'renamed' })
    expect(replaced.map(item => item.id)).toEqual(['fav-a', 'fav-b'])
    expect(replaced[0]?.name).toBe('renamed')

    const full = Array.from({ length: MAX_FAVORITES }, (_, index) => ({
      id: `fav-${String(index)}`,
      connId: 'c1',
      name: `n${String(index)}`,
      sql: 'SELECT 1',
      at: 0,
    }))
    const capped = addFavorite(full, favoriteFromHistory(entry('newest')))
    expect(capped).toHaveLength(MAX_FAVORITES)
    expect(capped[0]?.id).toBe('fav-newest')
  })

  it('removes one favorite and ignores unknown ids', () => {
    const list = [favoriteFromHistory(entry('a')), favoriteFromHistory(entry('b'))]

    expect(removeFavorite(list, 'fav-a').map(item => item.id)).toEqual(['fav-b'])
    expect(removeFavorite(list, 'missing')).toHaveLength(2)
  })

  it('searches both the name and the SQL', () => {
    const list = [
      { ...favoriteFromHistory(entry('a')), name: '每日订单' },
      { ...favoriteFromHistory(entry('b')), name: '客户' },
    ]

    expect(searchFavorites(list, '')).toBe(list)
    expect(searchFavorites(list, '订单').map(item => item.id)).toEqual(['fav-a'])
    expect(searchFavorites(list, 'SELECT')).toHaveLength(2)
    expect(searchFavorites(list, '每日 select')).toHaveLength(1)
  })

  it('wraps the list in a document', () => {
    expect(toFavoritesDocument([])).toEqual(EMPTY_FAVORITES)
    expect(toFavoritesDocument([favoriteFromHistory(entry('a'))]).schemaVersion).toBe(1)
  })
})

describe('parsing stored documents', () => {
  it('returns empty history for anything that is not a document', () => {
    expect(parseHistoryDocument(null)).toBe(EMPTY_HISTORY)
    expect(parseHistoryDocument('nope')).toBe(EMPTY_HISTORY)
    expect(parseHistoryDocument({})).toBe(EMPTY_HISTORY)
    expect(parseHistoryDocument({ byConn: [] })).toBe(EMPTY_HISTORY)
  })

  it('keeps usable entries and drops broken ones', () => {
    const document = parseHistoryDocument({
      schemaVersion: 1,
      byConn: {
        c1: [
          entry('a'),
          null,
          { id: '' },
          {},
          { id: 'no-conn' },
          { id: 'no-sql', connId: 'c1' },
          { ...entry('sparse'), at: 'yesterday', durationMs: null, rowCount: undefined, ok: 'yes', errorCode: 7 },
        ],
        c2: 'not-a-list',
      },
    })

    expect(document.byConn['c1']?.map(item => item.id)).toEqual(['a', 'sparse'])
    expect(document.byConn['c1']?.[1]).toMatchObject({ id: 'sparse', at: 0, durationMs: 0, rowCount: null, ok: false })
    expect(document.byConn['c1']?.[1]?.errorCode).toBeUndefined()
    expect(document.byConn['c2']).toBeUndefined()
  })

  it('keeps the error code of a failed entry and re-trims a huge list', () => {
    const failed = entry('bad', { ok: false, errorCode: 'ER_PARSE_ERROR' })
    const huge = Array.from({ length: MAX_HISTORY + 20 }, (_, index) => entry(`e${String(index)}`))

    const document = parseHistoryDocument({ byConn: { c1: [failed, ...huge] } })

    expect(document.byConn['c1']?.[0]).toMatchObject({ id: 'bad', ok: false, errorCode: 'ER_PARSE_ERROR' })
    expect(document.byConn['c1']).toHaveLength(MAX_HISTORY)
  })

  it('returns empty favorites for anything that is not a document', () => {
    expect(parseFavoritesDocument(null)).toBe(EMPTY_FAVORITES)
    expect(parseFavoritesDocument([])).toBe(EMPTY_FAVORITES)
    expect(parseFavoritesDocument({ entries: 'nope' })).toBe(EMPTY_FAVORITES)
  })

  it('keeps usable favorites, fixing missing names and timestamps', () => {
    const document = parseFavoritesDocument({
      entries: [
        favoriteFromHistory(entry('a')),
        null,
        {},
        { id: 'x' },
        { id: 'y', connId: 'c1' },
        { id: 'nameless', connId: 'c1', sql: 'SELECT 1' },
        { id: 'blank', connId: 'c1', sql: 'SELECT 2', name: '  ' },
        { id: 'typed', connId: 'c1', sql: 'SELECT 3', name: ' 报表 ', at: 'now' },
      ],
    })

    expect(document.entries.map(item => item.id)).toEqual(['fav-a', 'nameless', 'blank', 'typed'])
    expect(document.entries[1]).toEqual({ id: 'nameless', connId: 'c1', name: 'SELECT 1', sql: 'SELECT 1', at: 0 })
    expect(document.entries[2]?.name).toBe('SELECT 2')
    expect(document.entries[3]?.name).toBe('报表')
    expect(document.entries[3]?.at).toBe(0)
  })

  it('caps a hand-edited favorites list', () => {
    const huge = Array.from({ length: MAX_FAVORITES + 5 }, (_, index) => ({
      id: `f${String(index)}`,
      connId: 'c1',
      name: 'n',
      sql: 'SELECT 1',
      at: 0,
    }))

    expect(parseFavoritesDocument({ entries: huge }).entries).toHaveLength(MAX_FAVORITES)
  })
})

describe('console workspace snapshot', () => {
  it('snapshots one tab without any result data', () => {
    const snapshot = toConsoleDocumentState(tab('doc-1', 'SELECT 1', { title: 'console_1', pageSize: 1000 }), 3)

    expect(snapshot).toEqual({
      id: 'doc-1',
      title: 'console_1',
      connId: 'c1',
      sql: 'SELECT 1',
      pageSize: 1000,
      cursor: 3,
    })
  })

  it('keeps only the fields the panel can rebuild from', () => {
    const snapshot = toConsoleDocumentState(tab('doc-1'))

    expect(Object.keys(snapshot).sort()).toEqual(['connId', 'cursor', 'id', 'pageSize', 'sql', 'title'])
    expect(JSON.stringify(snapshot)).not.toContain('rows')
  })

  it('clamps the cursor into the statement', () => {
    const sql = 'SELECT 1'

    expect(toConsoleDocumentState(tab('doc-1', sql), -4).cursor).toBe(0)
    expect(toConsoleDocumentState(tab('doc-1', sql), Number.NaN).cursor).toBe(0)
    expect(toConsoleDocumentState(tab('doc-1', sql), 99).cursor).toBe(sql.length)
    expect(toConsoleDocumentState(tab('doc-1', sql), 2.9).cursor).toBe(2)
  })

  it('snapshots every tab with its cursor and a valid active id', () => {
    const state = toWorkspaceState([tab('a', 'SELECT 1'), tab('b', '', { connId: null })], 'b', { a: 4 })

    expect(state.docs.map(doc => doc.id)).toEqual(['a', 'b'])
    expect(state.docs[0]?.cursor).toBe(4)
    expect(state.docs[1]?.cursor).toBe(0)
    expect(state.activeDocId).toBe('b')
  })

  it('falls back to the first tab for an unknown active id and caps the list', () => {
    expect(toWorkspaceState([tab('a'), tab('b')], 'missing').activeDocId).toBe('a')
    expect(toWorkspaceState([], 'anything')).toEqual({ schemaVersion: 1, activeDocId: '', docs: [] })

    const many = Array.from({ length: 12 }, (_, index) => tab(`t${String(index)}`))
    expect(toWorkspaceState(many, 't11').docs).toHaveLength(8)
  })
})

describe('workspace size guard', () => {
  it('leaves a document under the ceiling untouched', () => {
    const state = toWorkspaceState([tab('a', 'SELECT 1')], 'a')

    expect(fitWorkspace(state)).toBe(state)
  })

  it('degrades an oversized document to the active tab', () => {
    const state = toWorkspaceState([tab('a', 'SELECT 1'), tab('b', 'SELECT 2')], 'b')

    const fitted = fitWorkspace(state, 10)

    expect(fitted.docs.map(doc => doc.id)).toEqual(['b'])
    expect(fitted.activeDocId).toBe('b')
  })

  it('falls back to the first tab when the active id is gone', () => {
    const state = { schemaVersion: 1 as const, activeDocId: 'gone', docs: [toConsoleDocumentState(tab('a'))] }

    expect(fitWorkspace(state, 10).docs.map(doc => doc.id)).toEqual(['a'])
  })

  it('has nothing to trim in an empty workspace', () => {
    expect(fitWorkspace(EMPTY_WORKSPACE, 0)).toBe(EMPTY_WORKSPACE)
    expect(MAX_WORKSPACE_CHARS).toBeGreaterThan(1000)
  })
})

describe('parsing the stored workspace', () => {
  it('returns the empty workspace for anything that is not a document', () => {
    expect(parseWorkspaceState(null)).toBe(EMPTY_WORKSPACE)
    expect(parseWorkspaceState(42)).toBe(EMPTY_WORKSPACE)
    expect(parseWorkspaceState({})).toBe(EMPTY_WORKSPACE)
    expect(parseWorkspaceState({ docs: 'nope' })).toBe(EMPTY_WORKSPACE)
  })

  it('drops unusable tabs and falls back when none survives', () => {
    expect(parseWorkspaceState({ docs: [null, {}, { id: '' }] })).toBe(EMPTY_WORKSPACE)
  })

  it('restores a stored document and repairs its optional fields', () => {
    const parsed = parseWorkspaceState({
      schemaVersion: 9,
      activeDocId: 'doc-2',
      docs: [
        { id: 'doc-1', title: 'console_1', connId: 'c1', sql: 'SELECT 1', pageSize: 1000, cursor: 2 },
        { id: 'doc-2', sql: 7, title: '', connId: 4, pageSize: 0, cursor: 'end' },
      ],
    })

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.activeDocId).toBe('doc-2')
    expect(parsed.docs[0]).toEqual({ id: 'doc-1', title: 'console_1', connId: 'c1', sql: 'SELECT 1', pageSize: 1000, cursor: 2 })
    expect(parsed.docs[1]).toEqual({
      id: 'doc-2',
      title: 'console',
      connId: null,
      sql: '',
      pageSize: 500,
      cursor: 0,
    })
  })

  it('clamps a dirty cursor to the statement length', () => {
    const parsed = parseWorkspaceState({
      docs: [
        { id: 'a', sql: 'SELECT 1', cursor: 999 },
        { id: 'b', sql: 'SELECT 2', cursor: -1 },
        { id: 'c', pageSize: Number.POSITIVE_INFINITY },
        { id: 'd', title: 'titled', sql: 'SELECT 3', cursor: 1.9 },
      ],
    })

    expect(parsed.docs[0]?.cursor).toBe('SELECT 1'.length)
    expect(parsed.docs[1]?.cursor).toBe(0)
    expect(parsed.docs[2]?.pageSize).toBe(500)
    expect(parsed.docs[3]?.title).toBe('titled')
    expect(parsed.docs[3]?.cursor).toBe(1)
  })

  it('falls back to the first tab for a missing or unknown active id', () => {
    expect(parseWorkspaceState({ docs: [{ id: 'a' }, { id: 'b' }] }).activeDocId).toBe('a')
    expect(parseWorkspaceState({ activeDocId: 7, docs: [{ id: 'a' }] }).activeDocId).toBe('a')
    expect(parseWorkspaceState({ activeDocId: 'missing', docs: [{ id: 'a' }] }).activeDocId).toBe('a')
  })

  it('never restores more tabs than the panel allows', () => {
    const docs = Array.from({ length: 12 }, (_, index) => ({ id: `t${String(index)}` }))

    expect(parseWorkspaceState({ docs }).docs).toHaveLength(8)
  })
})

describe('restoring console tabs', () => {
  it('has nothing to restore for an empty workspace', () => {
    expect(restoreConsoleDocuments(EMPTY_WORKSPACE)).toBeNull()
  })

  it('mints fresh tabs carrying the stored titles, SQL and page size', () => {
    const state = toWorkspaceState(
      [tab('doc-1', 'SELECT 1', { title: 'console_1', pageSize: 1000 }), tab('doc-2', 'SELECT 2', { title: 'console_2' })],
      'doc-2',
      { 'doc-1': 2 },
    )

    const restored = restoreConsoleDocuments(state)

    expect(restored).not.toBeNull()
    expect(restored?.tabs.map(item => item.title)).toEqual(['console_1', 'console_2'])
    expect(restored?.tabs.map(item => item.query.sql)).toEqual(['SELECT 1', 'SELECT 2'])
    expect(restored?.tabs[0]?.query.pageSize).toBe(1000)
    // Restored tabs mint fresh ids, so a later createTab cannot collide with them.
    const ids = restored?.tabs.map(item => item.id) ?? []
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain(createTab(restored?.tabs ?? [], null).id)
    expect(restored?.activeId).toBe(restored?.tabs[1]?.id)
    expect(restored?.cursors[restored?.tabs[0]?.id ?? '']).toBe(2)
  })

  it('falls back to the first tab when the active id is unknown', () => {
    const state = { ...toWorkspaceState([tab('doc-1'), tab('doc-2')], 'doc-1'), activeDocId: 'gone' }

    const restored = restoreConsoleDocuments(state)

    expect(restored?.activeId).toBe(restored?.tabs[0]?.id)
  })
})

describe('time and duration formatting', () => {
  it('formats every timestamp as local yyyy-mm-dd hh:mm:ss', () => {
    // Built from local components, so the expectation holds in any timezone.
    expect(formatTimestamp(new Date(2026, 9, 26, 5, 7, 9).getTime())).toBe('2026-10-26 05:07:09')
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05')
    expect(formatTimestamp(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe('2026-12-31 23:59:59')
  })

  it('no longer uses relative wording (需求6)', () => {
    const at = new Date(2026, 9, 26, 15, 30).getTime()

    // The clock seam is still accepted by the old call site, but ignored.
    expect(formatRelativeTime(at, at - 5 * 60_000)).toBe('2026-10-26 15:30:00')
    expect(formatRelativeTime(at)).toBe('2026-10-26 15:30:00')
  })

  it('formats sub-second and multi-second durations', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(5.4)).toBe('5ms')
    expect(formatDuration(-3)).toBe('0ms')
    expect(formatDuration(1_500)).toBe('1.5s')
    expect(formatDuration(60_000)).toBe('60.0s')
  })
})
