#!/usr/bin/env node
/**
 * E05-01 in-host: scheduler row, read-only patrol, native automation binding.
 *
 * A real DSH 0.2.1-rc.2 Host boots with the `boop-scheduler` row in a private
 * `$DSH_HOME`. This suite proves the ROW, not a mock:
 *  - the row is unique, mounts warning-free and reports REAL facts (write mode
 *    still off, gates, empty in-memory queue, background batches closed);
 *  - patrol is genuinely read-only: ledger row counts do not move across it and
 *    it declares modelCalls: 0 / readOnly: true;
 *  - pause/resume/cancel work with write mode OFF and land an audit row;
 *  - the native automation binding registers exactly ONE task through the real
 *    mounted `schedule` service (visible in native catalog), adopts instead of
 *    duplicating, and unbinds only its own task;
 *  - unauthenticated callers are refused (401).
 *
 * Run: node --test --test-force-exit tests/host/e05-01-scheduler-in-host.test.mjs
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

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e05-01-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const PROFILE = 'boop-sched'
const PROJECT = path.join(WORK, 'project')
const SESSIONS = path.join(HOME, 'sessions')
const MARKER = '[BOOP] 主动节奏检查（自动注册）'

let host = null
let cookie = null
let base = null

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

/** Row counts from BOOP's own ledger, read through a separate read-only handle. */
function ledgerCounts() {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    const tables = ['scopes', 'approval', 'action', 'command_outbox', 'source_cursor', 'fact', 'fact_evidence', 'memory_snapshot', 'audit_event', 'runtime_lease']
    const counts = {}
    for (const table of tables) {
      const row = db.prepare(`SELECT count(*) c FROM ${table}`).get()
      counts[table] = Number(row.c)
    }
    return counts
  } finally {
    db.close()
  }
}

function ledgerRows(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

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
    `# E05-01 scheduler in-host (isolated DSH_HOME only; never a user profile).
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS.replace(/\\/g, '/')}'
    compression: none

- id: boop-scheduler
  config:
    # Deterministic host: the 60s read-only compensation timer is covered by the
    # unit/patrol tests; here status/patrol are called explicitly.
    patrolTimer: false
    dailyTime: '09:00:00'
    timeZone: 'Asia/Shanghai'
`,
  )
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E05-01 the scheduler row is unique and mounts without activation warnings', async () => {
  const dump = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(dump.code, 0, dump.stderr.slice(0, 600))
  const occurrences = dump.stdout.match(/- id: boop-scheduler/gu) ?? []
  assert.equal(occurrences.length, 1, 'exactly one boop-scheduler row is composed')
  assert.match(dump.stdout, /boop-scheduler/)

  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))
})

test('E05-01 status reports real facts: write mode off, empty in-memory queue, background closed', async () => {
  // The native schedule service is optional and the composition settles a moment
  // after the web URL is printed; poll (bounded) instead of freezing a boot race.
  let status = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    status = await ok('boopScheduler/status')
    if (status.native.available) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.ok(status)
  assert.equal(status.row, 'boop-scheduler')
  assert.equal(status.remoteService, 'boopScheduler')
  assert.equal(status.writeMode.enabled, false, 'write mode stays OFF (G03/G04/G05/G06/G08/G09)')
  assert.ok(status.writeMode.blockedByGates.includes('G05'))
  assert.equal(status.gates.G01, 'PASS')
  assert.equal(status.gates.G02, 'PASS')
  assert.equal(status.background.pocEnabled, false, 'production/default profile keeps background batches closed')
  assert.equal(status.background.modelRoute, null, 'no route is invented')
  assert.equal(status.scheduler.queue.total, 0, 'a fresh Host has no queued background work')
  assert.equal(status.scheduler.foreground.active, false)
  assert.equal(status.scheduler.permits.active, 0)
  assert.deepEqual(status.scheduler.recent, [])
  assert.equal(status.scheduler.background.wire, 'memory-only', 'the queue is memory-only: a restart never replays work')
  assert.equal(status.native.available, true, 'the rc.2.1 web profile mounts the native schedule service')
  assert.notEqual(status.native.state, 'bound', 'no BOOP main Session identity yet → binding is not faked')
  assert.ok(['pending-session', 'unbound'].includes(status.native.state), status.native.state)
  assert.equal(status.pocEndpoints.length, 1, 'the PoC endpoint is declared but closed')
})

test('E05-01 patrol is read-only: no ledger row changes and no model call', async () => {
  await ok('boop/mainSession') // durable BOOP identity for the automation binding
  const before = ledgerCounts()
  const patrol = await ok('boopScheduler/patrolNow')
  const after = ledgerCounts()

  assert.equal(patrol.readOnly, true)
  assert.equal(patrol.modelCalls, 0, 'patrol never calls a model')
  assert.equal(typeof patrol.durationMs, 'number')
  assert.equal(patrol.writeMode.available, true)
  assert.equal(patrol.writeMode.value.enabled, false)
  assert.equal(patrol.lease.available, true)
  assert.equal(patrol.lease.value.held, true, 'this Host owns the writer lease')
  assert.equal(patrol.gate.value.armed, true)
  assert.equal(patrol.cursors.available, true)
  assert.deepEqual(patrol.notDone.length, 4)
  assert.deepEqual(after, before, `patrol must not write the ledger: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)

  const status = await ok('boopScheduler/status')
  assert.ok(status.patrol, 'status exposes the last patrol result')
  assert.equal(status.patrol.readOnly, true)
})

test('E05-01 native automation registers ONE task through the real schedule service', async () => {
  const bound = await ok('boopScheduler/automation', { request: { action: 'bind' } })
  assert.equal(bound.state, 'bound', JSON.stringify(bound))
  assert.equal(bound.available, true)
  assert.equal(bound.sessionId, 'boop-main')
  assert.ok(bound.taskId && bound.taskId.length > 0)
  assert.equal(bound.title, MARKER)
  assert.equal(bound.kind, 'daily')

  // The native service itself must show exactly our one task.
  const catalog = await ok('schedule/catalog')
  assert.ok(Array.isArray(catalog))
  const ours = catalog.filter((task) => task.title === MARKER)
  assert.equal(ours.length, 1, `exactly one BOOP task, no duplicates: ${JSON.stringify(catalog)}`)
  assert.equal(ours[0].id, bound.taskId)
  assert.equal(ours[0].sessionId, 'boop-main')
  assert.equal(ours[0].kind, 'daily')

  const again = await ok('boopScheduler/automation', { request: { action: 'bind' } })
  assert.equal(again.state, 'bound')
  assert.equal(again.taskId, bound.taskId, 'binding is idempotent: it adopts, never duplicates')
  const catalogAgain = await ok('schedule/catalog')
  assert.equal(catalogAgain.filter((task) => task.title === MARKER).length, 1)
})

test('E05-01 pause/resume/cancel are deterministic, scope-exact and allowed with write mode off', async () => {
  const auditBefore = ledgerCounts().audit_event

  const pausedAll = await ok('boopScheduler/pause', { request: { scope: { kind: 'all' } } })
  assert.equal(pausedAll.ok, true)
  assert.equal(pausedAll.action, 'pause')
  assert.equal(pausedAll.writeMode.enabled, false, 'a safety act does not require write mode')
  assert.equal(pausedAll.dispatch, 'gated (this row never dispatches)')
  assert.equal(pausedAll.paused.all, true)
  assert.equal(pausedAll.audit.sink, 'ledger', 'the control action was audited in the BOOP ledger')
  assert.ok(['pause'].includes(pausedAll.audit.event.kind.replace('scheduler/', '')))

  const statusPaused = await ok('boopScheduler/status')
  assert.equal(statusPaused.scheduler.paused.all, true)

  const resumedAll = await ok('boopScheduler/resume', { request: { scope: { kind: 'all' } } })
  assert.equal(resumedAll.ok, true)
  assert.equal(resumedAll.paused.all, false)

  const scopedPause = await ok('boopScheduler/pause', { request: { scope: { kind: 'session', id: 'session-precise' } } })
  assert.equal(scopedPause.ok, true)
  assert.deepEqual(scopedPause.paused.scopes, [{ kind: 'session', id: 'session-precise' }], 'exact scope, never expanded')
  const scopedResume = await ok('boopScheduler/resume', { request: { scope: { kind: 'session', id: 'session-precise' } } })
  assert.equal(scopedResume.paused.scopes.length, 0)

  const invalid = await ok('boopScheduler/pause', { request: { scope: { kind: 'session' } } })
  assert.equal(invalid.ok, false, 'a scope without an exact id is refused, never guessed')
  assert.equal(invalid.code, 'INVALID_SCOPE')

  const cancelled = await ok('boopScheduler/cancel', { request: { scope: { kind: 'all' } } })
  assert.equal(cancelled.ok, true)
  assert.deepEqual(cancelled.queuedRemoved, [])
  assert.deepEqual(cancelled.abortRequested, [])
  assert.match(cancelled.note, /nothing was running/u)

  const auditAfter = ledgerCounts().audit_event
  assert.ok(auditAfter > auditBefore, `control actions land audit rows (${auditBefore} -> ${auditAfter})`)
  const rows = ledgerRows("SELECT kind, actor FROM audit_event WHERE kind LIKE 'scheduler/%' ORDER BY rowid DESC LIMIT 10")
  assert.ok(rows.length >= 4, 'scheduler audit rows are visible in the ledger')
  assert.ok(rows.every((row) => row.actor === 'system'))

  const statusEnd = await ok('boopScheduler/status')
  assert.equal(statusEnd.writeMode.enabled, false, 'write mode is still false after control actions')
  assert.equal(statusEnd.scheduler.queue.total, 0)
})

test('E05-01 unbinding removes only the BOOP task from the native schedule', async () => {
  const unbound = await ok('boopScheduler/automation', { request: { action: 'unbind' } })
  assert.equal(unbound.state, 'unbound')
  assert.equal(unbound.taskId, null)
  const catalog = await ok('schedule/catalog')
  assert.equal(catalog.filter((task) => task.title === MARKER).length, 0, 'the BOOP task is gone')
})

test('E05-01 unauthenticated callers never reach the scheduler (401)', async () => {
  const anonymous = await anonymousRequest(`${base}/api/boopScheduler/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: 'boopScheduler/status', payload: { args: {} } }),
  })
  assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body).slice(0, 300))
})
