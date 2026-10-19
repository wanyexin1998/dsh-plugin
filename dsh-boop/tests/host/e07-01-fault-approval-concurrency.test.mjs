#!/usr/bin/env node
/**
 * E07-01 · fault injection 3/3 — concurrent / forged approval decisions.
 *
 * Scenario (real rc.2.1 `dsh web` payload, private `$DSH_HOME`):
 *  - TWO pending approval fixtures are seeded directly into
 *    `$DSH_HOME/boop/boop.sqlite` (disclosed below; the plugin has no seed
 *    endpoint), each bound to its own action/outbox row;
 *  - the SAME approval is decided TWICE concurrently with the exact binding the
 *    card shows: exactly one decision may consume it, the other must come back
 *    as an idempotent `already-handled` reply, the ledger must show exactly ONE
 *    decision audit row, and no action/outbox row may be dispatched;
 *  - forged bindings (wrong payloadHash / wrong nonce) must be refused as
 *    `APPROVAL_STALE` with the server's own `staleCause`, must NOT destroy the
 *    legitimate pending card, and a later correct decision must still succeed;
 *  - an unrelated user Session/turn is never touched and the deterministic Stop
 *    plane keeps refusing user turns.
 *
 * FIXTURE DISCLOSURE: task/task_revision/action/command_outbox/approval rows with
 * `e07-*` ids are INSERTed through `node:sqlite` after boot. The user's real
 * `~/.dsh` is never read or modified.
 *
 * Run: node --test --test-force-exit tests/host/e07-01-fault-approval-concurrency.test.mjs
 * Evidence: docs/development/evidence/e07-01/fault-approval-concurrency-<ts>.json
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, before, after } from 'node:test'
import {
  PROJECT_ROOT,
  authorize,
  bootWeb,
  createProfile,
  freePort,
  makeHome,
  rpc,
} from '../helpers/test-host.mjs'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e07-01-fault-approval-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop/boop.sqlite')
const PROFILE = 'boop-e07-fault-approval'
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e07-01')

const log = (...args) => console.log('  ', ...args)

let host = null
let base = null
let cookie = null
let scopeId = null
let userSession = null
let userHeadBefore = null
let evidence = null
const ids = {
  raceTask: 'e07-race-task',
  raceAction: 'e07-race-action',
  raceApproval: 'e07-race-approval',
  forgeTask: 'e07-forge-task',
  forgeAction: 'e07-forge-action',
  forgeApproval: 'e07-forge-approval',
}

async function call(endpoint, args = {}) {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 800)}`)
  return body
}

async function ok(endpoint, args = {}) {
  const body = await call(endpoint, args)
  assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result).slice(0, 1200)}`)
  return body.result.value
}

/** BOOP control Remote plane: one `request` arg, single-layer fact value. */
async function control(method, request) {
  const value = await ok(`boopControl/${method}`, request === undefined ? { request: {} } : { request })
  assert.equal(value.value, undefined, 'the control value is SINGLE-LAYER, never an {ok,value} envelope')
  return value
}

function readRow(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).get(...params)
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

function insertFixtureRows(db, { taskId, actionId, approvalId, payloadHash, nonce, goal }) {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  db.exec('PRAGMA foreign_keys = ON')
  db.prepare(
    'INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(taskId, scopeId, goal, 'active', 'not_requested', 1, '["可验证"]', '["不部署"]', null, now, now)
  db.prepare(
    'INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)',
  ).run(taskId, scopeId, 1, JSON.stringify({ goal }), null, now)
  db.prepare(
    'INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(actionId, scopeId, taskId, 1, `e07-target-${actionId}`, payloadHash, JSON.stringify({ instruction: 'fixture' }), 'awaiting_approval', null, null, 1, 'dsh:operator', now, now)
  db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run(actionId, scopeId, 'prepared', 0)
  db.prepare(
    'INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,consumed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(approvalId, scopeId, actionId, payloadHash, 1, 1, 'dsh-local-owner', nonce, expiresAt, null, 'pending')
}

function seedLedgerFixture() {
  const db = new DatabaseSync(LEDGER)
  try {
    const scope = db.prepare('SELECT scope_id FROM scopes LIMIT 1').get()
    assert.ok(scope, 'the BOOP ledger + scope row exist after boot')
    scopeId = String(scope.scope_id)
    insertFixtureRows(db, {
      taskId: ids.raceTask,
      actionId: ids.raceAction,
      approvalId: ids.raceApproval,
      payloadHash: 'e07-race-payload-hash',
      nonce: 'e07-race-nonce',
      goal: 'E07 concurrent approval race fixture',
    })
    insertFixtureRows(db, {
      taskId: ids.forgeTask,
      actionId: ids.forgeAction,
      approvalId: ids.forgeApproval,
      payloadHash: 'e07-forge-payload-hash',
      nonce: 'e07-forge-nonce',
      goal: 'E07 forged binding fixture',
    })
  } finally {
    db.close()
  }
}

async function card(approvalId) {
  const list = await control('approvals')
  const found = (list.approvals ?? []).find((entry) => entry.approvalId === approvalId)
  assert.ok(found, `approval ${approvalId} is projected by the Host`)
  return found
}

function decideRequest(approvalCard, overrides = {}) {
  return {
    approvalId: approvalCard.approvalId,
    decision: overrides.decision ?? 'approve',
    expected: {
      payloadHash: overrides.payloadHash ?? approvalCard.payloadHash,
      taskVersion: overrides.taskVersion ?? approvalCard.taskVersion,
      policyEpoch: overrides.policyEpoch ?? approvalCard.policyEpoch,
      nonce: overrides.nonce ?? approvalCard.nonce,
    },
  }
}

function writeEvidence() {
  if (evidence === null) return
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = path.join(EVIDENCE_DIR, `fault-approval-concurrency-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`  evidence written: ${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}`)
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), '- id: boop-api\n  config:\n    pocEnabled: true\n')
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)

  userSession = (await ok('session/create', { request: { cwd: WORK } })).sessionId
  userHeadBefore = (await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })).headSeq
  seedLedgerFixture()
})

after(async () => {
  if (host && host.child.exitCode === null) await host.stop()
  writeEvidence()
})

test('E07-01 two concurrent decisions consume exactly one approval (never twice)', async () => {
  const approvalCard = await card(ids.raceApproval)
  assert.equal(approvalCard.canDecide, true, JSON.stringify(approvalCard))
  const request = decideRequest(approvalCard)

  // Fire both decisions without awaiting in between: same object, same binding.
  const [first, second] = await Promise.all([
    control('decideApproval', request),
    control('decideApproval', request),
  ])
  const outcomes = [first, second]
  const accepted = outcomes.filter((value) => value.accepted === true)
  const refused = outcomes.filter((value) => value.accepted !== true)
  assert.equal(accepted.length, 1, `exactly one decision is accepted: ${JSON.stringify(outcomes.map((v) => [v.accepted, v.outcome, v.code]))}`)
  assert.equal(accepted[0].outcome, 'allowed', 'the accepted decision recorded an approval (not a dispatch)')
  assert.equal(accepted[0].executed, false, 'a decision never executes')
  assert.equal(accepted[0].dispatched, false, 'a decision never dispatches')
  assert.equal(refused.length, 1, 'the second concurrent decision was answered, not lost')
  assert.equal(refused[0].outcome, 'already-handled', `the second decision is idempotent, got ${refused[0].outcome}`)
  assert.equal(refused[0].idempotent, true)
  assert.equal(refused[0].existingStatus, 'allowed')
  assert.equal(refused[0].code, null)

  // Durable single-use CAS: one allowed row, consumed exactly once.
  const row = readRow('SELECT status, consumed_at FROM approval WHERE id = ?', ids.raceApproval)
  assert.equal(row.status, 'allowed')
  assert.ok(row.consumed_at, 'the single-use consumption timestamp is recorded once')
  const decisionAudits = readRows(
    "SELECT id, reason FROM audit_event WHERE kind = 'control/approval-decided' AND object_id = ?",
    ids.raceApproval,
  )
  assert.equal(decisionAudits.length, 1, `exactly ONE decision audit row, got ${decisionAudits.length}`)

  // The action/outbox are untouched: approving is not dispatching.
  assert.equal(readRow('SELECT state FROM action WHERE id = ?', ids.raceAction).state, 'awaiting_approval')
  assert.equal(readRow('SELECT state FROM command_outbox WHERE action_id = ?', ids.raceAction).state, 'prepared')
  log('race outcomes:', JSON.stringify(outcomes.map((value) => [value.accepted, value.outcome, value.idempotent, value.existingStatus])))
  evidence ??= { schemaVersion: 1, task: 'E07-01', scenario: 'approval-concurrency-and-forgery', capturedAt: new Date().toISOString(), host: { profile: PROFILE, dshHome: HOME, work: WORK } }
  evidence.race = {
    approvalId: ids.raceApproval,
    outcomes: outcomes.map((value) => ({ accepted: value.accepted, outcome: value.outcome, idempotent: value.idempotent, existingStatus: value.existingStatus, executed: value.executed, dispatched: value.dispatched })),
    durable: { status: row.status, consumedAt: row.consumed_at, decisionAuditRows: decisionAudits.length },
    actionUntouched: true,
    outboxUntouched: true,
  }
})

test('E07-01 a forged payloadHash/nonce is APPROVAL_STALE and does not destroy the legitimate card', async () => {
  const approvalCard = await card(ids.forgeApproval)
  assert.equal(approvalCard.canDecide, true)

  const forgedHash = await control(
    'decideApproval',
    decideRequest(approvalCard, { payloadHash: 'forged-payload-hash' }),
  )
  assert.equal(forgedHash.accepted, false, JSON.stringify(forgedHash).slice(0, 900))
  assert.equal(forgedHash.code, 'APPROVAL_STALE')
  assert.equal(forgedHash.outcome, 'stale')
  assert.equal(forgedHash.staleCause, 'payload-changed', `staleCause names the caller mismatch (got ${forgedHash.staleCause})`)
  assert.equal(forgedHash.markedInvalid, false, 'a caller-side mismatch never invalidates the ledger card')
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.forgeApproval).status, 'pending')

  const forgedNonce = await control(
    'decideApproval',
    decideRequest(approvalCard, { nonce: 'forged-nonce' }),
  )
  assert.equal(forgedNonce.accepted, false)
  assert.equal(forgedNonce.code, 'APPROVAL_STALE')
  assert.equal(forgedNonce.staleCause, 'nonce-mismatch')
  assert.equal(forgedNonce.markedInvalid, false)
  assert.equal(readRow('SELECT status FROM approval WHERE id = ?', ids.forgeApproval).status, 'pending')
  assert.ok(
    readRows(
      "SELECT id FROM audit_event WHERE kind = 'control/approval-refused' AND object_id = ?",
      ids.forgeApproval,
    ).length >= 2,
    'each refused forged decision is audited',
  )

  // The legitimate card still works after the forged attempts.
  const legitimate = await control('decideApproval', decideRequest(approvalCard))
  assert.equal(legitimate.accepted, true, JSON.stringify(legitimate).slice(0, 900))
  assert.equal(legitimate.outcome, 'allowed')
  assert.equal(legitimate.executed, false)
  assert.equal(legitimate.dispatched, false)
  const row = readRow('SELECT status, consumed_at FROM approval WHERE id = ?', ids.forgeApproval)
  assert.equal(row.status, 'allowed')
  assert.ok(row.consumed_at)
  evidence.forgery = {
    approvalId: ids.forgeApproval,
    forgedPayloadHash: { accepted: forgedHash.accepted, code: forgedHash.code, staleCause: forgedHash.staleCause, markedInvalid: forgedHash.markedInvalid },
    forgedNonce: { accepted: forgedNonce.accepted, code: forgedNonce.code, staleCause: forgedNonce.staleCause, markedInvalid: forgedNonce.markedInvalid },
    legitimateAfterForgeries: { accepted: legitimate.accepted, outcome: legitimate.outcome, status: row.status, consumedAt: row.consumed_at },
  }
})

test('E07-01 the decision plane never dispatches and write mode stays false (G05/TB09)', async () => {
  const bootstrap = await ok('boop/bootstrap')
  assert.equal(bootstrap.scope?.writeModeEnabled, false, 'write mode stays false')
  const controlState = await control('state')
  assert.equal(controlState.writeMode.enabled, false)
  assert.equal(controlState.dispatch.available, false, 'the control plane itself never dispatches')
  assert.equal(controlState.dispatch.requiresModel, true)

  // No row on this data domain was ever delivered by decideApproval.
  const acceptedOutbox = readRows(
    "SELECT action_id FROM command_outbox WHERE scope_id = ? AND state = 'accepted'",
    scopeId,
  )
  assert.deepEqual(acceptedOutbox, [], 'decideApproval wrote no accepted outbox row')
  const actions = readRows('SELECT id, state FROM action WHERE scope_id = ?', scopeId)
  for (const action of actions) {
    assert.equal(action.state, 'awaiting_approval', `action ${action.id} is still awaiting approval, not dispatched`)
  }
  log('actions after decisions:', JSON.stringify(actions))
})

test('E07-01 concurrent/forged decisions never stop or touch an unrelated user Session', async () => {
  const user = await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })
  assert.equal(user.available, true, 'the user Session is readable')
  assert.equal(user.headSeq, userHeadBefore, 'the approval fault injection appended nothing to the user Session')
  assert.deepEqual((user.events ?? []).filter((event) => event.type === 'turn/start'), [])

  const stopped = await control('stop', { scope: `session:${userSession}` })
  assert.equal(stopped.accepted, true)
  assert.deepEqual(stopped.stopped, [], 'no user turn is stopped by the deterministic Stop plane')
  assert.equal(stopped.policy.userTurnsStopped, false)
  assert.equal(stopped.policy.foreignTurns, 'not-inspected-never-stopped')

  evidence.userSession = {
    sessionId: userSession,
    headBefore: userHeadBefore,
    headAfter: user.headSeq,
    stoppedByControl: stopped.stopped.length,
    userTurnsStopped: stopped.policy.userTurnsStopped,
  }
  evidence.knownUnknown = {
    auditSingleRow: 'the ledger holds exactly one control/approval-decided row for the raced approval; the losing concurrent call is answered idempotently and audited separately (not as a second decision)',
    staleCauses: 'payload-changed / nonce-mismatch are the Host taxonomy values asserted above',
    runtimePreStepEnforcement: 'not part of the approval decision plane; see E07-01 report NOT_RUN',
  }
})
