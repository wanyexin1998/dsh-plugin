/**
 * BOOP taskboard panel (E04-02 client half) — TaskboardPanel.
 *
 * One task surface only: the four display groups are a DERIVED projection of
 * BOOP's lifecycle / authorization / verification axes served by the `boopTasks`
 * Remote namespace (contract by task-6, adapted to `src/host/tasks.ts` on
 * 2026-10-18). The panel never stores a second task status, never writes
 * verification/approval, and never presents a local view order as a committed
 * priority.
 *
 * Honesty rules encoded here (04§06–07, 06§03–08):
 *  - FE-11: unreadable plane ≠ empty list; disconnect/error have retry paths;
 *  - AT-19/FE-04: request sequence + Host `projectionSeq` + per-task
 *    `taskVersion` guards refuse to let an older response overwrite new state;
 *  - TB05: cross-column drag is closed; same-column reorder is local view order
 *    only and the gated Host write-back refusal is shown verbatim;
 *  - TB07: all task text is plain text (React-escaped); no Markdown pipeline;
 *  - TB08: board/list toggle, column collapse, row/card keyboard navigation,
 *    complete-title toggle, in-column move buttons and a detail dialog replace
 *    any pointer-only/drag-only interaction; Escape closes the dialog;
 *  - FE-09/FE-12: scoped sheet under `data-plugin-css="boop/taskboard"`,
 *    removed on unmount, dark theme follows `body[data-ds-dark-theme]`,
 *    reduced motion honoured.
 */
import React from 'react'
import { BoardColumn } from './BoardColumn.tsx'
import { IssueListView } from './IssueListView.tsx'
import type { TaskCardWriteState } from './TaskCard.tsx'
import {
  applyFilterPatch,
  buildPriorityRequest,
  clearFilters,
  fetchTaskboardCapabilities,
  fetchTaskboardDetail,
  fetchTaskboardList,
  submitPriorityChange,
  type MoveDirection,
} from './commands.ts'
import { installTaskboardStyles } from './styles.ts'
import {
  EMPTY_FILTERS,
  GROUP_ORDER,
  createRequestGuard,
  detailTask,
  filterTasks,
  formatUpdatedAt,
  hasActiveFilters,
  lifecycleLabel,
  mergeTaskVersions,
  moveWithinColumn,
  normalizeActions,
  normalizeApprovals,
  normalizeCapabilities,
  normalizeEvidence,
  normalizeListFacts,
  normalizeRevisions,
  normalizeTargetList,
  pendingReasonLabel,
  projectGroups,
  sortGroup,
  verificationLabel,
  verificationTone,
  workspaceOptions,
  type TaskDisplayGroup,
  type TaskboardCall,
  type TaskboardCapabilitiesFacts,
  type TaskboardDetailFacts,
  type TaskboardFilters,
  type TaskboardListFacts,
  type TaskboardTask,
  type TasksWriteModeFacts,
} from './view-model.ts'

export interface TaskboardPanelProps {
  call: TaskboardCall
  onOpenSession?: (sessionId: string) => void
}

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      tasks: TaskboardTask[]
      total: number
      partial: boolean
      partialReason: string | null
      hidden: number
      writeMode: TasksWriteModeFacts | null
    }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string }

type CapabilityState =
  | { kind: 'loading' }
  | { kind: 'ready'; facts: TaskboardCapabilitiesFacts }
  | { kind: 'error'; message: string }

type DetailState =
  | { kind: 'closed' }
  | { kind: 'loading'; taskId: string }
  | { kind: 'ready'; taskId: string; facts: TaskboardDetailFacts; task: TaskboardTask | null }
  | { kind: 'notfound'; taskId: string; reason: string }
  | { kind: 'unavailable'; taskId: string; reason: string }
  | { kind: 'error'; taskId: string; message: string }

type ViewMode = 'board' | 'list'

const COLLAPSED_DEFAULT: Record<TaskDisplayGroup, boolean> = {
  todo: false,
  in_progress: false,
  needs_me: false,
  finished: false,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function TaskboardPanel({ call, onOpenSession }: TaskboardPanelProps): React.ReactElement {
  const callRef = React.useRef(call)
  callRef.current = call

  // Scoped styles live exactly as long as this panel (FE-12).
  React.useEffect(() => installTaskboardStyles(), [])

  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' })
  const [capabilities, setCapabilities] = React.useState<CapabilityState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = React.useState(false)
  const [staleNotice, setStaleNotice] = React.useState<string | null>(null)
  const [versionNotice, setVersionNotice] = React.useState<string | null>(null)
  const [view, setView] = React.useState<ViewMode>('board')
  const [filters, setFilters] = React.useState<TaskboardFilters>({ ...EMPTY_FILTERS })
  const [order, setOrder] = React.useState<string[]>([])
  const [writes, setWrites] = React.useState<Record<string, TaskCardWriteState>>({})
  const [collapsed, setCollapsed] = React.useState<Record<TaskDisplayGroup, boolean>>({ ...COLLAPSED_DEFAULT })
  const [detail, setDetail] = React.useState<DetailState>({ kind: 'closed' })

  const listGuard = React.useRef(createRequestGuard())
  const detailGuard = React.useRef(createRequestGuard())
  const tasksRef = React.useRef<TaskboardTask[]>([])
  const orderRef = React.useRef<string[]>([])
  const lastProjectionSeq = React.useRef<number | null>(null)

  const applyOrder = React.useCallback((next: string[]): void => {
    orderRef.current = next
    setOrder(next)
  }, [])

  const refresh = React.useCallback(async (): Promise<void> => {
    const seq = listGuard.current.next()
    setRefreshing(true)
    let result: Awaited<ReturnType<typeof fetchTaskboardList>>
    try {
      result = await fetchTaskboardList(callRef.current)
    } catch (error) {
      if (!listGuard.current.isLatest(seq)) {
        setStaleNotice(`已丢弃一个较旧的列表响应（请求 #${seq}）：保留较新的看板状态（AT-19/FE-04）。`)
        setRefreshing(false)
        return
      }
      setLoad({ kind: 'error', message: errorMessage(error) })
      setRefreshing(false)
      return
    }
    if (!listGuard.current.isLatest(seq)) {
      // A newer request already answered: never let the older response win.
      setStaleNotice(`已丢弃一个较旧的列表响应（请求 #${seq}）：保留较新的看板状态（AT-19/FE-04）。`)
      setRefreshing(false)
      return
    }
    if (!result.ok) {
      setLoad({ kind: 'error', message: result.error ?? '任务投影读取失败' })
      setRefreshing(false)
      return
    }
    const normalized = normalizeListFacts(result.facts)
    if (!normalized.available) {
      setLoad({ kind: 'unavailable', reason: normalized.reason ?? '宿主报告任务投影不可用（未给出原因）' })
      setRefreshing(false)
      return
    }
    // The Host stamps a monotonic projection sequence; a smaller value is an
    // older projection even when it arrived on the newest request.
    if (
      normalized.projectionSeq !== null
      && lastProjectionSeq.current !== null
      && normalized.projectionSeq < lastProjectionSeq.current
    ) {
      setStaleNotice(
        `已丢弃投影序号更旧的响应（projectionSeq ${normalized.projectionSeq} < ${lastProjectionSeq.current}）：保留较新的看板状态（AT-19/FE-04）。`,
      )
      setRefreshing(false)
      return
    }
    if (normalized.projectionSeq !== null) lastProjectionSeq.current = normalized.projectionSeq
    const merged = mergeTaskVersions(tasksRef.current, normalized.tasks)
    tasksRef.current = merged.tasks
    setLoad({
      kind: 'ready',
      tasks: merged.tasks,
      total: normalized.total,
      partial: normalized.partial,
      partialReason: normalized.partialReason,
      hidden: normalized.hidden,
      writeMode: normalized.writeMode,
    })
    if (merged.droppedStale.length > 0) {
      setVersionNotice(
        `已忽略 ${merged.droppedStale.length} 张卡的旧版本数据（taskVersion 回退）：${merged.droppedStale
          .slice(0, 5)
          .join('、')}${merged.droppedStale.length > 5 ? ' 等' : ''}。没有用旧响应覆盖新状态。`,
      )
    } else {
      setVersionNotice(null)
    }
    setStaleNotice(null)
    const activeIds = new Set(merged.tasks.map((task) => task.taskId))
    applyOrder(orderRef.current.filter((taskId) => activeIds.has(taskId)))
    setRefreshing(false)
  }, [applyOrder])

  const openDetail = React.useCallback(async (task: TaskboardTask): Promise<void> => {
    const seq = detailGuard.current.next()
    setDetail({ kind: 'loading', taskId: task.taskId })
    let result: Awaited<ReturnType<typeof fetchTaskboardDetail>>
    try {
      result = await fetchTaskboardDetail(callRef.current, task.taskId)
    } catch (error) {
      if (!detailGuard.current.isLatest(seq)) return
      setDetail({ kind: 'error', taskId: task.taskId, message: errorMessage(error) })
      return
    }
    if (!detailGuard.current.isLatest(seq)) return
    if (!result.ok) {
      setDetail({ kind: 'error', taskId: task.taskId, message: result.error ?? '任务详情读取失败' })
      return
    }
    if (result.unavailable) {
      setDetail({ kind: 'unavailable', taskId: task.taskId, reason: result.reason ?? '宿主报告任务详情不可用（未给出原因）' })
      return
    }
    const facts = result.facts ?? { available: true }
    if (facts.found === false) {
      setDetail({
        kind: 'notfound',
        taskId: task.taskId,
        reason: facts.notFoundReason === 'invalid-request' ? '请求无效（缺少 taskId）' : '该数据域中不存在这个任务',
      })
      return
    }
    setDetail({ kind: 'ready', taskId: task.taskId, facts, task: detailTask(facts) })
  }, [])

  React.useEffect(() => {
    void refresh()
    let disposed = false
    void fetchTaskboardCapabilities(callRef.current).then(
      (result) => {
        if (disposed) return
        if (!result.ok) {
          setCapabilities({ kind: 'error', message: result.error ?? '任务能力读取失败' })
        } else {
          setCapabilities({ kind: 'ready', facts: result.facts ?? { available: true } })
        }
      },
      (error: unknown) => {
        if (disposed) return
        setCapabilities({ kind: 'error', message: errorMessage(error) })
      },
    )
    return () => {
      disposed = true
    }
  }, [refresh])

  // Reconnect: one honest refetch when the browser reports the network back.
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const onOnline = (): void => {
      void refresh()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [refresh])

  // Escape closes the detail dialog (keyboard path, TB08).
  React.useEffect(() => {
    if (detail.kind === 'closed') return undefined
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetail({ kind: 'closed' })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [detail.kind])

  const patchFilters = React.useCallback((patch: Parameters<typeof applyFilterPatch>[1]): void => {
    setFilters((current) => applyFilterPatch(current, patch))
  }, [])

  const moveTask = React.useCallback(
    (task: TaskboardTask, direction: MoveDirection, groupTaskIds: string[]): void => {
      const result = moveWithinColumn(orderRef.current, groupTaskIds, task.taskId, direction)
      if (!result.moved) return
      // Local view order updates immediately; it is NOT a task-state change.
      applyOrder(result.order)
      const request = buildPriorityRequest(task, direction, result.order, result.position)
      setWrites((current) => ({
        ...current,
        [task.taskId]: { status: 'pending', reason: '等待服务端确认；本地视图顺序已更新' },
      }))
      void submitPriorityChange(callRef.current, request).then((outcome) => {
        setWrites((current) => ({
          ...current,
          [task.taskId]: { status: outcome.status, reason: outcome.reason },
        }))
        if (outcome.status === 'rejected' && outcome.code === 'TASK_VERSION_CONFLICT') {
          // Server saw a newer version: re-read instead of overwriting locally.
          void refresh()
        }
      })
    },
    [applyOrder, refresh],
  )

  const toggleCollapse = React.useCallback((group: TaskDisplayGroup): void => {
    setCollapsed((current) => ({ ...current, [group]: !current[group] }))
  }, [])

  /* ── derived render data ──────────────────────────────────────────── */

  const allTasks = load.kind === 'ready' ? load.tasks : []
  const filtered = filterTasks(allTasks, filters)
  const filtersActive = hasActiveFilters(filters)
  const projected = projectGroups(filtered)
  const grouped: Record<TaskDisplayGroup, TaskboardTask[]> = {
    todo: sortGroup(projected.todo, order),
    in_progress: sortGroup(projected.in_progress, order),
    needs_me: sortGroup(projected.needs_me, order),
    finished: sortGroup(projected.finished, order),
  }
  const workspaces = workspaceOptions(allTasks)
  const capabilityFacts = capabilities.kind === 'ready' ? normalizeCapabilities(capabilities.facts) : null
  const blockedBy = capabilityFacts?.blockedBy ?? []
  const listWriteMode = load.kind === 'ready' ? load.writeMode : null
  const writeModeEnabled = capabilityFacts?.writeMode?.enabled ?? listWriteMode?.enabled ?? null
  const listTotal = load.kind === 'ready' ? load.total : 0
  const groupedCount = filtered.length

  return (
    <section className="boop-card">
      <h2>任务看板</h2>
      <div data-boop-taskboard="" data-boop-taskboard-view={view}>
        <div data-boop-taskboard-toolbar="">
          <div data-boop-taskboard-view-switch="" role="group" aria-label="看板或列表视图">
            <button
              type="button"
              aria-pressed={view === 'board'}
              onClick={() => setView('board')}
              data-boop-taskboard-action="view-board"
            >
              看板
            </button>
            <button
              type="button"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
              data-boop-taskboard-action="view-list"
            >
              列表
            </button>
          </div>
          <label>
            搜索
            <input
              type="search"
              aria-label="搜索任务名、任务ID、工作区或会话"
              placeholder="任务名 / ID / 工作区 / 会话"
              value={filters.search}
              onChange={(event) => patchFilters({ search: event.target.value })}
            />
          </label>
          <label>
            工作区
            <select
              aria-label="按工作区筛选"
              value={filters.workspaceId ?? ''}
              onChange={(event) => patchFilters({ workspaceId: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">全部工作区</option>
              {workspaces.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              aria-label="只看待我处理的任务"
              checked={filters.onlyPending}
              onChange={(event) => patchFilters({ onlyPending: event.target.checked })}
            />
            只看待我处理
          </label>
          <button
            type="button"
            data-boop-taskboard-action="refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            data-boop-taskboard-action="clear-filters"
            disabled={!filtersActive}
            onClick={() => setFilters(clearFilters())}
          >
            清除筛选
          </button>
        </div>

        <p data-boop-taskboard-note="" data-boop-taskboard-capabilities="">
          任务能力：
          {capabilities.kind === 'loading'
            ? '能力读取中'
            : capabilityFacts === null
              ? `不可用（${capabilities.kind === 'error' ? capabilities.message : '未知原因'}）`
              : capabilityFacts.available === false
                ? `不可用（${capabilityFacts.reason ?? '未给出原因'}）`
                : '可读'}
          ；本地排序：{capabilityFacts === null ? '能力未知' : capabilityFacts.canSortLocal ? '可用' : '不可用'}；
          写回优先级：
          {capabilities.kind === 'loading'
            ? '能力读取中'
            : capabilityFacts === null
              ? `能力不可用（${capabilities.kind === 'error' ? capabilities.message : '未知原因'}）`
              : capabilityFacts.canCommit
                ? `服务端允许提交（写模式 ${writeModeEnabled === true ? '开启' : '关闭'}）`
                : `服务端拒绝（canCommit=false；写模式 ${writeModeEnabled === true ? '开启' : '关闭'}${
                    blockedBy.length > 0 ? `；blockedBy: ${blockedBy.join(', ')}` : ''
                  }）`}
          。四组由任务/执行/验收三轴派生；跨列拖拽首版关闭；卡片文本按纯文本渲染（未启用 Markdown）；
          验收与审批不可由此界面修改。
        </p>

        {load.kind === 'loading' && <p data-boop-taskboard-note="">正在从宿主读取任务投影…</p>}

        {load.kind === 'error' && (
          <div data-boop-taskboard-alert="" role="alert">
            任务投影读取失败：{load.message}。没有用空列表冒充“没有任务”，也没有把它保留为成功状态。
            <div>
              <button type="button" data-boop-taskboard-action="retry" onClick={() => void refresh()}>
                重试
              </button>
            </div>
          </div>
        )}

        {load.kind === 'unavailable' && (
          <div data-boop-taskboard-alert="" role="alert">
            任务投影不可用：{load.reason}。不可用不等于“没有任务”，这里不显示任何任务卡。
            <div>
              <button type="button" data-boop-taskboard-action="retry" onClick={() => void refresh()}>
                重新连接
              </button>
            </div>
          </div>
        )}

        {staleNotice && (
          <p data-boop-taskboard-note="" data-boop-taskboard-stale="" role="status">
            {staleNotice}
          </p>
        )}
        {versionNotice && (
          <p data-boop-taskboard-note="" data-boop-taskboard-stale="" role="status">
            {versionNotice}
          </p>
        )}

        {load.kind === 'ready' && load.partial && (
          <p data-boop-taskboard-note="" data-boop-taskboard-partial="" role="status">
            部分覆盖：当前显示 {load.tasks.length} / 宿主报告 {load.total} 张任务
            {load.partialReason ? `（${load.partialReason}）` : ''}。这不是完整任务集，未显示的部分不会被当作不存在。
          </p>
        )}

        {load.kind === 'ready' && allTasks.length === 0 && !filtersActive && (
          <p data-boop-taskboard-empty="" role="status">
            宿主可读：当前没有任务（真实空状态，不是读取失败）。
          </p>
        )}

        {load.kind === 'ready' && allTasks.length > 0 && groupedCount === 0 && (
          <p data-boop-taskboard-empty="" role="status">
            当前筛选下没有匹配任务（宿主可读任务 {allTasks.length} 张；筛选只影响本地视图）。
          </p>
        )}

        {load.kind === 'ready' && groupedCount > 0 && view === 'board' && (
          <div data-boop-taskboard-board="">
            {GROUP_ORDER.map((group) => (
              <BoardColumn
                key={group}
                group={group}
                tasks={grouped[group]}
                collapsed={collapsed[group]}
                filtersActive={filtersActive}
                writes={writes}
                onToggleCollapse={toggleCollapse}
                onOpenDetail={(task) => void openDetail(task)}
                onOpenSession={onOpenSession}
                onMove={moveTask}
              />
            ))}
          </div>
        )}

        {load.kind === 'ready' && groupedCount > 0 && view === 'list' && (
          <IssueListView
            groups={grouped}
            filtersActive={filtersActive}
            onOpenDetail={(task) => void openDetail(task)}
            onOpenSession={onOpenSession}
          />
        )}

        {detail.kind !== 'closed' && (
          <TaskDetailDrawer
            state={detail}
            onClose={() => setDetail({ kind: 'closed' })}
            onRetry={(taskId) => {
              const task = allTasks.find((candidate) => candidate.taskId === taskId)
              if (task) void openDetail(task)
            }}
            onOpenSession={onOpenSession}
          />
        )}
        <p data-boop-taskboard-note="" data-boop-taskboard-listtotal="">
          最近一次读取：宿主报告总数 {listTotal}
          {load.kind === 'ready' ? `，本页 ${load.tasks.length} 张` : ''}
          {load.kind === 'ready' && load.hidden > 0 ? `，未包含 ${load.hidden} 张（见上方部分覆盖说明）` : ''}。
        </p>
      </div>
    </section>
  )
}

/* ── detail drawer: 04§07 order, plain text only ──────────────────────── */

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div data-boop-detail-row="">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}

function TaskDetailDrawer({
  state,
  onClose,
  onRetry,
  onOpenSession,
}: {
  state: DetailState
  onClose: () => void
  onRetry: (taskId: string) => void
  onOpenSession?: (sessionId: string) => void
}): React.ReactElement {
  const facts = state.kind === 'ready' ? state.facts : null
  const task = state.kind === 'ready' ? state.task : null
  const snapshot = facts?.snapshot ?? null
  const targets = normalizeTargetList(facts?.targets ?? task?.targets)
  const evidence = normalizeEvidence(facts?.evidence)
  const approvals = normalizeApprovals(facts?.approvals)
  const revisions = normalizeRevisions(facts?.revisions)
  const actions = normalizeActions(facts?.actions)
  const dependencies = facts?.dependencies ?? null
  const limitations = facts?.limitations ?? []

  return (
    <div
      data-boop-taskboard-drawer=""
      role="dialog"
      aria-modal="false"
      aria-label="任务详情"
      data-boop-detail-state={state.kind}
    >
      <div data-boop-taskboard-toolbar="">
        <strong>任务详情</strong>
        <button type="button" data-boop-taskboard-action="close-detail" aria-label="关闭任务详情" onClick={onClose}>
          关闭
        </button>
      </div>

      {state.kind === 'loading' && <p data-boop-taskboard-note="">正在读取任务详情…</p>}

      {state.kind === 'unavailable' && (
        <div data-boop-taskboard-alert="" role="alert">
          任务详情不可用：{state.reason}。没有把不可用当作空详情。
          <div>
            <button type="button" data-boop-taskboard-action="retry-detail" onClick={() => onRetry(state.taskId)}>
              重试
            </button>
          </div>
        </div>
      )}

      {state.kind === 'notfound' && (
        <div data-boop-taskboard-alert="" role="alert">
          没有找到任务 {state.taskId}：{state.reason}。列表可能已变化，请刷新后再试。
          <div>
            <button type="button" data-boop-taskboard-action="retry-detail" onClick={() => onRetry(state.taskId)}>
              重试
            </button>
          </div>
        </div>
      )}

      {state.kind === 'error' && (
        <div data-boop-taskboard-alert="" role="alert">
          任务详情读取失败：{state.message}
          <div>
            <button type="button" data-boop-taskboard-action="retry-detail" onClick={() => onRetry(state.taskId)}>
              重试
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && task === null && (
        <p data-boop-taskboard-note="">宿主返回了可读详情但没有任务对象；这里不编造任务字段。</p>
      )}

      {task && (
        <>
          <h3>{task.title}</h3>

          {/* 1. 目标与禁止项 */}
          <h4>目标与禁止项</h4>
          <p>{snapshot?.goal || task.title}</p>
          <ul data-boop-detail-criteria="">
            {(snapshot?.criteria ?? []).map((criterion, index) => (
              <li key={`criterion-${index}-${criterion.slice(0, 16)}`}>验收标准：{criterion}</li>
            ))}
            {(snapshot?.exclusions ?? []).map((exclusion, index) => (
              <li key={`exclusion-${index}-${exclusion.slice(0, 16)}`}>禁止项：{exclusion}</li>
            ))}
          </ul>
          {(snapshot?.criteria ?? []).length + (snapshot?.exclusions ?? []).length === 0 && (
            <p data-boop-taskboard-note="">该任务没有记录验收标准或禁止项。</p>
          )}

          {/* 2. 当前执行 / 验收 */}
          <h4>当前执行与验收</h4>
          <DetailRow label="任务" value={task.taskId} />
          <DetailRow label="版本" value={task.taskVersion} />
          <DetailRow label="状态" value={taskStatusLineSafe(task)} />
          <DetailRow label="生命周期" value={lifecycleLabel(task.lifecycle)} />
          <DetailRow label="验收" value={verificationLabel(task.verification)} />
          <DetailRow label="执行/授权" value={task.authorization} />
          {task.latestAction && (
            <DetailRow
              label="最近动作"
              value={`${task.latestAction.state} → ${task.latestAction.targetSessionId}（版本 ${task.latestAction.taskVersion}）`}
            />
          )}
          {task.workspaceId && <DetailRow label="工作区" value={task.workspaceId} />}
          {formatUpdatedAt(task.updatedAt) && <DetailRow label="最近更新" value={formatUpdatedAt(task.updatedAt)} />}

          {/* 3. 需要用户做什么 */}
          <h4>需要你做什么</h4>
          {task.pendingReason === null && <p data-boop-taskboard-note="">当前没有待决原因。</p>}
          {task.pendingReason !== null && (
            <p data-boop-detail-pending="">
              待决原因：{pendingReasonLabel(task.pendingReason) ?? task.pendingReason}
              {task.pendingApproval
                ? `（审批 ${task.pendingApproval.approvalId}，${
                    task.pendingApproval.valid ? '仍然有效' : `已失效：${task.pendingApproval.invalidReason ?? '未知原因'}`
                  }）`
                : ''}
            </p>
          )}

          {/* 4. 相关 Session */}
          <h4>相关 Session</h4>
          {targets.length === 0 && <p data-boop-taskboard-note="">任务没有记录相关 Session。</p>}
          {targets.length > 0 && (
            <ul>
              {targets.map((target) => (
                <li key={target.sessionId}>
                  {target.title ?? target.role ?? '会话'}（{target.sessionId}）
                  {onOpenSession ? (
                    <button
                      type="button"
                      data-boop-taskboard-action="open-session"
                      aria-label={`打开会话 ${target.sessionId}`}
                      onClick={() => onOpenSession(target.sessionId)}
                    >
                      打开
                    </button>
                  ) : (
                    <span data-boop-taskboard-note="">（宿主原生导航不可用）</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* 5. 交付证据 */}
          <h4>交付证据</h4>
          {evidence.length === 0 && <p data-boop-taskboard-note="">没有可读证据条目。</p>}
          {evidence.length > 0 && (
            <ul data-boop-detail-evidence="">
              {evidence.map((row, index) => (
                <li key={`${index}-${row.label}`}>
                  {row.label}
                  {row.detail ? ` · ${row.detail}` : ''}
                </li>
              ))}
            </ul>
          )}

          {/* 6. 审批 */}
          <h4>审批</h4>
          {approvals.length === 0 && <p data-boop-taskboard-note="">没有关联审批。</p>}
          {approvals.length > 0 && (
            <ul data-boop-detail-approvals="">
              {approvals.map((row) => (
                <li key={row.approvalId}>
                  {row.state}
                  {row.taskVersion !== null ? `（任务版本 ${row.taskVersion}）` : ''} · {row.valid ? '有效' : `失效：${row.reason ?? '未知原因'}`}
                </li>
              ))}
            </ul>
          )}

          {/* 7. 简化时间线 */}
          <h4>简化时间线</h4>
          {actions.length === 0 && <p data-boop-taskboard-note="">没有派发/执行时间线条目。</p>}
          {actions.length > 0 && (
            <ul data-boop-detail-actions="">
              {actions.map((row) => (
                <li key={row.actionId}>
                  {row.updatedAt ? formatUpdatedAt(row.updatedAt) ?? row.updatedAt : '时间未知'} · {row.state}
                  {row.targetSessionId ? ` · ${row.targetSessionId}` : ''}
                </li>
              ))}
            </ul>
          )}
          {revisions.length > 0 && (
            <ul data-boop-detail-revisions="">
              {revisions.map((row, index) => (
                <li key={`${index}-${row.taskVersion ?? 'v'}`}>
                  {row.taskVersion !== null ? `v${row.taskVersion} · ` : ''}
                  {row.summary}
                </li>
              ))}
            </ul>
          )}

          {dependencies && dependencies.count > 0 && (
            <>
              <h4>依赖</h4>
              <p>
                {dependencies.count} 个依赖
                {dependencies.truncated ? '（只显示前 50 个）' : ''}
              </p>
            </>
          )}

          {limitations.length > 0 && (
            <p data-boop-taskboard-note="" data-boop-detail-limitations="">
              本次详情限制：{limitations.join('；')}。
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** Local alias to avoid a second import block; the real helper lives in the view model. */
function taskStatusLineSafe(task: TaskboardTask): string {
  return task.statusLine ?? `${lifecycleLabel(task.lifecycle)} · ${verificationLabel(task.verification)}`
}

/* ── test / diagnostic surface ───────────────────────────────────────── */

/**
 * The component above is the only production entry. These re-exports exist so
 * the jsdom client test can assert the pure projection/guard/command logic and
 * the scoped stylesheet without a second copy of the code.
 */
export * from './view-model.ts'
export * from './commands.ts'
export { BOOP_TASKBOARD_CSS, TASKBOARD_STYLE_TAG, installTaskboardStyles } from './styles.ts'
export { TaskCard } from './TaskCard.tsx'
export { BoardColumn } from './BoardColumn.tsx'
export { IssueListView } from './IssueListView.tsx'
