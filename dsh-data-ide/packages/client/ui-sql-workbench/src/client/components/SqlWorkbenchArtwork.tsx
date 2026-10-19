import * as React from 'react'

import type { ReactElement } from 'react'

/**
 * Glyph for the right column's guide card.
 *
 * The card is the shell's — it draws the row, the hover and the pick — so a tab
 * type supplies artwork only, sized by the card.
 */
export function SqlWorkbenchArtwork(props: { readonly size?: number; readonly className?: string }): ReactElement {
  const size = props.size ?? 26
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={props.className}
    >
      <ellipse cx="12" cy="6" rx="7.2" ry="2.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.8 6v12c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8V6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.8 12c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}
