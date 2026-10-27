#!/usr/bin/env node
/**
 * E01-01 · Structured ledger, repositories, and migration.
 *
 * Gate: G08. Scenes: AT-14 (task version conflict), AT-15, AT-24/AT-26.
 *
 * Synthetic data in a temporary directory only.
 * Run: node tests/unit/e01-01-ledger.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase, snapshotBackup, verifyDatabase } from '../../src/host/persistence/database.ts'
import { migrate } from '../../src/host/persistence/migrate.ts'
import { ApprovalConflict, BoopRepository, LedgerConflict } from '../../src/host/persistence/repository.ts'

let dir
let db
let repo
let counter = 0

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e01-01-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, () => new Date().toISOString(), () => `id-${++counter}`)
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const SCOPE = 'scope-test'

test('E01-01 the scope is created once, even under a concurrent second caller', () => {
  const first = repo.ensureScope(SCOPE, 'owner-1')
  const second = repo.ensureScope(SCOPE, 'owner-2')
  assert.equal(first.scopeId, SCOPE)
  assert.equal(second.ownerId, 'owner-1', 'a second caller must reuse the existing identity')
  assert.equal(second.policyEpoch, 1)
})

test('E01-01 the main Session binds once and never silently rebinds', () => {
  const bound = repo.bindMainSession(SCOPE, 'session-main')
  assert.equal(bound.mainSessionId, 'session-main')
  assert.equal(repo.bindMainSession(SCOPE, 'session-main').mainSessionId, 'session-main')
  assert.throws(() => repo.bindMainSession(SCOPE, 'session-other'), LedgerConflict)
})

test('E01-01 a task starts draft and keeps an append-only revision trail', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '推进分屏窄屏检查', criteria: ['窄屏可用'], exclusions: ['不部署'] })
  assert.equal(task.lifecycle, 'draft')
  assert.equal(task.verification, 'not_requested')
  assert.equal(task.version, 1)
  assert.equal(repo.revisions(SCOPE, task.id).length, 1)
  assert.ok(repo.auditTrail(SCOPE).some((row) => row.kind === 'task/created'))
})

test('AT-14 a stale writer is refused with TASK_VERSION_CONFLICT', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '检查侧栏折叠' })
  const v1 = repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  assert.equal(v1.version, 2)
  assert.throws(
    () => repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'paused' }),
    (error) => error.code === 'TASK_VERSION_CONFLICT',
  )
  assert.equal(repo.getTask(SCOPE, task.id).lifecycle, 'active', 'the stale write changed nothing')
})

test('E01-01 three axes are independent: lifecycle and verification do not overwrite each other', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '写证据' })
  let row = repo.getTask(SCOPE, task.id)
  row = repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: row.version, verification: 'pending' })
  assert.equal(row.verification, 'pending')
  assert.equal(row.lifecycle, 'draft', 'setting verification must not move the lifecycle')
  row = repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: row.version, lifecycle: 'completed', verification: 'passed' })
  assert.equal(row.lifecycle, 'completed')
  assert.equal(row.verification, 'passed')
})

test('E01-01 a completed task cannot claim completion without verification', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '未验证就结束' })
  assert.throws(
    () => repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'completed' }),
    LedgerConflict,
  )
})

test('E01-01 two active tasks cannot hold the same resource key', () => {
  const a = repo.createTask({ scopeId: SCOPE, goal: 'A' })
  const b = repo.createTask({ scopeId: SCOPE, goal: 'B' })
  repo.updateTask({ scopeId: SCOPE, taskId: a.id, expectedVersion: 1, lifecycle: 'active' })
  repo.addTarget({ scopeId: SCOPE, taskId: a.id, workspaceId: 'ws-1', sessionId: 'sess-1', role: 'primary', resourceKey: 'sess-1' })
  repo.updateTask({ scopeId: SCOPE, taskId: b.id, expectedVersion: 1, lifecycle: 'active' })
  assert.throws(
    () => repo.addTarget({ scopeId: SCOPE, taskId: b.id, workspaceId: 'ws-1', sessionId: 'sess-1', role: 'primary', resourceKey: 'sess-1' }),
    /already held/,
  )
  assert.equal(repo.holdersOfSession(SCOPE, 'sess-1')[0].taskId, a.id)
})

test('E01-01 a dependency cycle is rejected at the repository boundary', () => {
  const a = repo.createTask({ scopeId: SCOPE, goal: 'dep-a' })
  const b = repo.createTask({ scopeId: SCOPE, goal: 'dep-b' })
  repo.addDependency({ scopeId: SCOPE, taskId: a.id, dependsOn: b.id })
  assert.throws(() => repo.addDependency({ scopeId: SCOPE, taskId: b.id, dependsOn: a.id }), /cycle/)
  assert.throws(() => repo.addDependency({ scopeId: SCOPE, taskId: a.id, dependsOn: a.id }), /itself/)
})

test('E02-03 an action is planned against the exact task version and lands in the outbox', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '继续实现' })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  const current = repo.getTask(SCOPE, task.id)
  const action = repo.beginAction({
    scopeId: SCOPE,
    taskId: task.id,
    expectedTaskVersion: current.version,
    targetSessionId: 'sess-dev',
    payloadHash: 'abc123',
    payload: { instruction: '继续' },
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  assert.equal(action.state, 'dispatching')
  assert.equal(repo.getAction(SCOPE, action.id)?.taskVersion, current.version)
})

test('AT-14 an action planned before a task version bump is refused', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '会改方案的任务' })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  assert.throws(
    () =>
      repo.beginAction({
        scopeId: SCOPE,
        taskId: task.id,
        expectedTaskVersion: 1, // the task has already moved to version 2
        targetSessionId: 'sess-dev',
        payloadHash: 'h',
        payload: {},
        originRef: 'dsh:operator',
        policyEpoch: 1,
      }),
    (error) => error instanceof LedgerConflict,
  )
})

test('E02-03 outbox claims are leased and reconciled as unknown, never auto-retried', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: 'outbox' })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  const current = repo.getTask(SCOPE, task.id)
  const action = repo.beginAction({
    scopeId: SCOPE,
    taskId: task.id,
    expectedTaskVersion: current.version,
    targetSessionId: 'sess-outbox',
    payloadHash: 'h',
    payload: {},
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  const claimed = repo.claimOutbox(SCOPE, 1_000)
  assert.ok(claimed.some((row) => row.actionId === action.id))
  assert.ok(
    !repo.claimOutbox(SCOPE, 1_000).some((row) => row.actionId === action.id),
    'a leased row must not be claimed twice',
  )
  const reconciled = repo.reconcileOutbox(SCOPE)
  assert.ok(reconciled.unknown.includes(action.id))
  assert.equal(repo.getAction(SCOPE, action.id).state, 'outcome_unknown')
})

test('E02-02 an approval is single-use and bound to the exact payload/version/epoch', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '危险操作' })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  const current = repo.getTask(SCOPE, task.id)
  const action = repo.beginAction({
    scopeId: SCOPE,
    taskId: task.id,
    expectedTaskVersion: current.version,
    targetSessionId: 'sess-risky',
    payloadHash: 'payload-hash',
    payload: {},
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  const approval = repo.createApproval({
    scopeId: SCOPE,
    actionId: action.id,
    payloadHash: 'payload-hash',
    taskVersion: current.version,
    policyEpoch: 1,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const binding = { scopeId: SCOPE, approvalId: approval.id, nonceHash: 'nonce-1', payloadHash: 'payload-hash', taskVersion: current.version, policyEpoch: 1 }
  assert.equal(repo.consumeApproval(binding).status, 'allowed')
  assert.equal(repo.consumeApproval(binding).status, 'allowed', 'repeat clicks stay idempotent')
  // A different payload or version is stale, never allowed.
  const second = repo.createApproval({
    scopeId: SCOPE,
    actionId: action.id,
    payloadHash: 'payload-hash',
    taskVersion: current.version,
    policyEpoch: 1,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-2',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  assert.equal(
    repo.consumeApproval({ ...binding, approvalId: second.id, nonceHash: 'nonce-2', payloadHash: 'other-payload' }).status,
    'stale',
  )
  assert.equal(
    repo.consumeApproval({ ...binding, approvalId: second.id, nonceHash: 'nonce-2', taskVersion: current.version + 5 }).status,
    'stale',
  )
})

test('E02-02 an expired approval cannot be consumed', () => {
  const task = repo.createTask({ scopeId: SCOPE, goal: '过期审批' })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  const current = repo.getTask(SCOPE, task.id)
  const action = repo.beginAction({
    scopeId: SCOPE,
    taskId: task.id,
    expectedTaskVersion: current.version,
    targetSessionId: 'sess-expired',
    payloadHash: 'h',
    payload: {},
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  const approval = repo.createApproval({
    scopeId: SCOPE,
    actionId: action.id,
    payloadHash: 'h',
    taskVersion: current.version,
    policyEpoch: 1,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-expired',
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  })
  assert.equal(
    repo.consumeApproval({
      scopeId: SCOPE,
      approvalId: approval.id,
      nonceHash: 'nonce-expired',
      payloadHash: 'h',
      taskVersion: current.version,
      policyEpoch: 1,
    }).status,
    'expired',
  )
})

test('E03-02 a memory snapshot commits against an explicit baseline and refuses a stale writer', () => {
  const first = repo.saveMemorySnapshot({
    scopeId: SCOPE,
    ownerType: 'session',
    ownerId: 'sess-dev',
    body: '快照 v1',
    coverage: { 'sess-dev#gen1': { sourceGeneration: 'gen1', throughSeq: 10 } },
    expectedBaselineVersion: 0,
  })
  assert.equal(first.version, 1)
  assert.throws(
    () =>
      repo.saveMemorySnapshot({
        scopeId: SCOPE,
        ownerType: 'session',
        ownerId: 'sess-dev',
        body: 'stale',
        coverage: {},
        expectedBaselineVersion: 0,
      }),
    (error) => error instanceof LedgerConflict,
  )
  assert.equal(repo.latestMemorySnapshot(SCOPE, 'session', 'sess-dev').body, '快照 v1')
  const second = repo.saveMemorySnapshot({
    scopeId: SCOPE,
    ownerType: 'session',
    ownerId: 'sess-dev',
    body: '快照 v2',
    coverage: {},
    expectedBaselineVersion: 1,
  })
  assert.equal(second.version, 2)
})

test('E03-01 facts keep versions, and evidence points at an exact source seq', () => {
  const v1 = repo.upsertFact({ scopeId: SCOPE, factId: 'fact-1', ownerType: 'session', ownerId: 'sess-dev', kind: 'decision', text: '不部署', authority: 'user_confirmed' })
  assert.equal(v1.version, 1)
  const v2 = repo.upsertFact({ scopeId: SCOPE, factId: 'fact-1', ownerType: 'session', ownerId: 'sess-dev', kind: 'decision', text: '不部署生产，仅灰度', authority: 'user_confirmed' })
  assert.equal(v2.version, 2)
  repo.addEvidence({ scopeId: SCOPE, factId: 'fact-1', sessionId: 'sess-dev', seq: 42, sourceHash: 'h-42' })
  const versions = db.db.prepare('SELECT version FROM fact_version WHERE fact_id = ? ORDER BY version').all('fact-1')
  assert.equal(versions.length, 2, 'every version stays addressable')
})

test('E03-01 source cursors track the read watermark per generation', () => {
  repo.upsertCursor({ scopeId: SCOPE, sessionId: 'sess-dev', sourceGeneration: 'gen1', throughSeq: 5, state: 'fresh' })
  repo.upsertCursor({ scopeId: SCOPE, sessionId: 'sess-dev', sourceGeneration: 'gen1', throughSeq: 9, state: 'dirty' })
  const cursors = repo.cursors(SCOPE)
  assert.equal(cursors.length, 1)
  assert.equal(cursors[0].throughSeq, 9)
  assert.equal(cursors[0].state, 'dirty')
})

test('AT-36 migration reports its source version and verifies integrity', async () => {
  const report = await migrate(db, { backupDir: path.join(dir, 'backups') })
  assert.equal(report.from, 2, 'a fresh ledger is initialized at schema 2')
  assert.equal(report.to, 2)
  assert.equal(report.applied.length, 0, 'schema 2 is not migrated again')
  assert.equal(report.integrity, 'ok')
  assert.equal(verifyDatabase(db.path).ok, true)
})