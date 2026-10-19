#!/usr/bin/env node
/**
 * E00-02 · G04 closure — runtime `agent/pre-step` gate on the real rc.2.1 Host.
 *
 * Hook (verified against the installed payload's generated Cordis surface and
 * `@deepseek-ai/dsh-agent/README.md`):
 *
 *   'agent/pre-step' (waterfall):
 *     (payload: { agent, messages, turn, step, signal },
 *      next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
 *   PreStepDecision = { kind: 'reject' } | { kind: 'enter', messages, ... }
 *
 * The `boop-gate` row installs the listener. It runs after inbox claim and
 * `turn/start` but BEFORE `step/start`, `agent/request`, `prepareCall()` and any
 * model request. Facts this file proves on a real Host:
 *
 *  1. composition: `boop-gate` row is composed exactly once and its listener is
 *     registered; `boopControl/recovery.runtimeEnforcement.composed` is `true`
 *     because of that real registration (not hard-coded);
 *  2. a BOOP proxy command dispatched WITHOUT release is held at admission: the
 *     durable log has no `step/start`, no `user/message` commit, no
 *     `request/header` and no assistant message; there is no model call;
 *  3. the human `boopControl/release` of that exact messageId admits the SAME
 *     claimed message exactly once (`step/start` + `user/message` with
 *     `source.kind=boop-command` appear); a later wake never re-executes it
 *     (consumed id registry), and the gate counters report allow=1;
 *  4. an unrelated plain user Session/message is never blocked (G04: the user's
 *     own tasks are not mis-blocked);
 *  5. fail-closed: (a) a wait timeout on an unreleased tracked command ends the
 *     turn as `blocked` with no step/model; (b) when the gate ledger itself is
 *     unavailable, a BOOP command is blocked immediately — no step/model — while
 *     a plain user message still runs;
 *  6. write mode stays OFF throughout; this gate never dispatches anything.
 *
 * HONEST BOUNDARY (asserted as facts, not hidden): rc.2.1 logs `turn/start`
 * before `agent/pre-step`, and the inbox claim has already removed the batch, so
 * a veto is "no step / no user commit / no model" rather than "no turn start".
 * A rejected claim is NOT resurrected; the evidence states that limitation.
 *
 * Run: node --test --test-concurrency=1 --test-force-exit tests/host/e00-02-pre-step-gate.test.mjs
 * Evidence: docs/development/evidence/e00-02/pre-step-<ts>.json
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
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/g04-pre-step-' + Date.now())
const HOME = path.join(WORK, 'main-home')
const PROFILE = 'boop-g04-pre-step'
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'docs/development/evidence/e00-02')
const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const REAL_MODEL = BASE_URL !== '' && MODEL_ID !== ''
const TURN_TIMEOUT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('  ', ...args)

let host = null
let base = null
let cookie = null
let sessionId = null
let userSession = null
let dispatch = null
let evidence = {
  schemaVersion: 1,
  task: 'G04/E00-02',
  scenario: 'agent-pre-step-runtime-gate',
  capturedAt: new Date().toISOString(),
  hook: {
    name: 'agent/pre-step',
    mode: 'waterfall',
    source: '@deepseek-ai/dsh-agent/README.md + installed payload api-catalog (rc.2.1)',
    decision: "{ kind: 'reject' } | { kind: 'enter', messages, startsRequestSeries? }",
    beforeModel: true,
    boundary:
      'turn/start + inbox claim happen before pre-step; a veto means no step/start, no user/message commit and no model request (durable turn/end reason blocked)',
  },
  host: { profile: PROFILE, dshHome: HOME, work: WORK, realModelOptIn: REAL_MODEL },
}

async function call(endpoint, args = {}) {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 800)}`)
  return body
}

async function ok(endpoint, args = {}) {
  const body = await call(endpoint, args)
  assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result).slice(0, 1400)}`)
  return body.result.value
}

async function record(session) {
  return await ok('boop/pocSessionRecord', { sessionId: session, tailEvents: 400 })
}

function eventTypes(rec) {
  return (rec.events ?? []).map((event) => event.type)
}

function hasModelOrStep(rec) {
  const types = eventTypes(rec)
  return {
    stepStart: types.includes('step/start'),
    requestHeader: types.includes('request/header'),
    request: types.includes('request/header') || types.includes('request/context'),
    userCommit: (rec.userMessages ?? []).length > 0,
    assistant: (rec.assistant ?? []).length > 0,
  }
}

async function waitFor(condition, what, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await condition()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function waitForTurnEnd(session, timeoutMs = TURN_TIMEOUT_MS) {
  return await waitFor(async () => {
    const rec = await record(session)
    return (rec.turnEnds ?? []).length > 0 ? rec : null
  }, `turn/end for ${session}`, timeoutMs)
}

async function gateStatus() {
  return await ok('boopGate/status', { request: {} })
}

async function controlRecovery() {
  return await ok('boopControl/recovery', { request: {} })
}

async function dispatchUnreleased(session, instruction) {
  const dispatched = await ok('boop/pocDispatch', {
    sessionId: session,
    instruction,
    mode: 'queue',
    release: false,
  })
  assert.equal(dispatched.accepted, true, JSON.stringify(dispatched))
  assert.equal(dispatched.gateState, 'blocked', 'the command is NOT released, so the gate tracks it as blocked')
  return dispatched
}

async function createSession() {
  return (await ok('session/create', { request: { cwd: WORK } })).sessionId
}

async function sendUserMessage(session, text, tag) {
  const accepted = await ok('session/prompt', {
    request: {
      requestId: `g04-${tag}-${Date.now()}`,
      sessionId: session,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  assert.equal(accepted.accepted, true)
}

/** Boot a second isolated Host for one fail-closed scenario. */
async function bootScenario(tag, gateConfig) {
  const scenarioHome = path.join(WORK, `${tag}-home`)
  const scenarioProfile = `${PROFILE}-${tag}`
  makeHome(scenarioHome)
  await createProfile(scenarioHome, scenarioProfile, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.writeFileSync(
    path.join(scenarioHome, 'profiles', scenarioProfile, 'cordis.patch.yml'),
    `# G04 fail-closed scenario: ${tag}\n- id: boop-api\n  config:\n    pocEnabled: true\n- id: boop-gate\n  config:\n${gateConfig}`,
  )
  const scenarioHost = await bootWeb({ home: scenarioHome, profile: scenarioProfile, port: await freePort(), timeoutMs: 180_000 })
  const scenarioCookie = await authorize(scenarioHost.base, scenarioHost.token)
  return {
    home: scenarioHome,
    profile: scenarioProfile,
    host: scenarioHost,
    call: async (endpoint, args = {}) => {
      const { status, body } = await rpc(scenarioHost.base, scenarioCookie, endpoint, args)
      assert.equal(status, 200, `${endpoint} -> HTTP ${status}`)
      return body
    },
    ok: async (endpoint, args = {}) => {
      const { status, body } = await rpc(scenarioHost.base, scenarioCookie, endpoint, args)
      assert.equal(status, 200, `${endpoint} -> HTTP ${status}`)
      assert.equal(body.result.ok, true, `${endpoint} failed: ${JSON.stringify(body.result).slice(0, 1200)}`)
      return body.result.value
    },
  }
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  const routePatch = REAL_MODEL
    ? `- id: llm-pi-ai
  config:
    providers:
      qwen-local:
        displayName: Qwen local (vLLM)
        api: openai-completions
        baseURL: ${BASE_URL}
        apiKeyEnv: BOOP_QWEN_KEY
        models:
          - id: ${MODEL_ID}
            name: Qwen local
            contextWindow: 196608
- id: agent-default-model
  config:
    provider: qwen-local
    model: ${MODEL_ID}
`
    : ''
  fs.writeFileSync(
    path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'),
    `# G04 main scenario (poc opt-in for the shipped dispatch/claim/record endpoints)\n- id: boop-api\n  config:\n    pocEnabled: true\n- id: boop-gate\n  config:\n    waitTimeoutMs: 60000\n    pollMs: 50\n${routePatch}`,
  )
  if (REAL_MODEL) process.env.BOOP_QWEN_KEY = process.env.BOOP_QWEN_KEY || 'g04-placeholder-not-a-secret'

  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  base = host.base
  cookie = await authorize(base, host.token)

  sessionId = await createSession()
  userSession = await createSession()
  await ok('boop/pocResolveAgent', { sessionId })
  await ok('boop/pocClaimFeed', { sessionId, clear: true })
  dispatch = await dispatchUnreleased(sessionId, 'G04: this BOOP command is held until a human release.')
  // Wait until the runtime gate is actually holding the claimed batch.
  await waitFor(
    async () => (await gateStatus()).counters.boopMessages >= 1,
    'the pre-step gate to evaluate the BOOP claim',
    20_000,
  )
  await sleep(800)
})

after(async () => {
  if (host && host.child.exitCode === null) await host.stop()
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  const file = path.join(EVIDENCE_DIR, `pre-step-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`  evidence written: ${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}`)
})

/* ── 1. composition / real registration ──────────────────────────────── */

test('G04 the boop-gate row registers the official agent/pre-step waterfall exactly once', async () => {
  const output = host.diagnostics.out + host.diagnostics.err
  const warnings = output.split('\n').filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], `activation warnings:\n${warnings.join('\n')}`)
  assert.match(output, /dsh web:/)

  const compiled = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(compiled.code, 0, compiled.stderr)
  const lines = compiled.stdout.split('\n').map((line) => line.trim())
  for (const id of ['dsh-boop', 'boop-api', 'boop-gate', 'boop-control', 'boop-tasks']) {
    assert.equal(lines.filter((line) => line === `- id: ${id}`).length, 1, `${id} is composed exactly once`)
  }

  const status = await gateStatus()
  assert.equal(status.registered, true)
  assert.equal(status.hook, 'agent/pre-step')
  assert.equal(status.mode, 'waterfall')
  assert.equal(status.gateAvailable, true)
  assert.equal(status.armed, true)
  assert.equal(status.runtimeEnforcement.composed, true)

  // The control plane reports the SAME live fact, not a hard-coded value.
  const recovery = await controlRecovery()
  assert.equal(recovery.available, true)
  assert.equal(recovery.recovery.armed, true)
  assert.equal(recovery.recovery.runtimeEnforcement.composed, true)
  assert.match(recovery.recovery.runtimeEnforcement.detail, /agent\/pre-step/)
  const blockedEntry = (recovery.recovery.entries ?? []).find((entry) => entry.messageId === dispatch.messageId)
  assert.ok(blockedEntry, 'the unreleased command is in the real gate ledger')
  assert.equal(blockedEntry.state, 'blocked')

  evidence.composition = {
    rows: ['dsh-boop', 'boop-api', 'boop-gate', 'boop-control', 'boop-tasks'],
    status,
    controlRuntimeEnforcement: recovery.recovery.runtimeEnforcement,
    blockedEntry,
  }
})

/* ── 2. held before any step/model ───────────────────────────────────── */

test('G04 an unreleased BOOP command is held: no step/start, no user commit, no model request', async () => {
  const rec = await record(sessionId)
  const facts = hasModelOrStep(rec)
  const types = eventTypes(rec)
  assert.ok(types.includes('turn/start'), 'rc.2.1 logs turn/start before pre-step (documented boundary)')
  assert.ok(types.includes('agent/inbox/spliced'), 'the inbox claim happened before the waterfall')
  assert.equal(facts.stepStart, false, 'no step/start while the command is unreleased')
  assert.equal(facts.request, false, 'no agent/request / request header reached the model call')
  assert.equal(facts.userCommit, false, 'the BOOP message is NOT committed as a user/message')
  assert.equal(facts.assistant, false, 'no assistant message exists')
  assert.deepEqual(rec.turnEnds ?? [], [], 'the turn is held at pre-step (no turn/end while waiting)')

  const claims = await ok('boop/pocClaimFeed', { sessionId })
  assert.equal((claims.claims ?? []).filter((claim) => claim.messageId === dispatch.messageId).length, 1, 'exactly one claim (runtime), no execution')

  const status = await gateStatus()
  assert.equal(status.counters.boopMessages, 1)
  assert.equal(status.counters.allowed, 0, 'nothing was allowed before the human release')
  assert.equal(status.lastDecision, null, 'no reject decision was made while the gate is holding')
  assert.deepEqual(status.consumedMessageIds, [])

  evidence.held = { events: types, counters: status.counters, claims: claims.claims, turnEnds: rec.turnEnds }
})

/* ── 3. release → exactly one execution; then no duplicate ───────────── */

test('G04 explicit human release admits the SAME claimed message exactly once', async () => {
  const released = await ok('boopControl/release', { request: { messageIds: [dispatch.messageId] } })
  assert.equal(released.accepted, true, JSON.stringify(released).slice(0, 900))
  assert.deepEqual(released.released.map((entry) => entry.messageId), [dispatch.messageId])
  assert.equal(released.audit.recorded, true)
  assert.equal(released.audit.kind, 'control/gate-released')

  const settled = await waitForTurnEnd(sessionId)
  const types = eventTypes(settled)
  assert.ok(types.includes('step/start'), 'after release the step is admitted')
  assert.ok(types.includes('request/header'), 'the model request was actually prepared (attempt made)')
  const ownMessages = (settled.userMessages ?? []).filter((message) => message.messageId === dispatch.messageId)
  assert.equal(ownMessages.length, 1, 'the released BOOP message is committed as durable user/message exactly once')
  assert.equal(ownMessages[0].sourceKind, 'boop-command', 'provenance stays boop-command, never rewritten as user')
  if (REAL_MODEL) {
    assert.ok((settled.assistant ?? []).length >= 1, 'real-model opt-in: the released command produced one assistant reply')
  } else {
    assert.equal((settled.assistant ?? []).length, 0, 'without a usable model route the turn ends in error, not a fake reply')
    assert.match(String(settled.turnEnds.at(-1)?.turnEnd ?? ''), /^error:/u, 'the failure taxonomy is recorded verbatim')
  }

  const status = await gateStatus()
  assert.equal(status.counters.allowed, 1)
  assert.deepEqual(status.consumedMessageIds, [dispatch.messageId], 'the message id is consumed for the process lifetime')

  // A later wake must NOT execute the same message again.
  await sendUserMessage(sessionId, 'G04: ordinary follow-up wake after the released command.', 'wake')
  const second = await waitFor(async () => {
    const rec = await record(sessionId)
    return (rec.turnEnds ?? []).length >= 2 ? rec : null
  }, 'second turn/end after the follow-up wake', TURN_TIMEOUT_MS)
  const ownAfter = (second.userMessages ?? []).filter((message) => message.messageId === dispatch.messageId)
  assert.equal(ownAfter.length, 1, 'the released command was never re-executed after a later wake')
  const claims = await ok('boop/pocClaimFeed', { sessionId })
  assert.equal((claims.claims ?? []).filter((claim) => claim.messageId === dispatch.messageId).length, 1, 'no duplicate claim')
  const secondTurnStarts = (second.events ?? []).filter((event) => event.type === 'turn/start').length
  assert.equal(secondTurnStarts, 2, 'the later wake opened its own turn only')

  evidence.released = {
    receipt: released,
    turnEvents: types,
    ownMessages,
    counters: status.counters,
    consumedMessageIds: status.consumedMessageIds,
    secondWake: { headSeq: second.headSeq, ownMessageCount: ownAfter.length, claimsForCommand: 1, turnStarts: secondTurnStarts },
  }
})

/* ── 4. plain user message is never blocked ─────────────────────────── */

test('G04 an unrelated user message executes normally and is never blocked by the gate', async () => {
  const beforeStatus = await gateStatus()
  await sendUserMessage(userSession, 'G04: this is a normal human message; it must not be blocked.', 'user')
  const settled = await waitForTurnEnd(userSession)
  const types = eventTypes(settled)
  assert.ok(types.includes('step/start'), 'the user message reached a normal step')
  assert.ok(types.includes('request/header'), 'the user message reached the model request preparation')
  const mine = (settled.userMessages ?? []).filter((message) => /normal human message/u.test(String(message.text ?? '')))
  assert.equal(mine.length, 1, 'the user message is committed exactly once')
  assert.notEqual(mine[0].sourceKind, 'boop-command', 'a human message is never treated as a BOOP command')
  const afterStatus = await gateStatus()
  assert.ok(
    afterStatus.counters.passThroughBatches > beforeStatus.counters.passThroughBatches,
    'the gate observed a non-BOOP batch and passed it through',
  )
  assert.ok(afterStatus.counters.blocked >= beforeStatus.counters.blocked, 'no user-visible block happened for this path')

  evidence.userMessage = { events: types, committed: mine, beforeCounters: beforeStatus.counters, afterCounters: afterStatus.counters }
})

/* ── 5a. wait timeout is fail-closed (no step/model) ────────────────── */

test('G04 an unreleased command that times out fails closed (blocked turn, no step/model)', async () => {
  const scenario = await bootScenario('timeout', '    waitTimeoutMs: 900\n    pollMs: 50\n')
  try {
    const session = (await scenario.ok('session/create', { request: { cwd: WORK } })).sessionId
    const other = (await scenario.ok('session/create', { request: { cwd: WORK } })).sessionId
    await scenario.ok('boop/pocResolveAgent', { sessionId: session })
    await scenario.ok('boop/pocClaimFeed', { sessionId: session, clear: true })
    const unreleased = await scenario.ok('boop/pocDispatch', {
      sessionId: session,
      instruction: 'G04 timeout: never released.',
      mode: 'queue',
      release: false,
    })
    const settled = await waitFor(async () => {
      const rec = await scenario.ok('boop/pocSessionRecord', { sessionId: session, tailEvents: 400 })
      return (rec.turnEnds ?? []).length > 0 ? rec : null
    }, 'blocked turn/end after the release timeout', 30_000)
    const types = eventTypes(settled)
    assert.equal(settled.turnEnds.at(-1)?.turnEnd, 'blocked', 'the turn ends as blocked')
    assert.equal(types.includes('step/start'), false, 'no step was opened')
    assert.equal(types.includes('request/header'), false, 'no model request was prepared')
    assert.equal((settled.userMessages ?? []).length, 0, 'nothing was committed to history')
    assert.equal((settled.assistant ?? []).length, 0)
    assert.equal((settled.events ?? []).filter((event) => event.type === 'turn/start').length, 1)

    const status = await scenario.ok('boopGate/status', { request: {} })
    assert.equal(status.counters.blocked, 1)
    assert.equal(status.counters.timeouts, 1, 'timeout counted once')
    assert.match(String(status.lastDecision?.reason ?? ''), /release-timeout/u)
    const recovery = await scenario.ok('boopControl/recovery', { request: {} })
    assert.equal(recovery.recovery.runtimeEnforcement.composed, true)

    // The rejected claim is NOT resurrected (known rc.2.1 boundary): a later
    // human release plus a new wake must not execute it.
    await scenario.ok('boopControl/release', { request: { messageIds: [unreleased.messageId] } })
    await scenario.ok('session/prompt', {
      request: { requestId: `g04-timeout-wake-${Date.now()}`, sessionId: session, mode: 'queue', content: [{ type: 'text', text: 'wake after timeout' }], clientTimeZone: 'Asia/Shanghai' },
    })
    const afterWake = await waitFor(async () => {
      const rec = await scenario.ok('boop/pocSessionRecord', { sessionId: session, tailEvents: 400 })
      return (rec.turnEnds ?? []).length >= 2 ? rec : null
    }, 'second turn after the wake', 30_000)
    assert.equal(
      (afterWake.userMessages ?? []).filter((message) => message.messageId === unreleased.messageId).length,
      0,
      'the timed-out command was not executed by a later wake',
    )

    // A user message on the same scenario Host still runs normally.
    await scenario.ok('session/prompt', {
      request: { requestId: `g04-timeout-user-${Date.now()}`, sessionId: other, mode: 'queue', content: [{ type: 'text', text: 'normal user message in the timeout scenario' }], clientTimeZone: 'Asia/Shanghai' },
    })
    const userRec = await waitFor(async () => {
      const rec = await scenario.ok('boop/pocSessionRecord', { sessionId: other, tailEvents: 200 })
      return (rec.turnEnds ?? []).length > 0 ? rec : null
    }, 'user turn end in the timeout scenario', 30_000)
    assert.ok(eventTypes(userRec).includes('step/start'), 'plain user messages are still admitted')

    evidence.timeoutScenario = {
      turnEnd: settled.turnEnds.at(-1),
      blockedEvents: types,
      counters: status.counters,
      lastDecision: status.lastDecision,
      afterWakeOwnMessageCount: 0,
      userMessageAdmitted: true,
    }
  } finally {
    await scenario.host.stop()
  }
})

/* ── 5b. unavailable gate → fail-closed for BOOP, pass-through for user ─ */

test('G04 an unavailable gate fails closed for BOOP commands and still passes user messages', async () => {
  const scenario = await bootScenario('unavailable', '    waitTimeoutMs: 5000\n    pollMs: 50\n    simulateGateUnavailable: true\n')
  try {
    const session = (await scenario.ok('session/create', { request: { cwd: WORK } })).sessionId
    const other = (await scenario.ok('session/create', { request: { cwd: WORK } })).sessionId
    await scenario.ok('boop/pocResolveAgent', { sessionId: session })
    await scenario.ok('boop/pocClaimFeed', { sessionId: session, clear: true })
    const unreleased = await scenario.ok('boop/pocDispatch', {
      sessionId: session,
      instruction: 'G04 unavailable-gate: must never execute.',
      mode: 'queue',
      release: false,
    })
    const settled = await waitFor(async () => {
      const rec = await scenario.ok('boop/pocSessionRecord', { sessionId: session, tailEvents: 400 })
      return (rec.turnEnds ?? []).length > 0 ? rec : null
    }, 'fail-closed turn/end with an unavailable gate', 30_000)
    const types = eventTypes(settled)
    assert.equal(settled.turnEnds.at(-1)?.turnEnd, 'blocked')
    assert.equal(types.includes('step/start'), false, 'no step with an unavailable gate')
    assert.equal(types.includes('request/header'), false, 'no model request with an unavailable gate')
    assert.equal((settled.userMessages ?? []).length, 0)
    assert.equal((settled.assistant ?? []).length, 0)

    const status = await scenario.ok('boopGate/status', { request: {} })
    assert.equal(status.registered, true, 'the listener is registered — the row is composed')
    assert.equal(status.gateAvailable, false, 'but the gate ledger itself is unavailable')
    assert.equal(status.runtimeEnforcement.composed, true, 'composed reflects registration, not gate availability')
    assert.match(String(status.lastDecision?.reason ?? ''), /gate-unavailable/u)
    assert.equal(status.counters.blocked, 1)

    // User messages are unaffected even while the gate ledger is unavailable.
    await scenario.ok('session/prompt', {
      request: { requestId: `g04-unavailable-user-${Date.now()}`, sessionId: other, mode: 'queue', content: [{ type: 'text', text: 'normal user message with unavailable gate' }], clientTimeZone: 'Asia/Shanghai' },
    })
    const userRec = await waitFor(async () => {
      const rec = await scenario.ok('boop/pocSessionRecord', { sessionId: other, tailEvents: 200 })
      return (rec.turnEnds ?? []).length > 0 ? rec : null
    }, 'user turn end with unavailable gate', 30_000)
    assert.ok(eventTypes(userRec).includes('step/start'), 'the human message is admitted')
    assert.equal((userRec.userMessages ?? []).length >= 1, true)

    evidence.unavailableScenario = {
      turnEnd: settled.turnEnds.at(-1),
      blockedEvents: types,
      status,
      userMessageAdmitted: true,
      unreleasedMessageId: unreleased.messageId,
    }
  } finally {
    await scenario.host.stop()
  }
})

/* ── 6. write mode stays off; this gate never dispatches ────────────── */

test('G04 the runtime gate never dispatches and write mode stays OFF', async () => {
  const bootstrap = await ok('boop/bootstrap')
  assert.equal(bootstrap.scope.writeModeEnabled, false)
  const control = await ok('boopControl/state', { request: {} })
  assert.equal(control.writeMode.enabled, false)
  assert.equal(control.dispatch.available, false)
  const status = await gateStatus()
  assert.equal(status.runtimeEnforcement.composed, true)
  evidence.writeMode = { bootstrap: bootstrap.scope.writeModeEnabled, control: control.writeMode.enabled, dispatch: { available: control.dispatch.available, reason: control.dispatch.reason } }
})

/* ── 7. real-model opt-in: released command gets one real reply ─────── */

test('G04 real-model opt-in: the released BOOP command produces exactly one assistant reply', { skip: REAL_MODEL ? false : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL for the real-model reply assertion (never faked)' }, async () => {
  const session = await createSession()
  await ok('boop/pocResolveAgent', { sessionId: session })
  await ok('boop/pocClaimFeed', { sessionId: session, clear: true })
  const dispatched = await dispatchUnreleased(session, '只回复 BOOP-G04-OK，不要调用工具，不要解释。')
  await waitFor(async () => (await gateStatus()).counters.boopMessages >= 1, 'gate evaluation for the opt-in command', 20_000)
  await ok('boopControl/release', { request: { messageIds: [dispatched.messageId] } })
  const settled = await waitForTurnEnd(session)
  const own = (settled.userMessages ?? []).filter((message) => message.messageId === dispatched.messageId)
  assert.equal(own.length, 1)
  const assistant = (settled.assistant ?? []).filter((message) => message.provider === 'qwen-local')
  assert.equal(assistant.length, 1, 'exactly one real-model reply for the single admitted command')
  evidence.realModel = { dispatched: dispatched.messageId, ownMessages: own, assistant: assistant.map((message) => ({ provider: message.provider, model: message.model, text: message.text })) }
})
