#!/usr/bin/env node
/**
 * E04-02 Host half · Taskboard read-only projection view-model.
 *
 * Gates/scenes this unit suite covers: G09 (read-only UI/data plane), TB04
 * (three-axis → four display groups, execution end ≠ verification pass), TB05
 * (no cross-column write path; same-column order is local only), TB06 (version
 * + stale-response contract), TB09 (write entry points refused server-side).
 *
 * The ledger is the REAL E01/E02 SQLite repository in a temporary directory;
 * only the host port (gate/audit/sequence) is a fake. No DSH host is started
 * here — the real rc.2.1 host assertions live in
 * `tests/host/e04-02-tasks-in-host.test.mjs`.
 *
 * Run: node --test tests/unit/e04-02-tasks.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import {
  DISPLAY_GROUPS,
  TASKS_ENDPOINTS,
  TASKS_PAGE_DEFAULT,
  TASKS_PAGE_MAX,
  TASKS_SCAN_MAX,
  TASKS_WRITE_ENDPOINTS,
  deriveDisplayGroup,
  orderTaskCards,
  setPriorityFacts,
  taskDetailFacts,
  tasksCapabilitiesFacts,
  tasksListFacts,
  toTaskCard,
} from '../../src/host/tasks.ts'
import * as tasksModule from '../../src/host/tasks.ts'

/* ── fixture ledger ───────────────────────────────────────────────────── */

let dir
let db
let repo
let clock = Date.parse('2026-10-18T00:00:00.000Z')
let counter = 0
const SCOPE = 'boop-e04-02-unit'
const ids = {}

const now = () => new Date((clock += 1000)).toISOString()
const nextId = () => `id-${++counter}`

function seed() {
  repo.ensureScope(SCOPE, 'owner-test')
  repo.bindMainSession(SCOPE, 'boop-main')

  const create = (key, goal, criteria = ['可验证'], exclusions = ['不部署']) => {
    const task = repo.createTask({ scopeId: SCOPE, goal, criteria, exclusions })
    ids[key] = task.id
    return task
  }
  const move = (key, lifecycle, expected = repo.getTask(SCOPE, ids[key]).version) =>
    repo.updateTask({ scopeId: SCOPE, taskId: ids[key], expectedVersion: expected, lifecycle })
  const verify = (key, verification, expected = repo.getTask(SCOPE, ids[key]).version) =>
    repo.updateTask({ scopeId: SCOPE, taskId: ids[key], expectedVersion: expected, verification })
  const dispatch = (key, payloadHash, state) => {
    const task = repo.getTask(SCOPE, ids[key])
    const action = repo.beginAction({
      scopeId: SCOPE,
      taskId: task.id,
      expectedTaskVersion: task.version,
      targetSessionId: `sess-${key}`,
      payloadHash,
      payload: { instruction: '继续' },
      originRef: 'dsh:operator',
      policyEpoch: 1,
    })
    if (state !== undefined) repo.markActionState(SCOPE, action.id, state)
    return action
  }

  /* 待开始 */
  create('todo', '整理空状态文案')
  create('paused', '补充深色主题文案')
  move('paused', 'active')
  move('paused', 'paused')

  /* 进行中（执行轴：running） */
  create('active', '接入任务看板列投影')
  move('active', 'active')
  dispatch('active', 'hash-active', 'running')

  /* 待我处理 · 有效待决审批 */
  create('approval', '批量归档旧看板任务')
  move('approval', 'active')
  const approvalAction = dispatch('approval', 'hash-approval')
  repo.createApproval({
    scopeId: SCOPE,
    actionId: approvalAction.id,
    payloadHash: 'hash-approval',
    taskVersion: repo.getTask(SCOPE, ids.approval).version,
    policyEpoch: 1,
    requestingOwner: 'dsh-local-owner',
    nonceHash: 'nonce-approval-1',
    expiresAt: new Date(clock + 3_600_000).toISOString(),
  })

  /* 待我处理 · 旧审批（任务版本已移动 → 已失效） */
  create('stale', '删除旧看板数据')
  move('stale', 'active')
  const staleAction = dispatch('stale', 'hash-stale')
  repo.createApproval({
    scopeId: SCOPE,
    actionId: staleAction.id,
    payloadHash: 'hash-stale',
    taskVersion: 2,
    policyEpoch: 1,
    requestingOwner: 'dsh-local-owner',
    nonceHash: 'nonce-stale-1',
    expiresAt: new Date(clock + 3_600_000).toISOString(),
  })
  move('stale', 'paused') // version 3 ≠ approval's taskVersion 2

  /* 待我处理 · 过期审批 */
  create('expired', '合并重复任务卡')
  move('expired', 'active')
  const expiredAction = dispatch('expired', 'hash-expired')
  repo.createApproval({
    scopeId: SCOPE,
    actionId: expiredAction.id,
    payloadHash: 'hash-expired',
    taskVersion: 2,
    policyEpoch: 1,
    requestingOwner: 'dsh-local-owner',
    nonceHash: 'nonce-expired-1',
    expiresAt: new Date(clock - 1000).toISOString(),
  })

  /* 待我处理 · 恢复 / 阻塞 */
  create('recovery', '恢复被中断的派发')
  move('recovery', 'recovery_required')
  create('blocked', '等待外部依赖')
  move('blocked', 'blocked')

  /* 待我处理 · 人工验收（执行已 settle + verification pending） */
  create('verification', '生成验收证据')
  move('verification', 'active')
  const verifyAction = dispatch('verification', 'hash-verify')
  repo.markActionState(SCOPE, verifyAction.id, 'settled')
  verify('verification', 'pending')

  /* 待我处理 · 验收失败（draft 生命周期，已失败验收仍是待处理） */
  create('failed', '修复验收失败项')
  verify('failed', 'failed')

  /* 待我处理 · 结果未知 */
  create('unknown', '派发结果未知的任务')
  move('unknown', 'active')
  dispatch('unknown', 'hash-unknown', 'outcome_unknown')

  /* 已结束 */
  create('done', '完成主聊天入口')
  verify('done', 'passed')
  move('done', 'completed')
  create('waived', '结束但未验收')
  verify('waived', 'waived')
  move('waived', 'completed')
  create('cancelled', '取消旧方案')
  move('cancelled', 'cancelled')

  /* 目标（工作区 + 受托 Session）——每张卡一个独立 resourceKey */
  repo.addTarget({
    scopeId: SCOPE,
    taskId: ids.active,
    workspaceId: 'ws-board',
    sessionId: 'sess-board',
    role: 'primary',
    resourceKey: 'sess-board',
  })
  repo.addTarget({
    scopeId: SCOPE,
    taskId: ids.verification,
    workspaceId: 'ws-verify',
    sessionId: 'sess-verify',
    role: 'primary',
    resourceKey: 'sess-verify',
  })

  /* 依赖边 */
  repo.addDependency({ scopeId: SCOPE, taskId: ids.todo, dependsOn: ids.done })
  repo.addDependency({ scopeId: SCOPE, taskId: ids.blocked, dependsOn: ids.active })

  /* 证据：fact + evidence 地址 + 该任务对事实版本的消费 */
  repo.upsertFact({
    scopeId: SCOPE,
    factId: 'fact-e04',
    ownerType: 'task',
    ownerId: ids.verification,
    kind: 'verification',
    text: '验收需要 42 号事件',
    authority: 'tool_observed',
  })
  repo.addEvidence({ scopeId: SCOPE, factId: 'fact-e04', sessionId: 'sess-verify', seq: 42, sourceHash: 'hash-42', artifactRef: 'artifact-42' })
  db.db
    .prepare(
      'INSERT INTO fact_consumption(id,fact_id,scope_id,fact_version,task_id,action_id,use_kind) VALUES(?,?,?,?,?,?,?)',
    )
    .run('fc-e04', 'fact-e04', SCOPE, 1, ids.verification, verifyAction.id, 'verification')

  /* LIKE 转义夹具：`%`/`_` 必须按字面匹配 */
  create('percent', '进度 100% 记录')
  create('underscore', 'a_b 命名规范')
  create('lookalike', 'axb 命名规范')

}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e04-02-tasks-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, now, nextId)
  seed()
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** The only fake surface: gate, sequence, audit, clock. The ledger is real. */
function makePort(options = {}) {
  const {
    writeModeEnabled = false,
    gates = { G01: 'PASS', G02: 'NOT_RUN', G03: 'NOT_RUN', G05: 'NOT_RUN', G09: 'NOT_RUN' },
    auditSink = 'ledger',
    ledger = () => ({
      scopeId: SCOPE,
      listTasks: (scopeId, filter) => repo.listTasks(scopeId, filter),
      listApprovals: (scopeId, filter) => repo.listApprovals(scopeId, filter),
      taskDetail: (scopeId, taskId) => repo.taskDetail(scopeId, taskId),
    }),
  } = options
  let seq = 0
  const audits = []
  return {
    ledger,
    gate: () => ({
      writeModeEnabled: () => writeModeEnabled,
      gates: () => ({ ...gates }),
      blockedByGates: () => {
        const frozen = ['G02', 'G05'].filter((gate) => gates[gate] !== 'PASS')
        const rest = Object.entries(gates)
          .filter(([, state]) => state !== 'PASS')
          .map(([gate]) => gate)
          .filter((gate) => !frozen.includes(gate))
        return [...frozen, ...rest]
      },
    }),
    nextProjectionSeq: () => ++seq,
    now,
    audit: (entry) => {
      audits.push(entry)
      return { recorded: true, sink: auditSink, id: `audit-${audits.length}` }
    },
    auditSink: () => auditSink,
    diagnostics: () => ({ test: 'unit' }),
    audits,
  }
}

const list = (request, port = makePort()) => tasksListFacts(port, request)
const detail = (request, port = makePort()) => taskDetailFacts(port, request)
const cardById = (response, key) => response.tasks.find((card) => card.taskId === ids[key])

/* ── four display groups ─────────────────────────────────────────────── */

test('E04-02 four display groups are derived from the three axes, in frozen order', () => {
  const response = list()
  assert.equal(response.available, true)
  assert.equal(response.readOnly, true)
  assert.deepEqual(
    response.groups.map((group) => [group.key, group.label, group.order]),
    [
      ['todo', '待开始', 1],
      ['in_progress', '进行中', 2],
      ['needs_me', '待我处理', 3],
      ['finished', '已结束', 4],
    ],
  )
  assert.equal(response.tasks.length, Number(db.db.prepare('SELECT count(*) c FROM task').get().c))

  const expectedGroup = {
    todo: 'todo',
    paused: 'todo',
    active: 'in_progress',
    approval: 'needs_me',
    stale: 'needs_me',
    expired: 'needs_me',
    recovery: 'needs_me',
    blocked: 'needs_me',
    verification: 'needs_me',
    failed: 'needs_me',
    unknown: 'needs_me',
    done: 'finished',
    waived: 'finished',
    cancelled: 'finished',
    percent: 'todo',
    underscore: 'todo',
    lookalike: 'todo',
  }
  for (const [key, group] of Object.entries(expectedGroup)) {
    const card = cardById(response, key)
    assert.ok(card, `${key} must be projected`)
    assert.equal(card.displayGroup, group, `${key} -> ${group} (got ${card.displayGroup})`)
    assert.equal(card.displayGroupLabel, DISPLAY_GROUPS.find((entry) => entry.key === group).label)
  }
  const counts = Object.fromEntries(response.groups.map((group) => [group.key, group.count]))
  assert.deepEqual(counts, {
    todo: 5,
    in_progress: 1,
    needs_me: 8,
    finished: 3,
  })
  assert.equal(counts.todo + counts.in_progress + counts.needs_me + counts.finished, response.total)
})

test('E04-02 execution end is not verification: settled execution with pending verification needs a human', () => {
  const response = list()
  const settleVerify = cardById(response, 'verification')
  assert.equal(settleVerify.authorization, 'settled', 'the execution axis stays settled')
  assert.equal(settleVerify.verification, 'pending', 'verification is a separate axis')
  assert.equal(settleVerify.displayGroup, 'needs_me')
  assert.equal(settleVerify.pendingReason, 'verification')
  assert.equal(settleVerify.statusLine, '待你验收')
  // Finishing a task is distinct: passed / waived / cancelled are all "finished"
  // but the derived status line keeps the reason, never one green "success".
  assert.equal(cardById(response, 'done').statusLine, '已结束（验收通过）')
  assert.equal(cardById(response, 'waived').statusLine, '已结束（验收豁免）')
  assert.equal(cardById(response, 'cancelled').statusLine, '已结束（已取消）')
})

test('E04-02 pending reasons: approval / approval_stale / recovery / blocked / failed / unknown', () => {
  const response = list()
  const reasons = Object.fromEntries(response.tasks.map((card) => [card.taskId, card.pendingReason]))
  assert.equal(reasons[ids.approval], 'approval')
  assert.equal(reasons[ids.stale], 'approval_stale')
  assert.equal(reasons[ids.expired], 'approval_stale')
  assert.equal(reasons[ids.recovery], 'recovery')
  assert.equal(reasons[ids.blocked], 'blocked')
  assert.equal(reasons[ids.failed], 'verification_failed')
  assert.equal(reasons[ids.unknown], 'outcome_unknown')

  const approval = cardById(response, 'approval')
  assert.equal(approval.pendingApproval.valid, true, 'a still-binding approval is actionable')
  assert.equal(approval.pendingApproval.invalidReason, null)
  assert.equal(approval.authorization, 'dispatching')

  const stale = cardById(response, 'stale')
  assert.equal(stale.pendingApproval.valid, false, 'the old card must not be clickable')
  assert.equal(stale.pendingApproval.invalidReason, 'task-version-moved')
  const expired = cardById(response, 'expired')
  assert.equal(expired.pendingApproval.valid, false)
  assert.equal(expired.pendingApproval.invalidReason, 'expired')

  const unknown = cardById(response, 'unknown')
  assert.equal(unknown.authorization, 'outcome_unknown')
  assert.equal(unknown.statusLine, '执行结果未知，需人工核查')
})

test('E04-02 a paused card is 待开始 (not running, not finished) and says why', () => {
  const card = cardById(list(), 'paused')
  assert.equal(card.displayGroup, 'todo')
  assert.equal(card.lifecycle, 'paused')
  assert.equal(card.statusLine, '已暂停（待恢复）')
})

test('E04-02 precedence: completed beats every pending axis; a valid approval beats an unknown outcome', () => {
  const fixture = repo.getTask(SCOPE, ids.done)
  const row = repo.taskDetail(SCOPE, fixture.id).task
  assert.equal(deriveDisplayGroup(row).group, 'finished')
  const unknownRow = repo.taskDetail(SCOPE, ids.unknown).task
  assert.equal(deriveDisplayGroup(unknownRow).group, 'needs_me')
  assert.equal(deriveDisplayGroup(unknownRow).pendingReason, 'outcome_unknown')
})

/* ── filters ─────────────────────────────────────────────────────────── */

test('E04-02 filters: group / lifecycle / verification / workspace / session / query / pending', () => {
  const byGroup = list({ group: 'needs_me' })
  assert.equal(byGroup.total, 8)
  assert.ok(byGroup.tasks.every((card) => card.displayGroup === 'needs_me'))
  assert.deepEqual(
    byGroup.groups.map((group) => group.count),
    [0, 0, 8, 0],
    'group counts always describe the filtered set',
  )

  const byLifecycle = list({ lifecycle: ['completed', 'cancelled'] })
  assert.deepEqual(byLifecycle.tasks.map((card) => card.taskId).sort(), [ids.done, ids.waived, ids.cancelled].sort())

  const byVerification = list({ verification: ['failed'] })
  assert.deepEqual(byVerification.tasks.map((card) => card.taskId), [ids.failed])

  const byWorkspace = list({ workspaceId: 'ws-board' })
  assert.deepEqual(byWorkspace.tasks.map((card) => card.taskId), [ids.active])
  assert.equal(byWorkspace.tasks[0].workspaceId, 'ws-board')
  assert.equal(byWorkspace.tasks[0].primarySessionId, 'sess-board')

  const bySession = list({ sessionId: 'sess-verify' })
  assert.deepEqual(bySession.tasks.map((card) => card.taskId), [ids.verification])

  const byQuery = list({ q: '看板' })
  assert.deepEqual(
    byQuery.tasks.map((card) => card.taskId).sort(),
    [ids.active, ids.approval, ids.stale].sort(),
    'title search is a substring match over the real goals',
  )

  // "pending" means an approval that STILL BINDS; stale/expired cards are not
  // actionable and must not be reported as pending work.
  const pendingAny = list({ pending: 'any' })
  assert.deepEqual(pendingAny.tasks.map((card) => card.taskId), [ids.approval])
  const pendingNone = list({ pending: 'none' })
  assert.ok(!pendingNone.tasks.some((card) => card.taskId === ids.approval))
  assert.ok(pendingNone.tasks.some((card) => card.taskId === ids.stale))

  const combined = list({ group: 'needs_me', lifecycle: ['active'] })
  assert.ok(combined.tasks.every((card) => card.lifecycle === 'active' && card.displayGroup === 'needs_me'))
})

test('E04-02 unknown filter values are ignored AND reported instead of hiding tasks', () => {
  const response = list({ group: 'not-a-group', lifecycle: ['done'], orderBy: 'unsupported', limit: 'many' })
  assert.deepEqual(response.ignoredFilters.sort(), ['group:not-a-group', 'lifecycle:done', 'orderBy'])
  assert.equal(response.total, 17, 'an invalid group filter must not hide the board')
  assert.equal(response.filter.orderBy, 'group', 'the default survives only as a reported default')
  assert.equal(response.filter.limit, TASKS_PAGE_DEFAULT)

  const limitClamped = list({ limit: 10_000, offset: 2 })
  assert.equal(limitClamped.filter.limit, TASKS_PAGE_MAX, 'page size is explicitly capped')
  assert.equal(limitClamped.page.limit, TASKS_PAGE_MAX)
  assert.equal(limitClamped.page.offset, 2)
})

test('E04-02 title search matches literally: LIKE wildcards are not operators', () => {
  assert.deepEqual(list({ q: '100%' }).tasks.map((card) => card.taskId), [ids.percent])
  assert.deepEqual(list({ q: 'a_b' }).tasks.map((card) => card.taskId), [ids.underscore])
  assert.deepEqual(list({ q: 'axb' }).tasks.map((card) => card.taskId), [ids.lookalike])
})

/* ── same-column ordering (local view only) ──────────────────────────── */

test('E04-02 same-column ordering is local: group order + title/time, no writes', () => {
  const beforeCounts = {
    task: Number(db.db.prepare('SELECT count(*) c FROM task').get().c),
    audit: Number(db.db.prepare('SELECT count(*) c FROM audit_event').get().c),
  }
  const byGroup = list({ limit: 100 })
  let lastOrder = 0
  for (const card of byGroup.tasks) {
    const order = DISPLAY_GROUPS.find((group) => group.key === card.displayGroup).order
    assert.ok(order >= lastOrder, 'cards stay grouped in frozen group order')
    lastOrder = order
  }
  const times = byGroup.tasks.map((card) => card.updatedAt)
  for (let index = 1; index < times.length; index += 1) {
    const previous = byGroup.tasks[index - 1].displayGroup
    const current = byGroup.tasks[index].displayGroup
    if (previous === current) {
      assert.ok(times[index - 1] >= times[index], 'within one column the newest card comes first')
    }
  }

  const byTitle = list({ group: 'needs_me', orderBy: 'title', orderDir: 'asc' }).tasks
  const titles = byTitle.map((card) => card.title)
  assert.deepEqual(titles, [...titles].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')))

  const byTime = list({ orderBy: 'updatedAt', orderDir: 'desc' }).tasks
  for (let index = 1; index < byTime.length; index += 1) {
    assert.ok(byTime[index - 1].updatedAt >= byTime[index].updatedAt)
  }

  // Ordering is a pure function of the projection: nothing was persisted.
  assert.equal(Number(db.db.prepare('SELECT count(*) c FROM task').get().c), beforeCounts.task)
  assert.equal(Number(db.db.prepare('SELECT count(*) c FROM audit_event').get().c), beforeCounts.audit)
})

test('E04-02 orderTaskCards is deterministic for equal keys (taskId tiebreaker)', () => {
  const cards = [
    { taskId: 'b', title: '同', displayGroup: 'todo', updatedAt: '2026-01-01T00:00:00.000Z' },
    { taskId: 'a', title: '同', displayGroup: 'todo', updatedAt: '2026-01-01T00:00:00.000Z' },
  ]
  assert.deepEqual(orderTaskCards(cards, 'updatedAt', 'desc').map((card) => card.taskId), ['a', 'b'])
  assert.deepEqual(orderTaskCards(cards, 'title', 'asc').map((card) => card.taskId), ['a', 'b'])
})

/* ── versions + stale responses (TB06) ───────────────────────────────── */

test('E04-02 every response carries a monotonic projectionSeq and each card its taskVersion', () => {
  const port = makePort()
  const first = tasksListFacts(port)
  const second = tasksListFacts(port)
  assert.ok(second.projectionSeq > first.projectionSeq, 'response sequence is monotonic')

  let state = null
  const accept = (response) => {
    if (state !== null && response.projectionSeq <= state.projectionSeq) return false
    state = response
    return true
  }
  assert.equal(accept(second), true)
  assert.equal(accept(first), false, 'an older response must be droppable by the client')
  assert.equal(state.projectionSeq, second.projectionSeq)

  const activeCard = cardById(second, 'active')
  assert.equal(activeCard.taskVersion, 2, 'taskVersion is the ledger optimistic-concurrency version')
  const activeRow = repo.getTask(SCOPE, ids.active)
  assert.equal(activeCard.taskVersion, activeRow.version)
})

test('TB06 a version bump produces a newer taskVersion in the next snapshot', () => {
  const port = makePort()
  const beforeSnapshot = tasksListFacts(port)
  const beforeCard = cardById(beforeSnapshot, 'active')
  repo.updateTask({ scopeId: SCOPE, taskId: ids.active, expectedVersion: beforeCard.taskVersion, lifecycle: 'paused' })
  const afterSnapshot = tasksListFacts(port)
  const afterCard = cardById(afterSnapshot, 'active')
  assert.ok(afterSnapshot.projectionSeq > beforeSnapshot.projectionSeq)
  assert.ok(afterCard.taskVersion > beforeCard.taskVersion, 'the client can compare versions before writing')
  assert.equal(afterCard.displayGroup, 'todo', 'the projection follows the real lifecycle immediately')

  // restore for later tests
  repo.updateTask({ scopeId: SCOPE, taskId: ids.active, expectedVersion: afterCard.taskVersion, lifecycle: 'active' })
})

/* ── the only write-ish command: refused + audited (TB05/TB09) ───────── */

const snapshotCounts = () => ({
  task: Number(db.db.prepare('SELECT count(*) c FROM task').get().c),
  action: Number(db.db.prepare('SELECT count(*) c FROM action').get().c),
  approval: Number(db.db.prepare('SELECT count(*) c FROM approval').get().c),
  revision: Number(db.db.prepare('SELECT count(*) c FROM task_revision').get().c),
  audit: Number(db.db.prepare('SELECT count(*) c FROM audit_event').get().c),
})

test('TB09 setPriority fails closed with CAPABILITY_UNAVAILABLE and writes an audit row, nothing else', () => {
  const port = makePort()
  const before = snapshotCounts()
  const refusal = setPriorityFacts(port, { taskId: ids.active, expectedVersion: 2, priority: 'high' })
  assert.equal(refusal.accepted, false)
  assert.equal(refusal.executed, false)
  assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(refusal.reason, 'write-mode-disabled')
  assert.equal(refusal.writeModeEnabled, false)
  assert.ok(refusal.blockedByGates.includes('G02'))
  assert.ok(refusal.blockedByGates.includes('G05'))
  assert.equal(refusal.localViewOnly, true)
  assert.deepEqual(refusal.requested, { taskId: ids.active, expectedVersion: 2, priority: 'high' })
  assert.equal(refusal.audit.recorded, true)
  assert.equal(refusal.audit.kind, 'tasks/write-refused')
  assert.equal(port.audits.length, 1)
  assert.equal(port.audits[0].kind, 'tasks/write-refused')
  assert.match(port.audits[0].reason, /CAPABILITY_UNAVAILABLE/)

  const after = snapshotCounts()
  assert.deepEqual(after, before, 'a refused write changes no ledger row at all')
})

test('TB05 even with the gate injected open, no priority-persistence path exists: still refused', () => {
  const port = makePort({ writeModeEnabled: true, gates: { G02: 'PASS', G05: 'PASS' } })
  const refusal = setPriorityFacts(port, { taskId: ids.active, priority: 'low' })
  assert.equal(refusal.accepted, false)
  assert.equal(refusal.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(refusal.reason, 'priority-persistence-not-wired')
  assert.deepEqual(refusal.blockedByGates, [])
  assert.equal(refusal.audit.sink, 'ledger')
})

test('TB05/TB09 the module exposes no verification/approval mutation surface', () => {
  assert.deepEqual([...TASKS_ENDPOINTS], [
    'boopTasks/capabilities',
    'boopTasks/list',
    'boopTasks/detail',
    'boopTasks/setPriority',
  ])
  assert.deepEqual([...TASKS_WRITE_ENDPOINTS], ['boopTasks/setPriority'])
  for (const endpoint of TASKS_ENDPOINTS) {
    assert.doesNotMatch(endpoint, /verification|approval|verify|approve|done|complete/i)
  }
  const exportedFunctions = Object.entries(tasksModule)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
  assert.ok(!exportedFunctions.some((name) => /verification|approval|completeTask|cancelTask/i.test(name)))
  assert.ok(exportedFunctions.includes('setPriorityFacts'))
  assert.ok(!exportedFunctions.includes('updateTask'))

  const capabilities = tasksCapabilitiesFacts(makePort())
  assert.equal(capabilities.canCommit, false)
  assert.equal(capabilities.canChangeVerification, false)
  assert.equal(capabilities.canChangeApproval, false)
  assert.deepEqual(capabilities.methods.filter((method) => method.kind === 'write').map((method) => method.method), [
    'setPriority',
  ])
  assert.equal(capabilities.writeMode.enabled, false)
  assert.ok(capabilities.blockedBy.includes('G02'))
  assert.ok(capabilities.blockedBy.includes('G05'))
  assert.equal(capabilities.audit.sink, 'ledger')
  assert.equal(capabilities.readOnly, true)
  assert.equal(capabilities.canSortLocal, true)
  assert.equal(capabilities.diagnostics.test, 'unit')
})

/* ── detail ──────────────────────────────────────────────────────────── */

test('E04-02 detail: latest snapshot + revision summaries + targets + deps + evidence address', () => {
  const response = detail({ taskId: ids.verification })
  assert.equal(response.available, true)
  assert.equal(response.found, true)
  assert.equal(response.task.taskId, ids.verification)
  assert.equal(response.task.taskVersion, repo.getTask(SCOPE, ids.verification).version)
  assert.equal(response.snapshot.version, response.task.taskVersion)
  assert.equal(response.snapshot.goal, '生成验收证据')
  assert.deepEqual(response.snapshot.criteria, ['可验证'])
  assert.equal(response.revisions[0].version, response.snapshot.version, 'revisions are newest-first')
  assert.equal(response.coverage.revisionCount, response.revisions.length)
  assert.equal(response.actions.length, 1, 'the settled action is the latest execution fact')
  assert.equal(response.actions[0].state, 'settled')
  assert.equal(response.targets[0].sessionId, 'sess-verify')
  assert.equal(response.evidence.length, 1)
  assert.equal(response.evidence[0].factId, 'fact-e04')
  assert.equal(response.evidence[0].sessionId, 'sess-verify')
  assert.equal(response.evidence[0].seq, 42)
  assert.equal(response.evidence[0].address, 'session:sess-verify#seq:42')
  assert.deepEqual(response.limitations, [])
})

test('E04-02 detail shows invalid approvals as invalid and dependencies both ways', () => {
  const stale = detail({ taskId: ids.stale })
  assert.equal(stale.approvals.length, 1)
  assert.equal(stale.approvals[0].status, 'pending')
  assert.equal(stale.approvals[0].valid, false)
  assert.equal(stale.approvals[0].invalidReason, 'task-version-moved')

  const todo = detail({ taskId: ids.todo })
  assert.equal(todo.dependencies.count, 1)
  assert.deepEqual(todo.dependencies.dependsOn, [ids.done])
  const done = detail({ taskId: ids.done })
  assert.deepEqual(done.dependencies.dependedOnBy, [ids.todo])
})

test('E04-02 detail: unknown task and invalid request are stated facts, not empty successes', () => {
  const missing = detail({ taskId: 'no-such-task' })
  assert.equal(missing.available, true)
  assert.equal(missing.found, false)
  assert.equal(missing.notFoundReason, 'task-not-found')
  assert.equal(missing.task, null)

  const invalid = detail({})
  assert.equal(invalid.available, true)
  assert.equal(invalid.found, false)
  assert.equal(invalid.notFoundReason, 'invalid-request')
})

/* ── availability honesty (FE-11) ────────────────────────────────────── */

test('FE-11 an unreadable ledger is unavailable, never an empty task list', () => {
  const noLedger = makePort({ ledger: () => null })
  const missing = tasksListFacts(noLedger)
  assert.equal(missing.available, false)
  assert.equal(missing.reason, 'ledger-unavailable')
  assert.deepEqual(missing.tasks, [])
  assert.deepEqual(missing.groups, [], 'no fake zero-count groups on an unreadable ledger')

  const detailMissing = taskDetailFacts(noLedger, { taskId: ids.todo })
  assert.equal(detailMissing.available, false)
  assert.equal(detailMissing.reason, 'ledger-unavailable')
  assert.equal(detailMissing.found, false)

  const capsMissing = tasksCapabilitiesFacts(noLedger)
  assert.equal(capsMissing.available, false)
  assert.equal(capsMissing.reason, 'ledger-unavailable')
  assert.equal(capsMissing.methods.find((method) => method.method === 'list').status, 'unavailable')
})

test('FE-11 a ledger read failure is reported with its reason, not swallowed', () => {
  const broken = makePort({
    ledger: () => ({
      scopeId: SCOPE,
      listTasks: () => {
        throw new Error('disk I/O error')
      },
      listApprovals: () => {
        throw new Error('disk I/O error')
      },
      taskDetail: () => {
        throw new Error('disk I/O error')
      },
    }),
  })
  const response = tasksListFacts(broken)
  assert.equal(response.available, false)
  assert.equal(response.reason, 'ledger-read-failed')
  assert.equal(response.detail, 'disk I/O error')
  const detailResponse = taskDetailFacts(broken, { taskId: ids.todo })
  assert.equal(detailResponse.available, false)
  assert.equal(detailResponse.reason, 'ledger-read-failed')
  const capabilities = tasksCapabilitiesFacts(broken)
  assert.equal(capabilities.available, false)
  assert.equal(capabilities.reason, 'ledger-read-failed')
})

/* ── pagination + scan caps ──────────────────────────────────────────── */

test('E04-02 pagination is explicit and bounded; totals describe the whole filtered set', () => {
  const page = list({ group: 'needs_me', limit: 2, offset: 0 })
  assert.equal(page.page.limit, 2)
  assert.equal(page.page.returned, 2)
  assert.equal(page.page.total, 8)
  assert.equal(page.page.hasMore, true)
  assert.equal(page.page.defaultLimit, TASKS_PAGE_DEFAULT)
  assert.equal(page.page.maxLimit, TASKS_PAGE_MAX)
  assert.equal(page.total, 8, 'total is not the page size')
  assert.equal(page.scan.cap, TASKS_SCAN_MAX)
  assert.equal(page.scan.truncated, false)
})

/* ── wire stability of the card shape ────────────────────────────────── */

test('E04-02 card keeps the frozen field contract the client codes against', () => {
  const card = cardById(list(), 'active')
  for (const field of [
    'taskId',
    'title',
    'lifecycle',
    'authorization',
    'verification',
    'displayGroup',
    'displayGroupLabel',
    'pendingReason',
    'pendingApproval',
    'taskVersion',
    'workspaceId',
    'primarySessionId',
    'targets',
    'targetCount',
    'dependencyCount',
    'latestAction',
    'statusLine',
    'createdAt',
    'updatedAt',
  ]) {
    assert.ok(field in card, `card field ${field} missing`)
  }
  assert.equal(card.title, '接入任务看板列投影')
  assert.deepEqual(card.targets, [{ workspaceId: 'ws-board', sessionId: 'sess-board', role: 'primary', resourceKey: 'sess-board' }])
  assert.equal(card.latestAction.state, 'running')
  assert.equal(card.latestAction.targetSessionId, 'sess-active')
  // toTaskCard is a pure projection: same row -> deep-equal card.
  const row = repo.taskDetail(SCOPE, ids.active).task
  assert.deepEqual(toTaskCard(row), card)
})
