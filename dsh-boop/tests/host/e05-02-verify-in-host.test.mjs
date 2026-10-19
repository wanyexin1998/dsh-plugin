#!/usr/bin/env node
/**
 * E05-02 in-host: evidence verification row + limited self-heal gate.
 *
 * A real DSH 0.2.1-rc.2 Host boots with the `boop-verify` row in a private
 * `$DSH_HOME`. The verification fixture is seeded DIRECTLY into BOOP's SQLite
 * ledger (and disclosed here): three tasks with durable evidence rows —
 *  A: version-1 task with version-1 evidence (a pass is possible),
 *  B: version-2 task whose only evidence was produced for version 1 (stale),
 *  C: evidence whose source generation has moved on (stale).
 *
 * What this proves on the REAL host:
 *  - verify is READ-ONLY: no ledger row changes across repeated calls;
 *  - conclusions are honest (passed / stale / unknown, Agent claim never passes);
 *  - previewHeal is fail-closed (CAPABILITY_UNAVAILABLE) with executed:false and
 *    an audit row, while write mode stays false;
 *  - the same failure fingerprint reaches its limit and stops further repair;
 *  - the model-facing `boop_verify` tool is registered in the live tool catalog;
 *  - the row is unique, mounts warning-free and unauthenticated callers get 401.
 *
 * Run: node --test --test-force-concurrency=1 --test-force-exit tests/host/e05-02-verify-in-host.test.mjs
 * (the suite runs with the shared `--test-concurrency=1` regression command)
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

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e05-02-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const PROFILE = 'boop-verify'
const PROJECT = path.join(WORK, 'project')
const SESSIONS = path.join(HOME, 'sessions')

const SESSION_A = 'session-e05-02-a'
const SESSION_B = 'session-e05-02-b'
const SESSION_C = 'session-e05-02-c'
const GENERATION_A = `${SESSION_A}@4:1700000000000:`
const GENERATION_B = `${SESSION_B}@4:1700000000000:`
const GENERATION_C_OLD = `${SESSION_C}@4:1700000000000:`
const GENERATION_C_NEW = `${SESSION_C}@4:1700000000000:1700000500000:`

const TASK_A = 'task-e05-02-pass'
const TASK_B = 'task-e05-02-version-stale'
const TASK_C = 'task-e05-02-generation-stale'

const NOW = new Date('2026-10-18T00:00:00.000Z').toISOString()

let host = null
let cookie = null
let base = null

function writeEvidenceArtifact(payload) {
  const dir = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''
  if (dir === '') return
  const resolved = path.resolve(PROJECT_ROOT, dir)
  fs.mkdirSync(resolved, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(resolved, `verify-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${file}`)
}
const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  return { status, body }
}

const ok = async (endpoint, args = {}) => {
  const { status, body } = await call(endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 600)}`)
  assert.equal(body?.result?.ok, true, `${endpoint} failed: ${JSON.stringify(body?.result ?? body).slice(0, 900)}`)
  return body.result.value
}

function tableCounts() {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    const tables = [
      'scopes',
      'task',
      'task_revision',
      'action',
      'approval',
      'command_outbox',
      'fact',
      'fact_version',
      'fact_evidence',
      'fact_consumption',
      'source_cursor',
      'memory_snapshot',
      'audit_event',
    ]
    const counts = {}
    for (const table of tables) counts[table] = Number(db.prepare(`SELECT count(*) c FROM ${table}`).get().c)
    return counts
  } finally {
    db.close()
  }
}

function auditCount(kind) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return Number(db.prepare('SELECT count(*) c FROM audit_event WHERE kind = ?').get(kind).c)
  } finally {
    db.close()
  }
}

/* ── fixture seeding (disclosed: direct SQLite writes before the verify boot) ── */

function seedFixture() {
  const db = new DatabaseSync(LEDGER)
  try {
    const scope = db.prepare('SELECT scope_id FROM scopes LIMIT 1').get()
    assert.ok(scope, 'the first boot must have created the BOOP scope')
    const scopeId = String(scope.scope_id)
    // Boot 1 was stopped a moment ago; its 15s writer lease would make boot 2
    // read-only (PRAGMA query_only) and push audits to the memory fallback.
    // Fixture setup clears the stale lease so the second boot owns the writer.
    db.prepare('DELETE FROM runtime_lease WHERE scope_id = ?').run(scopeId)

    const insertTask = db.prepare(
      `INSERT INTO task(id, scope_id, goal, lifecycle, verification, version, criteria_json, exclusions_json, intent_ref, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const insertRevision = db.prepare(
      'INSERT INTO task_revision(task_id, scope_id, version, snapshot_json, intent_ref, created_at) VALUES(?,?,?,?,?,?)',
    )
    const insertAction = db.prepare(
      `INSERT INTO action(id, scope_id, task_id, task_version, target_session_id, payload_hash, payload_json, state, message_id, turn_id, policy_epoch, origin_ref, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const insertFact = db.prepare(
      `INSERT INTO fact(id, scope_id, owner_type, owner_id, kind, text, status, authority, valid_time, version, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const insertFactVersion = db.prepare(
      'INSERT INTO fact_version(fact_id, scope_id, version, snapshot_json, created_at) VALUES(?,?,?,?,?)',
    )
    const insertEvidence = db.prepare(
      'INSERT INTO fact_evidence(id, fact_id, scope_id, session_id, seq, source_hash, artifact_ref) VALUES(?,?,?,?,?,?,?)',
    )
    const insertConsumption = db.prepare(
      'INSERT INTO fact_consumption(id, fact_id, scope_id, fact_version, task_id, action_id, use_kind) VALUES(?,?,?,?,?,?,?)',
    )
    const insertCursor = db.prepare(
      'INSERT INTO source_cursor(scope_id, session_id, source_generation, through_seq, state) VALUES(?,?,?,?,?)',
    )

    const task = (id, version, criteria, verification = 'pending') => {
      insertTask.run(id, scopeId, `E05-02 fixture ${id}`, 'active', verification, version, JSON.stringify(criteria), JSON.stringify(['不部署']), null, NOW, NOW)
      for (let v = 1; v <= version; v += 1) {
        insertRevision.run(id, scopeId, v, JSON.stringify({ version: v, goal: `E05-02 fixture ${id}`, criteria, exclusions: ['不部署'], intentRef: null }), null, NOW)
      }
    }
    const consumption = (taskId, factId, actionId, useKind, factVersion = 1) => {
      insertFact.run(factId, scopeId, 'session', SESSION_A, 'evidence', `evidence for ${taskId}`, 'active', 'tool_observed', null, factVersion, NOW, NOW)
      insertFactVersion.run(factId, scopeId, factVersion, JSON.stringify({ text: `evidence for ${taskId}` }), NOW)
      insertConsumption.run(`consume-${taskId}-${factId}`, factId, scopeId, factVersion, taskId, actionId, useKind)
    }

    /* A — a PASS is possible: task v1, action v1, generation current */
    task(TASK_A, 1, ['窄屏布局不溢出', '交互路径可完成'])
    insertAction.run('action-a1', scopeId, TASK_A, 1, SESSION_A, 'payload-a', '{}', 'settled', 'msg-a1', null, 1, 'dsh:operator', NOW, NOW)
    insertFact.run('fact-a1', scopeId, 'session', SESSION_A, 'evidence', 'narrow layout verified', 'active', 'tool_observed', null, 1, NOW, NOW)
    insertFactVersion.run('fact-a1', scopeId, 1, JSON.stringify({ text: 'narrow layout verified' }), NOW)
    insertEvidence.run('evidence-a1', 'fact-a1', scopeId, SESSION_A, 5, `${GENERATION_A}#5`, null)
    insertConsumption.run('consume-a1', 'fact-a1', scopeId, 1, TASK_A, 'action-a1', 'verification')
    insertCursor.run(scopeId, SESSION_A, GENERATION_A, 5, 'fresh')

    /* B — VERSION stale: task v2 but its evidence/action were produced for v1 */
    task(TASK_B, 2, ['窄屏布局不溢出', '交互路径可完成'])
    insertAction.run('action-b1', scopeId, TASK_B, 1, SESSION_B, 'payload-b', '{}', 'settled', 'msg-b1', null, 1, 'dsh:operator', NOW, NOW)
    consumption(TASK_B, 'fact-b1', 'action-b1', 'verification')
    insertEvidence.run('evidence-b1', 'fact-b1', scopeId, SESSION_B, 7, `${GENERATION_B}#7`, null)
    insertCursor.run(scopeId, SESSION_B, GENERATION_B, 7, 'fresh')

    /* C — GENERATION stale: evidence from an older generation of the same source */
    task(TASK_C, 1, ['窄屏布局不溢出'])
    insertAction.run('action-c1', scopeId, TASK_C, 1, SESSION_C, 'payload-c', '{}', 'settled', 'msg-c1', null, 1, 'dsh:operator', NOW, NOW)
    consumption(TASK_C, 'fact-c1', 'action-c1', 'verification')
    insertEvidence.run('evidence-c1', 'fact-c1', scopeId, SESSION_C, 9, `${GENERATION_C_OLD}#9`, null)
    insertCursor.run(scopeId, SESSION_C, GENERATION_C_NEW, 12, 'fresh')

    return scopeId
  } finally {
    db.close()
  }
}

/* ── boot ─────────────────────────────────────────────────────────────── */

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.mkdirSync(PROJECT, { recursive: true })
  fs.writeFileSync(
    path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    `# E05-02 verification in-host (isolated DSH_HOME only; never a user profile).
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS.replace(/\\/g, '/')}'
    compression: none

- id: boop-verify
  config:
    maxAttempts: 2
`,
  )

  // Boot 1: let the real Host create the ledger/scope, then stop.
  const first = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  try {
    const firstCookie = await authorize(first.base, first.token)
    const bootstrap = await rpc(first.base, firstCookie, 'boop/bootstrap')
    assert.equal(bootstrap.body?.result?.ok, true, JSON.stringify(bootstrap.body).slice(0, 600))
  } finally {
    await first.stop()
  }

  seedFixture()

  // Boot 2: the verification suite runs against the seeded ledger.
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  await host?.stop()
})

/* ── tests ────────────────────────────────────────────────────────────── */

test('E05-02 the verification row is unique, mounts warning-free and reports real facts', async () => {
  const dump = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(dump.code, 0, dump.stderr.slice(0, 500))
  assert.equal(dump.stdout.split('\n').filter((line) => line === '- id: boop-verify').length, 1)

  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))

  const status = await ok('boopVerify/status')
  assert.equal(status.row, 'boop-verify')
  assert.equal(status.remoteService, 'boopVerify')
  assert.equal(status.writeMode.enabled, false, 'write mode stays OFF while G03/G04/G05/G06 are not PASS')
  assert.equal(status.ledger.available, true)
  assert.equal(status.verifier.executesCommands, false, 'verification never runs commands')
  assert.equal(status.verifier.readsArbitraryFiles, false)
  assert.equal(status.tool.name, 'boop_verify')
  assert.equal(status.tool.registered, true, 'the model-facing boop_verify tool is in the live catalog')
  assert.equal(status.relatedTools.boop_catalog, true, 'the M0 boop_catalog tool is registered too (schema-DSL defect fixed)')
})

test('E05-02 verify is read-only: repeated conclusions change no ledger row', async () => {
  const before = tableCounts()
  const passed = await ok('boopVerify/verify', {
    request: {
      taskId: TASK_A,
      evidenceRefs: [`session:${SESSION_A}#seq:5`],
      checks: ['0:passed:布局断言通过', '1:passed:交互核查通过'],
    },
  })
  const stale = await ok('boopVerify/verify', { request: { taskId: TASK_B } })
  const claimOnly = await ok('boopVerify/verify', { request: { taskId: TASK_A, claim: { text: '我已经完成并且全部测试通过' } } })
  const missing = await ok('boopVerify/verify', { request: { taskId: 'task-does-not-exist' } })
  const after = tableCounts()
  assert.deepEqual(after, before, `verify must not write the ledger (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`)
  assert.equal(passed.ledgerWrites, 0)

  assert.equal(passed.conclusion, 'passed', JSON.stringify(passed))
  assert.equal(passed.recommendedVerification, 'passed')
  assert.equal(passed.task.version, 1)
  assert.equal(passed.coverage.passed, 2)

  assert.equal(stale.conclusion, 'stale', JSON.stringify(stale))
  assert.match(String(stale.evidence[0].staleReason), /EVIDENCE_VERSION_MISMATCH/u)
  assert.notEqual(stale.recommendedVerification, 'passed')

  assert.equal(claimOnly.conclusion, 'unknown', JSON.stringify(claimOnly))
  assert.notEqual(claimOnly.recommendedVerification, 'passed')

  assert.equal(missing.conclusion, 'unknown')
  assert.equal(missing.reason, 'TASK_NOT_FOUND')

  const toolStatus = await ok('boopVerify/status')
  const summarize = (result) => ({
    taskId: result.taskId,
    conclusion: result.conclusion,
    reason: result.reason,
    recommendedVerification: result.recommendedVerification,
    gates: result.gates,
    coverage: result.coverage,
    evidence: result.evidence.map((entry) => ({
      ref: entry.ref,
      resolved: entry.resolved,
      version: entry.version,
      versionMatchesTask: entry.versionMatchesTask,
      generationMoved: entry.generationMoved,
      staleReason: entry.staleReason,
      agentClaim: entry.agentClaim,
    })),
    attempt: result.attempt,
    fingerprint: result.fingerprint,
  })
  writeEvidenceArtifact({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    environment: { dshVersion: '0.2.1-rc.2', profile: PROFILE, isolatedDshHome: HOME },
    writer: { writeMode: toolStatus.writeMode, gates: toolStatus.gates, ledgerWrites: 0 },
    tools: toolStatus.tool,
    ledgerRowsBefore: before,
    ledgerRowsAfter: after,
    sample: {
      passed: summarize(passed),
      versionStale: summarize(stale),
      agentClaimOnly: summarize(claimOnly),
      taskNotFound: summarize(missing),
    },
    note: 'Fixture rows were seeded directly into the isolated ledger before the verify boot; verify itself changed no row.',
  })
})

test('E05-02 a source generation that moved on makes the evidence stale (real cursor plane)', async () => {
  const result = await ok('boopVerify/verify', {
    request: { taskId: TASK_C, evidenceRefs: [`session:${SESSION_C}#seq:9`] },
  })
  assert.equal(result.conclusion, 'stale', JSON.stringify(result))
  assert.match(String(result.evidence[0].staleReason), /EVIDENCE_GENERATION_MOVED/u)
  assert.notEqual(result.recommendedVerification, 'passed')
})

test('E05-02 the same failure fingerprint reaches the limit and stops further repair (AT-18)', async () => {
  const request = {
    request: { taskId: TASK_A, evidenceRefs: [`session:${SESSION_A}#seq:5`], checks: ['0:passed', '1:failed:窄屏交互中断'] },
  }
  const first = await ok('boopVerify/verify', request)
  const second = await ok('boopVerify/verify', request)
  const third = await ok('boopVerify/verify', request)
  assert.equal(first.conclusion, 'failed')
  assert.equal(first.attempt, 1)
  assert.equal(first.limitReached, false)
  assert.equal(second.attempt, 2)
  assert.equal(second.limitReached, true, 'default limit is 2')
  assert.equal(third.attempt, 3)
  assert.equal(third.halted, true)
  assert.equal(third.nextAction, 'stop-dispatch')
  assert.equal(first.fingerprint, third.fingerprint)

  const status = await ok('boopVerify/status')
  assert.ok(status.verifier.attemptsRecorded >= 1)
})

test('E05-02 previewHeal is fail-closed with an audit row while write mode is off, never dispatched', async () => {
  const before = auditCount('verify/preview-heal')
  // Fresh failure fingerprint (failing criterion 0) so the attempt budget is
  // available; the gate — not the attempt limit — is what refuses execution.
  const heal = await ok('boopVerify/previewHeal', {
    request: {
      taskId: TASK_A,
      evidenceRefs: [`session:${SESSION_A}#seq:5`],
      checks: ['0:failed:布局断言失败', '1:passed'],
    },
  })
  assert.equal(heal.ok, false)
  assert.equal(heal.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(heal.executed, false, 'nothing was executed')
  assert.equal(heal.dispatchAllowed, false, 'nothing may be dispatched while write mode is closed')
  assert.ok(heal.blockedByGates.length > 0, 'the blocking gates are named')
  assert.equal(heal.writeMode.enabled, false)
  assert.ok(heal.candidates.length >= 1, 'the honest preview still carries repair candidates')
  assert.equal(heal.candidates[0].requiresNewHypothesis, true)
  assert.equal(heal.audit?.sink, 'ledger')
  assert.match(heal.rendered, /未执行、未派发/u)
  assert.ok(auditCount('verify/preview-heal') > before, 'the preview request was audited')

  const status = await ok('boopVerify/status')
  assert.equal(status.writeMode.enabled, false, 'write mode is still false after the heal preview')
})

test('E05-02 an exhausted fingerprint refuses the repair plan entirely (host wiring)', async () => {
  // The same failed-criterion fingerprint was used once above; this second
  // attempt reaches the configured limit of 2, so no repair plan is produced.
  const heal = await ok('boopVerify/previewHeal', {
    request: { taskId: TASK_A, evidenceRefs: [`session:${SESSION_A}#seq:5`], checks: ['0:failed:布局断言失败', '1:passed'] },
  })
  assert.equal(heal.code, 'ATTEMPT_LIMIT_REACHED')
  assert.equal(heal.executed, false)
  assert.equal(heal.dispatchAllowed, false)
  assert.deepEqual(heal.candidates, [])
})

test('E05-02 unauthenticated callers never reach the verification plane (401)', async () => {
  const anonymous = await anonymousRequest(`${base}/api/boopVerify/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: 'boopVerify/verify', payload: { args: { request: { taskId: TASK_A } } } }),
  })
  assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body).slice(0, 300))
})
