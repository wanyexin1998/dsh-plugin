#!/usr/bin/env node
/**
 * E03-02 · REAL model-side memory extraction (opt-in).
 *
 * Proves the model half of memory extraction end to end against the user's real
 * self-hosted Qwen service, with the REAL ledger and the REAL commit layer:
 *
 *  1. a real `dsh web` Host boots in a private `$DSH_HOME`, creates a real
 *     Session and records one short fact-bearing conversation (1 model call);
 *  2. the host is stopped and its durable plain-JSONL Session log is read back
 *     through the same `SourceReader` seam the observation plane uses;
 *  3. BOOP's own `MemoryExtractor` opens one constrained window, calls the real
 *     model ONCE under the 45s single permit, admits candidates that cite REAL
 *     event seqs, and commits them through the existing `MemoryCommitter`
 *     (CAS / evidence window / authority) into BOOP's ledger;
 *  4. the snapshot + evidence rows + processed watermark are asserted against
 *     the durable log, a second run is proven not to re-commit, and a failing
 *     extraction is proven to commit nothing and keep the watermark.
 *
 * Opt-in: without `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` every test SKIPS —
 * no mock is substituted and no PASS is faked. The service needs no
 * credential; `BOOP_QWEN_KEY` may be any placeholder because pi-ai-style
 * OpenAI clients require a key field (BOOP's own client uses `none`).
 *
 * Model calls: exactly two short calls (one host Agent turn for the fixture,
 * one extraction). Everything else is local.
 *
 * Run:
 *   $env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
 *   $env:BOOP_QWEN_MODEL="qwen3.8-27b"
 *   node --test --test-force-exit tests/host/e03-02-extraction-real.test.mjs
 *
 * Optional evidence artifact: $env:BOOP_EVIDENCE_DIR="docs/development/evidence/e03-02"
 *
 * NOT_RUN here (honest limits): a full DSH-Host wiring of the extraction job
 * (scheduler row / API endpoint) is E05-01 work; this file drives the job
 * in-process against the Host's own durable artifacts.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
} from '../helpers/test-host.mjs'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { SourceObserver, LedgerCursorStore } from '../../src/host/observe/observer.ts'
import { MemoryExtractor } from '../../src/host/memory/extractor.ts'
import { MemoryCommitter } from '../../src/host/memory/committer.ts'
import { ModelPermits } from '../../src/host/model/permits.ts'
import { NO_CREDENTIAL, createQwenClient } from '../../src/host/model/qwen-client.ts'

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''
const SKIP = ENABLED
  ? false
  : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real extraction test (opt-in; never faked)'
const KEY_ENV = 'BOOP_QWEN_KEY'
const KEY_PLACEHOLDER = 'boop-local-placeholder-not-a-secret'
const EVIDENCE_DIR = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e03-02-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROJECT = path.join(WORK, 'project')
const PROFILE = 'boop-mem-real'
const SESSIONS_ROOT = path.join(HOME, 'sessions')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')

const INSTRUCTION =
  '请只回复 OK，不要调用任何工具。请记住这些项目事实：BOOP 项目本阶段不部署生产环境；下周五之前要完成 E03-02 记忆抽取验收；当前唯一阻塞是共享 GPU 排队。'
const TURN_TIMEOUT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The isolated profile: plain-JSONL sessions + the real Qwen route. */
function profilePatch() {
  return `# E03-02 REAL memory extraction (isolated DSH_HOME only; never a user profile).
# Plain JSONL is configured so the durable Session log can be read back as
# stored text rather than through a codec — the evidence is the same bytes.
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS_ROOT.replace(/\\/g, '/')}'
    compression: none

# The host's title LLM would spend a model call on decoration; memory
# extraction is the only model work this test wants to budget.
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
`
}

/* ── durable plain-JSONL Session reader (SourceReader seam) ───────────── */

const SEMANTIC_TYPES = new Set(['user/message', 'assistant/message', 'turn/end', 'notice', 'user/approval'])

function listJsonl(root) {
  if (!fs.existsSync(root)) return []
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )
  return walk(root).filter((file) => file.endsWith('.jsonl'))
}

function readLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  assert.equal(header.type, 'session', `unexpected session log header in ${file}`)
  const events = lines.slice(1).map((line) => JSON.parse(line))
  return { header, events }
}

function textOfBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function semanticText(event) {
  switch (event.type) {
    case 'user/message':
      return textOfBlocks(event.data?.content)
    case 'assistant/message':
      return textOfBlocks(event.data?.message?.content)
    case 'turn/end':
      return event.data?.reason?.kind === 'error' ? String(event.data.reason.error?.message ?? '') : ''
    default:
      return ''
  }
}

function sourceKindOf(event) {
  if (event.type === 'user/message') return event.data?.source?.kind ?? undefined
  if (event.type === 'assistant/message') return event.data?.message?.source?.kind ?? 'model'
  return undefined
}

function generationOf(header) {
  const parent = header.parentSession === undefined ? '' : String(header.parentSession)
  return `${header.id}@${String(header.version ?? '')}:${String(header.createdAt ?? '')}:${parent}`
}

function createFileReader(root) {
  const load = () => {
    const map = new Map()
    for (const file of listJsonl(root)) {
      try {
        const { header, events } = readLog(file)
        map.set(String(header.id), { header, events, file })
      } catch {
        /* an unreadable log is not silently treated as empty: it is skipped and
           the discovery count proves the difference */
      }
    }
    return map
  }
  return {
    async listSources(options = {}) {
      const wanted = options.resolveHeadFor ?? new Set()
      return [...load().entries()].map(([sessionId, entry]) => ({
        sessionId,
        sourceGeneration: generationOf(entry.header),
        workspaceId: null,
        title: null,
        headSeq: wanted.has(sessionId) ? (entry.events.at(-1)?.seq ?? -1) : null,
      }))
    },
    async listEvents(sessionId, afterSeq, limit) {
      const entry = load().get(sessionId)
      if (!entry) return []
      return entry.events
        .filter((event) => Number(event.seq) > afterSeq)
        .slice(0, limit)
        .map((event) => {
          const text = semanticText(event)
          const sourceKind = sourceKindOf(event)
          return {
            seq: Number(event.seq),
            type: String(event.type),
            time: Number(event.time ?? 0),
            semantic: SEMANTIC_TYPES.has(event.type) && text.trim() !== '',
            ...(text.trim() === '' ? {} : { text }),
            ...(sourceKind === undefined ? {} : { sourceKind }),
          }
        })
    },
    eventsOf(sessionId) {
      return load().get(sessionId)?.events ?? []
    },
    files() {
      return listJsonl(root)
    },
  }
}

/* ── fixture ─────────────────────────────────────────────────────────── */

let fixture = null
let host = null

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
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
  const cookie = await authorize(host.base, host.token)
  const call = async (endpoint, args) => {
    const { status, body } = await rpc(host.base, cookie, endpoint, args)
    assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 500)}`)
    assert.equal(body?.result?.ok, true, `${endpoint} failed: ${JSON.stringify(body?.result ?? body).slice(0, 800)}`)
    return body.result.value
  }

  const created = await call('session/create', { request: { cwd: PROJECT } })
  const sessionId = created.sessionId
  assert.equal(typeof sessionId, 'string')

  const accepted = await call('session/prompt', {
    request: {
      requestId: `e03-02-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: INSTRUCTION }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  assert.equal(accepted.accepted, true)

  // Wait for the real turn to settle in the DURABLE log (plain JSONL appends).
  const reader = createFileReader(SESSIONS_ROOT)
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let events = []
  while (Date.now() < deadline) {
    events = reader.eventsOf(sessionId)
    if (events.some((event) => event.type === 'turn/end')) break
    await sleep(500)
  }
  assert.ok(
    events.some((event) => event.type === 'turn/end'),
    `the real model turn did not settle within ${TURN_TIMEOUT_MS}ms`,
  )
  await host.stop()
  host = null

  const files = reader.files()
  assert.equal(files.length, 1, `expected exactly one durable Session log, got ${JSON.stringify(files)}`)
  const logFile = files[0]
  const { header, events: durableEvents } = readLog(logFile)
  const userMessage = durableEvents.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  const assistantMessage = durableEvents.find((event) => event.type === 'assistant/message')
  assert.ok(userMessage, 'the fixture Session must carry a real human message')
  assert.ok(assistantMessage, 'the fixture Session must carry a real model reply')
  const assistantText = semanticText(assistantMessage)
  assert.match(assistantText, /OK/u, `the real model should have replied OK, got ${JSON.stringify(assistantText)}`)

  fixture = {
    sessionId,
    logFile,
    header,
    durableEvents,
    generation: generationOf(header),
    headSeq: durableEvents.at(-1).seq,
    userMessageSeq: userMessage.seq,
    assistantMessageSeq: assistantMessage.seq,
    assistantText,
    sha256: sha256(logFile),
    callCount: 0,
  }
  console.log(`  fixture: session ${sessionId}, head seq ${fixture.headSeq}, reply ${JSON.stringify(assistantText)}`)
})

after(async () => {
  await host?.stop()
})

/* ── in-process BOOP plane over the real ledger ──────────────────────── */

function openPlane() {
  const db = new BoopDatabase({ path: LEDGER })
  db.bootstrap()
  // Ledger row ids must be unique ACROSS processes/instances: the real store
  // expects BOOP's id source to be globally unique, so a per-instance counter
  // would collide with rows written by an earlier plane on the same ledger.
  const repo = new BoopRepository(db, undefined, () => `e03-02-${crypto.randomUUID()}`)
  const scopeRow = db.db.prepare('SELECT scope_id, owner_id FROM scopes LIMIT 1').get()
  assert.ok(scopeRow, 'the real Host must have created BOOP\'s scope row')
  const scopeId = String(scopeRow.scope_id)
  assert.match(scopeId, /^boop-[0-9a-f]{16}$/u)
  const cursors = new LedgerCursorStore(repo)
  const reader = createFileReader(SESSIONS_ROOT)
  const observer = new SourceObserver(scopeId, reader, cursors)
  return { db, repo, scopeId, cursors, reader, observer, close: () => db.close() }
}

function modelConfig() {
  return {
    providerId: 'qwen-local',
    modelId: MODEL_ID,
    credentialRef: NO_CREDENTIAL,
    baseUrl: BASE_URL,
    contextWindowTokens: 196608,
    declaredContext: '196k',
    quantization: '4bit',
    externalFallbackAllowed: false,
  }
}

/** Real client wrapped with a call counter (so "no extra call" is provable). */
function createCountingClient() {
  const real = createQwenClient(modelConfig())
  const counted = {
    config: real.config,
    calls: 0,
    requests: [],
    async chat(request) {
      counted.calls += 1
      counted.requests.push(request)
      return await real.chat(request)
    },
  }
  return counted
}

/** Scripted transport (NOT a model call): proves the failure policy locally. */
function createStubClient(content, finishReason = 'stop') {
  const stub = {
    config: modelConfig(),
    calls: 0,
    requests: [],
    async chat(request) {
      stub.calls += 1
      stub.requests.push(request)
      return {
        content,
        reasoning: null,
        toolCalls: [],
        finishReason,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        elapsedMs: 1,
      }
    },
  }
  return stub
}

function createExtractor(plane, client, onAudit) {
  return new MemoryExtractor({
    client,
    batch: plane.observer,
    cursors: plane.cursors,
    committer: new MemoryCommitter(plane.repo),
    store: plane.repo,
    permits: new ModelPermits({ softTimeoutMs: 45_000 }),
    config: {
      scopeId: plane.scopeId,
      owner: { type: 'session', id: fixture.sessionId },
      maxInputTokens: 12_000,
      maxOutputTokens: 2_048,
      softTimeoutMs: 45_000,
    },
    ...(onAudit === undefined ? {} : { onAudit }),
  })
}

function writeEvidenceArtifact(payload) {
  if (EVIDENCE_DIR === '') return
  const dir = path.resolve(PROJECT_ROOT, EVIDENCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `real-extraction-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${file}`)
}

/* ── tests ───────────────────────────────────────────────────────────── */

test('E03-02 the real host recorded a short fact-bearing Session in plain JSONL', { skip: SKIP }, async () => {
  assert.ok(fixture)
  const kinds = fixture.durableEvents.map((event) => event.type)
  assert.ok(kinds.includes('user/message'))
  assert.ok(kinds.includes('assistant/message'))
  assert.ok(kinds.includes('turn/end'))
  const userEvent = fixture.durableEvents.find((event) => event.seq === fixture.userMessageSeq)
  assert.match(textOfBlocks(userEvent.data.content), /不部署生产环境/u)
  assert.ok(fixture.headSeq > 0)
  assert.match(fixture.generation, new RegExp(`^${fixture.sessionId}@\\d+:\\d+`, 'u'))
})

test('E03-02 a failing extraction commits nothing and keeps the observation watermark', { skip: SKIP }, async () => {
  const plane = openPlane()
  try {
    const scan = await plane.observer.scan()
    assert.equal(scan.discovered, 1, 'the seeded Session must be discovered')
    assert.deepEqual(scan.fresh, [fixture.sessionId])
    const before = plane.cursors.all(plane.scopeId).find((row) => row.sessionId === fixture.sessionId)
    assert.equal(before.throughSeq, -1, 'a fresh source starts at -1')

    const stub = createStubClient('', 'stop')
    const extractor = createExtractor(plane, stub)
    const result = await extractor.extract({ sessionId: fixture.sessionId })
    assert.equal(result.status, 'invalid-output', JSON.stringify(result))
    assert.equal(result.reason, 'EMPTY_OUTPUT')
    assert.equal(result.formatFailures, 1)
    assert.equal(stub.calls, 1, 'the local stub answered once; no real model call was spent')

    const facts = plane.repo.facts(plane.scopeId, 'session', fixture.sessionId)
    assert.equal(facts.length, 0, 'an empty output never becomes a fact')
    assert.equal(plane.repo.latestMemorySnapshot(plane.scopeId, 'session', fixture.sessionId), null)
    const after = plane.cursors.all(plane.scopeId).find((row) => row.sessionId === fixture.sessionId)
    assert.equal(after.throughSeq, -1, 'the failure policy restores the watermark')
  } finally {
    plane.close()
  }
})

test('E03-02 the real model extracts facts that commit with a real evidence address', { skip: SKIP }, async () => {
  const plane = openPlane()
  try {
    await plane.observer.scan()
    const client = createCountingClient()
    const audits = []
    const extractor = createExtractor(plane, client, (event) => audits.push(event))
    const started = Date.now()
    const result = await extractor.extract({ sessionId: fixture.sessionId })
    const elapsedMs = Date.now() - started

    assert.equal(result.status, 'committed', JSON.stringify(result))
    assert.equal(client.calls, 1, 'exactly one real model call for the extraction')
    assert.ok(result.changeCount >= 1, 'at least one admitted fact')
    assert.equal(result.applied.length, result.changeCount)
    assert.equal(result.version, 1)
    assert.equal(result.model.providerId, 'qwen-local', 'the actual route is audited')
    assert.equal(result.model.modelId, MODEL_ID)
    assert.equal(result.model.attempts.length, 1)
    assert.ok(result.model.estimatedInputTokens > 0 && result.model.estimatedInputTokens <= 12_000)
    assert.ok(result.toSeq <= fixture.headSeq, 'the processed window never passes the durable head')
    assert.equal(result.fromSeq, -1)

    // Every fact carries real evidence inside the window, on a REAL semantic seq.
    const facts = plane.repo.facts(plane.scopeId, 'session', fixture.sessionId)
    assert.ok(facts.length >= 1, 'the ledger holds the committed facts')
    const evidence = plane.db.db
      .prepare('SELECT fact_id, scope_id, session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND session_id = ?')
      .all(plane.scopeId, fixture.sessionId)
    assert.ok(evidence.length >= facts.length, 'each admitted fact has evidence rows')
    const semanticSeqs = new Set(
      fixture.durableEvents
        .filter((event) => SEMANTIC_TYPES.has(event.type) && semanticText(event).trim() !== '')
        .map((event) => event.seq),
    )
    for (const row of evidence) {
      assert.equal(row.scope_id, plane.scopeId)
      assert.equal(row.session_id, fixture.sessionId)
      assert.ok(Number(row.seq) >= -1 && Number(row.seq) <= result.toSeq, `evidence seq ${row.seq} outside the processed window`)
      assert.ok(semanticSeqs.has(Number(row.seq)), `evidence seq ${row.seq} is not a real semantic event`)
      assert.match(String(row.source_hash), new RegExp(`^${fixture.generation}#`, 'u'))
    }
    const semanticEvents = [...semanticSeqs].sort((a, b) => a - b)
    assert.ok(semanticEvents.length >= 2, 'user + assistant events are both available as evidence')

    // The snapshot records exactly how far it was read (coverage, not a claim).
    const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', fixture.sessionId)
    assert.ok(snapshot, 'a memory snapshot exists')
    assert.ok(snapshot.body.length > 0)
    const coverageValues = Object.values(snapshot.coverage)
    assert.equal(coverageValues.length, 1)
    assert.equal(coverageValues[0].throughSeq, result.toSeq)
    assert.ok(coverageValues[0].throughSeq <= fixture.headSeq)

    // The processed watermark advanced to exactly the processed boundary.
    const cursor = plane.cursors.all(plane.scopeId).find((row) => row.sessionId === fixture.sessionId)
    assert.equal(cursor.throughSeq, result.toSeq)
    assert.equal(cursor.state, 'dirty')

    // The user's Session log was only ever READ: same bytes before and after.
    assert.equal(sha256(fixture.logFile), fixture.sha256, 'extraction never writes into the user Session')
    assert.equal(createFileReader(SESSIONS_ROOT).files().length, 1, 'no hidden Session/Agent was created')

    // The audit trail names the real route and the admitted count.
    const attemptAudit = audits.find((event) => event.kind === 'model/attempt')
    assert.equal(attemptAudit.providerId, 'qwen-local')
    assert.equal(attemptAudit.modelId, MODEL_ID)
    assert.ok(audits.some((event) => event.kind === 'extract/committed'))

    console.log(
      `  real extraction: ${elapsedMs}ms, ${result.changeCount} facts, window (-1..${result.toSeq}], ` +
        `input ~${result.model.estimatedInputTokens} tokens (estimate), head ${fixture.headSeq}`,
    )

    fixture.extraction = {
      result,
      facts: facts.map((fact) => ({ factId: fact.factId, kind: fact.kind, text: fact.text, authority: fact.authority, status: fact.status })),
      evidence: evidence.map((row) => ({ factId: row.fact_id, seq: Number(row.seq), sourceHash: row.source_hash })),
      snapshot: { version: snapshot.version, coverage: snapshot.coverage, body: snapshot.body },
      elapsedMs,
      inputTokensEstimated: result.model.estimatedInputTokens,
      modelCalls: 1,
    }
    writeEvidenceArtifact({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      route: { providerId: 'qwen-local', modelId: MODEL_ID, service: BASE_URL, credential: 'none (keyless)' },
      fixture: {
        sessionId: fixture.sessionId,
        generation: fixture.generation,
        headSeq: fixture.headSeq,
        userMessageSeq: fixture.userMessageSeq,
        assistantMessageSeq: fixture.assistantMessageSeq,
        assistantText: fixture.assistantText,
        logFileSha256: fixture.sha256,
      },
      extraction: {
        status: result.status,
        fromSeq: result.fromSeq,
        toSeq: result.toSeq,
        version: result.version,
        applied: result.applied,
        inputTokensEstimated: result.model.estimatedInputTokens,
        outputBudget: result.model.estimatedOutputBudget,
        attempts: result.model.attempts,
        elapsedMs,
      },
      facts: fixture.extraction.facts,
      evidence: fixture.extraction.evidence,
      snapshot: fixture.extraction.snapshot,
      modelCalls: { hostTurn: 1, extraction: 1 },
    })
  } finally {
    plane.close()
  }
})

test('E03-02 a second extraction finds nothing new: no model call, no duplicate commit', { skip: SKIP }, async () => {
  assert.ok(fixture?.extraction, 'the committed extraction fixture must exist')
  const plane = openPlane()
  try {
    const client = createCountingClient()
    const extractor = createExtractor(plane, client)
    const result = await extractor.extract({ sessionId: fixture.sessionId })
    assert.equal(result.status, 'no-op', JSON.stringify(result))
    assert.equal(client.calls, 0, 'nothing new means no model call')
    assert.equal(result.applied.length, 0)

    const facts = plane.repo.facts(plane.scopeId, 'session', fixture.sessionId)
    assert.equal(facts.length, fixture.extraction.facts.length, 'no duplicate facts were written')
    const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', fixture.sessionId)
    assert.equal(snapshot.version, 1, 'the snapshot version did not move')
    const cursor = plane.cursors.all(plane.scopeId).find((row) => row.sessionId === fixture.sessionId)
    assert.equal(cursor.throughSeq, fixture.extraction.result.toSeq, 'the watermark stays at the processed boundary')
  } finally {
    plane.close()
  }
})

test('E03-02 re-proposing the same fact keeps ONE fact row (stable identity, CAS/ledger dedupe)', { skip: SKIP }, async () => {
  assert.ok(fixture?.extraction, 'the committed extraction fixture must exist')
  const plane = openPlane()
  try {
    // Rewind the observation watermark and answer with the SAME fact text from a
    // scripted transport: the commit layer must keep one fact row (stable fact
    // id), never a duplicate, and record a new traceable snapshot version.
    const row = plane.cursors.all(plane.scopeId).find((entry) => entry.sessionId === fixture.sessionId)
    plane.cursors.write({
      scopeId: plane.scopeId,
      sessionId: fixture.sessionId,
      sourceGeneration: row.sourceGeneration,
      throughSeq: -1,
      state: 'dirty',
    })
    const firstFact = fixture.extraction.facts[0]
    const stub = createStubClient(
      JSON.stringify({
        facts: [
          {
            text: firstFact.text,
            kind: firstFact.kind,
            confidence: 0.9,
            evidenceSeq: fixture.userMessageSeq,
            authority: firstFact.authority,
          },
        ],
        unresolved: [],
      }),
    )
    const extractor = createExtractor(plane, stub)
    const result = await extractor.extract({ sessionId: fixture.sessionId })
    assert.equal(result.status, 'committed', JSON.stringify(result))
    assert.equal(stub.calls, 1)
    assert.equal(result.applied.length, 1)

    const facts = plane.repo.facts(plane.scopeId, 'session', fixture.sessionId)
    assert.equal(facts.length, fixture.extraction.facts.length, 'the same fact text/kind stays ONE row')
    const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', fixture.sessionId)
    assert.ok(snapshot.version >= 2, 'a re-commit is a new traceable version, not a second fact')
    assert.equal(sha256(fixture.logFile), fixture.sha256, 'still no write into the user Session')
  } finally {
    plane.close()
  }
})
