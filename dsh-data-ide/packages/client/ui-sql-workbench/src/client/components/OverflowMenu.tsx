import * as React from 'react'
import { createPortal } from 'react-dom'

import type { ReactElement, ReactNode } from 'react'

import { classes as styles } from '../styles.ts'

export interface MenuAnchor {
  readonly top: number
  readonly bottom: number
  readonly right: number
}

export interface MenuViewport {
  readonly width: number
  readonly height: number
}

export interface MenuBox {
  readonly top: number
  readonly left: number
  readonly maxHeight: number
}

/**
 * Place a menu in the viewport, opening upward when the strip has no room below.
 *
 * `position: fixed` plus a portal is required: the tab strip and the result grid
 * are both `overflow: hidden`, so an absolute menu never becomes clickable.
 */
export function menuBox(anchor: MenuAnchor, viewport: MenuViewport): MenuBox {
  const margin = 8
  const menuWidth = 168
  const below = viewport.height - anchor.bottom - margin
  const above = anchor.top - margin
  const upward = below < 160 && above > below
  const room = Math.max(0, upward ? above : below)
  const maxHeight = Math.min(320, Math.max(80, room))
  const top = upward ? Math.max(margin, anchor.top - maxHeight) : anchor.bottom
  let left = anchor.right - menuWidth
  if (left < margin) left = margin
  if (left + menuWidth > viewport.width - margin) left = Math.max(margin, viewport.width - margin - menuWidth)
  return { top, left, maxHeight }
}

export interface OverflowMenuProps {
  readonly label: string
  /** Accessible name when it should differ from the visible label. */
  readonly ariaLabel?: string
  readonly buttonClassName?: string
  /** Sets `data-sql-{marker}` on the button and `data-sql-{marker}-menu` on the panel. */
  readonly marker?: string
  readonly children: ReactNode
}

/**
 * A button that opens a viewport-fixed menu.
 *
 * Item buttons close the menu. Selects do not, so a format choice can be made
 * before the action button. Escape and a press outside close it too.
 */
export function OverflowMenu({ label, ariaLabel, buttonClassName, marker, children }: OverflowMenuProps): ReactElement {
  const [open, setOpen] = React.useState(false)
  const [box, setBox] = React.useState<MenuBox>({ top: 0, left: 0, maxHeight: 320 })
  const buttonRef = React.useRef<HTMLButtonElement | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = buttonRef.current
      /* v8 ignore next -- the button is mounted for the life of the menu */
      if (anchor === null) return
      const rect = anchor.getBoundingClientRect()
      setBox(menuBox(
        { top: rect.top, bottom: rect.bottom, right: rect.right },
        { width: window.innerWidth, height: window.innerHeight },
      ))
    }
    place()
    const onPointer = (event: PointerEvent): void => {
      const node = event.target
      if (node instanceof Node && (buttonRef.current?.contains(node) || menuRef.current?.contains(node))) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  const buttonAttrs = marker === undefined ? {} : { [`data-sql-${marker}`]: '' }
  const menuAttrs = marker === undefined ? {} : { [`data-sql-${marker}-menu`]: '' }

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={buttonClassName ?? styles.button}
        aria-label={ariaLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(current => !current)
        }}
        {...buttonAttrs}
      >
        {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              className={styles.anchoredMenu}
              role="menu"
              style={{ top: box.top, left: box.left, maxHeight: box.maxHeight }}
              onClick={event => {
                const target = event.target
                if (target instanceof Element && target.closest('button') !== null) setOpen(false)
              }}
              {...menuAttrs}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
