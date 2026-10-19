/**
 * BOOP taskboard list view — the same view model as the board, never a second
 * task state (E04-02 client half).
 *
 * Source & licence: selectively adapted from `IssueListView.tsx` of
 * `chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142`
 * (Apache-2.0). Changes from upstream (see docs/development/taskboard-sources.md):
 *  - rows are read-only: no inline priority/assignee/due-date/status writers and
 *    no conversation menu (those were Codex API writes and are forbidden here);
 *  - groups are BOOP's four derived projection groups, collapsed by default for
 *    the two "closed" sides of the board (待开始 / 已结束), all keyboard toggles;
 *  - the row uses `role="button"` + Enter/Space and roving Arrow keys, so the
 *    whole list is reachable without a pointer (TB08);
 *  - styles are BOOP-scoped `[data-boop-list-*]`.
 */
import React from 'react'
import {
  GROUP_LABELS,
  GROUP_ORDER,
  formatUpdatedAt,
  taskStatusLine,
  verificationTone,
  type TaskDisplayGroup,
  type TaskboardTask,
} from './view-model.ts'

export interface IssueListViewProps {
  groups: Record<TaskDisplayGroup, TaskboardTask[]>
  filtersActive: boolean
  onOpenDetail: (task: TaskboardTask) => void
  onOpenSession?: (sessionId: string) => void
}

/** 已结束 is collapsed by default like upstream's done/canceled groups. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<TaskDisplayGroup> = new Set(['finished'])

export function IssueListView({
  groups,
  filtersActive,
  onOpenDetail,
  onOpenSession,
}: IssueListViewProps): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState<Set<TaskDisplayGroup>>(() => new Set(COLLAPSED_BY_DEFAULT))
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  function toggleGroup(group: TaskDisplayGroup): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  /** Roving focus across all visible rows (keyboard navigation, TB08). */
  function navigate(task: TaskboardTask, direction: 'up' | 'down'): void {
    const container = containerRef.current
    if (!container) return
    const rows = [...container.querySelectorAll<HTMLElement>('[data-boop-list-row]')]
    const index = rows.findIndex((row) => row.getAttribute('data-task-id') === task.taskId)
    const next = rows[direction === 'up' ? index - 1 : index + 1]
    next?.focus()
  }

  return (
    <div data-boop-taskboard-list="" ref={containerRef}>
      {GROUP_ORDER.map((group) => {
        const tasks = groups[group]
        const isCollapsed = collapsed.has(group)
        const bodyId = `boop-taskboard-list-${group}`
        return (
          <section data-boop-list-group="" data-boop-group={group} key={group}>
            <button
              type="button"
              data-boop-list-group-header=""
              aria-expanded={!isCollapsed}
              aria-controls={bodyId}
              onClick={() => toggleGroup(group)}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
              <span>{GROUP_LABELS[group]}</span>
              <span data-boop-column-count="">{tasks.length}</span>
            </button>
            {!isCollapsed && (
              <div id={bodyId}>
                {tasks.map((task) => (
                  <div
                    key={task.taskId}
                    data-boop-list-row=""
                    data-boop-group={group}
                    data-task-id={task.taskId}
                    role="button"
                    tabIndex={0}
                    aria-label={`查看任务详情：${task.title}`}
                    onClick={() => onOpenDetail(task)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpenDetail(task)
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        navigate(task, 'down')
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        navigate(task, 'up')
                      }
                    }}
                  >
                    <span data-boop-list-title="" title={task.title}>
                      {task.title}
                    </span>
                    <span data-boop-task-status="" data-tone={verificationTone(task.lifecycle, task.verification)}>
                      {taskStatusLine(task)}
                    </span>
                    <span data-boop-list-meta="">
                      {task.workspaceId ? `${task.workspaceId} · ` : ''}
                      {formatUpdatedAt(task.updatedAt) ?? '更新时间未知'}
                    </span>
                    {(task.targets ?? []).length > 0 && onOpenSession && (
                      <button
                        type="button"
                        data-boop-task-session="open"
                        aria-label={`打开相关会话：${task.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          const first = (task.targets ?? [])[0]
                          if (first) onOpenSession(first.sessionId)
                        }}
                      >
                        打开会话
                      </button>
                    )}
                  </div>
                ))}
                {tasks.length === 0 && (
                  <div data-boop-list-empty="">
                    {filtersActive ? '当前筛选下没有匹配任务' : `没有${GROUP_LABELS[group]}任务（宿主可读，真实为空）`}
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
