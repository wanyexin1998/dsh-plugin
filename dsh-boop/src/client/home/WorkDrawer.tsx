import React from 'react'
import type { TaskView } from '../../shared/mvp-contract.ts'
import { WorkCard } from './WorkCard.tsx'

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
  onClose: () => void
  onAction: (action: TaskView['availableActions'][number], task: TaskView) => void
}): React.ReactElement {
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]['id']>('attention')
  const closeRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    closeRef.current?.focus()
  }, [])
  const visible = props.tasks.filter((task) => matches(task, filter))
  return (
    <aside className="boop-drawer" aria-label="工作">
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
      {visible.length === 0 ? <p className="boop-muted">你交代给我的事情会出现在这里。</p> : null}
      <div className="boop-summary">
        {visible.map((task) => <WorkCard key={task.taskId} task={task} onAction={props.onAction} />)}
      </div>
    </aside>
  )
}
