/**
 * Formal followup slot: running occupies it, turn/end releases it,
 * and a dead process's running row becomes outcome_unknown at boot.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { dispatchFollowup } from '../../src/host/dispatch/followup.ts'
import { holdSlotForTurn, releaseRunningOnTurnEnd } from '../../src/host/dispatch/turn-release.ts'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { BoopStorage } from '../../src/host/persistence/storage.ts'

let dir
let db
let repo
let counter = 0
const SCOPE = 'scope-turn'

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-turn-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, undefined, () => `turn-${++counter}`)
  repo.ensureScope(SCOPE, 'owner-1')
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function task(goal, intentRef) {
  return repo.createTask({ scopeId: SCOPE, goal, intentRef })
}

function action(taskId, state, sessionId = 'sess-a') {
  const row = repo.beginAction({
    scopeId: SCOPE,
    taskId,
    expectedTaskVersion: 1,
    targetSessionId: sessionId,
    payloadHash: 'hash',
    payload: { instruction: 'do the thing', mode: 'queue' },
    originRef: 'tool:boop_dispatch',
    policyEpoch: 1,
  })
  repo.markActionState(SCOPE, row.id, state, row.id)
  return row.id
}

function ctx() {
  return {
    boop: {
      isWriteModeEnabled: () => true,
      storage: () => ({
        repo,
        identity: { scopeId: SCOPE },
        checkWrite: () => ({ ok: true }),
      }),
      gate: () => ({
        track() {},
        release() {},
        decide: () => ({ allow: true }),
      }),
      proxyMessageIds: () => [],
    },
    reflect: { get: () => null },
  }
}

test('an error turn/end frees the slot; a completed one is settled; another session is ignored', () => {
  const id = action(task('进行中').id, 'running', 'sess-live')
  const other = action(task('别的会话').id, 'running', 'sess-other')
  assert.equal(releaseRunningOnTurnEnd(repo, SCOPE, 'sess-live', { type: 'user/message' }), null)
  assert.equal(repo.getAction(SCOPE, id).state, 'running')
  const error = releaseRunningOnTurnEnd(repo, SCOPE, 'sess-live', {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'connect ECONNREFUSED' } } },
  })
  assert.equal(error.to, 'accepted')
  assert.equal(repo.getAction(SCOPE, id).state, 'accepted')
  assert.equal(repo.getAction(SCOPE, other).state, 'running', 'the other session keeps its slot')
  assert.equal(
    releaseRunningOnTurnEnd(repo, SCOPE, 'sess-live', { type: 'turn/end', data: { reason: { kind: 'error' } } }),
    null,
    'a second ending writes nothing',
  )
  const done = releaseRunningOnTurnEnd(repo, SCOPE, 'sess-other', {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  assert.equal(done.to, 'settled')
  assert.equal(repo.getAction(SCOPE, other).state, 'settled')
  assert.equal(repo.slotHolder(SCOPE), null)
})

test('boot moves a leftover running action to outcome_unknown and reports its id', () => {
  const home = path.join(dir, 'boot-home')
  const first = new BoopStorage({ dshHome: home, holder: 'host-a', leaseTtlMs: 60_000 })
  first.start()
  const created = first.repo.createTask({ scopeId: first.identity.scopeId, goal: '跑了一半' })
  const row = first.repo.beginAction({
    scopeId: first.identity.scopeId,
    taskId: created.id,
    expectedTaskVersion: 1,
    targetSessionId: 'sess-boot',
    payloadHash: 'hash',
    payload: { instruction: 'keep going', mode: 'queue' },
    originRef: 'tool:boop_dispatch',
    policyEpoch: 1,
  })
  first.repo.settleOutbox(first.identity.scopeId, row.id, 'accepted')
  first.repo.markActionState(first.identity.scopeId, row.id, 'accepted', row.id)
  assert.equal(holdSlotForTurn(first.repo, first.identity.scopeId, row.id), true)
  first.close()

  const second = new BoopStorage({ dshHome: home, holder: 'host-b', leaseTtlMs: 60_000 })
  const facts = second.start()
  assert.ok(facts.bootReconcile.unknown.includes(row.id))
  assert.equal(second.repo.getAction(second.identity.scopeId, row.id).state, 'outcome_unknown')
  assert.equal(second.repo.slotHolder(second.identity.scopeId)?.actionId, row.id)
  second.close()
})

test('the same requestId does not send again, and a held slot refuses a different one', async () => {
  const created = task('已投递', 'dispatch:req-1')
  const id = action(created.id, 'accepted')
  const replay = await dispatchFollowup(ctx(), {
    requestId: 'req-1',
    targetSessionId: 'sess-a',
    instruction: 'do the thing',
  })
  assert.equal(replay.kind, 'duplicate')
  assert.equal(replay.actionId, id)
  assert.equal(replay.slotHeld, false)

  repo.markActionState(SCOPE, id, 'running')
  const inflight = await dispatchFollowup(ctx(), {
    requestId: 'req-1',
    targetSessionId: 'sess-a',
    instruction: 'do the thing',
  })
  assert.equal(inflight.kind, 'in-flight')
  assert.equal(inflight.slotHeld, true)
  const blocked = await dispatchFollowup(ctx(), {
    requestId: 'req-2',
    targetSessionId: 'sess-b',
    instruction: 'something else',
  })
  assert.equal(blocked.reason, 'SLOT_HELD')
  assert.equal(blocked.slotHeld, true)
  assert.equal(repo.taskByIntent(SCOPE, 'dispatch:req-2'), null, 'a refused delegation does not create a task')
})

test('a followup is refused when write mode is off or the request is blank', async () => {
  const closed = await dispatchFollowup(
    { boop: { isWriteModeEnabled: () => false } },
    { requestId: 'req-x', targetSessionId: 'sess-a', instruction: 'go' },
  )
  assert.equal(closed.reason, 'WRITE_MODE_OFF')
  const blank = await dispatchFollowup(ctx(), { requestId: '', targetSessionId: 'sess-a', instruction: 'go' })
  assert.equal(blank.reason, 'INVALID_REQUEST')
})
