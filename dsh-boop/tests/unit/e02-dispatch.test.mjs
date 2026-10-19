#!/usr/bin/env node
/**
 * E02-01/E02-02/E02-03 · Task states, two-layer authorization, reliable dispatch.
 *
 * The transport is an explicit test double: no model, no GUI, no user data.
 * What is proven is BOOP's own control flow — preconditions, staleness,
 * approval binding, unknown-outcome handling, and deterministic stop.
 *
 * Run: node tests/unit/e02-dispatch.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { Dispatcher } from '../../src/host/dispatch/dispatcher.ts'
import { RecoveryGate } from '../../src/host/gate/recovery-gate.ts'

let dir
let db
let repo
let counter = 0
const SCOPE = 'scope-e02'
const known = new Set()
let gate
let deliveries = []
let failureMode = null

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e02-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, undefined, () => `e2-${++counter}`)
  repo.ensureScope(SCOPE, 'owner-1')
  gate = new RecoveryGate(() => {})
  gate.arm()
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function makeDispatcher() {
  deliveries = []
  failureMode = null
  return new Dispatcher({
    repo,
    scopeId: SCOPE,
    knownMessageIds: () => known,
    gateDecision: (claimed) => gate.decide(claimed),
    pendingFor: () => [],
    enqueue: async ({ envelope, targetSessionId }) => {
      deliveries.push({ envelope, targetSessionId })
      if (failureMode === 'throw') throw new Error('transport exploded after the row was claimed')
      if (failureMode === 'busy') return { messageId: envelope.messageId, accepted: false, mode: envelope.mode }
      const messageId = `host_${envelope.actionId}`
      known.add(messageId)
      return { messageId, accepted: true, mode: envelope.mode }
    },
  })
}

function activeTask(goal = '推进任务') {
  const task = repo.createTask({ scopeId: SCOPE, goal })
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: 1, lifecycle: 'active' })
  return repo.getTask(SCOPE, task.id)
}

test('E02-03 a command is delivered to the original Session with BOOP provenance', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '继续实现并做窄屏检查，不部署',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  assert.equal(outcome.kind, 'accepted')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].targetSessionId, 'sess-original', 'BOOP drives the original Session')
  assert.equal(deliveries[0].envelope.instruction, '继续实现并做窄屏检查，不部署')
  const action = repo.getAction(SCOPE, outcome.actionId)
  assert.equal(action.state, 'accepted')
  assert.equal(action.messageId, `host_${outcome.actionId}`, 'the receipt is recorded for reconciliation')
})

test('AT-14 a task version bump refuses the planned command before any delivery', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: task.version, lifecycle: 'paused' })
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '旧计划',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.reason, 'TASK_VERSION_CONFLICT')
  assert.equal(deliveries.length, 0, 'nothing reached the user Session')
})

test('E02-02 a policy epoch change invalidates every unexecuted command', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  repo.bumpPolicyEpoch(SCOPE)
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '按旧策略执行',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: 1,
  })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.reason, 'POLICY_EPOCH_CHANGED')
  assert.equal(deliveries.length, 0)
})

test('E02-02 a dangerous action without an approval never reaches a Session', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask('危险操作')
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '部署生产',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: repo.getScope(SCOPE).policyEpoch,
    requiresApproval: true,
  })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.reason, 'APPROVAL_REQUIRED')
  assert.equal(deliveries.length, 0)
})

test('E02-02 an approval is bound to the exact payload and cannot be reused for another one', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask('危险操作')
  const epoch = repo.getScope(SCOPE).policyEpoch
  const planned = dispatcher.plan({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '部署预发',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: epoch,
    requiresApproval: true,
  })
  assert.equal(repo.getAction(SCOPE, planned.actionId).state, 'awaiting_approval')

  repo.createApproval({
    scopeId: SCOPE,
    actionId: planned.actionId,
    payloadHash: planned.payloadHash,
    taskVersion: planned.taskVersion,
    policyEpoch: epoch,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-e2',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })

  // Same approval card, different instruction → refused, nothing delivered.
  const reused = await dispatcher.dispatch({
    actionId: planned.actionId,
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '部署生产',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: epoch,
    requiresApproval: true,
  })
  assert.equal(reused.kind, 'rejected')
  assert.equal(reused.reason, 'PAYLOAD_CHANGED')
  assert.equal(deliveries.length, 0)
})

test('E02-02 the approved payload goes through exactly once', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask('审批通过')
  const epoch = repo.getScope(SCOPE).policyEpoch
  const planned = dispatcher.plan({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '部署预发',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: epoch,
    requiresApproval: true,
  })
  const approval = repo.createApproval({
    scopeId: SCOPE,
    actionId: planned.actionId,
    payloadHash: planned.payloadHash,
    taskVersion: planned.taskVersion,
    policyEpoch: epoch,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-e2-2',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const outcome = await dispatcher.dispatch({
    actionId: planned.actionId,
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '部署预发',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: epoch,
    requiresApproval: true,
    approvalId: approval.id,
    approvalNonce: 'nonce-e2-2',
  })
  assert.equal(outcome.kind, 'accepted')
  assert.equal(deliveries.length, 1)
})

test('E02-03 a transport failure after claiming becomes unknown, never an auto retry', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  failureMode = 'throw'
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '可能失败',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: repo.getScope(SCOPE).policyEpoch,
  })
  assert.equal(outcome.kind, 'unknown')
  assert.equal(repo.getAction(SCOPE, outcome.actionId).state, 'outcome_unknown')

  const reconciled = dispatcher.reconcile()
  assert.equal(reconciled.readyToRetry, 0, 'an unknown command is never queued for an automatic retry')
  const repeat = await dispatcher.dispatch({
    actionId: outcome.actionId,
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '可能失败',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: repo.getScope(SCOPE).policyEpoch,
  })
  assert.equal(repeat.kind, 'rejected', 'a previously unknown action must not be re-sent blindly')
})

test('E02-03 a busy target returns the action to `planned` instead of losing it', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  failureMode = 'busy'
  const outcome = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-busy',
    instruction: '排队',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: repo.getScope(SCOPE).policyEpoch,
  })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.reason, 'TARGET_BUSY')
  assert.equal(repo.getAction(SCOPE, outcome.actionId).state, 'planned')
})

test('E02-02 approvals become stale when the object version moves', () => {
  const dispatcher = makeDispatcher()
  const task = activeTask('审批失效')
  const epoch = repo.getScope(SCOPE).policyEpoch
  const planned = dispatcher.plan({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-risky',
    instruction: '重新评估后再执行',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: epoch,
    requiresApproval: true,
  })
  const approval = repo.createApproval({
    scopeId: SCOPE,
    actionId: planned.actionId,
    payloadHash: planned.payloadHash,
    taskVersion: planned.taskVersion,
    policyEpoch: epoch,
    requestingOwner: 'owner-1',
    nonceHash: 'nonce-e2-3',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const stale = dispatcher.expireStaleApprovals({ taskVersion: task.version + 3, policyEpoch: epoch })
  assert.ok(stale.includes(approval.id))
  const consumed = repo.consumeApproval({
    scopeId: SCOPE,
    approvalId: approval.id,
    nonceHash: 'nonce-e2-3',
    payloadHash: planned.payloadHash,
    taskVersion: planned.taskVersion,
    policyEpoch: epoch,
  })
  assert.equal(consumed.status, 'stale', 'an invalidated card can never be consumed')
})

test('E02-03 stop is BOOP-owned only', async () => {
  const dispatcher = makeDispatcher()
  const task = activeTask()
  const accepted = await dispatcher.dispatch({
    taskId: task.id,
    expectedTaskVersion: task.version,
    targetSessionId: 'sess-original',
    instruction: '长任务',
    mode: 'queue',
    originRef: 'dsh:operator',
    policyEpoch: repo.getScope(SCOPE).policyEpoch,
  })
  const foreign = await dispatcher.stopOwned({
    sessionId: 'sess-other',
    actionId: accepted.actionId,
    cancel: async () => ({ requested: true, settled: true }),
  })
  assert.equal(foreign.requested, false, 'a different Session is never stopped')

  const owned = await dispatcher.stopOwned({
    sessionId: 'sess-original',
    actionId: accepted.actionId,
    cancel: async () => ({ requested: true, settled: true }),
  })
  assert.equal(owned.requested, true)
  assert.equal(repo.getAction(SCOPE, accepted.actionId).state, 'stopped')
})

test('E02-01 three axes stay independent on a real task', () => {
  const task = activeTask('三轴')
  let row = repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: task.version, verification: 'pending' })
  assert.equal(row.lifecycle, 'active')
  assert.equal(row.verification, 'pending')
  row = repo.updateTask({ scopeId: SCOPE, taskId: task.id, expectedVersion: row.version, lifecycle: 'blocked' })
  assert.equal(row.verification, 'pending', 'lifecycle changes never rewrite verification')
  assert.equal(row.version, task.version + 2)
})