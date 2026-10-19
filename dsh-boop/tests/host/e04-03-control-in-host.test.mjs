#!/usr/bin/env node
/**
 * E04-03 in-host · human approval / stop / recovery control plane on DSH 0.2.1-rc.2.
 *
 * Gates/scenes: G04 (recovery gate, explicit release), G05 (server-side
 * authority; no UI-only gating; no dispatch from this plane), G09 (native
 * data/UI plane). Scenes: AT-09, AT-25, AT-26, AT-30, AT-37, FE-06, FE-07,
 * FE-10, FE-11.
 *
 * Runs against the INSTALLED rc.2.1 payload in a private `$DSH_HOME` under
 * `.work/test-runs/e04-03-control-*`; the user's real `~/.dsh` is never read or
 * modified.
 *
 * FIXTURE DISCLOSURE: real BOOP ledger rows are seeded by this test through a
 * direct `node:sqlite` connection to `$DSH_HOME/boop/boop.sqlite` (task +
 * task_revision + action + command_outbox + approval INSERTs). The plugin itself
 * has NO seed endpoint and the PoC API row is NOT extended for this test; the
 * only PoC call used is the already-shipped `boop/pocSeedInbox`, solely to put
 * real BOOP gate entries into the in-memory `RecoveryGate` so release can be
 * proven end-to-end. The seeded rows are marked `seed-*` in every id.
 *
 * Run: node --test --test-force-exit tests/host/e04-03-control-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, before, after } from 'node:test'
import {
  PROJECT_ROOT,
  anonymousRequest,
  authorize,
  bootWeb,
  createProfile,
  freePort,
  makeHome,
  rpc,
  runCli,
} from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e04-03-control-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROFILE = 'boop-control'
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const POC_SESSION = 'boop-control-poc'

let host
let base
let cookie
let fixture
let scopeId
let ids = {}
const seeded = {}

/* ── direct-SQLite fixture (disclosed above; no plugin seed endpoint) ─── */

const NOW = new Date()
const FUTURE = new Date(NOW.getTime() + 3_600_000).toISOString()
const PAST = new Date(NOW.getTime() - 3_600_000).toISOString()

function insertTaskRow(db, { id, goal, lifecycle, verification, version }) {
  db.prepare(
    'INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, scopeId, goal, lifecycle, verification, version, '["可验证"]', '["不部署"]', null, NOW.toISOString(), NOW.toISOString())
  // Every version the action/approval fixture names must exist as a revision
  // (the action row's FK binds to the exact revision).
  for (let revision = 1; revision <= version; revision += 1) {
    db.prepare(
      'INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)',
    ).run(
      id,
      scopeId,
      revision,
      JSON.stringify({ goal, criteria: ['可验证'], exclusions: ['不部署'] }),
      null,
      new Date(NOW.getTime() - (version - revision) * 1000).toISOString(),
    )
  }
}

function insertActionRow(db, { id, taskId, taskVersion, state, targetSessionId, payloadHash, outboxState, leaseUntil }) {
  db.prepare(
    'INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    scopeId,
    taskId,
    taskVersion,
    targetSessionId,
    payloadHash,
    JSON.stringify({ instruction: 'seed' }),
    state,
    null,
    null,
    1,
    'dsh:operator',
    NOW.toISOString(),
    NOW.toISOString(),
  )
  if (leaseUntil === null) {
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run(id, scopeId, outboxState, 0)
  } else {
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt,lease_until) VALUES(?,?,?,?,?)').run(
      id,
      scopeId,
      outboxState,
      1,
      leaseUntil,
    )
  }
}

function insertApprovalRow(db, { id, actionId, payloadHash, taskVersion, nonce, status, expiresAt, consumedAt = null }) {
  db.prepare(
    'INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,consumed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, scopeId, actionId, payloadHash, taskVersion, 1, 'dsh-local-owner', nonce, expiresAt, consumedAt, status)
}

function seedLedgerFixture() {
  fixture = new DatabaseSync(LEDGER)
  fixture.exec('PRAGMA foreign_keys = ON')
  const scope = fixture.prepare('SELECT scope_id, policy_epoch FROM scopes LIMIT 1').get()
  assert.ok(scope, 'the BOOP ledger + scope row exist after boot')
  scopeId = String(scope.scope_id)
  assert.equal(Number(scope.policy_epoch), 1)

  /* Task/action/outbox/approval fixture: every id starts with `seed-`. */
  ids = {
    pendingTask: 'seed-task-pending',
    pendingAction: 'seed-act-pending',
    pendingApproval: 'seed-appr-pending',
    expiredTask: 'seed-task-expired',
    expiredAction: 'seed-act-expired',
    expiredApproval: 'seed-appr-expired',
    movedTask: 'seed-task-moved',
    movedAction: 'seed-act-moved',
    movedApproval: 'seed-appr-moved',
    deliveredTask: 'seed-task-delivered',
    deliveredAction: 'seed-act-delivered',
    allowedApproval: 'seed-appr-allowed',
    unknownTask: 'seed-task-unknown',
    unknownAction: 'seed-act-unknown',
    stopTask: 'seed-task-stop',
    stopAction: 'seed-act-stop',
    stopApproval: 'seed-appr-stop',
    sendingTask: 'seed-task-sending',
    sendingAction: 'seed-act-sending',
  }

  insertTaskRow(fixture, { id: ids.pendingTask, goal: '等待人工批准的归档动作', lifecycle: 'active', verification: 'not_requested', version: 3 })
  insertActionRow(fixture, {
    id: ids.pendingAction,
    taskId: ids.pendingTask,
    taskVersion: 3,
    state: 'awaiting_approval',
    targetSessionId: 'seed-session-pending',
    payloadHash: 'seed-payload-pending',
    outboxState: 'prepared',
    leaseUntil: null,
  })
  insertApprovalRow(fixture, {
    id: ids.pendingApproval,
    actionId: ids.pendingAction,
    payloadHash: 'seed-payload-pending',
    taskVersion: 3,
    nonce: 'seed-nonce-pending',
    status: 'pending',
    expiresAt: FUTURE,
  })

  insertTaskRow(fixture, { id: ids.expiredTask, goal: '已过期的审批卡', lifecycle: 'active', verification: 'not_requested', version: 1 })
  insertActionRow(fixture, {
    id: ids.expiredAction,
    taskId: ids.expiredTask,
    taskVersion: 1,
    state: 'awaiting_approval',
    targetSessionId: 'seed-session-expired',
    payloadHash: 'seed-payload-expired',
    outboxState: 'prepared',
    leaseUntil: null,
  })
  insertApprovalRow(fixture, {
    id: ids.expiredApproval,
    actionId: ids.expiredAction,
    payloadHash: 'seed-payload-expired',
    taskVersion: 1,
    nonce: 'seed-nonce-expired',
    status: 'pending',
    expiresAt: PAST,
  })

  // The card binds to taskVersion 2 while the task is already at 3: the Host
  // must project it as task-version-moved and mark it invalid on a decide.
  insertTaskRow(fixture, { id: ids.movedTask, goal: '参数已变化的审批卡', lifecycle: 'active', verification: 'not_requested', version: 3 })
  insertActionRow(fixture, {
    id: ids.movedAction,
    taskId: ids.movedTask,
    taskVersion: 2,
    state: 'planned',
    targetSessionId: 'seed-session-moved',
    payloadHash: 'seed-payload-moved',
    outboxState: 'prepared',
    leaseUntil: null,
  })
  insertApprovalRow(fixture, {
    id: ids.movedApproval,
    actionId: ids.movedAction,
    payloadHash: 'seed-payload-moved',
    taskVersion: 2,
    nonce: 'seed-nonce-moved',
    status: 'pending',
    expiresAt: FUTURE,
  })

  insertTaskRow(fixture, { id: ids.deliveredTask, goal: '已投递到原 Session 的动作', lifecycle: 'active', verification: 'not_requested', version: 1 })
  insertActionRow(fixture, {
    id: ids.deliveredAction,
    taskId: ids.deliveredTask,
    taskVersion: 1,
    state: 'running',
    targetSessionId: 'seed-session-delivered',
    payloadHash: 'seed-payload-delivered',
    outboxState: 'accepted',
    leaseUntil: null,
  })
  insertApprovalRow(fixture, {
    id: ids.allowedApproval,
    actionId: ids.deliveredAction,
    payloadHash: 'seed-payload-delivered',
    taskVersion: 1,
    nonce: 'seed-nonce-allowed',
    status: 'allowed',
    expiresAt: FUTURE,
    consumedAt: NOW.toISOString(),
  })

  insertTaskRow(fixture, { id: ids.unknownTask, goal: '结果未知的动作', lifecycle: 'active', verification: 'not_requested', version: 1 })
  insertActionRow(fixture, {
    id: ids.unknownAction,
    taskId: ids.unknownTask,
    taskVersion: 1,
    state: 'outcome_unknown',
    targetSessionId: 'seed-session-unknown',
    payloadHash: 'seed-payload-unknown',
    outboxState: 'unknown',
    leaseUntil: null,
  })

  insertTaskRow(fixture, { id: ids.stopTask, goal: '用于确定性停止的任务', lifecycle: 'active', verification: 'not_requested', version: 1 })
  insertActionRow(fixture, {
    id: ids.stopAction,
    taskId: ids.stopTask,
    taskVersion: 1,
    state: 'planned',
    targetSessionId: 'seed-session-stop',
    payloadHash: 'seed-payload-stop',
    outboxState: 'prepared',
    leaseUntil: null,
  })
  insertApprovalRow(fixture, {
    id: ids.stopApproval,
    actionId: ids.stopAction,
    payloadHash: 'seed-payload-stop',
    taskVersion: 1,
    nonce: 'seed-nonce-stop',
    status: 'pending',
    expiresAt: FUTURE,
  })

  insertTaskRow(fixture, { id: ids.sendingTask, goal: '投递进行中的动作', lifecycle: 'active', verification: 'not_requested', version: 1 })
  insertActionRow(fixture, {
    id: ids.sendingAction,
    taskId: ids.sendingTask,
    taskVersion: 1,
    state: 'dispatching',
    targetSessionId: 'seed-session-sending',
    payloadHash: 'seed-payload-sending',
    outboxState: 'sending',
    leaseUntil: FUTURE,
  })

  fixture.close()
}

/** Read one seeded ledger row back (test-side verification, read-only). */
function readRow(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).get(...params) ?? null
  } finally {
    db.close()
  }
}

function readRows(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

/* ── RPC helpers ─────────────────────────────────────────────────────── */

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 800)}`)
  return body
}

/** BOOP control Remote plane: one `request` arg, single-layer fact value. */
const control = async (method, request) => {
  const body = await call(`boopControl/${method}`, request === undefined ? {} : { request })
  assert.equal(body.result.ok, true, `${method} RPC failed: ${JSON.stringify(body.result).slice(0, 1200)}`)
  assert.equal(body.result.value.value, undefined, 'the value is SINGLE-LAYER, never an {ok,value} envelope')
  return body.result.value
}

/** PoC-only existing surface: used ONLY to make the real RecoveryGate track messages. */
const poc = async (endpoint, args) => {
  const body = await call(endpoint, args)
  assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result).slice(0, 800)}`)
  return body.result.value
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  // PoC opt-in ONLY so the shipped `boop/pocSeedInbox` can put real recovery-gate
  // entries into this process (no plugin change, no seed endpoint added).
  const patch = path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml')
  fs.writeFileSync(patch, '- id: boop-api\n  config:\n    pocEnabled: true\n')
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort() })
  base = host.base
  cookie = await authorize(base, host.token)

  seedLedgerFixture()

  // Real gate entries: the shipped PoC helper mints BOOP proxy messages, which
  // the runtime gate tracks exactly like a previous run's pending command.
  seeded.messageId = (await poc('boop/pocSeedInbox', { sessionId: POC_SESSION })).messageId
  assert.ok(seeded.messageId, 'the gate seed produced a real message id')
})

after(async () => {
  await host?.stop()
})

/* ── composition ──────────────────────────────────────────────────────── */

test('E04-03 the boop-control row activates with no failed rows or import warnings', () => {
  const output = host.diagnostics.out + host.diagnostics.err
  const warnings = output.split('\n').filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], `activation warnings:\n${warnings.join('\n')}`)
  assert.match(output, /dsh web:/, 'the Web Host booted')
})

test('E04-03 the boop-control row is composed exactly once and does not disturb the other BOOP rows', async () => {
  const compiled = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(compiled.code, 0, compiled.stderr)
  const lines = compiled.stdout.split('\n')
  for (const id of ['dsh-boop', 'boop-api', 'boop-tasks', 'boop-workspace', 'boop-control']) {
    assert.equal(lines.filter((line) => line.trim() === `- id: ${id}`).length, 1, `${id} must be composed exactly once`)
  }
})

/* ── real state / approvals reads ────────────────────────────────────── */

test('E04-03 state projects the real seeded approvals, actions/outbox and recovery gate', async () => {
  const value = await control('state')
  assert.equal(value.available, true, JSON.stringify(value).slice(0, 800))
  assert.equal(value.scopeId, scopeId)
  assert.equal(value.writeMode.enabled, false, 'write mode stays off until G02/G05 pass')
  assert.equal(value.writeMode.source, 'boop.isWriteModeEnabled()')
  // The blocked list is derived from the frozen gate ledger, so compare it to
  // the authoritative bootstrap facts instead of hard-coding gates.
  const bootstrap = await call('boop/bootstrap')
  assert.deepEqual(
    [...value.writeMode.blockedByGates].sort(),
    [...bootstrap.result.value.writeMode.blockedByGates].sort(),
    'the control plane reports the SAME blocked gates as the gate ledger',
  )
  assert.ok(value.writeMode.blockedByGates.includes('G05'))
  assert.equal(value.ledger.writable, true, 'the Host owns the single-writer lease')
  assert.equal(value.dispatch.available, false, 'this row never dispatches')
  assert.equal(value.dispatch.reason, 'write-mode-disabled')
  assert.equal(value.audit.recorded, false, 'a read does not write an audit row')

  const pending = Object.fromEntries(value.pendingApprovals.map((card) => [card.approvalId, card]))
  assert.equal(pending[ids.pendingApproval].valid, true)
  assert.equal(pending[ids.pendingApproval].canDecide, true)
  assert.equal(pending[ids.pendingApproval].nonce, 'seed-nonce-pending', 'the card carries its exact binding value')
  assert.equal(pending[ids.pendingApproval].targetSessionId, 'seed-session-pending')
  assert.equal(pending[ids.expiredApproval].valid, false)
  assert.equal(pending[ids.expiredApproval].invalidReason, 'expired')
  assert.equal(pending[ids.movedApproval].valid, false)
  assert.equal(pending[ids.movedApproval].invalidReason, 'task-version-moved')
  assert.equal(pending[ids.stopApproval].valid, true)
  assert.equal(pending[ids.allowedApproval], undefined, 'an allowed approval is not pending work')

  const actions = Object.fromEntries(value.actions.map((action) => [action.actionId, action]))
  assert.equal(actions[ids.pendingAction].bucket, 'pending')
  assert.equal(actions[ids.pendingAction].outboxState, 'prepared')
  assert.equal(actions[ids.pendingAction].cancellable, true)
  assert.equal(actions[ids.deliveredAction].bucket, 'accepted')
  assert.equal(actions[ids.deliveredAction].cancellable, false)
  assert.equal(actions[ids.sendingAction].bucket, 'pending')
  assert.equal(actions[ids.sendingAction].outboxState, 'sending')
  assert.equal(actions[ids.sendingAction].cancellable, false)
  assert.equal(actions[ids.unknownAction].bucket, 'unknown')
  assert.deepEqual(value.unknownResults.map((action) => action.actionId), [ids.unknownAction])

  assert.equal(value.recovery.available, true)
  assert.equal(value.recovery.armed, true)
  assert.equal(value.recovery.pendingCount, 1)
  assert.equal(value.recovery.entries[0].messageId, seeded.messageId)
  assert.equal(value.recovery.entries[0].state, 'blocked')
  assert.equal(value.recovery.entries[0].releasable, true)
  assert.equal(value.recovery.bulkReleaseDefault, false)
  assert.equal(value.recovery.runtimeEnforcement.composed, true, 'the rc.2.1 agent/pre-step runtime gate is composed (E00-02 G04)')
  assert.equal(value.approvalCounts.pending, 4)
  assert.equal(value.approvalCounts.allowed, 1)
})

test('E04-03 approvals() returns every card with its binding; limits are explicit', async () => {
  const value = await control('approvals')
  assert.equal(value.available, true)
  assert.equal(value.total, 5, JSON.stringify(value.approvals.map((card) => card.approvalId)))
  const byId = Object.fromEntries(value.approvals.map((card) => [card.approvalId, card]))
  assert.equal(byId[ids.allowedApproval].status, 'allowed')
  assert.equal(byId[ids.allowedApproval].decision, 'allowed')
  assert.equal(typeof byId[ids.pendingApproval].nonce, 'string')
  assert.equal(value.limits.listMax, 100)
  const bounded = await control('approvals', { limit: 2 })
  assert.equal(bounded.approvals.length, 2)
  assert.equal(bounded.total, 5)
  assert.equal(bounded.truncated, true)
})

/* ── decideApproval: lands the human decision, never dispatches ──────── */

test('G05/04§08 approve lands exactly one allowed decision and touches no action/outbox', async () => {
  const before = (await control('approvals')).approvals.find((card) => card.approvalId === ids.pendingApproval)
  const body = await call('boopControl/decideApproval', {
    request: {
      approvalId: ids.pendingApproval,
      decision: 'approve',
      expected: {
        payloadHash: before.payloadHash,
        taskVersion: before.taskVersion,
        policyEpoch: before.policyEpoch,
        nonce: before.nonce,
      },
    },
  })
  assert.equal(body.result.ok, true, 'the transport call succeeds; the decision is the business fact')
  const value = body.result.value
  assert.equal(value.accepted, true, JSON.stringify(value))
  assert.equal(value.outcome, 'allowed')
  assert.equal(value.code, null)
  assert.equal(value.executed, false, 'approving is not executing')
  assert.equal(value.dispatched, false)
  assert.equal(value.approval.status, 'allowed')
  assert.ok(value.approval.consumedAt, 'the single-use CAS recorded its consumption')
  assert.equal(value.audit.recorded, true)
  assert.equal(value.audit.sink, 'ledger')
  assert.equal(value.audit.kind, 'control/approval-decided')

  const approvalRow = readRow('SELECT status, consumed_at FROM approval WHERE id = ?', ids.pendingApproval)
  assert.equal(approvalRow.status, 'allowed')
  assert.ok(approvalRow.consumed_at)
  const actionRow = readRow('SELECT state FROM action WHERE id = ?', ids.pendingAction)
  assert.equal(actionRow.state, 'awaiting_approval', 'approval is NOT dispatch: the action did not move')
  const outboxRow = readRow('SELECT state FROM command_outbox WHERE action_id = ?', ids.pendingAction)
  assert.equal(outboxRow.state, 'prepared', 'the outbox was not settled: nothing was sent')
  const auditRow = readRow("SELECT kind FROM audit_event WHERE kind = 'control/approval-decided' ORDER BY rowid DESC LIMIT 1")
  assert.ok(auditRow, 'the decision is durably audited in BOOP\'s own ledger')
})

test('E04-03 a repeated approval decision is already-handled, never re-allowed', async () => {
  const card = (await control('approvals')).approvals.find((entry) => entry.approvalId === ids.pendingApproval)
  const value = await control('decideApproval', {
    approvalId: ids.pendingApproval,
    decision: 'approve',
    expected: { payloadHash: card.payloadHash, taskVersion: card.taskVersion, policyEpoch: card.policyEpoch, nonce: card.nonce },
  })
  assert.equal(value.accepted, false)
  assert.equal(value.outcome, 'already-handled')
  assert.equal(value.idempotent, true)
  assert.equal(value.existingStatus, 'allowed')
  assert.equal(value.dispatched, false)
})

test('04§08 an expired card is APPROVAL_STALE (expired), persisted and never allowed', async () => {
  const card = (await control('approvals')).approvals.find((entry) => entry.approvalId === ids.expiredApproval)
  const value = await control('decideApproval', {
    approvalId: ids.expiredApproval,
    decision: 'approve',
    expected: { payloadHash: card.payloadHash, taskVersion: card.taskVersion, policyEpoch: card.policyEpoch, nonce: card.nonce },
  })
  assert.equal(value.accepted, false)
  assert.equal(value.outcome, 'stale')
  assert.equal(value.code, 'APPROVAL_STALE')
  assert.equal(value.staleCause, 'expired')
  assert.equal(value.markedInvalid, true)
  assert.equal(value.dispatched, false)
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.expiredApproval).status, 'expired')
  assert.ok(
    readRow("SELECT id FROM audit_event WHERE kind = 'control/approval-refused' ORDER BY rowid DESC LIMIT 1"),
    'the refused decision is audited',
  )
})

test('04§08 a task-version move invalidates ONLY that old card (no scope-wide damage)', async () => {
  const moved = (await control('approvals')).approvals.find((entry) => entry.approvalId === ids.movedApproval)
  const value = await control('decideApproval', {
    approvalId: ids.movedApproval,
    decision: 'approve',
    expected: {
      payloadHash: moved.payloadHash,
      taskVersion: moved.taskVersion,
      policyEpoch: moved.policyEpoch,
      nonce: moved.nonce,
    },
  })
  assert.equal(value.accepted, false)
  assert.equal(value.outcome, 'stale')
  assert.equal(value.staleCause, 'task-version-moved')
  assert.equal(value.markedInvalid, true)
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.movedApproval).status, 'stale')
  assert.equal(
    readRow('SELECT status FROM approval WHERE id = ?', ids.stopApproval).status,
    'pending',
    'an unrelated still-valid card must stay clickable',
  )
})

test('04§08 a forged binding is APPROVAL_STALE and does NOT invalidate the legitimate card', async () => {
  const card = (await control('approvals')).approvals.find((entry) => entry.approvalId === ids.stopApproval)
  const value = await control('decideApproval', {
    approvalId: ids.stopApproval,
    decision: 'approve',
    expected: { payloadHash: card.payloadHash, taskVersion: card.taskVersion, policyEpoch: card.policyEpoch, nonce: 'forged-nonce' },
  })
  assert.equal(value.accepted, false)
  assert.equal(value.code, 'APPROVAL_STALE')
  assert.equal(value.staleCause, 'nonce-mismatch')
  assert.equal(value.markedInvalid, false, 'a caller-side mismatch must not invalidate the ledger card')
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.stopApproval).status, 'pending')
})

/* ── deterministic stop ──────────────────────────────────────────────── */

test('G05/AT-30 stop task scope cancels BOOP pending work, settles its outbox and invalidates its card', async () => {
  const value = await control('stop', { scope: `task:${ids.stopTask}` })
  assert.equal(value.accepted, true, JSON.stringify(value).slice(0, 800))
  assert.equal(value.executed, true)
  assert.equal(value.matched, 1)
  assert.equal(value.deterministic, true)
  assert.equal(value.requiresModel, false)
  assert.deepEqual(value.requestedScope, { raw: `task:${ids.stopTask}`, kind: 'task', id: ids.stopTask })
  assert.equal(value.stopped.length, 1)
  assert.equal(value.stopped[0].actionId, ids.stopAction)
  assert.equal(value.stopped[0].actionState, 'stopped')
  assert.equal(value.stopped[0].outboxState, 'cancelled')
  assert.deepEqual(value.stopped[0].invalidatedApprovalIds, [ids.stopApproval])
  assert.equal(value.policy.userTurnsStopped, false)
  assert.equal(value.policy.externalSideEffectsUndone, false)
  assert.equal(readRow('SELECT state FROM action WHERE id = ?', ids.stopAction).state, 'stopped')
  assert.equal(readRow('SELECT state FROM command_outbox WHERE action_id = ?', ids.stopAction).state, 'cancelled')
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.stopApproval).status, 'rejected')
  assert.ok(readRow("SELECT id FROM audit_event WHERE kind = 'control/stop' ORDER BY rowid DESC LIMIT 1"))
})

test('G05/AT-30 stop session scope refuses delivered work and never stops a user turn', async () => {
  const delivered = await control('stop', { scope: `session:seed-session-delivered` })
  assert.equal(delivered.matched, 1)
  assert.deepEqual(delivered.stopped, [])
  assert.equal(delivered.refused.length, 1)
  assert.equal(delivered.refused[0].actionId, ids.deliveredAction)
  assert.equal(delivered.refused[0].code, 'ALREADY_DELIVERED')
  assert.equal(delivered.executed, false)
  assert.equal(readRow('SELECT state FROM action WHERE id = ?', ids.deliveredAction).state, 'running', 'delivered work is not "undone"')

  const noOwnedWork = await control('stop', { scope: 'session:a-user-only-session' })
  assert.equal(noOwnedWork.accepted, true)
  assert.equal(noOwnedWork.noop, true)
  assert.deepEqual(noOwnedWork.stopped, [])
  assert.match(noOwnedWork.message, /没有可停止的 BOOP 动作/)
  assert.equal(noOwnedWork.policy.foreignTurns, 'not-inspected-never-stopped')
})

test('AT-30 stop all reports honest per-object partial success on the real ledger', async () => {
  const value = await control('stop', { scope: 'all' })
  assert.equal(value.accepted, true)
  const stoppedIds = value.stopped.map((entry) => entry.actionId).sort()
  // Everything still undelivered at this point: the pending, the expired-card and
  // the version-moved actions are all cancellable BOOP bookkeeping.
  assert.deepEqual(stoppedIds, [ids.pendingAction, ids.expiredAction, ids.movedAction].sort())
  assert.deepEqual(
    value.refused.map((entry) => [entry.actionId, entry.code]).sort(),
    [
      [ids.deliveredAction, 'ALREADY_DELIVERED'],
      // Stopped by the previous test: terminal, so a second stop is honestly refused.
      [ids.stopAction, 'ALREADY_TERMINAL'],
    ],
  )
  assert.deepEqual(
    value.unknown.map((entry) => [entry.actionId, entry.code]).sort(),
    [
      [ids.sendingAction, 'DELIVERY_IN_FLIGHT'],
      [ids.unknownAction, 'OUTCOME_UNKNOWN'],
    ],
  )
  for (const actionId of stoppedIds) {
    assert.equal(readRow('SELECT state FROM action WHERE id = ?', actionId).state, 'stopped')
    assert.equal(readRow('SELECT state FROM command_outbox WHERE action_id = ?', actionId).state, 'cancelled')
  }
  assert.equal(value.executed, true)
  assert.equal(value.policy.externalSideEffectsUndone, false)
})

/* ── recovery + explicit release ─────────────────────────────────────── */

test('G04/AT-26 the recovery gate blocks the seeded command; release is explicit, audited and named', async () => {
  const recovery = await control('recovery')
  assert.equal(recovery.available, true)
  assert.equal(recovery.recovery.armed, true)
  assert.equal(recovery.recovery.pendingCount, 1)
  assert.equal(recovery.recovery.entries[0].messageId, seeded.messageId)
  assert.equal(recovery.recovery.entries[0].state, 'blocked')
  assert.equal(recovery.recovery.requiresExplicitSelection, true)
  assert.equal(recovery.recovery.bulkReleaseDefault, false)
  assert.equal(recovery.audit.recorded, false)

  // No explicit selection: refused, and the gate stays blocked.
  const empty = await control('release', {})
  assert.equal(empty.accepted, false)
  assert.equal(empty.code, 'INVALID_ARGUMENT')
  assert.deepEqual(empty.released, [])
  let gate = await poc('boop/pocGateStatus')
  assert.equal(gate.entries[0].state, 'blocked', 'an empty release must not treat "all" as selected')

  // Explicit ids: exactly the named one moves; unknown ids are reported.
  const released = await control('release', { messageIds: [seeded.messageId, 'unknown-message-id'] })
  assert.equal(released.accepted, true)
  assert.equal(released.released.length, 1)
  assert.equal(released.released[0].messageId, seeded.messageId)
  assert.equal(released.released[0].state, 'released')
  assert.deepEqual(released.ignored, [{ messageId: 'unknown-message-id', reason: 'unknown-message-id' }])
  assert.equal(released.audit.recorded, true)
  assert.equal(released.audit.kind, 'control/gate-released')
  assert.ok(readRow("SELECT id FROM audit_event WHERE kind = 'control/gate-released' ORDER BY rowid DESC LIMIT 1"))

  gate = await poc('boop/pocGateStatus')
  const entry = gate.entries.find((row) => row.messageId === seeded.messageId)
  assert.equal(entry.state, 'released', 'the real RecoveryGate entry is released')
})

/* ── authority / trust boundary ──────────────────────────────────────── */

test('G05 write mode is still false and the control plane never dispatched anything', async () => {
  const bootstrap = await call('boop/bootstrap')
  assert.equal(bootstrap.result.value.scope.writeModeEnabled, false)
  const state = await control('state')
  assert.equal(state.writeMode.enabled, false)
  assert.equal(state.dispatch.available, false)
  // No seeded outbox row was ever accepted by this plane: approvals and stop only
  // write bookkeeping. (`seed-act-delivered` was pre-seeded as accepted by the
  // fixture, not by the control plane.)
  const accepted = readRows(
    "SELECT action_id FROM command_outbox WHERE scope_id = ? AND state = 'accepted'",
    scopeId,
  ).map((row) => row.action_id)
  assert.deepEqual(accepted.sort(), [ids.deliveredAction], 'nothing new was delivered by decide/stop/release')
})

test('TB05/TB09 no verification/approval-run/dispatch endpoint exists on this row', async () => {
  for (const endpoint of ['boopControl/dispatch', 'boopControl/approve', 'boopControl/execute', 'boopControl/verification']) {
    const { status, body } = await rpc(base, cookie, endpoint, { request: {} })
    if (status === 200) {
      assert.equal(body.result.ok, false, `${endpoint} must not exist`)
    } else {
      assert.equal(status, 404, `${endpoint} must be an unknown endpoint (got ${status})`)
    }
  }
})

test('E04-03 every boopControl endpoint rejects anonymous callers', async () => {
  for (const endpoint of [
    'boopControl/state',
    'boopControl/approvals',
    'boopControl/decideApproval',
    'boopControl/stop',
    'boopControl/recovery',
    'boopControl/release',
  ]) {
    const response = await anonymousRequest(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'anon',
        method: endpoint,
        payload: { args: { request: {} } },
      }),
    })
    assert.ok([401, 403].includes(response.status), `${endpoint} anonymous -> ${response.status}`)
  }
})
