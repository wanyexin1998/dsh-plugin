import React from 'react'
import type { TaskView } from '../../shared/mvp-contract.ts'
import { WorkCard } from './WorkCard.tsx'

function TaskDetail(props: { task: TaskView }): React.ReactElement {
  const task = props.task
  const result = task.latestResult
  return (
    <section className="boop-card" data-boop-detail={task.taskId}>
      <h3>{task.title}</h3>
      <p className="boop-muted">第 {task.taskVersion} 版 · {task.statusText}</p>
      <p className="boop-muted">验证：{task.verification.summary}</p>
      <p className="boop-muted">确认：{task.confirmation.state === 'accepted' ? '你已确认收下' : task.confirmation.state === 'pending' ? '还没有确认收下' : '现在不能确认'}</p>
      {result ? <p>{result.summary}</p> : <p className="boop-muted">还没有带回结果。</p>}
      {result && result.artifacts.length > 0 ? (
        <ul>{result.artifacts.map((artifact) => <li key={`${artifact.kind}-${artifact.label}`}>{artifact.label}</li>)}</ul>
      ) : <p className="boop-muted">没有单独列出的产物。</p>}
      {task.verification.checks.length > 0 ? (
        <ul>
          {task.verification.checks.map((check) => (
            <li key={check.criterion}>{check.criterion}：{check.state === 'passed' ? '通过' : check.state === 'failed' ? '没通过' : '还不能判断'}</li>
          ))}
        </ul>
      ) : null}
      {result && result.missing.length > 0 ? <p className="boop-muted">还缺：{result.missing.join('、')}</p> : null}
    </section>
  )
}

const FILTERS = [
  { id: 'attention', label: '需要处理' },
  { id: 'active', label: '进行中' },
  { id: 'done', label: '已交付' },
] as const

function matches(task: TaskView, filter: (typeof FILTERS)[number]['id']): boolean {
  if (filter === 'attention') return ['needs_attention', 'awaiting_native_approval', 'delivered', 'received_reply'].includes(task.productState)
  if (filter === 'active') return ['queued', 'waiting_target', 'dispatching', 'accepted', 'running', 'stopping'].includes(task.productState)
  return task.productState === 'stopped' || task.confirmation.state === 'accepted'
}

export function WorkDrawer(props: {
  tasks: TaskView[]
  selectedTaskId: string | null
  onClose: () => void
  onAction: (action: TaskView['availableActions'][number], task: TaskView) => void
}): React.ReactElement {
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]['id']>('attention')
  const closeRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
  const visible = props.tasks.filter((task) => matches(task, filter))
  const selected = props.tasks.find((task) => task.taskId === props.selectedTaskId) ?? null
  return (
    <aside className="boop-drawer" role="dialog" aria-label="工作">
      <div className="boop-card-title">
        <h2>我交代的工作</h2>
        <button ref={closeRef} type="button" className="boop-text-button" onClick={props.onClose}>关闭</button>
      </div>
      <div className="boop-filter" role="tablist">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" className="boop-text-button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {selected ? <TaskDetail task={selected} /> : null}
      {visible.length === 0 ? <p className="boop-muted">你交代给我的事情会出现在这里。</p> : null}
      <div className="boop-summary">
        {visible.map((task) => <WorkCard key={task.taskId} task={task} onAction={props.onAction} />)}
      </div>
    </aside>
  )
}
