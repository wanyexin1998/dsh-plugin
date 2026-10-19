/**
 * BOOP taskboard card — trimmed layout only (E04-02 client half).
 *
 * Source & licence: layout/density informed by `TaskCard.tsx` of
 * `chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142`
 * (Apache-2.0). It is NOT a copy: the Codex `api`/`actors`/`taskConversations`
 * imports, the Cover/Markdown pipeline (`remark-gfm`/`remark-parse`/`unified`)
 * and every attachment resolver were removed. All task text is rendered as
 * plain React text (no `dangerouslySetInnerHTML`, no Markdown), which is the
 * explicit TB07 stop-gap: model Markdown must go through host-authorised
 * rendering before it can ever be shown as rich text.
 *
 * Frozen rules encoded here:
 *  - no cross-column drag / no complete action that fakes acceptance (TB05);
 *  - verification and approval fields are display-only (TB04/TB09);
 *  - keyboard paths exist for every action (TB08);
 *  - write-back status is reported verbatim, never optimistically (TB05/TB06).
 */
import React from 'react'
import type { MoveDirection } from './commands.ts'
import {
  formatUpdatedAt,
  pendingReasonLabel,
  taskStatusLine,
  verificationTone,
  type TaskDisplayGroup,
  type TaskboardTask,
} from './view-model.ts'

export interface TaskCardWriteState {
  status: 'pending' | 'confirmed' | 'rejected' | 'error'
  reason: string
}

export interface TaskCardProps {
  task: TaskboardTask
  group: TaskDisplayGroup
  groupTaskIds: string[]
  index: number
  write: TaskCardWriteState | null
  onOpenDetail: (task: TaskboardTask) => void
  onOpenSession?: (sessionId: string) => void
  onMove: (task: TaskboardTask, direction: MoveDirection) => void
  onNavigate: (task: TaskboardTask, direction: 'up' | 'down') => void
}

/** Plain-text card body; every user/model string is escaped by React itself. */
export function TaskCard({
  task,
  group,
  groupTaskIds,
  index,
  write,
  onOpenDetail,
  onOpenSession,
  onMove,
  onNavigate,
}: TaskCardProps): React.ReactElement {
  const [titleExpanded, setTitleExpanded] = React.useState(false)
  const titleId = `boop-task-${task.taskId}-title`
  const tone = verificationTone(task.lifecycle, task.verification)
  const updated = formatUpdatedAt(task.updatedAt)
  const targets = task.targets ?? []
  const canMoveUp = index > 0
  const canMoveDown = index < groupTaskIds.length - 1

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      onNavigate(task, 'down')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      onNavigate(task, 'up')
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpenDetail(task)
    }
  }

  return (
    <article
      data-boop-task-card=""
      data-boop-group={group}
      data-task-id={task.taskId}
      data-task-version={task.taskVersion}
      data-boop-lifecycle={task.lifecycle}
      data-boop-verification={task.verification}
      data-boop-authorization={task.authorization}
      data-boop-expanded={titleExpanded ? 'true' : undefined}
      tabIndex={0}
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
    >
      <div data-boop-task-meta="">
        <span>ID: {task.taskId.slice(0, 24)}</span>
        {task.taskVersion > 0 && <span>版本 {task.taskVersion}</span>}
        {updated && <span>更新 {updated}</span>}
        {task.workspaceId && <span>工作区 {task.workspaceId}</span>}
      </div>

      <h3 id={titleId} data-boop-task-title="" title={task.title}>
        {task.title}
      </h3>

      <div data-boop-task-status="" data-tone={tone}>
        {taskStatusLine(task)}
      </div>

      {task.pendingReason != null && (
        <div data-boop-task-pending="">
          待决原因：{pendingReasonLabel(task.pendingReason) ?? task.pendingReason}
        </div>
      )}

      <div data-boop-task-actions="">
        <button
          type="button"
          data-boop-task-open=""
          aria-label={`查看任务详情：${task.title}`}
          onClick={() => onOpenDetail(task)}
        >
          详情
        </button>
        <button
          type="button"
          data-boop-task-open=""
          aria-label={titleExpanded ? '收起完整标题' : '展开完整标题'}
          aria-expanded={titleExpanded}
          onClick={() => setTitleExpanded((current) => !current)}
        >
          {titleExpanded ? '收起标题' : '完整标题'}
        </button>
        <button
          type="button"
          data-boop-task-move="up"
          aria-label={`在本列内上移：${task.title}`}
          disabled={!canMoveUp}
          onClick={() => onMove(task, 'up')}
        >
          上移
        </button>
        <button
          type="button"
          data-boop-task-move="down"
          aria-label={`在本列内下移：${task.title}`}
          disabled={!canMoveDown}
          onClick={() => onMove(task, 'down')}
        >
          下移
        </button>
        {targets.length > 0 && onOpenSession && (
          <button
            type="button"
            data-boop-task-session="open"
            aria-label={`打开相关会话（共 ${targets.length} 个）：${task.title}`}
            onClick={() => {
              // Multiple targets are NOT guessed: the exact ids are listed in
              // the detail drawer, and only the first is opened from the card.
              const first = targets[0]
              if (first) onOpenSession(first.sessionId)
            }}
          >
            打开会话{targets.length > 1 ? `（${targets.length}）` : ''}
          </button>
        )}
      </div>

      {write && (
        <div
          data-boop-task-write=""
          data-state={write.status}
          role={write.status === 'rejected' || write.status === 'error' ? 'alert' : 'status'}
        >
          {write.status === 'pending' && `优先级写回：待服务端确认…`}
          {write.status === 'confirmed' && `优先级写回：${write.reason}`}
          {(write.status === 'rejected' || write.status === 'error') && `优先级写回被拒绝：${write.reason}`}
        </div>
      )}
    </article>
  )
}
