/**
 * BOOP page inside the native right Sidebar.
 *
 * One tab type (`kind: boop`) holds the three surfaces that used to sit in the
 * conversation or on a separate panel: memory (the initialization choice),
 * the task board, and the settings facts. The host owns the column, the tab
 * chip, and expand/collapse.
 */
import React from 'react'
import { BoopInitDock } from './init.tsx'
import { BoopSettingsRow } from './settings.tsx'
import { BoopControlPanel } from './control.tsx'
import { TaskboardPanel } from './taskboard/index.tsx'
import { BoopSessionTools, type SessionToolsHost } from './session-tools.tsx'
import { useMainSessionState } from './header.tsx'
import type { BoopCall, MainSessionStore } from './main-session.ts'

const SIDE_CSS = `
[data-boop-side] {
  box-sizing: border-box;
  width: 100%;
  flex: 1 0 auto;
  min-height: max-content;
  overflow: visible;
  padding: 12px 16px 24px;
  color: #0B2637;
  background: #ffffff;
}
body[data-ds-dark-theme] [data-boop-side] {
  color: #EAF5FB;
  background: transparent;
}
[data-boop-side] h2 {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.55;
}
[data-boop-side] [data-boop-dock="init"] { margin: 0; }
[data-boop-tools] {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[data-boop-tools] .boop-tools-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
}
[data-boop-tools] .boop-tools-field > span:first-child {
  opacity: 0.66;
  letter-spacing: 0.04em;
  font-size: 11.5px;
}
[data-boop-tools] select {
  min-height: 32px;
  width: 100%;
  border: 1px solid var(--boop-line, rgba(11, 38, 55, 0.16));
  border-radius: 10px;
  background: #ffffff;
  color: inherit;
  font: inherit;
  padding: 0 10px;
}
[data-boop-tools] .boop-tools-preset { margin: 0; font-size: 13px; }
[data-boop-tools] .boop-tools-switch {
  min-height: 32px;
  align-self: start;
  padding: 0 12px;
  border: 1px solid var(--boop-line, rgba(11, 38, 55, 0.16));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
[data-boop-tools] [data-tone="bad"] { color: var(--boop-bad, #B23E3E); }
[data-boop-tools] [data-tone="warn"] { color: var(--boop-warn, #8A5A14); }
body[data-ds-dark-theme] [data-boop-tools] select {
  background: rgba(11, 38, 55, 0.86);
}
`

class SideSectionBoundary extends React.Component<{ title: string; children: React.ReactNode }, { message: string | null }> {
  state = { message: null as string | null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  render(): React.ReactNode {
    return (
      <section>
        <h2>{this.props.title}</h2>
        {this.state.message ? <p data-tone="bad">{this.state.message}</p> : this.props.children}
      </section>
    )
  }
}

export interface BoopSideTabProps {
  observer?: MainSessionStore
  call?: BoopCall
  onOpenSession?: (sessionId: string) => void
  onOpenMain?: () => void
  sessionTools?: SessionToolsHost | null
}

export function BoopSideTab({ observer, call, onOpenSession, onOpenMain, sessionTools }: BoopSideTabProps): React.ReactElement {
  const state = useMainSessionState(observer)
  React.useEffect(() => {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', 'boop/side-tab')
    style.textContent = SIDE_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  return (
    <div
      data-boop-side=""
      style={{
        boxSizing: 'border-box',
        width: '100%',
        flex: '1 0 auto',
        minHeight: 'max-content',
        overflow: 'visible',
        padding: '12px 16px 24px',
        color: '#0B2637',
      }}
    >
      <SideSectionBoundary title="会话">
        <BoopSessionTools observer={observer} host={sessionTools} />
      </SideSectionBoundary>
      <SideSectionBoundary title="记忆">
        <BoopInitDock sessionId={state?.mainSessionId ?? undefined} observer={observer} call={call} />
      </SideSectionBoundary>
      <SideSectionBoundary title="任务">
        {call ? <TaskboardPanel call={call} onOpenSession={onOpenSession ?? (() => undefined)} /> : <p>任务暂时读不到。</p>}
        {call ? <BoopControlPanel call={call} onOpenSession={onOpenSession ?? (() => undefined)} /> : null}
      </SideSectionBoundary>
      <SideSectionBoundary title="设置">
        <BoopSettingsRow observer={observer} call={call} onOpenMain={onOpenMain} />
      </SideSectionBoundary>
    </div>
  )
}
