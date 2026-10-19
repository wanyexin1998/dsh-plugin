/**
 * BOOP human control-plane host row `boop-control` (E04-03, host half).
 *
 * An unambiguous Cordis function plugin (`name` / `inject` / `apply`) mounted
 * from `cordis.patch.yml` as `boop-control`, so the human approval / stop /
 * recovery plane can be composed, disabled or tested independently of the BOOP
 * runtime row and the gated dispatch path.
 *
 * It registers the `boopControl` Typert Remote service over the framework-free
 * core in `control.ts`:
 *
 *  - READ  → the ONE BOOP ledger: approval rows with their binding and real
 *            invalid reason, BOOP-owned action + outbox states (`command_outbox`
 *            joined in), and the live `RecoveryGate` entries. Only the project's
 *            own ledger handle is used; unreadable planes are reported as
 *            unavailable, never as an empty board (FE-11).
 *  - WRITE → the HUMAN act only: `decideApproval` lands the single-use approval
 *            decision (approve/reject) with a full server-side binding check;
 *            `stop` cancels BOOP's OWN pending actions/outbox rows; `release`
 *            explicitly releases named recovery-gate messages. Every write goes
 *            through an existing E01/E02 repository method (or the single-row
 *            approval invalidate the repository does not expose) and then an
 *            audit row (`control/*`), with an honest memory fallback when the
 *            ledger is not writable.
 *  - NEVER → this row has NO dispatch, NO model call, NO external side effect,
 *            NO verification/approval-run endpoint and NO model-facing tool: 03§10
 *            says BOOP may request and relay an approval, never decide it for
 *            the model.
 *
 * Wire shape (rc.2.1 SRC convention): every method takes ONE `request` object;
 * responses are SINGLE-LAYER fact objects:
 * `POST /api/boopControl/state` → `{ result: { ok: true, value: <facts> } }`.
 * Business refusals stay inside the value (`accepted:false` + `code`,
 * `available:false` + `reason`); the transport is not used to signal them.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { remote } from './remote.ts'
import {
  CONTROL_ENDPOINTS,
  CONTROL_ROW_ID,
  CONTROL_REMOTE_NAMESPACE,
  controlApprovalsFacts,
  controlRecoveryFacts,
  controlReleaseFacts,
  controlStateFacts,
  controlStopFacts,
  decideApprovalFacts,
  type ControlActionListResult,
  type ControlActionRow,
  type ControlApprovalListResult,
  type ControlApprovalRow,
  type ControlApprovalsFacts,
  type ControlAuditEntry,
  type ControlAuditResult,
  type ControlDecideFacts,
  type ControlGateEntryFacts,
  type ControlGatePort,
  type ControlLedgerPort,
  type ControlPort,
  type ControlRecoveryFactsResponse,
  type ControlReleaseFacts,
  type ControlStateFacts,
  type ControlStopFacts,
  type GateState,
} from './control.ts'

export const name = 'boop-control'

/** `boop` carries the ledger, gate and write-mode; the gateway routes Remote methods. */
export const inject = ['boop', 'typertGateway']

export interface BoopControlConfig {
  /** Set false only in isolated diagnostics; the shipped default registers the row. */
  enabled?: boolean
}

export interface BoopControlRules {
  state(request?: unknown): ControlStateFacts
  approvals(request?: unknown): ControlApprovalsFacts
  decideApproval(request?: unknown): ControlDecideFacts
  stop(request?: unknown): ControlStopFacts
  recovery(request?: unknown): ControlRecoveryFactsResponse
  release(request?: unknown): ControlReleaseFacts
}

/* ── live ledger port (repository reads/writes + raw read-only joins) ─── */

function storageOf(ctx: any): any {
  try {
    return ctx.boop?.storage?.() ?? null
  } catch {
    return null
  }
}

function scopeOf(storage: any): string | null {
  const scopeId = storage?.identity?.scopeId
  return typeof scopeId === 'string' && scopeId.length > 0 ? scopeId : null
}

/** Map one raw `approval LEFT JOIN action` row to the control-plane row shape. */
function mapApprovalRow(row: Record<string, unknown>): ControlApprovalRow {
  return {
    approvalId: String(row.id),
    actionId: String(row.action_id),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    targetSessionId:
      row.target_session_id === null || row.target_session_id === undefined ? null : String(row.target_session_id),
    payloadHash: String(row.payload_hash),
    taskVersion: Number(row.task_version),
    policyEpoch: Number(row.policy_epoch),
    requestingOwner: String(row.requesting_owner),
    nonce: String(row.nonce_hash),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
    status: String(row.status) as ControlApprovalRow['status'],
    // The core recomputes the real reason from the live task version, scope
    // epoch and expiry; the stored row carries no reason column.
    invalidReason: null,
  }
}

const APPROVAL_SELECT = `SELECT ap.id, ap.action_id, ap.payload_hash, ap.task_version, ap.policy_epoch,
        ap.requesting_owner, ap.nonce_hash, ap.expires_at, ap.consumed_at, ap.status,
        ac.task_id, ac.target_session_id
   FROM approval ap
   LEFT JOIN action ac ON ac.id = ap.action_id AND ac.scope_id = ap.scope_id
  WHERE ap.scope_id = ?`

function mapActionRow(row: Record<string, unknown>): ControlActionRow {
  return {
    actionId: String(row.id),
    taskId: String(row.task_id),
    targetSessionId: String(row.target_session_id),
    taskVersion: Number(row.task_version),
    payloadHash: String(row.payload_hash),
    state: String(row.state) as ControlActionRow['state'],
    messageId: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    policyEpoch: Number(row.policy_epoch),
    originRef: String(row.origin_ref ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    outboxState:
      row.outbox_state === null || row.outbox_state === undefined ? null : (String(row.outbox_state) as ControlActionRow['outboxState']),
    outboxAttempt: Number(row.outbox_attempt ?? 0),
    leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : String(row.lease_until),
  }
}

/**
 * The BOOP ledger as the control plane sees it, or null when storage is not
 * composed. Reads use the repository where it has a read-only query and direct
 * `SELECT`s only for action/outbox joins the repository does not expose; every
 * WRITE maps to an existing repository method except the per-card invalidate.
 */
function ledgerPortOf(ctx: any): ControlLedgerPort | null {
  const storage = storageOf(ctx)
  const repo = storage?.repo
  const db = storage?.db?.db
  const scopeId = scopeOf(storage)
  if (!repo || !db || scopeId === null) return null
  if (typeof repo.listApprovals !== 'function' || typeof repo.consumeApproval !== 'function') return null

  const ledger: ControlLedgerPort = {
    scopeId,
    listApprovals(limit = 50): ControlApprovalListResult {
      // Read-only join over BOOP's own ledger: the repository's E04-02 projection
      // intentionally hides the single-use nonce, but the human card must carry
      // it to echo back.
      const total = Number(
        (db.prepare('SELECT count(*) c FROM approval WHERE scope_id = ?').get(scopeId) as { c: number }).c,
      )
      const rows = db
        .prepare(
          `${APPROVAL_SELECT}
            ORDER BY CASE WHEN ap.status = 'pending' THEN 0 ELSE 1 END, ap.expires_at ASC, ap.id ASC
            LIMIT ?`,
        )
        .all(scopeId, limit) as Array<Record<string, unknown>>
      return { rows: rows.map(mapApprovalRow), total }
    },
    listActions(limit = 50): ControlActionListResult {
      const total = Number(
        (db.prepare('SELECT count(*) c FROM action WHERE scope_id = ?').get(scopeId) as { c: number }).c,
      )
      const rows = db
        .prepare(
          `SELECT a.id, a.task_id, a.task_version, a.target_session_id, a.payload_hash, a.state, a.message_id,
                  a.policy_epoch, a.origin_ref, a.created_at, a.updated_at,
                  o.state AS outbox_state, o.attempt AS outbox_attempt, o.lease_until AS outbox_lease_until
             FROM action a
             LEFT JOIN command_outbox o ON o.action_id = a.id AND o.scope_id = a.scope_id
            WHERE a.scope_id = ?
            ORDER BY a.updated_at DESC, a.id ASC
            LIMIT ?`,
        )
        .all(scopeId, limit) as Array<Record<string, unknown>>
      return { rows: rows.map(mapActionRow), total }
    },
    getApproval(approvalId: string): ControlApprovalRow | null {
      const row = db.prepare(`${APPROVAL_SELECT} AND ap.id = ?`).get(scopeId, approvalId) as
        | Record<string, unknown>
        | undefined
      return row === undefined ? null : mapApprovalRow(row)
    },
    taskVersions(): Map<string, number> {
      const rows = db.prepare('SELECT id, version FROM task WHERE scope_id = ?').all(scopeId) as Array<{
        id: string
        version: number
      }>
      return new Map(rows.map((row) => [String(row.id), Number(row.version)]))
    },
    policyEpoch(): number {
      const scope = repo.getScope(scopeId)
      return scope === null || scope === undefined ? 1 : Number(scope.policyEpoch)
    },
    writable(): boolean {
      try {
        return ctx.boop?.state?.()?.storage?.ok === true
      } catch {
        return false
      }
    },
    consumeApproval(input): ReturnType<ControlLedgerPort['consumeApproval']> {
      return repo.consumeApproval({
        scopeId,
        approvalId: input.approvalId,
        nonceHash: input.nonce,
        payloadHash: input.payloadHash,
        taskVersion: input.taskVersion,
        policyEpoch: input.policyEpoch,
      }).status
    },
    rejectApproval(approvalId: string): void {
      repo.rejectApproval(scopeId, approvalId)
    },
    markApprovalInvalid(approvalId: string, cause: 'task-version-moved' | 'policy-epoch-moved'): boolean {
      // The repository has no per-card invalidate primitive and E01's
      // `expireStaleApprovals` is scope-wide, so ONE row is changed here. The
      // cause is recorded by the caller's audit row.
      const info = db
        .prepare("UPDATE approval SET status = 'stale' WHERE scope_id = ? AND id = ? AND status = 'pending'")
        .run(scopeId, approvalId)
      void cause
      return Number(info.changes) > 0
    },
    markActionStopped(actionId: string): void {
      repo.markActionState(scopeId, actionId, 'stopped')
    },
    settleOutboxCancelled(actionId: string): void {
      repo.settleOutbox(scopeId, actionId, 'cancelled')
    },
  }
  return ledger
}

/* ── live recovery-gate port ─────────────────────────────────────────── */

function gatePortOf(ctx: any): ControlGatePort | null {
  try {
    const gate = ctx.boop?.gate?.()
    if (!gate || typeof gate.isArmed !== 'function' || typeof gate.list !== 'function' || typeof gate.release !== 'function') {
      return null
    }
    const mapEntry = (entry: any): ControlGateEntryFacts => ({
      messageId: String(entry?.messageId ?? ''),
      actionId: String(entry?.actionId ?? ''),
      sessionId: String(entry?.sessionId ?? ''),
      state: entry?.state === 'released' ? 'released' : 'blocked',
      reason: String(entry?.reason ?? ''),
    })
    return {
      armed: () => gate.isArmed() === true,
      entries: () => (gate.list() as unknown[]).map(mapEntry),
      release: (messageIds: string[]) => (gate.release(messageIds) as unknown[]).map(mapEntry),
    }
  } catch {
    return null
  }
}

/* ── audit sink: BOOP ledger with an honest memory fallback ──────────── */

class ControlAuditSink {
  private readonly ctx: any
  private readonly memory: Array<ControlAuditEntry & { id: string; time: string }> = []

  constructor(ctx: any) {
    this.ctx = ctx
  }

  sink(): 'ledger' | 'memory' {
    try {
      if (ledgerPortOf(this.ctx) === null) return 'memory'
      return this.ctx.boop?.state?.()?.storage?.ok === true ? 'ledger' : 'memory'
    } catch {
      return 'memory'
    }
  }

  record(entry: ControlAuditEntry): ControlAuditResult {
    try {
      const storage = storageOf(this.ctx)
      const repo = storage?.repo
      const scopeId = scopeOf(storage)
      if (repo && typeof repo.audit === 'function' && scopeId !== null) {
        const row = repo.audit(scopeId, entry.kind, entry.objectId, entry.actor, entry.reason)
        if (row !== undefined && row !== null) {
          return { recorded: true, sink: 'ledger', id: row.id === undefined ? null : String(row.id) }
        }
      }
    } catch {
      /* fall through to memory: the human act still lands, audit degrades honestly */
    }
    const id = `mem-control-${this.memory.length + 1}`
    this.memory.push({ ...entry, id, time: new Date().toISOString() })
    return { recorded: true, sink: 'memory', id }
  }

  trail(limit = 20): Array<ControlAuditEntry & { id: string; time: string }> {
    return this.memory.slice(-Math.max(0, limit)).reverse()
  }
}

/* ── capability gate read from the BOOP runtime service ──────────────── */

function readGates(ctx: any): Record<string, GateState> {
  try {
    const gates = ctx.boop?.state?.()?.gates
    return gates && typeof gates === 'object' ? { ...gates } : {}
  } catch {
    return {}
  }
}

/* ── the framework-free port, wired to the live Host ─────────────────── */

interface PlaneState {
  row: string
  state: 'armed' | 'failed' | 'disabled'
  endpoints: string[]
}

function createPort(ctx: any, planeState: PlaneState): ControlPort {
  const auditSink = new ControlAuditSink(ctx)
  let projectionSeq = 0
  return {
    ledger: () => ledgerPortOf(ctx),
    gate: () => gatePortOf(ctx),
    writeModeEnabled: () => {
      try {
        return ctx.boop?.isWriteModeEnabled?.() === true
      } catch {
        return false
      }
    },
    gates: () => readGates(ctx),
    blockedByGates: () => {
      // The authoritative list is the frozen gate ledger's write-mode status
      // (src/host/gates.ts): a gate that is PASS is no longer "blocked", and the
      // order/required set are decided there, never re-derived here.
      try {
        const status = ctx.boop?.writeMode?.()
        if (status && Array.isArray(status.blockedByGates)) {
          return status.blockedByGates.map((gate: unknown) => String(gate))
        }
      } catch {
        /* fall through to the gate map below */
      }
      const gates = readGates(ctx)
      return Object.entries(gates)
        .filter(([, state]) => state !== 'PASS')
        .map(([gate]) => gate)
    },
    runtimeEnforcement: () => gateRuntimeEnforcementOf(ctx),
    nextProjectionSeq: () => {
      projectionSeq += 1
      return projectionSeq
    },
    now: () => new Date().toISOString(),
    audit: (entry) => auditSink.record(entry),
    auditSink: () => auditSink.sink(),
    diagnostics: () => ({
      row: planeState.row,
      remoteService: CONTROL_REMOTE_NAMESPACE,
      rowState: planeState.state,
      endpoints: [...planeState.endpoints],
      rulesFacade: 'boopControlRules',
      modelFacingApprovalTool: 'absent (03§10: BOOP never owns the approval decision tool)',
      dispatch: 'absent (this row never dispatches)',
      ledger: ledgerPortOf(ctx) === null ? 'unavailable' : 'available',
      runtimeEnforcement: gateRuntimeEnforcementOf(ctx),
    }),
  }
}

/**
 * Live registration facts of the `boop-gate` row. `composed:true` is only
 * reported when that row actually registered its official `agent/pre-step`
 * waterfall listener on this composition; a missing/failed row is reported as
 * not composed (never a hard-coded claim).
 */
function gateRuntimeEnforcementOf(ctx: any): { composed: boolean; detail: string } {
  try {
    const runtime = ctx.reflect?.get?.('boopGateRuntime', false)
    if (runtime && typeof runtime.enforcement === 'function') {
      const facts = runtime.enforcement()
      if (facts && typeof facts.composed === 'boolean' && typeof facts.detail === 'string') return facts
    }
  } catch {
    /* fall through to the honest not-composed fact */
  }
  return {
    composed: false,
    detail:
      'boop-gate 行未在本 Host composition 注册 agent/pre-step 监听：释放只改变门禁账本，不代表运行时已放行。',
  }
}

/* ── Remote service (the UI/IM transport plane) ───────────────────────── */

/**
 * Typert Remote owner for the generated `boopControl` namespace. Every method
 * takes ONE `request` object (rc.2.1 SRC wire convention:
 * `ctx.connection.rpc.call('/api', 'boopControl/<method>', { args: { request } })`)
 * and returns a SINGLE-LAYER fact object as `result.value`.
 */
class BoopControlApi extends TypertRemoteService {
  private readonly port: ControlPort

  constructor(ctx: any, port: ControlPort) {
    super(ctx, CONTROL_REMOTE_NAMESPACE, { namespace: CONTROL_REMOTE_NAMESPACE })
    this.port = port
  }

  /** Read-only snapshot: pending/invalid approvals, action/outbox states, gate, unknown results. */
  state(request?: unknown): ControlStateFacts {
    return controlStateFacts(this.port, request)
  }

  /** Every approval card with its exact binding (nonce) and validity. */
  approvals(request?: unknown): ControlApprovalsFacts {
    return controlApprovalsFacts(this.port, request)
  }

  /** The human decision: approve (single-use CAS) or reject. Never dispatches. */
  decideApproval(request?: unknown): ControlDecideFacts {
    return decideApprovalFacts(this.port, request)
  }

  /** Deterministic, model-free stop of BOOP-owned pending work only. */
  stop(request?: unknown): ControlStopFacts {
    return controlStopFacts(this.port, request)
  }

  /** Restart recovery inspection: armed gate, entries, unknown results. */
  recovery(request?: unknown): ControlRecoveryFactsResponse {
    return controlRecoveryFacts(this.port, request)
  }

  /** Explicit, audited release of named gate messages (never a bulk default). */
  release(request?: unknown): ControlReleaseFacts {
    return controlReleaseFacts(this.port, request)
  }
}

for (const method of ['state', 'approvals', 'decideApproval', 'stop', 'recovery', 'release']) {
  remote(method)(BoopControlApi.prototype)
}

/* ── in-process facade (future IM adapters / tests) ──────────────────── */

function createFacade(port: ControlPort): BoopControlRules {
  return {
    state: (request?: unknown) => controlStateFacts(port, request),
    approvals: (request?: unknown) => controlApprovalsFacts(port, request),
    decideApproval: (request?: unknown) => decideApprovalFacts(port, request),
    stop: (request?: unknown) => controlStopFacts(port, request),
    recovery: (request?: unknown) => controlRecoveryFacts(port, request),
    release: (request?: unknown) => controlReleaseFacts(port, request),
  }
}

/* ── row lifecycle ────────────────────────────────────────────────────── */

export function apply(ctx: any, config?: BoopControlConfig): void {
  if (config?.enabled === false) {
    try {
      ctx.logger?.info?.('[boop] control plane disabled by config; host continues')
    } catch {
      /* logging must never break activation */
    }
    return
  }
  const planeState: PlaneState = { row: CONTROL_ROW_ID, state: 'armed', endpoints: [...CONTROL_ENDPOINTS] }
  try {
    const port = createPort(ctx, planeState)
    // One service key owns the Typert binding; the in-process facade is a
    // SEPARATE key so adapters never construct a second service that shadows it.
    new BoopControlApi(ctx, port)
    ctx.provide('boopControlRules', createFacade(port))
    ctx.logger?.info?.(
      '[boop] control plane armed: human approval/stop/recovery over the real ledger; decisions and stop land in the ledger, dispatch stays gated',
    )
  } catch (error) {
    planeState.state = 'failed'
    // A throwing optional row must warn, never break the host boot (03§05).
    try {
      ctx.logger?.warn?.('[boop] control plane failed to arm; host continues', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
