/**
 * Agent proposal review card (SQL-406).
 *
 * Props-driven on purpose: the workbench panel owns the proposal lifecycle and
 * decides what "accept" does (replace the editor document), so this component
 * only renders the line diff, keeps Escape = reject, and caps its own height so
 * a long script scrolls inside the card instead of pushing the panel around.
 *
 * Colours come from theme tokens only; the tinted rows are `color-mix` of the
 * success/error state tokens, never literal colours (AC-7).
 */

import * as React from 'react'

import type { CSSProperties, ReactElement } from 'react'

import { applyDiff, diffLines, diffSummary, type DiffLineType } from '../sql-diff.ts'
import { classes as styles } from '../styles.ts'

export interface DiffProposalProps {
  readonly open: boolean
  /** SQL currently in the editor. */
  readonly original: string
  /** SQL the agent proposes as the replacement. */
  readonly proposal: string
  /** Accept: hand the proposed SQL back to the panel. */
  readonly onAccept: (sql: string) => void
  /** Reject: dismiss without touching the editor. */
  readonly onReject: () => void
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  minHeight: 0,
  maxHeight: '100%',
  padding: '12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 'var(--sql-radius, 10px)',
  boxShadow: '0 12px 32px var(--dsw-alias-border-l1)',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  gap: '8px',
  alignItems: 'baseline',
}

const titleStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 'var(--dsw-font-s-14)',
  fontWeight: 600,
}

const addedStatStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary)',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 'var(--dsw-font-s-12)',
}

const removedStatStyle: CSSProperties = {
  ...addedStatStyle,
  color: 'var(--dsw-alias-state-error-primary)',
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 auto',
  minHeight: 0,
  maxHeight: '46vh',
  overflow: 'auto',
  padding: '4px 0',
  background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '8px',
  fontFamily: 'var(--ds-font-family-code)',
  fontSize: 'var(--dsw-font-s-12)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  padding: '0 6px',
  whiteSpace: 'pre',
}

const markerStyle: CSSProperties = {
  flex: '0 0 auto',
  width: '1ch',
  color: 'var(--dsw-alias-label-tertiary)',
  userSelect: 'none',
}

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: '8px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: '8px',
  justifyContent: 'flex-end',
}

const buttonStyle: CSSProperties = {
  height: '28px',
  padding: '0 12px',
  borderRadius: '8px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--dsw-font-s-13)',
}

const rejectButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  border: '1px solid var(--dsw-alias-border-l1)',
}

const acceptButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: 'var(--dsw-alias-bg-base)',
  background: 'var(--dsw-alias-state-business-primary)',
  border: '1px solid var(--dsw-alias-state-business-primary)',
}

/**
 * One diff row's presentation: tint only the change rows.
 *
 * @param type - row role.
 * @returns the row style.
 */
function rowStyleOf(type: DiffLineType): CSSProperties {
  if (type === 'add') {
    return {
      ...rowStyle,
      color: 'var(--dsw-alias-label-primary)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)',
      boxShadow: 'inset 2px 0 0 var(--dsw-alias-state-success-primary)',
    }
  }
  if (type === 'del') {
    return {
      ...rowStyle,
      color: 'var(--dsw-alias-label-secondary)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
      boxShadow: 'inset 2px 0 0 var(--dsw-alias-state-error-primary)',
    }
  }
  return { ...rowStyle, color: 'var(--dsw-alias-label-secondary)' }
}

/**
 * The proposal card.
 *
 * @param props - visibility, the two SQL texts and the two decisions.
 * @returns the card, or `null` while closed.
 */
export function DiffProposal({ open, original, proposal, onAccept, onReject }: DiffProposalProps): ReactElement | null {
  React.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onReject()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onReject])

  if (!open) return null

  const lines = diffLines(original, proposal)
  const summary = diffSummary(lines)

  return (
    <div className={styles.historyOverlay} data-diff-proposal-overlay="">
      <div role="dialog" aria-modal="true" aria-label="Agent 提案" data-diff-proposal="" style={cardStyle}>
        <div style={headerStyle}>
          <h2 data-diff-title="" style={titleStyle}>
            Agent 提案
          </h2>
          <span data-diff-stat-add="" style={addedStatStyle}>
            +{summary.added}
          </span>
          <span data-diff-stat-del="" style={removedStatStyle}>
            -{summary.removed}
          </span>
        </div>
        <div data-diff-body="" style={bodyStyle}>
          {lines.length === 0 ? (
            <p data-diff-empty="" style={emptyStyle}>
              SQL 没有变化。
            </p>
          ) : (
            lines.map((line, index) => (
              <div
                // Rows have no identity of their own; the index keeps duplicate lines stable.
                key={`${line.type}:${index}`}
                data-diff-line=""
                data-diff-line-type={line.type}
                style={rowStyleOf(line.type)}
              >
                <span aria-hidden="true" style={markerStyle}>
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                <span>{line.text === '' ? ' ' : line.text}</span>
              </div>
            ))
          )}
        </div>
        <div style={footerStyle}>
          <button type="button" data-diff-reject="" style={rejectButtonStyle} onClick={onReject}>
            拒绝
          </button>
          <button
            type="button"
            data-diff-accept=""
            style={acceptButtonStyle}
            onClick={() => {
              onAccept(applyDiff(lines))
            }}
          >
            接受并替换
          </button>
        </div>
      </div>
    </div>
  )
}
