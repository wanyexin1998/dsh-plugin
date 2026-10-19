#!/usr/bin/env node
/**
 * E03-01 · Whole-domain light observation and the durable read watermark.
 *
 * The reader is an explicit test double: this proves BOOP's incremental read
 * policy, not the host's query implementation (covered by the in-host suite).
 *
 * Run: node tests/unit/e03-01-observer.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LedgerCursorStore, SourceObserver } from '../../src/host/observe/observer.ts'

/** In-memory cursor store with the same contract as the ledger one. */
function memoryCursors() {
  const rows = new Map()
  return {
    read(scopeId, sessionId, generation) {
      const row = rows.get(`${scopeId}|${sessionId}|${generation}`)
      return row ? { throughSeq: row.throughSeq, state: row.state } : undefined
    },
    write({ scopeId, sessionId, sourceGeneration, throughSeq, state }) {
      rows.set(`${scopeId}|${sessionId}|${sourceGeneration}`, { throughSeq, state })
    },
    all(scopeId) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(`${scopeId}|`))
        .map(([key, value]) => {
          const [, sessionId, sourceGeneration] = key.split('|')
          return { sessionId, sourceGeneration, throughSeq: value.throughSeq, state: value.state }
        })
    },
    rows,
  }
}

/** Mutable source set: the test can add sessions and append events. */
function fakeReader() {
  const sources = new Map()
  const events = new Map()
  const state = { lastResolveHeadFor: null }
  return {
    state,
    listSources: (options = {}) => {
      state.lastResolveHeadFor = options.resolveHeadFor ?? null
      return [...sources.values()].map((source) => ({ ...source }))
    },
    markHeadUnknown(sessionId) {
      const source = sources.get(sessionId)
      if (source) source.headSeq = null
    },
    listEvents(sessionId, afterSeq, limit) {
      return (events.get(sessionId) ?? [])
        .filter((row) => row.seq > afterSeq)
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },
    addSession(sessionId, headSeq = 0, generation = 'g1') {
      sources.set(sessionId, { sessionId, sourceGeneration: generation, workspaceId: 'ws', title: sessionId, headSeq })
      if (!events.has(sessionId)) events.set(sessionId, [])
    },
    append(sessionId, records) {
      const merged = [...(events.get(sessionId) ?? []), ...records]
      events.set(sessionId, merged)
      const source = sources.get(sessionId)
      if (source) source.headSeq = merged[merged.length - 1]?.seq ?? source.headSeq
    },
    advanceGeneration(sessionId, generation, headSeq = 0) {
      sources.set(sessionId, { ...sources.get(sessionId), sourceGeneration: generation, headSeq })
    },
  }
}

function msg(seq, text) {
  return { seq, type: 'user/message', time: 1000 + seq, semantic: true, text }
}

test('E03-01 a first scan discovers sources as fresh and writes no watermark', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 4)
  reader.append('s1', [msg(0, 'a'), msg(1, 'b')])
  const observer = new SourceObserver('scope', reader, cursors)

  const scan = await observer.scan()
  assert.equal(scan.discovered, 1)
  assert.deepEqual(scan.fresh, ['s1'])
  assert.equal(cursors.read('scope', 's1', 'g1').throughSeq, -1, 'nothing is claimed as read yet')
})

test('E03-01 reading advances the watermark only to the durable boundary of that read', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 4)
  reader.append('s1', [msg(0, 'a'), msg(1, 'b'), msg(2, 'c')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()

  const batch = await observer.readBatch({ sessionId: 's1', limit: 2 })
  assert.deepEqual(batch.records.map((r) => r.seq), [0, 1])
  assert.equal(batch.throughSeq, 1)
  assert.equal(batch.gap, false)
  assert.equal(cursors.read('scope', 's1', 'g1').state, 'processing')

  observer.commitRead({ sessionId: 's1', throughSeq: batch.throughSeq })
  assert.equal(cursors.read('scope', 's1', 'g1').throughSeq, 1)
})

test('E03-01 the next scan marks an advanced source dirty, not a quiet one', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 4)
  reader.append('s1', [msg(0, 'a')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()
  observer.readBatch({ sessionId: 's1' })
  observer.commitRead({ sessionId: 's1', throughSeq: 0 })

  assert.deepEqual((await observer.scan()).dirty, [], 'an unchanged session is never re-read')
  reader.append('s1', [msg(1, 'b')])
  assert.deepEqual((await observer.scan()).dirty, ['s1'])
})

test('E03-01 a generation change starts fresh and never rewrites the old generation', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 2, 'g1')
  reader.append('s1', [msg(0, 'a'), msg(1, 'b')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()
  observer.readBatch({ sessionId: 's1' })
  observer.commitRead({ sessionId: 's1', throughSeq: 1 })

  reader.advanceGeneration('s1', 'g2', 0)
  const scan = await observer.scan()
  assert.deepEqual(scan.generationChanged, ['s1'])
  assert.equal(cursors.read('scope', 's1', 'g2').throughSeq, -1, 'the new generation starts at zero')
  const batch = await observer.readBatch({ sessionId: 's1' })
  assert.equal(batch.fromSeq, -1)
})

test('E03-01 a truncated log is reported as a gap instead of contiguous coverage', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 10)
  reader.append('s1', [msg(0, 'a'), msg(5, 'later')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()
  const batch = await observer.readBatch({ sessionId: 's1' })
  assert.equal(batch.gap, true, 'a non-contiguous read must not claim coverage')
  assert.equal(cursors.read('scope', 's1', 'g1').state, 'gap')
})

test('E03-01 an unresolved head is deferred, never invented as movement', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 1)
  reader.append('s1', [msg(0, 'a')])
  const observer = new SourceObserver('scope', reader, cursors)
  const first = await observer.scan()
  assert.equal(first.headDeferred.length, 0, 'a brand-new source needs no head')
  assert.equal(reader.state.lastResolveHeadFor?.size ?? 0, 0, 'the first scan has no cursors to resolve')
  await observer.readBatch({ sessionId: 's1' })
  observer.commitRead({ sessionId: 's1', throughSeq: 0 })

  reader.markHeadUnknown('s1')
  const second = await observer.scan()
  assert.equal(reader.state.lastResolveHeadFor?.has('s1'), true, 'known sources ask for their current head')
  assert.deepEqual(second.dirty, [], 'without a resolved head there is no proof of movement')
  assert.deepEqual(second.headDeferred, ['s1'], 'the deferral is reported, not hidden')

  reader.advanceGeneration('s1', 'g1', 1)
  const third = await observer.scan()
  assert.deepEqual(third.dirty, ['s1'], 'a later resolved head still marks the source dirty')
})

test('E03-01 a forgotten source stops being read and stays readable by evidence', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 1)
  reader.append('s1', [msg(0, 'a')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()
  observer.exclude('s1')
  assert.equal(cursors.read('scope', 's1', 'g1').state, 'excluded')

  reader.append('s1', [msg(1, 'b')])
  assert.deepEqual((await observer.scan()).dirty, [], 'an excluded source is never marked dirty again')
  assert.equal((await observer.scan()).skippedExcluded, 0, 'excluded sources are still discovered, just not read')
})

test('E03-01 excluded session ids are skipped at discovery time', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1')
  reader.addSession('s2')
  const observer = new SourceObserver('scope', reader, cursors)
  const scan = await observer.scan(new Set(['s2']))
  assert.equal(scan.discovered, 1)
  assert.equal(scan.skippedExcluded, 1)
})

test('E03-01 the watermark never moves backwards', async () => {
  const reader = fakeReader()
  const cursors = memoryCursors()
  reader.addSession('s1', 3)
  reader.append('s1', [msg(0, 'a'), msg(1, 'b'), msg(2, 'c')])
  const observer = new SourceObserver('scope', reader, cursors)
  await observer.scan()
  observer.readBatch({ sessionId: 's1' })
  observer.commitRead({ sessionId: 's1', throughSeq: 2 })
  observer.commitRead({ sessionId: 's1', throughSeq: 0 })
  assert.equal(cursors.read('scope', 's1', 'g1').throughSeq, 2)
})

test('E03-01 the ledger cursor store speaks the same contract', async () => {
  const written = []
  const repo = {
    cursors: () => [
      { sessionId: 's1', sourceGeneration: 'g1', throughSeq: 3, state: 'dirty' },
    ],
    upsertCursor: (input) => written.push(input),
  }
  const store = new LedgerCursorStore(repo)
  assert.deepEqual(store.read('scope', 's1', 'g1'), { throughSeq: 3, state: 'dirty' })
  assert.equal(store.read('scope', 's1', 'g2'), undefined)
  store.write({ scopeId: 'scope', sessionId: 's2', sourceGeneration: 'g1', throughSeq: -1, state: 'fresh' })
  assert.equal(written.length, 1)
  assert.equal(store.all('scope').length, 1)
})