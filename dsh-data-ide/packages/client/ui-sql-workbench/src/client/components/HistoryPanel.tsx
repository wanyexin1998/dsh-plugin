/**
 * Query history + favorites panel (SQL-204 / SQL-205).
 *
 * Props-driven and self-contained: it owns only its tab / search / selection
 * state and never talks to the host. The panel (or a future tab) passes the
 * already-loaded history, decides what "insert" and "replace" mean for the
 * editor, and wires persistence; that keeps the component testable without a
 * project, a host, or a storage backend.
 *
 * Interaction follows DataGrip's history widget: type to narrow, ↑/↓ to move,
 * Enter (or a double click) inserts the statement at the cursor, and
 * Ctrl/Cmd+Enter (or the 替换 button) replaces the current statement.
 */

import * as React from 'react'
import type { CSSProperties, ReactElement } from 'react'

import type { FavoriteEntry, QueryHistoryEntry } from '../state/history.ts'
import {
  filterHistory,
  formatDuration,
  formatRelativeTime,
  previewSql,
  searchFavorites,
} from '../state/history.ts'

/** Which list the panel is showing. */
export type HistoryPanelTab = 'history' | 'favorites'

export interface HistoryPanelProps {
  /** All recorded runs; the panel filters by connection and search text. */
  readonly entries: readonly QueryHistoryEntry[]
  /** Pinned queries; absent means "nothing pinned yet". */
  readonly favorites?: readonly FavoriteEntry[]
  /** Connection to show history/favorites for; `null`/absent means all. */
  readonly connId?: string | null
  /** Insert a statement at the editor cursor (Enter, double click). */
  readonly onInsert: (sql: string) => void
  /** Replace the current statement (Ctrl/Cmd+Enter, 替换 button). */
  readonly onReplace: (sql: string) => void
  /** Save an entry as a favorite; absent hides the pin control. */
  readonly onPin?: (entry: QueryHistoryEntry) => void
  /** Delete a favorite; absent hides the remove control. */
  readonly onRemoveFavorite?: (id: string) => void
  /** Esc asks the host to put the panel away; absent makes Esc inert. */
  readonly onClose?: () => void
  /** Initial tab; defaults to history. */
  readonly initialTab?: HistoryPanelTab
  /** Clock seam for the relative timestamps; defaults to `Date.now`. */
  readonly now?: () => number
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
  padding: 8,
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 'var(--dsw-font-s-14)',
}

const tabBarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4 }

const tabStyle: CSSProperties = {
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  padding: '2px 6px',
  fontSize: 'var(--dsw-font-xs-13)',
}

const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  color: 'var(--dsw-alias-state-business-primary)',
  borderBottom: '2px solid var(--dsw-alias-state-business-primary)',
}

const closeStyle: CSSProperties = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  fontSize: 'var(--dsw-font-xs-13)',
}

const searchStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '3px 6px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 'var(--dsw-font-s-14)',
  outline: 'none',
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  overflowY: 'auto',
  minHeight: 0,
  flex: 1,
}

const itemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '4px 6px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid transparent',
}

const itemSelectedStyle: CSSProperties = {
  ...itemStyle,
  background: 'var(--dsw-alias-interactive-bg-active)',
  border: '1px solid var(--dsw-alias-border-l2)',
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }

const sqlStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const metaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-xs-13)',
  minWidth: 0,
}

const dotSuccessStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 3,
  flex: 'none',
  background: 'var(--dsw-alias-state-success-primary)',
}

const dotErrorStyle: CSSProperties = { ...dotSuccessStyle, background: 'var(--dsw-alias-state-error-primary)' }

const statusSuccessStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }
const statusErrorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

const iconButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  padding: 0,
  fontSize: 'var(--dsw-font-s-14)',
}

const replaceButtonStyle: CSSProperties = {
  ...iconButtonStyle,
  marginLeft: 'auto',
  color: 'var(--dsw-alias-state-business-primary)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const emptyStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-s-14)',
  padding: 8,
  textAlign: 'center',
}

const favoriteNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 'var(--dsw-font-s-14)',
}

/** Status word for a row; the detailed reason goes in the tooltip. */
function statusLabel(entry: QueryHistoryEntry): string {
  return entry.ok ? '成功' : '失败'
}

/** Tooltip explaining a failed row without adding a second line. */
function statusTitle(entry: QueryHistoryEntry): string {
  if (entry.ok) return '执行成功'
  return entry.errorCode ?? '执行失败'
}

/** Rows cell text; a failed/first-page-unknown run has no count. */
function rowCountLabel(rowCount: number | null): string {
  return rowCount === null ? '行数未知' : `${String(rowCount)} 行`
}

/** Empty-state copy, which differs for "nothing yet" and "nothing matched". */
function emptyText(tab: HistoryPanelTab, query: string): string {
  const searching = query.trim() !== ''
  if (tab === 'history') return searching ? '没有匹配的查询' : '还没有查询历史'
  return searching ? '没有匹配的收藏' : '还没有收藏的查询'
}

/**
 * History and favorites in one switchable list.
 *
 * @param props - see {@link HistoryPanelProps}.
 */
export function HistoryPanel({
  entries,
  favorites = [],
  connId,
  onInsert,
  onReplace,
  onPin,
  onRemoveFavorite,
  onClose,
  initialTab = 'history',
  now,
}: HistoryPanelProps): ReactElement {
  const [tab, setTab] = React.useState<HistoryPanelTab>(initialTab)
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState(0)
  const clock = now ?? Date.now

  const historyRows = filterHistory(entries, { connId, query })
  const favoriteRows = searchFavorites(favorites, query)
  const rows = tab === 'history' ? historyRows : favoriteRows
  const selectedRow = rows[Math.min(selected, rows.length - 1)]

  const chooseTab = (next: HistoryPanelTab): void => {
    setTab(next)
    setSelected(0)
  }

  const search = (value: string): void => {
    setQuery(value)
    // The narrowed list has no relationship to the old index.
    setSelected(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose?.()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selectedRow === undefined) return
      if (event.ctrlKey || event.metaKey) onReplace(selectedRow.sql)
      else onInsert(selectedRow.sql)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (rows.length === 0) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setSelected(current => Math.min(Math.max(current + step, 0), rows.length - 1))
  }

  return (
    <div
      style={panelStyle}
      role="dialog"
      aria-label="查询历史"
      data-sql-history-panel=""
      onKeyDown={handleKeyDown}
    >
      <div style={tabBarStyle} role="tablist" aria-label="查询历史与收藏">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          data-sql-history-tab="history"
          style={tab === 'history' ? tabActiveStyle : tabStyle}
          onClick={() => {
            chooseTab('history')
          }}
        >
          历史 {String(entries.length)}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'favorites'}
          data-sql-history-tab="favorites"
          style={tab === 'favorites' ? tabActiveStyle : tabStyle}
          onClick={() => {
            chooseTab('favorites')
          }}
        >
          收藏 {String(favorites.length)}
        </button>
        {onClose === undefined ? null : (
          <button
            type="button"
            style={closeStyle}
            aria-label="关闭历史面板"
            title="关闭（Esc）"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>

      <input
        type="search"
        value={query}
        style={searchStyle}
        aria-label="搜索查询历史"
        placeholder="搜索 SQL 或收藏名"
        data-sql-history-search=""
        autoFocus
        onChange={event => {
          search(event.target.value)
        }}
      />

      {rows.length === 0 ? (
        <div style={emptyStyle} data-sql-history-empty="">
          {emptyText(tab, query)}
        </div>
      ) : tab === 'history' ? (
        <ul style={listStyle} role="listbox" aria-label="查询历史列表">
          {historyRows.map((row, index) => (
            <li
              key={row.id}
              role="option"
              aria-selected={index === selected}
              style={index === selected ? itemSelectedStyle : itemStyle}
              data-sql-history-item=""
              data-entry-id={row.id}
              title={row.sql}
              onClick={() => {
                setSelected(index)
              }}
              onDoubleClick={() => {
                onInsert(row.sql)
              }}
            >
              <div style={rowStyle}>
                <span
                  style={row.ok ? dotSuccessStyle : dotErrorStyle}
                  aria-label={statusLabel(row)}
                  title={statusTitle(row)}
                />
                <span style={sqlStyle}>{previewSql(row.sql, 80)}</span>
                {onPin === undefined ? null : (
                  <button
                    type="button"
                    style={iconButtonStyle}
                    data-sql-history-pin=""
                    aria-label="收藏这条查询"
                    title="收藏"
                    onClick={event => {
                      event.stopPropagation()
                      onPin(row)
                    }}
                  >
                    ☆
                  </button>
                )}
              </div>
              <div style={metaStyle}>
                <span>{formatRelativeTime(row.at, clock())}</span>
                <span>·</span>
                <span>{formatDuration(row.durationMs)}</span>
                <span>·</span>
                <span>{rowCountLabel(row.rowCount)}</span>
                <span>·</span>
                <span style={row.ok ? statusSuccessStyle : statusErrorStyle}>{statusLabel(row)}</span>
                <button
                  type="button"
                  style={replaceButtonStyle}
                  data-sql-history-replace=""
                  aria-label="替换当前语句"
                  title="替换当前语句"
                  onClick={event => {
                    event.stopPropagation()
                    onReplace(row.sql)
                  }}
                >
                  替换
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul style={listStyle} role="listbox" aria-label="收藏的查询">
          {favoriteRows.map((row, index) => (
            <li
              key={row.id}
              role="option"
              aria-selected={index === selected}
              style={index === selected ? itemSelectedStyle : itemStyle}
              data-sql-favorite-item=""
              data-entry-id={row.id}
              title={row.sql}
              onClick={() => {
                setSelected(index)
              }}
              onDoubleClick={() => {
                onInsert(row.sql)
              }}
            >
              <div style={rowStyle}>
                <span style={favoriteNameStyle}>{row.name}</span>
                {onRemoveFavorite === undefined ? null : (
                  <button
                    type="button"
                    style={iconButtonStyle}
                    data-sql-favorite-remove=""
                    aria-label={`取消收藏 ${row.name}`}
                    title="取消收藏"
                    onClick={event => {
                      event.stopPropagation()
                      onRemoveFavorite(row.id)
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
              <div style={metaStyle}>
                <span style={sqlStyle}>{previewSql(row.sql, 80)}</span>
                <span>{formatRelativeTime(row.at, clock())}</span>
                <button
                  type="button"
                  style={replaceButtonStyle}
                  data-sql-favorite-replace=""
                  aria-label="替换当前语句"
                  title="替换当前语句"
                  onClick={event => {
                    event.stopPropagation()
                    onReplace(row.sql)
                  }}
                >
                  替换
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
