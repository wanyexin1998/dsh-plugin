#!/usr/bin/env node
/**
 * E02-03 / G03 closure · AT-13 duplicate & disconnect reconciliation on a real Host.
 *
 * What this file proves (real rc.2.1 `dsh web` payload, private `$DSH_HOME`):
 *  1. a ledger-backed dispatch goes through the REAL `Dispatcher` and the REAL
 *     Agent (`pocReconcile` is PoC-only; `pocEnabled` defaults to false);
 *  2. a repeated dispatch of the SAME action id is a `duplicate` — the transport
 *     is not called again and no second message is inserted/claimed;
 *  3. the exact crash window "transport accepted, ledger not yet settled" (the
 *     SQLite ledger row is rewritten to `dispatching/sending`, disclosed fixture;
 *     the real Session log is the real delivery evidence) is reconciled after a
 *     REAL SIGKILL + restart: durable `user/message`/`inbox splice` evidence
 *     lands `accepted`; repeated reconciliation is idempotent (no second audit);
 *     a new process still dedupes on the ledger, never on a process-local registry;
 *  4. a genuinely lost send (`outcome_unknown` with NO durable trace) is only
 *     classified `not-delivered` after a CLEAN restart attestation; it is NOT
 *     auto-retried, and an explicit retry reuses the SAME action/message id;
 *  5. tri-state honesty: absence without the clean-restart attestation, or an
 *     unreadable/missing target Session, stays `indeterminate` and unchanged.
 *
 * Env-gated (real model evidence): `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL`
 * (+ placeholder `BOOP_QWEN_KEY`). Without them the model-turn cases SKIP; the
 * host/ledger/reconciliation cases still run. Never a fake PASS.
 *
 * FIXTURE DISCLOSURE: BOOP has no production seed endpoint. Task/action/outbox
 * rows are seeded by this test through a direct `node:sqlite` connection to
 * `$DSH_HOME/boop/boop.sqlite` (the plugin itself writes only through the real
 * Dispatcher/repository). Only the crash-window LEDGER rows are rewritten by the
 * test; the durable Session log is always the real Agent's own record.
 *
 * Run: node --test --test-concurrency=1 --test-force-exit tests/host/e02-03-idempotency-in-host.test.mjs
 * Evidence: docs/development/evidence/e02-03/idempotency-<ts>.json
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
  hostFacts,
  makeHome,
  rpc,
} from '../helpers/test-host.mjs'
import { newActionId, payloadHash, PROXY_SOURCE_KIND } from '../../src/host/transport/command-envelope.ts'

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''
const SKIP = ENABLED
  ? false
  : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real-model claim/reply cases (never faked)'
const KEY_ENV = 'BOOP_QWEN_KEY'
const KEY_PLACEHOLDER = 'boop-local-placeholder-not-a-secret'
const INSTRUCTION = '只回复 BOOP-OK 这 7 个字符，不要调用任何工具，不要解释，不要加标点。'
const TURN_TIMEOUT_MS = 90_000
/** Writer-lease TTL is 15s; after an unclean kill wait for it to expire. */
const LEASE_AFTER_KILL_MS = 17_000
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e02-03')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/g03-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const PROJECT = path.join(WORK, 'project')
const PROFILE = 'boop-g03'

let host = null
let base = null
let cookie = null
let sessionId = null
let userSession = null
let scopeId = null
let fixtureCounter = 0
const evidence = {
  schemaVersion: 1,
  task: 'E02-03/G03',
  scenario: 'at-13-duplicate-disconnect-reconciliation',
  capturedAt: null,
  env: {
    modelConfigured: ENABLED,
    modelId: ENABLED ? MODEL_ID : null,
    baseUrl: ENABLED ? BASE_URL : null,
    node: process.version,
  },
  host: null,
  ledger: { scopeId: null, schemaVersion: null },
  sessions: { dispatchTarget: null, untouchedUserSession: null },
  scenarios: {},
  knownUnknown: {
    hostCrossProcessDedupe:
      'NOT_RUN: the DSH host has no durable cross-turn dedupe by message id; BOOP dedupe is the dispatcher/ledger layer (tested here). A non-BOOP direct injection of a duplicate id is outside BOOP control.',
    uncleanCrashTailLoss:
      'NOT_RUN by design: an unclean SIGKILL can lose an unflushed durable tail (E07-01 evidence); therefore "no trace" is only accepted as not-delivered with an explicit clean-restart attestation.',
    preStepRuntimeGate:
      'COVERED, not bypassed: the G04 `boop-gate` row composes the real rc.2.1 agent/pre-step waterfall in this bundle. The PoC reconcile harness tracks and explicitly releases each dispatched message id (the same operator act the real planned-command flow performs); unreleased/untracked BOOP commands still fail closed. Gate entries are process-local and not durable across a restart.',
  },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('  ', ...args)

/* ── RPC helpers ─────────────────────────────────────────────────────── */

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

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await predicate()
    if (last?.done === true) return last.value
    await sleep(250)
  }
  assert.fail(`${label} did not happen within ${timeoutMs}ms (last: ${JSON.stringify(last)})`)
}

/** One call of the PoC-only reconcile harness (single-layer value). */
const reconcile = (request) => ok('boop/pocReconcile', { request })

/* ── direct-SQLite fixture helpers (disclosed above) ─────────────────── */

function withLedger(fn) {
  const db = new DatabaseSync(LEDGER)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    return fn(db)
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

function readRow(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).get(...params) ?? null
  } finally {
    db.close()
  }
}

function readScope() {
  const row = readRow('SELECT scope_id, schema_version FROM scopes LIMIT 1')
  assert.ok(row, 'the BOOP ledger + scope row exist after boot')
  const meta = readRow("SELECT value FROM meta WHERE key = 'schema_version'")
  return { scopeId: String(row.scope_id), schemaVersion: Number(meta?.value ?? row.schema_version) }
}

/** Seed ONE active task + one action + its outbox row (fixture, disclosed). */
function seedFixture({ tag, actionState = 'planned', outboxState = 'prepared', targetSession = null, instruction = INSTRUCTION }) {
  fixtureCounter += 1
  const taskId = `g03-task-${fixtureCounter}-${tag}`
  const actionId = newActionId()
  const target = targetSession ?? sessionId
  const hash = payloadHash({ taskId, taskVersion: 1, targetSessionId: target, instruction, mode: 'queue' })
  const now = new Date().toISOString()
  withLedger((db) => {
    db.prepare(
      'INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(taskId, scopeId, `G03 fixture ${tag}`, 'active', 'not_requested', 1, '["可验证"]', '["不部署"]', null, now, now)
    db.prepare(
      'INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)',
    ).run(taskId, scopeId, 1, JSON.stringify({ goal: `G03 fixture ${tag}`, criteria: ['可验证'] }), null, now)
    db.prepare(
      'INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      actionId,
      scopeId,
      taskId,
      1,
      target,
      hash,
      JSON.stringify({ instruction, mode: 'queue' }),
      actionState,
      null,
      null,
      1,
      'dsh:operator',
      now,
      now,
    )
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run(
      actionId,
      scopeId,
      outboxState,
      0,
    )
  })
  return { actionId, taskId, targetSessionId: target, payloadHash: hash, instruction }
}

/** Rewrite the ledger windows the test needs (fixture; disclosed in the header). */
function setWindow(actionId, { actionState, outboxState, messageId = null }) {
  const now = new Date().toISOString()
  withLedger((db) => {
    db.prepare('UPDATE action SET state = ?, message_id = ?, updated_at = ? WHERE id = ?').run(
      actionState,
      messageId,
      now,
      actionId,
    )
    db.prepare('UPDATE command_outbox SET state = ?, lease_until = NULL WHERE action_id = ?').run(outboxState, actionId)
  })
}

function ledgerAction(actionId) {
  return readRow('SELECT id, state, message_id, target_session_id FROM action WHERE scope_id = ? AND id = ?', scopeId, actionId)
}

function ledgerOutbox(actionId) {
  return readRow('SELECT state, attempt FROM command_outbox WHERE scope_id = ? AND action_id = ?', scopeId, actionId)
}

function auditCount(kind) {
  const row = readRow('SELECT count(*) c FROM audit_event WHERE scope_id = ? AND kind = ?', scopeId, kind)
  return Number(row?.c ?? 0)
}

function auditReasons(kind) {
  return readRows('SELECT reason FROM audit_event WHERE scope_id = ? AND kind = ?', scopeId, kind).map((row) =>
    String(row.reason ?? ''),
  )
}

/* ── durable Session record helpers ──────────────────────────────────── */

const record = (target = sessionId) => ok('boop/pocSessionRecord', { sessionId: target, tailEvents: 400 })
const claims = (target = sessionId) => ok('boop/pocClaimFeed', { sessionId: target })

function spliceInserts(rec, messageId) {
  return (rec.events ?? []).filter(
    (event) => event.type === 'agent/inbox/spliced' && (event.insertedIds ?? []).includes(messageId),
  )
}

function userMessages(rec, messageId) {
  return (rec.userMessages ?? []).filter((event) => event.messageId === messageId)
}

async function waitDelivered(messageId, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const rec = await record()
      const splice = spliceInserts(rec, messageId)
      const user = userMessages(rec, messageId)
      return {
        done: splice.length >= 1 || user.length >= 1,
        value: { record: rec, splice: splice.length, user: user.length },
      }
    },
    timeoutMs,
    `durable delivery evidence for ${messageId}`,
  )
}

async function waitForTurnCoverage(messageId, timeoutMs = TURN_TIMEOUT_MS) {
  return waitFor(
    async () => {
      const rec = await record()
      const feed = await claims()
      const ownClaims = (feed.claims ?? []).filter((claim) => claim.messageId === messageId)
      const ownUser = userMessages(rec, messageId)
      // A turn that belongs to THIS claim only: earlier turns in the same Session
      // must not satisfy the wait.
      const claimTurn = ownClaims[0]?.turn ?? null
      const answered = (rec.assistant ?? []).some(
        (event) => claimTurn === null || event.turn === claimTurn || event.seq > (ownUser[0]?.seq ?? Number.MAX_SAFE_INTEGER),
      )
      const ended = (rec.turnEnds ?? []).some(
        (end) => end.turnEnd === 'completed' && (claimTurn === null || end.turn === claimTurn),
      )
      const drained = rec.inbox !== null && rec.inbox.nextTurn.length === 0 && rec.inbox.nextStep.length === 0
      return {
        done: ownClaims.length === 1 && ownUser.length === 1 && answered && ended && drained,
        value: { record: rec, claims: feed, ownClaims, ownUser },
      }
    },
    timeoutMs,
    `real turn coverage for ${messageId}`,
  )
}

/* ── host lifecycle helpers ──────────────────────────────────────────── */

function profilePatch() {
  const base = '- id: boop-api\n  config:\n    pocEnabled: true\n'
  if (!ENABLED) return base
  return `${base}
- id: llm-pi-ai
  config:
    providers:
      qwen-local:
        displayName: Qwen local (vLLM)
        api: openai-completions
        baseURL: ${BASE_URL}
        apiKeyEnv: ${KEY_ENV}
        models:
          - id: ${MODEL_ID}
            name: Qwen 3.8 27B (self-hosted vLLM)
            contextWindow: 196608
- id: agent-default-model
  config:
    provider: qwen-local
    model: ${MODEL_ID}
`
}

async function bootHost() {
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)
  const bootstrap = await ok('boop/bootstrap')
  return bootstrap
}

async function killHard() {
  const child = host.child
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const accepted = child.kill('SIGKILL')
  const result = await exited
  return { accepted, ...result }
}

/** Restart the SAME DSH_HOME after an unclean kill, waiting out the writer lease. */
async function bootAfterCrash() {
  await sleep(LEASE_AFTER_KILL_MS)
  let last = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const bootstrap = await bootHost()
    last = bootstrap
    if (bootstrap.storage?.ok === true) return bootstrap
    // The stale lease row has not expired yet: stop this read-only instance and wait.
    log(`writer lease not acquired on attempt ${attempt}; waiting 6s and rebooting`)
    await host.stop()
    await sleep(6_000)
  }
  assert.fail(`the restarted Host never acquired the writer lease: ${JSON.stringify(last?.storage)}`)
}

/* ── evidence artifact ───────────────────────────────────────────────── */

function writeEvidence() {
  evidence.capturedAt = new Date().toISOString()
  evidence.host = hostFacts()
  evidence.ledger.scopeId = scopeId
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = path.join(EVIDENCE_DIR, `idempotency-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
  log(`evidence written: ${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}`)
}

/* ── setup / teardown ────────────────────────────────────────────────── */

before(async () => {
  process.env[KEY_ENV] = process.env[KEY_ENV] || KEY_PLACEHOLDER
  fs.mkdirSync(WORK, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), profilePatch())
  const bootstrap = await bootHost()
  assert.equal(bootstrap.scope.writeModeEnabled, true, 'write mode is driven by the gate ledger')
  const dispatchSession = await ok('session/create', { request: { cwd: PROJECT } })
  sessionId = dispatchSession.sessionId
  const user = await ok('session/create', { request: { cwd: PROJECT } })
  userSession = user.sessionId
  const ledger = readScope()
  scopeId = ledger.scopeId
  evidence.ledger.schemaVersion = ledger.schemaVersion
  evidence.sessions.dispatchTarget = sessionId
  evidence.sessions.untouchedUserSession = userSession
  await ok('boop/pocClaimFeed', { sessionId, clear: true })
})

after(async () => {
  try {
    if (host && host.child.exitCode === null) await host.stop()
  } catch {
    /* the process may already be dead from a SIGKILL scenario */
  }
  try {
    writeEvidence()
  } catch (error) {
    console.error('  evidence write failed:', error)
  }
})

/* ── 1. harness armed ────────────────────────────────────────────────── */

test('G03 the PoC reconcile harness is armed on the real Host with a writable ledger', async () => {
  const facts = await reconcile({})
  assert.equal(facts.available, true, JSON.stringify(facts))
  assert.equal(facts.scopeId, scopeId)
  assert.equal(facts.ledgerWritable, true, 'the Host owns the single-writer lease')
  assert.equal(facts.cleanRestart, false)
  assert.ok(facts.boot !== null && typeof facts.boot.readyToRetry === 'number')
  assert.deepEqual(facts.boot.unknown, [], 'a fresh ledger has no unknown action')
  const bootstrap = await ok('boop/bootstrap')
  assert.equal(bootstrap.scope.writeModeEnabled, true, 'reconciliation does not close the gate-derived write mode')
  assert.equal(bootstrap.storage?.ok, true)
  // The G04 pre-step gate row is composed in this bundle; the PoC dispatch harness
  // must pass THROUGH it (explicit release), never around it.
  const gate = await ok('boopGate/status')
  assert.equal(gate.registered, true, 'the agent/pre-step waterfall listener is registered')
  assert.equal(gate.runtimeEnforcement.composed, true)
  assert.equal(gate.armed, true)
  evidence.scenarios.harness = {
    available: facts.available,
    ledgerWritable: facts.ledgerWritable,
    preStepGate: { registered: gate.registered, armed: gate.armed, composed: gate.runtimeEnforcement.composed },
  }
})

/* ── 2. normal path + duplicate dispatch (no new id) ─────────────────── */

test('AT-13 a ledger-backed dispatch is accepted once; repeating the same action id is a duplicate', async () => {
  if (ENABLED) await ok('boop/pocResolveAgent', { sessionId })
  const fixture = seedFixture({ tag: 'normal' })
  const first = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(first.dispatch?.kind, 'accepted', JSON.stringify(first.dispatch))
  assert.equal(first.dispatch.actionId, fixture.actionId)
  assert.equal(first.dispatch.messageId, fixture.actionId, 'the message id IS the action id (no new id)')
  assert.equal(first.report?.results?.[0]?.verdict, 'accepted')
  const delivered = await waitDelivered(fixture.actionId)
  assert.equal(delivered.splice, 1, 'exactly one durable inbox insert for this id')
  assert.ok(delivered.user <= 1)

  const duplicate = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(duplicate.dispatch?.kind, 'duplicate', JSON.stringify(duplicate.dispatch))
  assert.equal(duplicate.dispatch.reason, 'ALREADY_ACCEPTED')
  assert.equal(duplicate.dispatch.messageId, fixture.actionId)
  await sleep(1500)
  const afterDuplicate = await record()
  assert.equal(spliceInserts(afterDuplicate, fixture.actionId).length, 1, 'no second inbox insert')
  assert.ok(userMessages(afterDuplicate, fixture.actionId).length <= 1, 'no second execution record')

  const action = ledgerAction(fixture.actionId)
  assert.equal(action.state, 'accepted')
  assert.equal(action.message_id, fixture.actionId)
  assert.equal(ledgerOutbox(fixture.actionId).state, 'accepted')

  evidence.scenarios.normalPath = {
    actionId: fixture.actionId,
    firstDispatch: first.dispatch,
    duplicateDispatch: duplicate.dispatch,
    durable: {
      spliceInserts: spliceInserts(afterDuplicate, fixture.actionId).length,
      userMessages: userMessages(afterDuplicate, fixture.actionId).map((event) => event.seq),
    },
    ledger: { actionState: action.state, messageId: action.message_id, outboxState: ledgerOutbox(fixture.actionId).state },
  }
})

/* ── 3. crash window: delivered, ledger not settled → SIGKILL → reconcile ── */

test('AT-13 delivered-but-unsettled survives a real SIGKILL: durable evidence lands accepted, twice is idempotent', async () => {
  if (ENABLED) await ok('boop/pocResolveAgent', { sessionId })
  const fixture = seedFixture({ tag: 'crash-delivered' })
  const first = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(first.dispatch?.kind, 'accepted', JSON.stringify(first.dispatch))
  const delivered = await waitDelivered(fixture.actionId)
  assert.ok(delivered.splice >= 1 || delivered.user >= 1, 'the durable log holds the delivery before the kill')

  // Simulate the crash window: the transport accepted, the ledger never settled
  // (fixture rewrite; the DURABLE log above is the real Agent evidence).
  setWindow(fixture.actionId, { actionState: 'dispatching', outboxState: 'sending' })
  assert.equal(ledgerAction(fixture.actionId).state, 'dispatching')
  assert.equal(ledgerOutbox(fixture.actionId).state, 'sending')
  const beforeKill = await record()

  const killed = await killHard()
  assert.equal(killed.signal, 'SIGKILL', 'the Host was force-killed, not asked to stop')
  const bootstrap = await bootAfterCrash()
  assert.equal(bootstrap.storage?.ok, true, 'the restarted Host acquired the writer lease after the TTL')
  assert.equal(bootstrap.storage?.scope?.scopeId, scopeId, 'the same data domain restarted')
  assert.equal((await ok('boop/pocGateStatus')).adoptedMessageIds.length, 0, 'no process-local id registry survived')

  const boot = await reconcile({ actionId: fixture.actionId, cleanRestart: false })
  assert.ok(boot.boot.unknown.includes(fixture.actionId), 'the crashed sending row is now outcome_unknown')
  const verdict = boot.report.results[0]
  assert.equal(verdict.verdict, 'accepted', JSON.stringify(verdict))
  assert.equal(verdict.changed, true)
  assert.equal(verdict.messageId, fixture.actionId)
  assert.ok(
    ['durable-claimed', 'durable-inbox-splice', 'inbox-pending'].includes(verdict.evidence.kind),
    `durable positive evidence expected, got ${verdict.evidence.kind}`,
  )
  const action = ledgerAction(fixture.actionId)
  assert.equal(action.state, 'accepted')
  assert.equal(action.message_id, fixture.actionId, 'the reconciled message id is the SAME id')
  assert.equal(ledgerOutbox(fixture.actionId).state, 'accepted')
  assert.equal(auditCount('dispatch/reconciled-delivered'), 1, 'the determination is audited exactly once')

  const repeat = await reconcile({ actionId: fixture.actionId, cleanRestart: false })
  assert.equal(repeat.report.results[0].verdict, 'accepted')
  assert.equal(repeat.report.results[0].changed, false, 'a repeated reconciliation changes nothing')
  assert.equal(repeat.report.idempotent, true)
  assert.equal(auditCount('dispatch/reconciled-delivered'), 1, 'no second audit row')

  // A NEW process dedupes from the ledger, never from a process-local id set.
  const duplicate = await reconcile({ actionId: fixture.actionId, retry: true })
  assert.equal(duplicate.dispatch?.kind, 'duplicate', JSON.stringify(duplicate.dispatch))
  assert.equal(duplicate.dispatch.reason, 'ALREADY_ACCEPTED')

  const afterRestart = await record()
  assert.equal(spliceInserts(afterRestart, fixture.actionId).length, 1, 'still exactly one durable inbox insert')
  assert.ok(userMessages(afterRestart, fixture.actionId).length <= 1, 'at most one executed message record')
  for (const claim of (await claims()).claims ?? []) {
    assert.notEqual(claim.messageId, fixture.actionId, 'the new process reclaimed nothing')
  }
  const frozenHead = afterRestart.headSeq
  await sleep(2500)
  assert.equal((await record()).headSeq, frozenHead, 'nothing re-executed automatically after the restart')

  evidence.scenarios.crashDelivered = {
    actionId: fixture.actionId,
    kill: killed,
    preKillHead: beforeKill.headSeq,
    restart: { storageOk: bootstrap.storage?.ok, scopeId: bootstrap.storage?.scope?.scopeId, schemaVersion: bootstrap.storage?.schemaVersion },
    bootUnknown: boot.boot.unknown,
    reconcile: verdict,
    repeated: { verdict: repeat.report.results[0].verdict, changed: repeat.report.results[0].changed, idempotent: repeat.report.idempotent },
    crossProcessDuplicate: duplicate.dispatch,
    durable: {
      spliceInserts: spliceInserts(afterRestart, fixture.actionId).length,
      userMessages: userMessages(afterRestart, fixture.actionId).map((event) => ({ seq: event.seq, sourceKind: event.sourceKind })),
      headAfterRestart: afterRestart.headSeq,
    },
    audit: auditReasons('dispatch/reconciled-delivered'),
  }
})

/* ── 4. lost send: not-delivered only with clean-restart proof, never auto-retried ── */

test('AT-13 a lost send is not-delivered only after a clean restart, and an explicit retry keeps the SAME id', async () => {
  if (ENABLED) await ok('boop/pocResolveAgent', { sessionId })
  const fixture = seedFixture({ tag: 'lost-send' })
  // Ledger says the send was attempted; the durable log will prove it never
  // arrived (this window is the fixture's honest simulation of a lost attempt).
  setWindow(fixture.actionId, { actionState: 'outcome_unknown', outboxState: 'unknown' })

  const before = await record()
  assert.equal(spliceInserts(before, fixture.actionId).length, 0)
  assert.equal(userMessages(before, fixture.actionId).length, 0)

  const determined = await reconcile({ actionId: fixture.actionId, cleanRestart: true })
  const verdict = determined.report.results[0]
  assert.equal(verdict.verdict, 'not-delivered', JSON.stringify(verdict))
  assert.equal(verdict.changed, true)
  assert.equal(verdict.reason, 'no-durable-trace-after-clean-restart')
  assert.equal(ledgerAction(fixture.actionId).state, 'planned', 'back to a visible planned state')
  assert.equal(ledgerOutbox(fixture.actionId).state, 'blocked')
  assert.equal(auditCount('dispatch/reconciled-not-delivered'), 1)

  const repeated = await reconcile({ actionId: fixture.actionId, cleanRestart: true })
  assert.equal(repeated.report.results[0].verdict, 'not-delivered')
  assert.equal(repeated.report.results[0].changed, false)
  assert.equal(auditCount('dispatch/reconciled-not-delivered'), 1, 'no second audit row')
  // NOT auto-retried: still no durable trace, and the outbox was not claimed.
  const afterReconcile = await record()
  assert.equal(spliceInserts(afterReconcile, fixture.actionId).length, 0, 'reconciliation performed no automatic retry')
  assert.equal(userMessages(afterReconcile, fixture.actionId).length, 0)

  // Explicit operator retry: the SAME action id becomes the message id.
  const retried = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(retried.dispatch?.kind, 'accepted', JSON.stringify(retried.dispatch))
  assert.equal(retried.dispatch.actionId, fixture.actionId)
  assert.equal(retried.dispatch.messageId, fixture.actionId, 'an explicit retry NEVER mints a new id')
  const delivered = await waitDelivered(fixture.actionId)
  assert.equal(delivered.splice, 1, 'exactly one durable inbox insert after the explicit retry')
  const ledger = ledgerAction(fixture.actionId)
  assert.equal(ledger.state, 'accepted')
  assert.equal(ledger.message_id, fixture.actionId)

  evidence.scenarios.lostSend = {
    actionId: fixture.actionId,
    determined: verdict,
    repeated: { verdict: repeated.report.results[0].verdict, changed: repeated.report.results[0].changed },
    explicitRetry: retried.dispatch,
    durable: { spliceInserts: spliceInserts(await record(), fixture.actionId).length },
    neverAutoRetried: true,
  }
})

/* ── 5. tri-state honesty: indeterminate stays unknown and unchanged ──── */

test('G03 tri-state: absence without clean-restart proof, and a missing target Session, stay indeterminate', async () => {
  const unattested = seedFixture({ tag: 'no-attestation' })
  setWindow(unattested.actionId, { actionState: 'outcome_unknown', outboxState: 'unknown' })
  const undetermined = await reconcile({ actionId: unattested.actionId, cleanRestart: false })
  const undeterminedVerdict = undetermined.report.results[0]
  assert.equal(undeterminedVerdict.verdict, 'indeterminate', JSON.stringify(undeterminedVerdict))
  assert.equal(undeterminedVerdict.changed, false)
  assert.match(undeterminedVerdict.reason, /clean-restart-not-attested/)
  assert.equal(ledgerAction(unattested.actionId).state, 'outcome_unknown', 'no write without proof')
  assert.equal(ledgerOutbox(unattested.actionId).state, 'unknown')

  // The SAME absence becomes not-delivered only when the clean restart is attested.
  const attested = await reconcile({ actionId: unattested.actionId, cleanRestart: true })
  assert.equal(attested.report.results[0].verdict, 'not-delivered')
  assert.equal(attested.report.results[0].changed, true)
  assert.equal(ledgerAction(unattested.actionId).state, 'planned')

  const missing = seedFixture({ tag: 'missing-session', targetSession: `no-such-session-${Date.now()}` })
  setWindow(missing.actionId, { actionState: 'outcome_unknown', outboxState: 'unknown' })
  const missingVerdict = (await reconcile({ actionId: missing.actionId, cleanRestart: true })).report.results[0]
  assert.equal(missingVerdict.verdict, 'indeterminate', JSON.stringify(missingVerdict))
  assert.equal(missingVerdict.changed, false)
  assert.equal(ledgerAction(missing.actionId).state, 'outcome_unknown', 'a missing Session proves nothing')
  assert.equal(ledgerOutbox(missing.actionId).state, 'unknown')
  assert.equal(userMessages(await record(userSession), missing.actionId).length, 0, 'the user Session is untouched')

  evidence.scenarios.triState = {
    unattested: undeterminedVerdict,
    attested: attested.report.results[0],
    missingSession: missingVerdict,
  }
})

/* ── 6. real model: claim once, reply once, duplicate never executes ──── */

test('AT-13 real model: one claim, one durable user/message, and a duplicate dispatch never executes twice', { skip: SKIP }, async () => {
  const fixture = seedFixture({ tag: 'real-turn' })
  const dispatched = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(dispatched.dispatch?.kind, 'accepted', JSON.stringify(dispatched.dispatch))
  const settled = await waitForTurnCoverage(fixture.actionId)
  const ownClaim = settled.ownClaims
  assert.equal(ownClaim.length, 1, 'exactly one runtime claim for the dispatched id')
  assert.equal(ownClaim[0].sourceKind, PROXY_SOURCE_KIND)
  assert.equal(ownClaim[0].actionId, fixture.actionId)
  assert.equal(settled.ownUser.length, 1, 'exactly one durable user/message')
  assert.equal(settled.ownUser[0].sourceKind, PROXY_SOURCE_KIND)
  assert.equal(settled.ownUser[0].actionId, fixture.actionId)
  const claimTurn = ownClaim[0].turn
  const reply = (settled.record.assistant ?? []).filter((event) => event.turn === claimTurn).at(-1)
  assert.ok(reply, 'the real model reply must belong to the claim turn')
  assert.equal(reply.provider, 'qwen-local')
  assert.equal(reply.model, MODEL_ID)
  assert.match(String(reply.text ?? ''), /BOOP-OK/u)
  const turnEnd = (settled.record.turnEnds ?? []).filter((end) => end.turn === claimTurn).at(-1)
  assert.equal(turnEnd?.turnEnd, 'completed')

  // The turn only ran because the pre-step gate allowed the explicitly released id.
  const gate = await ok('boopGate/status')
  assert.ok(
    (gate.consumedMessageIds ?? []).includes(fixture.actionId) ||
      (gate.lastDecision?.messageIds ?? []).includes(fixture.actionId),
    `the pre-step gate must have admitted the released id: ${JSON.stringify({ consumed: gate.consumedMessageIds, last: gate.lastDecision })}`,
  )
  assert.equal(gate.lastDecision?.decision ?? 'allow', 'allow', 'the runtime gate admitted the released BOOP command')

  const after = await reconcile({ actionId: fixture.actionId, retry: true, cleanRestart: true })
  assert.equal(after.dispatch?.kind, 'duplicate', JSON.stringify(after.dispatch))
  assert.equal(after.dispatch.reason, 'ALREADY_ACCEPTED')
  await sleep(2000)
  const finalRecord = await record()
  const finalFeed = await claims()
  assert.equal(userMessages(finalRecord, fixture.actionId).length, 1, 'no second execution after the duplicate')
  assert.equal(spliceInserts(finalRecord, fixture.actionId).length, 1, 'no second inbox insert')
  assert.equal(
    (finalFeed.claims ?? []).filter((claim) => claim.messageId === fixture.actionId).length,
    1,
    'still exactly one claim',
  )

  evidence.scenarios.realModel = {
    actionId: fixture.actionId,
    dispatch: dispatched.dispatch,
    claim: ownClaim[0],
    durableUserMessage: settled.ownUser[0],
    reply: { provider: reply.provider, model: reply.model, text: reply.text, turn: reply.turn },
    turnEnd,
    duplicate: after.dispatch,
    preStepGate: {
      registered: gate.registered,
      armed: gate.armed,
      composed: gate.runtimeEnforcement.composed,
      consumed: (gate.consumedMessageIds ?? []).includes(fixture.actionId),
      lastDecision: gate.lastDecision,
      counters: gate.counters,
    },
    afterDuplicate: {
      userMessages: userMessages(finalRecord, fixture.actionId).length,
      spliceInserts: spliceInserts(finalRecord, fixture.actionId).length,
      claims: (finalFeed.claims ?? []).filter((claim) => claim.messageId === fixture.actionId).length,
    },
  }
})
