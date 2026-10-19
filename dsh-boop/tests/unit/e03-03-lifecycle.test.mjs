#!/usr/bin/env node
/**
 * E03-03 · Three initialization modes, import, correction, forgetting.
 *
 * Run: node tests/unit/e03-03-lifecycle.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryLifecycle } from '../../src/host/memory/lifecycle.ts'

function fakeStore() {
  const jobs = []
  const cursors = new Map()
  const facts = new Map()
  const rules = []
  const audits = []
  let seq = 0
  const store = {
    createJob(job) {
      const row = { id: `job-${++seq}`, ...job }
      jobs.push(row)
      return row
    },
    getJob: (id) => jobs.find((row) => row.id === id) ?? null,
    updateJob(id, patch) {
      const row = jobs.find((r) => r.id === id)
      Object.assign(row, patch)
      return row
    },
    setWatermarkNow(scopeId, heads) {
      for (const head of heads) {
        cursors.set(`${scopeId}|${head.sessionId}|${head.sourceGeneration}`, head.headSeq)
      }
      return heads.length
    },
    countSources: () => 4,
    upsertFact(input) {
      facts.set(input.factId, { ...input, version: 1 })
      return { version: 1 }
    },
    facts: () => [...facts.values()].map((f) => ({ factId: f.factId, status: f.status ?? 'active' })),
    saveRule(input) {
      const row = { id: `rule-${++seq}`, ...input }
      rules.push(row)
      return row
    },
    rules: () => rules,
    audit(scopeId, kind, objectId, actor, reason) {
      audits.push({ scopeId, kind, objectId, actor, reason })
      return audits[audits.length - 1]
    },
    cursors,
    audits,
    rulesList: rules,
  }
  return { store, cursors, audits }
}

test('E03-03 the three modes are separate jobs with honest totals', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)

  const learn = lifecycle.startInitialization('scope', 'learn_history')
  assert.equal(learn.mode, 'learn_history')
  assert.equal(learn.total, 4, 'history learning knows its object count up front')

  const fromNow = lifecycle.startInitialization('scope', 'from_now')
  assert.equal(fromNow.total, null, '从现在开始 does not claim a history total')
})

test('E03-03 从现在开始 marks the watermark and imports nothing', () => {
  const { store, cursors } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const job = lifecycle.startInitialization('scope', 'from_now')
  const done = lifecycle.applyFromNow({
    scopeId: 'scope',
    jobId: job.id,
    heads: [{ sessionId: 's1', sourceGeneration: 'g1', headSeq: 12 }],
  })
  assert.equal(done.state, 'done')
  assert.equal(cursors.get('scope|s1|g1'), 12)
  assert.equal(store.audits[0].kind, 'memory/init-from-now')
})

test('E03-03 学习已有会话 reports processed counts and lists failures per object', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const job = lifecycle.startInitialization('scope', 'learn_history')
  const after = lifecycle.advanceLearnHistory({
    scopeId: 'scope',
    jobId: job.id,
    results: [
      { objectId: 's1', ok: true },
      { objectId: 's2', ok: false, reason: 'log unreadable' },
      { objectId: 's3', ok: true },
      { objectId: 's4', ok: true },
    ],
  })
  assert.equal(after.processed, 4)
  assert.equal(after.state, 'done')
  assert.deepEqual(after.failures, [{ objectId: 's2', reason: 'log unreadable' }])
  assert.equal(lifecycle.progressCopy(after), '已整理 4/4 个会话')
})

test('E03-03 a history job can be paused and resumed with its watermark intact', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const job = lifecycle.startInitialization('scope', 'learn_history')
  lifecycle.advanceLearnHistory({ scopeId: 'scope', jobId: job.id, results: [{ objectId: 's1', ok: true }] })
  const paused = lifecycle.pauseJob(job.id)
  assert.equal(paused.state, 'paused')
  assert.equal(paused.processed, 1, 'processed work is not rolled back by a pause')
  assert.equal(lifecycle.progressCopy(paused), '已整理 1/4 个会话')
})

test('E03-03 import previews before writing and refuses unsupported formats outright', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const preview = lifecycle.previewImport({
    format: 'python-script',
    entries: [{ text: 'anything', kind: 'note' }],
    existing: [],
  })
  assert.equal(preview.supported, false)
  assert.equal(preview.added, 0, 'an unsupported format is never parsed or imported')
  assert.deepEqual(preview.rejected, [{ index: 0, reason: 'UNSUPPORTED_FORMAT' }])
})

test('E03-03 import counts new/duplicate entries and marks them unverified', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const preview = lifecycle.previewImport({
    format: 'markdown-list',
    entries: [
      { kind: 'decision', text: '不部署' },
      { kind: 'decision', text: '不部署' },
      { kind: '', text: '缺少类型' },
      { kind: 'note', text: '  ' },
      { kind: 'decision', text: '按灰度发布' },
    ],
    existing: [{ factId: 'f0', text: '已有事实' }],
  })
  assert.equal(preview.supported, true)
  assert.equal(preview.added, 2)
  assert.equal(preview.duplicates, 1)
  assert.equal(preview.needsReview, 2, 'every imported item needs local verification')
  assert.equal(preview.rejected.length, 2)
  assert.equal(preview.importedAuthority, 'import_unverified')

  const committed = lifecycle.commitImport({
    scopeId: 'scope',
    owner: { type: 'personal', id: 'owner-1' },
    entries: [{ kind: 'decision', text: '不部署' }],
  })
  assert.equal(committed.factIds.length, 1)
  assert.equal(store.audits[0].reason, '1 facts (unverified)')
})

test('E03-03 a correction names its scope and never claims an instant global revoke', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const plan = lifecycle.correctionPlan({
    scopeId: 'scope',
    owner: { type: 'session', id: 'sess-dev' },
    statement: '改为可以部署生产',
    source: { sessionId: 'sess-dev', sourceGeneration: 'g1', seq: 42 },
    targets: ['fact-a'],
  })
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0].authority, 'user_confirmed')
  assert.equal(plan.changes[0].evidenceRefs[0].seq, 42, 'a correction always carries its source')
  assert.match(plan.userMessage, /已被执行的|不会被追回|已执行的任务不会被追回/)
  assert.match(plan.userMessage, /不会被追回|不会追回/)
})

test('E03-03 forgetting writes a rule and never deletes the original history', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  const result = lifecycle.forget({
    scopeId: 'scope',
    mode: 'forget_fact',
    sourceFingerprint: 'sess-dev@g1',
    selector: ['fact-a', 'fact-b'],
  })
  assert.equal(result.tombstoned.length, 2)
  assert.equal(store.rulesList.length, 1)
  assert.deepEqual(lifecycle.applicableRules('scope', 'sess-dev@g1'), ['forget_fact'])
  assert.equal(store.audits[0].kind, 'memory/forgotten')
})

test('E03-03 a wildcard rule applies to every source of the scope', () => {
  const { store } = fakeStore()
  const lifecycle = new MemoryLifecycle(store)
  lifecycle.forget({ scopeId: 'scope', mode: 'exclude_scope', sourceFingerprint: '*' })
  assert.deepEqual(lifecycle.applicableRules('scope', 'any-session'), ['exclude_scope'])
})