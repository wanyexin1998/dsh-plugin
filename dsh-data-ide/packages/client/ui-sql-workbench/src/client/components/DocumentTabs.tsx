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
export function DocumentTabs({ tabs, activeId, connectionNames, onSelect, onClose, onCreate, canCreate }: DocumentTabsProps): ReactElement {
  return (
    <div className={styles.documentTabs} role="tablist" aria-label="查询标签" data-sql-documents="">
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
      <button
        type="button"
        className={styles.documentTabAdd}
        aria-label="新建查询标签"
        disabled={!canCreate}
        onClick={onCreate}
      >
        +
      </button>
    </div>
  )
}
