import * as React from 'react'

import type { ReactElement } from 'react'

import type { DataSource } from '../../datasource/model.ts'
import { TestStateBadge } from './TestStateBadge.tsx'
import { OverflowMenu } from './OverflowMenu.tsx'
import { classes as styles } from '../styles.ts'

export interface ConnectionBarProps {
  readonly connections: readonly DataSource[]
  readonly activeId: string | null
  readonly testingId: string | null
  readonly verdicts: Readonly<Record<string, import('../api.ts').TestResult>>
  readonly onSelect: (connId: string) => void
  readonly onTest: (connId: string) => void
  readonly onCreate: () => void
  readonly onEdit: (connId: string) => void
  /** Opens the shortcut settings sheet. */
  readonly onOpenShortcuts: () => void
}

/**
 * Connection identity for the console strip.
 *
 * The selector and the status dot stay visible. Configure / test / create /
 * shortcuts sit in a menu so a 420px rail does not grow a second toolbar.
 */
export function ConnectionBar(props: ConnectionBarProps): ReactElement {
  const active = props.connections.find(entry => entry.id === props.activeId)
  const busy = props.testingId !== null
  const verdict = active === undefined ? undefined : props.verdicts[active.id]
  const dotState = busy ? 'testing' : (verdict?.state ?? 'idle')

  return (
    <div className={styles.connectionBar} data-sql-connection="">
      <span className={styles.srOnly}>
        <TestStateBadge result={verdict} busy={busy} />
      </span>
      <span className={styles.connectionDot} data-test-state={dotState} aria-hidden="true" />
      {active?.writeEnabled === true ? <span className={styles.connectionWrite}>可写</span> : null}
      <label className={styles.srOnly} htmlFor="sql-workbench-connection">
        数据源
      </label>
      <select
        id="sql-workbench-connection"
        className={styles.select}
        value={props.activeId ?? ''}
        disabled={props.connections.length === 0}
        onChange={event => {
          props.onSelect(event.target.value)
        }}
      >
        {props.connections.length === 0 ? <option value="">未选择连接</option> : null}
        {props.connections.map(entry => (
          <option key={entry.id} value={entry.id}>
            {entry.name}（{entry.dbms}）
          </option>
        ))}
      </select>
      {props.connections.length === 0 ? (
        <button type="button" className={styles.button} onClick={props.onCreate}>
          新建
        </button>
      ) : null}
      <OverflowMenu label="连接" ariaLabel="连接操作">
          <button
            type="button"
            className={styles.button}
            disabled={active === undefined}
            onClick={() => {
              if (active !== undefined) props.onEdit(active.id)
            }}
          >
            配置
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={active === undefined || busy}
            onClick={() => {
              if (active !== undefined) props.onTest(active.id)
            }}
          >
            测试连接
          </button>
          <button type="button" className={styles.button} onClick={props.onCreate}>
            新建
          </button>
          <button
            type="button"
            className={styles.button}
            aria-label="快捷键设置"
            title="快捷键设置"
            onClick={props.onOpenShortcuts}
          >
            快捷键
          </button>
      </OverflowMenu>
    </div>
  )
}
