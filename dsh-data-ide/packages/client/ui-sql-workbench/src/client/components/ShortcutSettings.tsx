/**
 * Shortcut settings sheet (user requirement 1).
 *
 * Renders the editable chords and records new ones. It is deliberately dumb
 * about persistence: the panel owns `value` / `onChange` and uses
 * `loadSettings` / `saveSettings` from `shortcut-settings.ts`, so this component
 * stays testable with no storage and no host.
 *
 * Recording works on the window (capture phase): once a row is armed, the next
 * valid chord becomes that action's binding. `Escape` cancels recording instead
 * of closing the sheet; with no row armed it closes the sheet.
 */

import * as React from 'react'
import type { CSSProperties, ReactElement } from 'react'

import { DEFAULT_SHORTCUTS, SHORTCUT_GROUPS, comboFromEvent, conflictOf, withShortcut } from '../shortcut-settings.ts'
import type { ShortcutAction, ShortcutSettings } from '../shortcut-settings.ts'

export interface ShortcutSettingsProps {
  /** When false the sheet renders nothing (the panel keeps it mounted). */
  readonly open: boolean
  /** Current settings; always the panel's canonicalized value. */
  readonly value: ShortcutSettings
  /** Called with a full settings map when a row is recorded or defaults are restored. */
  readonly onChange: (next: ShortcutSettings) => void
  /** Close request (close button, Esc with no recording in progress). */
  readonly onClose: () => void
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 12,
  background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(520px, 92vw)',
  maxHeight: '78vh',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 10,
  boxShadow: '0 16px 40px -20px var(--dsw-alias-border-l2)',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 'var(--dsw-font-s-14)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
}

const titleStyle: CSSProperties = { flex: 1, fontSize: 'var(--dsw-font-s-14)' }

const iconButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  padding: '2px 4px',
  fontSize: 'var(--dsw-font-s-14)',
}

const bodyStyle: CSSProperties = { overflowY: 'auto', padding: '4px 12px 8px', minHeight: 0 }

const groupTitleStyle: CSSProperties = {
  margin: '8px 0 4px',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 'var(--dsw-font-xs-13)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 6px',
  borderRadius: 6,
}

const rowRecordingStyle: CSSProperties = {
  ...rowStyle,
  background: 'var(--dsw-alias-interactive-bg-active)',
}

const rowConflictStyle: CSSProperties = { ...rowStyle, border: '1px solid var(--dsw-alias-state-error-primary)' }

const labelStyle: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const comboStyle: CSSProperties = {
  minWidth: 112,
  textAlign: 'center',
  padding: '1px 6px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 4,
  background: 'var(--dsw-alias-markdown-code-block)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 'var(--dsw-font-xs-13)',
  whiteSpace: 'nowrap',
}

const conflictStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: 'var(--dsw-font-xs-13)',
  whiteSpace: 'nowrap',
}

const recordStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-secondary)',
  borderRadius: 4,
  padding: '1px 8px',
  cursor: 'pointer',
  fontSize: 'var(--dsw-font-xs-13)',
  whiteSpace: 'nowrap',
}

const recordActiveStyle: CSSProperties = {
  ...recordStyle,
  border: '1px solid var(--dsw-alias-state-business-primary)',
  color: 'var(--dsw-alias-state-business-primary)',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderTop: '1px solid var(--dsw-alias-border-l1)',
}

const hintStyle: CSSProperties = { flex: 1, color: 'var(--dsw-alias-label-tertiary)', fontSize: 'var(--dsw-font-xs-13)' }

/**
 * Render the shortcut settings sheet.
 *
 * @param props - see {@link ShortcutSettingsProps}.
 */
export function ShortcutSettings({ open, value, onChange, onClose }: ShortcutSettingsProps): ReactElement | null {
  const [recording, setRecording] = React.useState<ShortcutAction | null>(null)

  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (recording === null) {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
        return
      }
      // While a row is armed every key belongs to the recorder, so the editor
      // and the panel never see the chord that is becoming a binding.
      // `preventDefault` also stops Enter/Tab from activating the focused record
      // button or moving focus: both are valid bindings (accept-completion),
      // never "confirm" gestures while recording.
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = comboFromEvent(event)
      // Modifier-only presses and bare typing keys cannot be shortcuts; keep waiting.
      if (combo === null) return
      onChange(withShortcut(value, recording, combo))
      setRecording(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, recording, value, onChange, onClose])

  if (!open) return null

  const conflicts = new Set(conflictOf(value))
  const close = (): void => {
    setRecording(null)
    onClose()
  }
  const restoreDefaults = (): void => {
    setRecording(null)
    onChange(DEFAULT_SHORTCUTS)
  }

  return (
    <div style={overlayStyle} data-sql-shortcut-settings="" role="presentation">
      <div style={cardStyle} role="dialog" aria-modal="true" aria-label="快捷键设置" data-sql-shortcut-card="">
        <div style={headerStyle}>
          <span style={titleStyle}>快捷键设置</span>
          <button type="button" style={iconButtonStyle} aria-label="关闭快捷键设置" title="关闭（Esc）" onClick={close}>
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.id} data-sql-shortcut-group={group.id}>
              <div style={groupTitleStyle}>{group.title}</div>
              {group.actions.map(meta => {
                const isRecording = recording === meta.action
                const conflict = conflicts.has(meta.action)
                const row = isRecording ? rowRecordingStyle : conflict ? rowConflictStyle : rowStyle
                return (
                  <div key={meta.action} style={row} data-sql-shortcut-row={meta.action} data-conflict={conflict ? 'true' : 'false'}>
                    <span style={labelStyle}>{meta.label}</span>
                    <span style={comboStyle} data-sql-shortcut-combo="">
                      {isRecording ? '按下新键…' : value[meta.action]}
                    </span>
                    {conflict ? (
                      <span style={conflictStyle} data-sql-shortcut-conflict="" title="该组合键已被其他动作占用">
                        冲突
                      </span>
                    ) : null}
                    <button
                      type="button"
                      style={isRecording ? recordActiveStyle : recordStyle}
                      aria-pressed={isRecording}
                      aria-label={`${isRecording ? '取消录制' : '录制'} ${meta.label}`}
                      data-sql-shortcut-record={meta.action}
                      onClick={() => {
                        setRecording(isRecording ? null : meta.action)
                      }}
                    >
                      {isRecording ? '取消录制' : '录制'}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div style={footerStyle}>
          <span style={hintStyle} data-sql-shortcut-hint="">
            {conflicts.size === 0 ? '点击「录制」后按下新组合键；Esc 取消录制' : '存在重复键位：同一组合键只会触发排在前面的动作'}
          </span>
          <button type="button" style={recordStyle} data-sql-shortcut-reset="" onClick={restoreDefaults}>
            恢复默认
          </button>
        </div>
      </div>
    </div>
  )
}
