/**
 * Fill-in form for named SQL parameters (SQL-403).
 *
 * Props-driven and keyboard-first: the first input is focused, Enter submits,
 * Esc cancels. The panel owns the pending statement and the substitution.
 */

import * as React from 'react'

import type { ReactElement } from 'react'

import { classes as styles } from '../styles.ts'

export interface ParamsFormProps {
  readonly open: boolean
  /** Parameter names, in first-appearance order. */
  readonly names: readonly string[]
  readonly onSubmit: (values: Readonly<Record<string, string>>) => void
  readonly onCancel: () => void
}

const sheetStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  alignSelf: 'flex-start',
  maxHeight: '70%',
  margin: '8vh auto 0',
  padding: '12px',
  overflow: 'auto',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 'var(--sql-radius, 10px)',
  boxShadow: '0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'var(--dsw-font-s-13)',
  fontWeight: 600,
}

const hintStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 'var(--dsw-font-s-11)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
}

const nameStyle: React.CSSProperties = {
  minWidth: '90px',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
}

const inputStyle: React.CSSProperties = {
  flex: '1 1 auto',
  height: '26px',
  padding: '0 6px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '6px',
  font: 'inherit',
}

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  justifyContent: 'flex-end',
}

/**
 * One parameter form occurrence.
 *
 * @param props - Visibility, names and the submit/cancel callbacks.
 */
export function ParamsForm({ open, names, onSubmit, onCancel }: ParamsFormProps): ReactElement | null {
  const [values, setValues] = React.useState<Readonly<Record<string, string>>>({})

  React.useEffect(() => {
    if (open) setValues({})
  }, [open])

  if (!open) return null

  const submit = (): void => {
    onSubmit(values)
  }

  return (
    <div
      className={styles.historyOverlay}
      data-params-overlay=""
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <form
        role="dialog"
        aria-label="参数"
        data-params-form=""
        style={sheetStyle}
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        <h2 style={titleStyle}>填写参数</h2>
        <p style={hintStyle}>数字与 NULL 原样执行，其余按字符串加引号；Enter 执行，Esc 取消。</p>
        {names.map((name, index) => (
          <label key={name} style={rowStyle}>
            <span style={nameStyle}>:{name}</span>
            <input
              autoFocus={index === 0}
              aria-label={`参数 ${name}`}
              placeholder="值"
              value={values[name] ?? ''}
              style={inputStyle}
              onChange={event => {
                const next = event.target.value
                setValues(current => ({ ...current, [name]: next }))
              }}
            />
          </label>
        ))}
        <div style={actionsStyle}>
          <button type="button" className={styles.button} onClick={onCancel} aria-label="取消参数">
            取消
          </button>
          <button type="submit" className={styles.primaryButton} aria-label="执行带参数的语句">
            执行
          </button>
        </div>
      </form>
    </div>
  )
}
