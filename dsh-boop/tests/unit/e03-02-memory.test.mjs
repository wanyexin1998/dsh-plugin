#!/usr/bin/env node
/**
 * E03-02 · Memory commit: evidence window, authority, CAS, conflict, coverage.
 *
 * The extractor is model-backed and now has real-service evidence (E03-02
 * model half); this suite proves the admission rules BOOP enforces on whatever
 * a model proposes.
 *
 * Run: node tests/unit/e03-02-memory.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { MemoryCommitter, aggregateWorkspace, authorityRank } from '../../src/host/memory/committer.ts'

let dir
let db
let repo
let committer
let counter = 0
const SCOPE = 'scope-memory'
const OWNER = { type: 'session', id: 'sess-dev' }

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e03-02-'))
  db = new BoopDatabase({ path: path.join(dir, 'boop.sqlite') })
  db.bootstrap()
  repo = new BoopRepository(db, undefined, () => `m-${++counter}`)
  repo.ensureScope(SCOPE, 'owner-1')
  committer = new MemoryCommitter(repo)
})

after(() => {
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function evidence(seq, hash = `h${seq}`) {
  return { scopeId: SCOPE, sessionId: OWNER.id, sourceGeneration: 'g1', seq, hash }
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 1,
    scopeId: SCOPE,
    sessionId: OWNER.id,
    fromSeq: 0,
    toSeq: 10,
    baselineVersion: 0,
    changes: [
      {
        op: 'add',
        factId: 'fact-a',
        kind: 'decision',
        text: '本阶段不部署生产',
        authority: 'user_confirmed',
        evidenceRefs: [evidence(4)],
        supersedes: [],
      },
    ],
    unresolved: [],
    ...overrides,
  }
}

test('E03-02 a change without evidence inside the read window is rejected', () => {
  const result = committer.commit(proposal({ baselineVersion: 0 }), OWNER)
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.applied, ['fact-a'])

  const outside = committer.commit(
    proposal({
      baselineVersion: result.version,
      fromSeq: 20,
      toSeq: 30,
      changes: [
        {
          op: 'add',
          factId: 'fact-b',
          kind: 'decision',
          text: '越界证据',
          authority: 'user_confirmed',
          evidenceRefs: [evidence(4)],
          supersedes: [],
        },
      ],
    }),
    OWNER,
  )
  assert.equal(outside.status, 'rejected')
  assert.equal(outside.rejected[0].reason, 'EVIDENCE_OUT_OF_WINDOW')
  assert.equal(
    repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).body.includes('越界证据'),
    false,
  )
})

test('E03-02 evidence from another Session or scope is refused', () => {
  const otherSession = committer.commit(
    proposal({
      baselineVersion: repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).version,
      changes: [
        {
          op: 'add',
          factId: 'fact-c',
          kind: 'decision',
          text: '越权证据',
          authority: 'user_confirmed',
          evidenceRefs: [{ ...evidence(2), sessionId: 'sess-other' }],
          supersedes: [],
        },
      ],
    }),
    OWNER,
  )
  assert.equal(otherSession.rejected[0].reason, 'EVIDENCE_SESSION_MISMATCH')
})

test('E03-02 a stale baseline never overwrites a newer snapshot', () => {
  const current = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).version
  const stale = committer.commit(proposal({ baselineVersion: current - 1 }), OWNER)
  assert.equal(stale.status, 'rejected')
  assert.equal(stale.rejected[0].reason, 'BASELINE_MOVED')
})

test('E03-02 a weaker source may not overwrite a stronger fact', () => {
  const current = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).version
  const result = committer.commit(
    proposal({
      baselineVersion: current,
      changes: [
        {
          op: 'edit',
          factId: 'fact-a',
          kind: 'decision',
          text: '模型推断：不部署',
          authority: 'inference',
          evidenceRefs: [evidence(6)],
          supersedes: [],
        },
      ],
    }),
    OWNER,
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.rejected[0].reason, 'AUTHORITY_DOWNGRADE')
  assert.ok(
    repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).body.includes('本阶段不部署生产'),
    'the stronger fact is untouched',
  )
})

test('E03-02 authority order is explicit and total', () => {
  assert.ok(authorityRank('user_confirmed') < authorityRank('agent_reported'))
  assert.ok(authorityRank('agent_reported') < authorityRank('inference'))
  assert.equal(authorityRank('nonsense'), authorityRank('inference'))
})

test('E03-02 two disagreeing active facts become disputed, not silently resolved', () => {
  const current = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).version
  const result = committer.commit(
    proposal({
      baselineVersion: current,
      changes: [
        {
          op: 'add',
          factId: 'fact-d',
          kind: 'decision',
          text: '改为可以部署生产',
          authority: 'user_confirmed',
          evidenceRefs: [evidence(8)],
          supersedes: [],
        },
      ],
    }),
    OWNER,
  )
  assert.equal(result.status, 'committed')
  assert.ok(result.disputed.length >= 1, 'conflicting facts are surfaced')
  const facts = repo['store'] ?? null
  void facts
  const body = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).body
  assert.ok(body.includes('disputed'), 'the snapshot marks the disagreement')
})

test('E03-02 supersede retires the old version but keeps it addressable', () => {
  const current = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id).version
  const result = committer.commit(
    proposal({
      baselineVersion: current,
      changes: [
        {
          op: 'supersede',
          factId: 'fact-a',
          kind: 'decision',
          text: '本阶段不部署生产（已被后续决策取代）',
          authority: 'user_confirmed',
          evidenceRefs: [evidence(9)],
          supersedes: ['fact-a'],
        },
      ],
    }),
    OWNER,
  )
  assert.equal(result.status, 'committed')
  const versions = db.db.prepare('SELECT count(*) c FROM fact_version WHERE fact_id = ?').get('fact-a')
  assert.ok(Number(versions.c) >= 2, 'every version stays in the ledger')
})

test('E03-02 coverage records exactly how far the snapshot was read', () => {
  const snapshot = repo.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id)
  const keys = Object.keys(snapshot.coverage)
  assert.ok(keys.length >= 1)
  for (const key of keys) {
    assert.ok(key.startsWith(`${OWNER.id}#`))
    assert.ok(typeof snapshot.coverage[key].throughSeq === 'number')
  }
})

test('E03-02 the workspace view aggregates coverage and reports staleness', () => {
  const fresh = aggregateWorkspace({
    snapshots: [
      { ownerId: 'sess-dev', snapshot: { scopeId: SCOPE, ownerId: 'sess-dev', version: 3, body: '', coverage: { 'g1': { sourceGeneration: 'g1', throughSeq: 12 } }, freshness: 'current' } },
      { ownerId: 'sess-ops', snapshot: { scopeId: SCOPE, ownerId: 'sess-ops', version: 1, body: '', coverage: { 'g2': { sourceGeneration: 'g2', throughSeq: 4 } }, freshness: 'current' } },
    ],
  })
  assert.deepEqual(Object.keys(fresh.coverage).sort(), ['g1', 'g2'])
  assert.equal(fresh.freshness, 'current')

  const stale = aggregateWorkspace({
    snapshots: [
      { ownerId: 'sess-dev', snapshot: { scopeId: SCOPE, ownerId: 'sess-dev', version: 3, body: '', coverage: {}, freshness: 'stale' } },
      { ownerId: 'sess-ops', snapshot: null },
    ],
  })
  assert.equal(stale.freshness, 'stale', 'a missing or stale session makes the workspace view stale')
})

test('E03-02 coverage names the real source generation when the proposal provides it', () => {
  // Real extraction passes the generation it read; the committer must persist
  // THAT generation (not the session id and not a "current" placeholder), so a
  // stale answer is visible instead of silent.
  const owner = { type: 'session', id: 'sess-gen' }
  const result = committer.commit(
    {
      schemaVersion: 1,
      scopeId: SCOPE,
      sessionId: owner.id,
      sourceGeneration: 'gen-abc',
      fromSeq: 0,
      toSeq: 2,
      baselineVersion: 0,
      changes: [
        {
          op: 'add',
          factId: 'fact-gen',
          kind: 'decision',
          text: '真实世代覆盖测试',
          authority: 'user_confirmed',
          evidenceRefs: [{ scopeId: SCOPE, sessionId: owner.id, sourceGeneration: 'gen-abc', seq: 1, hash: 'gen-abc#1' }],
          supersedes: [],
        },
      ],
      unresolved: [],
    },
    owner,
  )
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.coverage[`${owner.id}#gen-abc`], { sourceGeneration: 'gen-abc', throughSeq: 2 })
  const snapshot = repo.latestMemorySnapshot(SCOPE, owner.type, owner.id)
  assert.deepEqual(snapshot.coverage[`${owner.id}#gen-abc`], { sourceGeneration: 'gen-abc', throughSeq: 2 })
})
/* ── conflict semantics: comparable subject, not bare `kind` ──────────── */

/** Proposal for an isolated owner: each test owns its fact set and CAS base. */
function ownerProposal(ownerId, changes, overrides = {}) {
  return {
    schemaVersion: 1,
    scopeId: SCOPE,
    sessionId: ownerId,
    sourceGeneration: 'g-conflict',
    fromSeq: 0,
    toSeq: 10,
    baselineVersion: 0,
    changes,
    unresolved: [],
    ...overrides,
  }
}

function changeFor(ownerId, factId, text, extra = {}) {
  return {
    op: 'add',
    factId,
    kind: 'decision',
    text,
    authority: 'user_confirmed',
    evidenceRefs: [{ scopeId: SCOPE, sessionId: ownerId, sourceGeneration: 'g-conflict', seq: 1, hash: 'g-conflict#1' }],
    supersedes: [],
    ...extra,
  }
}

/** Store wrapper that CAN expose the subject keys it wrote (forward seam). */
function subjectAwareStore(inner) {
  const keys = new Map()
  const keyOf = (scopeId, factId) => `${scopeId}\u0000${factId}`
  return {
    currentVersion: (...args) => inner.currentVersion(...args),
    facts: (scopeId, ownerType, ownerId) =>
      inner.facts(scopeId, ownerType, ownerId).map((fact) => {
        const key = keys.get(keyOf(scopeId, fact.factId))
        return key === undefined ? { ...fact } : { ...fact, subjectKey: key }
      }),
    upsertFact(input) {
      const mapKey = keyOf(input.scopeId, input.factId)
      if (Object.hasOwn(input, 'subjectKey')) {
        if (input.subjectKey === undefined) keys.delete(mapKey)
        else keys.set(mapKey, input.subjectKey)
      }
      return inner.upsertFact(input)
    },
    addEvidence: (input) => inner.addEvidence(input),
    saveMemorySnapshot: (input) => inner.saveMemorySnapshot(input),
    latestMemorySnapshot: (...args) => inner.latestMemorySnapshot(...args),
  }
}

test('E03-07 two decisions about different subjects coexist active, never disputed', () => {
  // The real failure this fixes: one extraction proposed two different
  // decisions ("不部署生产" and "下周五前完成验收"); `kind` alone made both
  // disputed even though they are about different subjects and both hold.
  const owner = { type: 'session', id: 'sess-two-decisions' }
  const result = committer.commit(
    ownerProposal(owner.id, [
      changeFor(owner.id, 'fact-subj-deploy', 'BOOP 项目本阶段不部署生产环境', { subjectKey: 'deploy-policy' }),
      changeFor(owner.id, 'fact-subj-deadline', '下周五之前完成 E03-04 检索验收', { subjectKey: 'deadline:e03-04' }),
    ]),
    owner,
  )
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.disputed, [], 'different subjects are independent facts')
  const facts = repo.facts(SCOPE, owner.type, owner.id)
  assert.equal(facts.length, 2)
  for (const fact of facts) {
    assert.equal(fact.status, 'active', `${fact.factId} must stand active`)
    assert.equal(fact.kind, 'decision')
  }
  const body = repo.latestMemorySnapshot(SCOPE, owner.type, owner.id).body
  assert.ok(!body.includes('[disputed]'), body)
})

test('E03-07 the same subject with different values is disputed and both sides survive', () => {
  const owner = { type: 'session', id: 'sess-same-subject' }
  const result = committer.commit(
    ownerProposal(owner.id, [
      changeFor(owner.id, 'fact-same-no-deploy', '本阶段不部署生产', {
        subjectKey: 'deploy-policy',
        authority: 'user_confirmed',
      }),
      changeFor(owner.id, 'fact-same-deploy', '本阶段允许部署生产', {
        subjectKey: 'deploy-policy',
        authority: 'user_exploration',
      }),
    ]),
    owner,
  )
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.disputed.sort(), ['fact-same-deploy', 'fact-same-no-deploy'])

  const facts = repo.facts(SCOPE, owner.type, owner.id)
  assert.equal(facts.length, 2, 'a conflict never deletes a side (no last-write-wins)')
  const byId = new Map(facts.map((fact) => [fact.factId, fact]))
  // `disputed` is a STATUS: kind/authority/text stay exactly as committed.
  assert.equal(byId.get('fact-same-no-deploy').status, 'disputed')
  assert.equal(byId.get('fact-same-deploy').status, 'disputed')
  assert.equal(byId.get('fact-same-no-deploy').kind, 'decision', 'kind is not rewritten to "disputed"')
  assert.equal(byId.get('fact-same-deploy').kind, 'decision')
  assert.equal(byId.get('fact-same-no-deploy').authority, 'user_confirmed', 'authority is never silently downgraded')
  assert.equal(byId.get('fact-same-deploy').authority, 'user_exploration')
  assert.equal(byId.get('fact-same-no-deploy').text, '本阶段不部署生产')
  assert.equal(byId.get('fact-same-deploy').text, '本阶段允许部署生产')
  const body = repo.latestMemorySnapshot(SCOPE, owner.type, owner.id).body
  assert.ok(body.includes('本阶段不部署生产') && body.includes('本阶段允许部署生产'), body)
  assert.ok(body.includes('[disputed]'), 'the snapshot marks the disagreement')
})

test('E03-07 a missing subjectKey keeps the conservative rule (no silent compatibility)', () => {
  const owner = { type: 'session', id: 'sess-conservative' }
  const first = committer.commit(
    ownerProposal(owner.id, [changeFor(owner.id, 'fact-cons-first', '暂不部署生产')]),
    owner,
  )
  assert.equal(first.status, 'committed')
  assert.deepEqual(first.disputed, [])

  const second = committer.commit(
    ownerProposal(owner.id, [changeFor(owner.id, 'fact-cons-second', '可以部署生产')], {
      baselineVersion: first.version,
    }),
    owner,
  )
  assert.equal(second.status, 'committed')
  assert.deepEqual(second.disputed.sort(), ['fact-cons-first', 'fact-cons-second'], 'unknown subjects stay conservative')
  const facts = repo.facts(SCOPE, owner.type, owner.id)
  assert.deepEqual(facts.map((fact) => fact.status).sort(), ['disputed', 'disputed'])
})

test('E03-07 explicit store subject keys make a later proposal compare exactly', () => {
  // Forward seam: when the store CAN expose subjectKey, a follow-up proposal
  // disputes only the same-subject fact and leaves the other subject active.
  const owner = { type: 'session', id: 'sess-exact-compare' }
  const exact = new MemoryCommitter(subjectAwareStore(repo))
  const first = exact.commit(
    ownerProposal(owner.id, [
      changeFor(owner.id, 'fact-exact-deploy', '本阶段不部署生产', { subjectKey: 'deploy-policy' }),
      changeFor(owner.id, 'fact-exact-deadline', '下周五完成验收', { subjectKey: 'deadline:e03-04' }),
    ]),
    owner,
  )
  assert.equal(first.status, 'committed')
  const second = exact.commit(
    ownerProposal(owner.id, [changeFor(owner.id, 'fact-exact-deploy-2', '本周开始部署生产', { subjectKey: 'deploy-policy' })], {
      baselineVersion: first.version,
    }),
    owner,
  )
  assert.equal(second.status, 'committed')
  assert.deepEqual(second.disputed.sort(), ['fact-exact-deploy', 'fact-exact-deploy-2'], 'only the same subject is disputed')
  const byId = new Map(repo.facts(SCOPE, owner.type, owner.id).map((fact) => [fact.factId, fact]))
  assert.equal(byId.get('fact-exact-deadline').status, 'active', 'a different subject is not dragged into the conflict')
})

test('E03-07 a declared conflict is reported without inventing a second fact', () => {
  const owner = { type: 'session', id: 'sess-declared' }
  const result = committer.commit(
    ownerProposal(owner.id, [
      changeFor(owner.id, 'fact-declared-claim', '两种说法都缺少证据', { op: 'conflict', kind: 'claim' }),
    ]),
    owner,
  )
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.disputed, ['fact-declared-claim'])
  const fact = repo.facts(SCOPE, owner.type, owner.id).find((row) => row.factId === 'fact-declared-claim')
  assert.equal(fact.status, 'disputed')
  assert.equal(fact.kind, 'claim', 'a declared conflict keeps its kind')
})
