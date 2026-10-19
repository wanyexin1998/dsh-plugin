/**
 * BOOP structured ledger repository (E01-01).
 *
 * All writes go through the database's single write queue and one transaction
 * per business operation, so a task + its revision + its audit row can never
 * diverge. Optimistic concurrency is explicit: every state change carries the
 * expected version and fails with a typed conflict instead of overwriting.
 *
 * Frozen rules implemented here (03§06, 02§10):
 *  - one task row is the only task state (no second status store);
 *  - three axes (lifecycle / verification / action state) are separate and
 *    never overwrite each other;
 *  - business status changes only through explicit commands, never by drag;
 *  - approval binds to (taskVersion, policyEpoch, payloadHash, nonce) and is
 *    single-use.
 */

import type { ActionState, TaskLife, Verification } from '../../shared/types.ts'
import type { BoopDatabase } from './database.ts'

export class LedgerConflict extends Error {
  readonly code = 'TASK_VERSION_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'LedgerConflict'
  }
}

export class ApprovalConflict extends Error {
  readonly code = 'APPROVAL_STALE'
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalConflict'
  }
}

export interface ScopeRow {
  scopeId: string
  ownerId: string
  mainSessionId: string | null
  policyEpoch: number
  createdAt: string
}

export interface TaskRow {
  id: string
  scopeId: string
  goal: string
  lifecycle: TaskLife
  verification: Verification
  version: number
  criteria: string[]
  exclusions: string[]
  updatedAt: string
}

export interface ActionRow {
  id: string
  scopeId: string
  taskId: string
  taskVersion: number
  targetSessionId: string
  payloadHash: string
  state: ActionState
  messageId: string | null
  policyEpoch: number
  updatedAt: string
}

export interface AuditRow {
  id: string
  scopeId: string
  time: string
  actor: string
  kind: string
  objectId: string | null
  reason: string | null
}

export interface ResourceConflict {
  taskId: string
  sessionId: string
  resourceKey: string
  lifecycle: TaskLife
}

/* ── read-only Taskboard projection types (E04-02) ──────────────────────
 *
 * The Taskboard is a PROJECTION over the one task/action/approval ledger: it
 * never owns a second status store. These shapes exist only for reads; every
 * write still goes through the explicit E01/E02 methods above, so the board
 * cannot change verification or approval through a read/order path.
 */

export type ApprovalStatus = 'pending' | 'allowed' | 'rejected' | 'expired' | 'stale' | 'cancelled'

export interface TaskTargetRow {
  workspaceId: string
  sessionId: string
  role: string
  resourceKey: string
}

export interface TaskActionRow {
  id: string
  scopeId: string
  taskId: string
  taskVersion: number
  targetSessionId: string
  payloadHash: string
  state: ActionState
  messageId: string | null
  policyEpoch: number
  originRef: string
  createdAt: string
  updatedAt: string
}

export interface TaskRevisionRow {
  version: number
  snapshot: unknown
  intentRef: string | null
  createdAt: string
}

/** Why a still-`pending` approval no longer binds to the live plan. */
export type ApprovalInvalidReason = 'expired' | 'task-version-moved' | 'policy-epoch-moved' | null

export interface ApprovalDetailRow {
  id: string
  scopeId: string
  actionId: string
  /** Resolved through `action.task_id`; null when that action row is gone. */
  taskId: string | null
  payloadHash: string
  taskVersion: number
  policyEpoch: number
  requestingOwner: string
  expiresAt: string
  consumedAt: string | null
  status: ApprovalStatus
  /** Computed for `pending` rows only; null = still binds to the live plan. */
  invalidReason: ApprovalInvalidReason
}

export interface TaskProjectionRow {
  id: string
  scopeId: string
  goal: string
  lifecycle: TaskLife
  verification: Verification
  version: number
  criteria: string[]
  exclusions: string[]
  intentRef: string | null
  createdAt: string
  updatedAt: string
  targets: TaskTargetRow[]
  dependencyCount: number
  latestAction: TaskActionRow | null
  pendingApprovals: ApprovalDetailRow[]
  /** Pending rows that still bind (invalidReason === null). */
  validPendingApprovalCount: number
}

export interface TaskListFilter {
  lifecycles?: TaskLife[]
  verifications?: Verification[]
  workspaceId?: string
  sessionId?: string
  /** Case-insensitive title (goal) substring; `%`/`_` are matched literally. */
  goalQuery?: string
  /** true = only tasks with an approval that still binds; false = the complement. */
  hasPendingApproval?: boolean
  limit?: number
  offset?: number
}

export interface TaskListPage {
  items: TaskProjectionRow[]
  /** Exact count of rows matching the filter, before pagination. */
  total: number
  limit: number
  offset: number
  /** More rows exist past this page (`total > offset + items.length`). */
  truncated: boolean
}

export interface ApprovalListFilter {
  statuses?: ApprovalStatus[]
  pendingOnly?: boolean
  taskId?: string
  actionId?: string
  limit?: number
  offset?: number
}

export interface ApprovalListPage {
  items: ApprovalDetailRow[]
  total: number
  limit: number
  offset: number
  truncated: boolean
}

export interface TaskEvidenceRow {
  factId: string
  factVersion: number
  useKind: 'answer' | 'plan' | 'dispatch' | 'verification'
  actionId: string | null
  sessionId: string | null
  seq: number | null
  sourceHash: string
  artifactRef: string | null
}

export interface TaskDetailRow {
  task: TaskProjectionRow
  latestSnapshot: TaskRevisionRow | null
  revisions: TaskRevisionRow[]
  revisionCount: number
  dependsOn: string[]
  dependedOnBy: string[]
  actions: TaskActionRow[]
  actionCount: number
  approvals: ApprovalDetailRow[]
  approvalCount: number
  evidence: TaskEvidenceRow[]
  evidenceCount: number
  /** Which child lists were bounded by {@link TASK_DETAIL_CHILD_LIMIT}. */
  truncated: { revisions: boolean; actions: boolean; approvals: boolean; evidence: boolean; dependedOnBy: boolean }
}

/** Explicit paging caps: a page can never ask the ledger for an unbounded read. */
export const TASK_LIST_DEFAULT_LIMIT = 50
/** Ledger-level ceiling; the Taskboard view-model scans at most this many rows. */
export const TASK_LIST_MAX_LIMIT = 500
export const APPROVAL_LIST_DEFAULT_LIMIT = 50
export const APPROVAL_LIST_MAX_LIMIT = 200
/** Bound on every per-task child list returned by `taskDetail`. */
export const TASK_DETAIL_CHILD_LIMIT = 50

const json = (value: unknown): string => JSON.stringify(value ?? [])
const parse = <T,>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class BoopRepository {
  private readonly store: BoopDatabase
  private readonly now: () => string
  private readonly id: () => string

  constructor(store: BoopDatabase, now: () => string = () => new Date().toISOString(), id: () => string) {
    this.store = store
    this.now = now
    this.id = id
  }

  /* ── scopes ─────────────────────────────────────────────────────────── */

  /**
   * Create the data domain once. A concurrent creator gets the existing row,
   * never a second scope (AT-03: 并发打开不创建重复身份).
   */
  ensureScope(scopeId: string, ownerId: string): ScopeRow {
    const existing = this.getScope(scopeId)
    if (existing) return existing
    try {
      this.store.db
        .prepare(
          'INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES(?,?,?,?,?)',
        )
        .run(scopeId, ownerId, 1, 1, this.now())
    } catch (error) {
      const raced = this.getScope(scopeId)
      if (raced) return raced
      throw error
    }
    const created = this.getScope(scopeId)
    if (!created) throw new Error(`boop: scope ${scopeId} was not created`)
    return created
  }

  getScope(scopeId: string): ScopeRow | null {
    const row = this.store.db
      .prepare('SELECT scope_id, owner_id, main_session_id, policy_epoch, created_at FROM scopes WHERE scope_id = ?')
      .get(scopeId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      scopeId: String(row.scope_id),
      ownerId: String(row.owner_id),
      mainSessionId: row.main_session_id === null ? null : String(row.main_session_id),
      policyEpoch: Number(row.policy_epoch),
      createdAt: String(row.created_at),
    }
  }

  /** Bind the one main Session; a different binding never overwrites it. */
  bindMainSession(scopeId: string, sessionId: string): ScopeRow {
    const scope = this.getScope(scopeId)
    if (!scope) throw new Error(`boop: unknown scope ${scopeId}`)
    if (scope.mainSessionId && scope.mainSessionId !== sessionId) {
      throw new LedgerConflict('this data domain is already bound to another main Session')
    }
    this.store.db
      .prepare('UPDATE scopes SET main_session_id = ? WHERE scope_id = ? AND main_session_id IS NULL')
      .run(sessionId, scopeId)
    return this.getScope(scopeId)!
  }

  bumpPolicyEpoch(scopeId: string): number {
    const scope = this.getScope(scopeId)
    if (!scope) throw new Error(`boop: unknown scope ${scopeId}`)
    const next = scope.policyEpoch + 1
    this.store.db.prepare('UPDATE scopes SET policy_epoch = ? WHERE scope_id = ?').run(next, scopeId)
    return next
  }

  /* ── tasks ──────────────────────────────────────────────────────────── */

  createTask(input: {
    scopeId: string
    goal: string
    criteria?: string[]
    exclusions?: string[]
    intentRef?: string
  }): TaskRow {
    const id = this.id()
    const time = this.now()
    this.store.db
      .prepare(
        'INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.scopeId,
        input.goal,
        'draft',
        'not_requested',
        1,
        json(input.criteria),
        json(input.exclusions),
        input.intentRef ?? null,
        time,
        time,
      )
    this.writeRevision(id, input.scopeId, 1, input.goal, input.criteria ?? [], input.exclusions ?? [], input.intentRef)
    this.audit(input.scopeId, 'task/created', id, 'operator')
    return this.getTask(input.scopeId, id)!
  }

  getTask(scopeId: string, taskId: string): TaskRow | null {
    const row = this.store.db
      .prepare(
        'SELECT id, scope_id, goal, lifecycle, verification, version, criteria_json, exclusions_json, updated_at FROM task WHERE scope_id = ? AND id = ?',
      )
      .get(scopeId, taskId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      scopeId: String(row.scope_id),
      goal: String(row.goal),
      lifecycle: String(row.lifecycle) as TaskLife,
      verification: String(row.verification) as Verification,
      version: Number(row.version),
      criteria: parse<string[]>(String(row.criteria_json), []),
      exclusions: parse<string[]>(String(row.exclusions_json), []),
      updatedAt: String(row.updated_at),
    }
  }

  /**
   * Change one axis of a task under optimistic concurrency.
   *
   * `expectedVersion` is required: a stale caller is refused with
   * TASK_VERSION_CONFLICT (AT-14: 用户改方案后旧动作不得执行).
   */
  updateTask(input: {
    scopeId: string
    taskId: string
    expectedVersion: number
    lifecycle?: TaskLife
    verification?: Verification
    actor?: string
    reason?: string
  }): TaskRow {
    const current = this.getTask(input.scopeId, input.taskId)
    if (!current) throw new Error(`boop: unknown task ${input.taskId}`)
    if (current.version !== input.expectedVersion) {
      throw new LedgerConflict(
        `task ${input.taskId} is at version ${current.version}, expected ${input.expectedVersion}`,
      )
    }
    const lifecycle = input.lifecycle ?? current.lifecycle
    const verification = input.verification ?? current.verification
    if (lifecycle === 'completed' && verification !== 'passed' && verification !== 'waived') {
      throw new LedgerConflict('a completed task needs verification passed or explicitly waived')
    }
    const nextVersion = current.version + 1
    this.store.db
      .prepare('UPDATE task SET lifecycle = ?, verification = ?, version = ?, updated_at = ? WHERE scope_id = ? AND id = ?')
      .run(lifecycle, verification, nextVersion, this.now(), input.scopeId, input.taskId)
    this.writeRevision(
      input.taskId,
      input.scopeId,
      nextVersion,
      current.goal,
      current.criteria,
      current.exclusions,
      undefined,
    )
    this.audit(input.scopeId, 'task/updated', input.taskId, input.actor ?? 'operator', input.reason ?? null)
    return this.getTask(input.scopeId, input.taskId)!
  }

  /** Task snapshot history; every version change is retained (append-only). */
  revisions(scopeId: string, taskId: string): Array<{ version: number; snapshot: unknown; createdAt: string }> {
    const rows = this.store.db
      .prepare(
        'SELECT version, snapshot_json, created_at FROM task_revision WHERE scope_id = ? AND task_id = ? ORDER BY version',
      )
      .all(scopeId, taskId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      version: Number(row.version),
      snapshot: parse<unknown>(String(row.snapshot_json), null),
      createdAt: String(row.created_at),
    }))
  }

  private writeRevision(
    taskId: string,
    scopeId: string,
    version: number,
    goal: string,
    criteria: string[],
    exclusions: string[],
    intentRef?: string,
  ): void {
    this.store.db
      .prepare(
        'INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(taskId, scopeId, version, json({ goal, criteria, exclusions }), intentRef ?? null, this.now())
  }

  /* ── targets, resources, dependencies ───────────────────────────────── */

  /** Two tasks may not hold the same resource key in an active lifecycle. */
  assertResourceFree(input: {
    scopeId: string
    taskId: string
    sessionId: string
    resourceKey: string
  }): void {
    const rows = this.store.db
      .prepare(
        `SELECT t.id, t.lifecycle, tt.resource_key FROM task_target tt JOIN task t ON t.id = tt.task_id AND t.scope_id = tt.scope_id
         WHERE tt.scope_id = ? AND tt.resource_key = ? AND tt.task_id <> ?
           AND t.lifecycle IN ('draft','active','paused','blocked','recovery_required')`,
      )
      .all(input.scopeId, input.resourceKey, input.taskId) as Array<Record<string, unknown>>
    if (rows.length > 0) {
      throw new LedgerConflict(
        `resource ${input.resourceKey} is already held by task ${String(rows[0].id)} (${String(rows[0].lifecycle)})`,
      )
    }
  }

  addTarget(input: {
    scopeId: string
    taskId: string
    workspaceId: string
    sessionId: string
    role: string
    resourceKey: string
  }): void {
    this.assertResourceFree(input)
    this.store.db
      .prepare(
        'INSERT INTO task_target(task_id,scope_id,workspace_id,session_id,role,resource_key) VALUES(?,?,?,?,?,?)',
      )
      .run(input.taskId, input.scopeId, input.workspaceId, input.sessionId, input.role, input.resourceKey)
  }

  /** Tasks currently holding a session — used by dispatch and by the board. */
  holdersOfSession(scopeId: string, sessionId: string): ResourceConflict[] {
    const rows = this.store.db
      .prepare(
        `SELECT t.id, t.lifecycle, tt.resource_key, tt.session_id FROM task_target tt JOIN task t ON t.id = tt.task_id AND t.scope_id = tt.scope_id
         WHERE tt.scope_id = ? AND tt.session_id = ? AND t.lifecycle NOT IN ('completed','cancelled')`,
      )
      .all(scopeId, sessionId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      taskId: String(row.id),
      sessionId: String(row.session_id),
      resourceKey: String(row.resource_key),
      lifecycle: String(row.lifecycle) as TaskLife,
    }))
  }

  /** Transitive cycle check: a dependency graph must stay a DAG (02§10). */
  addDependency(input: { scopeId: string; taskId: string; dependsOn: string }): void {
    if (input.taskId === input.dependsOn) throw new LedgerConflict('a task cannot depend on itself')
    // Build the whole scope adjacency so transitive reachability is complete.
    const all = this.store.db
      .prepare('SELECT task_id, depends_on FROM task_dependency WHERE scope_id = ?')
      .all(input.scopeId) as Array<{ task_id: string; depends_on: string }>
    const graph = new Map<string, string[]>()
    for (const edge of all) graph.set(edge.task_id, [...(graph.get(edge.task_id) ?? []), edge.depends_on])
    // Adding `taskId -> dependsOn` closes a cycle exactly when `dependsOn`
    // already reaches `taskId` through the existing graph.
    if (reaches(graph, input.dependsOn, input.taskId)) {
      throw new LedgerConflict('the dependency would create a cycle')
    }
    this.store.db
      .prepare('INSERT INTO task_dependency(task_id,depends_on,scope_id) VALUES(?,?,?)')
      .run(input.taskId, input.dependsOn, input.scopeId)
  }

  /* ── actions + outbox ──────────────────────────────────────────────── */

  /** Record one action in `dispatching` and enqueue it in the same transaction. */
  beginAction(input: {
    scopeId: string
    taskId: string
    expectedTaskVersion: number
    targetSessionId: string
    payloadHash: string
    payload: unknown
    originRef: string
    policyEpoch: number
  }): ActionRow {
    const task = this.getTask(input.scopeId, input.taskId)
    if (!task) throw new Error(`boop: unknown task ${input.taskId}`)
    if (task.version !== input.expectedTaskVersion) {
      throw new LedgerConflict(
        `task ${input.taskId} moved to version ${task.version}; the planned action is stale`,
      )
    }
    const id = this.id()
    const time = this.now()
    this.store.db
      .prepare(
        'INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.scopeId,
        input.taskId,
        input.expectedTaskVersion,
        input.targetSessionId,
        input.payloadHash,
        json(input.payload),
        'dispatching',
        null,
        null,
        input.policyEpoch,
        input.originRef,
        time,
        time,
      )
    this.store.db
      .prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)')
      .run(id, input.scopeId, 'prepared', 0)
    this.audit(input.scopeId, 'action/started', id, 'operator')
    return this.getAction(input.scopeId, id)!
  }

  getAction(scopeId: string, actionId: string): ActionRow | null {
    const row = this.store.db
      .prepare(
        'SELECT id, scope_id, task_id, task_version, target_session_id, payload_hash, state, message_id, policy_epoch, updated_at FROM action WHERE scope_id = ? AND id = ?',
      )
      .get(scopeId, actionId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      scopeId: String(row.scope_id),
      taskId: String(row.task_id),
      taskVersion: Number(row.task_version),
      targetSessionId: String(row.target_session_id),
      payloadHash: String(row.payload_hash),
      state: String(row.state) as ActionState,
      messageId: row.message_id === null ? null : String(row.message_id),
      policyEpoch: Number(row.policy_epoch),
      updatedAt: String(row.updated_at),
    }
  }

  markActionState(scopeId: string, actionId: string, state: ActionState, messageId?: string): ActionRow {
    this.store.db
      .prepare('UPDATE action SET state = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE scope_id = ? AND id = ?')
      .run(state, messageId ?? null, this.now(), scopeId, actionId)
    return this.getAction(scopeId, actionId)!
  }

  /** Outbox claims are short leases: a stuck sender never blocks the queue. */
  claimOutbox(scopeId: string, leaseMs: number): Array<{ actionId: string; attempt: number }> {
    const now = this.now()
    const until = new Date(Date.parse(now) + leaseMs).toISOString()
    const rows = this.store.db
      .prepare(
        `SELECT action_id, attempt FROM command_outbox WHERE scope_id = ?
           AND state IN ('prepared','blocked') AND (lease_until IS NULL OR lease_until <= ?)`,
      )
      .all(scopeId, now) as Array<Record<string, unknown>>
    const claimed: Array<{ actionId: string; attempt: number }> = []
    for (const row of rows) {
      const actionId = String(row.action_id)
      const attempt = Number(row.attempt)
      this.store.db
        .prepare("UPDATE command_outbox SET state = 'sending', attempt = attempt + 1, lease_until = ? WHERE scope_id = ? AND action_id = ?")
        .run(until, scopeId, actionId)
      claimed.push({ actionId, attempt: attempt + 1 })
    }
    return claimed
  }

  settleOutbox(scopeId: string, actionId: string, state: 'accepted' | 'unknown' | 'blocked' | 'cancelled', receipt?: unknown): void {
    this.store.db
      .prepare('UPDATE command_outbox SET state = ?, lease_until = NULL, receipt_json = ? WHERE scope_id = ? AND action_id = ?')
      .run(state, receipt === undefined ? null : json(receipt), scopeId, actionId)
  }

  /**
   * Reconciliation on boot: a `sending` row with no matching action outcome is
   * `unknown`, and an unknown command is never retried automatically
   * (02§09: unknown 不重试).
   */
  reconcileOutbox(scopeId: string): { unknown: string[]; retryable: number } {
    const stuck = this.store.db
      .prepare("SELECT action_id FROM command_outbox WHERE scope_id = ? AND state = 'sending'")
      .all(scopeId) as Array<{ action_id: string }>
    for (const row of stuck) {
      const action = this.getAction(scopeId, row.action_id)
      if (action && action.state === 'dispatching') {
        this.markActionState(scopeId, row.action_id, 'outcome_unknown')
      }
      this.settleOutbox(scopeId, row.action_id, 'unknown')
    }
    const prepared = this.store.db
      .prepare("SELECT count(*) c FROM command_outbox WHERE scope_id = ? AND state IN ('prepared','blocked')")
      .get(scopeId) as { c: number }
    return { unknown: stuck.map((row) => row.action_id), retryable: Number(prepared.c) }
  }

  /* ── approvals ─────────────────────────────────────────────────────── */

  createApproval(input: {
    scopeId: string
    actionId: string
    payloadHash: string
    taskVersion: number
    policyEpoch: number
    requestingOwner: string
    nonceHash: string
    expiresAt: string
  }): { id: string } {
    const id = this.id()
    this.store.db
      .prepare(
        'INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.scopeId,
        input.actionId,
        input.payloadHash,
        input.taskVersion,
        input.policyEpoch,
        input.requestingOwner,
        input.nonceHash,
        input.expiresAt,
        'pending',
      )
    return { id }
  }

  /**
   * Single-use approval bound to the exact object version (03§10).
   * Returns the new status; never throws for an ordinary "already handled"
   * case so the UI can stay idempotent.
   */
  consumeApproval(input: {
    scopeId: string
    approvalId: string
    nonceHash: string
    payloadHash: string
    taskVersion: number
    policyEpoch: number
  }): { status: 'allowed' | 'rejected' | 'expired' | 'stale' | 'cancelled' | 'not_found' } {
    const row = this.store.db
      .prepare('SELECT * FROM approval WHERE scope_id = ? AND id = ?')
      .get(input.scopeId, input.approvalId) as Record<string, unknown> | undefined
    if (!row) return { status: 'not_found' }
    const current = String(row.status) as string
    if (current === 'consumed' || current === 'allowed') return { status: 'allowed' }
    if (current !== 'pending') return { status: current as 'rejected' | 'expired' | 'stale' | 'cancelled' }
    if (String(row.nonce_hash) !== input.nonceHash) return { status: 'stale' }
    if (String(row.payload_hash) !== input.payloadHash) return { status: 'stale' }
    if (Number(row.task_version) !== input.taskVersion) return { status: 'stale' }
    if (Number(row.policy_epoch) !== input.policyEpoch) return { status: 'stale' }
    if (String(row.expires_at) <= this.now()) {
      this.store.db.prepare("UPDATE approval SET status = 'expired' WHERE scope_id = ? AND id = ?").run(input.scopeId, input.approvalId)
      return { status: 'expired' }
    }
    this.store.db
      .prepare("UPDATE approval SET status = 'allowed', consumed_at = ? WHERE scope_id = ? AND id = ?")
      .run(this.now(), input.scopeId, input.approvalId)
    this.audit(input.scopeId, 'approval/consumed', String(row.action_id), 'operator')
    return { status: 'allowed' }
  }

  /**
   * Invalidate approvals that no longer bind to the live plan (04§S05:
   * "参数或任务变化 → 原卡变为已失效").
   */
  expireStaleApprovals(scopeId: string, current: { taskVersion: number; policyEpoch: number }): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT id FROM approval WHERE scope_id = ? AND status = 'pending'
           AND (task_version <> ? OR policy_epoch <> ?)`,
      )
      .all(scopeId, current.taskVersion, current.policyEpoch) as Array<{ id: string }>
    for (const row of rows) {
      this.store.db.prepare("UPDATE approval SET status = 'stale' WHERE scope_id = ? AND id = ?").run(scopeId, row.id)
    }
    if (rows.length > 0) this.audit(scopeId, 'approval/expired', null, 'system', `${rows.length} cards invalidated`)
    return rows.map((row) => row.id)
  }

  rejectApproval(scopeId: string, approvalId: string): void {
    this.store.db.prepare("UPDATE approval SET status = 'rejected' WHERE scope_id = ? AND id = ?").run(scopeId, approvalId)
  }

  /* ── read-only Taskboard projections (E04-02) ───────────────────────── */
  /*
   * Everything below is READ ONLY: no insert/update/delete, no audit row, no
   * cursor. The board projects the one ledger; it never becomes a second task
   * state store and can never move verification/approval.
   *
   * Query budget: `listTasks` is a constant number of statements (tasks +
   * targets + dependency counts + latest actions + pending approvals +
   * policy epoch) for a whole page, never one query per task.
   */

  /**
   * One page of tasks with targets, dependency count, latest action and
   * still-binding approvals. Exact `total` comes from SQL; paging caps are
   * explicit ({@link TASK_LIST_MAX_LIMIT}).
   */
  listTasks(scopeId: string, filter: TaskListFilter = {}): TaskListPage {
    const limit = clampInt(filter.limit, TASK_LIST_DEFAULT_LIMIT, 1, TASK_LIST_MAX_LIMIT)
    const offset = clampInt(filter.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const policyEpoch = this.policyEpochOf(scopeId)
    const { where, params } = taskFilterSql(scopeId, filter, policyEpoch, this.now())
    const total = Number(
      (this.store.db.prepare(`SELECT count(*) c FROM task t WHERE ${where}`).get(...params) as { c: number }).c,
    )
    const rows = this.store.db
      .prepare(
        `SELECT t.id, t.scope_id, t.goal, t.lifecycle, t.verification, t.version, t.criteria_json,
                t.exclusions_json, t.intent_ref, t.created_at, t.updated_at
           FROM task t
          WHERE ${where}
          ORDER BY t.updated_at DESC, t.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>
    const items = this.enrichTasks(scopeId, rows, policyEpoch)
    return { items, total, limit, offset, truncated: total > offset + items.length }
  }

  /**
   * One page of approvals with their bound `(taskVersion, policyEpoch)` and a
   * computed `invalidReason` for rows that are still `pending` but no longer
   * bind to the live plan. Read-only: an expired pending row is REPORTED as
   * expired here; only consumption may persist that transition.
   */
  listApprovals(scopeId: string, filter: ApprovalListFilter = {}): ApprovalListPage {
    const limit = clampInt(filter.limit, APPROVAL_LIST_DEFAULT_LIMIT, 1, APPROVAL_LIST_MAX_LIMIT)
    const offset = clampInt(filter.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const policyEpoch = this.policyEpochOf(scopeId)
    const clauses = ['a.scope_id = ?']
    const params: unknown[] = [scopeId]
    if (filter.pendingOnly === true) {
      clauses.push("a.status = 'pending'")
    } else if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`a.status IN (${placeholders(filter.statuses.length)})`)
      params.push(...filter.statuses)
    }
    if (typeof filter.taskId === 'string' && filter.taskId.length > 0) {
      clauses.push('ac.task_id = ?')
      params.push(filter.taskId)
    }
    if (typeof filter.actionId === 'string' && filter.actionId.length > 0) {
      clauses.push('a.action_id = ?')
      params.push(filter.actionId)
    }
    const from = `FROM approval a LEFT JOIN action ac ON ac.id = a.action_id AND ac.scope_id = a.scope_id WHERE ${clauses.join(' AND ')}`
    const total = Number((this.store.db.prepare(`SELECT count(*) c ${from}`).get(...params) as { c: number }).c)
    const rows = this.store.db
      .prepare(
        `SELECT a.id, a.scope_id, a.action_id, ac.task_id, a.payload_hash, a.task_version, a.policy_epoch,
                a.requesting_owner, a.expires_at, a.consumed_at, a.status
           ${from}
          ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.expires_at ASC, a.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>
    const versions = this.currentTaskVersions(scopeId, rows.map((row) => String(row.task_id ?? '')))
    const now = this.now()
    const items = rows.map((row) => mapApprovalRow(row, versions, policyEpoch, now))
    return { items, total, limit, offset, truncated: total > offset + items.length }
  }

  /**
   * Full read-only detail of one task: latest snapshot + bounded revision
   * summaries, targets, dependencies both ways, recent actions, every related
   * approval, and evidence addresses consumed by this task.
   *
   * Returns null only when the task does not exist in THIS scope (a wrong
   * scope reads as absent, never as another domain's task).
   */
  taskDetail(scopeId: string, taskId: string): TaskDetailRow | null {
    const policyEpoch = this.policyEpochOf(scopeId)
    const row = this.store.db
      .prepare(
        `SELECT t.id, t.scope_id, t.goal, t.lifecycle, t.verification, t.version, t.criteria_json,
                t.exclusions_json, t.intent_ref, t.created_at, t.updated_at
           FROM task t
          WHERE t.scope_id = ? AND t.id = ?`,
      )
      .get(scopeId, taskId) as Record<string, unknown> | undefined
    if (!row) return null
    const task = this.enrichTasks(scopeId, [row], policyEpoch)[0]!

    const revisionCount = Number(
      (
        this.store.db
          .prepare('SELECT count(*) c FROM task_revision WHERE scope_id = ? AND task_id = ?')
          .get(scopeId, taskId) as { c: number }
      ).c,
    )
    const revisionRows = this.store.db
      .prepare(
        `SELECT version, snapshot_json, intent_ref, created_at FROM task_revision
          WHERE scope_id = ? AND task_id = ?
          ORDER BY version DESC
          LIMIT ?`,
      )
      .all(scopeId, taskId, TASK_DETAIL_CHILD_LIMIT) as Array<Record<string, unknown>>
    const revisions = revisionRows.map((entry) => mapRevisionRow(entry))

    const actionCount = Number(
      (this.store.db.prepare('SELECT count(*) c FROM action WHERE scope_id = ? AND task_id = ?').get(scopeId, taskId) as { c: number }).c,
    )
    const actionRows = this.store.db
      .prepare(
        `SELECT id, scope_id, task_id, task_version, target_session_id, payload_hash, state, message_id,
                policy_epoch, origin_ref, created_at, updated_at
           FROM action
          WHERE scope_id = ? AND task_id = ?
          ORDER BY updated_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(scopeId, taskId, TASK_DETAIL_CHILD_LIMIT) as Array<Record<string, unknown>>
    const actions = actionRows.map((entry) => mapTaskActionRow(entry))

    const approvals = this.listApprovals(scopeId, { taskId, limit: TASK_DETAIL_CHILD_LIMIT })
    const approvalCount = approvals.total

    const dependsOn = (
      this.store.db
        .prepare('SELECT depends_on FROM task_dependency WHERE scope_id = ? AND task_id = ? ORDER BY depends_on')
        .all(scopeId, taskId) as Array<{ depends_on: string }>
    ).map((entry) => String(entry.depends_on))
    const dependedOnByCount = Number(
      (
        this.store.db
          .prepare('SELECT count(*) c FROM task_dependency WHERE scope_id = ? AND depends_on = ?')
          .get(scopeId, taskId) as { c: number }
      ).c,
    )
    const dependedOnBy = (
      this.store.db
        .prepare(
          'SELECT task_id FROM task_dependency WHERE scope_id = ? AND depends_on = ? ORDER BY task_id LIMIT ?',
        )
        .all(scopeId, taskId, TASK_DETAIL_CHILD_LIMIT) as Array<{ task_id: string }>
    ).map((entry) => String(entry.task_id))

    const evidenceFrom = `FROM fact_consumption fc
        LEFT JOIN fact_evidence fe ON fe.fact_id = fc.fact_id AND fe.scope_id = fc.scope_id
       WHERE fc.scope_id = ? AND fc.task_id = ?`
    const evidenceCount = Number(
      (this.store.db.prepare(`SELECT count(*) c ${evidenceFrom}`).get(scopeId, taskId) as { c: number }).c,
    )
    const evidenceRows = this.store.db
      .prepare(
        `SELECT fc.fact_id, fc.fact_version, fc.use_kind, fc.action_id, fe.session_id, fe.seq,
                fe.source_hash, fe.artifact_ref
           ${evidenceFrom}
          ORDER BY fc.fact_id, fc.fact_version, fe.session_id, fe.seq
          LIMIT ?`,
      )
      .all(scopeId, taskId, TASK_DETAIL_CHILD_LIMIT) as Array<Record<string, unknown>>

    return {
      task,
      latestSnapshot: revisions[0] ?? null,
      revisions,
      revisionCount,
      dependsOn,
      dependedOnBy,
      actions,
      actionCount,
      approvals: approvals.items,
      approvalCount,
      evidence: evidenceRows.map((entry) => mapEvidenceRow(entry)),
      evidenceCount,
      truncated: {
        revisions: revisionCount > revisions.length,
        actions: actionCount > actions.length,
        approvals: approvalCount > approvals.items.length,
        evidence: evidenceCount > evidenceRows.length,
        dependedOnBy: dependedOnByCount > dependedOnBy.length,
      },
    }
  }

  /** Current policy epoch of the data domain (1 when the scope row is absent). */
  private policyEpochOf(scopeId: string): number {
    const row = this.store.db.prepare('SELECT policy_epoch FROM scopes WHERE scope_id = ?').get(scopeId) as
      | { policy_epoch: number }
      | undefined
    return row === undefined ? 1 : Number(row.policy_epoch)
  }

  /** Enrich one page of `task` rows with child facts using a constant query count. */
  private enrichTasks(
    scopeId: string,
    rows: Array<Record<string, unknown>>,
    policyEpoch: number,
  ): TaskProjectionRow[] {
    if (rows.length === 0) return []
    const ids = rows.map((row) => String(row.id))
    const marks = placeholders(ids.length)

    const targetsByTask = new Map<string, TaskTargetRow[]>()
    const targetRows = this.store.db
      .prepare(
        `SELECT task_id, workspace_id, session_id, role, resource_key FROM task_target
          WHERE scope_id = ? AND task_id IN (${marks})
          ORDER BY task_id, CASE role WHEN 'primary' THEN 0 ELSE 1 END, workspace_id, session_id`,
      )
      .all(scopeId, ...ids) as Array<Record<string, unknown>>
    for (const entry of targetRows) {
      const taskId = String(entry.task_id)
      const list = targetsByTask.get(taskId) ?? []
      list.push({
        workspaceId: String(entry.workspace_id),
        sessionId: String(entry.session_id),
        role: String(entry.role),
        resourceKey: String(entry.resource_key),
      })
      targetsByTask.set(taskId, list)
    }

    const dependencyCounts = new Map<string, number>()
    const dependencyRows = this.store.db
      .prepare(
        `SELECT task_id, count(*) c FROM task_dependency
          WHERE scope_id = ? AND task_id IN (${marks}) GROUP BY task_id`,
      )
      .all(scopeId, ...ids) as Array<{ task_id: string; c: number }>
    for (const entry of dependencyRows) dependencyCounts.set(String(entry.task_id), Number(entry.c))

    const latestActions = this.latestActions(scopeId, ids)
    const approvalsByTask = this.pendingApprovalsForTasks(scopeId, ids, policyEpoch)

    return rows.map((row) => {
      const id = String(row.id)
      const pendingApprovals = approvalsByTask.get(id) ?? []
      return {
        id,
        scopeId: String(row.scope_id),
        goal: String(row.goal),
        lifecycle: String(row.lifecycle) as TaskLife,
        verification: String(row.verification) as Verification,
        version: Number(row.version),
        criteria: parse<string[]>(String(row.criteria_json), []),
        exclusions: parse<string[]>(String(row.exclusions_json), []),
        intentRef: row.intent_ref === null || row.intent_ref === undefined ? null : String(row.intent_ref),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        targets: targetsByTask.get(id) ?? [],
        dependencyCount: dependencyCounts.get(id) ?? 0,
        latestAction: latestActions.get(id) ?? null,
        pendingApprovals,
        validPendingApprovalCount: pendingApprovals.filter((approval) => approval.invalidReason === null).length,
      }
    })
  }

  /** Latest action per task (one statement for the whole page). */
  private latestActions(scopeId: string, taskIds: string[]): Map<string, TaskActionRow> {
    if (taskIds.length === 0) return new Map()
    const marks = placeholders(taskIds.length)
    const rows = this.store.db
      .prepare(
        `SELECT a.rowid AS rid, a.id, a.scope_id, a.task_id, a.task_version, a.target_session_id, a.payload_hash,
                a.state, a.message_id, a.policy_epoch, a.origin_ref, a.created_at, a.updated_at
           FROM action a
           JOIN (
             SELECT task_id, MAX(updated_at) AS newest FROM action
              WHERE scope_id = ? AND task_id IN (${marks}) GROUP BY task_id
           ) latest ON latest.task_id = a.task_id AND latest.newest = a.updated_at
          WHERE a.scope_id = ?
          ORDER BY a.rowid DESC`,
      )
      .all(scopeId, ...taskIds, scopeId) as Array<Record<string, unknown>>
    const latest = new Map<string, TaskActionRow>()
    for (const row of rows) {
      const taskId = String(row.task_id)
      if (!latest.has(taskId)) latest.set(taskId, mapTaskActionRow(row))
    }
    return latest
  }

  /** Still-`pending` approvals per task, with their computed invalid reason. */
  private pendingApprovalsForTasks(
    scopeId: string,
    taskIds: string[],
    policyEpoch: number,
  ): Map<string, ApprovalDetailRow[]> {
    if (taskIds.length === 0) return new Map()
    const marks = placeholders(taskIds.length)
    const rows = this.store.db
      .prepare(
        `SELECT a.id, a.scope_id, a.action_id, ac.task_id, a.payload_hash, a.task_version, a.policy_epoch,
                a.requesting_owner, a.expires_at, a.consumed_at, a.status
           FROM approval a
           JOIN action ac ON ac.id = a.action_id AND ac.scope_id = a.scope_id
          WHERE a.scope_id = ? AND ac.task_id IN (${marks}) AND a.status = 'pending'
          ORDER BY a.expires_at ASC, a.id ASC`,
      )
      .all(scopeId, ...taskIds) as Array<Record<string, unknown>>
    const versions = this.currentTaskVersions(scopeId, taskIds)
    const now = this.now()
    const grouped = new Map<string, ApprovalDetailRow[]>()
    for (const row of rows) {
      const taskId = row.task_id === null || row.task_id === undefined ? null : String(row.task_id)
      if (taskId === null) continue
      const list = grouped.get(taskId) ?? []
      list.push(mapApprovalRow(row, versions, policyEpoch, now))
      grouped.set(taskId, list)
    }
    return grouped
  }

  /** `{ taskId: version }` for one page of ids (one statement). */
  private currentTaskVersions(scopeId: string, taskIds: string[]): Map<string, number> {
    const unique = [...new Set(taskIds.filter((id) => id.length > 0))]
    if (unique.length === 0) return new Map()
    const rows = this.store.db
      .prepare(`SELECT id, version FROM task WHERE scope_id = ? AND id IN (${placeholders(unique.length)})`)
      .all(scopeId, ...unique) as Array<{ id: string; version: number }>
    return new Map(rows.map((row) => [String(row.id), Number(row.version)]))
  }

  /* ── memory facts + snapshots ──────────────────────────────────────── */

  upsertFact(input: {
    scopeId: string
    factId: string
    ownerType: string
    ownerId: string
    kind: string
    text: string
    authority: string
    status?: string
    validTime?: string
  }): { version: number } {
    const time = this.now()
    const existing = this.store.db
      .prepare('SELECT version FROM fact WHERE scope_id = ? AND id = ?')
      .get(input.scopeId, input.factId) as { version: number } | undefined
    const version = existing ? Number(existing.version) + 1 : 1
    if (existing) {
      this.store.db
        .prepare('UPDATE fact SET text = ?, status = ?, authority = ?, valid_time = ?, version = ?, updated_at = ? WHERE scope_id = ? AND id = ?')
        .run(input.text, input.status ?? 'active', input.authority, input.validTime ?? null, version, time, input.scopeId, input.factId)
    } else {
      this.store.db
        .prepare(
          'INSERT INTO fact(id,scope_id,owner_type,owner_id,kind,text,status,authority,valid_time,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(input.factId, input.scopeId, input.ownerType, input.ownerId, input.kind, input.text, input.status ?? 'active', input.authority, input.validTime ?? null, version, time, time)
    }
    this.store.db
      .prepare('INSERT INTO fact_version(fact_id,scope_id,version,snapshot_json,created_at) VALUES(?,?,?,?,?)')
      .run(input.factId, input.scopeId, version, json({ text: input.text, authority: input.authority, kind: input.kind }), time)
    return { version }
  }

  addEvidence(input: {
    scopeId: string
    factId: string
    sessionId?: string
    seq?: number
    sourceHash: string
    artifactRef?: string
  }): void {
    this.store.db
      .prepare('INSERT INTO fact_evidence(id,fact_id,scope_id,session_id,seq,source_hash,artifact_ref) VALUES(?,?,?,?,?,?,?)')
      .run(this.id(), input.factId, input.scopeId, input.sessionId ?? null, input.seq ?? null, input.sourceHash, input.artifactRef ?? null)
  }

  /**
   * Memory snapshot with an explicit baseline check (03§14 CAS):
   * a stale writer is refused instead of overwriting a newer snapshot.
   */
  saveMemorySnapshot(input: {
    scopeId: string
    ownerType: string
    ownerId: string
    body: string
    coverage: Record<string, { sourceGeneration: string; throughSeq: number }>
    expectedBaselineVersion: number
  }): { version: number } {
    const current = this.store.db
      .prepare(
        'SELECT max(version) v FROM memory_snapshot WHERE scope_id = ? AND owner_type = ? AND owner_id = ?',
      )
      .get(input.scopeId, input.ownerType, input.ownerId) as { v: number | null }
    const baseline = current.v === null ? 0 : Number(current.v)
    if (baseline !== input.expectedBaselineVersion) {
      throw new LedgerConflict(
        `memory baseline is ${baseline}, the proposal expected ${input.expectedBaselineVersion}`,
      )
    }
    const version = baseline + 1
    this.store.db
      .prepare('INSERT INTO memory_snapshot(scope_id,owner_type,owner_id,version,body,coverage_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(input.scopeId, input.ownerType, input.ownerId, version, input.body, json(input.coverage), this.now())
    return { version }
  }

  /** Latest snapshot version for one owner, or 0 when none exists (CAS base). */
  currentVersion(scopeId: string, ownerType: string, ownerId: string): number {
    const row = this.store.db
      .prepare('SELECT max(version) v FROM memory_snapshot WHERE scope_id = ? AND owner_type = ? AND owner_id = ?')
      .get(scopeId, ownerType, ownerId) as { v: number | null }
    return row.v === null ? 0 : Number(row.v)
  }

  /** Effective facts of one owner, newest version per fact id. */
  facts(scopeId: string, ownerType: string, ownerId: string): Array<{
    factId: string
    kind: string
    text: string
    status: string
    authority: string
    version: number
  }> {
    const rows = this.store.db
      .prepare('SELECT id, kind, text, status, authority, version FROM fact WHERE scope_id = ? AND owner_type = ? AND owner_id = ? ORDER BY id, version')
      .all(scopeId, ownerType, ownerId) as Array<Record<string, unknown>>
    const latest = new Map<string, Record<string, unknown>>()
    for (const row of rows) latest.set(String(row.id), row)
    return [...latest.values()].map((row) => ({
      factId: String(row.id),
      kind: String(row.kind),
      text: String(row.text),
      status: String(row.status),
      authority: String(row.authority),
      version: Number(row.version),
    }))
  }

  latestMemorySnapshot(scopeId: string, ownerType: string, ownerId: string): { version: number; body: string; coverage: unknown } | null {
    const row = this.store.db
      .prepare('SELECT version, body, coverage_json FROM memory_snapshot WHERE scope_id = ? AND owner_type = ? AND owner_id = ? ORDER BY version DESC LIMIT 1')
      .get(scopeId, ownerType, ownerId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      version: Number(row.version),
      body: String(row.body),
      coverage: parse<unknown>(String(row.coverage_json), {}),
    }
  }

  /* ── source cursors (E03-01 foundation) ─────────────────────────────── */

  upsertCursor(input: {
    scopeId: string
    sessionId: string
    sourceGeneration: string
    throughSeq: number
    state: 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded'
  }): void {
    this.store.db
      .prepare(
        `INSERT INTO source_cursor(scope_id,session_id,source_generation,through_seq,state) VALUES(?,?,?,?,?)
         ON CONFLICT(scope_id,session_id,source_generation) DO UPDATE SET through_seq = excluded.through_seq, state = excluded.state`,
      )
      .run(input.scopeId, input.sessionId, input.sourceGeneration, input.throughSeq, input.state)
  }

  cursors(scopeId: string): Array<{ sessionId: string; sourceGeneration: string; throughSeq: number; state: string }> {
    const rows = this.store.db
      .prepare('SELECT session_id, source_generation, through_seq, state FROM source_cursor WHERE scope_id = ?')
      .all(scopeId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      sourceGeneration: String(row.source_generation),
      throughSeq: Number(row.through_seq),
      state: String(row.state),
    }))
  }

  /* ── audit ─────────────────────────────────────────────────────────── */

  audit(scopeId: string, kind: string, objectId: string | null, actor: string, reason: string | null = null): AuditRow {
    const row: AuditRow = {
      id: this.id(),
      scopeId,
      time: this.now(),
      actor,
      kind,
      objectId,
      reason,
    }
    this.store.db
      .prepare('INSERT INTO audit_event(id,scope_id,time,actor,kind,object_id,reason) VALUES(?,?,?,?,?,?,?)')
      .run(row.id, row.scopeId, row.time, row.actor, row.kind, row.objectId, row.reason)
    return row
  }

  auditTrail(scopeId: string, limit = 50): AuditRow[] {
    const rows = this.store.db
      .prepare('SELECT id, scope_id, time, actor, kind, object_id, reason FROM audit_event WHERE scope_id = ? ORDER BY time DESC LIMIT ?')
      .all(scopeId, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      scopeId: String(row.scope_id),
      time: String(row.time),
      actor: String(row.actor),
      kind: String(row.kind),
      objectId: row.object_id === null ? null : String(row.object_id),
      reason: row.reason === null ? null : String(row.reason),
    }))
  }
}

function reaches(graph: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>()
  const stack = [...(graph.get(from) ?? [])]
  while (stack.length) {
    const node = stack.pop()!
    if (node === target) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(graph.get(node) ?? []))
  }
  return false
}

/* ── read-only projection helpers (E04-02) ────────────────────────────── */

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

/** Clamp a caller-supplied page bound into `[min, max]`; bad input falls back. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** WHERE clause for `listTasks`; every predicate is resolvable in one statement. */
function taskFilterSql(
  scopeId: string,
  filter: TaskListFilter,
  policyEpoch: number,
  now: string,
): { where: string; params: unknown[] } {
  const clauses = ['t.scope_id = ?']
  const params: unknown[] = [scopeId]
  if (Array.isArray(filter.lifecycles) && filter.lifecycles.length > 0) {
    clauses.push(`t.lifecycle IN (${placeholders(filter.lifecycles.length)})`)
    params.push(...filter.lifecycles)
  }
  if (Array.isArray(filter.verifications) && filter.verifications.length > 0) {
    clauses.push(`t.verification IN (${placeholders(filter.verifications.length)})`)
    params.push(...filter.verifications)
  }
  if (typeof filter.workspaceId === 'string' && filter.workspaceId.length > 0) {
    clauses.push(
      'EXISTS (SELECT 1 FROM task_target tw WHERE tw.task_id = t.id AND tw.scope_id = t.scope_id AND tw.workspace_id = ?)',
    )
    params.push(filter.workspaceId)
  }
  if (typeof filter.sessionId === 'string' && filter.sessionId.length > 0) {
    clauses.push(
      'EXISTS (SELECT 1 FROM task_target ts WHERE ts.task_id = t.id AND ts.scope_id = t.scope_id AND ts.session_id = ?)',
    )
    params.push(filter.sessionId)
  }
  if (typeof filter.goalQuery === 'string' && filter.goalQuery.length > 0) {
    clauses.push("t.goal LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filter.goalQuery)}%`)
  }
  if (filter.hasPendingApproval === true || filter.hasPendingApproval === false) {
    // "Has a pending approval" means one that still BINDS to the live plan and
    // has not expired; a version/epoch-moved or expired pending row is not
    // actionable and must not count as pending work.
    const exists = `EXISTS (
        SELECT 1 FROM approval ap
          JOIN action ac ON ac.id = ap.action_id AND ac.scope_id = ap.scope_id
         WHERE ac.task_id = t.id AND ap.scope_id = t.scope_id AND ap.status = 'pending'
           AND ap.task_version = t.version AND ap.policy_epoch = ? AND ap.expires_at > ?
      )`
    clauses.push(filter.hasPendingApproval === true ? exists : `NOT ${exists}`)
    params.push(policyEpoch, now)
  }
  return { where: clauses.join(' AND '), params }
}

/** Escape LIKE wildcards so a search for "a_b" never matches "aXb". */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`)
}

function mapTaskActionRow(row: Record<string, unknown>): TaskActionRow {
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    taskId: String(row.task_id),
    taskVersion: Number(row.task_version),
    targetSessionId: String(row.target_session_id),
    payloadHash: String(row.payload_hash),
    state: String(row.state) as ActionState,
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    policyEpoch: Number(row.policy_epoch),
    originRef: String(row.origin_ref ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function mapRevisionRow(row: Record<string, unknown>): TaskRevisionRow {
  return {
    version: Number(row.version),
    snapshot: parse<unknown>(String(row.snapshot_json), null),
    intentRef: row.intent_ref === null || row.intent_ref === undefined ? null : String(row.intent_ref),
    createdAt: String(row.created_at),
  }
}

function mapApprovalRow(
  row: Record<string, unknown>,
  currentVersions: Map<string, number>,
  currentPolicyEpoch: number,
  now: string,
): ApprovalDetailRow {
  const taskId = row.task_id === null || row.task_id === undefined ? null : String(row.task_id)
  const status = String(row.status) as ApprovalStatus
  const boundVersion = Number(row.task_version)
  const boundEpoch = Number(row.policy_epoch)
  const currentVersion = taskId === null ? null : (currentVersions.get(taskId) ?? null)
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    actionId: String(row.action_id),
    taskId,
    payloadHash: String(row.payload_hash),
    taskVersion: boundVersion,
    policyEpoch: boundEpoch,
    requestingOwner: String(row.requesting_owner),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
    status,
    invalidReason:
      status === 'pending'
        ? approvalInvalidReason(String(row.expires_at), boundVersion, boundEpoch, currentVersion, currentPolicyEpoch, now)
        : null,
  }
}

/** Why a pending approval no longer binds; null means it still does. */
function approvalInvalidReason(
  expiresAt: string,
  boundVersion: number,
  boundEpoch: number,
  currentVersion: number | null,
  currentPolicyEpoch: number,
  now: string,
): ApprovalInvalidReason {
  if (expiresAt <= now) return 'expired'
  if (currentVersion !== null && boundVersion !== currentVersion) return 'task-version-moved'
  if (boundEpoch !== currentPolicyEpoch) return 'policy-epoch-moved'
  return null
}

function mapEvidenceRow(row: Record<string, unknown>): TaskEvidenceRow {
  return {
    factId: String(row.fact_id),
    factVersion: Number(row.fact_version),
    useKind: String(row.use_kind) as TaskEvidenceRow['useKind'],
    actionId: row.action_id === null || row.action_id === undefined ? null : String(row.action_id),
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    seq: row.seq === null || row.seq === undefined ? null : Number(row.seq),
    sourceHash: String(row.source_hash ?? ''),
    artifactRef: row.artifact_ref === null || row.artifact_ref === undefined ? null : String(row.artifact_ref),
  }
}