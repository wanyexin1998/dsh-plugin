import * as React from 'react'

import type { ReactElement } from 'react'

import type { DataSource } from '../../datasource/model.ts'
import { TestStateBadge } from './TestStateBadge.tsx'
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
}

/** Connection selector plus the test affordance (docs/03 §4.1). */
export function ConnectionBar(props: ConnectionBarProps): ReactElement {
  const active = props.connections.find(entry => entry.id === props.activeId)

  return (
    <header className={styles.connectionBar}>
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
        disabled={active === undefined || props.testingId !== null}
        onClick={() => {
          if (active !== undefined) props.onTest(active.id)
        }}
      >
        测试连接
      </button>

      <button type="button" className={styles.button} onClick={props.onCreate}>
        新建
      </button>

      <TestStateBadge result={active === undefined ? undefined : props.verdicts[active.id]} busy={props.testingId !== null} />
    </header>
  )
}
