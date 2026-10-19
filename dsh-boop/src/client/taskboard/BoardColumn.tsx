/**
 * BOOP taskboard column — one of the four derived projection groups.
 *
 * Source & licence: adapted from `BoardColumn.tsx` of
 * `chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142`
 * (Apache-2.0). Changes from upstream (see docs/development/taskboard-sources.md):
 *  - no `useTaskCardDragPreview`, no HTML5 drag/drop at all: cross-column drag is
 *    OFF for v1 (TB05) and there is no pointer-only path that could imply it;
 *  - the column is driven by the BOOP three-axis projection, not an upstream
 *    `TaskStatus`;
 *  - no `onCreate` (BOOP creates work through its own ledger/tools, not a card);
 *  - every action is a real button so keyboard/menu fully replaces dragging
 *    (TB08), and the column header is a collapse button with `aria-expanded`;
 *  - styles are BOOP-scoped `[data-boop-column]`, not upstream global classes.
 */
import React from 'react'
import { TaskCard, type TaskCardWriteState } from './TaskCard.tsx'
import type { MoveDirection } from './commands.ts'
import { GROUP_LABELS, type TaskDisplayGroup, type TaskboardTask } from './view-model.ts'

export interface BoardColumnProps {
  group: TaskDisplayGroup
  tasks: TaskboardTask[]
  collapsed: boolean
  filtersActive: boolean
  writes: Record<string, TaskCardWriteState | undefined>
  onToggleCollapse: (group: TaskDisplayGroup) => void
  onOpenDetail: (task: TaskboardTask) => void
  onOpenSession?: (sessionId: string) => void
  onMove: (task: TaskboardTask, direction: MoveDirection, groupTaskIds: string[]) => void
}

export function BoardColumn({
  group,
  tasks,
  collapsed,
  filtersActive,
  writes,
  onToggleCollapse,
  onOpenDetail,
  onOpenSession,
  onMove,
}: BoardColumnProps): React.ReactElement {
  const label = GROUP_LABELS[group]
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const groupTaskIds = tasks.map((task) => task.taskId)
  const bodyId = `boop-taskboard-column-${group}-body`

  /** Roving focus inside this column: keyboard is a first-class navigation path. */
  function navigate(task: TaskboardTask, direction: 'up' | 'down'): void {
    const index = groupTaskIds.indexOf(task.taskId)
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    const nextId = nextIndex >= 0 && nextIndex < groupTaskIds.length ? groupTaskIds[nextIndex] : undefined
    if (!nextId) return
    const body = bodyRef.current
    if (!body) return
    for (const node of body.querySelectorAll<HTMLElement>('[data-boop-task-card]')) {
      if (node.getAttribute('data-task-id') === nextId) {
        node.focus()
        return
      }
    }
  }

  return (
    <section data-boop-column="" data-boop-group={group} aria-labelledby={`${bodyId}-header`}>
      <button
        type="button"
        data-boop-column-header=""
        id={`${bodyId}-header`}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => onToggleCollapse(group)}
      >
        <span>{label}</span>
        <span data-boop-column-count="">{tasks.length}</span>
      </button>
      {!collapsed && (
        <div data-boop-column-body="" id={bodyId} ref={bodyRef} role="list" aria-label={`${label}任务`}>
          {tasks.map((task, index) => (
            <div role="listitem" key={task.taskId}>
              <TaskCard
                task={task}
                group={group}
                groupTaskIds={groupTaskIds}
                index={index}
                write={writes[task.taskId] ?? null}
                onOpenDetail={onOpenDetail}
                onOpenSession={onOpenSession}
                onMove={(movedTask, direction) => onMove(movedTask, direction, groupTaskIds)}
                onNavigate={navigate}
              />
            </div>
          ))}
          {tasks.length === 0 && (
            <div data-boop-column-empty="">
              {filtersActive ? '当前筛选下没有匹配任务' : `没有${label}任务（宿主可读，真实为空）`}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
