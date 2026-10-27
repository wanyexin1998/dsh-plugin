/**
 * Command palette (SQL-213).
 *
 * Props-driven on purpose: the panel owns the actions (and their shortcuts), so
 * this component only filters and dispatches. Keyboard first: ↑↓ moves, Enter
 * runs, Esc closes.
 */

import * as React from 'react'

import type { ReactElement } from 'react'

import { type CommandAction, filterCommands } from '../commands.ts'
import { classes as styles } from '../styles.ts'

export interface CommandPaletteProps {
  readonly open: boolean
  readonly actions: readonly CommandAction[]
  readonly onClose: () => void
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

const keywordsStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-s-11)',
}

const emptyStyle: React.CSSProperties = {
  padding: '8px',
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-xs-13)',
}

/**
 * One palette occurrence.
 *
 * @param props - Visibility, the registered commands and the close callback.
 */
export function CommandPalette({ open, actions, onClose }: CommandPaletteProps): ReactElement | null {
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState(0)

  // Every opening starts from a clean query.
  React.useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  if (!open) return null

  const rows = filterCommands(actions, query)
  const active = rows[Math.min(selected, rows.length - 1)]

  const run = (action: CommandAction | undefined): void => {
    if (action === undefined) return
    onClose()
    action.run()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(active)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (rows.length === 0) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setSelected(current => (current + step + rows.length) % rows.length)
  }

  return (
    <div className={styles.historyOverlay} data-command-overlay="" onKeyDown={onKeyDown}>
      <div role="dialog" aria-label="命令面板" data-command-palette="" style={sheetStyle}>
        <input
          autoFocus
          aria-label="搜索命令"
          placeholder="输入命令，例如「格式」「历史」「执行」"
          value={query}
          style={inputStyle}
          onChange={event => {
            setQuery(event.target.value)
            setSelected(0)
          }}
        />
        <ul role="listbox" aria-label="命令列表" style={listStyle}>
          {rows.length === 0 ? (
            <li style={emptyStyle}>没有匹配的命令</li>
          ) : (
            rows.map((action, index) => (
              <li
                key={action.id}
                role="option"
                aria-selected={action === active}
                data-command-id={action.id}
                style={action === active ? activeItemStyle : itemStyle}
                onMouseEnter={() => {
                  setSelected(index)
                }}
                onClick={() => {
                  run(action)
                }}
              >
                <span>{action.title}</span>
                {action.keywords === undefined ? null : <span style={keywordsStyle}>{action.keywords}</span>}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}
