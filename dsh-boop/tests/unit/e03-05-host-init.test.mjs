#!/usr/bin/env node
/**
 * Host wiring for initialization, boot reconciliation, and forget tombstones.
 *
 * Synthetic ledgers only. The user's real DSH_HOME is never opened.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { BoopStorage } from '../../src/host/persistence/storage.ts'
import { MemoryCommitter } from '../../src/host/memory/committer.ts'
import { MemoryLifecycle } from '../../src/host/memory/lifecycle.ts'
import { LedgerInitStore } from '../../src/host/memory/ledger-init-store.ts'
import { applyInitialization } from '../../src/host/memory/host-init.ts'

let dir
let counter = 0

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e03-05-'))
})

after(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function openRepo(name) {
  const db = new BoopDatabase({ path: path.join(dir, name), wal: false, fts: true })
  db.bootstrap()
  const repo = new BoopRepository(db, () => '2026-10-27T00:00:00.000Z', () => `id-${++counter}`)
  repo.ensureScope('scope-1', 'owner-1')
  return { db, repo }
}

function ctxFor(storage, writeModeEnabled) {
  const facts = storage.facts(true)
  return {
    boop: {
      state: () => ({
        writeModeEnabled,
        gates: {},
        storage: { ...facts, ok: true },
      }),
      storage: () => storage,
      sourceReader: () => null,
    },
  }
}

test('boot reconciliation records an unclean start and a clean close', () => {
  const home = path.join(dir, 'home-boot')
  const first = new BoopStorage({ dshHome: home, holder: 'host-a', leaseTtlMs: 60_000 })
  first.start()
  assert.equal(first.previousShutdownClean, false)
  assert.deepEqual(first.bootReconcile.unknown, [])
  assert.equal(first.repo.getMeta('clean_shutdown'), '0')
  first.close()

  const second = new BoopStorage({ dshHome: home, holder: 'host-b', leaseTtlMs: 60_000 })
  second.start()
  assert.equal(second.previousShutdownClean, true, 'a graceful close is visible to the next process')
  second.close()
})

test('initialization writes watermarks only when write mode is enabled', async () => {
  const home = path.join(dir, 'home-init')
  const storage = new BoopStorage({ dshHome: home, holder: 'host-init', leaseTtlMs: 60_000 })
  storage.start()
  const heads = [{ sessionId: 'sess-1', sourceGeneration: 'sess-1@1:0', headSeq: 17 }]

  const refused = await applyInitialization(ctxFor(storage, false), 'from_now', heads)
  assert.equal(refused.executed, false)
  assert.equal(storage.repo.cursors(storage.identity.scopeId).length, 0)

  const applied = await applyInitialization(ctxFor(storage, true), 'from_now', heads)
  assert.equal(applied.executed, true)
  assert.equal(applied.reason, 'watermarked')
  const cursors = storage.repo.cursors(storage.identity.scopeId)
  assert.equal(cursors.length, 1)
  assert.equal(cursors[0].throughSeq, 17)
  assert.equal(cursors[0].state, 'fresh')

  const imported = await applyInitialization(ctxFor(storage, true), 'import_memory', heads)
  assert.equal(imported.executed, false)
  assert.equal(imported.reason, 'import-needs-preview')
  storage.close()
})

test('learn_history reads each source and records an unreadable one', async () => {
  const home = path.join(dir, 'home-learn')
  const storage = new BoopStorage({ dshHome: home, holder: 'host-learn', leaseTtlMs: 60_000 })
  storage.start()
  const heads = [
    { sessionId: 'sess-ok', sourceGeneration: 'sess-ok@1:0', headSeq: 3 },
    { sessionId: 'sess-bad', sourceGeneration: 'sess-bad@1:0', headSeq: 1 },
  ]
  const ctx = ctxFor(storage, true)
  ctx.boop.sourceReader = () => ({
    async listEvents(sessionId) {
      if (sessionId === 'sess-bad') throw new Error('session artifact unreadable')
      return []
    },
  })
  const learned = await applyInitialization(ctx, 'learn_history', heads)
  assert.equal(learned.executed, true)
  assert.equal(learned.reason, 'learned')
  assert.equal(learned.processed, 2)
  assert.equal(learned.total, 2)
  assert.match(learned.copy, /已整理 2\/2/)
  storage.close()
})

test('a forgotten fact stays tombstoned and cannot be committed again', () => {
  const { db, repo } = openRepo('forget.sqlite')
  const lifecycle = new MemoryLifecycle(new LedgerInitStore(repo, 'scope-1'))
  repo.upsertFact({
    scopeId: 'scope-1',
    factId: 'fact-a',
    ownerType: 'session',
    ownerId: 'sess-dev',
    kind: 'decision',
    text: '可以部署',
    authority: 'user_confirmed',
  })
  repo.addEvidence({ scopeId: 'scope-1', factId: 'fact-a', sessionId: 'sess-dev', seq: 4, sourceHash: 'h4' })
  const forgotten = lifecycle.forget({
    scopeId: 'scope-1',
    mode: 'forget_fact',
    sourceFingerprint: 'sess-dev',
    selector: ['fact-a'],
  })
  assert.deepEqual(forgotten.tombstoned, ['fact-a'])
  assert.equal(repo.facts('scope-1', 'session', 'sess-dev')[0].status, 'tombstoned')

  const committer = new MemoryCommitter(repo)
  const again = committer.commit(
    {
      schemaVersion: 1,
      scopeId: 'scope-1',
      sessionId: 'sess-dev',
      sourceGeneration: 'g1',
      fromSeq: 1,
      toSeq: 8,
      baselineVersion: 0,
      unresolved: [],
      changes: [
        {
          op: 'add',
          factId: 'fact-a',
          kind: 'decision',
          text: '可以部署',
          authority: 'user_confirmed',
          evidenceRefs: [{ scopeId: 'scope-1', sessionId: 'sess-dev', sourceGeneration: 'g1', seq: 4 }],
          supersedes: [],
        },
      ],
    },
    { type: 'session', id: 'sess-dev' },
  )
  assert.equal(again.status, 'rejected')
  assert.equal(again.rejected[0].reason, 'FACT_TOMBSTONED')
  db.close()
})

test('FTS search returns an active fact and drops it after a tombstone', () => {
  const { db, repo } = openRepo('fts.sqlite')
  assert.equal(db.fts, true)
  repo.upsertFact({
    scopeId: 'scope-1',
    factId: 'fact-q',
    ownerType: 'workspace',
    ownerId: 'ws-1',
    kind: 'decision',
    text: '窄屏三分栏保持草稿',
    authority: 'agent_reported',
    subjectKey: 'layout',
  })
  const hits = repo.searchFacts('scope-1', '三分栏', 5)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].factId, 'fact-q')
  repo.tombstoneFacts('scope-1', ['fact-q'])
  assert.equal(repo.searchFacts('scope-1', '三分栏', 5).length, 0)
  const stored = repo.facts('scope-1', 'workspace', 'ws-1')[0]
  assert.equal(stored.subjectKey, 'layout')
  db.close()
})
