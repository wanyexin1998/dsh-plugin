#!/usr/bin/env node
/**
 * E03-04 in-host: layered project context and lightweight retrieval over the
 * REAL rc.2.1 Host ledger (G06 closure), plus one REAL Qwen extraction →
 * commit → retrieval closure (opt-in).
 *
 * What is real (no mock replaces it):
 *  - a real `dsh web` Host boots in a private `$DSH_HOME`; three fixture
 *    Sessions are created through the Host's own `session/create` +
 *    `session/prompt` RPC and land in the durable plain-JSONL Session log
 *    (`compression: none` on this isolated profile, so the evidence is the
 *    stored bytes). The Host has no model credential, so the fixture turns end
 *    with an honest `turn/end` error — no model capability is claimed;
 *  - BOOP's own observation plane discovers those Sessions and writes the real
 *    BOOP ledger before the Host stops;
 *  - after the stop, facts are seeded into the real ledger through the REAL
 *    `MemoryCommitter` (evidence addresses = the real durable user-message seqs,
 *    real source generations) and retrieval reads the REAL `fact`/`fact_evidence`
 *    rows through the REAL `ContextAssembler`;
 *  - the opt-in case calls the user's REAL Qwen service once for a bounded
 *    `MemoryExtractor` window, commits through the same committer, and retrieves
 *    the fresh fact with its real evidence address.
 *
 * Opt-in: without `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` the real-model tests
 * SKIP with a reason (no mock, no faked PASS). Exactly one model call is spent.
 *
 * Run: node --test --test-force-exit tests/host/e03-04-retrieval-in-host.test.mjs
 * Optional evidence: $env:BOOP_EVIDENCE_DIR="docs/development/evidence/e03-06"
 *
 * NOT_RUN (honest): the production query planner / derived-FTS index population
 * and rebuild (the delivered retrieval module is a pure assembler; the ledger
 * has no FTS trigger/binding yet); mandatory-constraint non-competition
 * (03§14) has no dedicated assembly rule; global/spec layers are preset facts,
 * not ledger rows, so only owner+workspace are ledger-backed.
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
  hostFacts,
  makeHome,
  rpc,
} from '../helpers/test-host.mjs'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { SourceObserver, LedgerCursorStore } from '../../src/host/observe/observer.ts'
import { MemoryCommitter } from '../../src/host/memory/committer.ts'
import { MemoryLifecycle } from '../../src/host/memory/lifecycle.ts'
import { ContextAssembler, consumedFactIds } from '../../src/host/memory/retrieval.ts'
import { MemoryExtractor } from '../../src/host/memory/extractor.ts'
import { ModelPermits } from '../../src/host/model/permits.ts'
import { NO_CREDENTIAL, createQwenClient } from '../../src/host/model/qwen-client.ts'

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''
const SKIP = ENABLED
  ? false
  : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real extraction→commit→retrieval closure (opt-in; never faked)'

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/g06-e03-04-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROJECT = path.join(WORK, 'project')
const PROFILE = 'boop-g06-retrieval'
const SESSIONS_ROOT = path.join(HOME, 'sessions')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const TURN_TIMEOUT_MS = 120_000

const INSTRUCTIONS = [
  '请记住这些项目事实：BOOP 项目本阶段不部署生产环境；下周五之前完成 E03-04 检索验收；当前唯一阻塞是共享 GPU 排队。',
  '请记住：项目目录结构采用 pnpm monorepo；旧方案是单会话汇报。',
  '请只回复 OK，不要调用工具。请记住：BOOP 项目本阶段不部署生产环境；E03-04 的验收标准是分层检索可复现；当前唯一阻塞是共享 GPU 排队。',
]

let host = null
let plane = null
const fixture = {
  sessions: [], // index 0 = owner facts, 1 = workspace facts, 2 = opt-in extraction target
  observation: null,
  diagnostics: '',
  evidence: { schemaVersion: 1, task: 'E03-04', capturedAt: null, route: ENABLED ? { service: BASE_URL, modelId: MODEL_ID } : null },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── isolated profile (plain JSONL; no provider credential) ──────────── */

function profilePatch() {
  return `# G06 E03-04 host-path retrieval (isolated DSH_HOME only; never a user profile).
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS_ROOT.replace(/\\/g, '/')}'
    compression: none

# No decoration model call; this profile has no provider credential, so the
# fixture turns settle with an honest "no API key" error (no model claim).
- id: session-title-llm
  disabled: true

- id: boop-api
  config:
    pocEnabled: true
`
}

/* ── durable plain-JSONL reader ──────────────────────────────────────── */

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
  return { header, events: lines.slice(1).map((line) => JSON.parse(line)) }
}

function generationOf(header) {
  const parent = header.parentSession === undefined ? '' : String(header.parentSession)
  return `${header.id}@${String(header.version ?? '')}:${String(header.createdAt ?? '')}:${parent}`
}

function textOfMessage(event) {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function semanticSeqsOf(events) {
  return events
    .filter(
      (event) =>
        event.type === 'user/message' &&
        event.data?.source?.kind === 'user' &&
        textOfMessage(event).trim() !== '',
    )
    .map((event) => Number(event.seq))
}

const SEMANTIC_TYPES = new Set(['user/message', 'assistant/message', 'turn/end', 'notice', 'user/approval'])

function semanticText(event) {
  if (event.type === 'user/message') return textOfMessage(event)
  if (event.type === 'assistant/message') {
    const blocks = event.data?.message?.content
    if (!Array.isArray(blocks)) return ''
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }
  if (event.type === 'turn/end') {
    return event.data?.reason?.kind === 'error' ? String(event.data.reason.error?.message ?? '') : ''
  }
  return ''
}

function sourceKindOf(event) {
  if (event.type === 'user/message') return event.data?.source?.kind ?? undefined
  if (event.type === 'assistant/message') return event.data?.message?.source?.kind ?? 'model'
  return undefined
}

function createDurableReader(root) {
  const load = () => {
    const map = new Map()
    for (const file of listJsonl(root)) {
      try {
        const { header, events } = readLog(file)
        map.set(String(header.id), { file, header, events })
      } catch {
        /* unreadable logs stay a real per-object failure, never silently empty */
      }
    }
    return map
  }
  const sessions = () =>
    [...load().entries()].map(([sessionId, entry]) => ({
      sessionId,
      file: entry.file,
      header: entry.header,
      events: entry.events,
      generation: generationOf(entry.header),
      headSeq: entry.events.length === 0 ? -1 : Number(entry.events[entry.events.length - 1].seq),
      semanticSeqs: semanticSeqsOf(entry.events),
    }))
  return {
    load,
    files: () => listJsonl(root),
    sessions,
    /** SourceReader seam used by the observation plane over the stored bytes. */
    async listSources(options = {}) {
      const wanted = options.resolveHeadFor ?? new Set()
      return sessions().map((session) => ({
        sessionId: session.sessionId,
        sourceGeneration: session.generation,
        workspaceId: null,
        title: null,
        headSeq: wanted.has(session.sessionId) ? session.headSeq : null,
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
    hashOf(file) {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    },
  }
}

function openPlane() {
  const db = new BoopDatabase({ path: LEDGER })
  db.bootstrap()
  const repo = new BoopRepository(db, undefined, () => `g06-${crypto.randomUUID()}`)
  const scopeRow = db.db.prepare('SELECT scope_id FROM scopes LIMIT 1').get()
  assert.ok(scopeRow, "the real Host must have created BOOP's scope row")
  const scopeId = String(scopeRow.scope_id)
  const reader = createDurableReader(SESSIONS_ROOT)
  const cursors = new LedgerCursorStore(repo)
  const observer = new SourceObserver(scopeId, reader, cursors)
  return { db, repo, scopeId, reader, cursors, observer, committer: new MemoryCommitter(repo), close: () => db.close() }
}

/* ── ledger seeding through the REAL committer ───────────────────────── */

function evidenceOf(session, seq) {
  return {
    scopeId: plane.scopeId,
    sessionId: session.sessionId,
    sourceGeneration: session.generation,
    seq,
    hash: `${session.generation}#${seq}`,
  }
}

function seedProposal(session, changes, overrides = {}) {
  return plane.committer.commit(
    {
      schemaVersion: 1,
      scopeId: plane.scopeId,
      sessionId: session.sessionId,
      sourceGeneration: session.generation,
      fromSeq: -1,
      toSeq: session.headSeq,
      baselineVersion: plane.repo.currentVersion(plane.scopeId, 'session', session.sessionId),
      changes,
      unresolved: [],
      ...overrides,
    },
    { type: 'session', id: session.sessionId },
  )
}

function ledgerChange(session, input) {
  const seq = input.seq ?? session.semanticSeqs[0] ?? 0
  return {
    op: input.op ?? 'add',
    factId: input.factId,
    kind: input.kind,
    text: input.text,
    authority: input.authority,
    evidenceRefs: [evidenceOf(session, seq)],
    supersedes: input.supersedes ?? [],
    ...(input.subjectKey === undefined ? {} : { subjectKey: input.subjectKey }),
  }
}

/** Context facts assembled from the REAL ledger rows + evidence addresses. */
function ledgerContextFacts() {
  const rows = []
  const layers = [
    [fixture.sessions[0], 'owner'],
    [fixture.sessions[1], 'workspace'],
  ]
  for (const [session, layer] of layers) {
    for (const fact of plane.repo.facts(plane.scopeId, 'session', session.sessionId)) {
      if (fact.status === 'tombstoned') continue
      const evidence = plane.db.db
        .prepare('SELECT session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND fact_id = ? ORDER BY rowid')
        .all(plane.scopeId, fact.factId)
        .map((row) => ({
          scopeId: plane.scopeId,
          sessionId: String(row.session_id),
          // The generation is the durable key prefix of source_hash (<gen>#<seq>).
          sourceGeneration: String(row.source_hash).split('#')[0],
          seq: Number(row.seq),
        }))
      rows.push({
        factId: fact.factId,
        layer,
        kind: fact.kind,
        text: fact.text,
        authority: fact.authority,
        status: fact.status,
        version: fact.version,
        evidence,
      })
    }
  }
  return rows
}

/** The BOOP preset's immutable safety rule — a global/spec fact, not a ledger row. */
function globalSpecFacts() {
  return [
    {
      factId: 'spec-immutable-safety',
      layer: 'global',
      kind: 'constraint',
      text: '记忆允许自主学习和纠错，但不能扩大权限或修改不可变安全规则',
      authority: 'user_confirmed',
      status: 'active',
      version: 1,
      evidence: [],
    },
  ]
}

function writeEvidenceArtifact(payload) {
  if (EVIDENCE_DIR === '') return
  const dir = path.resolve(PROJECT_ROOT, EVIDENCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `retrieval-in-host-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${file}`)
}

/* ── fixture ─────────────────────────────────────────────────────────── */

const reader = createDurableReader(SESSIONS_ROOT)

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })
  makeHome(HOME)
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  fs.writeFileSync(path.join(HOME, 'profiles', PROFILE, 'cordis.patch.yml'), profilePatch())

  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort(), timeoutMs: 240_000 })
  const cookie = await authorize(host.base, host.token)
  const call = async (endpoint, args = {}) => {
    const { status, body } = await rpc(host.base, cookie, endpoint, args)
    assert.equal(status, 200, `${endpoint} -> HTTP ${status} ${JSON.stringify(body).slice(0, 500)}`)
    assert.equal(body?.result?.ok, true, `${endpoint} failed: ${JSON.stringify(body?.result ?? body).slice(0, 800)}`)
    return body.result.value
  }

  const created = []
  for (const instruction of INSTRUCTIONS) {
    const session = await call('session/create', { request: { cwd: PROJECT } })
    const accepted = await call('session/prompt', {
      request: {
        requestId: `g06-e03-04-${created.length}-${Date.now()}`,
        sessionId: session.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: instruction }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    assert.equal(accepted.accepted, true)
    created.push({ sessionId: session.sessionId, instruction })
  }

  const deadline = Date.now() + TURN_TIMEOUT_MS
  let durable = new Map()
  while (Date.now() < deadline) {
    durable = reader.load()
    if (created.every((entry) => durable.get(entry.sessionId)?.events.some((event) => event.type === 'turn/end'))) break
    await sleep(500)
  }
  for (const entry of created) {
    const log = durable.get(entry.sessionId)
    assert.ok(log, `no durable Session log for ${entry.sessionId}`)
    assert.ok(
      log.events.some((event) => event.type === 'user/message' && textOfMessage(event) === entry.instruction),
      'the human-authored message must be durable',
    )
  }

  fixture.observation = await call('boop/observeSources')
  fixture.diagnostics = host.diagnostics.out + host.diagnostics.err
  await host.stop()
  host = null

  for (const entry of created) {
    const session = reader.sessions().find((row) => row.sessionId === entry.sessionId)
    assert.ok(session)
    fixture.sessions.push({ ...session, instruction: entry.instruction })
  }
  fixture.sessions.sort((a, b) => Number(a.header.createdAt) - Number(b.header.createdAt))

  plane = openPlane()
  console.log(`  fixture: ${fixture.sessions.length} real Sessions, scope ${plane.scopeId}`)
})

after(async () => {
  try {
    await host?.stop()
  } catch {
    /* already stopped */
  }
  if (EVIDENCE_DIR !== '' && plane) {
    fixture.evidence.capturedAt = new Date().toISOString()
    writeEvidenceArtifact(fixture.evidence)
  }
  plane?.close()
})

/* ── hermetic host-path retrieval ────────────────────────────────────── */

test('G06/E03-04 the real Host recorded durable Sessions that BOOP discovered', () => {
  const warnings = fixture.diagnostics
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))

  assert.equal(fixture.sessions.length, 3)
  for (const session of fixture.sessions) {
    assert.ok(session.semanticSeqs.length >= 1, 'each Session carries a real human message seq')
    assert.match(session.generation, new RegExp(`^${session.sessionId}@\\d+:\\d+`, 'u'))
  }
  const observed = fixture.observation
  assert.ok(observed.discovered >= 3)
  for (const session of fixture.sessions) {
    const row = observed.sources.find((source) => source.sessionId === session.sessionId)
    assert.ok(row, `Host did not discover ${session.sessionId}`)
    assert.equal(row.sourceGeneration, session.generation)
    assert.equal(row.throughSeq, -1)
  }
  assert.equal(plane.scopeId, observed.scopeId)

  fixture.evidence.host = hostFacts()
  fixture.evidence.sessions = fixture.sessions.map((session) => ({
    sessionId: session.sessionId,
    generation: session.generation,
    headSeq: session.headSeq,
    semanticSeqs: session.semanticSeqs,
  }))
  fixture.evidence.observation = { scopeId: observed.scopeId, discovered: observed.discovered }
})

test('G06/E03-04 facts seeded through the real committer carry real evidence addresses and generations', () => {
  const [ownerA, ownerB] = fixture.sessions
  const seqA = ownerA.semanticSeqs[0]
  const seqB = ownerB.semanticSeqs[0]

  const p1 = seedProposal(ownerA, [
    ledgerChange(ownerA, {
      factId: 'fact-owner-deploy',
      kind: 'decision',
      text: '本阶段不部署生产环境',
      authority: 'user_confirmed',
      subjectKey: 'deploy-policy',
      seq: seqA,
    }),
    ledgerChange(ownerA, {
      factId: 'fact-owner-deadline',
      kind: 'decision',
      text: '下周五之前完成 E03-04 检索验收',
      authority: 'user_exploration',
      subjectKey: 'deadline:e03-04',
      seq: seqA,
    }),
    ledgerChange(ownerA, {
      factId: 'fact-owner-blocker',
      kind: 'open_item',
      text: '当前唯一阻塞是共享 GPU 排队',
      authority: 'agent_reported',
      subjectKey: 'blocker:gpu',
      seq: seqA,
    }),
  ])
  assert.equal(p1.status, 'committed', JSON.stringify(p1))
  assert.deepEqual(p1.disputed, [], 'different subjects coexist active — the E03-02 disputed mis-flag is gone')
  const ownerFacts = plane.repo.facts(plane.scopeId, 'session', ownerA.sessionId)
  assert.equal(ownerFacts.length, 3)
  for (const fact of ownerFacts) assert.equal(fact.status, 'active')

  const p1b = seedProposal(ownerB, [
    ledgerChange(ownerB, {
      factId: 'fact-workspace-repo',
      kind: 'claim',
      text: '项目目录结构采用 pnpm monorepo',
      authority: 'tool_observed',
      subjectKey: 'repo-layout',
      seq: seqB,
    }),
    ledgerChange(ownerB, {
      factId: 'fact-old-plan',
      kind: 'decision',
      text: '旧方案：单会话汇报',
      authority: 'user_confirmed',
      seq: seqB,
    }),
  ])
  assert.equal(p1b.status, 'committed', JSON.stringify(p1b))

  // Real evidence rows: the real Session id, the real durable seq, and a
  // source_hash whose prefix is the real generation.
  const evidence = plane.db.db
    .prepare('SELECT fact_id, session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? ORDER BY fact_id')
    .all(plane.scopeId)
  assert.equal(evidence.length, 5)
  const byId = new Map(evidence.map((row) => [String(row.fact_id), row]))
  assert.equal(byId.get('fact-owner-deploy').session_id, ownerA.sessionId)
  assert.equal(Number(byId.get('fact-owner-deploy').seq), seqA)
  assert.equal(byId.get('fact-owner-deploy').source_hash, `${ownerA.generation}#${seqA}`)
  assert.equal(byId.get('fact-workspace-repo').session_id, ownerB.sessionId)
  assert.equal(byId.get('fact-workspace-repo').source_hash, `${ownerB.generation}#${seqB}`)
  const durableSeqs = new Set(reader.eventsOf(ownerA.sessionId).map((event) => Number(event.seq)))
  assert.ok(durableSeqs.has(Number(byId.get('fact-owner-deploy').seq)), 'evidence points at a real durable event')

  // The snapshot coverage names the REAL generation and the durable head.
  const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', ownerA.sessionId)
  assert.equal(snapshot.coverage[`${ownerA.sessionId}#${ownerA.generation}`].throughSeq, ownerA.headSeq)
  assert.ok(snapshot.body.includes('本阶段不部署生产环境'))

  fixture.evidence.seeding = {
    proposals: [p1.status, p1b.status],
    facts: ownerFacts.map((fact) => ({ factId: fact.factId, kind: fact.kind, status: fact.status })),
    evidenceRows: evidence.map((row) => ({ factId: row.fact_id, seq: Number(row.seq), sourceHash: row.source_hash })),
    snapshot: { coverage: snapshot.coverage, version: snapshot.version },
  }
})

test('G06/E03-04 a superseded value is retired but stays addressable in fact_version', () => {
  const [, ownerB] = fixture.sessions
  const result = seedProposal(ownerB, [
    ledgerChange(ownerB, {
      op: 'supersede',
      factId: 'fact-old-plan',
      kind: 'decision',
      text: '旧方案：单会话汇报（已被双会话方案取代）',
      authority: 'user_confirmed',
      supersedes: ['fact-old-plan'],
    }),
  ])
  assert.equal(result.status, 'committed', JSON.stringify(result))
  // A supersede updates the SAME fact id: the current row is the new value, and
  // every earlier value remains addressable in fact_version (never overwritten).
  const current = plane.repo.facts(plane.scopeId, 'session', ownerB.sessionId).find((fact) => fact.factId === 'fact-old-plan')
  assert.equal(current.status, 'active')
  assert.equal(current.text, '旧方案：单会话汇报（已被双会话方案取代）')
  const versions = plane.db.db
    .prepare('SELECT version, snapshot_json FROM fact_version WHERE scope_id = ? AND fact_id = ? ORDER BY version')
    .all(plane.scopeId, 'fact-old-plan')
  assert.ok(versions.length >= 2, 'the old version stays in the ledger')
  assert.ok(
    versions.some((row) => String(row.snapshot_json).includes('旧方案：单会话汇报')),
    'the retired text is still addressable',
  )
  const evidence = Number(
    plane.db.db
      .prepare('SELECT count(*) c FROM fact_evidence WHERE scope_id = ? AND fact_id = ?')
      .get(plane.scopeId, 'fact-old-plan').c,
  )
  assert.ok(evidence >= 2, 'each version keeps its evidence')

  fixture.evidence.supersede = {
    factId: 'fact-old-plan',
    currentText: current.text,
    status: current.status,
    versionRows: versions.length,
    evidenceRows: evidence,
  }
})

test('G06/E03-04 the same subject is disputed on the real ledger; different subjects are not', () => {
  const [ownerA, ownerB] = fixture.sessions
  // Same subject, two incompatible values in ONE proposal: both retained as
  // `disputed` (never silently resolved), kind/authority preserved.
  const conflicted = seedProposal(ownerA, [
    ledgerChange(ownerA, {
      factId: 'fact-conflict-yes',
      kind: 'claim',
      text: '发布条件已满足，可以上线',
      authority: 'user_confirmed',
      subjectKey: 'release-status',
    }),
    ledgerChange(ownerA, {
      factId: 'fact-conflict-no',
      kind: 'claim',
      text: '发布条件未满足，暂不能上线',
      authority: 'user_exploration',
      subjectKey: 'release-status',
    }),
  ])
  assert.equal(conflicted.status, 'committed', JSON.stringify(conflicted))
  assert.deepEqual(conflicted.disputed.sort(), ['fact-conflict-no', 'fact-conflict-yes'])
  const facts = new Map(plane.repo.facts(plane.scopeId, 'session', ownerA.sessionId).map((fact) => [fact.factId, fact]))
  assert.equal(facts.get('fact-conflict-yes').status, 'disputed')
  assert.equal(facts.get('fact-conflict-no').status, 'disputed')
  assert.equal(facts.get('fact-conflict-yes').kind, 'claim', 'a conflict never rewrites kind')
  assert.equal(facts.get('fact-conflict-no').kind, 'claim')
  assert.equal(facts.get('fact-conflict-yes').authority, 'user_confirmed', 'a conflict never downgrades authority')
  assert.equal(facts.get('fact-conflict-no').authority, 'user_exploration')
  const body = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', ownerA.sessionId).body
  assert.ok(body.includes('发布条件已满足，可以上线') && body.includes('发布条件未满足，暂不能上线'), body)
  assert.ok(body.includes('[disputed]'), 'the snapshot marks the disagreement')

  // The conservative fallback is still in place: without a comparable subject
  // key, same-kind different-text facts are disputed rather than silently kept.
  const conservative = seedProposal(ownerB, [
    ledgerChange(ownerB, {
      factId: 'fact-workspace-implicit',
      kind: 'claim',
      text: '项目按周发布',
      authority: 'agent_reported',
    }),
  ])
  assert.equal(conservative.status, 'committed', JSON.stringify(conservative))
  assert.deepEqual(conservative.disputed.sort(), ['fact-workspace-implicit', 'fact-workspace-repo'])

  fixture.evidence.conflictSemantics = {
    sameSubject: { disputed: conflicted.disputed, statuses: ['disputed', 'disputed'] },
    differentSubjects: { disputedAfterFirstProposal: [], deployStatus: 'active' },
    conservativeFallback: conservative.disputed,
  }
})

test('G06/E03-04 layered context is reproducible and each hit keeps its real evidence address', () => {
  const assembler = new ContextAssembler(null)
  assert.equal(assembler.indexAvailable(), false, 'no derived FTS index exists on this ledger yet')
  const contextFacts = [...ledgerContextFacts(), ...globalSpecFacts()]
  assert.ok(contextFacts.some((fact) => fact.layer === 'owner'))
  assert.ok(contextFacts.some((fact) => fact.layer === 'workspace'))

  const first = assembler.assemble({ scopeId: plane.scopeId, query: '部署', facts: contextFacts })
  const second = assembler.assemble({ scopeId: plane.scopeId, query: '部署', facts: contextFacts })
  assert.equal(first.degraded, true, 'missing FTS is reported honestly')
  assert.deepEqual(
    first.hits.map((hit) => hit.factId),
    second.hits.map((hit) => hit.factId),
    'the layered ordering is reproducible',
  )
  assert.equal(first.hits[0].factId, 'fact-owner-deploy', 'the query match leads the context regardless of layer')
  assert.equal(first.hits[0].score, 1)
  assert.ok(first.body.includes('[owner/') && first.body.includes('[workspace/') && first.body.includes('[global/'))
  assert.ok(first.body.includes('本阶段不部署生产环境'), first.body)

  // Every ledger-backed hit carries the real evidence address; the preset
  // safety rule is a spec fact (no ledger evidence, by design).
  const ledgerIds = new Set(plane.repo.facts(plane.scopeId, 'session', fixture.sessions[0].sessionId).map((f) => f.factId))
  for (const session of fixture.sessions.slice(0, 2)) {
    for (const fact of plane.repo.facts(plane.scopeId, 'session', session.sessionId)) ledgerIds.add(fact.factId)
  }
  for (const hit of first.hits) {
    if (hit.factId === 'spec-immutable-safety') {
      assert.deepEqual(hit.evidence, [], 'the preset safety rule is not a memory claim')
      continue
    }
    assert.ok(ledgerIds.has(hit.factId), `unexpected hit ${hit.factId}`)
    assert.ok(hit.evidence.length >= 1, `${hit.factId} must keep its evidence address`)
    for (const evidence of hit.evidence) {
      assert.equal(evidence.scopeId, plane.scopeId)
      assert.ok(evidence.sessionId.length > 0)
      assert.ok(evidence.sourceGeneration.includes('@'))
      assert.equal(typeof evidence.seq, 'number')
    }
  }
  // The address matches the real fact_evidence row, and the seq exists durably.
  const deployHit = first.hits.find((hit) => hit.factId === 'fact-owner-deploy')
  const row = plane.db.db
    .prepare('SELECT session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND fact_id = ?')
    .get(plane.scopeId, 'fact-owner-deploy')
  assert.equal(deployHit.evidence[0].sessionId, row.session_id)
  assert.equal(deployHit.evidence[0].seq, Number(row.seq))
  assert.equal(deployHit.evidence[0].sourceGeneration, String(row.source_hash).split('#')[0])
  assert.ok(
    reader.eventsOf(String(row.session_id)).some((event) => Number(event.seq) === Number(row.seq)),
    'the evidence address exists in the durable Session log',
  )

  fixture.evidence.layered = {
    degraded: first.degraded,
    ordering: first.hits.map((hit) => ({ factId: hit.factId, layer: hit.layer, score: hit.score })),
    consumed: consumedFactIds(first.hits),
    evidenceChecked: deployHit.evidence,
  }
})

test('G06/E03-04 a moved source generation marks hits stale; text is never silently refreshed', () => {
  const [ownerA, ownerB] = fixture.sessions
  const assembler = new ContextAssembler(null)
  const contextFacts = [...ledgerContextFacts(), ...globalSpecFacts()]
  const view = assembler.assemble({ scopeId: plane.scopeId, query: '部署', facts: contextFacts })

  const current = new Map([
    [ownerA.sessionId, ownerA.generation],
    [ownerB.sessionId, ownerB.generation],
  ])
  const unchanged = assembler.markStale(view.hits, current)
  assert.ok(unchanged.every((hit) => hit.freshness === 'current'))

  const movedGeneration = `${ownerA.sessionId}@999:0:`
  const moved = assembler.markStale(view.hits, new Map([[ownerA.sessionId, movedGeneration]]))
  const ownerAHits = moved.filter((hit) => hit.evidence.some((evidence) => evidence.sessionId === ownerA.sessionId))
  const otherHits = moved.filter((hit) => hit.evidence.every((evidence) => evidence.sessionId !== ownerA.sessionId))
  assert.ok(ownerAHits.length >= 1, 'the owner layer moved')
  assert.ok(ownerAHits.every((hit) => hit.freshness === 'stale'), 'a moved generation is stale, not refreshed')
  assert.ok(otherHits.every((hit) => hit.freshness === 'current'), 'other sources are untouched')
  for (const hit of moved) {
    const original = view.hits.find((row) => row.factId === hit.factId)
    assert.equal(hit.text, original.text, 'stale never rewrites the remembered text')
  }

  fixture.evidence.staleness = {
    currentGenerations: [...current.entries()],
    movedGeneration,
    staleHits: ownerAHits.map((hit) => hit.factId),
    currentHits: otherHits.map((hit) => hit.factId),
  }
})

test('G06/E03-04 retired versions and forgotten facts never enter the current context', () => {
  const [ownerA] = fixture.sessions
  const assembler = new ContextAssembler(null)
  const contextFacts = [...ledgerContextFacts(), ...globalSpecFacts()]
  const before = assembler.assemble({ scopeId: plane.scopeId, query: '汇报', facts: contextFacts })
  // The superseded value never enters the context; only the current version does.
  assert.ok(!before.hits.some((hit) => hit.text === '旧方案：单会话汇报'), 'the retired text is not a current hit')
  assert.ok(before.body.includes('已被双会话方案取代'), 'the current version is what the context carries')
  assert.ok(before.hits.some((hit) => hit.factId === 'fact-owner-deploy'))

  // Forget rule written by the real lifecycle module, then the caller's scope
  // filter (03§14: tombstone/forget filtering happens BEFORE retrieval).
  const lifecycle = new MemoryLifecycle({
    createJob: () => assert.fail('forget does not create a job'),
    getJob: () => null,
    updateJob: () => assert.fail('forget does not update a job'),
    setWatermarkNow: () => 0,
    countSources: () => 0,
    upsertFact: (input) => plane.repo.upsertFact(input),
    facts: (scopeId, ownerType, ownerId) => plane.repo.facts(scopeId, ownerType, ownerId),
    saveRule: (input) => {
      const id = `rule-${crypto.randomUUID()}`
      plane.db.db
        .prepare('INSERT INTO forget_rule(id,scope_id,source_fingerprint,selector_json,mode,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, input.scopeId, input.sourceFingerprint, JSON.stringify(input.selector), input.mode, new Date().toISOString())
      return { id }
    },
    rules: (scopeId) =>
      plane.db.db
        .prepare('SELECT id, source_fingerprint, selector_json, mode FROM forget_rule WHERE scope_id = ?')
        .all(scopeId)
        .map((row) => ({
          id: String(row.id),
          sourceFingerprint: String(row.source_fingerprint),
          selector: JSON.parse(String(row.selector_json)),
          mode: String(row.mode),
        })),
    audit: (scopeId, kind, objectId, actor, reason = null) => plane.repo.audit(scopeId, kind, objectId, actor, reason),
  })
  const hashBefore = reader.hashOf(ownerA.file)
  const forgotten = lifecycle.forget({
    scopeId: plane.scopeId,
    mode: 'forget_fact',
    sourceFingerprint: `${ownerA.sessionId}@${ownerA.generation}`,
    selector: ['fact-owner-deploy'],
  })
  assert.ok(forgotten.ruleId)
  const excluded = new Set()
  for (const rule of plane.db.db.prepare('SELECT selector_json FROM forget_rule WHERE scope_id = ?').all(plane.scopeId)) {
    const selector = JSON.parse(String(rule.selector_json))
    if (Array.isArray(selector)) for (const factId of selector) excluded.add(String(factId))
  }
  assert.ok(excluded.has('fact-owner-deploy'))

  const afterView = assembler.assemble({
    scopeId: plane.scopeId,
    query: '部署',
    facts: contextFacts,
    excludedFactIds: excluded,
  })
  assert.ok(!afterView.hits.some((hit) => hit.factId === 'fact-owner-deploy'), 'a forgotten fact is not used')
  assert.ok(!afterView.body.includes('本阶段不部署生产环境'), afterView.body)
  // Control: without the scope filter the fact would still be there — the
  // exclusion did the work, not luck.
  const control = assembler.assemble({ scopeId: plane.scopeId, query: '部署', facts: contextFacts })
  assert.ok(control.hits.some((hit) => hit.factId === 'fact-owner-deploy'))
  // Forget stops USE; it does not delete the conversation or the fact row.
  assert.equal(reader.hashOf(ownerA.file), hashBefore, 'the original Session log is untouched')
  assert.ok(plane.repo.facts(plane.scopeId, 'session', ownerA.sessionId).some((fact) => fact.factId === 'fact-owner-deploy'))

  fixture.evidence.forgotten = {
    ruleId: forgotten.ruleId,
    excludedFacts: [...excluded],
    hitsWithoutExclusion: control.hits.map((hit) => hit.factId),
    sessionHashBefore: hashBefore,
    sessionHashAfter: reader.hashOf(ownerA.file),
  }
})

/* ── opt-in: real Qwen extraction → commit → retrieval ───────────────── */

test('G06/E03-04 REAL Qwen extraction commits facts that retrieval returns with real evidence', { skip: SKIP }, async () => {
  const target = fixture.sessions[2]
  const cursorBefore = plane.cursors.all(plane.scopeId).filter((cursor) => cursor.sessionId === target.sessionId)
  assert.ok(cursorBefore.length >= 1, 'the Host observation plane must have a cursor for the target Session')
  await plane.observer.scan()

  const client = createQwenClient({
    providerId: 'qwen-local',
    modelId: MODEL_ID,
    credentialRef: NO_CREDENTIAL,
    baseUrl: BASE_URL,
    contextWindowTokens: 196608,
    declaredContext: '196k',
    quantization: null,
    externalFallbackAllowed: false,
  })
  let calls = 0
  const counted = {
    config: client.config,
    async chat(request) {
      calls += 1
      return await client.chat(request)
    },
  }
  const audits = []
  const extractor = new MemoryExtractor({
    client: counted,
    batch: plane.observer,
    cursors: plane.cursors,
    committer: plane.committer,
    store: plane.repo,
    permits: new ModelPermits({ softTimeoutMs: 45_000 }),
    config: {
      scopeId: plane.scopeId,
      owner: { type: 'session', id: target.sessionId },
      maxInputTokens: 12_000,
      maxOutputTokens: 2_048,
      softTimeoutMs: 45_000,
    },
    onAudit: (event) => audits.push(event),
  })

  const hashBefore = reader.hashOf(target.file)
  const started = Date.now()
  const result = await extractor.extract({ sessionId: target.sessionId })
  const elapsedMs = Date.now() - started
  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(calls, 1, 'exactly one real model call')
  assert.equal(result.model.providerId, 'qwen-local')
  assert.equal(result.model.modelId, MODEL_ID)
  assert.ok(result.model.attempts.length === 1)
  assert.ok(result.changeCount >= 1)
  assert.equal(result.applied.length, result.changeCount)
  assert.ok(result.toSeq <= target.headSeq, 'coverage never passes the durable head')
  assert.equal(audits.find((event) => event.kind === 'model/attempt').providerId, 'qwen-local')

  // Every committed fact cites a real durable user-message seq of the target.
  const durableSeqs = new Set(reader.eventsOf(target.sessionId).map((event) => Number(event.seq)))
  const semanticSeqs = new Set(target.semanticSeqs)
  const facts = plane.repo.facts(plane.scopeId, 'session', target.sessionId)
  assert.ok(facts.length >= 1)
  const evidence = plane.db.db
    .prepare('SELECT fact_id, session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND session_id = ?')
    .all(plane.scopeId, target.sessionId)
  assert.ok(evidence.length >= facts.length)
  for (const row of evidence) {
    assert.equal(row.session_id, target.sessionId)
    assert.ok(durableSeqs.has(Number(row.seq)), `evidence seq ${row.seq} is not a durable event`)
    assert.ok(semanticSeqs.has(Number(row.seq)), `evidence seq ${row.seq} is not a real human message`)
    assert.match(String(row.source_hash), new RegExp(`^${target.generation.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}#`, 'u'))
  }
  const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, 'session', target.sessionId)
  assert.equal(snapshot.coverage[`${target.sessionId}#${target.generation}`].throughSeq, result.toSeq)
  const cursor = plane.cursors.all(plane.scopeId).find(
    (row) => row.sessionId === target.sessionId && row.sourceGeneration === target.generation,
  )
  assert.equal(cursor.throughSeq, result.toSeq, 'the watermark advanced to the processed boundary only')
  assert.equal(reader.hashOf(target.file), hashBefore, 'extraction never writes into the user Session')

  // Retrieval over the fresh real fact: the hit carries the real evidence.
  const assembler = new ContextAssembler(null)
  const contextFacts = ledgerContextFacts().filter((fact) => {
    // keep the target Session's facts in the owner layer for this closure
    return true
  })
  const targetFacts = []
  for (const fact of plane.repo.facts(plane.scopeId, 'session', target.sessionId)) {
    const address = plane.db.db
      .prepare('SELECT session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND fact_id = ?')
      .all(plane.scopeId, fact.factId)
      .map((row) => ({
        scopeId: plane.scopeId,
        sessionId: String(row.session_id),
        sourceGeneration: String(row.source_hash).split('#')[0],
        seq: Number(row.seq),
      }))
    targetFacts.push({ ...fact, layer: 'owner', evidence: address })
  }
  const view = assembler.assemble({
    scopeId: plane.scopeId,
    query: '部署',
    facts: [...targetFacts, ...contextFacts, ...globalSpecFacts()],
  })
  const freshHit = view.hits.find((hit) => targetFacts.some((fact) => fact.factId === hit.factId))
  assert.ok(freshHit, `real extraction facts must be retrievable: ${JSON.stringify(view.hits)}`)
  assert.ok(freshHit.evidence.length >= 1)
  assert.ok(freshHit.evidence.every((address) => semanticSeqs.has(address.seq)), 'retrieval returns the real evidence address')

  console.log(
    `  real extraction: ${elapsedMs}ms, ${result.changeCount} facts, window (-1..${result.toSeq}], ` +
      `subjectKeys=${result.candidatesWithSubjectKey}/${result.candidateCount}, disputed=${result.disputed.length}`,
  )
  fixture.evidence.realModel = {
    status: result.status,
    modelId: result.model.modelId,
    attempts: result.model.attempts,
    elapsedMs,
    fromSeq: result.fromSeq,
    toSeq: result.toSeq,
    version: result.version,
    changeCount: result.changeCount,
    candidates: result.candidateCount,
    candidatesWithSubjectKey: result.candidatesWithSubjectKey,
    disputed: result.disputed,
    applied: result.applied,
    facts: facts.map((fact) => ({ factId: fact.factId, kind: fact.kind, text: fact.text, authority: fact.authority, status: fact.status })),
    evidence: evidence.map((row) => ({ factId: row.fact_id, seq: Number(row.seq), sourceHash: row.source_hash })),
    retrieval: view.hits.map((hit) => ({ factId: hit.factId, layer: hit.layer, evidence: hit.evidence })),
    sessionSha256: { before: hashBefore, after: reader.hashOf(target.file) },
  }
})
