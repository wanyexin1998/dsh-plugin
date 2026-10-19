#!/usr/bin/env node
/**
 * E05-01 REAL background batch (opt-in, env identical to E05-00).
 *
 * Proves the scheduler's P3 background path end to end against the user's real
 * self-hosted Qwen service:
 *  1. a real Host records one short fact-bearing Session (1 model call);
 *  2. the real P1 wiring is observed: while the user message/turn is live the
 *     scheduler reports `foreground.active`, and it returns to idle after
 *     `turn/end` (no NEW background batch may start in between);
 *  3. `pocRunBackground` runs ONE bounded background batch through the REAL
 *     `MemoryExtractor` (E03-02) under the ONE shared permit → the real model →
 *     the real `MemoryCommitter` (1 model call), and the ledger facts/evidence
 *     /watermark are checked against the durable Session log;
 *  4. a second run is a `no-op` with ZERO model calls (no duplicate commit).
 *
 * Opt-in: without `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` every test SKIPS —
 * no mock is substituted and no PASS is faked.
 *
 * Run:
 *   $env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
 *   $env:BOOP_QWEN_MODEL="qwen3.8-27b"
 *   node --test --test-force-exit tests/host/e05-01-scheduler-real.test.mjs
 *
 * Optional evidence artifact: $env:BOOP_EVIDENCE_DIR="docs/development/evidence/e05-01"
 *
 * NOT_RUN here: the long-lived 60s patrol timer cadence (covered by unit/patrol
 * tests and the in-host patrol call), P2/P4 real work (their controllers are
 * later batches), concurrent foreground+background model calls (the permit is
 * proven serial in unit tests; real service preemption is never claimed).
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

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''
const SKIP = ENABLED
  ? false
  : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real background batch test (opt-in; never faked)'
const KEY_ENV = 'BOOP_QWEN_KEY'
const KEY_PLACEHOLDER = 'boop-local-placeholder-not-a-secret'
const EVIDENCE_DIR = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e05-01-real-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const SESSIONS = path.join(HOME, 'sessions')
const PROJECT = path.join(WORK, 'project')
const PROFILE = 'boop-sched-real'

const INSTRUCTION =
  '请只回复 OK，不要调用任何工具。请记住这些项目事实：BOOP 项目本阶段不部署生产环境；下周五之前要完成 E05-01 调度验收；当前唯一阻塞是共享 GPU 排队。'
const TURN_TIMEOUT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function profilePatch() {
  return `# E05-01 REAL scheduler evidence (isolated DSH_HOME only; never a user profile).
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS.replace(/\\/g, '/')}'
    compression: none

# A decorative title call would spend a model call this test does not need.
- id: session-title-llm
  disabled: true

- id: llm-pi-ai
  config:
    providers:
      qwen-local:
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

- id: boop-scheduler
  config:
    patrolTimer: false
    mergeWindowMs: 200
    maxJobAttempts: 1
    pocEnabled: true
    softTimeoutMs: 45000
    modelRoute:
      providerId: qwen-local
      modelId: ${MODEL_ID}
      baseUrl: ${BASE_URL}
      credentialRef: none
      contextWindowTokens: 196608
      declaredContext: 196k
`
}

/** Minimal durable JSONL reader (plain JSONL is configured for this profile). */
function sessionLogPath() {
  if (!fs.existsSync(SESSIONS)) return null
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )
  return walk(SESSIONS).find((file) => file.endsWith('.jsonl')) ?? null
}

function readEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  return lines.slice(1).map((line) => JSON.parse(line))
}

function textOfBlocks(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('')
    : ''
}

let fixture = null
let host = null
let cookie = null

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(host.base, cookie, endpoint, args)
  return { status, body }
}

const ok = async (endpoint, args = {}) => {
  const { status, body } = await call(endpoint, args)
  assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 600)}`)
  assert.equal(body?.result?.ok, true, `${endpoint} failed: ${JSON.stringify(body?.result ?? body).slice(0, 900)}`)
  return body.result.value
}

function ledgerQuery(sql, ...params) {
  const db = new DatabaseSync(LEDGER, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function writeEvidenceArtifact(payload) {
  if (EVIDENCE_DIR === '') return
  const dir = path.resolve(PROJECT_ROOT, EVIDENCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `real-background-${STAMP}.json`)
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

  const created = await ok('session/create', { request: { cwd: PROJECT } })
  const sessionId = created.sessionId
  const accepted = await ok('session/prompt', {
    request: {
      requestId: `e05-01-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: INSTRUCTION }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  assert.equal(accepted.accepted, true)

  // P1 wiring: a real user/message must arm the scheduler's foreground state.
  let foregroundSeen = false
  const turnDeadline = Date.now() + TURN_TIMEOUT_MS
  let logPath = null
  let events = []
  while (Date.now() < turnDeadline) {
    const status = await ok('boopScheduler/status')
    if (status.scheduler.foreground.active) foregroundSeen = true
    logPath = sessionLogPath()
    if (logPath !== null) {
      events = readEvents(logPath)
      if (events.some((event) => event.type === 'turn/end')) break
    }
    await sleep(200)
  }
  assert.equal(foregroundSeen, true, 'the real user message must put the scheduler in foreground (P1)')
  assert.ok(events.some((event) => event.type === 'turn/end'), `the real turn did not settle within ${TURN_TIMEOUT_MS}ms`)
  assert.ok(events.some((event) => event.type === 'assistant/message'), 'the real model must answer')

  // The end of the turn returns the scheduler to idle (bounded poll).
  let idle = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await ok('boopScheduler/status')
    if (!status.scheduler.foreground.active) {
      idle = true
      break
    }
    await sleep(100)
  }
  assert.equal(idle, true, 'turn/end must return the scheduler to idle')

  const userMessage = events.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  assert.ok(userMessage, 'the fixture Session must carry a real human message')
  fixture = {
    sessionId,
    logPath,
    headSeq: events.at(-1).seq,
    userMessageSeq: userMessage.seq,
    foregroundSeen: true,
    logSha256: null,
  }
  console.log(`  fixture: session ${sessionId}, head seq ${fixture.headSeq}, user seq ${fixture.userMessageSeq}`)
})

after(async () => {
  await host?.stop()
})

test('E05-01 the real Host reports the scheduler row with background batches opt-in', { skip: SKIP }, async () => {
  assert.ok(fixture)
  const status = await ok('boopScheduler/status')
  assert.equal(status.row, 'boop-scheduler')
  assert.equal(status.writeMode.enabled, false, 'write mode is still OFF')
  assert.equal(status.background.pocEnabled, true, 'the isolated profile explicitly enables background batches')
  assert.equal(status.background.modelRoute.providerId, 'qwen-local')
  assert.equal(status.background.modelRoute.modelId, MODEL_ID)
  assert.equal(status.background.modelRoute.credential, 'none')
  assert.equal(status.scheduler.foreground.active, false)
  assert.equal(status.scheduler.permits.active, 0)
  assert.equal(fixture.foregroundSeen, true)
})

test('E05-01 one real background batch extracts and commits facts with a real watermark', { skip: SKIP }, async () => {
  const statusBefore = await ok('boopScheduler/status')
  assert.equal(statusBefore.scheduler.recent.length, 0, 'no background batch ran before the explicit trigger')
  const started = Date.now()
  const run = await ok('boopScheduler/pocRunBackground', { request: { sessionId: fixture.sessionId } })
  const elapsedMs = Date.now() - started
  assert.equal(run.ok, true, JSON.stringify(run))
  assert.equal(run.state, 'completed')
  assert.ok(run.batch, 'a batch record is reported')
  assert.equal(run.batch.status, 'committed', JSON.stringify(run.batch))
  assert.equal(run.modelCalls, 1, 'exactly one real model call for the batch')
  assert.equal(run.batch.model.providerId, 'qwen-local', 'the actual route is audited')
  assert.equal(run.batch.model.modelId, MODEL_ID)
  assert.ok(run.batch.applied.length >= 1, 'at least one fact was admitted')
  assert.ok(run.batch.watermark, 'a watermark is reported')
  assert.ok(
    run.batch.watermark.after >= run.batch.watermark.before,
    `watermark must not move backwards: ${JSON.stringify(run.batch.watermark)}`,
  )
  assert.ok(run.batch.watermark.after <= fixture.headSeq, 'the processed boundary never passes the durable head')
  assert.equal(run.writeMode.enabled, false)

  // Ledger truth: facts, real evidence seq, snapshot coverage, cursor watermark.
  const scopeRows = ledgerQuery('SELECT scope_id FROM scopes LIMIT 1')
  const scopeId = String(scopeRows[0].scope_id)
  const facts = ledgerQuery('SELECT id, kind, text, status FROM fact WHERE scope_id = ? AND owner_type = ? AND owner_id = ?', scopeId, 'session', fixture.sessionId)
  assert.ok(facts.length >= 1, `the ledger must hold the committed facts: ${JSON.stringify(facts)}`)
  const evidence = ledgerQuery('SELECT fact_id, session_id, seq FROM fact_evidence WHERE scope_id = ? AND session_id = ?', scopeId, fixture.sessionId)
  assert.ok(evidence.length >= facts.length)
  for (const row of evidence) {
    assert.equal(row.session_id, fixture.sessionId)
    assert.ok(Number(row.seq) >= 0 && Number(row.seq) <= fixture.headSeq, `evidence seq ${row.seq} outside the durable log`)
  }
  assert.ok(
    evidence.some((row) => Number(row.seq) === fixture.userMessageSeq),
    'at least one fact cites the real user message seq',
  )
  const snapshots = ledgerQuery("SELECT version FROM memory_snapshot WHERE scope_id = ? AND owner_type = 'session' AND owner_id = ?", scopeId, fixture.sessionId)
  assert.ok(snapshots.length >= 1)
  const cursors = ledgerQuery('SELECT through_seq, state FROM source_cursor WHERE scope_id = ? AND session_id = ?', scopeId, fixture.sessionId)
  assert.equal(cursors.length, 1, 'the observation watermark lives in BOOP\'s own ledger')
  assert.equal(Number(cursors[0].through_seq), run.batch.watermark.after, 'the processed watermark advanced exactly to the batch boundary')
  assert.ok(Number(cursors[0].through_seq) <= fixture.headSeq)

  const occurredAt = new Date().toISOString()
  fixture.factCount = facts.length
  fixture.run = run
  fixture.scopeId = scopeId
  console.log(
    `  real background batch: ${elapsedMs}ms, ${run.batch.applied.length} facts, window after ${run.batch.watermark.after}, head ${fixture.headSeq}`,
  )
  writeEvidenceArtifact({
    schemaVersion: 1,
    occurredAt,
    route: { providerId: 'qwen-local', modelId: MODEL_ID, service: BASE_URL, credential: 'none (keyless)' },
    fixture: {
      sessionId: fixture.sessionId,
      headSeq: fixture.headSeq,
      userMessageSeq: fixture.userMessageSeq,
      foregroundObserved: fixture.foregroundSeen,
    },
    batch: {
      status: run.batch.status,
      applied: run.batch.applied,
      watermark: run.batch.watermark,
      model: run.batch.model,
      modelCalls: run.modelCalls,
      elapsedMs,
    },
    ledger: { facts, evidence, snapshots, cursors },
    modelCalls: { hostTurn: 1, backgroundBatch: 1 },
  })
})

test('E05-01 a second background batch is a no-op with ZERO model calls', { skip: SKIP }, async () => {
  assert.ok(fixture?.run && fixture.scopeId)
  const second = await ok('boopScheduler/pocRunBackground', { request: { sessionId: fixture.sessionId } })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.batch.status, 'no-op', 'nothing new means no extraction and no commit')
  assert.equal(second.modelCalls, 0, 'a no-op batch spends no model call')

  const status = await ok('boopScheduler/status')
  assert.ok(status.scheduler.recent.length >= 2, 'both batches stay in the recent history')
  assert.equal(status.scheduler.recent.at(-1).status, 'no-op')
  assert.equal(status.scheduler.permits.active, 0, 'the shared permit is released')
  assert.equal(status.scheduler.queue.total, 0)
  assert.equal(status.scheduler.recent.every((entry) => entry.model.providerId === 'qwen-local'), true, 'every batch audits the real route')

  const factsAfter = ledgerQuery(
    'SELECT count(*) c FROM fact WHERE scope_id = ? AND owner_type = ? AND owner_id = ?',
    fixture.scopeId,
    'session',
    fixture.sessionId,
  )
  assert.equal(Number(factsAfter[0].c), fixture.factCount, 'no duplicate facts were written')
})
