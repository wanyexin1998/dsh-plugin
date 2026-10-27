/**
 * Shortcut cheat sheet (SQL-2xx, P2: keyboard discoverability).
 *
 * A plain static dialog: the shortcuts are owned by the editor keymap and the
 * panel, so listing them here is documentation, not behaviour. Opened with `?`,
 * from the command palette, or the ⓘ hint in narrow panes.
 */

import * as React from 'react'

import type { ReactElement } from 'react'

import { classes as styles } from '../styles.ts'

export interface ShortcutsHelpProps {
  readonly open: boolean
  readonly onClose: () => void
}

/** One group of related shortcuts. */
interface Group {
  readonly title: string
  readonly rows: readonly { readonly keys: string; readonly action: string }[]
}

const GROUPS: readonly Group[] = [
  {
    title: '执行',
    rows: [
      { keys: 'Ctrl/Cmd + Enter', action: '执行光标所在语句' },
      { keys: 'Ctrl/Cmd + Shift + Enter', action: '执行全部语句' },
      { keys: 'Ctrl/Cmd + Alt + Enter', action: '重跑上次' },
      { keys: 'Esc', action: '取消执行 / 关闭浮层' },
    ],
  },
  {
    title: '编辑',
    rows: [
      { keys: 'Ctrl/Cmd + Alt + L', action: '格式化选中 / 全文' },
      { keys: 'Ctrl/Cmd + Alt + S', action: '把 * 展开为列清单' },
      { keys: 'Ctrl/Cmd + Shift + E', action: '查看执行计划' },
      { keys: 'Ctrl/Cmd + Space', action: '唤起代码补全' },
      { keys: 'Enter / Tab', action: '接受补全（有补全弹层时）' },
    ],
  },
  {
    title: '结果',
    rows: [
      { keys: 'Ctrl/Cmd + F', action: '在当前页查找' },
      { keys: 'Ctrl/Cmd + A', action: '选中整页' },
      { keys: 'Ctrl/Cmd + C', action: '复制选区（TSV）' },
      { keys: '双击单元格', action: '打开值查看器' },
    ],
  },
  {
    title: '全局',
    rows: [
      { keys: 'Ctrl/Cmd + Shift + P', action: '命令面板' },
      { keys: 'Ctrl/Cmd + Shift + O', action: '全局对象搜索' },
      { keys: 'Ctrl/Cmd + Shift + H', action: '查询历史与收藏' },
      { keys: 'F4 / Ctrl + B', action: '对象树：打开数据 / 查看 DDL' },
    ],
  },
]

const sheetStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  maxHeight: '76%',
  margin: '6vh auto 0',
  padding: '12px 14px',
  overflow: 'auto',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 10px)',
  boxShadow: '0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const titleStyle: React.CSSProperties = {
  margin: '0 0 8px',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'var(--dsw-font-s-13)',
  fontWeight: 600,
}

const groupStyle: React.CSSProperties = {
  margin: '0 0 10px',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  justifyContent: 'space-between',
  padding: '2px 0',
}

const keysStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  whiteSpace: 'nowrap',
}

const actionStyle: React.CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  textAlign: 'right',
}

/**
 * Static shortcut sheet.
 *
 * @param props - Visibility and the close callback.
 */
export function ShortcutsHelp({ open, onClose }: ShortcutsHelpProps): ReactElement | null {
  if (!open) return null
  return (
    <div
      className={styles.historyOverlay}
      data-shortcuts-overlay=""
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
      }}
    >
      <div role="dialog" aria-label="快捷键说明" data-shortcuts-help="" style={sheetStyle}>
        <h2 style={titleStyle}>快捷键</h2>
        {GROUPS.map(group => (
          <section key={group.title} style={groupStyle}>
            <h3 style={{ ...titleStyle, margin: '0 0 4px', fontSize: 'var(--dsw-font-s-12)' }}>{group.title}</h3>
            {group.rows.map(row => (
              <div key={row.keys} style={rowStyle}>
                <span style={keysStyle}>{row.keys}</span>
                <span style={actionStyle}>{row.action}</span>
              </div>
            ))}
          </section>
        ))}
        <button
          type="button"
          className={styles.button}
          aria-label="关闭快捷键说明"
          onClick={onClose}
        >
          关闭
        </button>
      </div>
    </div>
  )
}
