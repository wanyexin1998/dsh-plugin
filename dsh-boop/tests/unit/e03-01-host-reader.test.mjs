#!/usr/bin/env node
/**
 * E03-01 · HostSourceReader contract (offline).
 *
 * The in-host suite proves a real Session is discovered; this suite pins the
 * shape rules the observer depends on: EVERY event in ascending seq order with
 * a `semantic` flag, because a semantic-only listing turns a real Session into
 * a permanent READ_GAP. rc.2.1 exposes two planes (`listEvents` for continuity,
 * `filterEvents` for semantic text), so the reader must merge them.
 *
 * Run: node --test tests/unit/e03-01-host-reader.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HostSourceReader } from '../../src/host/observe/host-reader.ts'

function fakeCtx(query) {
  return { reflect: { get: (key) => (key === 'sessionQuery' ? query : undefined) } }
}

test('E03-01 a real Session read keeps contiguous seqs and marks only text-bearing events semantic', async () => {
  const all = [
    { seq: 0, type: 'permission/preset', time: 1 },
    { seq: 1, type: 'turn/start', time: 2 },
    { seq: 2, type: 'user/message', time: 3 },
    { seq: 3, type: 'assistant/message', time: 4 },
    { seq: 4, type: 'turn/end', time: 5 },
  ]
  const documents = [
    { seq: 2, type: 'user/message', time: 3, text: '请帮我整理项目' },
    { seq: 3, type: 'assistant/message', time: 4, text: '好的' },
  ]
  const reader = new HostSourceReader(
    fakeCtx({
      listEvents: async () => all,
      filterEvents: async () => documents,
    }),
  )
  const records = await reader.listEvents('session-1', -1, 100)
  assert.deepEqual(
    records.map((record) => record.seq),
    [0, 1, 2, 3, 4],
    'every event is present so the observer can prove contiguity (no false READ_GAP)',
  )
  assert.deepEqual(
    records.filter((record) => record.semantic).map((record) => record.seq),
    [2, 3],
    'only events with real extracted text are semantic',
  )
  assert.equal(records.find((record) => record.seq === 2).text, '请帮我整理项目')
  assert.equal(records.find((record) => record.seq === 1).text, undefined)
})

test('E03-01 a window starts after the durable watermark and respects the limit', async () => {
  const all = Array.from({ length: 10 }, (_, seq) => ({ seq, type: 'turn/start', time: seq }))
  const reader = new HostSourceReader(fakeCtx({ listEvents: async () => all, filterEvents: async () => [] }))
  const records = await reader.listEvents('session-1', 3, 3)
  assert.deepEqual(records.map((record) => record.seq), [4, 5, 6])
})

test('E03-01 a host without listEvents still uses semantic documents (degraded, no invented continuity)', async () => {
  const reader = new HostSourceReader(
    fakeCtx({
      filterEvents: async () => [{ seq: 2, type: 'user/message', time: 3, text: '只有语义文档' }],
    }),
  )
  const records = await reader.listEvents('session-1', -1, 10)
  assert.deepEqual(records.map((record) => record.seq), [2])
  assert.equal(records[0].semantic, true)
})
