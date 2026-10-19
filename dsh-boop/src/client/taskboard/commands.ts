/**
 * BOOP taskboard semantic commands (E04-02 client half).
 *
 * Source & licence: the "taskFilters"/local-sort ideas come from the selective
 * extraction of `chuspeeism/dashi-taskboard@723c400eec86c454c1ffa56ee1b500746d41e142`
 * (Apache-2.0); the command mapping itself is BOOP's own design against the
 * `boopTasks` Remote contract (contract by task-6; field shapes adapted to
 * `src/host/tasks.ts` on 2026-10-18). See docs/development/taskboard-sources.md.
 *
 * Frozen rules encoded here:
 *  - cross-column drag is OFF (TB05): no command changes a task's group/status;
 *  - same-column ordering is LOCAL VIEW state only. Writing the order back goes
 *    through the one gated `boopTasks/setPriority` command, which today always
 *    answers `CAPABILITY_UNAVAILABLE` + an audit row; the UI must show that
 *    refusal and must never report success;
 *  - verification/approval fields are not part of any request built here, so the
 *    UI cannot change them (TB04/TB09) — the Host capabilities even state
 *    `canChangeVerification:false` / `canChangeApproval:false`;
 *  - stale responses are dropped by the view-model guard, not by pretending the
 *    newer state never arrived.
 */
import type {
  TaskboardCall,
  TaskboardCapabilitiesFacts,
  TaskboardDetailFacts,
  TaskboardFilters,
  TaskboardListFacts,
  TaskboardTask,
  TasksWriteModeFacts,
} from './view-model.ts'
import {
  EMPTY_FILTERS,
  filterCount,
  normalizeCapabilities,
  normalizeDetailFacts,
  normalizeListFacts,
} from './view-model.ts'

/* ── host endpoint map (contract by task-6) ───────────────────────────── */

/** Typert Remote namespace `boopTasks` methods, as the client calls them. */
export const TASKBOARD_ENDPOINTS = {
  list: 'boopTasks/list',
  detail: 'boopTasks/detail',
  capabilities: 'boopTasks/capabilities',
  /** The only write-ish method; always refused today with an audit row. */
  setPriority: 'boopTasks/setPriority',
} as const

/**
 * The rc.2.1 Typert wire sends exactly one plain-object `args` field. BOOP
 * Remote services (e.g. `boopWorkspace`) take ONE `request` parameter, so the
 * client wraps every payload under `request`. Kept in one place: if the Host
 * row exposes named parameters instead, this constant is the only change.
 */
export const TASKBOARD_ARG_KEY = 'request' as const

function args(payload: Record<string, unknown>): Record<string, unknown> {
  return { [TASKBOARD_ARG_KEY]: payload }
}

export interface TaskboardFetchResult<T> {
  ok: boolean
  facts: T | null
  /** Transport/plane fault message, when the call itself failed. */
  error: string | null
  /** The Host reported `available:false`; `reason` carries why. */
  unavailable: boolean
  reason: string | null
}

export async function fetchTaskboardList(call: TaskboardCall): Promise<TaskboardFetchResult<TaskboardListFacts>> {
  const result = await call(TASKBOARD_ENDPOINTS.list, args({}))
  if (!result.ok) {
    return { ok: false, facts: null, error: result.error?.message ?? '任务投影读取失败', unavailable: false, reason: null }
  }
  const facts = (result.value ?? {}) as TaskboardListFacts
  const normalized = normalizeListFacts(facts)
  return {
    ok: true,
    facts,
    error: null,
    unavailable: !normalized.available,
    reason: normalized.reason,
  }
}

export async function fetchTaskboardCapabilities(
  call: TaskboardCall,
): Promise<TaskboardFetchResult<TaskboardCapabilitiesFacts>> {
  const result = await call(TASKBOARD_ENDPOINTS.capabilities, args({}))
  if (!result.ok) {
    return { ok: false, facts: null, error: result.error?.message ?? '任务能力读取失败', unavailable: true, reason: null }
  }
  const facts = (result.value ?? {}) as TaskboardCapabilitiesFacts
  const normalized = normalizeCapabilities(facts)
  return {
    ok: true,
    facts,
    error: null,
    unavailable: !normalized.available,
    reason: normalized.reason ?? null,
  }
}

export async function fetchTaskboardDetail(
  call: TaskboardCall,
  taskId: string,
): Promise<TaskboardFetchResult<TaskboardDetailFacts>> {
  const result = await call(TASKBOARD_ENDPOINTS.detail, args({ taskId }))
  if (!result.ok) {
    return { ok: false, facts: null, error: result.error?.message ?? '任务详情读取失败', unavailable: false, reason: null }
  }
  const facts = (result.value ?? {}) as TaskboardDetailFacts
  const normalized = normalizeDetailFacts(facts)
  return {
    ok: true,
    facts,
    error: null,
    unavailable: !normalized.available,
    reason: normalized.reason ?? null,
  }
}

/* ── local view commands (always available; never a task-state change) ── */

export type MoveDirection = 'up' | 'down'

export interface LocalSortCommand {
  kind: 'local-sort'
  taskId: string
  direction: MoveDirection
  /** Pure view state; grouping/lifecycle/verification never change. */
}

export function createLocalSortCommand(taskId: string, direction: MoveDirection): LocalSortCommand {
  return { kind: 'local-sort', taskId, direction }
}

export interface FilterPatch {
  groups?: TaskboardFilters['groups']
  workspaceId?: string | null
  onlyPending?: boolean
  search?: string
}

export function applyFilterPatch(filters: TaskboardFilters, patch: FilterPatch): TaskboardFilters {
  return {
    groups: patch.groups ?? filters.groups,
    workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : filters.workspaceId,
    onlyPending: patch.onlyPending ?? filters.onlyPending,
    search: patch.search ?? filters.search,
  }
}

export function clearFilters(): TaskboardFilters {
  return { ...EMPTY_FILTERS }
}

export function describeFilterState(filters: TaskboardFilters): string {
  const count = filterCount(filters)
  return count === 0 ? '无筛选' : `已启用 ${count} 项筛选`
}

/* ── gated write-back command (server must confirm; refusal is visible) ── */

export type PriorityWriteStatus = 'pending' | 'confirmed' | 'rejected' | 'error'

export interface PriorityWriteRequest {
  /** Only these three fields are consumed by the Host `setPriority` normaliser. */
  taskId: string
  /** The exact task version the caller saw; the Host re-checks it. */
  expectedVersion: number
  /** Desired same-column position, as a semantic token (not a ledger field). */
  priority: string
  /** The full local column order after the move, kept for the UI/tests. */
  order: string[]
  /** 1-based target position within the column after the move. */
  position: number
  direction: MoveDirection
  requestId: string
}

export interface PriorityWriteOutcome {
  status: PriorityWriteStatus
  /** Human-readable reason; always present for rejected/error. */
  reason: string
  code: string | null
  /** The Host refusal facts, when the Host answered with a refusal object. */
  refusal: {
    accepted: boolean
    executed: boolean
    message: string
    reason: string | null
    blockedByGates: string[]
    localViewOnly: boolean
    audit: { recorded: boolean; sink: string; id: string | null } | null
  } | null
  writeMode: TasksWriteModeFacts | null
  /** The request the UI generated (kept even when refused). */
  request: PriorityWriteRequest
}

let requestCounter = 0

/** Build the semantic write-back request; no verification/approval field exists. */
export function buildPriorityRequest(
  task: TaskboardTask,
  direction: MoveDirection,
  order: readonly string[],
  position: number,
): PriorityWriteRequest {
  requestCounter += 1
  return {
    taskId: task.taskId,
    expectedVersion: task.taskVersion,
    // Semantic token only: the Host has no persisted priority field yet and
    // refuses this command, so nothing stale is invented as a real priority.
    priority: `column-position:${position + 1}`,
    order: [...order],
    position: position + 1,
    direction,
    requestId: `boop-priority-${Date.now().toString(36)}-${requestCounter}`,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textAt(value: unknown, key: string): string | null {
  const entry = asRecord(value)[key]
  return typeof entry === 'string' && entry.length > 0 ? entry : null
}

/**
 * Send the write-back request and report the server's answer verbatim.
 *
 * The Host half (task-6) has exactly one outcome for this command today:
 * `accepted:false` / `executed:false` / `code:'CAPABILITY_UNAVAILABLE'` plus an
 * audit row. The UI shows the refusal message and the audit sink; a `confirmed`
 * status requires BOTH `accepted:true` and `executed:true` from the server, so
 * an empty/failed response can never be mistaken for success.
 */
export async function submitPriorityChange(
  call: TaskboardCall,
  request: PriorityWriteRequest,
): Promise<PriorityWriteOutcome> {
  const base = { request }
  let result: Awaited<ReturnType<TaskboardCall>>
  try {
    result = await call(TASKBOARD_ENDPOINTS.setPriority, args(base.request as unknown as Record<string, unknown>))
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      code: null,
      refusal: null,
      writeMode: null,
      request,
    }
  }
  if (!result.ok) {
    return {
      status: 'error',
      reason: result.error?.message ?? '写回请求失败（宿主未返回原因）',
      code: result.error?.code ?? null,
      refusal: null,
      writeMode: null,
      request,
    }
  }
  const value = asRecord(result.value)
  const accepted = value.accepted === true
  const executed = value.executed === true
  const writeMode = normalizeCapabilities({ writeMode: value.writeMode }).writeMode ?? null
  const auditRaw = asRecord(value.audit)
  const refusal = {
    accepted,
    executed,
    message: textAt(value, 'message') ?? '服务端未给出拒绝说明',
    reason: textAt(value, 'reason'),
    blockedByGates: Array.isArray(value.blockedByGates)
      ? value.blockedByGates.filter((entry): entry is string => typeof entry === 'string')
      : [],
    localViewOnly: value.localViewOnly === true,
    audit:
      Object.keys(auditRaw).length === 0
        ? null
        : {
            recorded: auditRaw.recorded === true,
            sink: textAt(auditRaw, 'sink') ?? 'unknown',
            id: textAt(auditRaw, 'id'),
          },
  }
  if (accepted && executed) {
    return { status: 'confirmed', reason: '服务端已确认优先级写回', code: null, refusal, writeMode, request }
  }
  const code = textAt(value, 'code') ?? 'CAPABILITY_UNAVAILABLE'
  const auditNote = refusal.audit
    ? `（审计：${refusal.audit.sink}${refusal.audit.recorded ? '，已记录' : '，未记录'}）`
    : ''
  const gates = refusal.blockedByGates.length > 0 ? `；blockedBy: ${refusal.blockedByGates.join(', ')}` : ''
  return {
    status: 'rejected',
    reason: `${refusal.message}${gates}${auditNote}`,
    code,
    refusal,
    writeMode,
    request,
  }
}
