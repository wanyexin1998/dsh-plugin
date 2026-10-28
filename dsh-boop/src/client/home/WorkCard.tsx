import React from 'react'
import type { ProductState, TaskView } from '../../shared/mvp-contract.ts'
import { Island } from './Island.tsx'

const ACTION_LABEL = {
  view: '查看详情',
  open_session: '打开原会话',
  stop: '停止任务',
  continue: '继续处理',
  confirm: '确认收下',
  reconcile: '核对进展',
} as const

const SHORT_STATE: Record<ProductState, string> = {
  queued: '排队',
  waiting_target: '等待',
  dispatching: '交出',
  accepted: '已交',
  running: '进行中',
  awaiting_native_approval: '待确认',
  received_reply: '待核对',
  delivered: '已交付',
  needs_attention: '要看',
  stopping: '停下',
  stopped: '已停',
}

export function WorkCard(props: {
  task: TaskView
  layout?: 'card' | 'island'
  defaultExpanded?: boolean
  onAction: (action: TaskView['availableActions'][number], task: TaskView) => void
}): React.ReactElement {
  const task = props.task
  if (props.layout === 'island') {
    const where = `${task.target.workspaceTitle ? `${task.target.workspaceTitle} · ` : ''}${task.target.sessionTitle}`
    return (
      <Island title={task.title} status={SHORT_STATE[task.productState]} marker={task.taskId} defaultExpanded={props.defaultExpanded}>
        <div className="boop-muted">{where}</div>
        <div className="boop-muted">{task.statusText}</div>
        {task.latestResult ? <p className="boop-island-summary">{task.latestResult.summary}</p> : null}
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
      </Island>
    )
  }
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
