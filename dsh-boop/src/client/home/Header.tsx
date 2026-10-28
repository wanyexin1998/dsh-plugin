import React from 'react'
import { BoopMark } from '../brand.tsx'

export function BoopHeader(props: {
  status: string
  workOpen: boolean
  settingsOpen: boolean
  onWork: () => void
  onSettings: () => void
  workButtonRef?: React.Ref<HTMLButtonElement>
}): React.ReactElement {
  return (
    <header className="boop-header">
      <div className="boop-header-id">
        <span className="boop-avatar"><BoopMark size={32} label="波波" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="boop-name">BOBO · 波波</div>
          <div className="boop-status">{props.status}</div>
        </div>
      </div>
      <div className="boop-header-actions">
        <button ref={props.workButtonRef} type="button" className="boop-text-button" aria-pressed={props.workOpen} onClick={props.onWork}>工作</button>
        <button type="button" className="boop-text-button" aria-pressed={props.settingsOpen} onClick={props.onSettings}>设置</button>
      </div>
    </header>
  )
}
