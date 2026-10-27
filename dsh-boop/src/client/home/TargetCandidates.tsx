import React from 'react'
import type { WorkCandidate } from '../../shared/mvp-contract.ts'
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
    <div className="boop-card" data-boop-candidates="">
      <strong>找到几个相关会话，你想继续哪一个？</strong>
      <div className="boop-summary" style={{ marginTop: 10 }}>
        {choice.candidates.map((candidate) => {
          const placed = props.inserted === candidate.selectionKey
          return (
            <button
              key={candidate.selectionKey}
              type="button"
              className="boop-text-button"
              disabled={placed}
              onClick={() => {
                void props.onInsert(candidate).then((applied) => {
                  setNote(applied ? '已放入输入框，发送后确认选择。' : '没有放进输入框，请再试一次。')
                })
              }}
            >
              <span>{candidate.title}</span>
              <span className="boop-muted">{candidate.workspaceTitle ?? '未命名工作区'} · {candidate.lastActivityAt ?? '最近活动未知'}</span>
            </button>
          )
        })}
      </div>
      {note ? <p className="boop-muted">{note}</p> : null}
    </div>
  )
}
