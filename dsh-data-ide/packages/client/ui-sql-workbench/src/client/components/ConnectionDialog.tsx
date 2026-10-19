import { useState } from 'react'
import * as React from 'react'

import type { ReactElement } from 'react'

import { type Dbms } from '../../datasource/model.ts'
import type { ConnectionDraft } from '../api.ts'
import { classes as styles } from '../styles.ts'

export interface ConnectionDialogProps {
  readonly draft: ConnectionDraft
  readonly title: string
  /** Field-level error from the last save attempt, if any. */
  readonly error?: { readonly field: string; readonly reason: string }
  readonly busy?: boolean
  readonly onChange: (draft: ConnectionDraft) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
  readonly onDelete?: () => void
}

const FIELDS = [
  { key: 'name', label: '名称', placeholder: 'doris.shcell.com' },
  { key: 'host', label: '主机', placeholder: 'doris.shcell.com' },
  { key: 'port', label: '端口', placeholder: '9030' },
  { key: 'database', label: '数据库', placeholder: '可选' },
  { key: 'username', label: '用户名', placeholder: 'wanyexin' },
] as const

/** Connection form (docs/03 §4.2). */
export function ConnectionDialog(props: ConnectionDialogProps): ReactElement {
  const [sessionOnly, setSessionOnly] = useState(props.draft.secretStorage === 'session')
  const fieldError = (key: string): string | undefined =>
    props.error?.field === key ? props.error.reason : undefined

  const set = (patch: Partial<ConnectionDraft>): void => {
    props.onChange({ ...props.draft, ...patch })
  }

  return (
    <div className={styles.dialogBackdrop} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={props.title}>
        <h2 className={styles.dialogTitle}>{props.title}</h2>

        <div className={styles.fieldGrid}>
          {FIELDS.map(field => (
            <label key={field.key} className={styles.field}>
              <span className={styles.fieldLabel}>{field.label}</span>
              <input
                className={styles.input}
                value={String(props.draft[field.key] ?? '')}
                placeholder={field.placeholder}
                aria-invalid={fieldError(field.key) !== undefined}
                onChange={event => {
                  const raw = event.target.value
                  set(field.key === 'port' ? { port: Number(raw) } : ({ [field.key]: raw } as Partial<ConnectionDraft>))
                }}
              />
              {fieldError(field.key) === undefined ? null : <span className={styles.fieldError}>{fieldError(field.key)}</span>}
            </label>
          ))}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>DBMS</span>
            <select
              className={styles.input}
              value={props.draft.dbms}
              onChange={event => {
                set({ dbms: event.target.value as Dbms })
              }}
            >
              <option value="doris">Doris</option>
              <option value="mysql">MySQL</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>密码</span>
            <input
              className={styles.input}
              type="password"
              value={props.draft.password ?? ''}
              onChange={event => {
                set({ password: event.target.value })
              }}
            />
          </label>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={sessionOnly}
              onChange={event => {
                setSessionOnly(event.target.checked)
                set({ secretStorage: event.target.checked ? 'session' : 'master_key' })
              }}
            />
            仅本次会话（不落盘）
          </label>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={props.draft.writeEnabled === true}
              onChange={event => {
                set({ writeEnabled: event.target.checked })
              }}
            />
            启用 writeEnabled（允许 agent 写操作）
          </label>
        </div>

        <footer className={styles.dialogActions}>
          {props.onDelete === undefined ? null : (
            <button type="button" className={styles.dangerButton} onClick={props.onDelete} disabled={props.busy === true}>
              删除
            </button>
          )}
          <button type="button" className={styles.button} onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={props.onSubmit}
            disabled={props.busy === true}
          >
            保存
          </button>
        </footer>
      </section>
    </div>
  )
}
