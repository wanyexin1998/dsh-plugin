import * as React from 'react'

import type { ErrorInfo, ReactNode } from 'react'

import { classes as styles } from '../styles.ts'

interface PanelBoundaryProps {
  readonly children: ReactNode
}

interface PanelBoundaryState {
  readonly error: Error | null
}

/**
 * Keeps a render crash inside this tab instead of showing an empty pane.
 *
 * The right column renders the seat's component directly, so an exception in
 * the panel would unmount the subtree and leave the pane blank with the error
 * only in the console. This turns that into readable text on screen.
 */
export class PanelBoundary extends React.Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PanelBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the console trail: the boundary is a floor, not a replacement.
    console.error('dsh-data-ide: 面板渲染失败', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <section className={styles.sqlWorkbenchPanel} data-sql-workbench="" data-phase="crashed">
        <div className={styles.placeholder}>
          <span className={styles.sqlWorkbenchTitle}>SQL 工作台渲染失败</span>
          <span className={styles.sqlWorkbenchHint}>{error.message}</span>
          <span className={styles.sqlWorkbenchHint}>详情见浏览器 Console；重新加载页面可复位。</span>
        </div>
      </section>
    )
  }
}
