import React from 'react'
import type { WorkCandidate } from '../../shared/mvp-contract.ts'
import { Island } from './Island.tsx'
import { readWorkChoice } from './read-work-choice.ts'

export { readWorkChoice }

export function TargetCandidates(props: {
  nodes: unknown
  phase: string
  inserted: string | null
  onInsert: (candidate: WorkCandidate) => Promise<boolean>
}): React.ReactElement | null {
  const choice = readWorkChoice(props.nodes)
  const [note, setNote] = React.useState<string | null>(null)
  if (!choice || props.phase !== 'plain') return null
  return (
    <div className="boop-islands" data-boop-candidates="">
      <Island title="相关会话" status={String(choice.candidates.length)}>
        {choice.candidates.map((candidate) => {
          const placed = props.inserted === candidate.selectionKey
          return (
            <button
              key={candidate.selectionKey}
              type="button"
              className="boop-island-choice"
              disabled={placed}
              onClick={() => {
                void props.onInsert(candidate).then((applied) => {
                  setNote(applied ? '已放入输入框，发送后确认选择。' : '没有放进输入框，请再试一次。')
                })
              }}
            >
              <span className="boop-island-title">{candidate.title}</span>
              <span className="boop-muted">{candidate.workspaceTitle ?? '未命名工作区'}</span>
            </button>
          )
        })}
        {note ? <p className="boop-muted">{note}</p> : null}
      </Island>
    </div>
  )
}
