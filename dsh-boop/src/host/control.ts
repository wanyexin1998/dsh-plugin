/**
 * BOOP human control plane view-model (E04-03, host half) — framework-free core.
 *
 * The frozen design (03§08–10, 04§08/§10, issue E04-03) draws one hard line:
 * the MODEL may request work but only the HUMAN decides, stops and recovers.
 * This module is the server half of that line:
 *
 *  - `state()`     — read-only projection of pending approvals (with their real
 *                    invalid reason), BOOP-owned actions/outbox states, the
 *                    recovery-gate entries and the unknown-result list;
 *  - `approvals()` — the approval cards with the exact binding the human must
 *                    echo back (payloadHash / taskVersion / policyEpoch / nonce);
 *  - `decideApproval()` — the ONE human decision that lands in the ledger:
 *                    approve consumes the single-use approval with a full
 *                    server-side binding check; reject records the refusal.
 *                    It NEVER dispatches, never runs a model and never executes
 *                    an external side effect; parameter/task/policy changes and
 *                    expiry are refused as APPROVAL_STALE and the old card is
 *                    marked invalid instead of being left clickable;
 *  - `stop()`      — deterministic stop (no model, no loop): only BOOP's OWN
 *                    ledger actions / outbox rows are cancelled; a delivered
 *                    command is never reported as "external effect undone"; a
 *                    user's own turn has no BOOP provenance and is never
 *                    touched; nothing to stop is reported as `stopped: []`;
 *  - `recovery()` / `release()` — restart recovery inspection and the EXPLICIT
 *                    per-message release (never a bulk default, unknown ids are
 *                    ignored and reported, every release is audited).
 *
 * Decisions are NOT gated by `boop.isWriteModeEnabled()`: a human authorisation
 * is the permission source itself. Write mode only governs DISPATCH, and while
 * it is closed every response states that no dispatch is available.
 *
 * This file imports only TYPES: it has no Cordis/framework dependency and is
 * unit-testable against an in-memory ledger/fake ports. All ledger writes go
 * through existing E01/E02 repository methods (no schema change, no raw write).
 */

import type { ActionState } from '../shared/types.ts'

/* ── contract constants ───────────────────────────────────────────────── */

export const CONTROL_SCHEMA_VERSION = 1 as const
export const CONTROL_ROW_ID = 'boop-control'
export const CONTROL_REMOTE_NAMESPACE = 'boopControl'

export const CONTROL_ENDPOINTS = [
  'boopControl/state',
  'boopControl/approvals',
  'boopControl/decideApproval',
  'boopControl/stop',
  'boopControl/recovery',
  'boopControl/release',
] as const

/** Endpoints that only read (no ledger row is written by them). */
export const CONTROL_READ_ENDPOINTS = ['state', 'approvals', 'recovery'] as const
/** Endpoints that land a human act in the ledger / gate. */
export const CONTROL_WRITE_ENDPOINTS = ['decideApproval', 'stop', 'release'] as const

/** Bounded reads: the control plane never asks the ledger for an unbounded list. */
export const CONTROL_LIST_DEFAULT = 50
export const CONTROL_LIST_MAX = 100

export type ApprovalStatus = 'pending' | 'allowed' | 'rejected' | 'expired' | 'stale' | 'cancelled'
export type ApprovalInvalidReason = 'expired' | 'task-version-moved' | 'policy-epoch-moved' | null
export type GateState = 'NOT_RUN' | 'PASS' | 'BLOCKED'
export type OutboxState = 'prepared' | 'blocked' | 'sending' | 'accepted' | 'unknown' | 'cancelled'
export type ActionBucket = 'pending' | 'accepted' | 'unknown' | 'blocked' | 'cancelled'
export type Decision = 'approve' | 'reject'

/* ── ledger rows the core projects ───────────────────────────────────── */

/**
 * One approval as the ledger holds it. `nonce` is the ledger's single-use
 * binding value for THIS card: the UI echoes it back on decide; it is never a
 * client-asserted identity (the server still re-checks every other field).
 */
export interface ControlApprovalRow {
  approvalId: string
  actionId: string
  taskId: string | null
  targetSessionId: string | null
  payloadHash: string
  taskVersion: number
  policyEpoch: number
  requestingOwner: string
  nonce: string
  expiresAt: string
  consumedAt: string | null
  status: ApprovalStatus
  invalidReason: ApprovalInvalidReason
}

/** One BOOP-owned action row joined with its outbox state. */
export interface ControlActionRow {
  actionId: string
  taskId: string
  targetSessionId: string
  taskVersion: number
  payloadHash: string
  state: ActionState
  messageId: string | null
  policyEpoch: number
  originRef: string
  createdAt: string
  updatedAt: string
  /** null = no outbox row (e.g. an action created outside the dispatch path). */
  outboxState: OutboxState | null
  outboxAttempt: number
  leaseUntil: string | null
}

export interface ControlApprovalListResult {
  rows: ControlApprovalRow[]
  total: number
}

export interface ControlActionListResult {
  rows: ControlActionRow[]
  total: number
}

/* ── host ports (real wiring in control-api.ts, fakes in unit tests) ──── */

/** Ledger access for the control plane. Every method maps to an EXISTING repository call. */
export interface ControlLedgerPort {
  readonly scopeId: string
  /** Bounded approval page (pending first) with exact total. */
  listApprovals(limit?: number): ControlApprovalListResult
  /** Bounded action+outbox page (newest first) with exact total. */
  listActions(limit?: number): ControlActionListResult
  getApproval(approvalId: string): ControlApprovalRow | null
  /** `{ taskId: version }` for the whole domain (one read). */
  taskVersions(): Map<string, number>
  policyEpoch(): number
  /** This process holds the ledger's single-writer lease and may write. */
  writable(): boolean
  /** Repository `consumeApproval` — single-use CAS bound to the exact payload. */
  consumeApproval(input: {
    approvalId: string
    nonce: string
    payloadHash: string
    taskVersion: number
    policyEpoch: number
  }): 'allowed' | 'rejected' | 'expired' | 'stale' | 'cancelled' | 'not_found'
  /** Repository `rejectApproval`. */
  rejectApproval(approvalId: string): void
  /**
   * Persist ONE card as invalid because the live plan moved past its binding.
   * Implemented as a single-row ledger status change (the repository has no
   * per-card invalidate primitive); the caller always re-reads the row.
   */
  markApprovalInvalid(approvalId: string, cause: 'task-version-moved' | 'policy-epoch-moved'): boolean
  /** Repository `markActionState(..., 'stopped')`. */
  markActionStopped(actionId: string): void
  /** Repository `settleOutbox(..., 'cancelled')`. */
  settleOutboxCancelled(actionId: string): void
}

export interface ControlGateEntryFacts {
  messageId: string
  actionId: string
  sessionId: string
  state: 'blocked' | 'released'
  reason: string
}

/** The startup recovery gate (unchanged E00-02 `RecoveryGate`). */
export interface ControlGatePort {
  armed(): boolean
  entries(): ControlGateEntryFacts[]
  /** Releases EXACTLY these message ids; unknown ids are not created. */
  release(messageIds: string[]): ControlGateEntryFacts[]
}

export interface ControlAuditEntry {
  kind: string
  objectId: string | null
  actor: string
  reason: string | null
}

export interface ControlAuditResult {
  recorded: boolean
  sink: 'ledger' | 'memory'
  id: string | null
}

export interface ControlPort {
  ledger(): ControlLedgerPort | null
  gate(): ControlGatePort | null
  writeModeEnabled(): boolean
  gates(): Record<string, GateState>
  blockedByGates(): string[]
  nextProjectionSeq(): number
  now(): string
  audit(entry: ControlAuditEntry): ControlAuditResult
  auditSink(): 'ledger' | 'memory'
  diagnostics(): Record<string, unknown>
  /**
   * Runtime enforcement facts of the `agent/pre-step` gate row (`boop-gate`).
   * Optional so existing unit fakes keep compiling; when absent (or when the
   * row is not composed) the recovery facts honestly report `composed:false`.
   */
  runtimeEnforcement?(): { composed: boolean; detail: string } | null
}

/* ── response base facts (every response carries these) ──────────────── */

export interface ControlWriteModeFacts {
  enabled: boolean
  source: 'boop.isWriteModeEnabled()'
  blockedByGates: string[]
}

export interface ControlLedgerFacts {
  writable: boolean
  auditSink: 'ledger' | 'memory'
  durable: boolean
}

export interface ControlDispatchFacts {
  /** Always false on this row: the human control plane never dispatches. */
  available: boolean
  reason: 'write-mode-disabled' | 'dispatch-not-on-this-row'
  requiresModel: boolean
  detail: string
}

export interface ControlAuditReceipt {
  recorded: boolean
  sink: 'ledger' | 'memory'
  id: string | null
  kind: string | null
  note: string | null
}

export interface ControlBaseFacts {
  schemaVersion: 1
  product: 'BOOP'
  scopeId: string | null
  writeMode: ControlWriteModeFacts
  ledger: ControlLedgerFacts
  dispatch: ControlDispatchFacts
  audit: ControlAuditReceipt
  projectionSeq: number
  generatedAt: string
}

/* ── card / action / recovery fact shapes ─────────────────────────────── */

export interface ControlApprovalCardFacts {
  approvalId: string
  status: ApprovalStatus
  actionId: string
  taskId: string | null
  targetSessionId: string | null
  payloadHash: string
  taskVersion: number
  policyEpoch: number
  requestingOwner: string
  expiresAt: string
  consumedAt: string | null
  invalidReason: ApprovalInvalidReason
  /** true = still bindable AND the ledger is writable: the buttons may act. */
  valid: boolean
  canDecide: boolean
  decision: 'allowed' | 'rejected' | null
  /** The single-use binding value the card must echo back on decide. */
  nonce: string
}

export interface ControlActionFacts {
  actionId: string
  taskId: string
  taskVersion: number
  targetSessionId: string
  state: ActionState
  bucket: ActionBucket
  outboxState: OutboxState | null
  outboxAttempt: number
  leaseUntil: string | null
  messageId: string | null
  policyEpoch: number
  originRef: string
  payloadHash: string
  ownership: 'boop'
  cancellable: boolean
  createdAt: string
  updatedAt: string
}

export interface ControlRecoveryEntryFacts extends ControlGateEntryFacts {
  releasable: boolean
}

export interface ControlRecoveryFacts {
  available: boolean
  reason: string | null
  armed: boolean
  entries: ControlRecoveryEntryFacts[]
  pendingCount: number
  releasedCount: number
  requiresExplicitSelection: true
  bulkReleaseDefault: false
  /**
   * REAL runtime enforcement facts: `composed:true` only when the `boop-gate`
   * row registered the official `agent/pre-step` waterfall listener on this
   * Host composition. Never hard-coded.
   */
  runtimeEnforcement: { composed: boolean; detail: string }
}

export interface ControlPolicyFacts {
  ownsOnly: 'boop-ledger-actions'
  userTurnsStopped: false
  foreignTurns: 'not-inspected-never-stopped'
  /** A stop cancels BOOP bookkeeping; it never claims an external effect was undone. */
  externalSideEffectsUndone: false
  deterministic: true
  requiresModel: false
}

/* ── state ───────────────────────────────────────────────────────────── */

export interface ControlStateFacts extends ControlBaseFacts {
  available: boolean
  reason: string | null
  detail: string | null
  readOnly: true
  pendingApprovals: ControlApprovalCardFacts[]
  invalidApprovals: ControlApprovalCardFacts[]
  approvalCounts: Record<'pending' | 'validPending' | 'invalidPending' | 'allowed' | 'rejected' | 'expired' | 'stale' | 'cancelled', number>
  actions: ControlActionFacts[]
  actionCounts: Record<ActionBucket | 'total', number>
  unknownResults: ControlActionFacts[]
  recovery: ControlRecoveryFacts
  truncated: boolean
  limits: { listMax: number }
}

/* ── approvals ───────────────────────────────────────────────────────── */

export interface ControlApprovalsFacts extends ControlBaseFacts {
  available: boolean
  reason: string | null
  detail: string | null
  readOnly: true
  approvals: ControlApprovalCardFacts[]
  counts: ControlStateFacts['approvalCounts']
  total: number
  truncated: boolean
  limits: { listMax: number }
}

/* ── decideApproval ──────────────────────────────────────────────────── */

export type DecideOutcome =
  | 'allowed'
  | 'rejected'
  | 'already-handled'
  | 'stale'
  | 'not-found'
  | 'invalid-request'
  | 'capability-unavailable'

export type StaleCause =
  | 'expired'
  | 'task-version-moved'
  | 'policy-epoch-moved'
  | 'payload-changed'
  | 'caller-binding-mismatch'
  | 'nonce-mismatch'

export interface ControlDecideFacts extends ControlBaseFacts {
  command: 'decideApproval'
  accepted: boolean
  executed: false
  dispatched: false
  approvalId: string | null
  decision: Decision | null
  outcome: DecideOutcome
  code: 'APPROVAL_STALE' | 'APPROVAL_NOT_FOUND' | 'INVALID_ARGUMENT' | 'CAPABILITY_UNAVAILABLE' | null
  staleCause: StaleCause | null
  /** true = the old card was actually persisted as invalid (no longer clickable). */
  markedInvalid: boolean
  /** true = the same human decision was already landed elsewhere; never re-allowed. */
  idempotent: boolean
  existingStatus: ApprovalStatus | null
  approval: ControlApprovalCardFacts | null
  message: string
}

/* ── stop ────────────────────────────────────────────────────────────── */

export type StopScopeKind = 'all' | 'task' | 'action' | 'session'

export interface ControlStopScopeFacts {
  raw: string
  kind: StopScopeKind | null
  id: string | null
}

export interface ControlStoppedActionFacts {
  actionId: string
  taskId: string
  targetSessionId: string
  previousActionState: ActionState
  previousOutboxState: OutboxState | null
  actionState: 'stopped'
  outboxState: 'cancelled'
  invalidatedApprovalIds: string[]
  note: string
}

export interface ControlRefusedActionFacts {
  actionId: string
  taskId: string
  targetSessionId: string
  actionState: ActionState
  outboxState: OutboxState | null
  bucket: ActionBucket
  code: 'ALREADY_DELIVERED' | 'ALREADY_TERMINAL' | 'NOT_CANCELLABLE' | 'LEDGER_WRITE_FAILED'
  reason: string
  note: string
}

export interface ControlUnknownActionFacts {
  actionId: string
  taskId: string
  targetSessionId: string
  actionState: ActionState
  outboxState: OutboxState | null
  code: 'OUTCOME_UNKNOWN' | 'DELIVERY_IN_FLIGHT'
  reason: string
  note: string
}

export interface ControlStopFacts extends ControlBaseFacts {
  command: 'stop'
  available: boolean
  accepted: boolean
  executed: boolean
  noop: boolean
  deterministic: true
  requiresModel: false
  requestedScope: ControlStopScopeFacts
  matched: number
  stopped: ControlStoppedActionFacts[]
  refused: ControlRefusedActionFacts[]
  unknown: ControlUnknownActionFacts[]
  summary: { matched: number; stopped: number; refused: number; unknown: number }
  /** true = more actions exist than the bounded read returned; the stop is partial. */
  truncated: boolean
  code: 'INVALID_ARGUMENT' | 'CAPABILITY_UNAVAILABLE' | null
  policy: ControlPolicyFacts
  message: string
}

/* ── recovery + release ──────────────────────────────────────────────── */

export interface ControlRecoveryFactsResponse extends ControlBaseFacts {
  readOnly: true
  available: boolean
  reason: string | null
  detail: string | null
  recovery: ControlRecoveryFacts
  /** BOOP actions whose outcome is unknown must be verified by the human, not retried. */
  unknownResults: ControlActionFacts[]
  /** true = more actions exist than the bounded read returned. */
  truncated: boolean
}

export interface ControlReleaseFacts extends ControlBaseFacts {
  command: 'release'
  accepted: boolean
  requestedMessageIds: string[]
  released: ControlRecoveryEntryFacts[]
  ignored: Array<{ messageId: string; reason: 'unknown-message-id' | 'already-released' }>
  requiresExplicitSelection: true
  bulkDefault: false
  code: 'INVALID_ARGUMENT' | 'CAPABILITY_UNAVAILABLE' | null
  message: string
}

/* ── small helpers ───────────────────────────────────────────────────── */

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeOf<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function clampLimit(value: unknown, fallback = CONTROL_LIST_DEFAULT): number {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(CONTROL_LIST_MAX, Math.max(1, Math.trunc(parsed)))
}

function bucketOf(row: ControlActionRow): ActionBucket {
  if (row.outboxState === 'unknown' || row.state === 'outcome_unknown') return 'unknown'
  if (row.outboxState === 'cancelled' || row.state === 'stopped' || row.state === 'rejected') return 'cancelled'
  if (row.outboxState === 'blocked') return 'blocked'
  if (row.outboxState === 'accepted' || row.state === 'accepted' || row.state === 'running' || row.state === 'settled') {
    return 'accepted'
  }
  return 'pending'
}

const CANCELLABLE_STATES: ReadonlyArray<ActionState> = ['planned', 'awaiting_approval', 'dispatching']
const CANCELLABLE_OUTBOX: ReadonlyArray<OutboxState | null> = [null, 'prepared', 'blocked']

/** A row is cancellable only before it was delivered (no model, no remote turn involved). */
function cancellableOf(row: ControlActionRow): boolean {
  return CANCELLABLE_STATES.includes(row.state) && CANCELLABLE_OUTBOX.includes(row.outboxState)
}

function writeModeOf(port: ControlPort): ControlWriteModeFacts {
  return {
    enabled: safeOf(() => port.writeModeEnabled() === true, false),
    source: 'boop.isWriteModeEnabled()',
    blockedByGates: safeOf(() => port.blockedByGates(), []),
  }
}

function auditSinkOf(port: ControlPort): 'ledger' | 'memory' {
  return safeOf(() => port.auditSink(), 'memory')
}

function ledgerOf(port: ControlPort): ControlLedgerPort | null {
  try {
    return port.ledger()
  } catch {
    return null
  }
}

function gateOf(port: ControlPort): ControlGatePort | null {
  try {
    return port.gate()
  } catch {
    return null
  }
}

function readAudit(port: ControlPort, note: string): ControlAuditReceipt {
  return { recorded: false, sink: auditSinkOf(port), id: null, kind: null, note }
}

/** Land ONE audit row for a human act/refusal; the receipt is returned to the caller. */
function writeAudit(port: ControlPort, entry: ControlAuditEntry): ControlAuditReceipt {
  try {
    const result = port.audit(entry)
    return {
      recorded: result.recorded === true,
      sink: result.sink,
      id: result.id,
      kind: entry.kind,
      note: null,
    }
  } catch (error) {
    return {
      recorded: false,
      sink: auditSinkOf(port),
      id: null,
      kind: entry.kind,
      note: `audit sink failed: ${errorDetail(error)}`,
    }
  }
}

function baseFacts(port: ControlPort, projectionSeq: number, generatedAt: string): ControlBaseFacts {
  const writeMode = writeModeOf(port)
  const sink = auditSinkOf(port)
  let writable = false
  try {
    writable = ledgerOf(port)?.writable() === true
  } catch {
    writable = false
  }
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    product: 'BOOP',
    scopeId: safeOf(() => ledgerOf(port)?.scopeId ?? null, null),
    writeMode,
    ledger: { writable, auditSink: sink, durable: sink === 'ledger' },
    dispatch: {
      available: false,
      reason: writeMode.enabled ? 'dispatch-not-on-this-row' : 'write-mode-disabled',
      requiresModel: true,
      detail: writeMode.enabled
        ? '人工控制行只落人工结论，不派发；派发属于 gated dispatch 路径。'
        : '写模式关闭（G02/G05 未 PASS）：没有任何派发可用；人工审批结论、确定性停止与显式释放仍可落账。',
    },
    audit: readAudit(port, 'read-only projection does not write an audit row'),
    projectionSeq,
    generatedAt,
  }
}

function nowIso(port: ControlPort): string {
  return safeOf(() => port.now(), new Date().toISOString())
}

function seqOf(port: ControlPort): number {
  return safeOf(() => port.nextProjectionSeq(), 0)
}

/* ── approval projection ─────────────────────────────────────────────── */

function effectiveInvalidReason(
  row: ControlApprovalRow,
  now: string,
  liveVersion: number | null,
  liveEpoch: number,
): ApprovalInvalidReason {
  if (row.status !== 'pending') return null
  if (row.expiresAt <= now) return 'expired'
  if (liveVersion !== null && row.taskVersion !== liveVersion) return 'task-version-moved'
  if (row.policyEpoch !== liveEpoch) return 'policy-epoch-moved'
  return row.invalidReason
}

function approvalCardFacts(
  row: ControlApprovalRow,
  options: { now: string; liveVersion: number | null; liveEpoch: number; writable: boolean },
): ControlApprovalCardFacts {
  const invalidReason = effectiveInvalidReason(row, options.now, options.liveVersion, options.liveEpoch)
  const valid = row.status === 'pending' && invalidReason === null
  return {
    approvalId: row.approvalId,
    status: row.status,
    actionId: row.actionId,
    taskId: row.taskId,
    targetSessionId: row.targetSessionId,
    payloadHash: row.payloadHash,
    taskVersion: row.taskVersion,
    policyEpoch: row.policyEpoch,
    requestingOwner: row.requestingOwner,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    invalidReason,
    valid,
    canDecide: valid && options.writable,
    decision: row.status === 'allowed' ? 'allowed' : row.status === 'rejected' ? 'rejected' : null,
    nonce: row.nonce,
  }
}

function approvalCounts(
  cards: ControlApprovalCardFacts[],
  rows: ControlApprovalRow[],
): ControlStateFacts['approvalCounts'] {
  const counts = {
    pending: 0,
    validPending: 0,
    invalidPending: 0,
    allowed: 0,
    rejected: 0,
    expired: 0,
    stale: 0,
    cancelled: 0,
  }
  for (const card of cards) {
    if (card.status === 'pending') {
      counts.pending += 1
      if (card.valid) counts.validPending += 1
      else counts.invalidPending += 1
    }
  }
  for (const row of rows) {
    if (row.status === 'allowed') counts.allowed += 1
    else if (row.status === 'rejected') counts.rejected += 1
    else if (row.status === 'expired') counts.expired += 1
    else if (row.status === 'stale') counts.stale += 1
    else if (row.status === 'cancelled') counts.cancelled += 1
  }
  return counts
}

function actionFacts(row: ControlActionRow): ControlActionFacts {
  return {
    actionId: row.actionId,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    targetSessionId: row.targetSessionId,
    state: row.state,
    bucket: bucketOf(row),
    outboxState: row.outboxState,
    outboxAttempt: row.outboxAttempt,
    leaseUntil: row.leaseUntil,
    messageId: row.messageId,
    policyEpoch: row.policyEpoch,
    originRef: row.originRef,
    payloadHash: row.payloadHash,
    ownership: 'boop',
    cancellable: cancellableOf(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function actionCounts(rows: ControlActionRow[]): ControlStateFacts['actionCounts'] {
  const counts: ControlStateFacts['actionCounts'] = {
    total: rows.length,
    pending: 0,
    accepted: 0,
    unknown: 0,
    blocked: 0,
    cancelled: 0,
  }
  for (const row of rows) counts[bucketOf(row)] += 1
  return counts
}

interface ReadableLedger {
  ledger: ControlLedgerPort
  approvals: ControlApprovalRow[]
  approvalTotal: number
  actions: ControlActionRow[]
  actionTotal: number
  liveEpoch: number
  versions: Map<string, number>
  writable: boolean
}

/** Read both bounded lists once; a read failure is reported, never turned into a fake empty board. */
function readLedger(
  ledger: ControlLedgerPort,
  limit: number,
): { ok: true; value: ReadableLedger } | { ok: false; detail: string } {
  try {
    const approvals = ledger.listApprovals(limit)
    const actions = ledger.listActions(limit)
    const versions = ledger.taskVersions()
    return {
      ok: true,
      value: {
        ledger,
        approvals: approvals.rows,
        approvalTotal: approvals.total,
        actions: actions.rows,
        actionTotal: actions.total,
        liveEpoch: ledger.policyEpoch(),
        versions,
        writable: ledger.writable(),
      },
    }
  } catch (error) {
    return { ok: false, detail: errorDetail(error) }
  }
}

/* ── recovery projection ─────────────────────────────────────────────── */

function recoveryFacts(port: ControlPort): ControlRecoveryFacts {
  const gate = gateOf(port)
  // Read the LIVE registration state of the `boop-gate` row: composed only when
  // its official `agent/pre-step` waterfall listener is really installed on this
  // composition (never a hard-coded claim).
  const enforcement = safeOf(
    () => port.runtimeEnforcement?.() ?? null,
    null,
  )
  const base: ControlRecoveryFacts = {
    available: gate !== null,
    reason: gate === null ? 'gate-unavailable' : null,
    armed: false,
    entries: [],
    pendingCount: 0,
    releasedCount: 0,
    requiresExplicitSelection: true,
    bulkReleaseDefault: false,
    runtimeEnforcement: enforcement ?? {
      composed: false,
      detail:
        'boop-gate 行未在本 Host composition 注册 agent/pre-step 监听：释放只改变门禁账本，不代表运行时已放行（NOT_RUN，见 STATUS 风险）。',
    },
  }
  if (gate === null) return base
  const entries = safeOf(() => gate.entries(), [])
  const mapped: ControlRecoveryEntryFacts[] = entries.map((entry) => ({
    messageId: entry.messageId,
    actionId: entry.actionId,
    sessionId: entry.sessionId,
    state: entry.state,
    reason: entry.reason,
    releasable: entry.state === 'blocked',
  }))
  return {
    ...base,
    armed: safeOf(() => gate.armed() === true, false),
    entries: mapped,
    pendingCount: mapped.filter((entry) => entry.state === 'blocked').length,
    releasedCount: mapped.filter((entry) => entry.state === 'released').length,
    runtimeEnforcement: base.runtimeEnforcement,
  }
}

/* ── state() ─────────────────────────────────────────────────────────── */

/**
 * Read-only human-control snapshot: pending/invalid approvals with their real
 * invalid reason, BOOP-owned action/outbox states, the recovery gate and the
 * unknown-result list. Writes nothing.
 */
export function controlStateFacts(port: ControlPort, request?: unknown): ControlStateFacts {
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const limit = clampLimit(raw.limit)
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const unavailable = (reason: string, detail: string | null): ControlStateFacts => ({
    ...base,
    available: false,
    reason,
    detail,
    readOnly: true,
    pendingApprovals: [],
    invalidApprovals: [],
    approvalCounts: { pending: 0, validPending: 0, invalidPending: 0, allowed: 0, rejected: 0, expired: 0, stale: 0, cancelled: 0 },
    actions: [],
    actionCounts: { total: 0, pending: 0, accepted: 0, unknown: 0, blocked: 0, cancelled: 0 },
    unknownResults: [],
    recovery: recoveryFacts(port),
    truncated: false,
    limits: { listMax: CONTROL_LIST_MAX },
  })

  const ledger = ledgerOf(port)
  if (ledger === null) return unavailable('ledger-unavailable', null)
  const read = readLedger(ledger, limit)
  if (!read.ok) return unavailable('ledger-read-failed', read.detail)
  const value = read.value
  const now = generatedAt

  const cards = value.approvals.map((row) =>
    approvalCardFacts(row, {
      now,
      liveVersion: row.taskId === null ? null : (value.versions.get(row.taskId) ?? null),
      liveEpoch: value.liveEpoch,
      writable: value.writable,
    }),
  )
  const pendingApprovals = cards.filter((card) => card.status === 'pending')
  const invalidApprovals = cards.filter((card) => card.status !== 'pending' && card.status !== 'allowed' && card.status !== 'rejected')
  const actions = value.actions.map(actionFacts)
  const unknownResults = actions.filter((action) => action.bucket === 'unknown')

  return {
    ...base,
    available: true,
    reason: null,
    detail: null,
    readOnly: true,
    pendingApprovals,
    invalidApprovals,
    approvalCounts: approvalCounts(cards, value.approvals),
    actions,
    actionCounts: actionCounts(value.actions),
    unknownResults,
    recovery: recoveryFacts(port),
    truncated: value.approvalTotal > value.approvals.length || value.actionTotal > value.actions.length,
    limits: { listMax: CONTROL_LIST_MAX },
  }
}

/* ── approvals() ─────────────────────────────────────────────────────── */

/** All approval cards in the domain (bounded), with the exact binding each requires. */
export function controlApprovalsFacts(port: ControlPort, request?: unknown): ControlApprovalsFacts {
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const limit = clampLimit(raw.limit)
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const emptyCounts: ControlStateFacts['approvalCounts'] = {
    pending: 0,
    validPending: 0,
    invalidPending: 0,
    allowed: 0,
    rejected: 0,
    expired: 0,
    stale: 0,
    cancelled: 0,
  }
  const ledger = ledgerOf(port)
  if (ledger === null) {
    return {
      ...base,
      available: false,
      reason: 'ledger-unavailable',
      detail: null,
      readOnly: true,
      approvals: [],
      counts: emptyCounts,
      total: 0,
      truncated: false,
      limits: { listMax: CONTROL_LIST_MAX },
    }
  }
  let rows: ControlApprovalRow[]
  let total = 0
  let liveEpoch = 1
  let versions = new Map<string, number>()
  let writable = false
  try {
    const listed = ledger.listApprovals(limit)
    rows = listed.rows
    total = listed.total
    liveEpoch = ledger.policyEpoch()
    versions = ledger.taskVersions()
    writable = ledger.writable()
  } catch (error) {
    return {
      ...base,
      available: false,
      reason: 'ledger-read-failed',
      detail: errorDetail(error),
      readOnly: true,
      approvals: [],
      counts: emptyCounts,
      total: 0,
      truncated: false,
      limits: { listMax: CONTROL_LIST_MAX },
    }
  }
  const cards = rows.map((row) =>
    approvalCardFacts(row, {
      now: generatedAt,
      liveVersion: row.taskId === null ? null : (versions.get(row.taskId) ?? null),
      liveEpoch,
      writable,
    }),
  )
  return {
    ...base,
    available: true,
    reason: null,
    detail: null,
    readOnly: true,
    approvals: cards,
    counts: approvalCounts(cards, rows),
    total,
    truncated: total > rows.length,
    limits: { listMax: CONTROL_LIST_MAX },
  }
}

/* ── decideApproval() — the human decision ───────────────────────────── */

const DECIDE_MESSAGE = {
  allowed: '审批结论已落账（允许本次）。写模式关闭：本次没有派发任何动作，也没有执行任何外部副作用。',
  rejected: '审批已拒绝并落账。不会派发任何动作。',
  alreadyHandled: '该审批已在别处处理：本次没有再次放行，也没有派发任何动作。',
  staleExpired: '此审批已过期失效，不能批准；没有派发任何动作。请重新核查后申请。',
  staleMoved: '任务版本或策略纪元已变化，原审批卡已失效，不能批准；没有派发任何动作。请重新核查后申请。',
  staleBinding: '请求携带的绑定与账本不一致（参数/任务版本/策略纪元/nonce），已拒绝；没有派发任何动作。请重新读取卡片后再试。',
  notFound: '账本中不存在该审批（或不属于当前数据域）。',
  invalidRequest: '请求不完整：需要 approvalId、decision（approve/reject）与完整的 expected 绑定（payloadHash/taskVersion/policyEpoch/nonce）。',
  unavailable: '账本当前不可写，审批结论无法落账；没有派发任何动作。',
} as const

interface DecideRequest {
  approvalId: string
  decision: Decision
  expected: { payloadHash: string; taskVersion: number; policyEpoch: number; nonce: string }
}

function parseDecideRequest(request: unknown): { ok: true; value: DecideRequest } | { ok: false; field: string } {
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  if (typeof raw.approvalId !== 'string' || raw.approvalId.trim() === '') return { ok: false, field: 'approvalId' }
  if (raw.decision !== 'approve' && raw.decision !== 'reject') return { ok: false, field: 'decision' }
  const expected = (typeof raw.expected === 'object' && raw.expected !== null ? raw.expected : {}) as Record<string, unknown>
  if (typeof expected.payloadHash !== 'string' || expected.payloadHash === '') return { ok: false, field: 'expected.payloadHash' }
  if (typeof expected.taskVersion !== 'number' || !Number.isInteger(expected.taskVersion)) {
    return { ok: false, field: 'expected.taskVersion' }
  }
  if (typeof expected.policyEpoch !== 'number' || !Number.isInteger(expected.policyEpoch)) {
    return { ok: false, field: 'expected.policyEpoch' }
  }
  if (typeof expected.nonce !== 'string' || expected.nonce === '') return { ok: false, field: 'expected.nonce' }
  return {
    ok: true,
    value: {
      approvalId: raw.approvalId.trim(),
      decision: raw.decision,
      expected: {
        payloadHash: expected.payloadHash,
        taskVersion: expected.taskVersion,
        policyEpoch: expected.policyEpoch,
        nonce: expected.nonce,
      },
    },
  }
}

/**
 * Land ONE human approval decision. Nothing here dispatches or executes; the
 * only writes are the approval CAS/status and the audit row.
 */
export function decideApprovalFacts(port: ControlPort, request?: unknown): ControlDecideFacts {
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const parsed = parseDecideRequest(request)
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const approvalId = parsed.ok ? parsed.value.approvalId : typeof raw.approvalId === 'string' && raw.approvalId.trim() !== '' ? raw.approvalId.trim() : null
  const decision: Decision | null = raw.decision === 'approve' || raw.decision === 'reject' ? raw.decision : null
  const refuse = (
    outcome: DecideOutcome,
    code: ControlDecideFacts['code'],
    message: string,
    extra: Partial<ControlDecideFacts> = {},
  ): ControlDecideFacts => {
    const audit =
      outcome === 'invalid-request' || outcome === 'not-found' || outcome === 'capability-unavailable'
        ? writeAudit(port, {
            kind: 'control/approval-refused',
            objectId: approvalId,
            actor: 'ui',
            reason: `${code ?? outcome}${extra.staleCause ? `:${extra.staleCause}` : ''}`,
          })
        : writeAudit(port, {
            kind: 'control/approval-refused',
            objectId: approvalId,
            actor: 'ui',
            reason: `APPROVAL_STALE:${extra.staleCause ?? 'unknown'}`,
          })
    return {
      ...base,
      command: 'decideApproval',
      accepted: false,
      executed: false,
      dispatched: false,
      approvalId,
      decision,
      outcome,
      code,
      staleCause: null,
      markedInvalid: false,
      idempotent: false,
      existingStatus: null,
      approval: null,
      message,
      ...extra,
      audit,
    }
  }

  if (!parsed.ok) {
    return refuse('invalid-request', 'INVALID_ARGUMENT', `${DECIDE_MESSAGE.invalidRequest} 缺少/非法字段：${parsed.field}`)
  }
  const value = parsed.value
  const ledger = ledgerOf(port)
  if (ledger === null) return refuse('capability-unavailable', 'CAPABILITY_UNAVAILABLE', DECIDE_MESSAGE.unavailable)
  if (!safeOf(() => ledger.writable(), false)) {
    return refuse('capability-unavailable', 'CAPABILITY_UNAVAILABLE', DECIDE_MESSAGE.unavailable)
  }

  let row: ControlApprovalRow | null
  try {
    row = ledger.getApproval(value.approvalId)
  } catch (error) {
    return refuse('capability-unavailable', 'CAPABILITY_UNAVAILABLE', `审批读取失败：${errorDetail(error)}`)
  }
  if (row === null) return refuse('not-found', 'APPROVAL_NOT_FOUND', DECIDE_MESSAGE.notFound)

  const versions = safeOf(() => ledger.taskVersions(), new Map<string, number>())
  const liveEpoch = safeOf(() => ledger.policyEpoch(), row.policyEpoch)
  const liveVersion = row.taskId === null ? null : (versions.get(row.taskId) ?? null)
  const card = (r: ControlApprovalRow): ControlApprovalCardFacts =>
    approvalCardFacts(r, { now: generatedAt, liveVersion: r.taskId === null ? null : (versions.get(r.taskId) ?? null), liveEpoch, writable: true })

  const finish = (
    outcome: DecideOutcome,
    code: ControlDecideFacts['code'],
    message: string,
    options: { staleCause?: StaleCause | null; markedInvalid?: boolean; idempotent?: boolean; existingStatus?: ApprovalStatus | null; reRead?: boolean } = {},
  ): ControlDecideFacts => {
    let current: ControlApprovalRow | null = row
    if (options.reRead === true) {
      try {
        current = ledger.getApproval(value.approvalId)
      } catch {
        current = row
      }
    }
    const accepted = outcome === 'allowed' || outcome === 'rejected'
    const audit = writeAudit(port, {
      kind: accepted ? 'control/approval-decided' : 'control/approval-refused',
      objectId: value.approvalId,
      actor: 'ui',
      reason: accepted
        ? `${value.decision}:${outcome}; taskVersion=${row?.taskVersion ?? 'unknown'}; dispatch=false`
        : `${code ?? outcome}${options.staleCause ? `:${options.staleCause}` : ''}`,
    })
    return {
      ...base,
      command: 'decideApproval',
      accepted,
      executed: false,
      dispatched: false,
      approvalId: value.approvalId,
      decision: value.decision,
      outcome,
      code,
      staleCause: options.staleCause ?? null,
      markedInvalid: options.markedInvalid === true,
      idempotent: options.idempotent === true,
      existingStatus: options.existingStatus ?? null,
      approval: current === null ? null : card(current),
      message,
      audit,
    }
  }

  /* Already handled: never allow a second time, never dispatch. */
  if (row.status === 'allowed') {
    return finish('already-handled', null, DECIDE_MESSAGE.alreadyHandled, {
      idempotent: true,
      existingStatus: 'allowed',
      reRead: true,
    })
  }
  if (row.status === 'rejected') {
    return finish('already-handled', null, DECIDE_MESSAGE.alreadyHandled, {
      idempotent: true,
      existingStatus: 'rejected',
      reRead: true,
    })
  }
  if (row.status !== 'pending') {
    return finish('stale', 'APPROVAL_STALE', row.status === 'expired' ? DECIDE_MESSAGE.staleExpired : DECIDE_MESSAGE.staleMoved, {
      staleCause: row.status === 'expired' ? 'expired' : 'task-version-moved',
      markedInvalid: true,
      existingStatus: row.status,
      reRead: true,
    })
  }

  /* Expiry first: persist the expiry (consume CAS performs the status change). */
  if (row.expiresAt <= generatedAt) {
    try {
      ledger.consumeApproval({
        approvalId: row.approvalId,
        nonce: row.nonce,
        payloadHash: row.payloadHash,
        taskVersion: row.taskVersion,
        policyEpoch: row.policyEpoch,
      })
    } catch {
      /* the refusal stands even when persisting the expiry failed */
    }
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleExpired, {
      staleCause: 'expired',
      markedInvalid: true,
      existingStatus: 'expired',
      reRead: true,
    })
  }

  /* The live plan moved: invalidate the old card instead of leaving it clickable. */
  if (liveVersion !== null && liveVersion !== row.taskVersion) {
    let marked = false
    try {
      marked = ledger.markApprovalInvalid(value.approvalId, 'task-version-moved')
    } catch {
      marked = false
    }
    const after = safeOf(() => ledger.getApproval(value.approvalId), row)
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleMoved, {
      staleCause: 'task-version-moved',
      markedInvalid: marked || after === null || after.status !== 'pending',
      existingStatus: after?.status ?? 'stale',
      reRead: true,
    })
  }
  if (row.policyEpoch !== liveEpoch) {
    let marked = false
    try {
      marked = ledger.markApprovalInvalid(value.approvalId, 'policy-epoch-moved')
    } catch {
      marked = false
    }
    const after = safeOf(() => ledger.getApproval(value.approvalId), row)
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleMoved, {
      staleCause: 'policy-epoch-moved',
      markedInvalid: marked || after === null || after.status !== 'pending',
      existingStatus: after?.status ?? 'stale',
      reRead: true,
    })
  }

  /* The caller's card must name the exact ledger binding; a mismatch is NOT a reason
   * to invalidate a possibly-legitimate card — the UI must re-read it. */
  if (value.expected.payloadHash !== row.payloadHash) {
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleBinding, { staleCause: 'payload-changed' })
  }
  if (value.expected.taskVersion !== row.taskVersion) {
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleBinding, { staleCause: 'caller-binding-mismatch' })
  }
  if (value.expected.policyEpoch !== row.policyEpoch) {
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleBinding, { staleCause: 'caller-binding-mismatch' })
  }
  if (value.expected.nonce !== row.nonce) {
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleBinding, { staleCause: 'nonce-mismatch' })
  }

  if (value.decision === 'approve') {
    let status: ReturnType<ControlLedgerPort['consumeApproval']>
    try {
      status = ledger.consumeApproval({
        approvalId: value.approvalId,
        nonce: value.expected.nonce,
        payloadHash: value.expected.payloadHash,
        taskVersion: value.expected.taskVersion,
        policyEpoch: value.expected.policyEpoch,
      })
    } catch (error) {
      return refuse('capability-unavailable', 'CAPABILITY_UNAVAILABLE', `审批落账失败：${errorDetail(error)}`)
    }
    if (status === 'allowed') return finish('allowed', null, DECIDE_MESSAGE.allowed, { reRead: true })
    if (status === 'expired') {
      return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleExpired, {
        staleCause: 'expired',
        markedInvalid: true,
        existingStatus: 'expired',
        reRead: true,
      })
    }
    if (status === 'not_found') return finish('not-found', 'APPROVAL_NOT_FOUND', DECIDE_MESSAGE.notFound, { reRead: true })
    if (status === 'allowed' || status === 'rejected' || status === 'cancelled') {
      return finish('already-handled', null, DECIDE_MESSAGE.alreadyHandled, {
        idempotent: true,
        existingStatus: status,
        reRead: true,
      })
    }
    return finish('stale', 'APPROVAL_STALE', DECIDE_MESSAGE.staleBinding, { staleCause: 'caller-binding-mismatch', reRead: true })
  }

  try {
    ledger.rejectApproval(value.approvalId)
  } catch (error) {
    return refuse('capability-unavailable', 'CAPABILITY_UNAVAILABLE', `审批落账失败：${errorDetail(error)}`)
  }
  return finish('rejected', null, DECIDE_MESSAGE.rejected, { reRead: true })
}

/* ── stop() — deterministic, model-free ──────────────────────────────── */

const STOP_MESSAGES = {
  invalidScope: '停止范围无效：scope 必须是 "all"、"task:{taskId}"、"action:{actionId}" 或 "session:{sessionId}"。',
  nothing: '没有可停止的 BOOP 动作（用户自己的 turn 不在停止范围，也没有任何外部副作用被宣称撤销）。',
  stoppedSome: '已确定性停止 BOOP 自有待发动作；请求已发出的动作不会被宣称撤销。',
  refusedSome: '部分动作无法确定性停止（已投递或已终态）；没有宣称任何外部副作用被撤销。',
  unavailable: '账本当前不可写，无法确定性停止；没有改动任何动作。',
} as const

function parseStopScope(raw: unknown): ControlStopScopeFacts {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'all') return { raw: value, kind: 'all', id: null }
  const separator = value.indexOf(':')
  if (separator > 0) {
    const kind = value.slice(0, separator)
    const id = value.slice(separator + 1).trim()
    if (id !== '' && (kind === 'task' || kind === 'action' || kind === 'session')) {
      return { raw: value, kind: kind as StopScopeKind, id }
    }
  }
  return { raw: value, kind: null, id: null }
}

function matchesStopScope(row: ControlActionRow, scope: ControlStopScopeFacts): boolean {
  if (scope.kind === 'all') return true
  if (scope.kind === 'task') return row.taskId === scope.id
  if (scope.kind === 'action') return row.actionId === scope.id
  if (scope.kind === 'session') return row.targetSessionId === scope.id
  return false
}

/**
 * Deterministic stop of BOOP-owned work. It writes only ledger bookkeeping:
 * pending actions become `stopped`, their outbox rows `cancelled`, and still
 * pending approvals bound to those actions are invalidated. It never cancels a
 * user's turn and never claims an external side effect was undone.
 */
export function controlStopFacts(port: ControlPort, request?: unknown): ControlStopFacts {
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const scope = parseStopScope(raw.scope)
  const policy: ControlPolicyFacts = {
    ownsOnly: 'boop-ledger-actions',
    userTurnsStopped: false,
    foreignTurns: 'not-inspected-never-stopped',
    externalSideEffectsUndone: false,
    deterministic: true,
    requiresModel: false,
  }
  let truncated = false
  const finish = (
    accepted: boolean,
    stopped: ControlStoppedActionFacts[],
    refused: ControlRefusedActionFacts[],
    unknown: ControlUnknownActionFacts[],
    matched: number,
    message: string,
    extra: Partial<ControlStopFacts> = {},
  ): ControlStopFacts => {
    const audit = writeAudit(port, {
      kind: accepted ? 'control/stop' : 'control/stop-refused',
      objectId: scope.raw === '' ? null : scope.raw,
      actor: 'ui',
      reason: `matched=${matched} stopped=${stopped.length} refused=${refused.length} unknown=${unknown.length}`,
    })
    return {
      ...base,
      command: 'stop',
      available: true,
      accepted,
      executed: stopped.length > 0,
      noop: accepted && matched === 0,
      deterministic: true,
      requiresModel: false,
      requestedScope: scope,
      matched,
      stopped,
      refused,
      unknown,
      summary: { matched, stopped: stopped.length, refused: refused.length, unknown: unknown.length },
      policy,
      message,
      truncated,
      code: null,
      ...extra,
      audit,
    }
  }

  if (scope.kind === null) {
    return finish(false, [], [], [], 0, STOP_MESSAGES.invalidScope, {
      code: 'INVALID_ARGUMENT',
    })
  }
  const ledger = ledgerOf(port)
  if (ledger === null) {
    return finish(false, [], [], [], 0, STOP_MESSAGES.unavailable, {
      available: false,
      code: 'CAPABILITY_UNAVAILABLE',
    })
  }
  if (!safeOf(() => ledger.writable(), false)) {
    return finish(false, [], [], [], 0, STOP_MESSAGES.unavailable, {
      available: false,
      code: 'CAPABILITY_UNAVAILABLE',
    })
  }

  let rows: ControlActionRow[]
  try {
    const listed = ledger.listActions(CONTROL_LIST_MAX)
    rows = listed.rows
    truncated = listed.total > listed.rows.length
  } catch (error) {
    return finish(false, [], [], [], 0, `${STOP_MESSAGES.unavailable}（${errorDetail(error)}）`, {
      available: false,
      code: 'CAPABILITY_UNAVAILABLE',
    })
  }

  const matchedRows = rows.filter((row) => matchesStopScope(row, scope))
  if (matchedRows.length === 0) {
    return finish(true, [], [], [], 0, STOP_MESSAGES.nothing, { code: null })
  }

  const stopped: ControlStoppedActionFacts[] = []
  const refused: ControlRefusedActionFacts[] = []
  const unknown: ControlUnknownActionFacts[] = []
  const matched = matchedRows.length
  // One bounded approval read for the whole stop, never one query per action.
  const approvalRows = safeOf(() => ledger.listApprovals(CONTROL_LIST_MAX).rows, [] as ControlApprovalRow[])

  for (const row of matchedRows) {
    if (row.outboxState === 'sending') {
      unknown.push({
        actionId: row.actionId,
        taskId: row.taskId,
        targetSessionId: row.targetSessionId,
        actionState: row.state,
        outboxState: row.outboxState,
        code: 'DELIVERY_IN_FLIGHT',
        reason: 'outbox 处于 sending：投递进行中，无法确定性停止',
        note: '不宣称已撤销任何外部副作用；请核对原 Session 的实际状态后再决定是否重试。',
      })
      continue
    }
    if (bucketOf(row) === 'unknown') {
      unknown.push({
        actionId: row.actionId,
        taskId: row.taskId,
        targetSessionId: row.targetSessionId,
        actionState: row.state,
        outboxState: row.outboxState,
        code: 'OUTCOME_UNKNOWN',
        reason: '动作结果已是 unknown：禁止自动重试',
        note: '请人工核对原 Session 的外部实际状态；本控制面不会重试或宣称撤销。',
      })
      continue
    }
    if (!cancellableOf(row)) {
      const bucket = bucketOf(row)
      refused.push({
        actionId: row.actionId,
        taskId: row.taskId,
        targetSessionId: row.targetSessionId,
        actionState: row.state,
        outboxState: row.outboxState,
        bucket,
        code: bucket === 'accepted' ? 'ALREADY_DELIVERED' : bucket === 'cancelled' ? 'ALREADY_TERMINAL' : 'NOT_CANCELLABLE',
        reason:
          bucket === 'accepted'
            ? '请求已投递到原 Session，账本无法证明当前 turn 属于 BOOP，故不宣称已撤销'
            : '动作已处于终态（stopped/rejected/settled 或 outbox 已结束）',
        note:
          bucket === 'accepted'
            ? '如仍在运行，请在原 Session 用原生 Stop 停止；BOOP 不会停止用户自己的 turn。'
            : '无需再次停止。',
      })
      continue
    }

    /* Cancellable: ledger bookkeeping only, no model, no remote turn. */
    const invalidatedApprovalIds: string[] = []
    try {
      ledger.markActionStopped(row.actionId)
      ledger.settleOutboxCancelled(row.actionId)
      for (const approval of approvalRows) {
        if (approval.actionId !== row.actionId || approval.status !== 'pending') continue
        try {
          ledger.rejectApproval(approval.approvalId)
          invalidatedApprovalIds.push(approval.approvalId)
        } catch {
          /* the action is still stopped; a failed card invalidation is reported by state() */
        }
      }
    } catch (error) {
      refused.push({
        actionId: row.actionId,
        taskId: row.taskId,
        targetSessionId: row.targetSessionId,
        actionState: row.state,
        outboxState: row.outboxState,
        bucket: bucketOf(row),
        code: 'LEDGER_WRITE_FAILED',
        reason: `账本写入失败：${errorDetail(error)}`,
        note: '本次没有宣称该动作已停止。',
      })
      continue
    }
    stopped.push({
      actionId: row.actionId,
      taskId: row.taskId,
      targetSessionId: row.targetSessionId,
      previousActionState: row.state,
      previousOutboxState: row.outboxState,
      actionState: 'stopped',
      outboxState: 'cancelled',
      invalidatedApprovalIds,
      note: '仅取消 BOOP 自己的待发动作与 outbox；外部副作用未发生也无从撤销。',
    })
  }

  const message =
    stopped.length > 0
      ? STOP_MESSAGES.stoppedSome
      : refused.length > 0 || unknown.length > 0
        ? STOP_MESSAGES.refusedSome
        : STOP_MESSAGES.nothing
  return finish(true, stopped, refused, unknown, matched, message, { executed: stopped.length > 0, code: null })
}

/* ── recovery() ──────────────────────────────────────────────────────── */

/** Restart-recovery inspection: the armed gate, its entries, and unknown BOOP results. */
export function controlRecoveryFacts(port: ControlPort, _request?: unknown): ControlRecoveryFactsResponse {
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const ledger = ledgerOf(port)
  let unknownResults: ControlActionFacts[] = []
  let available = true
  let reason: string | null = null
  let detail: string | null = null
  let truncated = false
  if (ledger === null) {
    available = false
    reason = 'ledger-unavailable'
  } else {
    try {
      const listed = ledger.listActions(CONTROL_LIST_MAX)
      unknownResults = listed.rows.map(actionFacts).filter((action) => action.bucket === 'unknown')
      truncated = listed.total > listed.rows.length
    } catch (error) {
      available = false
      reason = 'ledger-read-failed'
      detail = errorDetail(error)
    }
  }
  return {
    ...base,
    readOnly: true,
    available,
    reason,
    detail,
    recovery: recoveryFacts(port),
    unknownResults,
    truncated,
    audit: readAudit(port, 'read-only recovery inspection does not write an audit row'),
  }
}

/* ── release() — explicit per-message human act ──────────────────────── */

/** Explicitly release EXACTLY the named gate entries; never a bulk default. */
export function controlReleaseFacts(port: ControlPort, request?: unknown): ControlReleaseFacts {
  const projectionSeq = seqOf(port)
  const generatedAt = nowIso(port)
  const base = baseFacts(port, projectionSeq, generatedAt)
  const raw = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const requested = Array.isArray(raw.messageIds)
    ? [...new Set(raw.messageIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '').map((id: string) => id.trim()))]
    : []
  const finish = (
    accepted: boolean,
    released: ControlRecoveryEntryFacts[],
    ignored: ControlReleaseFacts['ignored'],
    message: string,
    code: ControlReleaseFacts['code'],
  ): ControlReleaseFacts => {
    const audit = writeAudit(port, {
      kind: accepted ? 'control/gate-released' : 'control/release-refused',
      objectId: requested.length === 0 ? null : requested.join(','),
      actor: 'ui',
      reason: `released=${released.map((entry) => entry.messageId).join(',') || '-'} ignored=${ignored.length}`,
    })
    return {
      ...base,
      command: 'release',
      accepted,
      requestedMessageIds: requested,
      released,
      ignored,
      requiresExplicitSelection: true,
      bulkDefault: false,
      code,
      message,
      audit,
    }
  }

  const gate = gateOf(port)
  if (gate === null) {
    return finish(false, [], [], '恢复门禁服务不可用；没有释放任何命令。', 'CAPABILITY_UNAVAILABLE')
  }
  if (requested.length === 0) {
    return finish(
      false,
      [],
      [],
      '必须显式选择要释放的 messageId；本接口不会默认全选，也不会批量放行。',
      'INVALID_ARGUMENT',
    )
  }
  let releasedIds: ControlGateEntryFacts[]
  try {
    releasedIds = gate.release(requested)
  } catch (error) {
    return finish(false, [], [], `释放失败：${errorDetail(error)}`, 'CAPABILITY_UNAVAILABLE')
  }
  const releasedSet = new Set(releasedIds.map((entry) => entry.messageId))
  const released: ControlRecoveryEntryFacts[] = releasedIds.map((entry) => ({
    messageId: entry.messageId,
    actionId: entry.actionId,
    sessionId: entry.sessionId,
    state: entry.state,
    reason: entry.reason,
    releasable: false,
  }))
  const ignored: ControlReleaseFacts['ignored'] = []
  for (const messageId of requested) {
    if (releasedSet.has(messageId)) continue
    const known = safeOf(() => gate.entries().find((entry) => entry.messageId === messageId), undefined)
    ignored.push({
      messageId,
      reason: known === undefined ? 'unknown-message-id' : 'already-released',
    })
  }
  const enforcement = safeOf(() => port.runtimeEnforcement?.() ?? null, null)
  const message =
    released.length === 0
      ? '没有释放任何命令：所选 messageId 均不在门禁账本中（未创建、未放行）。'
      : `已显式释放 ${released.length} 条命令；${ignored.length} 条未知/已释放被忽略。${
          enforcement?.composed === true
            ? '运行时 agent/pre-step 门控已注册：这些唯一 messageId 会在下一次准入时被放行一次，不会放行其他命令。'
            : '运行时 agent/pre-step 门控未注册：释放只改变门禁账本，不代表运行时会放行。'
        }`
  return finish(released.length > 0 || ignored.length > 0, released, ignored, message, null)
}
