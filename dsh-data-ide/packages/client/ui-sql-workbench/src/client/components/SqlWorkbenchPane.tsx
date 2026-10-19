import * as React from 'react'

import type { ReactElement } from 'react'

import { PanelBoundary } from './PanelBoundary.tsx'
import { SqlWorkbenchPanel, type SqlWorkbenchPanelProps } from './SqlWorkbenchPanel.tsx'

/**
 * The component the right column's body seat mounts.
 *
 * The boundary has to be an ancestor of the panel to catch its render errors, so
 * the seat registers this wrinkle rather than `SqlWorkbenchPanel` directly.
 */
export function SqlWorkbenchPane(props: SqlWorkbenchPanelProps): ReactElement {
  return (
    <PanelBoundary>
      <SqlWorkbenchPanel {...props} />
    </PanelBoundary>
  )
}
