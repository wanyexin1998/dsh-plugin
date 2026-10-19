import * as React from 'react'

import type { ReactElement, ReactNode } from 'react'

import { KEYBOARD_STEP, clampSize } from '../split.ts'
import { classes as styles } from '../styles.ts'

/**
 * One workbench panel: a card with a title strip.
 *
 * The look follows the `dsh-split` workbench (Dockview + `theme.gap`): a single
 * shared radius, no divider lines, and the gap between panels is what separates
 * them. `headless` panels (the editor) keep their own toolbar as the title strip
 * so a 444px-tall pane does not spend 26px on a second one.
 */
export interface WorkbenchPanelProps {
  /** Stable id for tests and for `data-sql-panel`. */
  readonly id: string
  readonly title?: string
  /** Right-hand hints in the title strip (counts, source, state). */
  readonly meta?: string
  readonly actions?: ReactNode
  /** Drop the title strip: the panel's own toolbar is the header. */
  readonly headless?: boolean
  readonly children: ReactNode
}

export function WorkbenchPanel({ id, title, meta, actions, headless = false, children }: WorkbenchPanelProps): ReactElement {
  return (
    <section className={styles.wbPanel} data-sql-panel={id}>
      {headless ? null : (
        <header className={styles.wbPanelHead}>
          <span className={styles.wbPanelTitle}>{title}</span>
          {meta === undefined ? null : (
            <span className={styles.wbPanelMeta} data-sql-panel-meta={id}>
              {meta}
            </span>
          )}
          {actions === undefined ? null : <span className={styles.wbPanelActions}>{actions}</span>}
        </header>
      )}
      <div className={styles.wbPanelBody}>{children}</div>
    </section>
  )
}

export interface SashProps {
  readonly orientation: 'vertical' | 'horizontal'
  /** Human label for `aria-label`, e.g. 调整对象树宽度. */
  readonly label: string
  /** Size of the pane this sash resizes, read at drag start. */
  readonly value: number
  /**
   * Limits, resolved when a drag or a key press begins.
   *
   * A function, not two numbers: the widest the rail may get depends on the
   * workspace width, which is measured from the DOM and changes with the window.
   */
  readonly bounds: () => { readonly min: number; readonly max: number }
  readonly onChange: (next: number) => void
  /** Double click: back to the default size. */
  readonly onReset: () => void
}

/**
 * The gap between two panels, which is also the handle.
 *
 * Transparent by default — the 8px of empty space *is* the separator — and only
 * paints a small grip while hovered, focused or dragged. That is what keeps the
 * layout from looking like a table of bordered boxes.
 */
export function Sash({ orientation, label, value, bounds, onChange, onReset }: SashProps): ReactElement {
  const [dragging, setDragging] = React.useState(false)

  const start = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // Pointer capture keeps the drag alive when the cursor leaves the 8px sash.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const origin = orientation === 'vertical' ? event.clientX : event.clientY
    const startValue = value
    const limits = bounds()
    const target = event.currentTarget
    setDragging(true)

    const move = (moveEvent: PointerEvent): void => {
      const position = orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY
      onChange(clampSize(startValue + (position - origin), limits.min, limits.max))
    }
    const stop = (): void => {
      setDragging(false)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', stop)
      target.removeEventListener('pointercancel', stop)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', stop)
    target.addEventListener('pointercancel', stop)
  }

  const limits = bounds()

  return (
    <div
      className={styles.wbSash}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      data-orientation={orientation}
      data-dragging={dragging ? '' : undefined}
      data-sql-splitter={orientation}
      tabIndex={0}
      onPointerDown={start}
      onDoubleClick={onReset}
      onKeyDown={event => {
        const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
        const backward = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
        if (event.key !== forward && event.key !== backward) return
        event.preventDefault()
        const step = event.key === forward ? KEYBOARD_STEP : -KEYBOARD_STEP
        onChange(clampSize(value + step, limits.min, limits.max))
      }}
    >
      <span className={styles.wbSashGrip} aria-hidden="true" />
    </div>
  )
}
