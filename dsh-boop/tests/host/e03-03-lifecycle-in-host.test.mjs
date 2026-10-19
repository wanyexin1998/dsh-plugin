#!/usr/bin/env node
/**
 * E03-03 in-host: three initialization modes, import, correction, forgetting —
 * driven against the REAL rc.2.1 Host artifacts (G06 closure).
 *
 * What is real here (no mock replaces it):
 *  - a real `dsh web` Host boots in a private `$DSH_HOME`; every fixture Session
 *    is created through the Host's own `session/create` + `session/prompt` RPC
 *    and lands in the Host's durable plain-JSONL Session log (this isolated
 *    profile sets `compression: none` so the evidence is the stored bytes).
 *    The Host has no model credential, so its turn ends with an honest
 *    `turn/end` error — no model capability is claimed or faked;
 *  - BOOP's own observation plane (the plugin's `boop/observeSources` endpoint)
 *    discovers those Sessions and writes the real BOOP ledger
 *    (`<DSH_HOME>/boop/boop.sqlite`) before the Host stops;
 *  - after the Host stops, the real ledger is opened through the real
 *    `BoopDatabase`/`BoopRepository`; `MemoryLifecycle`, `MemoryCommitter` and
 *    the observer write REAL rows (memory_job, source_cursor, fact,
 *    fact_version, fact_evidence, memory_snapshot, forget_rule, audit_event).
 *
 * The E03-03 execution plane is not wired to a Host endpoint yet (STATUS:
 * "E03-03 执行未接线"), so this test wires `MemoryLifecycle`'s store interface
 * to the real ledger in-process (see `createLedgerInitStore`). That adapter is
 * test-side plumbing over real tables — it never fakes a business result.
 *
 * Import safety: the import path takes bounded entries, never a path, and never
 * executes anything. An executable payload is planted with two side effects
 * (connect to a local canary listener, write a sentinel file); the import runs
 * while the canary is listening and the test asserts ZERO connections and NO
 * sentinel, then closes the listener and proves a direct TCP connect is
 * REFUSED — so an accidental execution could not have gone unnoticed.
 *
 * Run: node --test --test-force-exit tests/host/e03-03-lifecycle-in-host.test.mjs
 * Optional evidence: $env:BOOP_EVIDENCE_DIR="docs/development/evidence/e03-06"
 *
 * NOT_RUN (honest): Host endpoint wiring for init/import/correct/forget;
 * tombstoning of facts by `MemoryLifecycle.forget` (it writes the forget rule
 * only — the fact row is left intact, so "forget stops use, never deletes
 * history" is asserted at the rule/history level); fact_consumption impact
 * tracking; a real model turn in this fixture (E03-02/E03-04 opt-in cover the
 * model path).
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
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

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const EVIDENCE_DIR = process.env.BOOP_EVIDENCE_DIR?.trim() ?? ''
const WORK = path.join(PROJECT_ROOT, '.work/test-runs/g06-e03-03-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROJECT = path.join(WORK, 'project')
const IMPORT_DIR = path.join(WORK, 'import')
const PROFILE = 'boop-g06-lifecycle'
const SESSIONS_ROOT = path.join(HOME, 'sessions')
const LEDGER = path.join(HOME, 'boop', 'boop.sqlite')
const SENTINEL = path.join(WORK, 'import-executed.marker')
const PAYLOAD = path.join(IMPORT_DIR, 'payload.cmd')
const TURN_TIMEOUT_MS = 120_000

/**
 * Fact-bearing instructions. A Host without a model credential still records
 * the user message durably and ends the turn with an error; the text itself is
 * the real user-authored conversation the lifecycle reads.
 */
const INSTRUCTIONS = [
  '请记住这些项目事实：BOOP 项目本阶段不部署生产环境；下周五之前完成 E03-03 生命周期验收；当前唯一阻塞是共享 GPU 排队。',
  '请记住：项目目录结构采用 pnpm monorepo；发布需要两名评审。',
  '请记住：这条会话随后会变成不可读对象，用来验证失败对象被逐个列出。',
]

let host = null
const fixture = {
  sessions: [], // {sessionId, instruction, file, header, events, generation, headSeq, semanticSeqs}
  observation: null,
  diagnostics: '',
  evidence: { schemaVersion: 1, task: 'E03-03', capturedAt: null },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── the isolated profile ────────────────────────────────────────────── */

function profilePatch() {
  return `# G06 E03-03 host-path lifecycle (isolated DSH_HOME only; never a user profile).
# Plain JSONL keeps the durable Session log readable as stored bytes (evidence).
- id: session-persistence-jsonl
  config:
    root: '${SESSIONS_ROOT.replace(/\\/g, '/')}'
    compression: none

# No decoration model call, and no provider credential in this profile: the
# fixture Session turns end with an honest "no API key" error, not a model claim.
- id: session-title-llm
  disabled: true

- id: boop-api
  config:
    pocEnabled: true
`
}

/* ── durable plain-JSONL reader (the Host's own stored bytes) ────────── */

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

/** The real human-authored message seqs of one durable Session log. */
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

function createDurableReader(root) {
  const load = () => {
    const map = new Map()
    for (const file of listJsonl(root)) {
      try {
        const { header, events } = readLog(file)
        map.set(String(header.id), { file, header, events })
      } catch {
        /* an unreadable log is a real per-object failure, reported by the caller */
      }
    }
    return map
  }
  return {
    load,
    files: () => listJsonl(root),
    sessions() {
      return [...load().entries()].map(([sessionId, entry]) => ({
        sessionId,
        file: entry.file,
        header: entry.header,
        events: entry.events,
        generation: generationOf(entry.header),
        headSeq: entry.events.length === 0 ? -1 : Number(entry.events[entry.events.length - 1].seq),
        semanticSeqs: semanticSeqsOf(entry.events),
      }))
    },
    eventsOf(sessionId) {
      return load().get(sessionId)?.events ?? []
    },
    hashOf(file) {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    },
  }
}

/* ── real BOOP ledger plane (opened after the Host stopped) ──────────── */

function openPlane() {
  const db = new BoopDatabase({ path: LEDGER })
  db.bootstrap()
  // Ledger row ids must be unique across processes: the real Host wrote rows
  // into the same file before us, so a per-instance counter would collide.
  const repo = new BoopRepository(db, undefined, () => `g06-${crypto.randomUUID()}`)
  const scopeRow = db.db.prepare('SELECT scope_id, owner_id FROM scopes LIMIT 1').get()
  assert.ok(scopeRow, "the real Host must have created BOOP's scope row")
  const scopeId = String(scopeRow.scope_id)
  const reader = createDurableReader(SESSIONS_ROOT)
  const cursors = new LedgerCursorStore(repo)
  const observer = new SourceObserver(scopeId, reader, cursors)
  return { db, repo, scopeId, reader, cursors, observer, close: () => db.close() }
}

/**
 * Test-side adapter: `MemoryLifecycle`'s store interface over the real ledger.
 *
 * Every durable outcome goes to a real table: the job row to `memory_job`,
 * progress/failure snapshots to `audit_event`, watermarks to `source_cursor`,
 * imported facts to `fact`, forget rules to `forget_rule`. Process-local fields
 * the frozen `memory_job` schema has no column for (processed/total/failures)
 * and its missing `paused` status are mapped honestly: `paused` is stored as
 * the resumable `pending` status plus an audit row carrying the real state. The
 * schema gap is reported, not hidden.
 */
function durableJobStatus(state) {
  if (state === 'paused') return 'pending'
  if (state === 'pending' || state === 'running' || state === 'done' || state === 'failed') return state
  return 'pending'
}

function createLedgerInitStore(plane) {
  const jobs = new Map()
  const insertJob = plane.db.db.prepare(
    `INSERT INTO memory_job(id,scope_id,kind,session_id,from_seq,to_seq,baseline_version,input_hash,retry_count,status,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const updateJobRow = plane.db.db.prepare('UPDATE memory_job SET status = ? WHERE id = ? AND scope_id = ?')
  const selectJob = plane.db.db.prepare('SELECT id, kind, status, created_at FROM memory_job WHERE id = ? AND scope_id = ?')
  const recordProgress = (job, patch) => {
    const payload = {
      processed: job.processed,
      total: job.total,
      state: job.state,
      failures: job.failures,
      ...patch,
    }
    plane.repo.audit(plane.scopeId, 'memory/init-progress', job.id, 'operator', JSON.stringify(payload))
  }
  return {
    createJob(job) {
      const row = { id: `job-${crypto.randomUUID()}`, ...job, finishedAt: null }
      insertJob.run(
        row.id,
        plane.scopeId,
        row.mode,
        null,
        null,
        null,
        0,
        crypto.createHash('sha256').update(`${row.mode}:${row.createdAt}`).digest('hex'),
        0,
        'pending',
        row.createdAt,
      )
      jobs.set(row.id, row)
      return row
    },
    getJob(id) {
      const row = jobs.get(id)
      if (row) return row
      const persisted = selectJob.get(id, plane.scopeId)
      if (!persisted) return null
      const restored = {
        id: String(persisted.id),
        mode: String(persisted.kind),
        processed: 0,
        total: null,
        state: String(persisted.status),
        failures: [],
        createdAt: String(persisted.created_at),
        finishedAt: null,
      }
      jobs.set(id, restored)
      return restored
    },
    updateJob(id, patch) {
      const row = jobs.get(id)
      assert.ok(row, `unknown initialization job ${id}`)
      Object.assign(row, patch)
      if (patch.state !== undefined) updateJobRow.run(durableJobStatus(row.state), id, plane.scopeId)
      if (patch.processed !== undefined || patch.failures !== undefined || patch.state !== undefined) {
        recordProgress(row, patch)
      }
      return row
    },
    setWatermarkNow(scopeId, heads) {
      for (const head of heads) {
        plane.repo.upsertCursor({
          scopeId,
          sessionId: head.sessionId,
          sourceGeneration: head.sourceGeneration,
          throughSeq: head.headSeq,
          state: 'fresh',
        })
      }
      return heads.length
    },
    countSources(scopeId) {
      return new Set(plane.repo.cursors(scopeId).map((cursor) => cursor.sessionId)).size
    },
    upsertFact(input) {
      return plane.repo.upsertFact(input)
    },
    facts(scopeId, ownerType, ownerId) {
      return plane.repo
        .facts(scopeId, ownerType, ownerId)
        .map((fact) => ({ factId: fact.factId, status: fact.status }))
    },
    saveRule(input) {
      const id = `rule-${crypto.randomUUID()}`
      plane.db.db
        .prepare(
          'INSERT INTO forget_rule(id,scope_id,source_fingerprint,selector_json,mode,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(id, input.scopeId, input.sourceFingerprint, JSON.stringify(input.selector), input.mode, new Date().toISOString())
      return { id }
    },
    rules(scopeId) {
      return plane.db.db
        .prepare('SELECT id, source_fingerprint, selector_json, mode FROM forget_rule WHERE scope_id = ?')
        .all(scopeId)
        .map((row) => ({
          id: String(row.id),
          sourceFingerprint: String(row.source_fingerprint),
          selector: JSON.parse(String(row.selector_json)),
          mode: String(row.mode),
        }))
    },
    audit(scopeId, kind, objectId, actor, reason = null) {
      return plane.repo.audit(scopeId, kind, objectId, actor, reason)
    },
  }
}

/* ── committer seeding on the real ledger ────────────────────────────── */

function seedCommitterFact(plane, session, input) {
  const seq = input.seq ?? session.semanticSeqs[0] ?? 0
  return plane.committer.commit(
    {
      schemaVersion: 1,
      scopeId: plane.scopeId,
      sessionId: session.sessionId,
      sourceGeneration: session.generation,
      fromSeq: -1,
      toSeq: session.headSeq,
      baselineVersion: plane.repo.currentVersion(plane.scopeId, 'session', session.sessionId),
      changes: [
        {
          op: 'add',
          factId: input.factId,
          kind: input.kind,
          text: input.text,
          authority: input.authority,
          evidenceRefs: [
            {
              scopeId: plane.scopeId,
              sessionId: session.sessionId,
              sourceGeneration: session.generation,
              seq,
              hash: `${session.generation}#${seq}`,
            },
          ],
          supersedes: [],
          ...(input.subjectKey === undefined ? {} : { subjectKey: input.subjectKey }),
        },
      ],
      unresolved: [],
    },
    { type: 'session', id: session.sessionId },
  )
}

/* ── canary: importing a file must never execute it ──────────────────── */

async function startCanary() {
  const connections = []
  const server = net.createServer((socket) => {
    connections.push(Date.now())
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    address: server.address(),
    connections,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Returns 'open' | 'ECONNREFUSED' | 'timeout' — the control for "not executed". */
function probeTcp(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish('open'))
    socket.once('error', (error) => finish(String(error.code ?? error.message)))
    socket.setTimeout(2_000, () => finish('timeout'))
  })
}

/* ── evidence artifact ───────────────────────────────────────────────── */

function writeEvidenceArtifact(payload) {
  if (EVIDENCE_DIR === '') return
  const dir = path.resolve(PROJECT_ROOT, EVIDENCE_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `lifecycle-in-host-${STAMP}.json`)
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
  console.log(`  evidence written: ${file}`)
}

/* ── fixture ─────────────────────────────────────────────────────────── */

const reader = createDurableReader(SESSIONS_ROOT)
let plane = null
let lifecycle = null
let initStore = null

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })
  fs.mkdirSync(IMPORT_DIR, { recursive: true })
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
    const sessionId = session.sessionId
    assert.equal(typeof sessionId, 'string')
    const accepted = await call('session/prompt', {
      request: {
        requestId: `g06-e03-03-${created.length}-${Date.now()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: instruction }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    assert.equal(accepted.accepted, true, 'the real Host accepted each prompt')
    created.push({ sessionId, instruction })
  }

  // Wait for the durable plain-JSONL logs to settle (a real turn boundary).
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let durable = new Map()
  while (Date.now() < deadline) {
    durable = reader.load()
    const settled = created.every((entry) => {
      const log = durable.get(entry.sessionId)
      return log !== undefined && log.events.some((event) => event.type === 'turn/end')
    })
    if (settled) break
    await sleep(500)
  }
  for (const entry of created) {
    const log = durable.get(entry.sessionId)
    assert.ok(log, `no durable Session log for ${entry.sessionId} within ${TURN_TIMEOUT_MS}ms`)
    assert.ok(
      log.events.some((event) => event.type === 'user/message' && textOfMessage(event) === entry.instruction),
      'the real user message must be durably recorded',
    )
    assert.ok(log.events.some((event) => event.type === 'turn/end'), 'the turn must settle durably')
  }

  const observed = await call('boop/observeSources')
  fixture.observation = observed
  fixture.diagnostics = host.diagnostics.out + host.diagnostics.err

  await host.stop()
  host = null

  for (const entry of created) {
    const session = reader.sessions().find((row) => row.sessionId === entry.sessionId)
    assert.ok(session, `durable Session ${entry.sessionId} disappeared after the Host stopped`)
    fixture.sessions.push({ ...session, instruction: entry.instruction })
  }
  fixture.sessions.sort((a, b) => Number(a.header.createdAt) - Number(b.header.createdAt))

  plane = openPlane()
  plane.committer = new MemoryCommitter(plane.repo)
  initStore = createLedgerInitStore(plane)
  lifecycle = new MemoryLifecycle(initStore)

  console.log(
    `  fixture: ${fixture.sessions.length} real Sessions, scope ${plane.scopeId}, ledger ${LEDGER}`,
  )
  for (const session of fixture.sessions) {
    console.log(
      `    ${session.sessionId}: generation ${session.generation}, head ${session.headSeq}, ` +
        `human seqs [${session.semanticSeqs.join(',')}]`,
    )
  }
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

/* ── tests ───────────────────────────────────────────────────────────── */

test('G06/E03-03 the real Host recorded durable Sessions and BOOP observed them', () => {
  const warnings = fixture.diagnostics
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))

  assert.equal(fixture.sessions.length, 3, 'three real Sessions were created through the Host RPC')
  for (const session of fixture.sessions) {
    assert.ok(fs.existsSync(session.file), `durable log missing: ${session.file}`)
    assert.match(session.generation, new RegExp(`^${session.sessionId}@\\d+:\\d+`, 'u'))
    assert.ok(session.headSeq > 0, 'a real turn leaves durable events')
    assert.ok(session.semanticSeqs.length >= 1, 'the human-authored message is evidence')
    const humanSeq = session.semanticSeqs[0]
    const events = reader.eventsOf(session.sessionId)
    assert.ok(events.some((event) => Number(event.seq) === humanSeq), 'the evidence seq exists in the durable log')
  }

  const observed = fixture.observation
  assert.match(observed.scopeId, /^boop-[0-9a-f]{16}$/u)
  assert.ok(observed.discovered >= 3, 'the real Host observation plane discovered the fixture Sessions')
  for (const session of fixture.sessions) {
    const row = observed.sources.find((source) => source.sessionId === session.sessionId)
    assert.ok(row, `Host did not discover ${session.sessionId}: ${JSON.stringify(observed.sources)}`)
    assert.equal(row.sourceGeneration, session.generation, 'the Host generation is the durable header generation')
    assert.equal(row.throughSeq, -1, 'nothing is claimed as read before a memory job commits')
  }
  assert.equal(plane.scopeId, observed.scopeId, "the ledger scope is the Host's own scope")

  fixture.evidence.host = hostFacts()
  fixture.evidence.sessions = fixture.sessions.map((session) => ({
    sessionId: session.sessionId,
    generation: session.generation,
    headSeq: session.headSeq,
    semanticSeqs: session.semanticSeqs,
    file: path.relative(WORK, session.file),
  }))
  fixture.evidence.observation = {
    scopeId: observed.scopeId,
    discovered: observed.discovered,
    sources: observed.sources,
  }
})

test('G06/E03-03 学习已有会话 is a resumable real ledger job that names each failed object', () => {
  // A genuinely unreadable object: remove one real durable log after discovery.
  const missing = fixture.sessions[2]
  fs.rmSync(missing.file)
  assert.equal(fs.existsSync(missing.file), false)

  const job = lifecycle.startInitialization(plane.scopeId, 'learn_history')
  assert.equal(job.total, 3, 'the job knows its object count from the real source list')
  const jobRow = plane.db.db
    .prepare('SELECT kind, status FROM memory_job WHERE id = ? AND scope_id = ?')
    .get(job.id, plane.scopeId)
  assert.ok(jobRow, 'the initialization job is a real memory_job row')
  assert.equal(jobRow.kind, 'learn_history')
  assert.equal(jobRow.status, 'pending')

  const results = fixture.sessions.map((session) => {
    const present = fs.existsSync(session.file)
    return present
      ? { objectId: session.sessionId, ok: true }
      : { objectId: session.sessionId, ok: false, reason: 'session artifact unreadable' }
  })
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, false],
    'the failure is a real, observed unreadable object — not an invented one',
  )

  const done = lifecycle.advanceLearnHistory({ scopeId: plane.scopeId, jobId: job.id, results })
  assert.equal(done.processed, 3)
  assert.equal(done.state, 'done')
  assert.deepEqual(done.failures, [{ objectId: missing.sessionId, reason: 'session artifact unreadable' }])
  assert.equal(lifecycle.progressCopy(done), '已整理 3/3 个会话')
  assert.equal(
    plane.db.db.prepare('SELECT status FROM memory_job WHERE id = ?').get(job.id).status,
    'done',
    'the real job row moved to done',
  )
  const progressAudit = plane.db.db
    .prepare("SELECT reason FROM audit_event WHERE kind = 'memory/init-progress' AND object_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(job.id)
  assert.ok(progressAudit, 'progress is durable in the audit trail')
  assert.match(String(progressAudit.reason), /"processed":3/u)

  // Pause / resume a second job: committed progress is never rolled back.
  const second = lifecycle.startInitialization(plane.scopeId, 'learn_history')
  const running = lifecycle.advanceLearnHistory({
    scopeId: plane.scopeId,
    jobId: second.id,
    results: [{ objectId: fixture.sessions[0].sessionId, ok: true }],
  })
  assert.equal(running.processed, 1)
  assert.equal(running.state, 'running')
  const paused = lifecycle.pauseJob(second.id)
  assert.equal(paused.state, 'paused')
  assert.equal(paused.processed, 1)
  const pauseProgress = lifecycle.progressCopy(paused)
  assert.equal(pauseProgress, '已整理 1/3 个会话')
  // The frozen `memory_job` status enum has no `paused` value, so the durable
  // row stays `pending` (resumable, never done) and the real pause state lives
  // in the audit trail. Schema gap recorded in the report.
  assert.equal(plane.db.db.prepare('SELECT status FROM memory_job WHERE id = ?').get(second.id).status, 'pending')
  const pausedAudit = plane.db.db
    .prepare("SELECT reason FROM audit_event WHERE kind = 'memory/init-progress' AND object_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(second.id)
  assert.match(String(pausedAudit.reason), /"state":"paused"/u, 'the pause is durable in the audit trail')
  const resumed = lifecycle.advanceLearnHistory({
    scopeId: plane.scopeId,
    jobId: second.id,
    results: [
      { objectId: fixture.sessions[1].sessionId, ok: true },
      { objectId: missing.sessionId, ok: false, reason: 'session artifact unreadable' },
    ],
  })
  assert.equal(resumed.processed, 3)
  assert.equal(resumed.state, 'done')

  fixture.evidence.learnHistory = {
    job: { id: job.id, total: job.total, processed: done.processed, failures: done.failures },
    pausedJob: { id: second.id, progress: pauseProgress, final: resumed.state },
  }
})

test('G06/E03-03 从现在开始 moves only the real watermark and imports no history', () => {
  const factsBefore = plane.repo.facts(plane.scopeId, 'session', fixture.sessions[0].sessionId).length
  const snapshotsBefore = Number(
    plane.db.db.prepare('SELECT count(*) c FROM memory_snapshot WHERE scope_id = ?').get(plane.scopeId).c,
  )

  const job = lifecycle.startInitialization(plane.scopeId, 'from_now')
  assert.equal(job.total, null, '从现在开始 does not claim a history total')
  const heads = fixture.sessions.map((session) => ({
    sessionId: session.sessionId,
    sourceGeneration: session.generation,
    headSeq: session.headSeq,
  }))
  const done = lifecycle.applyFromNow({ scopeId: plane.scopeId, jobId: job.id, heads })
  assert.equal(done.state, 'done')
  assert.equal(done.processed, heads.length)

  for (const session of fixture.sessions) {
    const cursor = plane.repo
      .cursors(plane.scopeId)
      .find((row) => row.sessionId === session.sessionId && row.sourceGeneration === session.generation)
    assert.ok(cursor, `no real source_cursor row for ${session.sessionId}`)
    assert.equal(cursor.throughSeq, session.headSeq, 'the watermark is the real durable head, not an estimate')
    assert.equal(cursor.state, 'fresh')
  }
  // Nothing historical was absorbed: no facts, no snapshots from 从现在开始.
  assert.equal(
    plane.repo.facts(plane.scopeId, 'session', fixture.sessions[0].sessionId).length,
    factsBefore,
    '从现在开始 imports nothing',
  )
  assert.equal(
    Number(plane.db.db.prepare('SELECT count(*) c FROM memory_snapshot WHERE scope_id = ?').get(plane.scopeId).c),
    snapshotsBefore,
  )
  const audit = plane.db.db
    .prepare("SELECT reason FROM audit_event WHERE kind = 'memory/init-from-now' ORDER BY rowid DESC LIMIT 1")
    .get()
  assert.ok(audit, 'the real ledger carries the from-now audit row')

  fixture.evidence.fromNow = {
    heads: heads.length,
    watermark: fixture.sessions.map((session) => ({ sessionId: session.sessionId, throughSeq: session.headSeq })),
  }
})

test('G06/E03-03 import previews before writing and never executes the planted file', async () => {
  // The executable payload: if anything ran it, it would hit the canary port and
  // leave a sentinel. Both side effects are observable from this test process.
  const canary = await startCanary()
  fs.writeFileSync(
    PAYLOAD,
    [
      '@echo off',
      `powershell -NoProfile -Command "try { Invoke-WebRequest -Uri http://127.0.0.1:${canary.address.port}/pwned -TimeoutSec 2 } catch {}"`,
      `echo executed > "${SENTINEL}"`,
      '',
    ].join('\r\n'),
  )
  const markdown = [
    '# 记忆导入',
    '- [decision] 项目使用 pnpm monorepo 结构',
    '- [decision] 发布需要两名评审',
    '- [open_item] 预算审批仍在等待',
    '',
  ].join('\n')
  const markdownFile = path.join(IMPORT_DIR, 'facts.md')
  fs.writeFileSync(markdownFile, markdown)
  const entries = markdown
    .split('\n')
    .map((line) => /^- \[(?<kind>[a-z_]+)\] (?<text>.+)$/u.exec(line))
    .filter(Boolean)
    .map((match) => ({ kind: match.groups.kind, text: match.groups.text }))
  assert.equal(entries.length, 3)

  const count = (sql) => Number(plane.db.db.prepare(sql).get(plane.scopeId).c)
  const factsBefore = count('SELECT count(*) c FROM fact WHERE scope_id = ?')
  const tasksBefore = count('SELECT count(*) c FROM task WHERE scope_id = ?')
  const approvalsBefore = count('SELECT count(*) c FROM approval WHERE scope_id = ?')
  const sessionsBefore = reader.files().length
  const existing = fixture.sessions.flatMap((session) =>
    plane.repo.facts(plane.scopeId, 'session', session.sessionId).map((fact) => ({ factId: fact.factId, text: fact.text })),
  )

  // 1) An unsupported format is refused WITHOUT parsing or executing anything.
  const refused = lifecycle.previewImport({
    format: 'powershell-script',
    entries: [{ kind: 'exec', text: fs.readFileSync(PAYLOAD, 'utf8') }],
    existing,
  })
  assert.equal(refused.supported, false)
  assert.equal(refused.added, 0)
  assert.deepEqual(refused.rejected, [{ index: 0, reason: 'UNSUPPORTED_FORMAT' }])
  assert.equal(count('SELECT count(*) c FROM fact WHERE scope_id = ?'), factsBefore, 'a refused format writes nothing')

  // 2) A supported format previews candidates but still writes nothing.
  const preview = lifecycle.previewImport({ format: 'markdown-list', entries, existing })
  assert.equal(preview.supported, true)
  assert.equal(preview.added, 3)
  assert.equal(preview.needsReview, 3, 'every imported item needs local review')
  assert.equal(preview.duplicates, 0)
  assert.equal(preview.importedAuthority, 'import_unverified')
  assert.deepEqual(preview.rejected, [])
  assert.equal(count('SELECT count(*) c FROM fact WHERE scope_id = ?'), factsBefore, 'preview never writes facts')
  assert.equal(
    count("SELECT count(*) c FROM audit_event WHERE scope_id = ? AND kind = 'memory/imported'"),
    0,
    'preview never claims an import',
  )

  // 3) Commit the confirmed import: real fact rows, all unverified.
  const committed = lifecycle.commitImport({
    scopeId: plane.scopeId,
    entries,
    owner: { type: 'personal', id: plane.scopeId },
  })
  assert.equal(committed.factIds.length, 3)
  const imported = committed.factIds.map((factId) =>
    plane.db.db
      .prepare('SELECT kind, text, authority, status FROM fact WHERE scope_id = ? AND id = ?')
      .get(plane.scopeId, factId),
  )
  for (const row of imported) {
    assert.equal(row.authority, 'import_unverified', 'imported material is never presented as locally verified')
    assert.equal(row.status, 'active')
  }
  assert.equal(count('SELECT count(*) c FROM fact WHERE scope_id = ?'), factsBefore + 3)
  assert.equal(count("SELECT count(*) c FROM audit_event WHERE scope_id = ? AND kind = 'memory/imported'"), 1)
  assert.equal(count('SELECT count(*) c FROM task WHERE scope_id = ?'), tasksBefore, 'import restores no task')
  assert.equal(count('SELECT count(*) c FROM approval WHERE scope_id = ?'), approvalsBefore, 'import restores no approval')

  // 4) The executable was never executed: no canary connection, no sentinel, and
  //    the file itself is untouched. Then close the listener and prove a direct
  //    connect is refused (no process opened it on our behalf).
  assert.deepEqual(canary.connections, [], 'executing the payload would have connected to the canary')
  assert.equal(fs.existsSync(SENTINEL), false, 'executing the payload would have written the sentinel')
  assert.ok(fs.readFileSync(PAYLOAD, 'utf8').includes('Invoke-WebRequest'))
  assert.equal(reader.files().length, sessionsBefore, 'import creates no Session/Agent')
  await canary.close()
  assert.equal(await probeTcp(canary.address.port), 'ECONNREFUSED', 'the canary port is closed: nothing was listening')

  fixture.evidence.import = {
    unsupported: { format: refused.format, supported: refused.supported, added: refused.added },
    preview: {
      format: preview.format,
      added: preview.added,
      needsReview: preview.needsReview,
      importedAuthority: preview.importedAuthority,
      factRowsBefore: factsBefore,
      factRowsAfterPreview: factsBefore,
    },
    committed: { factIds: committed.factIds, factRowsAfter: factsBefore + 3, authority: 'import_unverified' },
    executable: {
      path: path.relative(WORK, PAYLOAD),
      canaryConnections: canary.connections.length,
      sentinel: fs.existsSync(SENTINEL),
      portProbeAfterClose: await probeTcp(canary.address.port),
      tasksBefore,
      approvalsBefore,
      sessionsBefore,
      sessionsAfter: reader.files().length,
    },
  }
})

test('G06/E03-03 a correction carries its source and affected scope, and stays traceable', () => {
  const session = fixture.sessions[0]
  const owner = { type: 'session', id: session.sessionId }
  const sourceSeq = session.semanticSeqs[0]
  const target = 'fact-lifecycle-correction-target'

  const seeded = seedCommitterFact(plane, session, {
    factId: target,
    kind: 'decision',
    text: '旧结论：本阶段不部署生产',
    authority: 'user_confirmed',
    seq: sourceSeq,
  })
  assert.equal(seeded.status, 'committed', JSON.stringify(seeded))
  const versionsBefore = Number(
    plane.db.db.prepare('SELECT count(*) c FROM fact_version WHERE scope_id = ? AND fact_id = ?').get(plane.scopeId, target).c,
  )
  const evidenceBefore = Number(
    plane.db.db.prepare('SELECT count(*) c FROM fact_evidence WHERE scope_id = ? AND fact_id = ?').get(plane.scopeId, target).c,
  )

  const plan = lifecycle.correctionPlan({
    scopeId: plane.scopeId,
    owner,
    statement: '更正：本阶段允许灰度部署',
    source: { sessionId: session.sessionId, sourceGeneration: session.generation, seq: sourceSeq },
    targets: [target],
  })
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].authority, 'user_confirmed')
  assert.equal(plan.changes[0].factId, target)
  assert.equal(plan.changes[0].evidenceRefs[0].seq, sourceSeq, 'a correction always carries its real source seq')
  assert.equal(plan.affected.scopeId, plane.scopeId)
  assert.equal(plan.affected.ownerType, 'session')
  assert.equal(plan.affected.ownerId, session.sessionId)
  assert.deepEqual(plan.affected.factIds, [target])
  assert.match(plan.userMessage, /已执行的任务不会被追回|不会被追回/u, 'no claim of instant global revoke')

  const committed = plane.committer.commit(
    {
      schemaVersion: 1,
      scopeId: plane.scopeId,
      sessionId: session.sessionId,
      sourceGeneration: session.generation,
      fromSeq: -1,
      toSeq: session.headSeq,
      baselineVersion: plane.repo.currentVersion(plane.scopeId, owner.type, owner.id),
      changes: plan.changes,
      unresolved: [],
    },
    owner,
  )
  assert.equal(committed.status, 'committed', JSON.stringify(committed))

  const fact = plane.repo.facts(plane.scopeId, owner.type, owner.id).find((row) => row.factId === target)
  assert.equal(fact.text, '更正：本阶段允许灰度部署')
  // The claim's kind stays the original one (the ledger mapper does not rewrite
  // `kind` on update); the correction intent is visible in the new version's
  // snapshot instead, so nothing is silently relabelled.
  assert.equal(fact.kind, 'decision')
  assert.equal(fact.authority, 'user_confirmed')
  const versionsAfter = Number(
    plane.db.db.prepare('SELECT count(*) c FROM fact_version WHERE scope_id = ? AND fact_id = ?').get(plane.scopeId, target).c,
  )
  assert.ok(versionsAfter > versionsBefore, 'the previous version stays addressable in fact_version')
  const latestVersion = plane.db.db
    .prepare('SELECT snapshot_json FROM fact_version WHERE scope_id = ? AND fact_id = ? ORDER BY version DESC LIMIT 1')
    .get(plane.scopeId, target)
  const latestSnapshot = JSON.parse(String(latestVersion.snapshot_json))
  assert.equal(latestSnapshot.kind, 'correction', 'the correction version is traceable as a correction')
  assert.equal(latestSnapshot.text, '更正：本阶段允许灰度部署')
  const evidenceAfter = Number(
    plane.db.db.prepare('SELECT count(*) c FROM fact_evidence WHERE scope_id = ? AND fact_id = ?').get(plane.scopeId, target).c,
  )
  assert.ok(evidenceAfter > evidenceBefore, 'the correction adds its own evidence row')
  const correctionEvidence = plane.db.db
    .prepare(
      'SELECT session_id, seq, source_hash FROM fact_evidence WHERE scope_id = ? AND fact_id = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(plane.scopeId, target)
  assert.equal(correctionEvidence.session_id, session.sessionId)
  assert.equal(Number(correctionEvidence.seq), sourceSeq)
  assert.match(String(correctionEvidence.source_hash), new RegExp(`^${session.generation.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}#`, 'u'))

  // Coverage still names the real generation it read.
  const snapshot = plane.repo.latestMemorySnapshot(plane.scopeId, owner.type, owner.id)
  assert.equal(snapshot.coverage[`${session.sessionId}#${session.generation}`].throughSeq, session.headSeq)

  fixture.evidence.correction = {
    target,
    sourceSeq,
    before: '旧结论：本阶段不部署生产',
    after: fact.text,
    factKind: fact.kind,
    correctionVersionKind: latestSnapshot.kind,
    authority: fact.authority,
    version: fact.version,
    factVersionRows: versionsAfter,
    evidenceRows: evidenceAfter,
    affected: plan.affected,
    userMessage: plan.userMessage,
  }
})

test('G06/E03-03 forgetting writes a real rule, keeps the original Session history readable', () => {
  const session = fixture.sessions[0]
  const target = 'fact-lifecycle-correction-target'
  const hashBefore = reader.hashOf(session.file)
  const eventsBefore = reader.eventsOf(session.sessionId).length
  const sessionsBefore = reader.files().length

  const forgotten = lifecycle.forget({
    scopeId: plane.scopeId,
    mode: 'forget_fact',
    sourceFingerprint: `${session.sessionId}@${session.generation}`,
    selector: [target],
  })
  assert.ok(forgotten.ruleId)
  const rule = plane.db.db
    .prepare('SELECT mode, source_fingerprint, selector_json FROM forget_rule WHERE scope_id = ? AND id = ?')
    .get(plane.scopeId, forgotten.ruleId)
  assert.ok(rule, 'the forget rule is a real forget_rule row')
  assert.equal(rule.mode, 'forget_fact')
  assert.deepEqual(JSON.parse(String(rule.selector_json)), [target])
  assert.equal(rule.source_fingerprint, `${session.sessionId}@${session.generation}`)
  const audit = plane.db.db
    .prepare("SELECT reason FROM audit_event WHERE kind = 'memory/forgotten' ORDER BY rowid DESC LIMIT 1")
    .get()
  assert.ok(audit)
  assert.match(String(audit.reason), /forget_fact/u)
  assert.deepEqual(lifecycle.applicableRules(plane.scopeId, rule.source_fingerprint), ['forget_fact'])

  // 03§13: forgetting stops USE; it never deletes the original conversation.
  assert.equal(reader.hashOf(session.file), hashBefore, 'the original Session log is byte-identical (not deleted)')
  assert.equal(reader.eventsOf(session.sessionId).length, eventsBefore, 'every durable event is still readable')
  assert.equal(reader.files().length, sessionsBefore, 'no Session artifact was removed')
  const humanEvent = reader
    .eventsOf(session.sessionId)
    .find((event) => event.type === 'user/message' && event.data?.source?.kind === 'user')
  assert.match(textOfMessage(humanEvent), /不部署生产环境/u, 'the original user words are still readable')
  // The fact row itself is NOT physically deleted either (forget stops use).
  const factStillThere = plane.repo.facts(plane.scopeId, 'session', session.sessionId).find((row) => row.factId === target)
  assert.ok(factStillThere, 'forgetting does not cascade-delete the fact row')

  fixture.evidence.forget = {
    ruleId: forgotten.ruleId,
    mode: rule.mode,
    selector: JSON.parse(String(rule.selector_json)),
    sessionHashBefore: hashBefore,
    sessionHashAfter: reader.hashOf(session.file),
    eventsBefore,
    eventsAfter: reader.eventsOf(session.sessionId).length,
    factRowRetained: Boolean(factStillThere),
  }
})
