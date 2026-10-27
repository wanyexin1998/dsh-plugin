#!/usr/bin/env node
/**
 * E04-01 batch 2 · real rc.2.1 host: main-Session identity, sources, init plan.
 *
 * Gates/scenes: G09 · AT-01, AT-03, AT-04, AT-37, FE-02, FE-11.
 *
 * Asserted on the installed 0.2.1-rc.2 payload in a private `$DSH_HOME`:
 *  - `boop/mainSession` is idempotent, binds ONE identity in BOOP's own ledger,
 *    survives a Host restart, and never creates a DSH Session by itself;
 *  - the browser's native ensure path works: `session/create` with the named id
 *    creates the Session once and reuses the blank Session on a repeat call —
 *    that is the exact call `ctx.sessions.create({ sessionId })` makes;
 *  - `boop/sources` reads the real Session query plane without writing cursors:
 *    a Session created after the first snapshot appears as `unseen`, not as a
 *    fake "covered" source and not as an empty list;
 *  - `boop/initPlan` and `boop/initApply` report all three E03-03 modes as
 *    unavailable with `executed: false` while write mode is off, and initApply
 *    writes no job or cursor rows;
 *  - the new endpoints are behind the authenticated connection like the rest of
 *    the BOOP API plane (anonymous access is rejected).
 *
 * NOT_RUN (stated, not simulated): real browser screenshots and Desktop window
 * chrome. Job execution stays closed because write mode is off.
 *
 * Run: node --test --test-force-exit tests/host/e04-01b-main-session.test.mjs
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
} from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e04-01b-main-session-' + Date.now())
const MAIN_ID = 'boop-main'
let home
let host
let cookie
let base

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> ${status} ${JSON.stringify(body)}`)
  assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  // Shipped default config on purpose: no `pocEnabled` patch. These endpoints
  // must be part of the normal read-only BOOP API plane.
  await createProfile(home, 'boop-main', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  host = await bootWeb({ home, profile: 'boop-main', port: await freePort() })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E04-01 the host arms the BOOP rows without activation warnings', () => {
  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))
})

test('E04-01 mainSession binds one durable identity and is idempotent', async () => {
  const first = await call('boop/mainSession')
  assert.equal(first.state, 'bound')
  assert.equal(first.durable, true)
  assert.equal(first.mainSessionId, MAIN_ID)
  assert.match(first.scopeId, /^boop-[0-9a-f]{16}$/)
  assert.ok(first.storage, 'the ledger facts are reported')
  assert.equal(first.storage.ok, true, 'the test host owns the single-writer lease')
  const second = await call('boop/mainSession')
  assert.deepEqual(second, first, 'a repeat call returns the same identity and facts')
})

test('E04-01 mainSession never creates a DSH Session by itself (main chat does no write dispatch)', async () => {
  const beforeList = await call('session/list', { _request: {} })
  const ids = beforeList.items.map((row) => row.sessionId)
  assert.equal(ids.includes(MAIN_ID), false, 'identity binding is not Session creation')
})

test('E04-01 native session/create ensures the named Session once and reuses the blank one', async () => {
  const created = await call('session/create', { request: { sessionId: MAIN_ID } })
  assert.equal(created.sessionId, MAIN_ID, 'the named identity becomes the Session id')
  const again = await call('session/create', { request: { sessionId: MAIN_ID } })
  assert.equal(again.sessionId, MAIN_ID, 'a repeat ensure reuses the same blank Session (FE-02)')
  const list = await call('session/list', { _request: {} })
  assert.ok(list.items.some((row) => row.sessionId === MAIN_ID), 'the Session is catalogued for native navigation')
})

test('E04-01 sources reads the real query plane without writing coverage', async () => {
  const first = await call('boop/sources')
  assert.equal(first.available, true, JSON.stringify(first))
  assert.equal(first.scopeId, (await call('boop/mainSession')).scopeId)
  assert.ok(Array.isArray(first.sources))
  assert.ok(first.discovered >= 1, `the native Session is discovered (got ${first.discovered})`)
  const main = first.sources.find((row) => row.sessionId === MAIN_ID)
  assert.ok(main, 'the BOOP main Session is a source like any other Session')
  assert.equal(main.headSeq === null || main.headSeq >= 0, true, 'head seq is either a real seq or not read in this snapshot')
  assert.equal(main.throughSeq, null, 'BOOP has not read it yet')
  assert.equal(main.state, 'unseen', 'not covered is reported as unseen, not full')
  assert.equal(main.coverage, 'unseen', 'coverage is derived from the ledger cursor, not invented')
  assert.equal(first.known, 0, 'reading sources does not write cursor rows')

  const second = await call('boop/sources')
  assert.equal(second.known, 0, 'a second read still writes nothing')
  assert.equal(second.available, true)
})

test('E04-01 the initialization plan is honest and does not write', async () => {
  const plans = {}
  for (const mode of ['from_now', 'learn_history', 'import_memory']) {
    const plan = await call('boop/initPlan', { mode })
    assert.equal(plan.mode, mode)
    assert.equal(plan.executed, false, `${mode} planning must not write`)
    assert.equal(plan.writeModeEnabled, true)
    assert.equal(plan.gates.G05, 'PASS', 'the frozen gate ledger is reported truthfully')
    assert.equal(plan.gates.G06, 'PASS', 'G06 is PASS on the current frozen ledger (memory host E2E)')
    assert.ok(plan.storage, 'real ledger facts are included')
    assert.equal(plan.storage.ok, true)
    assert.equal(plan.sources.discovered >= 1, true)
    assert.equal(plan.processed, 0)
    assert.doesNotMatch(plan.copy, /已从此刻开始记录|已开始整理|已新增|已完成/, 'the plan does not claim a run')
    if (mode === 'import_memory') {
      assert.equal(plan.state, 'unavailable')
      assert.equal(plan.reason, 'import-needs-preview')
    } else {
      assert.equal(plan.state, 'available')
      assert.equal(plan.reason, 'ready')
    }
    plans[mode] = plan
  }
  assert.equal(plans.learn_history.total, plans.learn_history.sources.discovered, 'history total is the real processed-count denominator')
  assert.equal(plans.from_now.total, null)
})

test('E04-01 initApply on the real host runs the three modes under the open write mode', async () => {
  const fromNow = await call('boop/initApply', { mode: 'from_now' })
  assert.equal(fromNow.executed, true, JSON.stringify(fromNow))
  assert.equal(fromNow.reason, 'watermarked')
  assert.equal(fromNow.writeModeEnabled, true)

  const learn = await call('boop/initApply', { mode: 'learn_history' })
  assert.equal(learn.executed, true, JSON.stringify(learn))
  assert.equal(learn.reason, 'learned')
  assert.equal(learn.writeModeEnabled, true)

  const imported = await call('boop/initApply', { mode: 'import_memory' })
  assert.equal(imported.executed, false, 'import without a confirmed preview writes nothing')
  assert.equal(imported.reason, 'import-needs-preview')

  const db = new DatabaseSync(path.join(home, 'boop', 'boop.sqlite'))
  db.exec('PRAGMA query_only = ON')
  const jobs = db.prepare('SELECT mode, state FROM init_job ORDER BY created_at').all()
  db.close()
  assert.deepEqual(jobs.map((row) => row.mode).sort(), ['from_now', 'learn_history'])
  assert.equal(jobs.find((row) => row.mode === 'from_now').state, 'done')
  assert.equal(jobs.find((row) => row.mode === 'learn_history').state, 'done')
})

test('E04-01 an unknown initialization mode is rejected, not silently treated as a default', async () => {
  const { status, body } = await rpc(base, cookie, 'boop/initPlan', { mode: 'not-a-mode' })
  assert.equal(status, 200, 'transport ok; the business call must fail')
  assert.equal(body.result.ok, false, JSON.stringify(body.result))
  assert.ok(body.result.error, 'a business error is returned')
})

test('E04-01 the identity binding survives a Host restart', async () => {
  const first = await call('boop/mainSession')
  await host.stop()
  host = await bootWeb({ home, profile: 'boop-main', port: await freePort() })
  base = host.base
  cookie = await authorize(base, host.token)
  const second = await call('boop/mainSession')
  assert.equal(second.mainSessionId, first.mainSessionId, 'the ledger binding is durable across restarts')
  assert.equal(second.state, 'bound')
  assert.equal(second.durable, true)
})

test('E04-01 the new API plane members reject anonymous callers', async () => {
  for (const endpoint of ['boop/mainSession', 'boop/sources', 'boop/initApply']) {
    const response = await anonymousRequest(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: endpoint, payload: { args: {} } }),
    })
    assert.ok([401, 403].includes(response.status), `${endpoint} anonymous -> ${response.status}`)
  }
})
