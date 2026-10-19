#!/usr/bin/env node
/**
 * E04-03 Host half · human control plane view-model (unit).
 *
 * Gates/scenes: G04 (recovery release is explicit), G05 (server-side authority,
 * no UI-only gating, no dispatch from the control plane), G09 (native UI/data
 * plane), TB09-adjacent (failure paths are real). Scenes: AT-09, AT-25, AT-26,
 * AT-30, FE-06, FE-07, FE-10, FE-11.
 *
 * The ledger here is a FAKE in-memory port: it deliberately exposes only the
 * operations the real repository has (plus the single-row invalidate primitive
 * the production adapter implements). The REAL host + real SQLite ledger run is
 * `tests/host/e04-03-control-in-host.test.mjs`.
 *
 * Run: node --test tests/unit/e04-03-control.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONTROL_ENDPOINTS,
  CONTROL_READ_ENDPOINTS,
  CONTROL_WRITE_ENDPOINTS,
  controlApprovalsFacts,
  controlRecoveryFacts,
  controlReleaseFacts,
  controlStateFacts,
  controlStopFacts,
  decideApprovalFacts,
} from '../../src/host/control.ts'
import * as controlModule from '../../src/host/control.ts'

const SCOPE = 'boop-e04-03-unit'
const NOW = '2026-10-18T04:00:00.000Z'
const FUTURE = '2026-10-18T05:00:00.000Z'
const PAST = '2026-10-18T03:00:00.000Z'

/* ── fixture: one BOOP ledger with every state the control plane must report ── */

function seedRows() {
  const tasks = new Map([
    ['T1', 3],
    ['T2', 2],
    ['T3', 1],
    ['T4', 1],
    ['T5', 1],
    ['T6', 1],
    ['T7', 1],
    ['T8', 1],
  ])
  const actions = [
    action('ACT_WAIT', 'T1', 'awaiting_approval', 'prepared'),
    action('ACT_STOPPABLE', 'T5', 'planned', 'prepared'),
    action('ACT_MOVED', 'T2', 'planned', 'prepared'),
    action('ACT_DELIVERED', 'T2', 'running', 'accepted', { session: 'sess-delivered' }),
    action('ACT_SETTLED', 'T8', 'settled', 'accepted', { session: 'sess-settled' }),
    action('ACT_SENDING', 'T3', 'dispatching', 'sending'),
    action('ACT_UNKNOWN', 'T4', 'outcome_unknown', 'unknown'),
    action('ACT_TERMINAL', 'T6', 'stopped', 'cancelled'),
    action('ACT_BLOCKED', 'T7', 'planned', 'blocked'),
  ]
  const approvals = [
    approval('A1', 'ACT_WAIT', 'pending', { taskId: 'T1', taskVersion: 3, nonce: 'nonce-1', payloadHash: 'ph-1' }),
    approval('A9', 'ACT_WAIT', 'pending', { taskId: 'T1', taskVersion: 3, nonce: 'nonce-9', payloadHash: 'ph-9' }),
    approval('A2', 'ACT_STOPPABLE', 'pending', { taskId: 'T5', taskVersion: 1, nonce: 'nonce-2', payloadHash: 'ph-2' }),
    approval('A3', 'ACT_MOVED', 'pending', { taskId: 'T2', taskVersion: 1, nonce: 'nonce-3', payloadHash: 'ph-3' }),
    approval('A4', 'ACT_WAIT', 'pending', { taskId: 'T1', taskVersion: 3, nonce: 'nonce-4', payloadHash: 'ph-4', expiresAt: PAST }),
    approval('A5', 'ACT_WAIT', 'pending', { taskId: 'T1', taskVersion: 3, policyEpoch: 0, nonce: 'nonce-5', payloadHash: 'ph-5' }),
    approval('A6', 'ACT_DELIVERED', 'allowed', { taskId: 'T2', taskVersion: 2, nonce: 'nonce-6', payloadHash: 'ph-6', consumedAt: NOW }),
    approval('A7', 'ACT_TERMINAL', 'rejected', { taskId: 'T6', taskVersion: 1, nonce: 'nonce-7', payloadHash: 'ph-7' }),
    approval('A8', 'ACT_TERMINAL', 'stale', { taskId: 'T6', taskVersion: 1, nonce: 'nonce-8', payloadHash: 'ph-8' }),
  ]
  return { tasks, actions, approvals }

  function action(actionId, taskId, state, outboxState, options = {}) {
    return {
      actionId,
      taskId,
      targetSessionId: options.session ?? `sess-${actionId}`,
      taskVersion: tasks.get(taskId),
      payloadHash: `action-ph-${actionId}`,
      state,
      messageId: state === 'planned' || state === 'awaiting_approval' ? null : `msg-${actionId}`,
      policyEpoch: 1,
      originRef: 'dsh:operator',
      createdAt: NOW,
      updatedAt: NOW,
      outboxState,
      outboxAttempt: outboxState === 'accepted' ? 1 : 0,
      leaseUntil: outboxState === 'sending' ? '2026-10-18T04:00:30.000Z' : null,
    }
  }

  function approval(approvalId, actionId, status, options = {}) {
    return {
      approvalId,
      actionId,
      taskId: options.taskId ?? null,
      targetSessionId: `sess-${actionId}`,
      payloadHash: options.payloadHash ?? `ph-${approvalId}`,
      taskVersion: options.taskVersion ?? 1,
      policyEpoch: options.policyEpoch ?? 1,
      requestingOwner: 'dsh-local-owner',
      nonce: options.nonce ?? `nonce-${approvalId}`,
      expiresAt: options.expiresAt ?? FUTURE,
      consumedAt: options.consumedAt ?? null,
      status,
      invalidReason: null,
    }
  }
}

/** In-memory mirror of the real repository operations the control plane uses. */
function makeLedger(seed, options = {}) {
  const rows = seed.approvals.map((row) => ({ ...row }))
  const actions = seed.actions.map((row) => ({ ...row }))
  const tasks = new Map(seed.tasks)
  const calls = []
  let epoch = 1
  const ledger = {
    scopeId: SCOPE,
    writable: options.writable !== false,
    calls,
    listApprovals(limit = 50) {
      const sorted = [...rows].sort(
        (left, right) =>
          (left.status === 'pending' ? 0 : 1) - (right.status === 'pending' ? 0 : 1) ||
          left.expiresAt.localeCompare(right.expiresAt) ||
          left.approvalId.localeCompare(right.approvalId),
      )
      return { rows: sorted.slice(0, limit), total: sorted.length }
    },
    listActions(limit = 50) {
      return { rows: actions.slice(0, limit), total: actions.length }
    },
    getApproval(approvalId) {
      return rows.find((row) => row.approvalId === approvalId) ?? null
    },
    taskVersions() {
      return new Map(tasks)
    },
    policyEpoch() {
      return epoch
    },
    writable() {
      return options.writable !== false
    },
    consumeApproval(input) {
      calls.push(['consumeApproval', input.approvalId])
      const row = ledger.getApproval(input.approvalId)
      if (row === null) return 'not_found'
      if (row.status === 'allowed') return 'allowed'
      if (row.status !== 'pending') return row.status
      if (row.nonce !== input.nonce) return 'stale'
      if (row.payloadHash !== input.payloadHash) return 'stale'
      if (row.taskVersion !== input.taskVersion) return 'stale'
      if (row.policyEpoch !== input.policyEpoch) return 'stale'
      if (row.expiresAt <= NOW) {
        row.status = 'expired'
        return 'expired'
      }
      row.status = 'allowed'
      row.consumedAt = NOW
      return 'allowed'
    },
    rejectApproval(approvalId) {
      calls.push(['rejectApproval', approvalId])
      const row = ledger.getApproval(approvalId)
      if (row !== null && row.status === 'pending') row.status = 'rejected'
    },
    markApprovalInvalid(approvalId, cause) {
      calls.push(['markApprovalInvalid', approvalId, cause])
      const row = ledger.getApproval(approvalId)
      if (row === null || row.status !== 'pending') return false
      row.status = 'stale'
      return true
    },
    markActionStopped(actionId) {
      calls.push(['markActionStopped', actionId])
      const row = actions.find((entry) => entry.actionId === actionId)
      row.state = 'stopped'
    },
    settleOutboxCancelled(actionId) {
      calls.push(['settleOutboxCancelled', actionId])
      const row = actions.find((entry) => entry.actionId === actionId)
      row.outboxState = 'cancelled'
    },
    setEpoch(value) {
      epoch = value
    },
  }
  return ledger
}

function makeGate(entries = []) {
  const map = new Map(
    entries.map((entry) => [
      entry.messageId,
      {
        messageId: entry.messageId,
        actionId: entry.actionId,
        sessionId: entry.sessionId,
        state: entry.state ?? 'blocked',
        reason: entry.reason ?? 'command created in this process',
      },
    ]),
  )
  return {
    armed: () => true,
    entries: () => [...map.values()].map((entry) => ({ ...entry })),
    release(messageIds) {
      const released = []
      for (const messageId of messageIds) {
        const entry = map.get(messageId)
        if (entry === undefined) continue
        entry.state = 'released'
        released.push({ ...entry })
      }
      return released
    },
  }
}

function makePort(overrides = {}) {
  const seed = overrides.seed ?? seedRows()
  const ledger = 'ledger' in overrides ? overrides.ledger : makeLedger(seed, overrides)
  const gate = 'gate' in overrides ? overrides.gate : makeGate(overrides.gateEntries ?? [])
  const audits = []
  let seq = 0
  const port = {
    ledger: () => ledger,
    gate: () => gate,
    writeModeEnabled: () => overrides.writeModeEnabled ?? false,
    gates: () => ({ G01: 'PASS', G02: 'NOT_RUN', G05: 'NOT_RUN', G09: 'PASS' }),
    blockedByGates: () => ['G02', 'G05'],
    nextProjectionSeq: () => ++seq,
    now: () => NOW,
    audit: (entry) => {
      audits.push(entry)
      return { recorded: true, sink: 'ledger', id: `audit-${audits.length}` }
    },
    auditSink: () => (overrides.auditSink ?? 'ledger'),
    diagnostics: () => ({ test: 'unit' }),
    audits,
    seed,
  }
  return port
}

const fullBinding = (approvalRow) => ({
  payloadHash: approvalRow.payloadHash,
  taskVersion: approvalRow.taskVersion,
  policyEpoch: approvalRow.policyEpoch,
  nonce: approvalRow.nonce,
})

/* ── state ───────────────────────────────────────────────────────────── */

test('E04-03 state projects pending approvals with real invalid reasons and action/outbox buckets', () => {
  const port = makePort({
    gateEntries: [
      { messageId: 'msg-gate-1', actionId: 'act-gate-1', sessionId: 'sess-gate' },
      { messageId: 'msg-gate-2', actionId: 'act-gate-2', sessionId: 'sess-gate', state: 'released' },
    ],
  })
  const facts = controlStateFacts(port)
  assert.equal(facts.available, true)
  assert.equal(facts.readOnly, true)
  assert.equal(facts.scopeId, SCOPE)
  assert.equal(facts.writeMode.enabled, false)
  assert.deepEqual(facts.writeMode.blockedByGates, ['G02', 'G05'])
  assert.equal(facts.ledger.writable, true)
  assert.equal(facts.dispatch.available, false, 'the control plane never dispatches')
  assert.equal(facts.dispatch.reason, 'write-mode-disabled')
  assert.equal(facts.audit.recorded, false, 'reads do not write audit rows')
  assert.equal(facts.projectionSeq, 1)

  const pending = Object.fromEntries(facts.pendingApprovals.map((card) => [card.approvalId, card]))
  assert.deepEqual(Object.keys(pending).sort(), ['A1', 'A2', 'A3', 'A4', 'A5', 'A9'])
  assert.equal(pending.A1.valid, true)
  assert.equal(pending.A1.canDecide, true)
  assert.equal(pending.A3.valid, false)
  assert.equal(pending.A3.invalidReason, 'task-version-moved')
  assert.equal(pending.A4.invalidReason, 'expired')
  assert.equal(pending.A5.invalidReason, 'policy-epoch-moved')
  assert.equal(pending.A1.nonce, 'nonce-1', 'the card carries the exact binding value it must echo back')

  assert.equal(facts.approvalCounts.pending, 6)
  assert.equal(facts.approvalCounts.validPending, 3)
  assert.equal(facts.approvalCounts.invalidPending, 3)
  assert.equal(facts.approvalCounts.allowed, 1)
  assert.equal(facts.approvalCounts.rejected, 1)
  assert.equal(facts.approvalCounts.stale, 1)
  assert.deepEqual(
    facts.invalidApprovals.map((card) => [card.approvalId, card.status]),
    [['A8', 'stale']],
    'terminal invalid cards are reported separately, never as pending work',
  )

  const actions = Object.fromEntries(facts.actions.map((action) => [action.actionId, action]))
  assert.equal(actions.ACT_WAIT.bucket, 'pending')
  assert.equal(actions.ACT_WAIT.cancellable, true)
  assert.equal(actions.ACT_DELIVERED.bucket, 'accepted')
  assert.equal(actions.ACT_DELIVERED.cancellable, false)
  assert.equal(actions.ACT_SENDING.bucket, 'pending')
  assert.equal(actions.ACT_SENDING.cancellable, false, 'in-flight delivery is not a deterministic stop target')
  assert.equal(actions.ACT_UNKNOWN.bucket, 'unknown')
  assert.equal(actions.ACT_BLOCKED.bucket, 'blocked')
  assert.equal(actions.ACT_TERMINAL.bucket, 'cancelled')
  assert.deepEqual(facts.actionCounts, { total: 9, pending: 4, accepted: 2, unknown: 1, blocked: 1, cancelled: 1 })
  assert.deepEqual(facts.unknownResults.map((action) => action.actionId), ['ACT_UNKNOWN'])

  assert.equal(facts.recovery.available, true)
  assert.equal(facts.recovery.armed, true)
  assert.deepEqual(
    facts.recovery.entries.map((entry) => [entry.messageId, entry.state, entry.releasable]),
    [
      ['msg-gate-1', 'blocked', true],
      ['msg-gate-2', 'released', false],
    ],
  )
  assert.equal(facts.recovery.pendingCount, 1)
  assert.equal(facts.recovery.releasedCount, 1)
  assert.equal(facts.recovery.bulkReleaseDefault, false)
  assert.equal(facts.recovery.runtimeEnforcement.composed, false, 'pre-step wiring is honestly NOT composed')
})

test('E04-03 every response carries monotonic projectionSeq, writeMode, ledger and an audit receipt', () => {
  const port = makePort()
  const responses = [
    controlStateFacts(port),
    controlApprovalsFacts(port),
    controlRecoveryFacts(port),
  ]
  for (const response of responses) {
    assert.equal(typeof response.projectionSeq, 'number')
    assert.ok(response.writeMode.source === 'boop.isWriteModeEnabled()')
    assert.equal(typeof response.ledger.writable, 'boolean')
    assert.equal(typeof response.audit.recorded, 'boolean')
  }
  assert.ok(responses[1].projectionSeq > responses[0].projectionSeq)
  assert.ok(responses[2].projectionSeq > responses[1].projectionSeq)
})

test('FE-11 an unreadable ledger is unavailable, never an empty approval/action list', () => {
  const port = makePort({ ledger: null })
  const facts = controlStateFacts(port)
  assert.equal(facts.available, false)
  assert.equal(facts.reason, 'ledger-unavailable')
  assert.deepEqual(facts.pendingApprovals, [])
  assert.deepEqual(facts.actions, [])
  assert.equal(facts.ledger.writable, false)

  const approvals = controlApprovalsFacts(port)
  assert.equal(approvals.available, false)
  assert.equal(approvals.reason, 'ledger-unavailable')

  const stop = controlStopFacts(port, { scope: 'all' })
  assert.equal(stop.available, false)
  assert.equal(stop.accepted, false)
  assert.equal(stop.code, 'CAPABILITY_UNAVAILABLE')

  const decide = decideApprovalFacts(port, {
    approvalId: 'A1',
    decision: 'approve',
    expected: { payloadHash: 'ph-1', taskVersion: 3, policyEpoch: 1, nonce: 'nonce-1' },
  })
  assert.equal(decide.outcome, 'capability-unavailable')
  assert.equal(decide.code, 'CAPABILITY_UNAVAILABLE')
})

test('E04-03 a read-only ledger (no writer lease) disables decisions but still reports state', () => {
  const port = makePort({ writable: false })
  const facts = controlStateFacts(port)
  assert.equal(facts.available, true)
  assert.equal(facts.ledger.writable, false)
  assert.ok(facts.pendingApprovals.length > 0)
  assert.ok(facts.pendingApprovals.every((card) => card.canDecide === false), 'no button may act on a read-only ledger')

  const decide = decideApprovalFacts(port, {
    approvalId: 'A1',
    decision: 'approve',
    expected: { payloadHash: 'ph-1', taskVersion: 3, policyEpoch: 1, nonce: 'nonce-1' },
  })
  assert.equal(decide.outcome, 'capability-unavailable')
  assert.equal(decide.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(decide.audit.recorded, true)
})

/* ── approvals ───────────────────────────────────────────────────────── */

test('E04-03 approvals() lists the real cards with nonce, validity and counts', () => {
  const port = makePort()
  const facts = controlApprovalsFacts(port)
  assert.equal(facts.available, true)
  assert.equal(facts.total, 9)
  assert.equal(facts.approvals.length, 9)
  const byId = Object.fromEntries(facts.approvals.map((card) => [card.approvalId, card]))
  assert.equal(byId.A6.status, 'allowed')
  assert.equal(byId.A6.decision, 'allowed')
  assert.equal(byId.A7.decision, 'rejected')
  assert.equal(byId.A8.status, 'stale')
  assert.equal(byId.A1.canDecide, true)
  assert.equal(byId.A3.canDecide, false)
  assert.equal(facts.counts.pending, 6)
  assert.equal(facts.limits.listMax, 100)

  const bounded = controlApprovalsFacts(port, { limit: 2 })
  assert.equal(bounded.approvals.length, 2)
  assert.equal(bounded.total, 9)
  assert.equal(bounded.truncated, true)
})

/* ── decideApproval: the human decision ──────────────────────────────── */

test('E04-03 approve lands the decision in the ledger and dispatches NOTHING', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A1')
  const facts = decideApprovalFacts(port, { approvalId: 'A1', decision: 'approve', expected: fullBinding(row) })
  assert.equal(facts.accepted, true)
  assert.equal(facts.outcome, 'allowed')
  assert.equal(facts.code, null)
  assert.equal(facts.executed, false)
  assert.equal(facts.dispatched, false)
  assert.equal(facts.ledger.writable, true)
  assert.equal(facts.dispatch.available, false)
  assert.equal(facts.approval.status, 'allowed')
  assert.equal(facts.approval.consumedAt, NOW)
  assert.equal(facts.audit.recorded, true)
  assert.equal(facts.audit.kind, 'control/approval-decided')
  assert.match(facts.audit.kind, /approval-decided/)
  // The action and outbox were NOT touched: approval is not execution.
  const action = port.ledger().listActions().rows.find((entry) => entry.actionId === 'ACT_WAIT')
  assert.equal(action.state, 'awaiting_approval')
  assert.equal(action.outboxState, 'prepared')
  assert.deepEqual(port.ledger().calls, [['consumeApproval', 'A1']])
})

test('E04-03 a repeated approve is already-handled and never re-allowed', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A1')
  decideApprovalFacts(port, { approvalId: 'A1', decision: 'approve', expected: fullBinding(row) })
  const callsBefore = port.ledger().calls.length
  const repeat = decideApprovalFacts(port, { approvalId: 'A1', decision: 'approve', expected: fullBinding(row) })
  assert.equal(repeat.accepted, false)
  assert.equal(repeat.outcome, 'already-handled')
  assert.equal(repeat.idempotent, true)
  assert.equal(repeat.existingStatus, 'allowed')
  assert.equal(repeat.dispatched, false)
  assert.equal(port.ledger().calls.length, callsBefore, 'the single-use CAS is not consumed twice')
})

test('E04-03 reject lands a calm rejection and dispatches NOTHING', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A2')
  const facts = decideApprovalFacts(port, { approvalId: 'A2', decision: 'reject', expected: fullBinding(row) })
  assert.equal(facts.accepted, true)
  assert.equal(facts.outcome, 'rejected')
  assert.equal(facts.executed, false)
  assert.equal(facts.dispatched, false)
  assert.equal(facts.approval.status, 'rejected')
  assert.equal(facts.audit.recorded, true)
  assert.deepEqual(port.ledger().calls, [['rejectApproval', 'A2']])
})

test('04§08 an expired approval is APPROVAL_STALE, persisted as expired, never allowed', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A4')
  const facts = decideApprovalFacts(port, { approvalId: 'A4', decision: 'approve', expected: fullBinding(row) })
  assert.equal(facts.accepted, false)
  assert.equal(facts.outcome, 'stale')
  assert.equal(facts.code, 'APPROVAL_STALE')
  assert.equal(facts.staleCause, 'expired')
  assert.equal(facts.markedInvalid, true)
  assert.equal(facts.approval.status, 'expired')
  assert.equal(facts.executed, false)
  assert.equal(facts.dispatched, false)
  assert.equal(facts.audit.kind, 'control/approval-refused')
})

test('04§08 a task version move invalidates the old card instead of leaving it clickable', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A3')
  assert.equal(row.taskVersion, 1)
  assert.equal(port.ledger().taskVersions().get('T2'), 2, 'the live task really moved past the card')
  const facts = decideApprovalFacts(port, { approvalId: 'A3', decision: 'approve', expected: fullBinding(row) })
  assert.equal(facts.outcome, 'stale')
  assert.equal(facts.staleCause, 'task-version-moved')
  assert.equal(facts.markedInvalid, true)
  assert.equal(facts.approval.status, 'stale')
  assert.deepEqual(port.ledger().calls, [['markApprovalInvalid', 'A3', 'task-version-moved']])
})

test('04§08 a policy epoch move invalidates the old card', () => {
  const port = makePort()
  const row = port.ledger().getApproval('A5')
  const facts = decideApprovalFacts(port, { approvalId: 'A5', decision: 'reject', expected: fullBinding(row) })
  assert.equal(facts.outcome, 'stale')
  assert.equal(facts.staleCause, 'policy-epoch-moved')
  assert.equal(facts.markedInvalid, true)
  assert.equal(facts.approval.status, 'stale')
})

test('a forged/mismatched card binding is APPROVAL_STALE but does NOT invalidate a legitimate card', () => {
  const cases = [
    { field: 'nonce', mutate: (binding) => ({ ...binding, nonce: 'forged-nonce' }), cause: 'nonce-mismatch' },
    { field: 'payloadHash', mutate: (binding) => ({ ...binding, payloadHash: 'forged-payload' }), cause: 'payload-changed' },
    { field: 'taskVersion', mutate: (binding) => ({ ...binding, taskVersion: 2 }), cause: 'caller-binding-mismatch' },
    { field: 'policyEpoch', mutate: (binding) => ({ ...binding, policyEpoch: 9 }), cause: 'caller-binding-mismatch' },
  ]
  for (const entry of cases) {
    const port = makePort()
    const row = port.ledger().getApproval('A9')
    const facts = decideApprovalFacts(port, {
      approvalId: 'A9',
      decision: 'approve',
      expected: entry.mutate(fullBinding(row)),
    })
    assert.equal(facts.outcome, 'stale', entry.field)
    assert.equal(facts.code, 'APPROVAL_STALE', entry.field)
    assert.equal(facts.staleCause, entry.cause, entry.field)
    assert.equal(facts.markedInvalid, false, `${entry.field}: a caller-side mismatch must not invalidate the card`)
    assert.equal(port.ledger().getApproval('A9').status, 'pending', entry.field)
    assert.equal(facts.executed, false, entry.field)
    assert.equal(facts.dispatched, false, entry.field)
    assert.equal(facts.audit.kind, 'control/approval-refused', entry.field)
  }
})

test('E04-03 a mixed-up approval id / binding pair is refused, not guessed', () => {
  const port = makePort()
  const a1 = port.ledger().getApproval('A1')
  const facts = decideApprovalFacts(port, { approvalId: 'A9', decision: 'approve', expected: fullBinding(a1) })
  assert.equal(facts.outcome, 'stale')
  assert.equal(facts.markedInvalid, false)
  assert.equal(port.ledger().getApproval('A9').status, 'pending')
  assert.equal(port.ledger().getApproval('A1').status, 'pending')
})

test('E04-03 unknown approval and incomplete request are stated facts', () => {
  const port = makePort()
  const missing = decideApprovalFacts(port, {
    approvalId: 'NO-SUCH',
    decision: 'approve',
    expected: { payloadHash: 'ph', taskVersion: 1, policyEpoch: 1, nonce: 'n' },
  })
  assert.equal(missing.outcome, 'not-found')
  assert.equal(missing.code, 'APPROVAL_NOT_FOUND')
  assert.equal(missing.accepted, false)

  const incomplete = decideApprovalFacts(port, { approvalId: 'A1', decision: 'maybe' })
  assert.equal(incomplete.outcome, 'invalid-request')
  assert.equal(incomplete.code, 'INVALID_ARGUMENT')
  assert.equal(incomplete.audit.recorded, true)
})

/* ── stop: deterministic, scoped, honest ─────────────────────────────── */

test('G05/AT-30 stop task scope cancels ONLY BOOP pending work and invalidates its card', () => {
  const port = makePort()
  const facts = controlStopFacts(port, { scope: 'task:T1' })
  assert.equal(facts.accepted, true)
  assert.equal(facts.executed, true)
  assert.equal(facts.matched, 1)
  assert.deepEqual(facts.requestedScope, { raw: 'task:T1', kind: 'task', id: 'T1' })
  assert.equal(facts.stopped.length, 1)
  const stopped = facts.stopped[0]
  assert.equal(stopped.actionId, 'ACT_WAIT')
  assert.equal(stopped.actionState, 'stopped')
  assert.equal(stopped.outboxState, 'cancelled')
  assert.deepEqual(stopped.invalidatedApprovalIds.sort(), ['A1', 'A4', 'A5', 'A9'])
  const action = port.ledger().listActions().rows.find((entry) => entry.actionId === 'ACT_WAIT')
  assert.equal(action.state, 'stopped')
  assert.equal(action.outboxState, 'cancelled')
  for (const id of ['A1', 'A4', 'A5', 'A9']) assert.equal(port.ledger().getApproval(id).status, 'rejected')
  assert.equal(facts.policy.userTurnsStopped, false)
  assert.equal(facts.policy.externalSideEffectsUndone, false)
  assert.equal(facts.policy.deterministic, true)
  assert.equal(facts.policy.requiresModel, false)
  assert.equal(facts.truncated, false, 'the bounded action read reports its truncation fact')
  assert.equal(facts.dispatch.available, false)
  assert.equal(facts.audit.kind, 'control/stop')
})

test('G05/AT-30 stop session scope refuses delivered work and never touches a user turn', () => {
  const port = makePort()
  const facts = controlStopFacts(port, { scope: 'session:sess-delivered' })
  assert.equal(facts.matched, 1)
  assert.deepEqual(facts.stopped, [])
  assert.equal(facts.refused.length, 1)
  assert.equal(facts.refused[0].actionId, 'ACT_DELIVERED')
  assert.equal(facts.refused[0].code, 'ALREADY_DELIVERED')
  assert.match(facts.refused[0].reason, /已投递/)
  assert.match(facts.refused[0].note, /原生 Stop|不会停止用户自己的 turn/)
  assert.equal(facts.executed, false)

  // A Session with no BOOP ledger action is a truthful no-op: nothing is stopped
  // and the response says so instead of pretending success.
  const foreign = controlStopFacts(port, { scope: 'session:a-user-session' })
  assert.equal(foreign.accepted, true)
  assert.equal(foreign.noop, true)
  assert.deepEqual(foreign.stopped, [])
  assert.deepEqual(foreign.refused, [])
  assert.equal(foreign.policy.foreignTurns, 'not-inspected-never-stopped')
})

test('AT-30 stop all reports per-object partial success, in-flight and unknown truthfully', () => {
  const port = makePort()
  const facts = controlStopFacts(port, { scope: 'all' })
  assert.equal(facts.accepted, true)
  assert.equal(facts.matched, 9)
  assert.equal(facts.stopped.length, 4)
  assert.deepEqual(facts.stopped.map((entry) => entry.actionId).sort(), [
    'ACT_BLOCKED',
    'ACT_MOVED',
    'ACT_STOPPABLE',
    'ACT_WAIT',
  ])
  assert.deepEqual(
    facts.refused.map((entry) => [entry.actionId, entry.code]).sort(),
    [
      ['ACT_DELIVERED', 'ALREADY_DELIVERED'],
      ['ACT_SETTLED', 'ALREADY_DELIVERED'],
      ['ACT_TERMINAL', 'ALREADY_TERMINAL'],
    ],
  )
  assert.deepEqual(
    facts.unknown.map((entry) => [entry.actionId, entry.code]).sort(),
    [
      ['ACT_SENDING', 'DELIVERY_IN_FLIGHT'],
      ['ACT_UNKNOWN', 'OUTCOME_UNKNOWN'],
    ],
  )
  assert.deepEqual(facts.summary, { matched: 9, stopped: 4, refused: 3, unknown: 2 })
  assert.equal(facts.executed, true)
  assert.equal(facts.policy.externalSideEffectsUndone, false, 'stop never claims a remote effect was undone')
  assert.equal(facts.audit.recorded, true)
})

test('E04-03 stop rejects an unknown scope and explains the accepted forms', () => {
  for (const scope of [undefined, '', 'everything', 'task:', 'bogus:x']) {
    const port = makePort()
    const facts = controlStopFacts(port, scope === undefined ? {} : { scope })
    assert.equal(facts.accepted, false, JSON.stringify(scope))
    assert.equal(facts.code, 'INVALID_ARGUMENT', JSON.stringify(scope))
    assert.match(facts.message, /all.*task:.*action:.*session:/)
    assert.equal(facts.audit.kind, 'control/stop-refused')
  }
})

test('E04-03 stop refuses to write on a read-only ledger and writes nothing', () => {
  const port = makePort({ writable: false })
  const facts = controlStopFacts(port, { scope: 'all' })
  assert.equal(facts.accepted, false)
  assert.equal(facts.available, false)
  assert.equal(facts.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(port.ledger().calls, [])
  assert.equal(facts.audit.recorded, true)
})

test('E04-03 stop with nothing to stop is an honest no-op, never a fake success', () => {
  const port = makePort()
  const facts = controlStopFacts(port, { scope: 'action:NO-SUCH-ACTION' })
  assert.equal(facts.accepted, true)
  assert.equal(facts.noop, true)
  assert.equal(facts.executed, false)
  assert.deepEqual(facts.stopped, [])
  assert.equal(facts.matched, 0)
  assert.match(facts.message, /没有可停止的 BOOP 动作/)
})

/* ── recovery + release ──────────────────────────────────────────────── */

test('G04 recovery reports the armed gate, explicit selection and unknown results', () => {
  const port = makePort({
    gateEntries: [{ messageId: 'msg-1', actionId: 'act-1', sessionId: 'sess-1' }],
  })
  const facts = controlRecoveryFacts(port)
  assert.equal(facts.available, true)
  assert.equal(facts.recovery.armed, true)
  assert.equal(facts.recovery.requiresExplicitSelection, true)
  assert.equal(facts.recovery.bulkReleaseDefault, false)
  assert.equal(facts.recovery.pendingCount, 1)
  assert.equal(facts.recovery.entries[0].releasable, true)
  assert.equal(facts.recovery.runtimeEnforcement.composed, false)
  assert.deepEqual(facts.unknownResults.map((action) => action.actionId), ['ACT_UNKNOWN'])
  assert.equal(facts.audit.recorded, false, 'inspection writes no audit row')
  assert.equal(facts.truncated, false)

  const noGate = controlRecoveryFacts(makePort({ gate: null }))
  assert.equal(noGate.recovery.available, false)
  assert.equal(noGate.recovery.reason, 'gate-unavailable')
})

test('G04/AT-26 release releases EXACTLY the named messages, never a bulk default', () => {
  const port = makePort({
    gateEntries: [
      { messageId: 'msg-1', actionId: 'act-1', sessionId: 'sess-1' },
      { messageId: 'msg-2', actionId: 'act-2', sessionId: 'sess-2' },
    ],
  })
  const facts = controlReleaseFacts(port, { messageIds: ['msg-1', 'unknown-id'] })
  assert.equal(facts.accepted, true)
  assert.equal(facts.released.length, 1)
  assert.equal(facts.released[0].messageId, 'msg-1')
  assert.equal(facts.released[0].state, 'released')
  assert.deepEqual(facts.ignored, [{ messageId: 'unknown-id', reason: 'unknown-message-id' }])
  assert.equal(facts.requiresExplicitSelection, true)
  assert.equal(facts.bulkDefault, false)
  assert.equal(facts.audit.recorded, true)
  assert.equal(facts.audit.kind, 'control/gate-released')
  assert.equal(port.gate().entries().find((entry) => entry.messageId === 'msg-1').state, 'released')
  assert.equal(port.gate().entries().find((entry) => entry.messageId === 'msg-2').state, 'blocked', 'unselected stays blocked')
})

test('G04 release with no explicit selection is refused: no default all-release', () => {
  for (const request of [{}, { messageIds: [] }, { messageIds: ['', '   '] }]) {
    const port = makePort({ gateEntries: [{ messageId: 'msg-1', actionId: 'act-1', sessionId: 'sess-1' }] })
    const facts = controlReleaseFacts(port, request)
    assert.equal(facts.accepted, false, JSON.stringify(request))
    assert.equal(facts.code, 'INVALID_ARGUMENT')
    assert.deepEqual(facts.released, [])
    assert.match(facts.message, /显式选择|不会默认全选/)
    assert.equal(facts.audit.recorded, true)
  }
})

test('E04-03 release says unavailable when the recovery gate service is missing', () => {
  const port = makePort({ gate: null })
  const facts = controlReleaseFacts(port, { messageIds: ['msg-1'] })
  assert.equal(facts.accepted, false)
  assert.equal(facts.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(facts.released, [])
  assert.equal(facts.audit.recorded, true)
})

/* ── frozen surface rules ────────────────────────────────────────────── */

test('TB05/TB09 the control plane exposes no dispatch/verification/approval-run command', () => {
  assert.deepEqual([...CONTROL_ENDPOINTS], [
    'boopControl/state',
    'boopControl/approvals',
    'boopControl/decideApproval',
    'boopControl/stop',
    'boopControl/recovery',
    'boopControl/release',
  ])
  assert.deepEqual([...CONTROL_READ_ENDPOINTS], ['state', 'approvals', 'recovery'])
  assert.deepEqual([...CONTROL_WRITE_ENDPOINTS], ['decideApproval', 'stop', 'release'])
  for (const endpoint of CONTROL_ENDPOINTS) {
    assert.doesNotMatch(endpoint, /dispatch|verify|approve-run|execute/i)
  }
  const exportedFunctions = Object.entries(controlModule)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
  assert.ok(!exportedFunctions.some((name) => /dispatch|execute|run/i.test(name)))
  // The only decision function only lands a decision; no dispatch path exists here.
  const port = makePort()
  const facts = decideApprovalFacts(port, {
    approvalId: 'A1',
    decision: 'approve',
    expected: { payloadHash: 'ph-1', taskVersion: 3, policyEpoch: 1, nonce: 'nonce-1' },
  })
  assert.equal(facts.dispatched, false)
  assert.equal(facts.executed, false)
})

test('E04-03 decideApproval is NOT gated by write mode, but every response says dispatch is unavailable', () => {
  const port = makePort({ writeModeEnabled: false })
  const row = port.ledger().getApproval('A1')
  const facts = decideApprovalFacts(port, { approvalId: 'A1', decision: 'approve', expected: fullBinding(row) })
  assert.equal(facts.accepted, true, 'human authorisation is the permission source itself')
  assert.equal(facts.writeMode.enabled, false)
  assert.equal(facts.dispatch.available, false)
  assert.equal(facts.dispatch.reason, 'write-mode-disabled')
  assert.match(facts.message, /没有派发任何动作/)

  // Even if the gate were flipped open, this row still dispatches nothing.
  const openPort = makePort({ writeModeEnabled: true })
  const openRow = openPort.ledger().getApproval('A1')
  const openFacts = decideApprovalFacts(openPort, {
    approvalId: 'A1',
    decision: 'approve',
    expected: fullBinding(openRow),
  })
  assert.equal(openFacts.accepted, true)
  assert.equal(openFacts.dispatch.available, false)
  assert.equal(openFacts.dispatch.reason, 'dispatch-not-on-this-row')
  assert.equal(openFacts.dispatched, false)
})
