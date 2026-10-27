/**
 * Global object search (SQL-214).
 *
 * One modal over the workbench: type any part of a table or column name, pick
 * with ↑↓/Enter, and the panel inserts the qualified name (or the column) at the
 * editor caret. The ranking lives in `schema-tree.ts` so it is unit-testable.
 */

import * as React from 'react'

import type { ReactElement } from 'react'

import type { SchemaTable } from '../completion.ts'
import { type ObjectMatch, qualifiedName, searchObjects } from '../schema-tree.ts'
import { classes as styles } from '../styles.ts'

export interface ObjectSearchProps {
  readonly open: boolean
  readonly tables: readonly SchemaTable[]
  readonly onClose: () => void
  /** Insert a qualified table name (`schema.table`). */
  readonly onPickTable: (qualifiedName: string) => void
  /** Pick the whole table object; used when the caller needs both objects (JOIN). */
  readonly onPickTableObject?: (table: SchemaTable) => void
  /** Insert one column (the panel decides whether to qualify it). */
  readonly onPickColumn: (table: SchemaTable, column: string) => void
}

const sheetStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  alignSelf: 'flex-start',
  maxHeight: '70%',
  margin: '8vh auto 0',
  padding: '10px',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 10px)',
  boxShadow: '0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
}

const inputStyle: React.CSSProperties = {
  height: '30px',
  padding: '0 8px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '8px',
  font: 'inherit',
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  overflow: 'auto',
  listStyle: 'none',
}

const itemStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 8px',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: 'var(--dsw-font-xs-13)',
}

const activeItemStyle: React.CSSProperties = {
  ...itemStyle,
  background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))',
}

const metaStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-s-11)',
  whiteSpace: 'nowrap',
}

const emptyStyle: React.CSSProperties = {
  padding: '8px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-xs-13)',
}

/** Display label and right-side detail for one match. */
function describe(match: ObjectMatch): { readonly label: string; readonly detail: string } {
  if (match.column !== undefined) {
    const owner = match.table.schema === undefined || match.table.schema === '' ? match.table.name : `${match.table.schema}.${match.table.name}`
    return { label: match.column.name, detail: `${match.column.type} · ${owner}` }
  }
  const schema = match.table.schema === undefined || match.table.schema === '' ? '' : `${match.table.schema}.`
  return { label: qualifiedName(match.table), detail: `${schema}${String(match.table.columns.length)} 列` }
}

/**
 * One search modal occurrence.
 *
 * @param props - Visibility, the schema snapshot and the pick/close callbacks.
 */
export function ObjectSearch({ open, tables, onClose, onPickTable, onPickTableObject, onPickColumn }: ObjectSearchProps): ReactElement | null {
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState(0)

  React.useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  if (!open) return null

  const rows = searchObjects(tables, query)
  const active = rows[Math.min(selected, rows.length - 1)]

  const pick = (match: ObjectMatch | undefined): void => {
    if (match === undefined) return
    onClose()
    if (match.column !== undefined) onPickColumn(match.table, match.column.name)
    else if (onPickTableObject === undefined) onPickTable(qualifiedName(match.table))
    else onPickTableObject(match.table)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      pick(active)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (rows.length === 0) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setSelected(current => (current + step + rows.length) % rows.length)
  }

  return (
    <div className={styles.historyOverlay} data-object-search-overlay="" onKeyDown={onKeyDown}>
      <div role="dialog" aria-label="对象搜索" data-object-search="" style={sheetStyle}>
        <input
          autoFocus
          aria-label="搜索表或列"
          placeholder="搜索表 / 列，例如 order、amount"
          value={query}
          style={inputStyle}
          onChange={event => {
            setQuery(event.target.value)
            setSelected(0)
          }}
        />
        <ul role="listbox" aria-label="对象列表" style={listStyle}>
          {query.trim() === '' ? (
            <li style={emptyStyle}>输入表名或列名开始搜索</li>
          ) : rows.length === 0 ? (
            <li style={emptyStyle}>没有匹配的对象</li>
          ) : (
            rows.map((match, index) => {
              const info = describe(match)
              return (
                <li
                  key={`${match.table.schema ?? ''}:${match.table.name}:${match.column?.name ?? ''}`}
                  role="option"
                  aria-selected={match === active}
                  data-object-id={`${match.table.name}${match.column === undefined ? '' : `.${match.column.name}`}`}
                  style={match === active ? activeItemStyle : itemStyle}
                  onMouseEnter={() => {
                    setSelected(index)
                  }}
                  onClick={() => {
                    pick(match)
                  }}
                >
                  <span>{info.label}</span>
                  <span style={metaStyle}>{info.detail}</span>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </div>
  )
}
