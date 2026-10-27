#!/usr/bin/env node
/**
 * E04-02 in-host · Taskboard read-only projection on DSH 0.2.1-rc.2.
 *
 * Gates/scenes: G09 (native UI/data plane), TB04 (three-axis → four groups),
 * TB05/TB09 (no cross-column/authority write path), TB06 (version + stale
 * responses), AT-19/FE-11 (stale response / unreadable plane honesty).
 *
 * Every assertion runs against the INSTALLED rc.2.1 payload inside a private
 * `$DSH_HOME` under `.work/test-runs/e04-02-tasks-*`; the user's real `~/.dsh`
 * is never read or modified. The BOOP ledger is seeded BEFORE the host boots
 * through the real E01/E02 repository (no second task store is introduced), so
 * the projection is asserted on real ledger rows.
 *
 * Run: node --test --test-force-exit tests/host/e04-02-tasks-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { deriveScopeIdentity } from '../../src/host/persistence/storage.ts'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e04-02-tasks-' + Date.now())
const HOME = path.join(WORK, 'dsh-home')
const PROFILE = 'boop-tasks'

let host
let base
let cookie
let probe
let identity
let ids = {}
let seededCounts

/* ── seed the real BOOP ledger before the Host boots ─────────────────── */

function seedLedger() {
  identity = deriveScopeIdentity(HOME)
  const dir = path.join(HOME, 'boop')
  fs.mkdirSync(dir, { recursive: true })
  const db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  // Relative clock: an absolute fixture timestamp turns into a time-bomb once
  // the wall clock passes the baked-in expiry (approvals then read as expired).
  let clock = Date.now()
  const now = () => new Date((clock += 1000)).toISOString()
  let n = 0
  const repo = new BoopRepository(db, now, () => `seed_${++n}`)
  const SCOPE = identity.scopeId
  repo.ensureScope(SCOPE, identity.ownerId)
  repo.bindMainSession(SCOPE, 'boop-main')

  const create = (key, goal) => {
    const task = repo.createTask({ scopeId: SCOPE, goal, criteria: ['可验证'], exclusions: ['不部署'] })
    ids[key] = task.id
    return task
  }
  const current = (key) => repo.getTask(SCOPE, ids[key])
  const dispatch = (key, state) => {
    const task = current(key)
    const action = repo.beginAction({
      scopeId: SCOPE,
      taskId: task.id,
      expectedTaskVersion: task.version,
      targetSessionId: `sess-${key}`,
      payloadHash: `hash-${key}`,
      payload: { instruction: '继续' },
      originRef: 'dsh:operator',
      policyEpoch: 1,
    })
    if (state !== undefined) repo.markActionState(SCOPE, action.id, state)
    return action
  }

  create('todo', '整理空状态文案')

  create('active', '接入任务看板列投影')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.active, expectedVersion: 1, lifecycle: 'active' })
  dispatch('active', 'running')
  repo.addTarget({
    scopeId: SCOPE,
    taskId: ids.active,
    workspaceId: 'ws-board',
    sessionId: 'sess-board',
    role: 'primary',
    resourceKey: 'sess-board',
  })

  create('approve', '批量归档旧看板任务')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.approve, expectedVersion: 1, lifecycle: 'active' })
  const approveAction = dispatch('approve')
  repo.createApproval({
    scopeId: SCOPE,
    actionId: approveAction.id,
    payloadHash: 'hash-approve',
    taskVersion: 2,
    policyEpoch: 1,
    requestingOwner: identity.ownerId,
    nonceHash: 'seed-nonce-approve',
    expiresAt: new Date(clock + 3_600_000).toISOString(),
  })

  // The approval stays bound to taskVersion 2 while the task moves to 3: the
  // projection must report a STALE card, not an actionable one (04§08).
  create('stale', '删除旧看板数据')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.stale, expectedVersion: 1, lifecycle: 'active' })
  const staleAction = dispatch('stale')
  repo.createApproval({
    scopeId: SCOPE,
    actionId: staleAction.id,
    payloadHash: 'hash-stale',
    taskVersion: 2,
    policyEpoch: 1,
    requestingOwner: identity.ownerId,
    nonceHash: 'seed-nonce-stale',
    expiresAt: new Date(clock + 3_600_000).toISOString(),
  })
  repo.updateTask({ scopeId: SCOPE, taskId: ids.stale, expectedVersion: 2, lifecycle: 'paused' })

  create('recover', '恢复被中断的派发')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.recover, expectedVersion: 1, lifecycle: 'recovery_required' })

  create('verify', '生成验收证据')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.verify, expectedVersion: 1, lifecycle: 'active' })
  const verifyAction = dispatch('verify', 'settled')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.verify, expectedVersion: 2, verification: 'pending' })
  repo.upsertFact({
    scopeId: SCOPE,
    factId: 'fact-host-e04',
    ownerType: 'task',
    ownerId: ids.verify,
    kind: 'verification',
    text: '验收引用真实事件 42',
    authority: 'tool_observed',
  })
  repo.addEvidence({
    scopeId: SCOPE,
    factId: 'fact-host-e04',
    sessionId: 'sess-verify',
    seq: 42,
    sourceHash: 'hash-seq-42',
    artifactRef: 'artifact-42',
  })
  db.db
    .prepare(
      'INSERT INTO fact_consumption(id,fact_id,scope_id,fact_version,task_id,action_id,use_kind) VALUES(?,?,?,?,?,?,?)',
    )
    .run('fc-host-e04', 'fact-host-e04', SCOPE, 1, ids.verify, verifyAction.id, 'verification')

  create('done', '完成主聊天入口')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.done, expectedVersion: 1, verification: 'passed' })
  repo.updateTask({ scopeId: SCOPE, taskId: ids.done, expectedVersion: 2, lifecycle: 'completed' })

  seededCounts = probeCountsOf(db)
  db.close()
}

function probeCountsOf(db) {
  const count = (table) => Number(db.db.prepare(`SELECT count(*) c FROM ${table}`).get().c)
  return {
    task: count('task'),
    action: count('action'),
    approval: count('approval'),
    task_revision: count('task_revision'),
    audit_event: count('audit_event'),
    source_cursor: count('source_cursor'),
  }
}

const counts = () => probeCountsOf(probe)

/* ── one authenticated unary RPC call ────────────────────────────────── */

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> ${status} ${JSON.stringify(body)}`)
  return body
}

/** BOOP tasks Remote plane: one `request` arg, single-layer fact value. */
const tasks = async (method, request) => {
  const body = await call(`boopTasks/${method}`, request === undefined ? {} : { request })
  assert.equal(body.result.ok, true, `${method} RPC failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  makeHome(HOME)
  seedLedger()
  await createProfile(HOME, PROFILE, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  host = await bootWeb({ home: HOME, profile: PROFILE, port: await freePort() })
  base = host.base
  cookie = await authorize(base, host.token)
  // A second connection ONLY to count ledger rows: it writes nothing itself and
  // is how the test proves that the projection reads did not mutate the ledger.
  probe = new BoopDatabase({ path: path.join(HOME, 'boop', 'boop.sqlite') })
})

after(async () => {
  probe?.close()
  await host?.stop()
})

/* ── composition ──────────────────────────────────────────────────────── */

test('E04-02 the boop-tasks row activates with no failed rows or import warnings', () => {
  const output = host.diagnostics.out + host.diagnostics.err
  const warnings = output.split('\n').filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], `activation warnings:\n${warnings.join('\n')}`)
  assert.match(output, /dsh web:/, 'the Web Host booted')
})

test('E04-02 the boop-tasks row is composed exactly once', async () => {
  const compiled = await runCli({ home: HOME, args: ['--profile', PROFILE, '--dump-config'] })
  assert.equal(compiled.code, 0, compiled.stderr)
  const lines = compiled.stdout.split('\n')
  assert.equal(lines.filter((line) => line.trim() === '- id: boop-tasks').length, 1, 'boop-tasks must be inserted once')
  assert.equal(lines.filter((line) => line.trim() === '- id: boop-workspace').length, 1, 'the E02-04 row must survive')
  assert.equal(lines.filter((line) => line.trim() === '- id: dsh-boop').length, 1)
})

/* ── capability matrix on the real host ──────────────────────────────── */

test('E04-02/TB09 capabilities: reads available, every write gate closed and stated honestly', async () => {
  const value = await tasks('capabilities')
  assert.equal(value.product, 'BOOP')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.available, true, JSON.stringify(value))
  assert.equal(value.readOnly, true)
  assert.equal(value.scopeId, identity.scopeId, 'the projection reads the derived data domain')
  assert.equal(value.writeMode.enabled, true, 'write mode follows the open gate ledger')
  assert.equal(value.writeMode.source, 'boop.isWriteModeEnabled()')
  assert.deepEqual(value.writeMode.blockedByGates, [])
  assert.equal(value.canCommit, false)
  assert.equal(value.canSortLocal, true)
  assert.equal(value.canChangeVerification, false)
  assert.equal(value.canChangeApproval, false)
  const byMethod = Object.fromEntries(value.methods.map((entry) => [entry.method, entry]))
  assert.equal(byMethod.list.status, 'available')
  assert.equal(byMethod.detail.status, 'available')
  assert.equal(byMethod.setPriority.status, 'disabled')
  assert.equal(byMethod.setPriority.kind, 'write')
  assert.equal(value.audit.sink, 'ledger', 'the Host owns the writable ledger, so refusals audit durably')
  assert.equal(value.audit.durable, true)
  assert.equal(value.diagnostics.row, 'boop-tasks')
  assert.equal(value.diagnostics.remoteService, 'boopTasks')
  assert.deepEqual(value.diagnostics.endpoints.sort(), [
    'boopTasks/capabilities',
    'boopTasks/detail',
    'boopTasks/list',
    'boopTasks/setPriority',
  ])
  assert.deepEqual(value.limits, { pageDefault: 50, pageMax: 100, scanMax: 500, detailChildMax: 50 })
  assert.deepEqual(value.groups.map((group) => group.key), ['todo', 'in_progress', 'needs_me', 'finished'])
})

/* ── real reads against the seeded ledger ────────────────────────────── */

test('TB04/E04-02 list projects the four real groups from the seeded three-axis ledger', async () => {
  const value = await tasks('list')
  assert.equal(value.available, true, JSON.stringify(value))
  assert.equal(value.scopeId, identity.scopeId)
  assert.equal(value.total, 7, JSON.stringify(value.tasks.map((card) => [card.title, card.displayGroup])))
  assert.deepEqual(
    value.groups.map((group) => [group.key, group.label, group.count]),
    [
      ['todo', '待开始', 1],
      ['in_progress', '进行中', 1],
      ['needs_me', '待我处理', 4],
      ['finished', '已结束', 1],
    ],
  )
  assert.equal(value.page.returned, 7)
  assert.equal(value.page.hasMore, false)
  assert.equal(value.scan.truncated, false)

  const byId = Object.fromEntries(value.tasks.map((card) => [card.taskId, card]))
  const card = (key) => {
    assert.ok(byId[ids[key]], `${key} must be projected`)
    return byId[ids[key]]
  }
  assert.equal(card('todo').displayGroup, 'todo')
  assert.equal(card('todo').lifecycle, 'draft')
  assert.equal(card('todo').authorization, 'none')

  assert.equal(card('active').displayGroup, 'in_progress')
  assert.equal(card('active').authorization, 'running', 'the execution axis is the latest real action state')
  assert.equal(card('active').workspaceId, 'ws-board')
  assert.equal(card('active').primarySessionId, 'sess-board')
  assert.deepEqual(card('active').targets, [
    { workspaceId: 'ws-board', sessionId: 'sess-board', role: 'primary', resourceKey: 'sess-board' },
  ])

  assert.equal(card('approve').displayGroup, 'needs_me')
  assert.equal(card('approve').pendingReason, 'approval')
  assert.equal(card('approve').pendingApproval.valid, true, 'the bound approval is actionable')
  assert.equal(card('approve').authorization, 'dispatching')

  assert.equal(card('stale').displayGroup, 'needs_me')
  assert.equal(card('stale').pendingReason, 'approval_stale')
  assert.equal(card('stale').pendingApproval.valid, false, 'a version-moved card must not be clickable')
  assert.equal(card('stale').pendingApproval.invalidReason, 'task-version-moved')

  assert.equal(card('recover').pendingReason, 'recovery')
  assert.equal(card('verify').pendingReason, 'verification')
  assert.equal(card('verify').authorization, 'settled', 'execution settled ≠ verification passed')
  assert.equal(card('verify').verification, 'pending')
  assert.equal(card('done').displayGroup, 'finished')
  assert.equal(card('done').statusLine, '已结束（验收通过）')

  // Group order is the frozen display order, and each card's taskVersion is the
  // real optimistic-concurrency version from the ledger.
  const groupOrder = value.tasks.map((entry) => value.groups.find((group) => group.key === entry.displayGroup).order)
  assert.deepEqual(groupOrder, [...groupOrder].sort((left, right) => left - right))
  assert.equal(card('approve').taskVersion, 2)
  assert.ok(value.projectionSeq >= 1)
})

test('E04-02 filters and local same-column ordering work against the real ledger', async () => {
  const needsMe = await tasks('list', { group: 'needs_me' })
  assert.equal(needsMe.total, 4)
  assert.ok(needsMe.tasks.every((card) => card.displayGroup === 'needs_me'))
  assert.deepEqual(needsMe.groups.map((group) => group.count), [0, 0, 4, 0])

  const pending = await tasks('list', { pending: 'any' })
  assert.deepEqual(pending.tasks.map((card) => card.taskId), [ids.approve], 'stale cards are not pending work')

  const byWorkspace = await tasks('list', { workspaceId: 'ws-board' })
  assert.deepEqual(byWorkspace.tasks.map((card) => card.taskId), [ids.active])

  const byTitle = await tasks('list', { orderBy: 'title', orderDir: 'asc' })
  const titles = byTitle.tasks.map((card) => card.title)
  assert.deepEqual(titles, [...titles].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')))

  const ignored = await tasks('list', { group: 'not-a-group' })
  assert.deepEqual(ignored.ignoredFilters, ['group:not-a-group'])
  assert.equal(ignored.total, 7, 'an unknown filter never hides the board')
})

test('E04-02/taskVersion the read plane reports monotonic projectionSeq (stale responses are droppable)', async () => {
  const first = await tasks('list')
  const second = await tasks('list')
  assert.ok(second.projectionSeq > first.projectionSeq, 'projectionSeq must be monotonic per process')
  let held = null
  const accept = (response) => {
    if (held !== null && response.projectionSeq <= held.projectionSeq) return false
    held = response
    return true
  }
  assert.equal(accept(second), true)
  assert.equal(accept(first), false, 'a late older response must be rejected by the client comparison')
})

test('E04-02 detail: latest snapshot, revisions, actions, approvals, evidence address', async () => {
  const value = await tasks('detail', { taskId: ids.verify })
  assert.equal(value.available, true)
  assert.equal(value.found, true)
  assert.equal(value.task.taskId, ids.verify)
  assert.equal(value.snapshot.version, value.task.taskVersion)
  assert.equal(value.snapshot.goal, '生成验收证据')
  assert.equal(value.revisions[0].version, value.snapshot.version, 'revisions come newest-first')
  assert.equal(value.coverage.revisionCount, value.revisions.length)
  assert.equal(value.actions.length, 1)
  assert.equal(value.actions[0].state, 'settled')
  assert.equal(value.evidence.length, 1)
  assert.equal(value.evidence[0].address, 'session:sess-verify#seq:42', 'evidence is addressed to an exact source seq')
  assert.equal(value.evidence[0].sourceHash, 'hash-seq-42')
  assert.deepEqual(value.limitations, [])

  const approve = await tasks('detail', { taskId: ids.approve })
  assert.equal(approve.approvals.length, 1)
  assert.equal(approve.approvals[0].valid, true)
  assert.equal(approve.approvals[0].status, 'pending')

  const stale = await tasks('detail', { taskId: ids.stale })
  assert.equal(stale.approvals[0].valid, false)
  assert.equal(stale.approvals[0].invalidReason, 'task-version-moved')

  const missing = await tasks('detail', { taskId: 'no-such-task' })
  assert.equal(missing.available, true)
  assert.equal(missing.found, false, 'an unknown task is a stated fact, not a transport error')
  assert.equal(missing.notFoundReason, 'task-not-found')
})

/* ── read-only guarantee ─────────────────────────────────────────────── */

test('E04-02 the projection is READ ONLY: no ledger row changes across reads', async () => {
  const before = counts()
  // The Host boot itself must not have rewritten the seeded task ledger.
  for (const table of ['task', 'action', 'approval', 'task_revision', 'source_cursor']) {
    assert.equal(before[table], seededCounts[table], `host boot must not rewrite ${table}`)
  }
  assert.ok(before.audit_event >= seededCounts.audit_event)
  for (const request of [undefined, { group: 'needs_me' }, { pending: 'any' }, { q: '看板' }, { orderBy: 'updatedAt' }]) {
    await tasks('list', request)
  }
  await tasks('detail', { taskId: ids.verify })
  await tasks('detail', { taskId: ids.approve })
  await tasks('capabilities')
  const after = counts()
  assert.deepEqual(after, before, 'reads must not insert/update any task, action, approval, revision, audit or cursor row')
})

/* ── the one write-ish command is refused + audited ──────────────────── */

test('TB09 setPriority is refused with CAPABILITY_UNAVAILABLE and leaves a durable audit row', async () => {
  const before = counts()
  const body = await call('boopTasks/setPriority', { request: { taskId: ids.active, expectedVersion: 2, priority: 'high' } })
  assert.equal(body.result.ok, true, 'the transport call succeeds; the business fact is the refusal')
  const value = body.result.value
  assert.equal(value.accepted, false)
  assert.equal(value.executed, false)
  assert.equal(value.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(value.reason, 'priority-persistence-not-wired')
  assert.equal(value.writeModeEnabled, true)
  assert.deepEqual(value.blockedByGates, [])
  assert.equal(value.localViewOnly, true)
  assert.equal(value.audit.recorded, true)
  assert.equal(value.audit.sink, 'ledger')
  assert.equal(value.audit.kind, 'tasks/write-refused')

  const after = counts()
  for (const table of ['task', 'action', 'approval', 'task_revision', 'source_cursor']) {
    assert.equal(after[table], before[table], `a refused write must not change ${table}`)
  }
  assert.equal(after.audit_event, before.audit_event + 1, 'the refusal is audited exactly once')

  const auditRow = probe.db
    .prepare("SELECT kind, object_id, reason FROM audit_event WHERE kind = 'tasks/write-refused' ORDER BY rowid DESC LIMIT 1")
    .get()
  assert.ok(auditRow, 'the audit row is durable in the BOOP ledger')
  assert.equal(auditRow.object_id, ids.active)
  assert.match(auditRow.reason, /CAPABILITY_UNAVAILABLE/)
  assert.match(auditRow.reason, /gates=G0[3-9]/)

  // Nothing about the task moved: the card is byte-identical before/after.
  const afterList = await tasks('list', { group: 'in_progress' })
  assert.equal(afterList.tasks[0].taskVersion, 2)
})

test('TB05/TB09 no verification/approval mutation endpoint exists on this row', async () => {
  for (const endpoint of ['boopTasks/verification', 'boopTasks/approve', 'boopTasks/updateTask']) {
    const { status, body } = await rpc(base, cookie, endpoint, { request: {} })
    // Either the gateway knows no such endpoint (404) or it refuses the call as a
    // business failure; in both cases there is no verification/approval command.
    if (status === 200) {
      assert.equal(body.result.ok, false, `${endpoint} must not exist`)
      assert.ok(body.result.error?.code, `${endpoint} must fail with a gateway error code`)
    } else {
      assert.equal(status, 404, `${endpoint} must be an unknown endpoint (got ${status})`)
    }
  }
})

/* ── trust boundary ──────────────────────────────────────────────────── */

test('E04-02 every boopTasks endpoint rejects anonymous callers', async () => {
  for (const endpoint of [
    'boopTasks/list',
    'boopTasks/detail',
    'boopTasks/capabilities',
    'boopTasks/setPriority',
  ]) {
    const response = await anonymousRequest(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'anon',
        method: endpoint,
        payload: { args: { request: { taskId: ids.active } } },
      }),
    })
    assert.ok([401, 403].includes(response.status), `${endpoint} anonymous -> ${response.status}`)
  }
})
