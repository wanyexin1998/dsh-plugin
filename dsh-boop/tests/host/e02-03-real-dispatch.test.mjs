#!/usr/bin/env node
/**
 * E02-03 · REAL dispatch and reconciliation (real host + real Qwen model).
 *
 * Replaces the synthetic/unit evidence for the BOOP transport with a real run:
 * a real `dsh web` Host boots in a private `$DSH_HOME`, creates a real Session
 * whose Agent is routed to the user's self-hosted vLLM gateway through a
 * hand-declared `llm-pi-ai` route, receives ONE host-minted BOOP proxy command,
 * claims it in a real turn, answers with the real model, and every step is read
 * back from the durable Session log.
 *
 * Opt-in: the test talks to the user's real service and therefore SKIPS unless
 * `BOOP_QWEN_BASE_URL` and `BOOP_QWEN_MODEL` are set — it never fakes a PASS and
 * never falls back to a mock. The service needs no credential; `BOOP_QWEN_KEY`
 * may carry ANY non-empty placeholder because pi-ai's OpenAI-compatible path
 * requires a key field even for a keyless local gateway (README known
 * limitation). No real secret is ever read or written by this test.
 *
 * Run:
 *   $env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
 *   $env:BOOP_QWEN_MODEL="qwen3.8-27b"
 *   node --test --test-force-exit tests/host/e02-03-real-dispatch.test.mjs
 *
 * Optional evidence artifact (sanitized, no credential value):
 *   $env:BOOP_EVIDENCE_DIR="docs/development/evidence/e02-03"
 *
 * NOT_RUN (documented, not simulated):
 *  - re-execution of the SAME message id after a restart: the host inbox has no
 *    cross-turn dedupe by message id once a claim was drained; the idempotency
 *    key is BOOP's actionId at the dispatch layer, whose cross-run recovery is
 *    E03/E04 work not composed in this profile;
 *  - enforcement of `agent/pre-step` gate blocking for a real resumed Agent:
 *    `RecoveryGate.decide` exists and is unit-tested, but the runtime wiring into
 *    `agent/pre-step` is not composed yet, so this file proves the durable
 *    restart facts (nothing auto-executes; provenance survives) and reports the
 *    gate's own decision, never a fake runtime block.
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
import { PROXY_SOURCE_KIND } from '../../src/host/transport/command-envelope.ts'

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''
const SKIP = ENABLED
  ? false
  : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real dispatch test (opt-in; never faked)'
const KEY_ENV = 'BOOP_QWEN_KEY'
/** A local gateway ignores it; pi-ai requires the field to exist. Never a real secret. */
const KEY_PLACEHOLDER = 'boop-local-placeholder-not-a-secret'
const INSTRUCTION = '只回复 BOOP-OK 这 7 个字符，不要调用任何工具，不要解释，不要加标点。'
const TURN_TIMEOUT_MS = 90_000
const EVIDENCE_DIR = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e02-03-real-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROJECT = path.join(WORK, 'project')
const PROFILE = 'boop-poc-real'

let host = null
let cookie = null
let sessionId = null
let dispatch = null
let record = null
let claims = null
let turnMs = null
let storedHead = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function profilePatch() {
  // Sanitized configuration: the credential REFERENCE is recorded, the value is
  // an env var supplied by the test process only (placeholder, no real secret).
  // (No backticks below: this text lives inside a JS template literal.)
  return `# E02-03 REAL profile patch (isolated DSH_HOME only; never a user profile).
- id: boop-api
  config:
    pocEnabled: true

# Hand-declared pi-ai gateway route to the self-hosted vLLM service.
# api: openai-completions is a supported custom protocol; a declared route needs
# api, baseURL and a non-empty models list, so all three are present here.
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

# Every Agent this Host creates is routed to that real route.
- id: agent-default-model
  config:
    provider: qwen-local
    model: ${MODEL_ID}
`
}

async function call(endpoint, args = {}) {
  const { status, body } = await rpc(host.base, cookie, endpoint, args)
  return { status, body }
}

async function ok(endpoint, args = {}) {
  const { status, body } = await call(endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 800)}`)
  assert.equal(body?.result?.ok, true, `${endpoint} failed: ${JSON.stringify(body?.result ?? body).slice(0, 1200)}`)
  return body.result.value
}

async function waitForTurn(deadlineMs = TURN_TIMEOUT_MS) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    const current = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 200 })
    const feed = await ok('boop/pocClaimFeed', { sessionId })
    const claimed = (feed.claims ?? []).some((claim) => claim.messageId === dispatch.messageId)
    const answered = (current.assistant ?? []).length > 0
    const ended = (current.turnEnds ?? []).length > 0
    const drained = current.inbox !== null && current.inbox.nextTurn.length === 0 && current.inbox.nextStep.length === 0
    if (claimed && answered && ended && drained) {
      return { record: current, claims: feed, turnMs: Date.now() - started }
    }
    await sleep(500)
  }
  const last = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 200 })
  assert.fail(
    `the real model turn did not settle within ${deadlineMs}ms; events=${JSON.stringify(
      (last.events ?? []).map((event) => `${event.seq}:${event.type}`),
    )}`,
  )
}

function writeEvidenceArtifact(payload) {
  if (EVIDENCE_DIR === '') return
  const dir = path.resolve(PROJECT_ROOT, EVIDENCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `real-dispatch-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${file}`)
}

before(async () => {
  if (!ENABLED) return
  process.env[KEY_ENV] = process.env[KEY_ENV] || KEY_PLACEHOLDER
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.mkdirSync(PROJECT, { recursive: true })
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), profilePatch())
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  cookie = await authorize(host.base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E02-03 the real model route is configured in the isolated profile (no fallback route)', { skip: SKIP }, async () => {
  // The patch is the only model-routing input; the dump proves the Host accepted
  // it (a refused route cannot reach any turn) and that it is the declared one.
  const dump = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(dump.code, 0, dump.stderr.slice(0, 800))
  assert.match(dump.stdout, /qwen-local/)
  assert.match(dump.stdout, new RegExp(MODEL_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(dump.stdout, /pocEnabled: true/)
  // No DeepSeek credential exists in this environment, so a turn can only reply
  // if the hand-declared route is what actually served it.
  assert.doesNotMatch(dump.stderr, /MISSING_CREDENTIAL|UNKNOWN_MODEL/)
})

test('E02-03 a real Session resolves a live Agent through SessionController', { skip: SKIP }, async () => {
  const created = await ok('session/create', { request: { cwd: PROJECT } })
  assert.equal(typeof created.sessionId, 'string')
  assert.notEqual(created.sessionId, '')
  sessionId = created.sessionId

  const resolved = await ok('boop/pocResolveAgent', { sessionId })
  assert.equal(resolved.error, null)
  assert.equal(resolved.resolved, true, 'resolveAgent must succeed for a real Session')
  assert.equal(resolved.agentId, sessionId)
  assert.equal(path.resolve(resolved.cwd), path.resolve(PROJECT), 'the Agent runs in the test project, not the user workspace')
})

test('E02-03 dispatch is accepted with a host-minted BOOP provenance id', { skip: SKIP }, async () => {
  const feed = await ok('boop/pocClaimFeed', { sessionId, clear: true })
  assert.equal(feed.subscribed, true, 'the claim feed must be live before dispatch')

  dispatch = await ok('boop/pocDispatch', { sessionId, instruction: INSTRUCTION, mode: 'queue' })
  assert.equal(dispatch.error, null)
  assert.equal(dispatch.accepted, true, 'a resolvable Agent must accept the command')
  assert.match(dispatch.messageId, /^msg_act_[0-9a-f-]{36}$/u, 'the message id is host-minted, never model text')
  assert.match(dispatch.actionId, /^act_[0-9a-f-]{36}$/u)
  assert.equal(dispatch.sourceKind, PROXY_SOURCE_KIND)
  assert.notEqual(dispatch.sourceKind, 'user', 'a proxy command must never claim to be a human message')
  assert.equal(dispatch.agentResolved, true)
  assert.equal(dispatch.gateState, 'released', 'the operator act releases exactly this command')
})

test('E02-03 the real turn claims the command, the durable log keeps its provenance, and the real model replies', { skip: SKIP }, async () => {
  const settled = await waitForTurn()
  record = settled.record
  claims = settled.claims
  turnMs = settled.turnMs
  storedHead = record.headSeq

  // ── runtime claim (`agent/inbox/claimed`; not durable on rc.2.1) ──────────
  const matchingClaims = (claims.claims ?? []).filter((claim) => claim.messageId === dispatch.messageId)
  assert.equal(matchingClaims.length, 1, 'exactly one claim for the dispatched id — no duplicate execution')
  assert.equal(matchingClaims[0].sourceKind, PROXY_SOURCE_KIND)
  assert.equal(matchingClaims[0].actionId, dispatch.actionId)
  assert.equal(matchingClaims[0].sessionId, sessionId)
  assert.ok(matchingClaims[0].turn >= 1)

  // ── durable identity + provenance ────────────────────────────────────────
  assert.equal(record.available, true, JSON.stringify({ reason: record.reason, detail: record.detail }))
  const own = record.userMessages.filter((event) => event.messageId === dispatch.messageId)
  assert.equal(own.length, 1, 'the dispatched id appears exactly once in the durable log')
  assert.equal(own[0].sourceKind, PROXY_SOURCE_KIND, 'durable source.kind is boop-command, never user')
  assert.notEqual(own[0].sourceKind, 'user')
  assert.equal(own[0].actionId, dispatch.actionId)
  assert.match(String(own[0].text ?? ''), /BOOP-OK|不要调用任何工具/u)

  // ── durable claim boundary: inbox splice insert, then the removing splice ─
  const splices = record.events.filter((event) => event.type === 'agent/inbox/spliced')
  const inserted = splices.find((event) => event.spliceTarget === 'next-turn' && (event.insertedIds ?? []).includes(dispatch.messageId))
  assert.ok(inserted, 'the Agent inbox recorded the durable insert of this message id')
  const removed = splices.find(
    (event) =>
      event.spliceTarget === 'next-turn' &&
      (event.insertedIds ?? []).length === 0 &&
      (event.removedCount ?? 0) >= 1 &&
      event.seq > inserted.seq,
  )
  assert.ok(removed, 'the claim drained the inbox durably (a later removing splice)')
  assert.ok(own[0].seq > removed.seq, 'the claimed message is appended only after the drain')

  // ── the real model actually answered through the declared route ──────────
  assert.ok(record.assistant.length >= 1, 'the real model must produce an assistant message')
  const reply = record.assistant.at(-1)
  assert.equal(reply.provider, 'qwen-local', 'the reply came from the hand-declared route, not a fallback')
  assert.equal(reply.model, MODEL_ID)
  assert.match(String(reply.text ?? ''), /BOOP-OK/u, 'the model obeyed the short reply instruction')
  const lastTurnEnd = record.turnEnds.at(-1)
  assert.ok(lastTurnEnd, 'the turn recorded its end')
  assert.equal(lastTurnEnd.turnEnd, 'completed', `turn ended abnormally: ${lastTurnEnd.turnEnd}`)
  assert.equal(lastTurnEnd.turn, matchingClaims[0].turn, 'claim turn and turn/end agree')

  // ── inbox consumed, never duplicated ─────────────────────────────────────
  assert.deepEqual(record.inbox?.nextTurn, [])
  assert.deepEqual(record.inbox?.nextStep, [])
  console.log(`  real turn: ${turnMs}ms, head seq ${record.headSeq}, reply ${JSON.stringify(reply.text)}`)

  writeEvidenceArtifact({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    route: {
      provider: 'qwen-local',
      api: 'openai-completions',
      model: MODEL_ID,
      baseURL: BASE_URL,
      credential: `env:${KEY_ENV} (placeholder value only; the service is keyless)`,
      contextWindowDeclared: 196608,
    },
    host: { profile: PROFILE, dshHome: HOME, project: PROJECT },
    session: { sessionId, headSeq: record.headSeq, turnMs },
    dispatch: {
      accepted: dispatch.accepted,
      messageId: dispatch.messageId,
      actionId: dispatch.actionId,
      sourceKind: dispatch.sourceKind,
      mode: dispatch.mode,
      gateState: dispatch.gateState,
      durationMs: dispatch.durationMs,
    },
    claims: claims.claims,
    durable: {
      userMessages: record.userMessages.map((event) => ({
        seq: event.seq,
        messageId: event.messageId,
        sourceKind: event.sourceKind,
        actionId: event.actionId,
      })),
      splices: record.events
        .filter((event) => event.type === 'agent/inbox/spliced')
        .map((event) => ({ seq: event.seq, target: event.spliceTarget, inserted: event.insertedIds, removedCount: event.removedCount })),
      assistant: record.assistant.map((event) => ({ seq: event.seq, provider: event.provider, model: event.model, text: event.text })),
      turnEnds: record.turnEnds.map((event) => ({ seq: event.seq, turn: event.turn, reason: event.turnEnd })),
      eventTypes: record.events.map((event) => `${event.seq}:${event.type}`),
    },
    turnMs,
  })
})

test('E02-03 after a Host restart the durable record survives and nothing re-executes on its own', { skip: SKIP }, async () => {
  await host.stop()
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 180_000 })
  cookie = await authorize(host.base, host.token)

  // A fresh process arms its own gate and adopts NOTHING from the previous run.
  const gate = await ok('boop/pocGateStatus')
  assert.equal(gate.gateArmed, true)
  assert.equal(gate.entries.length, 0, 'the restarted process adopted no previous command')
  assert.equal(gate.adoptedMessageIds.length, 0, 'no message id is carried over implicitly')

  // The durable log still carries the same provenance and the same reply.
  const afterRestart = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 200 })
  assert.equal(afterRestart.headSeq, storedHead, 'no event was appended by the restart itself')
  const own = afterRestart.userMessages.filter((event) => event.messageId === dispatch.messageId)
  assert.equal(own.length, 1)
  assert.equal(own[0].sourceKind, PROXY_SOURCE_KIND)
  assert.equal(own[0].actionId, dispatch.actionId)
  assert.equal(afterRestart.assistant.at(-1)?.provider, 'qwen-local')
  assert.match(String(afterRestart.assistant.at(-1)?.text ?? ''), /BOOP-OK/u)
  assert.equal(afterRestart.turnEnds.at(-1)?.turnEnd, 'completed')

  // Resuming the Agent (cold start) must not replay the already-claimed command.
  const resolved = await ok('boop/pocResolveAgent', { sessionId })
  assert.equal(resolved.resolved, true)
  await sleep(2000)
  const resumed = await ok('boop/pocSessionRecord', { sessionId, tailEvents: 200 })
  const EXECUTION_EVENTS = new Set([
    'turn/start',
    'agent/inbox/claimed',
    'user/message',
    'assistant/message',
    'turn/end',
    'tool/call',
    'tool/result',
  ])
  // `storedHead` is the turn/end seq of the recorded turn: only events AFTER it
  // belong to this process's resume lifecycle.
  const executedAfterRestart = resumed.events.filter(
    (event) => event.seq > storedHead && EXECUTION_EVENTS.has(event.type),
  )
  assert.deepEqual(
    executedAfterRestart.map((event) => `${event.seq}:${event.type}`),
    [],
    'a resumed Agent never re-executes a drained BOOP command',
  )
  // The durable prefix is unchanged; a cold resume may append its own marker.
  assert.ok(
    resumed.events.find((event) => event.seq === storedHead)?.type === 'turn/end',
    'the durable prefix still ends with the recorded turn/end',
  )
  const feed = await ok('boop/pocClaimFeed', { sessionId })
  assert.deepEqual(
    (feed.claims ?? []).filter((claim) => claim.messageId === dispatch.messageId),
    [],
    'the new process claimed nothing',
  )
})
