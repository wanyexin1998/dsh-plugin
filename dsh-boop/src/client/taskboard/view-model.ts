/**
 * BOOP taskboard view model (E04-02 client half) — pure display logic.
 *
 * Source & licence: layout/interaction ideas are selectively extracted from
 * `chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142`
 * (`web/src/taskFilters.ts`, `web/src/types.ts`), Apache-2.0; this file is a
 * rewrite against BOOP's three-axis task contract. See
 * `docs/development/taskboard-sources.md` for the per-file ledger.
 *
 * Contract by task-6, adapted 2026-10-18 to the real Host view-model in
 * `src/host/tasks.ts` (namespace `boopTasks`, methods `list`/`detail`/
 * `capabilities` + the always-refused `setPriority`): every method resolves to
 * ONE fact object (single-layer `result.value`). Field names below were taken
 * from `TaskCardFacts` / `TasksListFacts` / `TaskDetailFacts` /
 * `TasksCapabilitiesFacts` / `TasksWriteRefusalFacts`; the normalisers tolerate
 * null/absent values so an unreadable Host never becomes an invented task.
 *
 * The four display groups are a DERIVED PROJECTION of the task/execution/
 * verification axes (04§06). The Host already derives `displayGroup` per card;
 * the client uses it when present and only falls back to the axes locally.
 * Groups are never stored and cross-column moves do not exist (TB05). Finished
 * is not "success": a finished card keeps showing whether verification passed,
 * failed, was waived or was never requested (TB04).
 */

/** Client-side host call shape: exactly the BOOP connection `call` envelope. */
export type TaskboardCall = (
  endpoint: string,
  args?: Record<string, unknown>,
) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }>

export type TaskLifecycle =
  | 'draft'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'recovery_required'
  | 'completed'
  | 'cancelled'
  | (string & {})

export type TaskVerification =
  | 'not_requested'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'waived'
  | (string & {})

/** 执行/授权 axis: the latest action state ('none' = nothing dispatched yet). */
export type TaskAuthorization =
  | 'planned'
  | 'awaiting_approval'
  | 'dispatching'
  | 'accepted'
  | 'running'
  | 'settled'
  | 'stopped'
  | 'outcome_unknown'
  | 'rejected'
  | 'none'
  | (string & {})

/** Host `DisplayGroup` keys: 待开始 / 进行中 / 待我处理 / 已结束. */
export type TaskDisplayGroup = 'todo' | 'in_progress' | 'needs_me' | 'finished'

export const GROUP_ORDER: readonly TaskDisplayGroup[] = ['todo', 'in_progress', 'needs_me', 'finished']

export const GROUP_LABELS: Record<TaskDisplayGroup, string> = {
  todo: '待开始',
  in_progress: '进行中',
  needs_me: '待我处理',
  finished: '已结束',
}

/** Why a card sits in 待我处理 / what the user has to decide (Host enum). */
export type PendingReason =
  | 'approval'
  | 'approval_stale'
  | 'recovery'
  | 'blocked'
  | 'verification'
  | 'verification_failed'
  | 'outcome_unknown'
  | (string & {})

export const PENDING_REASON_LABELS: Record<string, string> = {
  approval: '等待你批准',
  approval_stale: '审批已失效，需重新核查后申请',
  recovery: '需要你确认恢复',
  blocked: '已阻塞',
  verification: '待你验收',
  verification_failed: '验收未通过',
  outcome_unknown: '执行结果未知，需人工核查',
}

export interface TaskPendingApproval {
  approvalId: string
  taskVersion: number
  policyEpoch: number
  expiresAt: string
  valid: boolean
  invalidReason: 'expired' | 'task-version-moved' | 'policy-epoch-moved' | null
}

export interface TaskLatestAction {
  actionId: string
  state: string
  targetSessionId: string
  taskVersion: number
  updatedAt: string
}

/** One related DSH Session target; opening uses the exact stable sessionId. */
export interface TaskTarget {
  sessionId: string
  workspaceId?: string | null
  role?: string | null
  resourceKey?: string | null
  title?: string | null
}

/** One projected card — the Host's `TaskCardFacts` (contract by task-6). */
export interface TaskboardTask {
  taskId: string
  title: string
  lifecycle: TaskLifecycle
  authorization: TaskAuthorization
  verification: TaskVerification
  displayGroup: TaskDisplayGroup | null
  displayGroupLabel: string | null
  pendingReason: PendingReason | null
  pendingApproval: TaskPendingApproval | null
  taskVersion: number
  workspaceId: string | null
  primarySessionId: string | null
  targets: TaskTarget[]
  targetCount: number
  dependencyCount: number
  latestAction: TaskLatestAction | null
  /** Host-derived honest sentence; the client falls back to its own line. */
  statusLine: string | null
  createdAt: string | null
  updatedAt: string | null
}

/* ── Host wire facts (names from src/host/tasks.ts, contract by task-6) ── */

export interface TasksWriteModeFacts {
  enabled: boolean
  source?: string
  blockedByGates: string[]
}

export interface TaskGroupFacts {
  key: TaskDisplayGroup
  label: string
  order: number
  count: number
}

export interface TasksPageFacts {
  limit: number
  offset: number
  returned: number
  total: number
  hasMore: boolean
  defaultLimit: number
  maxLimit: number
}

export interface TasksScanFacts {
  cap: number
  fetched: number
  ledgerTotal: number
  truncated: boolean
}

export interface TasksFilterFacts {
  groups: TaskDisplayGroup[]
  lifecycles: string[]
  verifications: string[]
  workspaceId: string | null
  sessionId: string | null
  pending: 'any' | 'none' | null
  query: string | null
  orderBy: 'group' | 'updatedAt' | 'title'
  orderDir: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface TaskboardListFacts {
  available?: boolean
  reason?: string | null
  detail?: string | null
  scopeId?: string | null
  readOnly?: true
  writeMode?: TasksWriteModeFacts
  filter?: TasksFilterFacts
  ignoredFilters?: string[]
  orderBy?: string
  orderDir?: string
  tasks?: unknown
  groups?: unknown
  total?: number | null
  page?: TasksPageFacts
  scan?: TasksScanFacts
  /** Monotonic per-process sequence: a smaller value means an older response. */
  projectionSeq?: number
  generatedAt?: string
}

export interface TaskRevisionFacts {
  version: number
  createdAt: string
  goal: string
  criteriaCount: number
  exclusionsCount: number
  intentRef: string | null
}

export interface TaskDependencyFacts {
  count: number
  dependsOn: string[]
  dependedOnBy: string[]
  truncated: boolean
}

export interface TaskActionFacts {
  actionId: string
  state: string
  taskVersion: number
  targetSessionId: string
  messageId: string | null
  policyEpoch: number
  payloadHash: string
  originRef: string
  createdAt: string
  updatedAt: string
}

export interface TaskApprovalFacts {
  approvalId: string
  status: string
  actionId: string
  taskVersion: number
  policyEpoch: number
  payloadHash: string
  requestingOwner: string
  expiresAt: string
  consumedAt: string | null
  invalidReason: string | null
  valid: boolean
}

export interface TaskEvidenceFacts {
  factId: string
  factVersion: number
  useKind: string
  actionId: string | null
  sessionId: string | null
  seq: number | null
  sourceHash: string
  artifactRef: string | null
  /** Drill-down address; the UI shows this instead of copying raw chats. */
  address: string
}

export interface TaskSnapshotFacts {
  version: number
  goal: string
  criteria: string[]
  exclusions: string[]
  intentRef: string | null
  createdAt: string
}

export interface TaskDetailCoverageFacts {
  revisionCount: number
  actionCount: number
  approvalCount: number
  evidenceCount: number
}

export interface TaskboardDetailFacts {
  available?: boolean
  reason?: string | null
  detail?: string | null
  scopeId?: string | null
  readOnly?: true
  writeMode?: TasksWriteModeFacts
  found?: boolean
  notFoundReason?: 'task-not-found' | 'invalid-request' | null
  task?: unknown
  snapshot?: TaskSnapshotFacts | null
  revisions?: unknown
  targets?: unknown
  dependencies?: TaskDependencyFacts | null
  actions?: unknown
  approvals?: unknown
  evidence?: unknown
  coverage?: TaskDetailCoverageFacts | null
  limitations?: string[]
  projectionSeq?: number
  generatedAt?: string
}

export interface TaskMethodCapabilityFacts {
  method: string
  kind: 'read' | 'write'
  status: 'available' | 'disabled' | 'unavailable'
  reason: string | null
}

export interface TaskboardCapabilitiesFacts {
  available?: boolean
  reason?: string | null
  detail?: string | null
  scopeId?: string | null
  readOnly?: true
  writeMode?: TasksWriteModeFacts
  canSortLocal?: boolean
  canCommit?: boolean
  canChangeVerification?: boolean
  canChangeApproval?: boolean
  blockedBy?: string[]
  methods?: TaskMethodCapabilityFacts[]
  endpoints?: string[]
  writeEndpoints?: Array<{ endpoint: string; code: string; reason: string }>
  groups?: Array<{ key: TaskDisplayGroup; label: string; order: number }>
  filters?: Record<string, boolean>
  orderBy?: string[]
  limits?: Record<string, number>
  audit?: { sink: string; durable: boolean }
  diagnostics?: Record<string, unknown>
}

/* ── normalisation ────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isDisplayGroup(value: unknown): value is TaskDisplayGroup {
  return value === 'todo' || value === 'in_progress' || value === 'needs_me' || value === 'finished'
}

function normalizeTarget(raw: unknown): TaskTarget | null {
  if (typeof raw === 'string') return { sessionId: raw }
  if (!isRecord(raw)) return null
  const sessionId = text(raw.sessionId) ?? text(raw.id)
  if (!sessionId) return null
  return {
    sessionId,
    workspaceId: text(raw.workspaceId),
    role: text(raw.role),
    resourceKey: text(raw.resourceKey),
    title: text(raw.title),
  }
}

function normalizeTargets(raw: unknown): TaskTarget[] {
  if (!Array.isArray(raw)) return []
  const targets: TaskTarget[] = []
  for (const entry of raw) {
    const target = normalizeTarget(entry)
    if (target) targets.push(target)
  }
  return targets
}

function normalizePendingApproval(raw: unknown): TaskPendingApproval | null {
  if (!isRecord(raw)) return null
  const approvalId = text(raw.approvalId)
  if (!approvalId) return null
  const invalidReason = text(raw.invalidReason)
  return {
    approvalId,
    taskVersion: num(raw.taskVersion) ?? 0,
    policyEpoch: num(raw.policyEpoch) ?? 0,
    expiresAt: text(raw.expiresAt) ?? '',
    valid: raw.valid === true,
    invalidReason:
      invalidReason === 'expired' || invalidReason === 'task-version-moved' || invalidReason === 'policy-epoch-moved'
        ? invalidReason
        : null,
  }
}

function normalizeLatestAction(raw: unknown): TaskLatestAction | null {
  if (!isRecord(raw)) return null
  const actionId = text(raw.actionId)
  if (!actionId) return null
  return {
    actionId,
    state: text(raw.state) ?? 'unknown',
    targetSessionId: text(raw.targetSessionId) ?? '',
    taskVersion: num(raw.taskVersion) ?? 0,
    updatedAt: text(raw.updatedAt) ?? '',
  }
}

/** Normalise one Host `TaskCardFacts`; never invents a value that was absent. */
export function normalizeTask(raw: unknown, index = -1): TaskboardTask | null {
  if (!isRecord(raw)) return null
  const taskId = text(raw.taskId) ?? text(raw.id) ?? (index >= 0 ? `task-${index}` : null)
  if (!taskId) return null
  const displayGroup = isDisplayGroup(raw.displayGroup) ? raw.displayGroup : null
  return {
    taskId,
    title: text(raw.title) ?? text(raw.goal) ?? '（未命名任务）',
    lifecycle: text(raw.lifecycle) ?? text(raw.life) ?? 'draft',
    // Unknown authorization is NOT assumed pending: an omitted field must not
    // push every card into "待我处理".
    authorization: text(raw.authorization) ?? text(raw.authorized) ?? 'none',
    verification: text(raw.verification) ?? 'not_requested',
    displayGroup,
    displayGroupLabel: text(raw.displayGroupLabel),
    pendingReason: text(raw.pendingReason),
    pendingApproval: normalizePendingApproval(raw.pendingApproval),
    taskVersion: num(raw.taskVersion) ?? num(raw.version) ?? 0,
    workspaceId: text(raw.workspaceId),
    primarySessionId: text(raw.primarySessionId),
    targets: normalizeTargets(raw.targets ?? raw.targetSessions ?? raw.sessions),
    targetCount: num(raw.targetCount) ?? normalizeTargets(raw.targets).length,
    dependencyCount: num(raw.dependencyCount) ?? 0,
    latestAction: normalizeLatestAction(raw.latestAction),
    statusLine: text(raw.statusLine),
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt ?? raw.updated_at),
  }
}

export function normalizeTasks(raw: unknown): TaskboardTask[] {
  if (!Array.isArray(raw)) return []
  const tasks: TaskboardTask[] = []
  for (const [index, entry] of raw.entries()) {
    const task = normalizeTask(entry, index)
    if (task) tasks.push(task)
  }
  return tasks
}

function normalizeWriteMode(raw: unknown): TasksWriteModeFacts | null {
  if (!isRecord(raw)) return null
  return {
    enabled: raw.enabled === true,
    source: text(raw.source) ?? undefined,
    blockedByGates: Array.isArray(raw.blockedByGates)
      ? raw.blockedByGates.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

export interface NormalizedList {
  available: boolean
  reason: string | null
  detail: string | null
  tasks: TaskboardTask[]
  groups: TaskGroupFacts[]
  total: number
  /** True only when the Host explicitly reports coverage beyond one response. */
  partial: boolean
  partialReason: string | null
  writeMode: TasksWriteModeFacts | null
  projectionSeq: number | null
  /** Server-reported rows not shown because of paging/scan caps. */
  hidden: number
}

/**
 * Normalise the `boopTasks/list` fact object (Host `TasksListFacts`).
 *
 * FE-11: an unreadable plane is `available:false` + reason — never an empty
 * list. A readable plane with zero tasks IS a genuine empty state.
 */
export function normalizeListFacts(value: unknown): NormalizedList {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回任务投影对象',
      detail: null,
      tasks: [],
      groups: [],
      total: 0,
      partial: false,
      partialReason: null,
      writeMode: null,
      projectionSeq: null,
      hidden: 0,
    }
  }
  const available = value.available === true
  const tasks = normalizeTasks(value.tasks)
  const page = isRecord(value.page) ? value.page : null
  const scan = isRecord(value.scan) ? value.scan : null
  const rawTotal = num(value.total)
  const pageTotal = page ? num(page.total) : null
  const total = rawTotal ?? pageTotal ?? tasks.length
  const hasMore = page?.hasMore === true
  const truncated = scan?.truncated === true
  const hidden = Math.max(0, total - tasks.length)
  const partial = hasMore || truncated || hidden > 0
  const cap = scan ? num(scan.cap) : null
  const partialReason = truncated && cap !== null
    ? `宿主单次最多投影 ${cap} 条（scan.cap），其余未包含在本次响应`
    : hasMore
      ? '宿主分页未返回全部匹配任务'
      : null
  const groupsRaw = Array.isArray(value.groups) ? value.groups : []
  const groups: TaskGroupFacts[] = []
  for (const entry of groupsRaw) {
    if (!isRecord(entry) || !isDisplayGroup(entry.key)) continue
    groups.push({
      key: entry.key,
      label: text(entry.label) ?? GROUP_LABELS[entry.key],
      order: num(entry.order) ?? GROUP_ORDER.indexOf(entry.key) + 1,
      count: num(entry.count) ?? 0,
    })
  }
  return {
    available,
    reason: text(value.reason),
    detail: text(value.detail),
    tasks,
    groups,
    total,
    partial,
    partialReason,
    writeMode: normalizeWriteMode(value.writeMode),
    projectionSeq: num(value.projectionSeq),
    hidden,
  }
}

export function normalizeDetailFacts(value: unknown): TaskboardDetailFacts {
  if (!isRecord(value)) return { available: false, reason: '宿主没有返回任务详情对象' }
  const normalized: TaskboardDetailFacts = {
    available: value.available === true,
    reason: text(value.reason),
    detail: text(value.detail),
    scopeId: text(value.scopeId),
    readOnly: true,
    writeMode: normalizeWriteMode(value.writeMode) ?? undefined,
    found: value.found === true,
    notFoundReason:
      value.notFoundReason === 'task-not-found' || value.notFoundReason === 'invalid-request'
        ? value.notFoundReason
        : null,
    task: value.task,
    snapshot: normalizeSnapshot(value.snapshot),
    revisions: value.revisions,
    targets: value.targets,
    dependencies: normalizeDependencies(value.dependencies),
    actions: value.actions,
    approvals: value.approvals,
    evidence: value.evidence,
    coverage: normalizeCoverage(value.coverage),
    limitations: Array.isArray(value.limitations)
      ? value.limitations.filter((entry): entry is string => typeof entry === 'string')
      : [],
    projectionSeq: num(value.projectionSeq) ?? undefined,
    generatedAt: text(value.generatedAt) ?? undefined,
  }
  return normalized
}

function normalizeSnapshot(raw: unknown): TaskSnapshotFacts | null {
  if (!isRecord(raw)) return null
  const criteria = Array.isArray(raw.criteria)
    ? raw.criteria.filter((entry): entry is string => typeof entry === 'string')
    : []
  const exclusions = Array.isArray(raw.exclusions)
    ? raw.exclusions.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    version: num(raw.version) ?? 0,
    goal: text(raw.goal) ?? '',
    criteria,
    exclusions,
    intentRef: text(raw.intentRef),
    createdAt: text(raw.createdAt) ?? '',
  }
}

function normalizeDependencies(raw: unknown): TaskDependencyFacts | null {
  if (!isRecord(raw)) return null
  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.filter((entry): entry is string => typeof entry === 'string')
    : []
  const dependedOnBy = Array.isArray(raw.dependedOnBy)
    ? raw.dependedOnBy.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    count: num(raw.count) ?? dependsOn.length + dependedOnBy.length,
    dependsOn,
    dependedOnBy,
    truncated: raw.truncated === true,
  }
}

function normalizeCoverage(raw: unknown): TaskDetailCoverageFacts | null {
  if (!isRecord(raw)) return null
  return {
    revisionCount: num(raw.revisionCount) ?? 0,
    actionCount: num(raw.actionCount) ?? 0,
    approvalCount: num(raw.approvalCount) ?? 0,
    evidenceCount: num(raw.evidenceCount) ?? 0,
  }
}

export function normalizeCapabilities(value: unknown): TaskboardCapabilitiesFacts {
  if (!isRecord(value)) {
    return { available: false, reason: '宿主没有返回任务能力对象', blockedBy: [] }
  }
  return {
    available: value.available !== false,
    reason: text(value.reason),
    detail: text(value.detail),
    scopeId: text(value.scopeId),
    readOnly: true,
    writeMode: normalizeWriteMode(value.writeMode) ?? undefined,
    canSortLocal: value.canSortLocal === true,
    canCommit: value.canCommit === true,
    canChangeVerification: value.canChangeVerification === true,
    canChangeApproval: value.canChangeApproval === true,
    blockedBy: Array.isArray(value.blockedBy)
      ? value.blockedBy.filter((entry): entry is string => typeof entry === 'string')
      : [],
    methods: Array.isArray(value.methods)
      ? value.methods
          .filter(isRecord)
          .map((entry) => ({
            method: text(entry.method) ?? 'unknown',
            kind: entry.kind === 'write' ? ('write' as const) : ('read' as const),
            status:
              entry.status === 'available' || entry.status === 'disabled' ? entry.status : ('unavailable' as const),
            reason: text(entry.reason),
          }))
      : [],
    endpoints: Array.isArray(value.endpoints)
      ? value.endpoints.filter((entry): entry is string => typeof entry === 'string')
      : [],
    writeEndpoints: Array.isArray(value.writeEndpoints)
      ? value.writeEndpoints.filter(isRecord).map((entry) => ({
          endpoint: text(entry.endpoint) ?? '',
          code: text(entry.code) ?? 'CAPABILITY_UNAVAILABLE',
          reason: text(entry.reason) ?? '',
        }))
      : [],
    groups: Array.isArray(value.groups)
      ? value.groups.filter(isRecord).flatMap((entry) => {
          if (!isDisplayGroup(entry.key)) return []
          return [{
            key: entry.key,
            label: text(entry.label) ?? GROUP_LABELS[entry.key],
            order: num(entry.order) ?? GROUP_ORDER.indexOf(entry.key) + 1,
          }]
        })
      : [],
    filters: isRecord(value.filters) ? (value.filters as Record<string, boolean>) : undefined,
    orderBy: Array.isArray(value.orderBy)
      ? value.orderBy.filter((entry): entry is string => typeof entry === 'string')
      : [],
    limits: isRecord(value.limits)
      ? Object.fromEntries(
          Object.entries(value.limits).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        )
      : {},
    audit: isRecord(value.audit)
      ? { sink: text(value.audit.sink) ?? 'unknown', durable: value.audit.durable === true }
      : undefined,
    diagnostics: isRecord(value.diagnostics) ? (value.diagnostics as Record<string, unknown>) : {},
  }
}

/* ── the four-group projection (display only, derived from three axes) ── */

/**
 * Derive the display group locally. The Host's `displayGroup` is authoritative
 * when present; this fallback mirrors the Host rule order closely enough that a
 * card is never silently dropped: 已结束 → pending reason → failed/pending
 * verification → recovery/blocked/paused → active → todo.
 */
export function deriveGroup(task: TaskboardTask): TaskDisplayGroup {
  if (task.displayGroup !== null) return task.displayGroup
  if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') return 'finished'
  if (
    task.pendingReason != null
    || task.pendingApproval != null
    || task.lifecycle === 'recovery_required'
    || task.lifecycle === 'blocked'
    || task.lifecycle === 'paused'
    || task.verification === 'failed'
    || task.verification === 'pending'
    || task.authorization === 'awaiting_approval'
    || task.authorization === 'outcome_unknown'
  ) {
    return 'needs_me'
  }
  if (task.lifecycle === 'active') return 'in_progress'
  return 'todo'
}

export function projectGroups(
  tasks: TaskboardTask[],
): Record<TaskDisplayGroup, TaskboardTask[]> {
  const groups: Record<TaskDisplayGroup, TaskboardTask[]> = {
    todo: [],
    in_progress: [],
    needs_me: [],
    finished: [],
  }
  for (const task of tasks) groups[deriveGroup(task)].push(task)
  return groups
}

/* ── local view order (same-column sort is VIEW state, never task state) ── */

/**
 * Sort one group's tasks: explicit local order first (taskIds from `order`),
 * then Host order (the Host already ordered by updatedAt/title); ties keep the
 * Host order (stable).
 */
export function sortGroup(tasks: TaskboardTask[], order: readonly string[]): TaskboardTask[] {
  const rank = new Map<string, number>()
  order.forEach((taskId, index) => {
    if (!rank.has(taskId)) rank.set(taskId, index)
  })
  return [...tasks].sort((left, right) => {
    const leftRank = rank.get(left.taskId)
    const rightRank = rank.get(right.taskId)
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
    if (leftRank !== undefined) return -1
    if (rightRank !== undefined) return 1
    return 0
  })
}

/** Move one card within its column in the local view order. */
export function moveWithinColumn(
  order: readonly string[],
  groupTaskIds: readonly string[],
  taskId: string,
  direction: 'up' | 'down',
): { order: string[]; moved: boolean; position: number } {
  // Materialise the column's visible order, then swap inside it.
  const columnOrder = sortGroup(
    groupTaskIds.map((id) => ({ taskId: id } as TaskboardTask)),
    order,
  ).map((task) => task.taskId)
  const index = columnOrder.indexOf(taskId)
  if (index < 0) return { order: [...order], moved: false, position: index }
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= columnOrder.length) {
    return { order: [...order], moved: false, position: index }
  }
  const nextColumn = [...columnOrder]
  const [movedTask] = nextColumn.splice(index, 1)
  nextColumn.splice(target, 0, movedTask as string)
  // Replace the column's slots in the global order with the new visible order.
  // The first column slot encountered receives the whole new column run, so a
  // missing/partial pre-existing order cannot swallow the reorder.
  const columnIds = new Set(columnOrder)
  const next: string[] = []
  let placed = false
  for (const id of order) {
    if (!columnIds.has(id)) {
      next.push(id)
      continue
    }
    if (!placed) {
      next.push(...nextColumn)
      placed = true
    }
  }
  if (!placed) next.push(...nextColumn)
  return { order: next, moved: true, position: target }
}

/* ── stale response protection (AT-19 / FE-04) ────────────────────────── */

/** Monotonic request sequence guard: only the newest request may apply. */
export interface RequestGuard {
  next(): number
  isLatest(seq: number): boolean
}

export function createRequestGuard(): RequestGuard {
  let latest = 0
  return {
    next(): number {
      latest += 1
      return latest
    },
    isLatest(seq: number): boolean {
      return seq === latest
    },
  }
}

export interface VersionMerge {
  tasks: TaskboardTask[]
  /** Task ids whose incoming version was older/equal and was NOT applied. */
  droppedStale: string[]
  /** Task ids that were added or advanced. */
  advanced: string[]
}

function comparableUpdatedAt(value: TaskboardTask['updatedAt']): number {
  if (typeof value !== 'string') return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** True when `candidate` carries newer task state than `current`. */
export function isNewerTask(candidate: TaskboardTask, current: TaskboardTask): boolean {
  if (candidate.taskVersion !== current.taskVersion) return candidate.taskVersion > current.taskVersion
  return comparableUpdatedAt(candidate.updatedAt) > comparableUpdatedAt(current.updatedAt)
}

/**
 * Merge one list response into the current view without ever downgrading a
 * task. The request-sequence/projection guard already drops wholly stale
 * responses; this per-task merge covers the case where a newer refetch
 * legitimately carries an older projection for one task (a slow API response
 * overtaken by a task event).
 */
export function mergeTaskVersions(current: readonly TaskboardTask[], incoming: readonly TaskboardTask[]): VersionMerge {
  const currentById = new Map(current.map((task) => [task.taskId, task]))
  const incomingIds = new Set(incoming.map((task) => task.taskId))
  const tasks: TaskboardTask[] = []
  const droppedStale: string[] = []
  const advanced: string[] = []
  for (const candidate of incoming) {
    const previous = currentById.get(candidate.taskId)
    if (!previous) {
      tasks.push(candidate)
      advanced.push(candidate.taskId)
      continue
    }
    if (isNewerTask(candidate, previous)) {
      tasks.push(candidate)
      advanced.push(candidate.taskId)
    } else {
      tasks.push(previous)
      droppedStale.push(candidate.taskId)
    }
  }
  // Tasks that vanished from the response are not deleted silently: keep them
  // and let the next accepted refresh settle the removal (a disappearing row is
  // not proof of deletion). The Host's `total` shows any coverage gap.
  for (const task of current) {
    if (!incomingIds.has(task.taskId)) tasks.push(task)
  }
  return { tasks, droppedStale, advanced }
}

/* ── honest display strings ───────────────────────────────────────────── */

const LIFECYCLE_LABELS: Record<string, string> = {
  draft: '草案',
  active: '已派发',
  paused: '已暂停',
  blocked: '受阻',
  recovery_required: '需恢复',
  completed: '已结束（完成）',
  cancelled: '已结束（取消）',
}

const VERIFICATION_LABELS: Record<string, string> = {
  not_requested: '未要求验收',
  pending: '待验收',
  passed: '验收通过',
  failed: '验收失败',
  waived: '验收豁免',
}

const AUTHORIZATION_LABELS: Record<string, string> = {
  none: '尚未派发',
  planned: '已计划',
  awaiting_approval: '待批准',
  dispatching: '派发中',
  accepted: '已接受',
  running: '执行中',
  settled: '已结束执行',
  stopped: '已停止',
  outcome_unknown: '结果未知',
  rejected: '已拒绝',
}

export function lifecycleLabel(value: TaskLifecycle): string {
  return LIFECYCLE_LABELS[value] ?? `生命周期：${value}`
}

export function verificationLabel(value: TaskVerification): string {
  return VERIFICATION_LABELS[value] ?? `验收：${value}`
}

export function authorizationLabel(value: TaskAuthorization): string {
  return AUTHORIZATION_LABELS[value] ?? `授权：${value}`
}

export function pendingReasonLabel(value: PendingReason | null): string | null {
  if (value === null) return null
  return PENDING_REASON_LABELS[value] ?? `待决原因：${value}`
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

/**
 * Verification tone for a card. Execution finishing is NOT acceptance: only
 * `passed` is visually "ok"; `failed` is bad; pending/waived are warn; a
 * cancelled or never-verified task is muted, never green (TB04).
 */
export function verificationTone(lifecycle: TaskLifecycle, verification: TaskVerification): Tone {
  if (lifecycle === 'cancelled') return 'muted'
  switch (verification) {
    case 'passed':
      return 'ok'
    case 'failed':
      return 'bad'
    case 'pending':
    case 'waived':
      return 'warn'
    default:
      return 'muted'
  }
}

/**
 * One plain-text status line. The Host's derived `statusLine` wins because it
 * is computed next to the projection rules; the local fallback keeps fixtures
 * and defensive responses readable. NEVER renders markdown.
 */
export function taskStatusLine(task: TaskboardTask): string {
  if (task.statusLine) return task.statusLine
  const parts = [lifecycleLabel(task.lifecycle)]
  if (task.verification !== 'not_requested' || task.lifecycle === 'completed' || task.lifecycle === 'cancelled') {
    parts.push(verificationLabel(task.verification))
  }
  return parts.join(' · ')
}

export function formatUpdatedAt(value: TaskboardTask['updatedAt']): string | null {
  if (value === null || value === undefined) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time <= 0) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(time))
  } catch {
    return null
  }
}

/* ── filters (workspace / delegated range / pending / search) ─────────── */

/**
 * Client-side view filters. They only narrow the rendered projection; they are
 * never written back and never change a task. (The Host list method accepts its
 * own filter object for future paged use; the first client version filters the
 * bounded page locally, which keeps one view model for board and list.)
 */
export interface TaskboardFilters {
  groups: TaskDisplayGroup[]
  workspaceId: string | null
  onlyPending: boolean
  search: string
}

export const EMPTY_FILTERS: TaskboardFilters = {
  groups: [],
  workspaceId: null,
  onlyPending: false,
  search: '',
}

/** Upstream `matchesTaskSearch` idea mapped to BOOP card fields (no description row). */
export function matchesSearch(task: TaskboardTask, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return [
    task.taskId,
    task.title,
    task.workspaceId ?? '',
    task.primarySessionId ?? '',
    ...task.targets.map((target) => `${target.sessionId} ${target.title ?? ''}`),
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle)
}

export function matchesFilters(task: TaskboardTask, filters: TaskboardFilters): boolean {
  if (filters.groups.length > 0 && !filters.groups.includes(deriveGroup(task))) return false
  if (filters.workspaceId !== null && (task.workspaceId ?? null) !== filters.workspaceId) return false
  if (filters.onlyPending && task.pendingReason == null && task.verification !== 'pending' && task.verification !== 'failed') {
    return false
  }
  return matchesSearch(task, filters.search)
}

export function filterTasks(tasks: readonly TaskboardTask[], filters: TaskboardFilters): TaskboardTask[] {
  return tasks.filter((task) => matchesFilters(task, filters))
}

export function filterCount(filters: TaskboardFilters): number {
  return (
    Number(filters.groups.length > 0)
    + Number(filters.workspaceId !== null)
    + Number(filters.onlyPending)
    + Number(filters.search.trim().length > 0)
  )
}

export function hasActiveFilters(filters: TaskboardFilters): boolean {
  return filterCount(filters) > 0
}

/** Workspace options derived from the projected rows only (no extra Host call). */
export function workspaceOptions(tasks: readonly TaskboardTask[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const options: Array<{ value: string; label: string }> = []
  for (const task of tasks) {
    if (!task.workspaceId || seen.has(task.workspaceId)) continue
    seen.add(task.workspaceId)
    options.push({ value: task.workspaceId, label: task.workspaceId })
  }
  options.sort((left, right) => left.label.localeCompare(right.label))
  return options
}

/* ── detail list projection (04§07) ───────────────────────────────────── */

function asRecordList(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

export interface RevisionRow {
  taskVersion: number | null
  summary: string
}

export interface ApprovalRow {
  approvalId: string
  taskVersion: number | null
  state: string
  valid: boolean
  reason: string | null
}

export interface EvidenceRow {
  label: string
  detail: string | null
}

export interface ActionRow {
  actionId: string
  state: string
  taskVersion: number | null
  targetSessionId: string | null
  updatedAt: string | null
}

export function normalizeRevisions(raw: unknown): RevisionRow[] {
  return asRecordList(raw).map((entry) => ({
    taskVersion: num(entry.version) ?? num(entry.taskVersion),
    summary:
      text(entry.goal) ?? text(entry.summary) ?? text(entry.reason) ?? text(entry.change) ?? '（无摘要）',
  }))
}

export function normalizeApprovals(raw: unknown): ApprovalRow[] {
  const rows: ApprovalRow[] = []
  for (const entry of asRecordList(raw)) {
    const approvalId = text(entry.approvalId) ?? text(entry.id) ?? text(entry.actionId)
    if (!approvalId) continue
    rows.push({
      approvalId,
      taskVersion: num(entry.taskVersion),
      state: text(entry.status) ?? text(entry.state) ?? 'unknown',
      valid: entry.valid === true,
      reason: text(entry.invalidReason) ?? text(entry.reason),
    })
  }
  return rows
}

export function normalizeEvidence(raw: unknown): EvidenceRow[] {
  return asRecordList(raw).map((entry) => ({
    label:
      text(entry.address) ?? text(entry.artifactRef) ?? text(entry.factId) ?? text(entry.sessionId) ?? '（证据地址）',
    detail:
      text(entry.useKind) ??
      (num(entry.seq) !== null ? `seq ${String(entry.seq)}` : null) ??
      text(entry.sourceHash),
  }))
}

export function normalizeActions(raw: unknown): ActionRow[] {
  return asRecordList(raw).map((entry) => ({
    actionId: text(entry.actionId) ?? text(entry.id) ?? '（无 id 动作）',
    state: text(entry.state) ?? 'unknown',
    taskVersion: num(entry.taskVersion),
    targetSessionId: text(entry.targetSessionId),
    updatedAt: text(entry.updatedAt),
  }))
}

export function normalizeTargetList(raw: unknown): TaskTarget[] {
  return normalizeTargets(raw)
}

export function detailTask(value: unknown): TaskboardTask | null {
  const facts = normalizeDetailFacts(value)
  return facts.task == null ? null : normalizeTask(facts.task)
}
