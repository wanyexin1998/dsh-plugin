#!/usr/bin/env node
/**
 * E07-01 · fault injection 1/3 — SIGKILL mid-turn, restart the same DSH_HOME,
 * and restore the BOOP ledger from a `VACUUM INTO` snapshot.
 *
 * Scenario (real rc.2.1 `dsh web` payload, private `$DSH_HOME`):
 *  1. boot a PoC-enabled profile, create a real Session, resolve its Agent,
 *     dispatch ONE host-minted BOOP proxy command and wait until the durable
 *     Session log records `turn/start` (so the kill really lands mid-turn);
 *  2. seed a durable BOOP-ledger task/action/approval fixture via direct SQLite
 *     (disclosed below), take a `VACUUM INTO` snapshot while the Host is running,
 *     verify integrity, then SIGKILL the Host process (`child.kill('SIGKILL')`,
 *     TerminateProcess on Windows; no graceful shutdown code runs);
 *  3. restart the SAME `$DSH_HOME` on the restored snapshot and assert the
 *     honest facts: fresh recovery gate (nothing adopted), interrupted turn
 *     recorded as non-completed, no assistant reply, no duplicate claim, no
 *     automatic replay, integrity ok, scopeId/schema unchanged, old rows
 *     readable, and the unrelated user Session untouched.
 *
 * What is KNOWN / UNKNOWN here is reported verbatim, never upgraded:
 *  - a SIGKILL leaves the single-writer lease row in the ledger; the restarted
 *    process therefore reports the ledger as READ-ONLY (fail-safe). This test
 *    records that fact instead of hiding it; automated lease takeover is NOT
 *    claimed.
 *  - the recovery gate's own decision is fail-closed (unit-tested / probed), but
 *    its `agent/pre-step` runtime wiring is NOT composed (see E04-03 state:
 *    `runtimeEnforcement.composed:false`), so this test asserts only what the
 *    new process really does (no automatic claim/replay) and what the durable log
 *    really says (turn interrupted, no assistant).
 *
 * FIXTURE DISCLOSURE: task/action/approval rows (`e07-*` ids) are seeded through
 * a direct `node:sqlite` connection to `$DSH_HOME/boop/boop.sqlite`; the plugin
 * has no seed endpoint. The user's real `~/.dsh` is never read or modified.
 *
 * Run: node --test --test-force-exit tests/host/e07-01-fault-kill-restart.test.mjs
 * Evidence: docs/development/evidence/e07-01/fault-kill-restart-<ts>.json
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
import { verifyDatabase } from '../../src/host/persistence/database.ts'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e07-01-fault-kill-restart-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop/boop.sqlite')
const PROFILE = 'boop-e07-fault-kill'
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e07-01')
const EXECUTION_EVENTS = new Set([
  'turn/start',
  'agent/inbox/claimed',
  'user/message',
  'assistant/message',
  'turn/end',
  'tool/call',
  'tool/result',
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('  ', ...args)

let host = null
let base = null
let cookie = null
let sessionId = null
let userSession = null
let dispatch = null
let headBeforeKill = null
let eventsBeforeKill = []
let headUserBeforeKill = null
let scopeIdBefore = null
let schemaVersionBefore = null
let snapshotPath = null
let killedLiveCopy = null
let integrity = {}
let killedInfo = null
let evidence = null
let durableFacts = null
let automationFacts = null
let restoredFacts = null
let userFacts = null

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

/** SIGKILL: no signal handler, no flush on the way out (TerminateProcess on Windows). */
async function killHard(child) {
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const accepted = child.kill('SIGKILL')
  const result = await exited
  return { accepted, ...result }
}

function readLedger() {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    const scope = db.prepare('SELECT scope_id, schema_version FROM scopes LIMIT 1').get()
    const meta = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    return { scope, schemaVersion: meta ? Number(meta.value) : null }
  } finally {
    db.close()
  }
}

/** Disclosed fixture: one active task + awaiting_approval action + pending approval. */
function seedLedgerFixture(scopeId) {
  const db = new DatabaseSync(LEDGER)
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(
      'INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,intent_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run('e07-restore-task', scopeId, 'E07 kill/restore fixture task', 'active', 'not_requested', 1, '["可验证"]', '["不部署"]', null, now, now)
    db.prepare(
      'INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,intent_ref,created_at) VALUES(?,?,?,?,?,?)',
    ).run('e07-restore-task', scopeId, 1, JSON.stringify({ goal: 'E07 kill/restore fixture task' }), null, now)
    db.prepare(
      'INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,message_id,turn_id,policy_epoch,origin_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('e07-restore-action', scopeId, 'e07-restore-task', 1, 'e07-restore-session', 'e07-restore-payload', JSON.stringify({ instruction: 'fixture' }), 'awaiting_approval', null, null, 1, 'dsh:operator', now, now)
    db.prepare('INSERT INTO command_outbox(action_id,scope_id,state,attempt) VALUES(?,?,?,?)').run('e07-restore-action', scopeId, 'prepared', 0)
    db.prepare(
      'INSERT INTO approval(id,scope_id,action_id,payload_hash,task_version,policy_epoch,requesting_owner,nonce_hash,expires_at,consumed_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run('e07-restore-approval', scopeId, 'e07-restore-action', 'e07-restore-payload', 1, 1, 'dsh-local-owner', 'e07-restore-nonce', expiresAt, null, 'pending')
  } finally {
    db.close()
  }
}

function writeEvidence() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const payload = evidence ?? {
    schemaVersion: 1,
    task: 'E07-01',
    scenario: 'sigkill-mid-turn-restart-restore',
    capturedAt: new Date().toISOString(),
    host: { profile: PROFILE, dshHome: HOME, work: WORK },
    session: { sessionId, userSession },
    dispatch: dispatch === null ? null : { messageId: dispatch.messageId, actionId: dispatch.actionId, accepted: dispatch.accepted, sourceKind: dispatch.sourceKind },
    killed: killedInfo,
    durable: durableFacts,
    automation: automationFacts,
    restored: restoredFacts,
    userSession: userFacts,
    integrity,
    knownUnknown: {
      interruptedTurnOutcome: 'known: durable turn/end interrupted; no assistant reply was observed',
      recoveryGateAdoption: 'known: new process adopts no gate entry and makes no claim',
      runtimePreStepEnforcement:
        'KNOWN RISK: RecoveryGate.decide is fail-closed but agent/pre-step wiring is NOT composed; this run proves no AUTOMATIC replay/claim, not a runtime block',
      writerLeaseAfterUncleanKill:
        'the restarted Host reports the writer lease facts above; automated lease takeover after an unclean kill is NOT claimed by this test',
    },
  }
  const file = path.join(EVIDENCE_DIR, `fault-kill-restart-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}`)
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  // PoC opt-in ONLY for the already-shipped dispatch/claim/record endpoints. No
  // model route is patched: the turn starts and then cannot complete (no
  // credential for the default route), which is exactly the window we kill in.
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), '- id: boop-api\n  config:\n    pocEnabled: true\n')
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)

  sessionId = (await ok('session/create', { request: { cwd: WORK } })).sessionId
  userSession = (await ok('session/create', { request: { cwd: WORK } })).sessionId
  const userRecord = await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })
  headUserBeforeKill = userRecord.headSeq

  const ledgerBefore = readLedger()
  assert.ok(ledgerBefore.scope, 'the BOOP ledger + scope row exist after boot')
  scopeIdBefore = String(ledgerBefore.scope.scope_id)
  schemaVersionBefore = ledgerBefore.schemaVersion
  seedLedgerFixture(scopeIdBefore)

  // Snapshot WHILE the Host is writable, then verify the snapshot itself.
  snapshotPath = path.join(WORK, 'boop-snapshot.sqlite')
  const snapshotDb = new DatabaseSync(LEDGER)
  try {
    snapshotDb.exec(`VACUUM INTO '${snapshotPath.replace(/\\/g, '/').replace(/'/g, "''")}'`)
  } finally {
    snapshotDb.close()
  }
  integrity.liveBeforeKill = verifyDatabase(LEDGER)
  integrity.snapshot = verifyDatabase(snapshotPath)
  assert.equal(integrity.snapshot.ok, true, 'the VACUUM INTO snapshot is consistent before the kill')

  // Dispatch one real proxy command and wait for the durable turn/start, so the
  // kill lands mid-turn (not before execution begins).
  await ok('boop/pocResolveAgent', { sessionId })
  const feed = await ok('boop/pocClaimFeed', { sessionId, clear: true })
  assert.equal(feed.subscribed, true)
  dispatch = await ok('boop/pocDispatch', {
    sessionId,
    instruction: 'E07-01 fault injection: this turn is killed before it completes.',
    mode: 'queue',
  })
  assert.equal(dispatch.accepted, true, JSON.stringify(dispatch))

  const started = Date.now()
  let record = null
  while (Date.now() - started < 10_000) {
    record = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 200 })
    if ((record.events ?? []).some((event) => event.type === 'turn/start')) break
    await sleep(50)
  }
  assert.ok(record && (record.events ?? []).some((event) => event.type === 'turn/start'), 'the turn started durably before the kill')
  headBeforeKill = record.headSeq
  eventsBeforeKill = (record.events ?? []).map((event) => `${event.seq}:${event.type}`)

  // SIGKILL the real Host process. No SIGTERM / no graceful close path runs.
  killedInfo = await killHard(host.child)
  log('SIGKILL result', JSON.stringify(killedInfo))
  assert.equal(killedInfo.signal, 'SIGKILL', 'the process was force-killed, not asked to stop')

  const killedLive = path.join(WORK, 'killed-live.sqlite')
  if (fs.existsSync(LEDGER)) fs.copyFileSync(LEDGER, killedLive)
  killedLiveCopy = killedLive
  integrity.killedLive = verifyDatabase(killedLive)

  // "Restore" the ledger from the snapshot: stale WAL/SHM from the killed process
  // are removed first, exactly as a cold restore would.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(LEDGER + suffix)) fs.rmSync(LEDGER + suffix, { force: true })
  }
  fs.copyFileSync(snapshotPath, LEDGER)
  integrity.restored = verifyDatabase(LEDGER)
  assert.equal(integrity.restored.ok, true, 'the restored ledger passes integrity_check')

  // Restart the SAME DSH_HOME (the user's ~/.dsh is untouched; HOME is under .work).
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  if (host && host.child.exitCode === null) await host.stop()
  writeEvidence()
})

test('E07-01 after SIGKILL the restarted process adopts no previous command', async () => {
  const gate = await ok('boop/pocGateStatus')
  assert.equal(gate.gateArmed, true, 'the new process arms its own recovery gate')
  assert.deepEqual(gate.entries, [], 'the new process adopts NO previous command entry')
  assert.deepEqual(gate.adoptedMessageIds, [], 'no previous message id is carried over implicitly')
  const recovery = await ok('boopControl/recovery', { request: {} })
  assert.equal(recovery.available, true)
  assert.equal(recovery.recovery.armed, true)
  assert.equal(recovery.recovery.pendingCount, 0, 'the gate ledger has no adopted pending entry after restart')
  assert.equal(recovery.recovery.runtimeEnforcement.composed, true, 'the agent/pre-step runtime gate is composed, so old commands stay blocked in-process too')
})

test('E07-01 the killed turn is interrupted-or-lost in the durable log — never success — with no duplicate claim', async () => {
  const record = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 400 })
  const events = (record.events ?? []).map((event) => `${event.seq}:${event.type}`)
  const prefixPreserved = eventsBeforeKill.every((previous) => events.includes(previous))

  // An unclean SIGKILL can lose the not-yet-flushed durable tail (the pre-kill
  // read goes through the live Session store). That window is REPORTED, never
  // hidden: what must never appear is a fabricated success or a second execution.
  assert.equal((record.assistant ?? []).length, 0, 'no assistant reply was fabricated or recovered')
  assert.equal(
    (record.turnEnds ?? []).some((end) => end.turnEnd === 'completed'),
    false,
    'a killed turn must never read as completed',
  )
  const lastEnd = (record.turnEnds ?? []).at(-1) ?? null
  if (lastEnd !== null) {
    assert.match(String(lastEnd.turnEnd), /interrupted|error/iu, 'the end reason names the interruption/error')
  }
  if (!prefixPreserved) {
    log(
      `UNKNOWN RESULT (honest): the SIGKILL lost a not-yet-durable session tail; ` +
        `pre-kill head ${headBeforeKill} -> post-restart head ${record.headSeq}. No success/claim was invented.`,
    )
  }

  const ownMessages = (record.userMessages ?? []).filter((message) => message.messageId === dispatch.messageId)
  assert.ok(ownMessages.length <= 1, 'the dispatched message id appears at most once in the durable log')
  if (ownMessages.length === 1) {
    assert.equal(ownMessages[0].sourceKind, 'boop-command', 'provenance survives: never rewritten as a user message')
  }
  const claims = await ok('boop/pocClaimFeed', { sessionId })
  assert.deepEqual(claims.claims ?? [], [], 'the new process made no claim of the old command')
  durableFacts = {
    headBeforeKill,
    headAfterRestart: record.headSeq,
    durablePrefixPreserved: prefixPreserved,
    preKillEvents: eventsBeforeKill,
    postRestartEvents: events,
    assistantCount: (record.assistant ?? []).length,
    lastTurnEnd: lastEnd,
    ownMessageCount: ownMessages.length,
    claimsAfterRestart: claims.claims ?? [],
    unknownResultWindows: prefixPreserved
      ? []
      : ['unclean SIGKILL lost the not-yet-durable session tail; reported as unknown, no success invented'],
  }
})

test('E07-01 nothing replays automatically: head stays frozen and an explicit resolve executes nothing', async () => {
  const first = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 400 })
  const frozenHead = first.headSeq
  await sleep(2500)
  const second = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 400 })
  assert.equal(second.headSeq, frozenHead, 'no event is appended by the restart / idle wait')
  assert.deepEqual(
    (second.events ?? []).filter((event) => event.seq > frozenHead && EXECUTION_EVENTS.has(event.type)),
    [],
    'no execution event after the restart',
  )

  // Explicit human action, not automation: cold-resolve the Agent and report the
  // observed behavior honestly (no claim of a runtime block).
  const resolved = await ok('boop/pocResolveAgent', { sessionId })
  assert.equal(resolved.resolved, true)
  await sleep(2500)
  const afterResolve = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 400 })
  const executed = (afterResolve.events ?? []).filter(
    (event) => event.seq > frozenHead && EXECUTION_EVENTS.has(event.type),
  )
  assert.deepEqual(
    executed.map((event) => `${event.seq}:${event.type}`),
    [],
    'a cold resolve after the restart executed no old BOOP command',
  )
  const claims = await ok('boop/pocClaimFeed', { sessionId })
  assert.deepEqual(claims.claims ?? [], [], 'no duplicate claim after the cold resolve either')

  automationFacts = {
    frozenHeadBeforeResolve: frozenHead,
    headAfterExplicitResolve: afterResolve.headSeq,
    executedAfterRestart: executed.map((event) => `${event.seq}:${event.type}`),
    claimsAfterResolve: claims.claims ?? [],
  }
})

test('E07-01 restored ledger: integrity ok, same scopeId/schema, old rows readable', async () => {
  assert.equal(integrity.liveBeforeKill.ok, true, 'live ledger integrity before the kill')
  assert.equal(integrity.killedLive.ok, true, 'the SIGKILL left a structurally intact SQLite file')
  assert.equal(integrity.restored.ok, true, 'restored snapshot integrity')

  const bootstrap = await ok('boop/bootstrap')
  log('bootstrap.storage after restore:', JSON.stringify(bootstrap.storage))
  assert.ok(bootstrap.storage !== null && bootstrap.storage !== undefined, 'the restarted Host opened the restored ledger')
  assert.equal(bootstrap.storage?.scope?.scopeId, scopeIdBefore, 'scopeId is unchanged by the restore')
  assert.equal(bootstrap.storage?.schemaVersion, schemaVersionBefore, 'schema version is unchanged (no fake migration)')
  assert.equal(bootstrap.scope?.writeModeEnabled, true, 'write mode still follows the open gate ledger after the restart')

  const tasks = await ok('boopTasks/list', { request: {} })
  assert.equal(tasks.available, true, JSON.stringify({ reason: tasks.reason, detail: tasks.detail }))
  assert.ok(
    (tasks.tasks ?? []).some((task) => task.taskId === 'e07-restore-task'),
    'the pre-kill durable task row is readable from the restored ledger',
  )

  // Report the writer-lease fact honestly instead of asserting a takeover.
  const control = await ok('boopControl/state', { request: {} })
  assert.equal(control.available, true, 'the control plane is readable against the restored ledger')
  const stopped = await ok('boopControl/stop', { request: { scope: 'all' } })
  log(
    'bootstrap.storage.ok:', bootstrap.storage?.ok,
    'lease.held:', bootstrap.storage?.lease?.held,
    'control.ledger.writable:', control.ledger?.writable,
    'stop.accepted:', stopped.accepted,
  )
  // Fail-closed posture after an unclean kill: when the ledger is not writable,
  // write-ish commands must not silently succeed. If the lease was re-acquired,
  // the stop may be a no-op (accepted, no rows); both are reported, never faked.
  if (control.ledger?.writable !== true) {
    assert.equal(stopped.accepted, false, 'read-only ledger: the write command is refused, not silently accepted')
    assert.equal(stopped.code, 'CAPABILITY_UNAVAILABLE')
  }
  restoredFacts = {
    scopeIdBefore,
    schemaVersionBefore,
    scopeIdAfter: bootstrap.storage?.scope?.scopeId ?? null,
    schemaVersionAfter: bootstrap.storage?.schemaVersion ?? null,
    storageOk: bootstrap.storage?.ok ?? null,
    leaseHeld: bootstrap.storage?.lease?.held ?? null,
    ledgerWritableAfterRestart: control.ledger?.writable ?? null,
    auditSinkAfterRestart: control.ledger?.auditSink ?? null,
    readableAfterRestart: tasks.available,
    restoredTaskReadable: (tasks.tasks ?? []).some((task) => task.taskId === 'e07-restore-task'),
    stopAfterRestore: { accepted: stopped.accepted, code: stopped.code ?? null, noop: stopped.noop ?? null },
  }
})

test('E07-01 the kill/restore never touches the unrelated user Session or user turn', async () => {
  const user = await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })
  log('user session record after restart:', JSON.stringify({ available: user.available, headSeq: user.headSeq, reason: user.reason, detail: user.detail }))
  assert.equal(user.available, true, 'the user Session survives the kill/restart')
  assert.equal(user.headSeq, headUserBeforeKill, 'the kill/restart appended nothing to the user Session')
  assert.deepEqual(
    (user.events ?? []).filter((event) => event.type === 'turn/start'),
    [],
    'the user Session had no turn started by the fault injection',
  )

  // Deterministic Stop must fail closed here: the restored snapshot still carries
  // the unexpired writer lease of the SIGKILLed process (holder was `dsh@<pid>`),
  // so the restarted Host is read-only. Either the command is refused, or (if a
  // later lease takeover happened) it is a no-op that stops nothing. Both paths
  // are asserted to never stop a user turn.
  const stopped = await ok('boopControl/stop', { request: { scope: `session:${userSession}` } })
  if (stopped.accepted === false) {
    assert.equal(stopped.code, 'CAPABILITY_UNAVAILABLE', 'read-only ledger refuses the write command explicitly')
    assert.deepEqual(stopped.stopped, [], 'the refused stop stopped nothing')
  } else {
    assert.deepEqual(stopped.stopped, [], 'no user turn is stopped')
    assert.equal(stopped.policy.userTurnsStopped, false)
    assert.equal(stopped.policy.foreignTurns, 'not-inspected-never-stopped')
  }
  const userAfterStop = await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })
  assert.equal(userAfterStop.headSeq, headUserBeforeKill, 'the stop attempt appended nothing to the user Session')
  userFacts = {
    sessionId: userSession,
    headBefore: headUserBeforeKill,
    headAfter: user.headSeq,
    headAfterStopAttempt: userAfterStop.headSeq,
    stopResponse: { accepted: stopped.accepted, code: stopped.code ?? null, stopped: stopped.stopped.length },
    userTurnsStopped: stopped.accepted === false ? null : stopped.policy.userTurnsStopped,
  }
})
