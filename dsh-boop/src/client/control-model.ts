/**
 * BOOP human-control view model (E04-03 client half) — pure logic for the
 * approval / stop / recovery surfaces.
 *
 * Contract by task-9 (Host half `boopControl`, finalised 2026-10-18; real JSON
 * fixtures in `.work/control-fixtures.json`): Typert Remote namespace, methods
 * `state` / `approvals` / `decideApproval` / `stop` / `recovery` / `release`;
 * each takes ONE `request` object and resolves to ONE fact object at
 * `result.value` (single layer, same convention as `boopTasks`).
 *
 * Frozen rules encoded here (04§08–10, 03§07–10, E04-03 issue):
 *  - "request sent" is NEVER "executed": every command receipt is parsed for the
 *    server's explicit `accepted`/`executed`/`dispatched`/`outcome` facts; the
 *    UI only claims what the server stated (no optimistic approval, no fake
 *    stop);
 *  - a stale approval (`APPROVAL_STALE` + `staleCause`) or an approval already
 *    handled elsewhere (`outcome:'already-handled'`, idempotent) is surfaced
 *    with the exact server reason and can never be clicked into a second
 *    decision;
 *  - Stop is deterministic (`requiresModel:false`) and scoped: `all` |
 *    `task:{id}` | `action:{id}` | `session:{id}`; the three result buckets
 *    (`stopped` / `refused` / `unknown`) keep their own meaning — a refused
 *    delivered action is never shown as stopped, an unknown one is never
 *    retried;
 *  - recovery release is explicit: no default selection and no bulk "select
 *    all"; the client only sends the messageIds the human checked, and the Host
 *    states whether the runtime pre-step enforcement is actually composed;
 *  - stale responses are discarded by a monotonic request sequence and the
 *    Host's own `projectionSeq`.
 */

/** Client-side host call shape: exactly the BOOP connection `call` envelope. */
export type ControlCall = (
  endpoint: string,
  args?: Record<string, unknown>,
) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }>

/* ── wire (contract by task-9) ────────────────────────────────────────── */

export const CONTROL_ENDPOINTS = {
  state: 'boopControl/state',
  approvals: 'boopControl/approvals',
  decideApproval: 'boopControl/decideApproval',
  stop: 'boopControl/stop',
  recovery: 'boopControl/recovery',
  release: 'boopControl/release',
} as const

/**
 * rc.2.1 Typert wire carries exactly one plain-object `args` field and BOOP
 * Remote services take ONE `request` parameter (same convention as
 * `boopTasks`). Kept in one place so a Host-side parameter rename is a one-line
 * change here.
 */
export const CONTROL_ARG_KEY = 'request' as const

export function controlArgs(payload: Record<string, unknown>): Record<string, unknown> {
  return { [CONTROL_ARG_KEY]: payload }
}

/* ── shared Host facts ────────────────────────────────────────────────── */

export interface ControlWriteModeFacts {
  enabled: boolean
  source?: string
  blockedByGates: string[]
}

export interface ControlLedgerFacts {
  writable: boolean
  auditSink: string
  durable: boolean
}

export interface ControlDispatchFacts {
  available: boolean
  reason: string | null
  requiresModel: boolean
  detail: string | null
}

export interface ControlAuditFacts {
  recorded: boolean
  sink: string
  id: string | null
  kind: string | null
  note: string | null
}

/* ── approvals ────────────────────────────────────────────────────────── */

export type ApprovalStatus =
  | 'pending'
  | 'allowed'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'cancelled'
  | (string & {})

export type ApprovalInvalidReason = 'expired' | 'task-version-moved' | 'policy-epoch-moved' | null

export interface ApprovalFacts {
  approvalId: string
  status: ApprovalStatus
  actionId: string
  taskId: string | null
  targetSessionId: string | null
  /** Normalized parameter hash the approval binds to (03§10). */
  payloadHash: string
  taskVersion: number
  policyEpoch: number
  requestingOwner: string
  expiresAt: string | null
  consumedAt: string | null
  invalidReason: ApprovalInvalidReason
  /** true = still binds to the live plan. */
  valid: boolean
  /** true = valid AND the ledger is writable, i.e. the buttons may be enabled. */
  canDecide: boolean
  decision: 'allowed' | 'rejected' | null
  /** Binding nonce; required by the decide request (single-use CAS, 03§10). */
  nonce: string
}

/* ── actions / outbox ─────────────────────────────────────────────────── */

export interface ControlActionFacts {
  actionId: string
  taskId: string | null
  taskVersion: number
  targetSessionId: string | null
  state: string
  /** Host bucket: pending / accepted / unknown / blocked / cancelled. */
  bucket: string
  outboxState: string | null
  outboxAttempt: number
  leaseUntil: string | null
  messageId: string | null
  policyEpoch: number
  originRef: string
  payloadHash: string
  /** 'boop' = BOOP-owned action (stoppable); user turns are never listed as such. */
  ownership: string
  cancellable: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface UnknownResultFacts extends ControlActionFacts {}

/* ── recovery gate ────────────────────────────────────────────────────── */

export interface RecoveryEntryFacts {
  messageId: string
  actionId: string
  sessionId: string
  state: 'blocked' | 'released' | (string & {})
  reason: string | null
  /** false = this entry cannot be released (already released / not owned). */
  releasable: boolean
}

export interface RecoveryRuntimeEnforcementFacts {
  /** false = release only moves the gate ledger; pre-step enforcement NOT composed. */
  composed: boolean
  detail: string | null
}

export interface RecoveryGateFacts {
  available: boolean
  reason: string | null
  armed: boolean
  entries: RecoveryEntryFacts[]
  pendingCount: number
  releasedCount: number
  /** The Host states bulk release is not the default; the UI must honour it. */
  requiresExplicitSelection: boolean
  bulkReleaseDefault: boolean
  runtimeEnforcement: RecoveryRuntimeEnforcementFacts
}

/* ── read facts ───────────────────────────────────────────────────────── */

export interface ApprovalCountsFacts {
  pending: number
  validPending: number
  invalidPending: number
  allowed: number
  rejected: number
  expired: number
  stale: number
  cancelled: number
}

export interface ActionCountsFacts {
  total: number
  pending: number
  accepted: number
  unknown: number
  blocked: number
  cancelled: number
}

export interface ControlStateFacts {
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  writeMode: ControlWriteModeFacts | null
  ledger: ControlLedgerFacts | null
  dispatch: ControlDispatchFacts | null
  audit: ControlAuditFacts | null
  pendingApprovals: ApprovalFacts[]
  invalidApprovals: ApprovalFacts[]
  approvalCounts: ApprovalCountsFacts | null
  actions: ControlActionFacts[]
  actionCounts: ActionCountsFacts | null
  unknownResults: UnknownResultFacts[]
  recovery: RecoveryGateFacts
  truncated: boolean
  limits: Record<string, number>
  projectionSeq: number | null
  generatedAt: string | null
}

export interface ApprovalListFacts {
  available: boolean
  reason: string | null
  approvals: ApprovalFacts[]
  counts: ApprovalCountsFacts | null
  total: number
  truncated: boolean
  projectionSeq: number | null
}

export interface RecoveryFacts {
  available: boolean
  reason: string | null
  detail: string | null
  recovery: RecoveryGateFacts
  unknownResults: UnknownResultFacts[]
  /** true = the recovery/action read cap was hit; the list is only partial. */
  truncated: boolean
  projectionSeq: number | null
}

/* ── write receipts ───────────────────────────────────────────────────── */

export interface DecisionFacts {
  available: boolean
  reason: string | null
  command: string
  accepted: boolean
  executed: boolean
  dispatched: boolean
  approvalId: string
  decision: string | null
  /** Host outcome: allowed / rejected / already-handled / stale / not-found / invalid / capability-unavailable. */
  outcome: string
  code: string | null
  staleCause: string | null
  markedInvalid: boolean
  idempotent: boolean
  existingStatus: string | null
  approval: ApprovalFacts | null
  message: string | null
  audit: ControlAuditFacts | null
  writeMode: ControlWriteModeFacts | null
  ledger: ControlLedgerFacts | null
  dispatch: ControlDispatchFacts | null
  projectionSeq: number | null
}

export interface StopItemFacts {
  actionId: string
  taskId: string | null
  targetSessionId: string | null
  previousActionState: string | null
  previousOutboxState: string | null
  actionState: string
  outboxState: string | null
  invalidatedApprovalIds: string[]
  note: string | null
}

export interface StopRefusalItemFacts extends StopItemFacts {
  bucket: string
  code: string
  reason: string
}

export interface StopUnknownItemFacts extends StopRefusalItemFacts {}

export interface StopSummaryFacts {
  matched: number
  stopped: number
  refused: number
  unknown: number
}

export interface StopPolicyFacts {
  ownsOnly: string
  userTurnsStopped: boolean
  foreignTurns: string
  externalSideEffectsUndone: boolean
  deterministic: boolean
  requiresModel: boolean
}

export interface StopScopeFacts {
  raw: string
  kind: string
  id: string | null
}

export interface StopFacts {
  available: boolean
  reason: string | null
  command: string
  accepted: boolean
  executed: boolean
  /** true = nothing matched; not a success claim (issue E04-03). */
  noop: boolean
  deterministic: boolean
  requiresModel: boolean
  requestedScope: StopScopeFacts | null
  matched: number
  stopped: StopItemFacts[]
  refused: StopRefusalItemFacts[]
  unknown: StopUnknownItemFacts[]
  summary: StopSummaryFacts | null
  policy: StopPolicyFacts | null
  message: string | null
  code: string | null
  audit: ControlAuditFacts | null
  writeMode: ControlWriteModeFacts | null
  ledger: ControlLedgerFacts | null
  dispatch: ControlDispatchFacts | null
  /** true = the action read cap was hit; this stop covered only part of the actions. */
  truncated: boolean
  projectionSeq: number | null
}

export interface ReleaseItemFacts {
  messageId: string
  actionId: string | null
  sessionId: string | null
  state: string
  reason: string | null
  releasable: boolean
}

export interface IgnoredReleaseFacts {
  messageId: string
  reason: string
}

export interface ReleaseFacts {
  available: boolean
  reason: string | null
  command: string
  accepted: boolean
  requestedMessageIds: string[]
  released: ReleaseItemFacts[]
  ignored: IgnoredReleaseFacts[]
  requiresExplicitSelection: boolean
  bulkDefault: boolean
  code: string | null
  message: string | null
  audit: ControlAuditFacts | null
  writeMode: ControlWriteModeFacts | null
  ledger: ControlLedgerFacts | null
  projectionSeq: number | null
}

/* ── defensive normalisation ──────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function normalizeWriteMode(value: unknown): ControlWriteModeFacts | null {
  if (!isRecord(value)) return null
  return {
    enabled: value.enabled === true,
    source: text(value.source) ?? undefined,
    blockedByGates: Array.isArray(value.blockedByGates)
      ? value.blockedByGates.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

export function normalizeLedger(value: unknown): ControlLedgerFacts | null {
  if (!isRecord(value)) return null
  return {
    writable: value.writable === true,
    auditSink: text(value.auditSink) ?? 'unknown',
    durable: value.durable === true,
  }
}

export function normalizeDispatch(value: unknown): ControlDispatchFacts | null {
  if (!isRecord(value)) return null
  return {
    available: value.available === true,
    reason: text(value.reason),
    requiresModel: value.requiresModel === true,
    detail: text(value.detail),
  }
}

export function normalizeAudit(value: unknown): ControlAuditFacts | null {
  if (!isRecord(value)) return null
  return {
    recorded: value.recorded === true,
    sink: text(value.sink) ?? 'unknown',
    id: text(value.id),
    kind: text(value.kind),
    note: text(value.note),
  }
}

function normalizeInvalidReason(value: unknown): ApprovalInvalidReason {
  return value === 'expired' || value === 'task-version-moved' || value === 'policy-epoch-moved' ? value : null
}

export function normalizeApproval(raw: unknown): ApprovalFacts | null {
  if (!isRecord(raw)) return null
  const approvalId = text(raw.approvalId) ?? text(raw.id)
  if (!approvalId) return null
  const status = text(raw.status) ?? 'unknown'
  const invalidReason = normalizeInvalidReason(raw.invalidReason)
  const valid = raw.valid === true
  // canDecide is authoritative from the Host; fall back only for a readable
  // pending row whose Host omitted the flag.
  const canDecide =
    raw.canDecide === true
    || (raw.canDecide === undefined && valid && status === 'pending')
  return {
    approvalId,
    status,
    actionId: text(raw.actionId) ?? '',
    taskId: text(raw.taskId),
    targetSessionId: text(raw.targetSessionId),
    payloadHash: text(raw.payloadHash) ?? '',
    taskVersion: num(raw.taskVersion) ?? 0,
    policyEpoch: num(raw.policyEpoch) ?? 0,
    requestingOwner: text(raw.requestingOwner) ?? 'unknown',
    expiresAt: text(raw.expiresAt),
    consumedAt: text(raw.consumedAt),
    invalidReason,
    valid,
    canDecide,
    decision:
      raw.decision === 'allowed' || raw.decision === 'rejected'
        ? raw.decision
        : text(raw.decision) === 'allowed'
          ? 'allowed'
          : text(raw.decision) === 'rejected'
            ? 'rejected'
            : null,
    nonce: text(raw.nonce) ?? '',
  }
}

export function normalizeApprovals(value: unknown): ApprovalFacts[] {
  return recordList(value)
    .map((entry) => normalizeApproval(entry))
    .filter((entry): entry is ApprovalFacts => entry !== null)
}

function normalizeRecoveryEntry(raw: unknown): RecoveryEntryFacts | null {
  if (!isRecord(raw)) return null
  const messageId = text(raw.messageId)
  if (!messageId) return null
  const state = text(raw.state) ?? 'blocked'
  return {
    messageId,
    actionId: text(raw.actionId) ?? '',
    sessionId: text(raw.sessionId) ?? '',
    state,
    reason: text(raw.reason),
    releasable: raw.releasable === true && state !== 'released',
  }
}

/** Normalise the Host `recovery` sub-object (shared by state and recovery). */
export function normalizeRecoveryGate(value: unknown): RecoveryGateFacts {
  const raw = isRecord(value) ? value : {}
  const runtime = isRecord(raw.runtimeEnforcement) ? raw.runtimeEnforcement : {}
  return {
    available: raw.available !== false,
    reason: text(raw.reason),
    armed: raw.armed === true,
    entries: recordList(raw.entries)
      .map((entry) => normalizeRecoveryEntry(entry))
      .filter((entry): entry is RecoveryEntryFacts => entry !== null),
    pendingCount: num(raw.pendingCount) ?? 0,
    releasedCount: num(raw.releasedCount) ?? 0,
    requiresExplicitSelection: raw.requiresExplicitSelection !== false,
    bulkReleaseDefault: raw.bulkReleaseDefault === true,
    runtimeEnforcement: {
      composed: runtime.composed === true,
      detail: text(runtime.detail),
    },
  }
}

export function normalizeAction(raw: unknown): ControlActionFacts | null {
  if (!isRecord(raw)) return null
  const actionId = text(raw.actionId) ?? text(raw.id)
  if (!actionId) return null
  return {
    actionId,
    taskId: text(raw.taskId),
    taskVersion: num(raw.taskVersion) ?? 0,
    targetSessionId: text(raw.targetSessionId),
    state: text(raw.state) ?? 'unknown',
    bucket: text(raw.bucket) ?? 'unknown',
    outboxState: text(raw.outboxState),
    outboxAttempt: num(raw.outboxAttempt) ?? 0,
    leaseUntil: text(raw.leaseUntil),
    messageId: text(raw.messageId),
    policyEpoch: num(raw.policyEpoch) ?? 0,
    originRef: text(raw.originRef) ?? 'unknown',
    payloadHash: text(raw.payloadHash) ?? '',
    ownership: text(raw.ownership) ?? 'unknown',
    cancellable: raw.cancellable === true,
    createdAt: text(raw.createdAt),
    updatedAt: text(raw.updatedAt),
  }
}

function normalizeActions(value: unknown): ControlActionFacts[] {
  return recordList(value)
    .map((entry) => normalizeAction(entry))
    .filter((entry): entry is ControlActionFacts => entry !== null)
}

function normalizeApprovalCounts(value: unknown): ApprovalCountsFacts | null {
  if (!isRecord(value)) return null
  const count = (key: string): number => num(value[key]) ?? 0
  return {
    pending: count('pending'),
    validPending: count('validPending'),
    invalidPending: count('invalidPending'),
    allowed: count('allowed'),
    rejected: count('rejected'),
    expired: count('expired'),
    stale: count('stale'),
    cancelled: count('cancelled'),
  }
}

function normalizeActionCounts(value: unknown): ActionCountsFacts | null {
  if (!isRecord(value)) return null
  const count = (key: string): number => num(value[key]) ?? 0
  return {
    total: count('total'),
    pending: count('pending'),
    accepted: count('accepted'),
    unknown: count('unknown'),
    blocked: count('blocked'),
    cancelled: count('cancelled'),
  }
}

function normalizeLimits(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const limits: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) limits[key] = entry
  }
  return limits
}

/** Normalise the `boopControl/state` fact object (contract by task-9). */
export function normalizeControlState(value: unknown): ControlStateFacts {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回控制面状态对象',
      detail: null,
      scopeId: null,
      writeMode: null,
      ledger: null,
      dispatch: null,
      audit: null,
      pendingApprovals: [],
      invalidApprovals: [],
      approvalCounts: null,
      actions: [],
      actionCounts: null,
      unknownResults: [],
      recovery: normalizeRecoveryGate(null),
      truncated: false,
      limits: {},
      projectionSeq: null,
      generatedAt: null,
    }
  }
  const unknownResults = normalizeActions(value.unknownResults)
  return {
    available: value.available === true,
    reason: text(value.reason),
    detail: text(value.detail),
    scopeId: text(value.scopeId),
    writeMode: normalizeWriteMode(value.writeMode),
    ledger: normalizeLedger(value.ledger),
    dispatch: normalizeDispatch(value.dispatch),
    audit: normalizeAudit(value.audit),
    pendingApprovals: normalizeApprovals(value.pendingApprovals ?? value.approvals),
    invalidApprovals: normalizeApprovals(value.invalidApprovals),
    approvalCounts: normalizeApprovalCounts(value.approvalCounts),
    actions: normalizeActions(value.actions),
    actionCounts: normalizeActionCounts(value.actionCounts),
    unknownResults,
    recovery: normalizeRecoveryGate(value.recovery),
    truncated: value.truncated === true,
    limits: normalizeLimits(value.limits),
    projectionSeq: num(value.projectionSeq),
    generatedAt: text(value.generatedAt),
  }
}

export function normalizeApprovalList(value: unknown): ApprovalListFacts {
  if (!isRecord(value)) {
    return { available: false, reason: '宿主没有返回审批列表对象', approvals: [], counts: null, total: 0, truncated: false, projectionSeq: null }
  }
  const approvals = normalizeApprovals(value.approvals)
  return {
    available: value.available === true,
    reason: text(value.reason),
    approvals,
    counts: normalizeApprovalCounts(value.counts),
    total: num(value.total) ?? approvals.length,
    truncated: value.truncated === true,
    projectionSeq: num(value.projectionSeq),
  }
}

export function normalizeRecovery(value: unknown): RecoveryFacts {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回恢复核查对象',
      detail: null,
      recovery: normalizeRecoveryGate(null),
      unknownResults: [],
      truncated: false,
      projectionSeq: null,
    }
  }
  return {
    available: value.available === true,
    reason: text(value.reason),
    detail: text(value.detail),
    recovery: normalizeRecoveryGate(value.recovery),
    unknownResults: normalizeActions(value.unknownResults),
    truncated: value.truncated === true,
    projectionSeq: num(value.projectionSeq),
  }
}

export function normalizeDecision(value: unknown): DecisionFacts {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回审批决定回执',
      command: 'decideApproval',
      accepted: false,
      executed: false,
      dispatched: false,
      approvalId: '',
      decision: null,
      outcome: 'unknown',
      code: null,
      staleCause: null,
      markedInvalid: false,
      idempotent: false,
      existingStatus: null,
      approval: null,
      message: null,
      audit: null,
      writeMode: null,
      ledger: null,
      dispatch: null,
      projectionSeq: null,
    }
  }
  return {
    available: value.available !== false,
    reason: text(value.reason),
    command: text(value.command) ?? 'decideApproval',
    accepted: value.accepted === true,
    executed: value.executed === true,
    dispatched: value.dispatched === true,
    approvalId: text(value.approvalId) ?? '',
    decision: text(value.decision),
    outcome: text(value.outcome) ?? 'unknown',
    code: text(value.code),
    staleCause: text(value.staleCause),
    markedInvalid: value.markedInvalid === true,
    idempotent: value.idempotent === true,
    existingStatus: text(value.existingStatus),
    approval: normalizeApproval(value.approval),
    message: text(value.message),
    audit: normalizeAudit(value.audit),
    writeMode: normalizeWriteMode(value.writeMode),
    ledger: normalizeLedger(value.ledger),
    dispatch: normalizeDispatch(value.dispatch),
    projectionSeq: num(value.projectionSeq),
  }
}

function normalizeStopItem(raw: unknown): StopItemFacts | null {
  if (!isRecord(raw)) return null
  const actionId = text(raw.actionId) ?? text(raw.id)
  if (!actionId) return null
  return {
    actionId,
    taskId: text(raw.taskId),
    targetSessionId: text(raw.targetSessionId),
    previousActionState: text(raw.previousActionState),
    previousOutboxState: text(raw.previousOutboxState),
    actionState: text(raw.actionState) ?? 'unknown',
    outboxState: text(raw.outboxState),
    invalidatedApprovalIds: Array.isArray(raw.invalidatedApprovalIds)
      ? raw.invalidatedApprovalIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    note: text(raw.note),
  }
}

function normalizeStopRefusal(raw: unknown): StopRefusalItemFacts | null {
  const item = normalizeStopItem(raw)
  if (!item || !isRecord(raw)) return null
  return {
    ...item,
    bucket: text(raw.bucket) ?? 'refused',
    code: text(raw.code) ?? 'NOT_CANCELLABLE',
    reason: text(raw.reason) ?? '未给出原因',
  }
}

export function normalizeStop(value: unknown): StopFacts {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回停止结果',
      command: 'stop',
      accepted: false,
      executed: false,
      noop: false,
      deterministic: false,
      requiresModel: true,
      requestedScope: null,
      matched: 0,
      stopped: [],
      refused: [],
      unknown: [],
      summary: null,
      policy: null,
      message: null,
      code: null,
      audit: null,
      writeMode: null,
      ledger: null,
      dispatch: null,
      truncated: false,
      projectionSeq: null,
    }
  }
  const summaryRaw = isRecord(value.summary) ? value.summary : {}
  const policyRaw = isRecord(value.policy) ? value.policy : {}
  const scopeRaw = isRecord(value.requestedScope) ? value.requestedScope : {}
  return {
    available: value.available !== false,
    reason: text(value.reason),
    command: text(value.command) ?? 'stop',
    accepted: value.accepted === true,
    executed: value.executed === true,
    noop: value.noop === true,
    deterministic: value.deterministic === true,
    requiresModel: value.requiresModel === true,
    requestedScope: isRecord(value.requestedScope)
      ? { raw: text(scopeRaw.raw) ?? '', kind: text(scopeRaw.kind) ?? 'unknown', id: text(scopeRaw.id) }
      : null,
    matched: num(value.matched) ?? 0,
    stopped: recordList(value.stopped)
      .map((entry) => normalizeStopItem(entry))
      .filter((entry): entry is StopItemFacts => entry !== null),
    refused: recordList(value.refused)
      .map((entry) => normalizeStopRefusal(entry))
      .filter((entry): entry is StopRefusalItemFacts => entry !== null),
    unknown: recordList(value.unknown)
      .map((entry) => normalizeStopRefusal(entry))
      .filter((entry): entry is StopUnknownItemFacts => entry !== null),
    summary: isRecord(value.summary)
      ? {
          matched: num(summaryRaw.matched) ?? 0,
          stopped: num(summaryRaw.stopped) ?? 0,
          refused: num(summaryRaw.refused) ?? 0,
          unknown: num(summaryRaw.unknown) ?? 0,
        }
      : null,
    policy: isRecord(value.policy)
      ? {
          ownsOnly: text(policyRaw.ownsOnly) ?? 'unknown',
          userTurnsStopped: policyRaw.userTurnsStopped === true,
          foreignTurns: text(policyRaw.foreignTurns) ?? 'unknown',
          externalSideEffectsUndone: policyRaw.externalSideEffectsUndone === true,
          deterministic: policyRaw.deterministic === true,
          requiresModel: policyRaw.requiresModel === true,
        }
      : null,
    message: text(value.message),
    code: text(value.code),
    audit: normalizeAudit(value.audit),
    writeMode: normalizeWriteMode(value.writeMode),
    ledger: normalizeLedger(value.ledger),
    dispatch: normalizeDispatch(value.dispatch),
    truncated: value.truncated === true,
    projectionSeq: num(value.projectionSeq),
  }
}

export function normalizeRelease(value: unknown): ReleaseFacts {
  if (!isRecord(value)) {
    return {
      available: false,
      reason: '宿主没有返回释放回执',
      command: 'release',
      accepted: false,
      requestedMessageIds: [],
      released: [],
      ignored: [],
      requiresExplicitSelection: true,
      bulkDefault: false,
      code: null,
      message: null,
      audit: null,
      writeMode: null,
      ledger: null,
      projectionSeq: null,
    }
  }
  const released: ReleaseItemFacts[] = []
  for (const entry of recordList(value.released)) {
    const messageId = text(entry.messageId) ?? text(entry.id)
    if (!messageId) continue
    released.push({
      messageId,
      actionId: text(entry.actionId),
      sessionId: text(entry.sessionId),
      state: text(entry.state) ?? 'released',
      reason: text(entry.reason),
      releasable: entry.releasable === true,
    })
  }
  const ignored: IgnoredReleaseFacts[] = []
  for (const entry of recordList(value.ignored)) {
    const messageId = text(entry.messageId) ?? text(entry.id)
    if (!messageId) continue
    ignored.push({ messageId, reason: text(entry.reason) ?? 'unknown-message-id' })
  }
  return {
    available: value.available !== false,
    reason: text(value.reason),
    command: text(value.command) ?? 'release',
    accepted: value.accepted === true,
    requestedMessageIds: Array.isArray(value.requestedMessageIds)
      ? value.requestedMessageIds.filter((entry): entry is string => typeof entry === 'string')
      : [],
    released,
    ignored,
    requiresExplicitSelection: value.requiresExplicitSelection !== false,
    bulkDefault: value.bulkDefault === true,
    code: text(value.code),
    message: text(value.message),
    audit: normalizeAudit(value.audit),
    writeMode: normalizeWriteMode(value.writeMode),
    ledger: normalizeLedger(value.ledger),
    projectionSeq: num(value.projectionSeq),
  }
}

/* ── fetches ──────────────────────────────────────────────────────────── */

export interface ControlFetchResult<T> {
  ok: boolean
  facts: T | null
  /** Transport/plane fault message when the call itself failed. */
  error: string | null
  /** The Host reported `available:false`; `reason` carries why (FE-11). */
  unavailable: boolean
  reason: string | null
}

async function readFact<T>(
  call: ControlCall,
  endpoint: string,
  normalize: (value: unknown) => T & { available: boolean; reason: string | null },
): Promise<ControlFetchResult<T>> {
  let result: Awaited<ReturnType<ControlCall>>
  try {
    result = await call(endpoint, controlArgs({}))
  } catch (error) {
    return {
      ok: false,
      facts: null,
      error: error instanceof Error ? error.message : String(error),
      unavailable: false,
      reason: null,
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      facts: null,
      error: result.error?.message ?? '控制面读取失败',
      unavailable: false,
      reason: null,
    }
  }
  const facts = normalize(result.value)
  return { ok: true, facts, error: null, unavailable: !facts.available, reason: facts.reason }
}

export function fetchControlState(call: ControlCall): Promise<ControlFetchResult<ControlStateFacts>> {
  return readFact(call, CONTROL_ENDPOINTS.state, normalizeControlState)
}

export function fetchApprovals(call: ControlCall): Promise<ControlFetchResult<ApprovalListFacts>> {
  return readFact(call, CONTROL_ENDPOINTS.approvals, normalizeApprovalList)
}

export function fetchRecovery(call: ControlCall): Promise<ControlFetchResult<RecoveryFacts>> {
  return readFact(call, CONTROL_ENDPOINTS.recovery, normalizeRecovery)
}

/* ── semantic commands (request builders + refusal handling) ─────────── */

export interface ApprovalDecisionRequest {
  approvalId: string
  decision: 'approve' | 'reject'
  /** All four binding values the human saw; the Host validates each (03§10). */
  expected: {
    payloadHash: string
    taskVersion: number
    policyEpoch: number
    nonce: string
  }
}

export function buildDecisionRequest(
  approval: ApprovalFacts,
  decision: 'approve' | 'reject',
): ApprovalDecisionRequest {
  return {
    approvalId: approval.approvalId,
    decision,
    expected: {
      payloadHash: approval.payloadHash,
      taskVersion: approval.taskVersion,
      policyEpoch: approval.policyEpoch,
      nonce: approval.nonce,
    },
  }
}

export type ControlCommandOutcome<T> =
  | { status: 'confirmed'; facts: T; reason: string; code: string | null }
  | { status: 'idempotent'; facts: T; reason: string; code: string | null }
  | { status: 'rejected'; facts: T | null; reason: string; code: string | null }
  | { status: 'error'; facts: null; reason: string; code: string | null }

async function submit<T>(
  call: ControlCall,
  endpoint: string,
  request: Record<string, unknown>,
  normalize: (value: unknown) => T & { available: boolean; reason?: string | null },
  classify: (facts: T & { available: boolean; reason?: string | null }) =>
    | { status: 'confirmed' | 'idempotent' | 'rejected'; reason: string; code: string | null },
): Promise<ControlCommandOutcome<T>> {
  let result: Awaited<ReturnType<ControlCall>>
  try {
    result = await call(endpoint, controlArgs(request))
  } catch (error) {
    return { status: 'error', facts: null, reason: error instanceof Error ? error.message : String(error), code: null }
  }
  if (!result.ok) {
    return {
      status: 'error',
      facts: null,
      reason: result.error?.message ?? '控制命令失败（宿主未返回原因）',
      code: result.error?.code ?? null,
    }
  }
  const facts = normalize(result.value)
  if (!facts.available) {
    return { status: 'rejected', facts, reason: facts.reason ?? '宿主报告该控制命令不可用', code: 'CAPABILITY_UNAVAILABLE' }
  }
  const classified = classify(facts)
  return { ...classified, facts }
}

/**
 * Decide one approval. The command is recorded-only: a `confirmed` outcome
 * requires the server's `accepted:true` with outcome `allowed`/`rejected`; an
 * idempotent `already-handled` reply is a separate neutral outcome (no second
 * release); stale/not-found/invalid are refusals with their exact code.
 */
export function submitDecision(
  call: ControlCall,
  request: ApprovalDecisionRequest,
): Promise<ControlCommandOutcome<DecisionFacts>> {
  return submit(
    call,
    CONTROL_ENDPOINTS.decideApproval,
    request as unknown as Record<string, unknown>,
    normalizeDecision,
    (facts) => {
      const code = facts.code ?? null
      if (facts.outcome === 'already-handled' || (facts.idempotent && !facts.accepted)) {
        return {
          status: 'idempotent',
          reason: `已在别处处理${facts.existingStatus ? `（${facts.existingStatus}）` : ''}；幂等回执，没有二次放行。`,
          code: code ?? 'APPROVAL_ALREADY_HANDLED',
        }
      }
      if (facts.accepted === true && (facts.outcome === 'allowed' || facts.outcome === 'rejected')) {
        return { status: 'confirmed', reason: '', code: null }
      }
      return {
        status: 'rejected',
        reason: facts.message ?? facts.reason ?? `服务端拒绝该决定（${facts.outcome}）`,
        code: code ?? 'APPROVAL_REFUSED',
      }
    },
  )
}

export type StopScopeKind = 'all' | 'task' | 'action' | 'session'

/** Build the frozen stop scope token: `all` / `task:{id}` / `action:{id}` / `session:{id}`. */
export function buildStopScope(kind: StopScopeKind, id?: string | null): string {
  if (kind === 'all') return 'all'
  if (!id || id.trim().length === 0) {
    throw new Error(`stop scope ${kind} requires an exact id`)
  }
  return `${kind}:${id.trim()}`
}

export interface StopRequest {
  scope: string
}

export function buildStopRequest(kind: StopScopeKind, id?: string | null): StopRequest {
  return { scope: buildStopScope(kind, id) }
}

export function submitStop(call: ControlCall, request: StopRequest): Promise<ControlCommandOutcome<StopFacts>> {
  return submit(call, CONTROL_ENDPOINTS.stop, { ...request }, normalizeStop, (facts) => {
    if (facts.accepted === true) {
      return { status: 'confirmed', reason: facts.message ?? '', code: null }
    }
    return {
      status: 'rejected',
      reason: facts.message ?? facts.reason ?? '服务端未确认停止请求',
      code: facts.code ?? 'CAPABILITY_UNAVAILABLE',
    }
  })
}

export interface ReleaseRequest {
  messageIds: string[]
}

export function buildReleaseRequest(messageIds: readonly string[]): ReleaseRequest {
  // Trim, de-duplicate and keep the human's exact selection; never widen it.
  return {
    messageIds: [
      ...new Set(messageIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ],
  }
}

export function submitRelease(call: ControlCall, request: ReleaseRequest): Promise<ControlCommandOutcome<ReleaseFacts>> {
  return submit(call, CONTROL_ENDPOINTS.release, { ...request }, normalizeRelease, (facts) => {
    if (facts.accepted === true) {
      return { status: 'confirmed', reason: facts.message ?? '', code: null }
    }
    return {
      status: 'rejected',
      reason: facts.message ?? facts.reason ?? '服务端未确认释放请求',
      code: facts.code ?? 'CAPABILITY_UNAVAILABLE',
    }
  })
}

/* ── stale response protection (AT-19/FE-04, same rule as the taskboard) ── */

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

/** True when `incoming` is older than the last accepted Host projection. */
export function isStaleProjection(incoming: number | null, lastAccepted: number | null): boolean {
  if (incoming === null || lastAccepted === null) return false
  return incoming < lastAccepted
}

/* ── honest display strings (never claim execution) ───────────────────── */

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: '待决定',
  allowed: '已批准（仅记录）',
  rejected: '已拒绝（仅记录）',
  expired: '已过期',
  stale: '绑定已失效',
  cancelled: '已取消',
}

const INVALID_REASON_LABELS: Record<string, string> = {
  expired: '已过期',
  'task-version-moved': '任务版本已移动',
  'policy-epoch-moved': '政策纪元已移动',
}

const STALE_CAUSE_LABELS: Record<string, string> = {
  expired: '审批已过期',
  'task-version-moved': '任务版本已移动',
  'policy-epoch-moved': '政策纪元已移动',
  'payload-changed': '参数摘要已变化',
  'caller-binding-mismatch': '调用方绑定不匹配',
  'nonce-mismatch': 'nonce 不匹配',
}

export function approvalStatusLabel(status: ApprovalStatus): string {
  return APPROVAL_STATUS_LABELS[status] ?? `状态：${status}`
}

export function approvalInvalidReasonLabel(reason: ApprovalInvalidReason): string | null {
  if (reason === null) return null
  return INVALID_REASON_LABELS[reason] ?? reason
}

export function staleCauseLabel(cause: string | null): string | null {
  if (cause === null) return null
  return STALE_CAUSE_LABELS[cause] ?? cause
}

/** One honest line answering "why can/can't I click this approval". */
export function approvalStateLine(approval: ApprovalFacts): string {
  if (approval.status !== 'pending') {
    return approval.decision
      ? `${approvalStatusLabel(approval.status)}；已在别处处理，不会二次放行`
      : `${approvalStatusLabel(approval.status)}；不可再次决定`
  }
  if (approval.invalidReason !== null) {
    return `已失效：${approvalInvalidReasonLabel(approval.invalidReason)}；不会据此执行任何动作`
  }
  if (!approval.valid) return '绑定已失效；需要重新核查后申请'
  if (!approval.canDecide) return '等待你决定，但账本当前不可写；按钮禁用，服务端也会拒绝'
  return '等待你决定（服务端会再次校验 payloadHash / taskVersion / policyEpoch / nonce）'
}

/** The permanent strip that must accompany every stop result (issue E04-03). */
export const STOP_RESULT_WARNING =
  '请求已发送 ≠ 外部副作用已撤销：只有 BOOP 尚未投递的待发动作会被确定性取消；已投递的动作 BOOP 不宣称撤销，未知项不会自动重试。'

/** The decision receipt strip: approval is a ledger decision, not execution. */
export const DECISION_RESULT_WARNING =
  '本次只记录审批结论与审计；没有派发 action、没有执行任何外部副作用。'

/** The recovery warning: no bulk release, explicit selection only. */
export const RECOVERY_WARNING =
  '恢复必须逐项显式勾选释放；未勾选的旧 BOOP 命令保持阻断，不会自动执行。释放只改变门禁账本。'

export function approvalBindingSummary(approval: ApprovalFacts): string {
  return [
    `approval ${approval.approvalId}`,
    `action ${approval.actionId || '未知'}`,
    `task ${approval.taskId ?? '未知'}`,
    `taskVersion ${approval.taskVersion}`,
    `policyEpoch ${approval.policyEpoch}`,
    `payloadHash ${approval.payloadHash ? `${approval.payloadHash.slice(0, 12)}…` : '未知'}`,
    `nonce ${approval.nonce ? `${approval.nonce.slice(0, 8)}…` : '未知'}`,
    `owner ${approval.requestingOwner}`,
  ].join(' · ')
}

/* ── stop item display (three Host buckets keep distinct meaning) ─────── */

export function stoppedItemLine(item: StopItemFacts): string {
  const target = item.actionId
  const invalidated = item.invalidatedApprovalIds.length > 0
    ? `；失效审批：${item.invalidatedApprovalIds.join('、')}`
    : ''
  return `${target}：已停止（${item.previousActionState ?? '未知'} → ${item.actionState}；outbox ${
    item.previousOutboxState ?? '未知'
  } → ${item.outboxState ?? '未知'}）${invalidated}`
}

export function refusedItemLine(item: StopRefusalItemFacts): string {
  return `${item.actionId}：未停止（${item.bucket}｜${item.code}）${item.reason ? ` — ${item.reason}` : ''}${
    item.note ? `（${item.note}）` : ''
  }`
}

export function unknownItemLine(item: StopUnknownItemFacts): string {
  return `${item.actionId}：结果待确认（${item.code}）${item.reason ? ` — ${item.reason}` : ''}${
    item.note ? `（${item.note}）` : ''
  }；不会自动重试，也不会显示为已停止`
}

export function actionStateIsUnknown(state: string): boolean {
  return state === 'outcome_unknown' || state === 'unknown'
}
