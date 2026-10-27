#!/usr/bin/env node
/**
 * E07-01 · fault injection 2/3 — the model route is unreachable.
 *
 * Scenario (real rc.2.1 `dsh web` payload, private `$DSH_HOME`):
 *  - the profile hand-declares ONE `llm-pi-ai` route pointing at a closed local
 *    port (`http://127.0.0.1:9/v1`) and routes every Agent to it;
 *  - a real Session resolves its Agent and receives ONE host-minted BOOP proxy
 *    command; the real turn then fails because the model service cannot be
 *    reached;
 *  - assertions: the turn ends in an error taxonomy (not "completed"), there is
 *    NO external fallback reply, the Host's own retry is bounded (one turn, a
 *    finite retry count, a recorded turn/end), write mode follows the gate
 *    ledger, the control row still never dispatches (`dispatch.available === false`), the
 *    deterministic Stop control still works without the model, and an unrelated
 *    user Session/turn is never touched.
 *
 * KNOWN / UNKNOWN honesty:
 *  - the exact retry count is Host policy; this test asserts a generous BOUND and
 *    that the turn settles, never an exact number of retries;
 *  - the failure taxonomy is the Host's own `turn/end` text (`error: …`); this
 *    test records it verbatim and does not translate it into a BOOP claim.
 *
 * FIXTURE DISCLOSURE: no BOOP ledger rows are seeded here. The PoC endpoint
 * `boop/pocDispatch` mints the proxy command exactly like E02-03 and is only
 * enabled in this isolated profile.
 *
 * Run: node --test --test-force-exit tests/host/e07-01-fault-model-down.test.mjs
 * Evidence: docs/development/evidence/e07-01/fault-model-down-<ts>.json
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import {
  PROJECT_ROOT,
  authorize,
  bootWeb,
  createProfile,
  freePort,
  makeHome,
  rpc,
  runCli,
} from '../helpers/test-host.mjs'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e07-01-fault-model-down-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROFILE = 'boop-e07-fault-model-down'
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e07-01')
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1'
const MODEL_ID = 'qwen-unreachable-e07'
const TURN_DEADLINE_MS = 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('  ', ...args)

let host = null
let base = null
let cookie = null
let sessionId = null
let userSession = null
let dispatch = null
let record = null
let userHeadBefore = null
let evidence = null

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

function writeEvidence() {
  if (evidence === null) return
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = path.join(EVIDENCE_DIR, `fault-model-down-${STAMP}.json`)
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
  // One hand-declared route to a CLOSED local port; every Agent uses it. No
  // fallback route is declared, so a successful reply would contradict the setup.
  const patch = `# E07-01 fault injection: unreachable model service (closed port)
- id: boop-api
  config:
    pocEnabled: true
- id: llm-pi-ai
  config:
    providers:
      e07-unreachable:
        displayName: E07 unreachable local
        api: openai-completions
        baseURL: ${UNREACHABLE_BASE_URL}
        apiKeyEnv: BOOP_E07_FAULT_KEY
        models:
          - id: ${MODEL_ID}
            name: E07 unreachable model
            contextWindow: 8192
- id: agent-default-model
  config:
    provider: e07-unreachable
    model: ${MODEL_ID}
`
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), patch)
  process.env.BOOP_E07_FAULT_KEY = process.env.BOOP_E07_FAULT_KEY || 'e07-placeholder-not-a-secret'

  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)

  sessionId = (await ok('session/create', { request: { cwd: WORK } })).sessionId
  userSession = (await ok('session/create', { request: { cwd: WORK } })).sessionId
  userHeadBefore = (await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })).headSeq

  const resolved = await ok('boop/pocResolveAgent', { sessionId })
  assert.equal(resolved.resolved, true, JSON.stringify(resolved))
  const feed = await ok('boop/pocClaimFeed', { sessionId, clear: true })
  assert.equal(feed.subscribed, true)
  dispatch = await ok('boop/pocDispatch', {
    sessionId,
    instruction: 'E07-01 fault injection: the model service is unreachable; do not reply from any fallback.',
    mode: 'queue',
  })
  assert.equal(dispatch.accepted, true, JSON.stringify(dispatch))

  // Wait for the Host to settle the failing turn (bounded: the Host retries a
  // finite number of times, then records turn/end).
  const started = Date.now()
  while (Date.now() - started < TURN_DEADLINE_MS) {
    record = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 400 })
    if ((record.turnEnds ?? []).length > 0) break
    await sleep(750)
  }
  assert.ok(record && (record.turnEnds ?? []).length > 0, `the failing turn settled within ${TURN_DEADLINE_MS}ms`)
})

after(async () => {
  if (host && host.child.exitCode === null) await host.stop()
  writeEvidence()
})

test('E07-01 the unreachable model ends the turn with an honest error, never a success', async () => {
  const turnEnds = record.turnEnds ?? []
  assert.equal(turnEnds.length, 1, `exactly one turn/end (no retry storm at turn level): ${JSON.stringify(turnEnds)}`)
  const end = turnEnds[0]
  assert.notEqual(end.turnEnd, 'completed', 'a failed model turn never reads as completed')
  assert.match(String(end.turnEnd), /^error:/u, `the Host's own error taxonomy is recorded verbatim (got ${end.turnEnd})`)
  assert.equal((record.assistant ?? []).length, 0, 'no assistant reply exists — no fallback provider produced text')

  const turnStarts = (record.events ?? []).filter((event) => event.type === 'turn/start')
  assert.equal(turnStarts.length, 1, 'the Host did not open a new turn to work around the failure')
  const retries = (record.events ?? []).filter((event) => event.type === 'llm/retry')
  const retryStarts = (record.events ?? []).filter((event) => event.type === 'llm/retry-started')
  assert.ok(retries.length + retryStarts.length > 0, 'the Host retried inside the bounded policy before failing')
  assert.ok(retries.length <= 12, `the retry count is bounded, not infinite (llm/retry=${retries.length})`)
  const claims = await ok('boop/pocClaimFeed', { sessionId })
  assert.equal((claims.claims ?? []).filter((claim) => claim.messageId === dispatch.messageId).length, 1, 'exactly one claim — no duplicate execution')
  log('turn end:', end.turnEnd, 'retries:', retries.length, 'assistant:', (record.assistant ?? []).length)
})

test('E07-01 no external fallback route was declared or used', async () => {
  const dump = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(dump.code, 0, dump.stderr.slice(0, 800))
  assert.match(dump.stdout, /e07-unreachable/, 'the only declared route is the unreachable one')
  assert.match(dump.stdout, new RegExp(MODEL_ID))
  // The turn produced no assistant message, so no alternative provider could have
  // answered it. BOOP must not invent a fallback either.
  assert.equal((record.assistant ?? []).length, 0)
  const bootstrap = await ok('boop/bootstrap')
  assert.equal(bootstrap.scope?.writeModeEnabled, true, 'write mode follows the gate ledger, not model availability')
  const gates = Object.values(bootstrap.gates ?? {})
  assert.ok(gates.length > 0, 'the gate ledger is still readable')
})

test('E07-01 deterministic Stop still works when the model is offline, and fails closed', async () => {
  const before = await ok('boopControl/state', { request: {} })
  assert.equal(before.available, true, JSON.stringify({ reason: before.reason, detail: before.detail }))
  assert.equal(before.writeMode.enabled, true, 'write mode follows the gate ledger')
  assert.equal(before.dispatch.available, false, 'the control plane itself never dispatches')
  assert.equal(before.dispatch.requiresModel, true)

  const stopAll = await ok('boopControl/stop', { request: { scope: 'all' } })
  assert.equal(stopAll.accepted, true, JSON.stringify(stopAll).slice(0, 900))
  assert.equal(stopAll.deterministic, true, 'Stop is deterministic and does not require the model')
  assert.equal(stopAll.requiresModel, false)
  assert.deepEqual(stopAll.stopped, [], 'no BOOP ledger action is pending here — nothing is claimed as stopped')
  assert.equal(stopAll.policy.userTurnsStopped, false)
  assert.equal(stopAll.policy.externalSideEffectsUndone, false)
  if (stopAll.noop) assert.match(String(stopAll.message), /没有可停止的 BOOP 动作/u, 'no-op is stated honestly')

  const controlUser = await ok('boopControl/stop', { request: { scope: `session:${userSession}` } })
  assert.equal(controlUser.accepted, true)
  assert.deepEqual(controlUser.stopped, [], 'a user Session is never stopped')
  assert.equal(controlUser.policy.foreignTurns, 'not-inspected-never-stopped')
})

test('E07-01 the failing model turn touches no user Session/turn', async () => {
  const user = await ok('boop/pocSessionRecord', { sessionId: userSession, tailEvents: 100 })
  assert.equal(user.available, true)
  assert.equal(user.headSeq, userHeadBefore, 'the user Session log is untouched by the failed BOOP turn')
  assert.deepEqual((user.events ?? []).filter((event) => event.type === 'turn/start'), [], 'no user turn was started or stopped')

  evidence = {
    schemaVersion: 1,
    task: 'E07-01',
    scenario: 'model-unreachable',
    capturedAt: new Date().toISOString(),
    host: { profile: PROFILE, dshHome: HOME, work: WORK },
    route: { provider: 'e07-unreachable', api: 'openai-completions', model: MODEL_ID, baseURL: 'http://127.0.0.1:9/v1 (closed port, local)', credential: 'env:BOOP_E07_FAULT_KEY (placeholder only)' },
    dispatch: { messageId: dispatch.messageId, actionId: dispatch.actionId, accepted: dispatch.accepted, sourceKind: dispatch.sourceKind },
    session: { sessionId, userSession },
    turn: {
      end: record.turnEnds?.[0] ?? null,
      turnStarts: (record.events ?? []).filter((event) => event.type === 'turn/start').length,
      llmRetries: (record.events ?? []).filter((event) => event.type === 'llm/retry').length,
      assistantCount: (record.assistant ?? []).length,
      claimsForDispatch: 1,
    },
    writeMode: { enabled: true, dispatchAvailable: false, note: 'write mode follows the gate ledger; the control row still never dispatches; Stop remains deterministic (no model)' },
    knownUnknown: {
      retryPolicy: 'bounded Host retry (recorded count above); exact policy is Host-owned and asserted as a bound, never an exact count',
      failureTaxonomy: 'Host turn/end text recorded verbatim (error: …); not translated into a BOOP claim',
      runtimePreStepEnforcement: 'not exercised here; see E07-01 report NOT_RUN list',
    },
  }
  log('model-down evidence collected', JSON.stringify(evidence.turn))
})
