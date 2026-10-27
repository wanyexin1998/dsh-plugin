import React from 'react'
import type { TaskView } from '../../shared/mvp-contract.ts'

const ACTION_LABEL = {
  view: '查看详情',
  open_session: '打开原会话',
  stop: '停止任务',
  continue: '继续处理',
  confirm: '确认收下',
  reconcile: '核对进展',
} as const

export function WorkCard(props: {
  task: TaskView
  onAction: (action: TaskView['availableActions'][number], task: TaskView) => void
}): React.ReactElement {
  const task = props.task
  return (
    <article className="boop-card" data-task-id={task.taskId}>
      <div className="boop-card-title">
        <strong>{task.title}</strong>
        <span className="boop-pill">{task.statusText}</span>
      </div>
      <div className="boop-muted">{task.target.workspaceTitle ? `${task.target.workspaceTitle} · ` : ''}{task.target.sessionTitle}</div>
      {task.latestResult ? <p style={{ margin: '8px 0 0' }}>{task.latestResult.summary}</p> : null}
      {task.latestResult && task.latestResult.missing.length > 0 ? (
        <div className="boop-muted">还缺：{task.latestResult.missing.join('、')}</div>
      ) : null}
      <div className="boop-actions">
        {task.availableActions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === 'confirm' || action === 'stop' ? 'boop-primary' : 'boop-text-button'}
            onClick={() => props.onAction(action, task)}
          >
            {ACTION_LABEL[action]}
          </button>
        ))}
      </div>
    </article>
  )
}
