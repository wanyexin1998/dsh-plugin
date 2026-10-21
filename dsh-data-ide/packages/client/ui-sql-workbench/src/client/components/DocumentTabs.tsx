import * as React from 'react'

import type { ReactElement } from 'react'

import { connectionColor, isDirty } from '../state/documents.ts'
import type { DocumentTab } from '../state/documents.ts'
import { classes as styles } from '../styles.ts'

export interface DocumentTabsProps {
  readonly tabs: readonly DocumentTab[]
  readonly activeId: string
  /** Connection name for the caveat line, keyed by id (undefined when unknown). */
  readonly connectionNames: Readonly<Record<string, string>>
  /** Closed agent consoles, reopenable from the strip (docs/10 §14). */
  readonly archived?: readonly DocumentTab[]
  readonly onRestore?: (id: string) => void
  /**
   * Object-browser state. The toggle lives in this strip because collapsing must
   * not reserve a gutter: a rail would still cost 22px + the sash, and on dsh's
   * ~500px sidebar that is exactly what squeezed the editor.
   */
  readonly objectsOpen?: boolean
  readonly onToggleObjects?: () => void
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onCreate: () => void
  readonly canCreate: boolean
}

const COLOR_CLASSES = [styles.tabColor0, styles.tabColor1, styles.tabColor2, styles.tabColor3] as const

/**
 * Console tabs above the editor.
 *
 * Each tab carries the colour of the connection it was opened on and a `*` once
 * its SQL drifts from what was last run — the two cues DataGrip's console strip
 * gives you (`console_17 [doris.shcell.com]`, `console [zanmal-test] *`).
 */
export function DocumentTabs({
  tabs,
  activeId,
  connectionNames,
  archived,
  onRestore,
  objectsOpen,
  onToggleObjects,
  onSelect,
  onClose,
  onCreate,
  canCreate,
}: DocumentTabsProps): ReactElement {
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const closed = archived ?? []

  return (
    <div className={styles.documentTabs} data-sql-documents="">
      {onToggleObjects === undefined ? null : (
        <button
          type="button"
          className={styles.documentTreeToggle}
          aria-label={objectsOpen === true ? '收起对象树' : '展开对象树'}
          aria-expanded={objectsOpen === true}
          title={objectsOpen === true ? '收起对象树' : '展开对象树'}
          data-sql-tree-toggle=""
          onClick={onToggleObjects}
        >
          {objectsOpen === true ? '«' : '»'}
        </button>
      )}
      {/* Only consoles are tabs; the toggle, `+` and history are ordinary
          controls and must not sit inside the tablist. `display: contents`
          keeps them all in one flex row. */}
      <div className={styles.documentTabsList} role="tablist" aria-label="查询标签">
      {tabs.map(tab => {
        const active = tab.id === activeId
        const name = tab.connId === null ? '未连接' : connectionNames[tab.connId] ?? '未连接'
        return (
          <div
            key={tab.id}
            className={active ? styles.documentTabActive : styles.documentTab}
            role="tab"
            aria-selected={active}
            onClick={() => {
              onSelect(tab.id)
            }}
          >
            <span className={COLOR_CLASSES[connectionColor(tab.connId)]} aria-hidden="true" />
            <button
              type="button"
              className={styles.documentTabButton}
              title={`${name}${isDirty(tab) ? '（未执行）' : ''}`}
              onClick={event => {
                // The tab row also selects; do not fire twice.
                event.stopPropagation()
                onSelect(tab.id)
              }}
            >
              {tab.title}
              {tab.unread === true ? (
                <span className={styles.documentDirty} aria-label="有新结果" title="有新结果">
                  {' '}●
                </span>
              ) : null}
              {isDirty(tab) ? <span className={styles.documentDirty}> *</span> : null}
            </button>
            <button
              type="button"
              className={styles.documentTabClose}
              aria-label={`关闭 ${tab.title}`}
              onClick={event => {
                // Closing must not also select the tab being removed.
                event.stopPropagation()
                onClose(tab.id)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      </div>
      <button
        type="button"
        className={styles.documentTabAdd}
        aria-label="新建查询标签"
        disabled={!canCreate}
        onClick={onCreate}
      >
        +
      </button>
      {closed.length === 0 ? null : (
        <div className={styles.agentHistory}>
          <button
            type="button"
            className={styles.agentHistoryButton}
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            data-sql-agent-history=""
            onClick={() => {
              setHistoryOpen(open => !open)
            }}
          >
            AI 历史 {closed.length}
          </button>
          {historyOpen ? (
            <div className={styles.agentHistoryMenu} role="menu" data-sql-agent-history-menu="">
              {closed.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  className={styles.agentHistoryItem}
                  title={tab.title}
                  onClick={() => {
                    setHistoryOpen(false)
                    onRestore?.(tab.id)
                  }}
                >
                  {tab.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
