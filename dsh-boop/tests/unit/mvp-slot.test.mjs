/**
 * Global delegation slot and exact outbox claim.
 *
 * One scope may have one accepted, running, in-flight, or unknown action.
 * A busy target stays queued and does not take that slot. Claiming one
 * action must not mark the rest of the queue as sending.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { Dispatcher } from '../../src/host/dispatch/dispatcher.ts'

let dir
let db
let repo
let counter = 0
const SCOPE = 'scope-slot'
let sends = 0
let mode = 'ok'

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-slot-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, undefined, () => `slot-${++counter}`)
  repo.ensureScope(SCOPE, 'owner-1')
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function dispatcher() {
  sends = 0
  mode = 'ok'
  return new Dispatcher({
    repo,
    scopeId: SCOPE,
    knownMessageIds: () => new Set(),
    enqueue: async ({ envelope, targetSessionId }) => {
      sends += 1
      if (mode === 'throw') throw new Error('transport lost the receipt')
      if (mode === 'busy' && targetSessionId === 'sess-busy') {
        return { messageId: envelope.messageId, accepted: false, mode: envelope.mode }
      }
      return { messageId: envelope.messageId, accepted: true, mode: envelope.mode }
    },
  })
}

function task(goal) {
  const created = repo.createTask({ scopeId: SCOPE, goal })
  repo.updateTask({ scopeId: SCOPE, taskId: created.id, expectedVersion: 1, lifecycle: 'active' })
  return repo.getTask(SCOPE, created.id)
}

function outbox(actionId) {
  return db.db.prepare('SELECT state FROM command_outbox WHERE scope_id = ? AND action_id = ?').get(SCOPE, actionId).state
}

function release() {
  const held = db.db
    .prepare("SELECT id FROM action WHERE scope_id = ? AND state IN ('accepted','running','outcome_unknown')")
    .all(SCOPE)
  for (const row of held) repo.markActionState(SCOPE, row.id, 'settled')
}

test('claiming one action leaves the other prepared', async () => {
  release()
  const run = dispatcher()
  const first = task('先排队')
  const second = task('后发送')
  const queued = run.plan({
    taskId: first.id,
    expectedTaskVersion: first.version,
    targetSessionId: 'sess-a',
    instruction: '等一下',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  const sent = await run.dispatch({
    taskId: second.id,
    expectedTaskVersion: second.version,
    targetSessionId: 'sess-b',
    instruction: '先做这个',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(sent.kind, 'accepted')
  assert.equal(sends, 1)
  assert.equal(outbox(queued.actionId), 'prepared')
  assert.equal(outbox(sent.actionId), 'accepted')
})

test('an accepted receipt does not hold the slot; a busy target does not either', async () => {
  release()
  const run = dispatcher()
  const held = await run.dispatch({
    taskId: task('已投递').id,
    expectedTaskVersion: 2,
    targetSessionId: 'sess-live',
    instruction: '回执已记下',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(held.kind, 'accepted')
  const nextTask = task('下一条')
  const next = await run.dispatch({
    taskId: nextTask.id,
    expectedTaskVersion: nextTask.version,
    targetSessionId: 'sess-other',
    instruction: '回执不占槽',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(next.kind, 'accepted')
  repo.markActionState(SCOPE, held.actionId, 'settled')
  repo.markActionState(SCOPE, next.actionId, 'settled')
  mode = 'busy'
  const busyTask = task('目标忙')
  const busy = await run.dispatch({
    taskId: busyTask.id,
    expectedTaskVersion: busyTask.version,
    targetSessionId: 'sess-busy',
    instruction: '等它空闲',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(busy.reason, 'TARGET_BUSY')
  assert.equal(repo.getAction(SCOPE, busy.actionId).state, 'planned')
  const idle = task('空闲目标')
  const idleSend = await run.dispatch({
    taskId: idle.id,
    expectedTaskVersion: idle.version,
    targetSessionId: 'sess-idle',
    instruction: '这个可以发',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(idleSend.kind, 'accepted')
  assert.equal(outbox(busy.actionId), 'blocked')
  assert.equal(outbox(idleSend.actionId), 'accepted')
})

test('an unknown delivery keeps the slot and is not replaced by another target', async () => {
  release()
  const run = dispatcher()
  mode = 'throw'
  const lost = await run.dispatch({
    taskId: task('丢回执').id,
    expectedTaskVersion: 2,
    targetSessionId: 'sess-lost',
    instruction: '发出去了但没回执',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(lost.kind, 'unknown')
  mode = 'ok'
  const other = await run.dispatch({
    taskId: task('不该顶上').id,
    expectedTaskVersion: 2,
    targetSessionId: 'sess-next',
    instruction: '不要补发',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(other.reason, 'SLOT_HELD')
  assert.equal(sends, 1)
  assert.equal(repo.getAction(SCOPE, lost.actionId).state, 'outcome_unknown')
})

test('steer is refused before any send', async () => {
  release()
  const run = dispatcher()
  const row = task('不要插话')
  const outcome = await run.dispatch({
    taskId: row.id,
    expectedTaskVersion: row.version,
    targetSessionId: 'sess-live',
    instruction: '打断当前轮',
    mode: 'steer',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(outcome.reason, 'STEER_REFUSED')
  assert.equal(sends, 0)
})

test('a version bump after planning refuses the old action before claim', async () => {
  release()
  const run = dispatcher()
  const row = task('会改方案')
  const planned = run.plan({
    taskId: row.id,
    expectedTaskVersion: row.version,
    targetSessionId: 'sess-a',
    instruction: '旧方案',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  repo.updateTask({ scopeId: SCOPE, taskId: row.id, expectedVersion: row.version, lifecycle: 'paused' })
  const outcome = await run.dispatch({
    actionId: planned.actionId,
    taskId: row.id,
    expectedTaskVersion: row.version,
    targetSessionId: 'sess-a',
    instruction: '旧方案',
    mode: 'queue',
    originRef: 'user',
    policyEpoch: 1,
  })
  assert.equal(outcome.reason, 'TASK_VERSION_CONFLICT')
  assert.equal(sends, 0)
  assert.equal(outbox(planned.actionId), 'prepared')
})
