/**
 * BOOP Taskboard view-model (E04-02, host half) — framework-free core.
 *
 * Frozen design rules implemented here (04§06–07, 06§03–08, issue E04-02):
 *  - the board is a PROJECTION over the one task/action/approval ledger
 *    (`src/host/persistence/repository.ts`). It never owns a second status
 *    store and never introduces a second "done" field;
 *  - four display groups (待开始 / 进行中 / 待我处理 / 已结束) are derived from
 *    the three axes (lifecycle / execution-authorization / verification) plus
 *    the pending reason; a group is never persisted;
 *  - cross-column drag is closed: this module exposes NO command that can
 *    change lifecycle, verification or approval. Same-column ordering is a
 *    LOCAL view order only; writing a priority back is a separate gated
 *    command that currently fails closed with CAPABILITY_UNAVAILABLE + audit;
 *  - reads are honest: an unreadable ledger is reported as `available: false`
 *    with a reason, never as an empty task list (FE-11); page/scan caps are
 *    returned in the payload;
 *  - stale responses are safe: every read carries a monotonic `projectionSeq`
 *    plus each card's `taskVersion`, so the client can drop an older response
 *    instead of overwriting newer state (AT-19/FE-04/TB06).
 *
 * This file imports only TYPES: it has no Cordis/framework dependency and is
 * unit-testable against the real SQLite repository.
 */

import type { ActionState, TaskLife, Verification } from '../shared/types.ts'
import type {
  ApprovalDetailRow,
  ApprovalListPage,
  TaskActionRow,
  TaskDetailRow,
  TaskEvidenceRow,
  TaskListFilter,
  TaskListPage,
  TaskProjectionRow,
  TaskRevisionRow,
  TaskTargetRow,
} from './persistence/repository.ts'

/* ── contract constants ───────────────────────────────────────────────── */

export const TASKS_SCHEMA_VERSION = 1 as const
export const TASKS_ROW_ID = 'boop-tasks'
export const TASKS_REMOTE_NAMESPACE = 'boopTasks'

/** The four frozen display groups, in display order. */
export type DisplayGroup = 'todo' | 'in_progress' | 'needs_me' | 'finished'

export const DISPLAY_GROUPS: ReadonlyArray<{ key: DisplayGroup; label: string; order: number }> = [
  { key: 'todo', label: '待开始', order: 1 },
  { key: 'in_progress', label: '进行中', order: 2 },
  { key: 'needs_me', label: '待我处理', order: 3 },
  { key: 'finished', label: '已结束', order: 4 },
]

export const DISPLAY_GROUP_LABELS: Readonly<Record<DisplayGroup, string>> = {
  todo: '待开始',
  in_progress: '进行中',
  needs_me: '待我处理',
  finished: '已结束',
}

/** Why a card sits in 待我处理 / what the user has to decide. */
export type PendingReason =
  | 'approval'
  | 'approval_stale'
  | 'recovery'
  | 'blocked'
  | 'verification'
  | 'verification_failed'
  | 'outcome_unknown'

/** 执行/授权 axis: the latest action's state ('none' = nothing dispatched yet). */
export type AuthorizationState = ActionState | 'none'

export type TaskOrderBy = 'group' | 'updatedAt' | 'title'
export type TaskOrderDir = 'asc' | 'desc'

export const TASKS_PAGE_DEFAULT = 50
export const TASKS_PAGE_MAX = 100
/** The board projects at most this many enriched tasks per call (honest cap). */
export const TASKS_SCAN_MAX = 500
/** Read endpoints: the ONLY Remote methods this plane exports besides the gated write. */
export const TASKS_ENDPOINTS = [
  'boopTasks/capabilities',
  'boopTasks/list',
  'boopTasks/detail',
  'boopTasks/setPriority',
] as const

/**
 * Frozen rule check used by unit tests: a Taskboard endpoint may never be a
 * verification/approval state change. `setPriority` is the only write-ish name
 * and it is gated; everything else is a read.
 */
export const TASKS_WRITE_ENDPOINTS = ['boopTasks/setPriority'] as const

/* ── host port (real wiring in tasks-api.ts, fakes in unit tests) ─────── */

export interface TasksLedgerPort {
  scopeId: string
  listTasks(scopeId: string, filter: TaskListFilter): TaskListPage
  listApprovals(scopeId: string, filter: { taskId?: string; limit?: number }): ApprovalListPage
  taskDetail(scopeId: string, taskId: string): TaskDetailRow | null
}

export type GateState = 'NOT_RUN' | 'PASS' | 'BLOCKED'

export interface TasksGatePort {
  /** The one BOOP write-mode gate (`boop.isWriteModeEnabled()`); false today. */
  writeModeEnabled(): boolean
  gates(): Record<string, GateState>
  /** Gates that still block writes; G02/G05 first while they are not PASS. */
  blockedByGates(): string[]
}

export interface TasksAuditEntry {
  kind: string
  objectId: string | null
  actor: string
  reason: string | null
}

export interface TasksAuditResult {
  recorded: boolean
  /** `memory` = the ledger was unavailable; the refusal still cannot execute. */
  sink: 'ledger' | 'memory'
  id: string | null
}

export interface TasksPort {
  /** The BOOP ledger, or null when storage is unavailable (reported honestly). */
  ledger(): TasksLedgerPort | null
  gate(): TasksGatePort
  /** Monotonic per-process sequence for stale-response protection. */
  nextProjectionSeq(): number
  now(): string
  audit(entry: TasksAuditEntry): TasksAuditResult
  auditSink(): 'ledger' | 'memory'
  /** Wiring facts only (never authority): row name, Remote namespace, row state. */
  diagnostics(): Record<string, unknown>
}

/* ── public fact shapes (the wire contract) ──────────────────────────── */

export interface TaskTargetFacts {
  workspaceId: string
  sessionId: string
  role: string
  resourceKey: string
}

export interface TaskPendingApprovalFacts {
  approvalId: string
  taskVersion: number
  policyEpoch: number
  expiresAt: string
  /** false = the card is already invalid and must not be clickable (04§08). */
  valid: boolean
  invalidReason: 'expired' | 'task-version-moved' | 'policy-epoch-moved' | null
}

export interface TaskLatestActionFacts {
  actionId: string
  state: ActionState
  targetSessionId: string
  taskVersion: number
  updatedAt: string
}

/** One board card: derived display facts over the ledger row. */
export interface TaskCardFacts {
  taskId: string
  /** The goal text; the client truncates visually but keeps the full value. */
  title: string
  lifecycle: TaskLife
  /**
   * 执行/授权 axis. `awaiting_approval` means the action is waiting for a human
   * approval; it is never "approved". `none` = nothing dispatched yet.
   */
  authorization: AuthorizationState
  verification: Verification
  displayGroup: DisplayGroup
  displayGroupLabel: string
  pendingReason: PendingReason | null
  pendingApproval: TaskPendingApprovalFacts | null
  /** Optimistic-concurrency version: a write must carry this exact version. */
  taskVersion: number
  workspaceId: string | null
  primarySessionId: string | null
  targets: TaskTargetFacts[]
  targetCount: number
  dependencyCount: number
  latestAction: TaskLatestActionFacts | null
  /** One honest sentence about the current state (derived, not a business field). */
  statusLine: string
  createdAt: string
  updatedAt: string
}

export interface TaskGroupFacts {
  key: DisplayGroup
  label: string
  order: number
  count: number
}

export interface TasksFilterFacts {
  groups: DisplayGroup[]
  lifecycles: TaskLife[]
  verifications: Verification[]
  workspaceId: string | null
  sessionId: string | null
  /** `any` = has an approval that still binds; `none` = the complement. */
  pending: 'any' | 'none' | null
  query: string | null
  orderBy: TaskOrderBy
  orderDir: TaskOrderDir
  limit: number
  offset: number
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
  /** true = filters/counts cover only the cap, not the whole ledger. */
  truncated: boolean
}

export interface TasksWriteModeFacts {
  enabled: boolean
  source: 'boop.isWriteModeEnabled()'
  blockedByGates: string[]
}

export interface TasksListFacts {
  schemaVersion: 1
  product: 'BOOP'
  /** false = the ledger could not be read; this is NOT "no tasks" (FE-11). */
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  readOnly: true
  writeMode: TasksWriteModeFacts
  filter: TasksFilterFacts
  /** Filters whose values were not understood and were therefore ignored. */
  ignoredFilters: string[]
  orderBy: TaskOrderBy
  orderDir: TaskOrderDir
  tasks: TaskCardFacts[]
  /** Four groups always present (in display order) when the ledger is readable. */
  groups: TaskGroupFacts[]
  total: number
  page: TasksPageFacts
  scan: TasksScanFacts
  /** Monotonic response sequence: drop responses with a smaller value. */
  projectionSeq: number
  generatedAt: string
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
  state: ActionState
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
  status: ApprovalDetailRow['status']
  actionId: string
  taskVersion: number
  policyEpoch: number
  payloadHash: string
  requestingOwner: string
  expiresAt: string
  consumedAt: string | null
  invalidReason: ApprovalDetailRow['invalidReason']
  valid: boolean
}

export interface TaskEvidenceFacts {
  factId: string
  factVersion: number
  useKind: TaskEvidenceRow['useKind']
  actionId: string | null
  sessionId: string | null
  seq: number | null
  sourceHash: string
  artifactRef: string | null
  /** Drill-down address; the UI shows this instead of copying raw chats. */
  address: string
}

export interface TaskDetailCoverageFacts {
  revisionCount: number
  actionCount: number
  approvalCount: number
  evidenceCount: number
}

export interface TaskDetailFacts {
  schemaVersion: 1
  product: 'BOOP'
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  readOnly: true
  writeMode: TasksWriteModeFacts
  /** false = no such task in this data domain (`available` stays true). */
  found: boolean
  notFoundReason: 'task-not-found' | 'invalid-request' | null
  task: TaskCardFacts | null
  /** Latest task revision snapshot (the full current plan text). */
  snapshot: {
    version: number
    goal: string
    criteria: string[]
    exclusions: string[]
    intentRef: string | null
    createdAt: string
  } | null
  revisions: TaskRevisionFacts[]
  targets: TaskTargetFacts[]
  dependencies: TaskDependencyFacts
  actions: TaskActionFacts[]
  approvals: TaskApprovalFacts[]
  evidence: TaskEvidenceFacts[]
  coverage: TaskDetailCoverageFacts
  /** Stated limits, e.g. child lists bounded to TASK_DETAIL_CHILD_LIMIT. */
  limitations: string[]
  projectionSeq: number
  generatedAt: string
}

export interface TaskMethodCapabilityFacts {
  method: 'capabilities' | 'list' | 'detail' | 'setPriority'
  kind: 'read' | 'write'
  status: 'available' | 'disabled' | 'unavailable'
  reason: string | null
}

export interface TasksCapabilitiesFacts {
  schemaVersion: 1
  product: 'BOOP'
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  readOnly: true
  writeMode: TasksWriteModeFacts
  canSortLocal: true
  canCommit: false
  canChangeVerification: false
  canChangeApproval: false
  blockedBy: string[]
  methods: TaskMethodCapabilityFacts[]
  endpoints: string[]
  writeEndpoints: Array<{ endpoint: string; code: 'CAPABILITY_UNAVAILABLE'; reason: string }>
  groups: Array<{ key: DisplayGroup; label: string; order: number }>
  filters: {
    workspace: boolean
    session: boolean
    group: boolean
    lifecycle: boolean
    verification: boolean
    pending: boolean
    query: boolean
  }
  orderBy: TaskOrderBy[]
  limits: { pageDefault: number; pageMax: number; scanMax: number; detailChildMax: number }
  audit: { sink: 'ledger' | 'memory'; durable: boolean }
  diagnostics: Record<string, unknown>
}

export interface TasksWriteRefusalFacts {
  schemaVersion: 1
  product: 'BOOP'
  command: 'setPriority'
  /** Always false: no Taskboard command can write while the gate is closed. */
  accepted: false
  executed: false
  code: 'CAPABILITY_UNAVAILABLE'
  reason: 'write-mode-disabled' | 'priority-persistence-not-wired'
  message: string
  writeModeEnabled: boolean
  blockedByGates: string[]
  /** Echoed request facts; nothing was persisted from them. */
  requested: { taskId: string | null; expectedVersion: number | null; priority: string | null }
  /** Same-column ordering is a local view order; it is not a ledger field. */
  localViewOnly: true
  audit: { recorded: boolean; sink: 'ledger' | 'memory'; id: string | null; kind: 'tasks/write-refused' }
}

/* ── group derivation ─────────────────────────────────────────────────── */

/**
 * Project one ledger row onto the four display groups.
 *
 * Order matters and is itself the rule: 已结束 → pending approval → unknown
 * outcome → recovery → blocked → stale approval → failed verification →
 * waiting-for-human verification → active → todo. A group is NEVER persisted;
 * moving a card across columns is not a supported operation.
 */
export function deriveDisplayGroup(task: TaskProjectionRow): {
  group: DisplayGroup
  pendingReason: PendingReason | null
} {
  const actionState: ActionState | null = task.latestAction?.state ?? null
  const validPending = task.pendingApprovals.filter((approval) => approval.invalidReason === null).length
  const hasStalePending = task.pendingApprovals.length > 0 && validPending === 0

  if (task.lifecycle === 'completed' || task.lifecycle === 'cancelled') {
    return { group: 'finished', pendingReason: null }
  }
  if (validPending > 0) return { group: 'needs_me', pendingReason: 'approval' }
  if (actionState === 'outcome_unknown') return { group: 'needs_me', pendingReason: 'outcome_unknown' }
  if (task.lifecycle === 'recovery_required') return { group: 'needs_me', pendingReason: 'recovery' }
  if (task.lifecycle === 'blocked') return { group: 'needs_me', pendingReason: 'blocked' }
  if (hasStalePending) return { group: 'needs_me', pendingReason: 'approval_stale' }
  if (task.verification === 'failed') return { group: 'needs_me', pendingReason: 'verification_failed' }
  const executing = actionState === 'dispatching' || actionState === 'accepted' || actionState === 'running'
  if (task.verification === 'pending' && !executing) {
    return { group: 'needs_me', pendingReason: 'verification' }
  }
  if (task.lifecycle === 'active') return { group: 'in_progress', pendingReason: null }
  return { group: 'todo', pendingReason: null }
}

/** The 执行/授权 axis: latest action state, or `none` when nothing dispatched. */
export function authorizationOf(task: TaskProjectionRow): AuthorizationState {
  return task.latestAction?.state ?? 'none'
}

/** One honest sentence per card; derived for display, never a business fact. */
export function statusLineOf(
  task: TaskProjectionRow,
  group: DisplayGroup,
  pendingReason: PendingReason | null,
): string {
  if (group === 'finished') {
    if (task.lifecycle === 'cancelled') return '已结束（已取消）'
    if (task.verification === 'waived') return '已结束（验收豁免）'
    if (task.verification === 'passed') return '已结束（验收通过）'
    return '已结束'
  }
  switch (pendingReason) {
    case 'approval':
      return '等待你批准'
    case 'approval_stale':
      return '审批已失效，需重新核查后申请'
    case 'recovery':
      return '需要你确认恢复'
    case 'blocked':
      return '已阻塞'
    case 'verification_failed':
      return '验收未通过'
    case 'verification':
      return '待你验收'
    case 'outcome_unknown':
      return '执行结果未知，需人工核查'
    default:
      break
  }
  if (group === 'in_progress') {
    switch (task.latestAction?.state) {
      case 'dispatching':
        return '正在派发'
      case 'accepted':
      case 'running':
        return '执行中'
      case 'planned':
        return '已计划，尚未派发'
      case 'awaiting_approval':
        return '等待批准'
      default:
        return '进行中'
    }
  }
  return task.lifecycle === 'paused' ? '已暂停（待恢复）' : '待开始'
}

/* ── card projection ─────────────────────────────────────────────────── */

/** Resolve the primary target: explicit `primary` role first, else the first. */
export function primaryTargetOf(targets: TaskTargetRow[]): TaskTargetRow | null {
  return targets.find((target) => target.role === 'primary') ?? targets[0] ?? null
}

export function toTaskCard(task: TaskProjectionRow): TaskCardFacts {
  const { group, pendingReason } = deriveDisplayGroup(task)
  const primary = primaryTargetOf(task.targets)
  const validPending = task.pendingApprovals.find((approval) => approval.invalidReason === null) ?? null
  const shownPending = validPending ?? task.pendingApprovals[0] ?? null
  return {
    taskId: task.id,
    title: task.goal,
    lifecycle: task.lifecycle,
    authorization: authorizationOf(task),
    verification: task.verification,
    displayGroup: group,
    displayGroupLabel: DISPLAY_GROUP_LABELS[group],
    pendingReason,
    pendingApproval:
      shownPending === null
        ? null
        : {
            approvalId: shownPending.id,
            taskVersion: shownPending.taskVersion,
            policyEpoch: shownPending.policyEpoch,
            expiresAt: shownPending.expiresAt,
            valid: shownPending.invalidReason === null,
            invalidReason: shownPending.invalidReason,
          },
    taskVersion: task.version,
    workspaceId: primary?.workspaceId ?? null,
    primarySessionId: primary?.sessionId ?? null,
    targets: task.targets.map((target) => ({ ...target })),
    targetCount: task.targets.length,
    dependencyCount: task.dependencyCount,
    latestAction:
      task.latestAction === null
        ? null
        : {
            actionId: task.latestAction.id,
            state: task.latestAction.state,
            targetSessionId: task.latestAction.targetSessionId,
            taskVersion: task.latestAction.taskVersion,
            updatedAt: task.latestAction.updatedAt,
          },
    statusLine: statusLineOf(task, group, pendingReason),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/* ── filter/sort normalisation ───────────────────────────────────────── */

const LIFECYCLES: readonly TaskLife[] = [
  'draft',
  'active',
  'paused',
  'blocked',
  'recovery_required',
  'completed',
  'cancelled',
]
const VERIFICATIONS: readonly Verification[] = ['not_requested', 'pending', 'passed', 'failed', 'waived']
const GROUP_KEYS: readonly DisplayGroup[] = ['todo', 'in_progress', 'needs_me', 'finished']
const ORDER_BYS: readonly TaskOrderBy[] = ['group', 'updatedAt', 'title']
const GROUP_ORDER: Readonly<Record<DisplayGroup, number>> = {
  todo: 1,
  in_progress: 2,
  needs_me: 3,
  finished: 4,
}

export interface NormalizedTasksFilter {
  facts: TasksFilterFacts
  repoFilter: TaskListFilter
  ignored: string[]
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

function stringList(value: unknown): string[] {
  return asArray(value)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

/**
 * Normalise an untrusted Remote `request` object into the filter the view-model
 * applies. Unknown values are IGNORED AND REPORTED (`ignoredFilters`) instead of
 * being silently coerced into a default that hides tasks.
 */
export function normalizeTasksFilter(request: unknown): NormalizedTasksFilter {
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const ignored: string[] = []

  const groups: DisplayGroup[] = []
  for (const entry of stringList(raw.group ?? raw.groups)) {
    if ((GROUP_KEYS as readonly string[]).includes(entry)) groups.push(entry as DisplayGroup)
    else ignored.push(`group:${entry}`)
  }

  const lifecycles: TaskLife[] = []
  for (const entry of stringList(raw.lifecycle ?? raw.lifecycles)) {
    if ((LIFECYCLES as readonly string[]).includes(entry)) lifecycles.push(entry as TaskLife)
    else ignored.push(`lifecycle:${entry}`)
  }

  const verifications: Verification[] = []
  for (const entry of stringList(raw.verification ?? raw.verifications)) {
    if ((VERIFICATIONS as readonly string[]).includes(entry)) verifications.push(entry as Verification)
    else ignored.push(`verification:${entry}`)
  }

  let workspaceId: string | null = null
  if (typeof raw.workspaceId === 'string' && raw.workspaceId.trim().length > 0) workspaceId = raw.workspaceId.trim()
  else if (raw.workspaceId !== undefined && raw.workspaceId !== null) ignored.push('workspaceId')

  let sessionId: string | null = null
  if (typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0) sessionId = raw.sessionId.trim()
  else if (raw.sessionId !== undefined && raw.sessionId !== null) ignored.push('sessionId')

  let pending: 'any' | 'none' | null = null
  const pendingRaw = raw.pending
  if (pendingRaw === true || pendingRaw === 'any' || pendingRaw === 'yes') pending = 'any'
  else if (pendingRaw === false || pendingRaw === 'none' || pendingRaw === 'no') pending = 'none'
  else if (pendingRaw !== undefined && pendingRaw !== null) ignored.push('pending')

  let query: string | null = null
  if (typeof raw.q === 'string' && raw.q.trim().length > 0) query = raw.q.trim()
  else if (typeof raw.query === 'string' && raw.query.trim().length > 0) query = raw.query.trim()
  else if (raw.q !== undefined && raw.q !== null) ignored.push('q')

  let orderBy: TaskOrderBy = 'group'
  if (raw.orderBy !== undefined && raw.orderBy !== null) {
    if (typeof raw.orderBy === 'string' && (ORDER_BYS as readonly string[]).includes(raw.orderBy)) {
      orderBy = raw.orderBy as TaskOrderBy
    } else {
      ignored.push('orderBy')
    }
  }

  let orderDir: TaskOrderDir = 'asc'
  if (raw.orderDir !== undefined && raw.orderDir !== null) {
    if (raw.orderDir === 'asc' || raw.orderDir === 'desc') orderDir = raw.orderDir
    else ignored.push('orderDir')
  }

  const limit = clampPageSize(raw.limit)
  const offset = clampOffset(raw.offset, 'offset', ignored)

  const repoFilter: TaskListFilter = {
    lifecycles,
    verifications,
    workspaceId: workspaceId ?? undefined,
    sessionId: sessionId ?? undefined,
    goalQuery: query ?? undefined,
    hasPendingApproval: pending === 'any' ? true : pending === 'none' ? false : undefined,
    limit: TASKS_SCAN_MAX,
    offset: 0,
  }

  return {
    facts: {
      groups,
      lifecycles,
      verifications,
      workspaceId,
      sessionId,
      pending,
      query,
      orderBy,
      orderDir,
      limit,
      offset,
    },
    repoFilter,
    ignored,
  }
}

function clampPageSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return TASKS_PAGE_DEFAULT
  return Math.min(TASKS_PAGE_MAX, Math.max(1, Math.trunc(parsed)))
}

function clampOffset(value: unknown, field: string, ignored: string[]): number {
  if (value === undefined || value === null) return 0
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) {
    ignored.push(field)
    return 0
  }
  return Math.trunc(parsed)
}

/** Local view ordering ONLY: nothing here is persisted or sent as a command. */
export function orderTaskCards(
  cards: TaskCardFacts[],
  orderBy: TaskOrderBy,
  orderDir: TaskOrderDir,
): TaskCardFacts[] {
  const direction = orderDir === 'asc' ? 1 : -1
  return [...cards].sort((left, right) => {
    if (orderBy === 'group') {
      const byGroup = GROUP_ORDER[left.displayGroup] - GROUP_ORDER[right.displayGroup]
      if (byGroup !== 0) return byGroup * direction
      // Within one column the newest card is first regardless of direction.
      const byTime = right.updatedAt.localeCompare(left.updatedAt)
      if (byTime !== 0) return byTime
      return left.taskId.localeCompare(right.taskId)
    }
    if (orderBy === 'title') {
      const byTitle = left.title.localeCompare(right.title, 'zh-Hans-CN')
      if (byTitle !== 0) return byTitle * direction
      return left.taskId.localeCompare(right.taskId)
    }
    const byTime = left.updatedAt.localeCompare(right.updatedAt)
    if (byTime !== 0) return byTime * direction
    return left.taskId.localeCompare(right.taskId)
  })
}

/* ── availability helpers ────────────────────────────────────────────── */

function writeModeFacts(port: TasksPort): TasksWriteModeFacts {
  let gate: TasksGatePort | null = null
  try {
    gate = port.gate()
  } catch {
    gate = null
  }
  return {
    enabled: gate?.writeModeEnabled() === true,
    source: 'boop.isWriteModeEnabled()',
    blockedByGates: gate?.blockedByGates() ?? [],
  }
}

function unavailableList(
  port: TasksPort,
  filter: TasksFilterFacts,
  ignored: string[],
  projectionSeq: number,
  generatedAt: string,
  reason: string,
  detail: string | null,
): TasksListFacts {
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available: false,
    reason,
    detail,
    scopeId: null,
    readOnly: true,
    writeMode: writeModeFacts(port),
    filter,
    ignoredFilters: ignored,
    orderBy: filter.orderBy,
    orderDir: filter.orderDir,
    tasks: [],
    groups: [],
    total: 0,
    page: {
      limit: filter.limit,
      offset: filter.offset,
      returned: 0,
      total: 0,
      hasMore: false,
      defaultLimit: TASKS_PAGE_DEFAULT,
      maxLimit: TASKS_PAGE_MAX,
    },
    scan: { cap: TASKS_SCAN_MAX, fetched: 0, ledgerTotal: 0, truncated: false },
    projectionSeq,
    generatedAt,
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ── reads ───────────────────────────────────────────────────────────── */

/**
 * Project one page of the board.
 *
 * Read-only: this function never writes a task, action, approval, cursor or
 * audit row. The only writes in this module are the audited refusals in
 * {@link setPriorityFacts}.
 */
export function tasksListFacts(port: TasksPort, request?: unknown): TasksListFacts {
  const projectionSeq = port.nextProjectionSeq()
  const generatedAt = port.now()
  const normalized = normalizeTasksFilter(request)
  const filter = normalized.facts
  let ledger: TasksLedgerPort | null = null
  try {
    ledger = port.ledger()
  } catch (error) {
    return unavailableList(port, filter, normalized.ignored, projectionSeq, generatedAt, 'ledger-unavailable', errorDetail(error))
  }
  if (ledger === null) {
    return unavailableList(port, filter, normalized.ignored, projectionSeq, generatedAt, 'ledger-unavailable', null)
  }

  let page: TaskListPage
  try {
    page = ledger.listTasks(ledger.scopeId, normalized.repoFilter)
  } catch (error) {
    return unavailableList(port, filter, normalized.ignored, projectionSeq, generatedAt, 'ledger-read-failed', errorDetail(error))
  }

  const cards = page.items.map(toTaskCard)
  const filtered =
    filter.groups.length === 0 ? cards : cards.filter((card) => filter.groups.includes(card.displayGroup))
  const groupCounts = new Map<DisplayGroup, number>()
  for (const card of filtered) groupCounts.set(card.displayGroup, (groupCounts.get(card.displayGroup) ?? 0) + 1)
  const groups: TaskGroupFacts[] = DISPLAY_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    order: group.order,
    count: groupCounts.get(group.key) ?? 0,
  }))

  const ordered = orderTaskCards(filtered, filter.orderBy, filter.orderDir)
  const paged = ordered.slice(filter.offset, filter.offset + filter.limit)
  const total = filtered.length

  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available: true,
    reason: null,
    detail: null,
    scopeId: ledger.scopeId,
    readOnly: true,
    writeMode: writeModeFacts(port),
    filter,
    ignoredFilters: normalized.ignored,
    orderBy: filter.orderBy,
    orderDir: filter.orderDir,
    tasks: paged,
    groups,
    total,
    page: {
      limit: filter.limit,
      offset: filter.offset,
      returned: paged.length,
      total,
      hasMore: filter.offset + paged.length < total,
      defaultLimit: TASKS_PAGE_DEFAULT,
      maxLimit: TASKS_PAGE_MAX,
    },
    scan: {
      cap: TASKS_SCAN_MAX,
      fetched: page.items.length,
      ledgerTotal: page.total,
      // The scan cap is only reached when the ledger holds more matching rows
      // than the board projected in one call; filters/counts then cover the cap.
      truncated: page.total > page.items.length,
    },
    projectionSeq,
    generatedAt,
  }
}

function notFoundDetail(
  port: TasksPort,
  projectionSeq: number,
  generatedAt: string,
  scopeId: string | null,
  reason: 'task-not-found' | 'invalid-request',
): TaskDetailFacts {
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available: true,
    reason: null,
    detail: null,
    scopeId,
    readOnly: true,
    writeMode: writeModeFacts(port),
    found: false,
    notFoundReason: reason,
    task: null,
    snapshot: null,
    revisions: [],
    targets: [],
    dependencies: { count: 0, dependsOn: [], dependedOnBy: [], truncated: false },
    actions: [],
    approvals: [],
    evidence: [],
    coverage: { revisionCount: 0, actionCount: 0, approvalCount: 0, evidenceCount: 0 },
    limitations: [],
    projectionSeq,
    generatedAt,
  }
}

function unavailableDetail(
  port: TasksPort,
  projectionSeq: number,
  generatedAt: string,
  scopeId: string | null,
  reason: string,
  detail: string | null,
): TaskDetailFacts {
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available: false,
    reason,
    detail,
    scopeId,
    readOnly: true,
    writeMode: writeModeFacts(port),
    found: false,
    notFoundReason: null,
    task: null,
    snapshot: null,
    revisions: [],
    targets: [],
    dependencies: { count: 0, dependsOn: [], dependedOnBy: [], truncated: false },
    actions: [],
    approvals: [],
    evidence: [],
    coverage: { revisionCount: 0, actionCount: 0, approvalCount: 0, evidenceCount: 0 },
    limitations: [],
    projectionSeq,
    generatedAt,
  }
}

function revisionFacts(revision: TaskRevisionRow): TaskRevisionFacts {
  const snapshot = (typeof revision.snapshot === 'object' && revision.snapshot !== null
    ? revision.snapshot
    : {}) as Record<string, unknown>
  return {
    version: revision.version,
    createdAt: revision.createdAt,
    goal: typeof snapshot.goal === 'string' ? snapshot.goal : '',
    criteriaCount: Array.isArray(snapshot.criteria) ? snapshot.criteria.length : 0,
    exclusionsCount: Array.isArray(snapshot.exclusions) ? snapshot.exclusions.length : 0,
    intentRef: revision.intentRef,
  }
}

function snapshotFacts(
  revision: TaskRevisionRow | null,
): TaskDetailFacts['snapshot'] {
  if (revision === null) return null
  const snapshot = (typeof revision.snapshot === 'object' && revision.snapshot !== null
    ? revision.snapshot
    : {}) as Record<string, unknown>
  return {
    version: revision.version,
    goal: typeof snapshot.goal === 'string' ? snapshot.goal : '',
    criteria: Array.isArray(snapshot.criteria) ? snapshot.criteria.map(String) : [],
    exclusions: Array.isArray(snapshot.exclusions) ? snapshot.exclusions.map(String) : [],
    intentRef: revision.intentRef,
    createdAt: revision.createdAt,
  }
}

function actionFacts(action: TaskActionRow): TaskActionFacts {
  return {
    actionId: action.id,
    state: action.state,
    taskVersion: action.taskVersion,
    targetSessionId: action.targetSessionId,
    messageId: action.messageId,
    policyEpoch: action.policyEpoch,
    payloadHash: action.payloadHash,
    originRef: action.originRef,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  }
}

function approvalFacts(approval: ApprovalDetailRow): TaskApprovalFacts {
  return {
    approvalId: approval.id,
    status: approval.status,
    actionId: approval.actionId,
    taskVersion: approval.taskVersion,
    policyEpoch: approval.policyEpoch,
    payloadHash: approval.payloadHash,
    requestingOwner: approval.requestingOwner,
    expiresAt: approval.expiresAt,
    consumedAt: approval.consumedAt,
    invalidReason: approval.invalidReason,
    valid: approval.status === 'pending' && approval.invalidReason === null,
  }
}

function evidenceAddress(evidence: TaskEvidenceRow): string {
  if (evidence.sessionId !== null && evidence.seq !== null) {
    return `session:${evidence.sessionId}#seq:${evidence.seq}`
  }
  return `fact:${evidence.factId}@${evidence.factVersion}`
}

function evidenceFacts(evidence: TaskEvidenceRow): TaskEvidenceFacts {
  return {
    factId: evidence.factId,
    factVersion: evidence.factVersion,
    useKind: evidence.useKind,
    actionId: evidence.actionId,
    sessionId: evidence.sessionId,
    seq: evidence.seq,
    sourceHash: evidence.sourceHash,
    artifactRef: evidence.artifactRef,
    address: evidenceAddress(evidence),
  }
}

/**
 * Read-only detail of one task. A task outside this data domain is reported as
 * `found: false` (available stays true), never as another domain's task and
 * never as an empty task.
 */
export function taskDetailFacts(port: TasksPort, request?: unknown): TaskDetailFacts {
  const projectionSeq = port.nextProjectionSeq()
  const generatedAt = port.now()
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : ''
  let ledger: TasksLedgerPort | null = null
  try {
    ledger = port.ledger()
  } catch (error) {
    return unavailableDetail(port, projectionSeq, generatedAt, null, 'ledger-unavailable', errorDetail(error))
  }
  if (ledger === null) {
    return unavailableDetail(port, projectionSeq, generatedAt, null, 'ledger-unavailable', null)
  }
  if (taskId.length === 0) {
    return notFoundDetail(port, projectionSeq, generatedAt, ledger.scopeId, 'invalid-request')
  }

  let detail: TaskDetailRow | null
  try {
    detail = ledger.taskDetail(ledger.scopeId, taskId)
  } catch (error) {
    return unavailableDetail(port, projectionSeq, generatedAt, ledger.scopeId, 'ledger-read-failed', errorDetail(error))
  }
  if (detail === null) return notFoundDetail(port, projectionSeq, generatedAt, ledger.scopeId, 'task-not-found')

  const limitations: string[] = []
  if (detail.truncated.revisions) limitations.push('revisions 只返回最近 50 条；总数见 coverage.revisionCount')
  if (detail.truncated.actions) limitations.push('actions 只返回最近 50 条；总数见 coverage.actionCount')
  if (detail.truncated.approvals) limitations.push('approvals 只返回最近 50 条；总数见 coverage.approvalCount')
  if (detail.truncated.evidence) limitations.push('evidence 只返回前 50 条地址；总数见 coverage.evidenceCount')
  if (detail.truncated.dependedOnBy) limitations.push('dependedOnBy 只返回前 50 个；总数见 dependencies.count')

  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available: true,
    reason: null,
    detail: null,
    scopeId: ledger.scopeId,
    readOnly: true,
    writeMode: writeModeFacts(port),
    found: true,
    notFoundReason: null,
    task: toTaskCard(detail.task),
    snapshot: snapshotFacts(detail.latestSnapshot),
    revisions: detail.revisions.map(revisionFacts),
    targets: detail.task.targets.map((target) => ({ ...target })),
    dependencies: {
      count: detail.dependsOn.length,
      dependsOn: [...detail.dependsOn],
      dependedOnBy: [...detail.dependedOnBy],
      truncated: detail.truncated.dependedOnBy,
    },
    actions: detail.actions.map(actionFacts),
    approvals: detail.approvals.map(approvalFacts),
    evidence: detail.evidence.map(evidenceFacts),
    coverage: {
      revisionCount: detail.revisionCount,
      actionCount: detail.actionCount,
      approvalCount: detail.approvalCount,
      evidenceCount: detail.evidenceCount,
    },
    limitations,
    projectionSeq,
    generatedAt,
  }
}

/* ── capabilities ────────────────────────────────────────────────────── */

/**
 * Honest capability matrix for this plane. Write mode is read from the ONE
 * runtime gate; this plane never caches or overrides it.
 */
export function tasksCapabilitiesFacts(port: TasksPort): TasksCapabilitiesFacts {
  const writeMode = writeModeFacts(port)
  let ledger: TasksLedgerPort | null = null
  let reason: string | null = null
  let detail: string | null = null
  try {
    ledger = port.ledger()
  } catch (error) {
    ledger = null
    reason = 'ledger-unavailable'
    detail = errorDetail(error)
  }
  if (ledger === null && reason === null) reason = 'ledger-unavailable'

  // Prove readability with one bounded read instead of assuming a handle works.
  let available = ledger !== null
  if (ledger !== null) {
    try {
      ledger.listTasks(ledger.scopeId, { limit: 1 })
    } catch (error) {
      available = false
      reason = 'ledger-read-failed'
      detail = errorDetail(error)
    }
  }

  let auditSink: 'ledger' | 'memory' = 'memory'
  try {
    auditSink = port.auditSink()
  } catch {
    auditSink = 'memory'
  }

  const readStatus: TaskMethodCapabilityFacts['status'] = available ? 'available' : 'unavailable'
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    available,
    reason: available ? null : reason,
    detail: available ? null : detail,
    scopeId: ledger?.scopeId ?? null,
    readOnly: true,
    writeMode,
    canSortLocal: true,
    canCommit: false,
    canChangeVerification: false,
    canChangeApproval: false,
    blockedBy: writeMode.blockedByGates,
    methods: [
      { method: 'capabilities', kind: 'read', status: 'available', reason: null },
      { method: 'list', kind: 'read', status: readStatus, reason: available ? null : reason },
      { method: 'detail', kind: 'read', status: readStatus, reason: available ? null : reason },
      {
        method: 'setPriority',
        kind: 'write',
        status: 'disabled',
        reason: writeMode.enabled ? 'priority-persistence-not-wired' : 'write-mode-disabled',
      },
    ],
    endpoints: [...TASKS_ENDPOINTS],
    writeEndpoints: [
      {
        endpoint: 'boopTasks/setPriority',
        code: 'CAPABILITY_UNAVAILABLE',
        reason: writeMode.enabled ? 'priority-persistence-not-wired' : 'write-mode-disabled',
      },
    ],
    groups: DISPLAY_GROUPS.map((group) => ({ key: group.key, label: group.label, order: group.order })),
    filters: {
      workspace: true,
      session: true,
      group: true,
      lifecycle: true,
      verification: true,
      pending: true,
      query: true,
    },
    orderBy: ['group', 'updatedAt', 'title'],
    limits: {
      pageDefault: TASKS_PAGE_DEFAULT,
      pageMax: TASKS_PAGE_MAX,
      scanMax: TASKS_SCAN_MAX,
      detailChildMax: 50,
    },
    audit: { sink: auditSink, durable: auditSink === 'ledger' },
    diagnostics: {
      row: TASKS_ROW_ID,
      remoteService: TASKS_REMOTE_NAMESPACE,
      ...port.diagnostics(),
    },
  }
}

/* ── the one gated write-ish command (always refused today) ──────────── */

const WRITE_REFUSAL_MESSAGE_DISABLED =
  'BOOP 写模式在 G02/G05 通过前保持关闭：本次同列排序只改变本地视图顺序，没有写回优先级，也没有改动任务状态、验收或审批。'
const WRITE_REFUSAL_MESSAGE_NOT_WIRED =
  '任务优先级在账本中尚未有持久化字段：本次没有写回任何优先级，也没有改动任务状态、验收或审批。'

/**
 * Attempt to persist a same-column priority change.
 *
 * There is NO code path here that can change lifecycle, verification or
 * approval: the command has exactly one outcome today — `CAPABILITY_UNAVAILABLE`
 * plus a durable audit row (ledger, or an honest memory fallback). Local
 * ordering itself lives in the client view and needs no write.
 */
export function setPriorityFacts(port: TasksPort, request?: unknown): TasksWriteRefusalFacts {
  const writeMode = writeModeFacts(port)
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const taskId = typeof raw.taskId === 'string' && raw.taskId.trim().length > 0 ? raw.taskId.trim() : null
  const expectedVersion = typeof raw.expectedVersion === 'number' && Number.isFinite(raw.expectedVersion)
    ? Math.trunc(raw.expectedVersion)
    : null
  const priority = typeof raw.priority === 'string' && raw.priority.trim().length > 0 ? raw.priority.trim() : null
  const reason: TasksWriteRefusalFacts['reason'] = writeMode.enabled
    ? 'priority-persistence-not-wired'
    : 'write-mode-disabled'
  const blockedByGates = writeMode.enabled ? [] : writeMode.blockedByGates
  const audit = port.audit({
    kind: 'tasks/write-refused',
    objectId: taskId ?? 'setPriority',
    actor: 'ui',
    reason: `CAPABILITY_UNAVAILABLE ${reason}; gates=${blockedByGates.join(',') || 'none'}`,
  })
  return {
    schemaVersion: TASKS_SCHEMA_VERSION,
    product: 'BOOP',
    command: 'setPriority',
    accepted: false,
    executed: false,
    code: 'CAPABILITY_UNAVAILABLE',
    reason,
    message: writeMode.enabled ? WRITE_REFUSAL_MESSAGE_NOT_WIRED : WRITE_REFUSAL_MESSAGE_DISABLED,
    writeModeEnabled: writeMode.enabled,
    blockedByGates,
    requested: { taskId, expectedVersion, priority },
    localViewOnly: true,
    audit: { recorded: audit.recorded, sink: audit.sink, id: audit.id, kind: 'tasks/write-refused' },
  }
}
