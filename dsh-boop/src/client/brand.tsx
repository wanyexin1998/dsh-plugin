/**
 * BOOP micro brand marks (E04-01 batch 2).
 *
 * Frozen visual rules (05§03, 05§07): the daily UI uses a small identification
 * mark only — the approved 3D character stays in the board hero / about scenes,
 * never inside rows or the chat header. The 2D mark keeps the same silhouette
 * language: short rounded blue whale, pale belly, two capsule eyes, upheld tail.
 */
import React from 'react'

export interface BoopMarkProps {
  /** Square edge in pixels; 16/18/24 are the shipped sizes. */
  size?: number
  /** Decorative by default; pass a label only when it stands alone. */
  label?: string
}

export function BoopMark({ size = 18, label }: BoopMarkProps): React.ReactElement {
  return (
    <span
      data-boop-mark=""
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        {/* tail */}
        <path d="M17.2 7.1c1.5-.6 2.9-.3 3.6.6.5.7.3 1.5-.4 1.9l-1.6.9 1.7.6c.8.3 1 1.1.5 1.7-.6.8-2 1.1-3.6.5z" fill="#449BCC" />
        {/* body */}
        <path
          d="M11.4 5.4c3.9 0 6.8 2.5 6.8 5.9 0 3.6-3.1 6.4-7.1 6.4-3.7 0-6.4-2.2-6.4-5.2 0-1.6.8-3 2.1-3.8-1.1-.9-1.2-2.2-.2-2.9.6-.4 1.4-.4 2.2 0 .9-.3 1.7-.4 2.6-.4z"
          fill="#449BCC"
        />
        {/* pale belly */}
        <path d="M6.6 11.2c.5 2.7 2.7 4.4 5.8 4.4 2.3 0 4.2-1 5.2-2.6-.2 2.7-2.8 4.7-6.2 4.7-2.9 0-5-1.7-5-4.1 0-.9.1-1.7.2-2.4z" fill="#F8F7F2" />
        {/* capsule eyes */}
        <rect x="8.4" y="8.6" width="1.7" height="2.7" rx="0.85" fill="#0B2637" />
        <rect x="12.4" y="8.6" width="1.7" height="2.7" rx="0.85" fill="#0B2637" />
        {/* water drop */}
        <circle cx="16.6" cy="4.1" r="1.1" fill="#ADDDEB" />
      </svg>
    </span>
  )
}
