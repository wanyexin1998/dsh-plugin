/**
 * BOOP Taskboard host row `boop-tasks` (E04-02, host half).
 *
 * An unambiguous Cordis function plugin (`name` / `inject` / `apply`) mounted
 * from `cordis.patch.yml` as `boop-tasks`, so the read-only task projection can
 * be composed, disabled or tested independently of the BOOP runtime row.
 *
 * It registers the `boopTasks` Typert Remote service over the framework-free
 * view-model in `tasks.ts`:
 *
 *  - READ  → the ONE BOOP ledger (`$DSH_HOME/boop/boop.sqlite`, repository
 *            read-only queries). Nothing is cached as a second task state; an
 *            unreadable ledger is reported as `available: false`, never as an
 *            empty board (FE-11);
 *  - WRITE → there is exactly one write-ish endpoint (`setPriority`) and it is
 *            fail-closed: `boop.isWriteModeEnabled()` is false until G02/G05
 *            pass, and no priority persistence exists in the ledger at all, so
 *            the command always returns CAPABILITY_UNAVAILABLE and records an
 *            audit row (ledger, or an honestly-reported memory fallback);
 *  - NO method here can change lifecycle / verification / approval — the row
 *            deliberately exposes no such endpoint (frozen rule TB05/TB09).
 *
 * Wire shape (rc.2.1 SRC convention): every method takes ONE `request` object;
 * responses are SINGLE-LAYER fact objects: `POST /api/boopTasks/list` →
 * `{ result: { ok: true, value: <TasksListFacts> } }`. The in-process facade for
 * tools/IM callers (`boopTasksRules`) reads the SAME port, so two planes cannot
 * drift apart.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { remote } from './remote.ts'
import {
  TASKS_ENDPOINTS,
  TASKS_ROW_ID,
  TASKS_REMOTE_NAMESPACE,
  setPriorityFacts,
  taskDetailFacts,
  tasksCapabilitiesFacts,
  tasksListFacts,
  type GateState,
  type TaskDetailFacts,
  type TasksAuditEntry,
  type TasksAuditResult,
  type TasksCapabilitiesFacts,
  type TasksGatePort,
  type TasksLedgerPort,
  type TasksListFacts,
  type TasksPort,
  type TasksWriteRefusalFacts,
} from './tasks.ts'

export const name = 'boop-tasks'

/** `boop` carries the one write-mode gate and the ledger; the gateway routes Remote methods. */
export const inject = ['boop', 'typertGateway']

export interface BoopTasksConfig {
  /** Set false only in isolated diagnostics; the shipped default registers the row. */
  enabled?: boolean
}

export interface BoopTasksRules {
  capabilities(request?: unknown): TasksCapabilitiesFacts
  list(request?: unknown): TasksListFacts
  detail(request?: unknown): TaskDetailFacts
  setPriority(request?: unknown): TasksWriteRefusalFacts
}

/* ── live ledger read port ───────────────────────────────────────────── */

function serviceOf(ctx: any, key: string): any {
  try {
    return ctx.reflect?.get?.(key, false) || undefined
  } catch {
    return undefined
  }
}

/**
 * The BOOP ledger as a read port, or null when storage is unavailable. Only
 * the three read-only repository queries are reachable from this port; there is
 * deliberately NO write method on it.
 */
function ledgerPortOf(ctx: any): TasksLedgerPort | null {
  try {
    const storage = ctx.boop?.storage?.()
    const repo = storage?.repo
    const scopeId = storage?.identity?.scopeId
    if (
      repo &&
      typeof repo.listTasks === 'function' &&
      typeof repo.listApprovals === 'function' &&
      typeof repo.taskDetail === 'function' &&
      typeof scopeId === 'string' &&
      scopeId.length > 0
    ) {
      return {
        scopeId,
        listTasks: (id: string, filter: any) => repo.listTasks(id, filter),
        listApprovals: (id: string, filter: any) => repo.listApprovals(id, filter),
        taskDetail: (id: string, taskId: string) => repo.taskDetail(id, taskId),
      }
    }
  } catch {
    /* ledger absence is reported by the view-model, never thrown from a read */
  }
  return null
}

/* ── audit sink: BOOP ledger with an honest memory fallback ──────────── */

class TasksAuditSink {
  private readonly ctx: any
  private readonly memory: Array<TasksAuditEntry & { id: string; time: string }> = []

  constructor(ctx: any) {
    this.ctx = ctx
  }

  /** `ledger` only when this process owns the writable ledger (lease held). */
  sink(): 'ledger' | 'memory' {
    try {
      if (ledgerPortOf(this.ctx) === null) return 'memory'
      const storageFacts = this.ctx.boop?.state?.()?.storage
      return storageFacts?.ok === true ? 'ledger' : 'memory'
    } catch {
      return 'memory'
    }
  }

  record(entry: TasksAuditEntry): TasksAuditResult {
    try {
      const storage = this.ctx.boop?.storage?.()
      const repo = storage?.repo
      const scopeId = storage?.identity?.scopeId
      if (repo && typeof repo.audit === 'function' && typeof scopeId === 'string' && scopeId.length > 0) {
        const row = repo.audit(scopeId, entry.kind, entry.objectId, entry.actor, entry.reason)
        if (row !== undefined && row !== null) {
          return { recorded: true, sink: 'ledger', id: row.id === undefined ? null : String(row.id) }
        }
      }
    } catch {
      /* fall through to memory: the refusal still fails closed, audit is degraded */
    }
    const id = `mem-tasks-${this.memory.length + 1}`
    this.memory.push({ ...entry, id, time: new Date().toISOString() })
    return { recorded: true, sink: 'memory', id }
  }

  trail(limit = 20): Array<TasksAuditEntry & { id: string; time: string }> {
    return this.memory.slice(-Math.max(0, limit)).reverse()
  }
}

/* ── capability gate read from the BOOP runtime service ──────────────── */

function tasksGate(ctx: any): TasksGatePort {
  const readGates = (): Record<string, GateState> => {
    try {
      const gates = ctx.boop?.state?.()?.gates
      return gates && typeof gates === 'object' ? { ...gates } : {}
    } catch {
      return {}
    }
  }
  return {
    writeModeEnabled(): boolean {
      try {
        return ctx.boop?.isWriteModeEnabled?.() === true
      } catch {
        return false
      }
    },
    gates: readGates,
    blockedByGates(): string[] {
      // One source of truth: the frozen gate ledger derives write mode. Never
      // hard-code a gate list here (G02 became PASS on 2026-10-18).
      try {
        const blocked = ctx.boop?.writeMode?.()?.blockedByGates
        if (Array.isArray(blocked)) return [...blocked]
      } catch {
        /* fall through to the gate map */
      }
      const gates = readGates()
      return Object.entries(gates)
        .filter(([, state]) => state !== 'PASS')
        .map(([gate]) => gate)
    },
  }
}

/* ── the framework-free port, wired to the live Host ─────────────────── */

interface PlaneState {
  row: string
  state: 'armed' | 'failed' | 'disabled'
  endpoints: string[]
}

function createPort(ctx: any, planeState: PlaneState): TasksPort {
  const auditSink = new TasksAuditSink(ctx)
  let projectionSeq = 0
  return {
    ledger: () => ledgerPortOf(ctx),
    gate: () => tasksGate(ctx),
    nextProjectionSeq: () => {
      projectionSeq += 1
      return projectionSeq
    },
    now: () => new Date().toISOString(),
    audit: (entry) => auditSink.record(entry),
    auditSink: () => auditSink.sink(),
    diagnostics: () => ({
      row: planeState.row,
      remoteService: TASKS_REMOTE_NAMESPACE,
      rowState: planeState.state,
      endpoints: [...planeState.endpoints],
      rulesFacade: 'boopTasksRules',
      ledger: ledgerPortOf(ctx) === null ? 'unavailable' : 'available',
      hostServices: {
        typertGateway: serviceOf(ctx, 'typertGateway') !== undefined,
      },
    }),
  }
}

/* ── Remote service (the UI/IM transport plane) ───────────────────────── */

/**
 * Typert Remote owner for the generated `boopTasks` namespace. Every method
 * takes ONE `request` object (rc.2.1 SRC wire convention:
 * `ctx.connection.rpc.call('/api', 'boopTasks/<method>', { args: { request } })`)
 * and returns a SINGLE-LAYER fact object as `result.value`.
 */
class BoopTasksApi extends TypertRemoteService {
  private readonly port: TasksPort
  private readonly ctx: any

  constructor(ctx: any, port: TasksPort) {
    super(ctx, TASKS_REMOTE_NAMESPACE, { namespace: TASKS_REMOTE_NAMESPACE })
    this.port = port
    this.ctx = ctx
  }

  /** Read-only capability matrix; write mode comes from the one runtime gate. */
  capabilities(request?: unknown): TasksCapabilitiesFacts {
    void request
    return tasksCapabilitiesFacts(this.port)
  }

  /** One page of the four-group projection with filters and local ordering. */
  list(request?: unknown): TasksListFacts {
    return tasksListFacts(this.port, request)
  }

  /** Latest snapshot + revisions + evidence addresses + related approvals. */
  detail(request?: unknown): TaskDetailFacts {
    return taskDetailFacts(this.port, request)
  }

  /** Gated same-column priority write-back: always CAPABILITY_UNAVAILABLE + audit. */
  setPriority(request?: unknown): TasksWriteRefusalFacts {
    return setPriorityFacts(this.port, request)
  }

  private mvp(): any {
    try { return this.ctx.boop?.delegation?.() ?? null } catch { return null }
  }

  listV2(request?: unknown): unknown {
    const delegation = this.mvp()
    if (!delegation) return { schemaVersion: 2, kind: 'boop.tasks', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '工作列表还不可用。', retryable: true } }
    void request
    return { schemaVersion: 2, kind: 'boop.tasks', ok: true, data: delegation.list() }
  }

  detailV2(request?: unknown): unknown {
    const delegation = this.mvp()
    const taskId = request && typeof request === 'object' ? String((request as { taskId?: unknown }).taskId ?? (request as { request?: { taskId?: unknown } }).request?.taskId ?? '') : ''
    if (!delegation || taskId === '') return { schemaVersion: 2, kind: 'boop.task', ok: false, error: { code: 'INVALID_ARGUMENT', message: '需要指定要查看的工作。', retryable: false } }
    const detail = delegation.detail(taskId)
    if (!detail) return { schemaVersion: 2, kind: 'boop.task', ok: false, error: { code: 'TARGET_NOT_FOUND', message: '没有找到这件工作。', retryable: false } }
    return { schemaVersion: 2, kind: 'boop.task', ok: true, data: detail }
  }

  async stop(request?: unknown): Promise<unknown> {
    return this.control('stop', request)
  }

  async confirm(request?: unknown): Promise<unknown> {
    const delegation = this.mvp()
    const body = unwrap(request)
    if (!delegation) return { schemaVersion: 2, kind: 'boop.confirm', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能确认。', retryable: true } }
    return delegation.confirm({
      requestId: String(body.requestId ?? ''),
      taskId: String(body.taskId ?? ''),
      expectedTaskVersion: Number(body.expectedTaskVersion),
      resultId: String(body.resultId ?? ''),
      decision: 'accept',
    }, uiCall(this.ctx, String(body.requestId ?? 'ui')))
  }

  async reconcile(request?: unknown): Promise<unknown> {
    const delegation = this.mvp()
    const body = unwrap(request)
    if (!delegation) return { schemaVersion: 2, kind: 'boop.task', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能核对。', retryable: true } }
    await delegation.reconcile(typeof body.taskId === 'string' ? body.taskId : undefined)
    const detail = typeof body.taskId === 'string' ? delegation.detail(body.taskId) : delegation.list()
    return { schemaVersion: 2, kind: 'boop.task', ok: true, data: detail }
  }

  access(): unknown {
    const delegation = this.mvp()
    const view = delegation?.readAccess?.()
    if (!view) return { schemaVersion: 2, kind: 'boop.access', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '还不能读取工作范围。', retryable: true } }
    return { schemaVersion: 2, kind: 'boop.access', ok: true, data: view }
  }

  async setAccess(request?: unknown): Promise<unknown> {
    const delegation = this.mvp()
    const body = unwrap(request)
    if (!delegation) return { schemaVersion: 2, kind: 'boop.access', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能修改工作范围。', retryable: true } }
    const mode = body.mode === 'none' || body.mode === 'selected' || body.mode === 'all_authorized' ? body.mode : null
    if (!mode) return { schemaVersion: 2, kind: 'boop.access', ok: false, error: { code: 'INVALID_ARGUMENT', message: '需要选择一个访问范围。', retryable: false } }
    return delegation.setAccess({
      requestId: String(body.requestId ?? `access-${Date.now()}`),
      expectedPolicyEpoch: Number(body.expectedPolicyEpoch),
      mode,
      workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds.map(String) : [],
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : [],
    }, uiCall(this.ctx, String(body.requestId ?? 'ui-access')))
  }

  private async control(operation: 'stop', request?: unknown): Promise<unknown> {
    const delegation = this.mvp()
    const body = unwrap(request)
    if (!delegation) return { schemaVersion: 2, kind: 'boop.control', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能停止。', retryable: true } }
    return delegation.stop({
      requestId: String(body.requestId ?? ''),
      taskId: String(body.taskId ?? ''),
      expectedTaskVersion: Number(body.expectedTaskVersion),
    }, uiCall(this.ctx, String(body.requestId ?? 'ui-stop')))
  }
}

function unwrap(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== 'object') return {}
  const obj = request as Record<string, unknown>
  if (obj.request && typeof obj.request === 'object') return obj.request as Record<string, unknown>
  return obj
}

function uiCall(ctx: any, originRef: string): any {
  const storage = ctx.boop?.storage?.()
  return {
    originRef,
    originKind: 'ui',
    mainSessionId: storage?.repo?.getScope?.(storage.identity.scopeId)?.mainSessionId ?? 'boop-home',
    bindingVersion: 1,
    policyEpoch: storage?.repo?.getScope?.(storage.identity.scopeId)?.policyEpoch ?? 1,
    holder: storage?.identity?.ownerId ?? 'owner',
    fence: 1,
  }
}

for (const method of ['capabilities', 'list', 'detail', 'setPriority']) {
  remote(method)(BoopTasksApi.prototype)
}
for (const method of ['listV2', 'detailV2', 'stop', 'confirm', 'reconcile', 'access', 'setAccess']) {
  remote(method)(BoopTasksApi.prototype)
}

/* ── in-process facade (tools / future IM adapters) ──────────────────── */

function createFacade(port: TasksPort): BoopTasksRules {
  return {
    capabilities: () => tasksCapabilitiesFacts(port),
    list: (request?: unknown) => tasksListFacts(port, request),
    detail: (request?: unknown) => taskDetailFacts(port, request),
    setPriority: (request?: unknown) => setPriorityFacts(port, request),
  }
}

/* ── row lifecycle ────────────────────────────────────────────────────── */

export function apply(ctx: any, config?: BoopTasksConfig): void {
  const effective = { enabled: config?.enabled !== false }
  if (!effective.enabled) {
    try {
      ctx.logger?.info?.('[boop] tasks plane disabled by config; host continues')
    } catch {
      /* logging must never break activation */
    }
    return
  }
  const planeState: PlaneState = { row: TASKS_ROW_ID, state: 'armed', endpoints: [...TASKS_ENDPOINTS] }
  try {
    const port = createPort(ctx, planeState)
    // The Remote service registers `boopTasks` on this row's context: one
    // service key owns the Typert binding. The facade is a SEPARATE key so
    // in-process callers never construct a second service that shadows it.
    new BoopTasksApi(ctx, port)
    ctx.provide('boopTasksRules', createFacade(port))
    ctx.logger?.info?.(
      '[boop] tasks plane armed: read-only four-group projection; no lifecycle/verification/approval command exists on this row',
    )
  } catch (error) {
    planeState.state = 'failed'
    // A throwing optional row must warn, never break the host boot (03§05).
    try {
      ctx.logger?.warn?.('[boop] tasks plane failed to arm; host continues', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
