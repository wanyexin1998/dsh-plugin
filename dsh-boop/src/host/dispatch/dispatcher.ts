/**
 * Reliable dispatch and reconciliation (E02-03, G03 closure).
 *
 * Frozen rules (02§09, 03§09):
 *  - BOOP commands the user's ORIGINAL Sessions; it never creates parallel work;
 *  - every command passes through the outbox and is reconciled by messageId;
 *  - an UNKNOWN outcome is never retried automatically;
 *  - a task version or policy epoch change invalidates every unexecuted action;
 *  - a dangerous tool call still goes through the native approval channel;
 *  - stop is BOOP-owned work only.
 *
 * G03 idempotency contract implemented here:
 *  - ONE action id == ONE message id. A retry of the same action NEVER mints a
 *    new id; an already-delivered action answers `duplicate` and the transport is
 *    not called again.
 *  - An `outcome_unknown` action is first reconciled against the DURABLE Session
 *    log (`user/message`, `agent/inbox/spliced`, the rebuilt inbox projection).
 *    Positive evidence lands `accepted`; positive evidence of absence after a
 *    CLEAN restart lands `not-delivered`; anything else stays `outcome_unknown`
 *    and is reported, never upgraded and never auto-retried.
 *  - Repeated reconciliation is idempotent: a second run observes the same
 *    ledger state, changes nothing and writes no second audit row.
 *
 * The dispatcher is transport-agnostic: it talks to the repository and to a
 * DshAdapter, so it is fully testable without a model or a GUI.
 */

import type { ActionState } from '../../shared/types.ts'
import type { ActionRow, BoopRepository, LedgerConflict } from '../persistence/repository.ts'
import type { DurableTrace } from '../transport/dsh-adapter.ts'
import { payloadHash, type CommandEnvelope } from '../transport/command-envelope.ts'

/* ── reconciliation fact shapes (G03 / AT-13) ────────────────────────── */

export type ReconcileVerdictKind = 'accepted' | 'not-delivered' | 'indeterminate'

export type ReconcileEvidenceKind =
  | 'ledger-accepted'
  | 'durable-claimed'
  | 'durable-inbox-splice'
  | 'inbox-pending'
  | 'no-trace'
  | 'not-observable'

export interface ReconcileEvidenceFacts {
  kind: ReconcileEvidenceKind
  /** Durable seq that proves the fact, or null when the fact is a ledger one. */
  seq: number | null
  messageId: string | null
  sourceKind: string | null
  headSeq: number | null
  headTimeMs?: number | null
  /** Lower bound used to select durable candidates (from the action createdAt). */
  sinceMs?: number | null
  /** Durable events that could have carried a delivery record. */
  candidates?: number
  truncated: boolean
  detail: string | null
}

export interface ReconcileVerdict {
  actionId: string
  verdict: ReconcileVerdictKind
  reason: string
  messageId: string | null
  from: { actionState: string; outboxState: string | null }
  to: { actionState: string; outboxState: string | null }
  /** false = reconciliation observed the same conclusion again (idempotent). */
  changed: boolean
  evidence: ReconcileEvidenceFacts
}

export interface ReconcileReport {
  scopeId: string
  actionIds: string[]
  results: ReconcileVerdict[]
  accepted: number
  notDelivered: number
  indeterminate: number
  /** true = a second reconciliation of the same inputs would change nothing. */
  idempotent: boolean
}

export interface DispatcherOptions {
  repo: BoopRepository
  scopeId: string
  enqueue: (input: { envelope: CommandEnvelope; targetSessionId: string }) => Promise<{
    messageId: string
    accepted: boolean
    mode: 'queue' | 'steer'
    duplicate?: boolean
  }>
  /** Message ids this process minted; provenance evidence for reconciliation. */
  knownMessageIds: () => ReadonlySet<string>
  /** Recovery gate decision for a set of claimed messages. */
  gateDecision?: (claimed: unknown[]) => { allow: boolean; reason?: string }
  /** Returns the pending proxy commands visible in a Session's durable inbox. */
  pendingFor?: (sessionId: string) => Array<{ id: string; actionId: string }>
  /**
   * DURABLE reconciliation evidence reader (G03). Required for evidence-based
   * unknown-result reconciliation; without it an unknown action is never retried
   * blindly and never upgraded.
   */
  evidence?: (sessionId: string, options: { sinceMs: number | null; clean: boolean }) => Promise<DurableTrace>
  /** Ledger outbox state reader (`command_outbox.state`); used for idempotency. */
  outboxState?: (actionId: string) => string | null
  /**
   * The action row's immutable `created_at`. Reconciliation starts its durable
   * candidate window here — NOT at `updated_at`, which is rewritten when a
   * crashed row is marked unknown (that would hide the delivery record).
   */
  actionCreatedAt?: (actionId: string) => string | null
  /**
   * Flush the target Session's durable log before reconciliation reads it.
   * Without it a just-delivered message may still be in the live store, and a
   * reconciliation snapshot can be stale (optimization only; never a source of
   * success/failure by itself).
   */
  flush?: (sessionId: string) => Promise<void>
  now?: () => string
}

export type DispatchOutcome =
  | { kind: 'accepted'; actionId: string; messageId: string }
  | { kind: 'rejected'; actionId: string; reason: string }
  | { kind: 'gated'; actionId: string; reason: string }
  | { kind: 'unknown'; actionId: string; reason: string; reconcile?: ReconcileVerdict }
  | {
      kind: 'duplicate'
      actionId: string
      messageId: string
      /** The ledger state the duplicate was recognised from. */
      state: ActionState
      reason: 'ALREADY_ACCEPTED' | 'RECONCILED_DELIVERED'
      /** Present when reconciliation, not the live ledger state, proved delivery. */
      reconcile?: ReconcileVerdict
    }

const TERMINAL_ACTION_STATES: ReadonlyArray<ActionState> = ['rejected', 'stopped']
const DELIVERED_ACTION_STATES: ReadonlyArray<ActionState> = ['accepted', 'running', 'settled']

export class Dispatcher {
  private readonly repo: BoopRepository
  private readonly scopeId: string
  private readonly options: DispatcherOptions

  constructor(options: DispatcherOptions) {
    this.options = options
    this.repo = options.repo
    this.scopeId = options.scopeId
  }

  /**
   * Create the action row and compute the payload hash an approval must bind
   * to (03§10: an approval always names one exact object version).
   *
   * Nothing is delivered here; the action only exists in the ledger.
   */
  plan(input: {
    taskId: string
    expectedTaskVersion: number
    targetSessionId: string
    instruction: string
    mode: 'queue' | 'steer'
    originRef: string
    policyEpoch: number
    /** Set when the action needs an explicit approval before delivery. */
    requiresApproval?: boolean
  }): { actionId: string; payloadHash: string; taskVersion: number; error?: string } {
    const scope = this.repo.getScope(this.scopeId)
    if (!scope) return { actionId: '', payloadHash: '', taskVersion: 0, error: 'SCOPE_UNKNOWN' }
    if (scope.policyEpoch !== input.policyEpoch) {
      return { actionId: '', payloadHash: '', taskVersion: 0, error: 'POLICY_EPOCH_CHANGED' }
    }
    const hash = payloadHash({
      taskId: input.taskId,
      taskVersion: input.expectedTaskVersion,
      targetSessionId: input.targetSessionId,
      instruction: input.instruction,
      mode: input.mode,
    })
    try {
      const action = this.repo.beginAction({
        scopeId: this.scopeId,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        targetSessionId: input.targetSessionId,
        payloadHash: hash,
        payload: { instruction: input.instruction, mode: input.mode },
        originRef: input.originRef,
        policyEpoch: input.policyEpoch,
      })
      if (input.requiresApproval) this.repo.markActionState(this.scopeId, action.id, 'awaiting_approval')
      return { actionId: action.id, payloadHash: hash, taskVersion: input.expectedTaskVersion }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'TASK_VERSION_CONFLICT') {
        return { actionId: '', payloadHash: '', taskVersion: 0, error: 'TASK_VERSION_CONFLICT' }
      }
      throw error
    }
  }

  /**
   * Deliver one planned action.
   *
   * Every precondition is checked BEFORE the message exists in any inbox, so a
   * refused command leaves no trace in the user Sessions. When plan() has
   * already created the action, actionId names it; otherwise it is created here.
   *
   * AT-13: repeating this call with the SAME actionId never mints a new id and
   * never sends twice — it answers `duplicate` for delivered work, and requires
   * evidence-based reconciliation before an `outcome_unknown` action may be
   * explicitly retried.
   */
  async dispatch(input: {
    taskId: string
    expectedTaskVersion: number
    targetSessionId: string
    instruction: string
    mode: 'queue' | 'steer'
    originRef: string
    policyEpoch: number
    /** Set when the action requires an explicit approval first. */
    requiresApproval?: boolean
    approvalId?: string
    /** The nonce carried by the approval card the user actually saw. */
    approvalNonce?: string
    /** Existing planned action id from plan(). */
    actionId?: string
    /**
     * Operator attestation that the previous Host stopped gracefully. Required
     * before absence of durable evidence may be read as `not-delivered`.
     */
    cleanRestart?: boolean
  }): Promise<DispatchOutcome> {
    const writeFence = this.repo.getScope(this.scopeId)
    if (!writeFence) return { kind: 'rejected', actionId: '', reason: 'SCOPE_UNKNOWN' }
    if (writeFence.policyEpoch !== input.policyEpoch) {
      // The approval or plan predates a policy change: refuse, never adapt.
      return { kind: 'rejected', actionId: '', reason: 'POLICY_EPOCH_CHANGED' }
    }

    const hash = payloadHash({
      taskId: input.taskId,
      taskVersion: input.expectedTaskVersion,
      targetSessionId: input.targetSessionId,
      instruction: input.instruction,
      mode: input.mode,
    })

    let action: ActionRow | null = input.actionId ? this.repo.getAction(this.scopeId, input.actionId) : null
    if (action && action.payloadHash !== hash) {
      // The approval card and the current payload disagree: refuse.
      this.repo.markActionState(this.scopeId, action.id, 'rejected')
      return { kind: 'rejected', actionId: action.id, reason: 'PAYLOAD_CHANGED' }
    }

    if (action) {
      const outbox = this.outboxStateOf(action)
      if (TERMINAL_ACTION_STATES.includes(action.state) || outbox === 'cancelled') {
        return { kind: 'rejected', actionId: action.id, reason: 'ACTION_TERMINAL' }
      }
      if (DELIVERED_ACTION_STATES.includes(action.state) || outbox === 'accepted') {
        // Idempotent retry of delivered work: same id, no second delivery.
        return {
          kind: 'duplicate',
          actionId: action.id,
          messageId: action.messageId ?? action.id,
          state: action.state,
          reason: 'ALREADY_ACCEPTED',
        }
      }
      if (outbox === 'sending') {
        // A live send lease exists: do not race it, and do not claim it is lost.
        return { kind: 'unknown', actionId: action.id, reason: 'DELIVERY_IN_FLIGHT' }
      }
      if (action.state === 'outcome_unknown' || outbox === 'unknown') {
        if (this.options.evidence === undefined) {
          // No durable evidence source: the old unknown stays unknown (never a
          // blind re-send). This preserves the E02-03 unit contract.
          return { kind: 'rejected', actionId: action.id, reason: 'ACTION_OUTCOME_UNKNOWN' }
        }
        const verdict = await this.reconcileAction(action, { cleanRestart: input.cleanRestart === true })
        if (verdict.verdict === 'accepted') {
          return {
            kind: 'duplicate',
            actionId: action.id,
            messageId: action.messageId ?? verdict.messageId ?? action.id,
            state: 'accepted',
            reason: 'RECONCILED_DELIVERED',
            reconcile: verdict,
          }
        }
        if (verdict.verdict === 'indeterminate') {
          return { kind: 'unknown', actionId: action.id, reason: `UNRECONCILED: ${verdict.reason}`, reconcile: verdict }
        }
        // `not-delivered` proven: an EXPLICIT retry may proceed with the SAME id.
      }
    }

    if (input.requiresApproval && (!input.approvalId || !input.approvalNonce)) {
      return { kind: 'rejected', actionId: input.actionId ?? '', reason: 'APPROVAL_REQUIRED' }
    }

    if (!action) {
      try {
        action = this.repo.beginAction({
          scopeId: this.scopeId,
          taskId: input.taskId,
          expectedTaskVersion: input.expectedTaskVersion,
          targetSessionId: input.targetSessionId,
          payloadHash: hash,
          payload: { instruction: input.instruction, mode: input.mode },
          originRef: input.originRef,
          policyEpoch: input.policyEpoch,
        })
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'TASK_VERSION_CONFLICT') {
          return { kind: 'rejected', actionId: '', reason: 'TASK_VERSION_CONFLICT' }
        }
        throw error
      }
    }

    if (input.requiresApproval && input.approvalId) {
      const approval = this.repo.consumeApproval({
        scopeId: this.scopeId,
        approvalId: input.approvalId,
        nonceHash: input.approvalNonce ?? '',
        payloadHash: hash,
        taskVersion: input.expectedTaskVersion,
        policyEpoch: input.policyEpoch,
      })
      if (approval.status !== 'allowed') {
        this.repo.markActionState(this.scopeId, action.id, 'rejected')
        this.repo.settleOutbox(this.scopeId, action.id, 'cancelled')
        return { kind: 'rejected', actionId: action.id, reason: `APPROVAL_${approval.status.toUpperCase()}` }
      }
    }

    const envelope: CommandEnvelope = {
      scopeId: this.scopeId,
      taskId: input.taskId,
      taskVersion: input.expectedTaskVersion,
      actionId: action.id,
      // G03: the message id IS the action id, stable across retries. A retry can
      // never mint a second message id.
      messageId: action.id,
      policyEpoch: input.policyEpoch,
      payloadHash: hash,
      initiatorRef: input.originRef,
      instruction: input.instruction,
      mode: input.mode,
    }

    const claimed = this.repo.claimOutbox(this.scopeId, 30_000).find((row) => row.actionId === action.id)
    if (!claimed) {
      return { kind: 'rejected', actionId: action.id, reason: 'OUTBOX_NOT_CLAIMED' }
    }

    try {
      const result = await this.options.enqueue({ envelope, targetSessionId: input.targetSessionId })
      if (!result.accepted) {
        this.repo.settleOutbox(this.scopeId, action.id, 'blocked')
        this.repo.markActionState(this.scopeId, action.id, 'planned')
        return { kind: 'rejected', actionId: action.id, reason: 'TARGET_BUSY' }
      }
      if (result.duplicate === true) {
        // The transport recognised the exact message id already pending in the
        // durable inbox: this is the same delivery, not a new one.
        this.repo.settleOutbox(this.scopeId, action.id, 'accepted', {
          messageId: result.messageId,
          duplicateSuppressed: true,
        })
        this.repo.markActionState(this.scopeId, action.id, 'accepted', result.messageId)
        return { kind: 'duplicate', actionId: action.id, messageId: result.messageId, state: 'accepted', reason: 'ALREADY_ACCEPTED' }
      }
      // Make the delivery durable BEFORE the ledger records it accepted, so a
      // crash between the two leaves durable evidence for reconciliation.
      try {
        await this.options.flush?.(input.targetSessionId)
      } catch {
        /* a failed flush never invents an outcome; reconciliation re-reads later */
      }
      this.repo.settleOutbox(this.scopeId, action.id, 'accepted', { messageId: result.messageId })
      this.repo.markActionState(this.scopeId, action.id, 'accepted', result.messageId)
      return { kind: 'accepted', actionId: action.id, messageId: result.messageId }
    } catch (error) {
      // The transport threw AFTER the row was claimed: the outcome is unknown,
      // and an unknown command is never retried automatically (02§09).
      this.repo.settleOutbox(this.scopeId, action.id, 'unknown')
      this.repo.markActionState(this.scopeId, action.id, 'outcome_unknown')
      return { kind: 'unknown', actionId: action.id, reason: String(error) }
    }
  }

  /* ── durable reconciliation (G03 / AT-13) ──────────────────────────── */

  /**
   * Reconcile the given actions against the DURABLE Session log.
   *
   * Read-mostly and idempotent: a result is written only when evidence changes
   * the conclusion, and a repeated run returns `changed: false` without a second
   * audit row. Never dispatches, never retries, never upgrades unknown → success
   * without positive durable evidence.
   */
  async reconcileUnknown(input: { actionIds: string[]; cleanRestart?: boolean }): Promise<ReconcileReport> {
    const unique = [...new Set(input.actionIds.filter((id) => typeof id === 'string' && id !== ''))]
    const results: ReconcileVerdict[] = []
    for (const actionId of unique) {
      const action = this.repo.getAction(this.scopeId, actionId)
      if (!action) {
        results.push({
          actionId,
          verdict: 'indeterminate',
          reason: 'action-not-found',
          messageId: null,
          from: { actionState: 'missing', outboxState: null },
          to: { actionState: 'missing', outboxState: null },
          changed: false,
          evidence: notObservableEvidence('action-not-found'),
        })
        continue
      }
      results.push(await this.reconcileAction(action, { cleanRestart: input.cleanRestart === true }))
    }
    return {
      scopeId: this.scopeId,
      actionIds: unique,
      results,
      accepted: results.filter((result) => result.verdict === 'accepted').length,
      notDelivered: results.filter((result) => result.verdict === 'not-delivered').length,
      indeterminate: results.filter((result) => result.verdict === 'indeterminate').length,
      idempotent: results.every((result) => result.changed === false),
    }
  }

  /**
   * Reconcile one action. Positive durable evidence always wins; absence is only
   * accepted as `not-delivered` when the caller attests a CLEAN restart (an
   * unclean kill can lose an unflushed durable tail — E07-01 evidence).
   */
  private async reconcileAction(
    action: ActionRow,
    options: { cleanRestart: boolean },
  ): Promise<ReconcileVerdict> {
    const outbox = this.outboxStateOf(action)
    const from = { actionState: String(action.state), outboxState: outbox }
    if (DELIVERED_ACTION_STATES.includes(action.state) || outbox === 'accepted') {
      return {
        actionId: action.id,
        verdict: 'accepted',
        reason: 'ledger-already-accepted',
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: {
          kind: 'ledger-accepted',
          seq: null,
          messageId: action.messageId ?? null,
          sourceKind: null,
          headSeq: null,
          truncated: false,
          detail: null,
        },
      }
    }
    if (TERMINAL_ACTION_STATES.includes(action.state) || outbox === 'cancelled') {
      return {
        actionId: action.id,
        verdict: 'indeterminate',
        reason: 'action-terminal',
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: notObservableEvidence('action-terminal'),
      }
    }
    if (this.options.evidence === undefined) {
      return {
        actionId: action.id,
        verdict: 'indeterminate',
        reason: 'evidence-source-unavailable',
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: notObservableEvidence('no evidence source is composed'),
      }
    }

    let createdMs = Number.NaN
    try {
      const createdAt = this.options.actionCreatedAt?.(action.id) ?? null
      if (typeof createdAt === 'string' && createdAt !== '') createdMs = Date.parse(createdAt)
    } catch {
      createdMs = Number.NaN
    }
    if (!Number.isFinite(createdMs)) {
      // No createdAt reader: fall back to updatedAt (best effort), or scan the
      // whole durable log when even that is unreadable.
      const fallback = Date.parse(action.updatedAt || action.id)
      createdMs = Number.isFinite(fallback) ? fallback : Number.NaN
    }
    const sinceMs = Number.isFinite(createdMs) ? createdMs - 5_000 : null
    try {
      // Read the CURRENT durable log, not a stale live-store snapshot.
      await this.options.flush?.(action.targetSessionId)
    } catch {
      /* a failed flush degrades the evidence read, never fabricates a fact */
    }
    let trace: DurableTrace
    try {
      trace = await this.options.evidence(action.targetSessionId, { sinceMs, clean: options.cleanRestart })
    } catch (error) {
      return {
        actionId: action.id,
        verdict: 'indeterminate',
        reason: 'evidence-read-failed',
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: notObservableEvidence(error instanceof Error ? error.message : String(error)),
      }
    }
    if (trace.sessionId !== action.targetSessionId) {
      return {
        actionId: action.id,
        verdict: 'indeterminate',
        reason: 'evidence-session-mismatch',
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: notObservableEvidence('the trace does not belong to the target Session'),
      }
    }

    const ids = new Set([action.id, action.messageId].filter((id): id is string => typeof id === 'string' && id !== ''))
    const claimed = trace.userMessages.find((message) => ids.has(message.messageId))
    const spliced = trace.splices.find((splice) => splice.insertedIds.some((id) => ids.has(id)))
    const pending = trace.pendingInboxIds.find((id) => ids.has(id))

    const now = this.options.now ?? (() => new Date().toISOString())

    if (claimed !== undefined || spliced !== undefined || pending !== undefined) {
      const windowFacts = {
        headTimeMs: trace.headTimeMs,
        sinceMs: trace.sinceMs,
        candidates: trace.candidateEvents,
      }
      const evidence: ReconcileEvidenceFacts =
        claimed !== undefined
          ? {
              kind: 'durable-claimed',
              seq: claimed.seq,
              messageId: claimed.messageId,
              sourceKind: claimed.sourceKind,
              headSeq: trace.headSeq,
              truncated: trace.truncated,
              detail: 'durable user/message with the exact message id',
              ...windowFacts,
            }
          : spliced !== undefined
            ? {
                kind: 'durable-inbox-splice',
                seq: spliced.seq,
                messageId: spliced.insertedIds.find((id) => ids.has(id)) ?? action.id,
                sourceKind: null,
                headSeq: trace.headSeq,
                truncated: trace.truncated,
                detail: `durable inbox splice (${spliced.target}) inserted the exact message id`,
                ...windowFacts,
              }
            : {
                kind: 'inbox-pending',
                seq: null,
                messageId: pending as string,
                sourceKind: null,
                headSeq: trace.headSeq,
                truncated: trace.truncated,
                detail: 'the rebuilt inbox projection still holds the exact message id',
                ...windowFacts,
              }
      const messageId = evidence.messageId ?? action.id
      const changed = !(action.state === 'accepted' && outbox === 'accepted' && action.messageId === messageId)
      if (changed) {
        this.repo.markActionState(this.scopeId, action.id, 'accepted', messageId)
        this.repo.settleOutbox(this.scopeId, action.id, 'accepted', {
          reconciled: true,
          evidence: { kind: evidence.kind, seq: evidence.seq, messageId, at: now() },
        })
        this.audit(
          'dispatch/reconciled-delivered',
          action.id,
          `DURABLE_EVIDENCE ${evidence.kind} seq=${String(evidence.seq)} messageId=${messageId}; state outcome_unknown -> accepted`,
        )
      }
      return {
        actionId: action.id,
        verdict: 'accepted',
        reason: 'durable-evidence',
        messageId,
        from,
        to: { actionState: 'accepted', outboxState: 'accepted' },
        changed,
        evidence,
      }
    }

    /* No delivery record. Absence is usable only for a CLEAN, complete, observable read. */
    const reasons: string[] = []
    if (!trace.available) reasons.push(`trace-unavailable:${trace.reason ?? 'unknown'}`)
    if (!trace.sessionExists) reasons.push('session-missing')
    if (trace.truncated) reasons.push('evidence-truncated')
    if (!options.cleanRestart) reasons.push('clean-restart-not-attested')
    if (reasons.length > 0) {
      return {
        actionId: action.id,
        verdict: 'indeterminate',
        reason: reasons.join('; '),
        messageId: action.messageId ?? null,
        from,
        to: from,
        changed: false,
        evidence: {
          kind: trace.available ? 'no-trace' : 'not-observable',
          seq: null,
          messageId: null,
          sourceKind: null,
          headSeq: trace.headSeq,
          headTimeMs: trace.headTimeMs,
          sinceMs: trace.sinceMs,
          candidates: trace.candidateEvents,
          truncated: trace.truncated,
          detail: reasons.join('; '),
        },
      }
    }

    const wasNotDelivered = action.state === 'planned' && outbox === 'blocked'
    const changed = !wasNotDelivered
    if (changed) {
      // Back to a visible, human-decided state: NO automatic retry follows.
      this.repo.markActionState(this.scopeId, action.id, 'planned')
      this.repo.settleOutbox(this.scopeId, action.id, 'blocked', {
        reconciled: true,
        verdict: 'not-delivered',
        at: now(),
      })
      this.audit(
        'dispatch/reconciled-not-delivered',
        action.id,
        `NO durable trace after clean restart (headSeq=${String(trace.headSeq)}); state outcome_unknown -> planned, outbox -> blocked; automatic retry NOT performed`,
      )
    }
    return {
      actionId: action.id,
      verdict: 'not-delivered',
      reason: 'no-durable-trace-after-clean-restart',
      messageId: action.messageId ?? null,
      from,
      to: { actionState: 'planned', outboxState: 'blocked' },
      changed,
      evidence: {
        kind: 'no-trace',
        seq: null,
        messageId: null,
        sourceKind: null,
        headSeq: trace.headSeq,
        headTimeMs: trace.headTimeMs,
        sinceMs: trace.sinceMs,
        candidates: trace.candidateEvents,
        truncated: false,
        detail: 'the durable log and the rebuilt inbox contain no trace of the message id',
      },
    }
  }

  /** Ledger outbox state for one action (unknown when no reader is composed). */
  private outboxStateOf(action: ActionRow): string | null {
    try {
      if (this.options.outboxState !== undefined) return this.options.outboxState(action.id)
    } catch {
      /* fall through to the ledger-state inference */
    }
    if (action.state === 'accepted' || action.state === 'running' || action.state === 'settled') return 'accepted'
    if (action.state === 'outcome_unknown') return 'unknown'
    if (action.state === 'rejected' || action.state === 'stopped') return 'cancelled'
    return null
  }

  private audit(kind: string, actionId: string, reason: string): void {
    try {
      this.repo.audit(this.scopeId, kind, actionId, 'system', reason)
    } catch {
      /* reconciliation must not fail because the audit sink did */
    }
  }

  /**
   * Boot reconciliation.
   *
   * - a `sending` row with no matching receipt becomes `outcome_unknown`;
   * - the recovery gate is consulted for every pending proxy command so an old
   *   run's command cannot execute on its own;
   * - duplicate message ids are collapsed by the ledger's UNIQUE constraint.
   *
   * This method only marks the UNKNOWN window; it never re-sends. Evidence-based
   * classification is `reconcileUnknown()`.
   */
  reconcile(): {
    unknown: string[]
    blockedByGate: string[]
    readyToRetry: number
  } {
    const outcome = this.repo.reconcileOutbox(this.scopeId)
    const blockedByGate: string[] = []
    const known = this.options.knownMessageIds()
    for (const actionId of outcome.unknown) {
      const action = this.repo.getAction(this.scopeId, actionId)
      if (!action) continue
      if (action.targetSessionId && this.options.pendingFor) {
        const pending = this.options.pendingFor(action.targetSessionId)
        const claimed = pending
          .filter((row) => row.actionId === actionId)
          .map((row) => (known.has(row.id) ? { id: row.id } : { id: row.id }))
        if (this.options.gateDecision && claimed.length > 0) {
          const decision = this.options.gateDecision(claimed)
          if (!decision.allow) blockedByGate.push(actionId)
        }
      }
    }
    return { unknown: outcome.unknown, blockedByGate, readyToRetry: outcome.retryable }
  }

  /** Deterministic stop: only BOOP-owned pending work is stopped. */
  async stopOwned(input: {
    sessionId: string
    actionId: string
    cancel: () => Promise<{ requested: boolean; settled: boolean }>
  }): Promise<{ requested: boolean; settled: boolean }> {
    const action = this.repo.getAction(this.scopeId, input.actionId)
    if (!action) return { requested: false, settled: false }
    if (action.targetSessionId !== input.sessionId) return { requested: false, settled: false }
    const result = await input.cancel()
    if (result.requested) {
      this.repo.markActionState(this.scopeId, input.actionId, 'stopped')
      this.repo.settleOutbox(this.scopeId, input.actionId, 'cancelled')
    }
    return result
  }

  /**
   * Invalidate approval cards whose object version moved (task version or
   * policy epoch). Returns the ids that became invalid, so the UI can turn the
   * old cards into "已失效" instead of leaving a live button.
   */
  expireStaleApprovals(current: { taskVersion: number; policyEpoch: number }): string[] {
    return this.repo.expireStaleApprovals(this.scopeId, current)
  }
}

function notObservableEvidence(detail: string): ReconcileEvidenceFacts {
  return {
    kind: 'not-observable',
    seq: null,
    messageId: null,
    sourceKind: null,
    headSeq: null,
    truncated: false,
    detail,
  }
}

export type { LedgerConflict }
