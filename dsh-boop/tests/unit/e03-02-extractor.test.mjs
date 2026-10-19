#!/usr/bin/env node
/**
 * E03-02 · Model-side memory extraction unit suite.
 *
 * Fake transport / observation / store, but the REAL `MemoryCommitter` and the
 * REAL single-permit scheduler: what is proven is BOOP's own control flow —
 * evidence admission, CAS/authority hand-off, the frozen failure policy
 * (truncated/empty/thinking-mixed never committed, two format failures stop the
 * batch and preserve the watermark), cancellation, soft timeout, backoff and
 * single-concurrency serialization. No model is contacted here.
 *
 * Run: node --test --test-force-exit tests/unit/e03-02-extractor.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryCommitter } from '../../src/host/memory/committer.ts'
import { QwenTransportError } from '../../src/host/model/qwen-client.ts'
import {
  MemoryExtractor,
  admitCandidates,
  detectThinkingLeak,
  estimateTokens,
  parseStrictJson,
  EXTRACTION_RESPONSE_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
} from '../../src/host/memory/extractor.ts'
import {
  ModelPermits,
  PermitCancelledError,
  PermitTimeoutError,
  backoffDelayMs,
  delay,
} from '../../src/host/model/permits.ts'

/* ── deterministic clock ──────────────────────────────────────────────── */

function createClock() {
  let now = 1000
  let seq = 0
  const timers = new Map()
  return {
    api: {
      now: () => now,
      setTimeout(handler, ms) {
        const id = ++seq
        timers.set(id, { at: now + Math.max(0, ms), handler })
        return id
      },
      clearTimeout(id) {
        timers.delete(id)
      },
    },
    advance(ms) {
      now += Math.max(0, ms)
      let progressed = true
      while (progressed) {
        progressed = false
        for (const [id, timer] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
          if (timer.at <= now) {
            timers.delete(id)
            timer.handler()
            progressed = true
          }
        }
      }
    },
    pending: () => timers.size,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/* ── fakes ────────────────────────────────────────────────────────────── */

/** CursorStore over an in-memory map; mirrors observer's own write shape. */
function createCursors() {
  const rows = new Map()
  const key = (scopeId, sessionId, generation) => `${scopeId}\u0000${sessionId}\u0000${generation}`
  return {
    rows,
    read(scopeId, sessionId, generation) {
      const row = rows.get(key(scopeId, sessionId, generation))
      return row ? { throughSeq: row.throughSeq, state: row.state } : undefined
    },
    write(input) {
      rows.set(key(input.scopeId, input.sessionId, input.sourceGeneration), { ...input })
    },
    all(scopeId) {
      return [...rows.values()]
        .filter((row) => row.scopeId === scopeId)
        .map((row) => ({
          sessionId: row.sessionId,
          sourceGeneration: row.sourceGeneration,
          throughSeq: row.throughSeq,
          state: row.state,
        }))
    },
    get(scopeId, sessionId, generation) {
      return rows.get(key(scopeId, sessionId, generation)) ?? null
    },
  }
}

/** BatchReader that serves scripted batches (one per readBatch call). */
function createBatchReader(script, cursors, scopeId, generation) {
  const calls = { readBatch: 0, commitRead: [] }
  const pending = [...script]
  return {
    calls,
    cursors,
    async readBatch(input) {
      calls.readBatch += 1
      const next = pending.length > 1 ? pending.shift() : pending[0]
      // Mirror SourceObserver: the read boundary advances to the batch end.
      if (next.records.length > 0) {
        cursors.write({
          scopeId,
          sessionId: input.sessionId,
          sourceGeneration: generation,
          throughSeq: next.throughSeq,
          state: next.gap ? 'gap' : 'processing',
        })
      }
      return { fromSeq: next.fromSeq, throughSeq: next.throughSeq, gap: next.gap === true, records: next.records }
    },
    commitRead(input) {
      calls.commitRead.push(input.throughSeq)
      cursors.write({
        scopeId,
        sessionId: input.sessionId,
        sourceGeneration: generation,
        throughSeq: input.throughSeq,
        state: 'dirty',
      })
    },
  }
}

/** In-memory MemoryStore; CAS semantics match the ledger (no silent overwrite). */
function createMemoryStore() {
  const facts = new Map()
  const evidence = []
  const snapshots = []
  const ownerKey = (scopeId, ownerType, ownerId) => `${scopeId}\u0000${ownerType}\u0000${ownerId}`
  const factKey = (scopeId, factId) => `${scopeId}\u0000${factId}`
  return {
    facts,
    evidence,
    snapshots,
    currentVersion(scopeId, ownerType, ownerId) {
      const rows = snapshots.filter((row) => row.key === ownerKey(scopeId, ownerType, ownerId))
      return rows.length === 0 ? 0 : rows[rows.length - 1].version
    },
    facts(scopeId, ownerType, ownerId) {
      return [...facts.values()]
        .filter((fact) => fact.scopeId === scopeId && fact.ownerType === ownerType && fact.ownerId === ownerId)
        .map((fact) => ({ ...fact }))
    },
    upsertFact(input) {
      const key = factKey(input.scopeId, input.factId)
      const previous = facts.get(key)
      const version = (previous?.version ?? 0) + 1
      facts.set(key, { ...input, version, status: input.status ?? 'active' })
      return { version }
    },
    addEvidence(input) {
      evidence.push({ ...input })
    },
    saveMemorySnapshot(input) {
      assert.equal(
        this.currentVersion(input.scopeId, input.ownerType, input.ownerId),
        input.expectedBaselineVersion,
        'snapshot CAS must not overwrite a newer baseline',
      )
      const version = input.expectedBaselineVersion + 1
      snapshots.push({ key: ownerKey(input.scopeId, input.ownerType, input.ownerId), version, ...input })
      return { version }
    },
    latestMemorySnapshot(scopeId, ownerType, ownerId) {
      const rows = snapshots.filter((row) => row.key === ownerKey(scopeId, ownerType, ownerId))
      return rows.length === 0 ? null : rows[rows.length - 1]
    },
  }
}

/** Scripted model transport: records every request, honours abort. */
function createFakeClient(script, config = { providerId: 'qwen-local', modelId: 'qwen3.8-27b' }) {
  const requests = []
  const state = { calls: 0, active: 0, maxActive: 0 }
  const queue = [...script]
  return {
    config: {
      providerId: config.providerId,
      modelId: config.modelId,
      credentialRef: 'none',
      baseUrl: 'http://fake.invalid/v1',
      contextWindowTokens: 196608,
      declaredContext: '196k',
      quantization: null,
      externalFallbackAllowed: false,
    },
    requests,
    state,
    async chat(request) {
      state.calls += 1
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      requests.push(request)
      try {
        const step = queue.length > 1 ? queue.shift() : queue[0]
        if (typeof step === 'function') return await step(request)
        return step
      } finally {
        state.active -= 1
      }
    },
  }
}

function chatResult(content, overrides = {}) {
  return {
    content,
    reasoning: overrides.reasoning ?? null,
    toolCalls: overrides.toolCalls ?? [],
    finishReason: overrides.finishReason ?? 'stop',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    elapsedMs: 5,
    ...overrides,
  }
}

function transportError(code, detail, status = 0) {
  return new QwenTransportError(code, `${code}: ${detail}`, status, detail)
}

/* ── default extraction fixture ───────────────────────────────────────── */

const SCOPE = 'boop-testscope'
const SESSION = 'session-e03-02'
const GENERATION = `${SESSION}@4:1700000000000:`
const OWNER = { type: 'session', id: SESSION }

function batchOf(records, { fromSeq = -1, throughSeq = records.at(-1)?.seq ?? -1, gap = false } = {}) {
  return { records, fromSeq, throughSeq, gap }
}

function userEvent(seq, text, sourceKind = 'user') {
  return { seq, type: 'user/message', time: seq, semantic: true, text, sourceKind }
}

function makeExtractor(overrides = {}) {
  const clock = overrides.clock ?? createClock()
  // Prefer the reader's own cursor store so `readBatch`/`commitRead` and the
  // extractor's restore/advance logic observe the SAME watermark plane.
  const cursors = overrides.cursors ?? overrides.batch?.cursors ?? createCursors()
  if (overrides.cursors === undefined && overrides.batch?.cursors === undefined) {
    cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  } else if (cursors.get(SCOPE, SESSION, GENERATION) === null && overrides.skipCursorSeed !== true) {
    cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  }
  const store = overrides.store ?? createMemoryStore()
  const committer = overrides.committer ?? new MemoryCommitter(store)
  const client = overrides.client
  const batch = overrides.batch
  const permits =
    overrides.permits ??
    new ModelPermits({ softTimeoutMs: overrides.softTimeoutMs ?? 45_000, timers: clock.api })
  const extractor = new MemoryExtractor({
    client,
    batch,
    cursors,
    committer,
    store,
    permits,
    timers: clock.api,
    config: {
      scopeId: SCOPE,
      owner: OWNER,
      ...(overrides.config ?? {}),
    },
    ...(overrides.onAudit === undefined ? {} : { onAudit: overrides.onAudit }),
  })
  return { extractor, clock, cursors, store, committer, client, batch, permits }
}

function successContent(facts, unresolved = []) {
  return JSON.stringify({ facts, unresolved })
}

const GOOD_FACT = {
  text: '本阶段不部署生产环境',
  kind: 'decision',
  confidence: 0.95,
  evidenceSeq: 2,
  authority: 'user_confirmed',
}

/* ── 1. permit scheduler ──────────────────────────────────────────────── */

test('E03-02 permits serialize every BOOP self-managed call on ONE permit', async () => {
  const clock = createClock()
  const permits = new ModelPermits({ timers: clock.api, softTimeoutMs: 45_000 })
  const order = []
  const first = await permits.acquire({ label: 'job-a' })
  assert.equal(permits.activeCount, 1)
  assert.equal(permits.queuedCount, 0)

  const secondPromise = permits.acquire({ label: 'job-b' }).then((lease) => {
    order.push('b')
    return lease
  })
  const thirdPromise = permits.acquire({ label: 'job-c' }).then((lease) => {
    order.push('c')
    return lease
  })
  await tick()
  assert.equal(permits.queuedCount, 2, 'waiters queue, never run concurrently')
  assert.deepEqual(order, [])

  first.release()
  const second = await secondPromise
  assert.equal(permits.activeCount, 1)
  assert.equal(permits.queuedCount, 1)
  assert.deepEqual(order, ['b'], 'FIFO order, one holder at a time')

  second.release()
  const third = await thirdPromise
  assert.deepEqual(order, ['b', 'c'])
  third.release()
  assert.equal(permits.activeCount, 0)
  second.release() // idempotent
  assert.equal(permits.activeCount, 0)
})

test('E03-02 a queued job can be cancelled without consuming the permit', async () => {
  const clock = createClock()
  const permits = new ModelPermits({ timers: clock.api })
  const holder = await permits.acquire()
  const controller = new AbortController()
  const queued = permits.acquire({ label: 'waiter', signal: controller.signal })
  await tick()
  controller.abort()
  await assert.rejects(queued, (error) => error instanceof PermitCancelledError)
  assert.equal(permits.queuedCount, 0, 'the cancelled waiter left the queue')
  holder.release()
  const next = await permits.acquire({ label: 'next' })
  assert.equal(permits.activeCount, 1)
  next.release()
})

test('E03-02 the 45s soft timeout aborts the call, discards its result and releases the permit', async () => {
  const clock = createClock()
  const permits = new ModelPermits({ timers: clock.api, softTimeoutMs: 45_000 })
  let sawAbort = false
  const task = permits.withPermit(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true
            reject(new Error('aborted by soft timeout'))
          },
          { once: true },
        )
      }),
    { label: 'slow' },
  )
  await tick()
  clock.advance(45_000)
  await assert.rejects(task, (error) => error instanceof PermitTimeoutError)
  assert.equal(sawAbort, true, 'the underlying request observes the abort')
  assert.equal(permits.activeCount, 0, 'the permit is released after the task settles')
})

test('E03-02 an external cancel propagates and a throwing task releases the permit', async () => {
  const clock = createClock()
  const permits = new ModelPermits({ timers: clock.api, softTimeoutMs: 45_000 })
  const controller = new AbortController()
  const running = permits.withPermit(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    { signal: controller.signal, label: 'cancel-me' },
  )
  await tick()
  controller.abort()
  await assert.rejects(running, (error) => error instanceof PermitCancelledError)
  assert.equal(permits.activeCount, 0)

  await assert.rejects(
    permits.withPermit(async () => {
      throw new Error('boom')
    }),
  )
  assert.equal(permits.activeCount, 0, 'a failed task never leaks the permit')
})

test('E03-02 backoff is deterministic, bounded and cancellable', async () => {
  assert.equal(backoffDelayMs(1), 500)
  assert.equal(backoffDelayMs(2), 1000)
  assert.equal(backoffDelayMs(3), 2000)
  assert.equal(backoffDelayMs(10), 8000, 'capped')
  assert.equal(backoffDelayMs(1, { baseMs: 100 }), 100)

  const clock = createClock()
  let done = false
  const wait = delay(1000, { timers: clock.api }).then(() => {
    done = true
  })
  await tick()
  assert.equal(done, false)
  clock.advance(1000)
  await wait
  assert.equal(done, true)

  const controller = new AbortController()
  const cancelled = delay(5000, { timers: clock.api, signal: controller.signal })
  await tick()
  controller.abort()
  await assert.rejects(cancelled, (error) => error instanceof PermitCancelledError)
})

/* ── 2. pure parsing/admission helpers ───────────────────────────────── */

test('E03-02 strict JSON parsing never repairs a truncated body', () => {
  assert.deepEqual(parseStrictJson('{"facts":[]}'), { ok: true, value: { facts: [] } })
  assert.equal(parseStrictJson('```json\n{"facts":[]}\n```').ok, true, 'a whole-document json fence is accepted')
  assert.equal(parseStrictJson('{"facts":[{"text":"x"').ok, false)
  assert.equal(parseStrictJson('好的，结果如下：{"facts":[]}').ok, false, 'no substring guessing')
  assert.equal(parseStrictJson('').reason, 'EMPTY_OUTPUT')
})

test('E03-02 thinking traces are never mistaken for an answer', () => {
  assert.equal(detectThinkingLeak('{"facts":[]}', null), null)
  assert.equal(detectThinkingLeak('思考过程：先看看资料\n{"facts":[]}', null), 'THINKING_LEAKED')
  assert.equal(detectThinkingLeak('<think>beep</think>{"facts":[]}', null), 'THINKING_LEAKED')
  assert.equal(detectThinkingLeak('{"facts":[]}', '先看看资料再说'), null, 'separate reasoning is fine')
})

test('E03-02 token estimates are conservative, never advertised capacity', () => {
  assert.ok(estimateTokens('abcdefgh') > 0)
  assert.ok(estimateTokens('中文中文中文') > estimateTokens('abcdefgh'), 'CJK is estimated denser')
  assert.match(JSON.stringify(EXTRACTION_RESPONSE_SCHEMA), /evidenceSeq/)
})

test('E03-02 a candidate outside the declared window is refused before it can be committed', () => {
  const outcome = admitCandidates({
    parsed: {
      facts: [
        { text: '证据在当前窗口', kind: 'decision', confidence: 0.9, evidenceSeq: 2, authority: 'user_confirmed' },
        { text: '越窗证据', kind: 'decision', confidence: 0.9, evidenceSeq: 99 },
        { text: '从未读过的事件', kind: 'claim', confidence: 0.8, evidenceSeq: 3 },
        { text: '密钥 api_key = sk-abcdefgh12345678', kind: 'claim', confidence: 0.9, evidenceSeq: 2 },
      ],
    },
    scopeId: SCOPE,
    sessionId: SESSION,
    sourceGeneration: GENERATION,
    fromSeq: -1,
    toSeq: 5,
    readSeqs: new Set([2]),
    existingFactIds: new Set(),
    maxChanges: 50,
  })
  assert.equal(outcome.changes.length, 1)
  assert.equal(outcome.changes[0].text, '证据在当前窗口')
  assert.equal(outcome.changes[0].evidenceRefs[0].seq, 2)
  assert.deepEqual(
    outcome.rejections.map((row) => row.reason),
    ['EVIDENCE_OUT_OF_WINDOW', 'EVIDENCE_OUT_OF_WINDOW', 'POSSIBLE_SECRET'],
  )
})

/* ── 3. extraction flow ──────────────────────────────────────────────── */

test('E03-02 a valid extraction commits through the real committer with a real evidence address', async () => {
  const clock = createClock()
  const client = createFakeClient([chatResult(successContent([GOOD_FACT]))])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境，这是用户确认的决定。')], { fromSeq: -1, throughSeq: 2 })],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor, store } = makeExtractor({ client, batch, cursors, clock })
  const result = await extractor.extract({ sessionId: SESSION })

  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(result.version, 1)
  assert.equal(result.applied.length, 1)
  assert.equal(result.fromSeq, -1)
  assert.equal(result.toSeq, 2)
  assert.equal(result.model.providerId, 'qwen-local')
  assert.equal(result.model.modelId, 'qwen3.8-27b', 'every call audits the real route')
  assert.equal(result.model.attempts.length, 1)

  const facts = store.facts(SCOPE, OWNER.type, OWNER.id)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].text, '本阶段不部署生产环境')
  assert.equal(facts[0].authority, 'user_confirmed')
  assert.equal(store.evidence.length, 1)
  assert.equal(store.evidence[0].sessionId, SESSION)
  assert.equal(store.evidence[0].seq, 2)
  const snapshot = store.latestMemorySnapshot(SCOPE, OWNER.type, OWNER.id)
  assert.ok(snapshot.body.includes('本阶段不部署生产环境'))
  assert.equal(snapshot.coverage[`${SESSION}#g1`]?.throughSeq ?? Object.values(snapshot.coverage)[0].throughSeq, 2)

  assert.deepEqual(batch.calls.commitRead, [2], 'the processed watermark advances only after the commit')
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, 2)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).state, 'dirty')
})

test('E03-02 runtime-context injections never enter the prompt and a synthetic-only window is a valid no-change', async () => {
  const clock = createClock()
  const client = createFakeClient([chatResult(successContent([]))])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  const batch = createBatchReader(
    [
      batchOf([
        userEvent(1, '本阶段不部署生产环境', 'user'),
        userEvent(2, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', 'runtime-context'),
      ], { fromSeq: -1, throughSeq: 2 }),
    ],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, cursors, clock })

  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'no-change')
  assert.equal(client.state.calls, 1)
  const prompt = client.requests[0].messages.find((message) => message.role === 'user').content
  assert.ok(prompt.includes('本阶段不部署生产环境'))
  assert.ok(!prompt.includes('Current runtime context'), 'injected context is not conversation')
  assert.deepEqual(batch.calls.commitRead, [2], 'the covered range is still marked processed')
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, 2)

  // A window of ONLY injected context needs no model call at all.
  const syntheticOnly = createBatchReader(
    [batchOf([userEvent(1, 'Time sampled: 2026-10-18', 'time-context')], { fromSeq: -1, throughSeq: 1 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const second = makeExtractor({
    client: createFakeClient([chatResult(successContent([]))]),
    batch: syntheticOnly,
    clock: createClock(),
  })
  const secondResult = await second.extractor.extract({ sessionId: SESSION })
  assert.equal(secondResult.status, 'no-change')
  assert.equal(second.client.state.calls, 0, 'nothing to extract means no model call')
})

/* ── 4. frozen failure policy ────────────────────────────────────────── */

test('E03-02 truncated / empty / thinking-mixed output is never committed and never advances the watermark', async () => {
  const cases = [
    { name: 'truncated', result: chatResult(successContent([GOOD_FACT]), { finishReason: 'length' }), reason: 'TRUNCATED_OUTPUT' },
    { name: 'empty', result: chatResult('', {}), reason: 'EMPTY_OUTPUT' },
    { name: 'thinking-mixed', result: chatResult('思考过程：让我想想\n{"facts":[]}', {}), reason: 'THINKING_LEAKED' },
    { name: 'unparsable', result: chatResult('当然可以！这里是要点。', {}), reason: 'NOT_JSON_DOCUMENT' },
    { name: 'schema', result: chatResult('{"facts":"nope"}', {}), reason: 'FACTS_NOT_ARRAY' },
  ]
  for (const entry of cases) {
    const clock = createClock()
    const cursors = createCursors()
    cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
    const store = createMemoryStore()
    const client = createFakeClient([entry.result])
    const batch = createBatchReader(
      [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
      cursors,
      SCOPE,
      GENERATION,
    )
    const { extractor } = makeExtractor({ client, batch, cursors, store, clock })
    const result = await extractor.extract({ sessionId: SESSION })
    assert.equal(result.status, 'invalid-output', `${entry.name}: ${JSON.stringify(result)}`)
    assert.equal(result.reason, entry.reason, entry.name)
    assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0, `${entry.name}: nothing committed`)
    assert.deepEqual(batch.calls.commitRead, [], `${entry.name}: watermark untouched`)
    assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1, `${entry.name}: watermark restored`)
  }
})

test('E03-02 two consecutive format failures stop the batch and preserve the watermark', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const client = createFakeClient([chatResult('not json at all')])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, cursors, store, clock })

  const first = await extractor.extract({ sessionId: SESSION })
  assert.equal(first.status, 'invalid-output')
  assert.equal(first.formatFailures, 1)
  assert.equal(first.halted, false)

  const second = await extractor.extract({ sessionId: SESSION })
  assert.equal(second.status, 'invalid-output')
  assert.equal(second.formatFailures, 2)
  assert.equal(second.halted, true, 'the batch is stopped after two format failures')

  const third = await extractor.extract({ sessionId: SESSION })
  assert.equal(third.status, 'halted')
  assert.equal(third.halted, true)
  assert.equal(client.state.calls, 2, 'a halted batch never reaches the model again')

  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1, 'the watermark is preserved, not advanced')
  assert.deepEqual(batch.calls.commitRead, [])

  extractor.resetBatch(SESSION)
  const afterReset = await extractor.extract({ sessionId: SESSION })
  assert.equal(afterReset.status, 'invalid-output', 'an explicit operator reset retries the batch')
  assert.equal(afterReset.formatFailures, 1)
  assert.equal(client.state.calls, 3)
})

test('E03-02 an out-of-window citation from the model is refused, never committed', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const badFact = { ...GOOD_FACT, evidenceSeq: 999 }
  const client = createFakeClient([chatResult(successContent([badFact]))])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({ client, batch, store, clock })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'invalid-output')
  assert.match(String(result.reason), /NO_ADMISSIBLE_CANDIDATES:EVIDENCE_OUT_OF_WINDOW/)
  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1)
})

test('E03-02 a soft timeout commits nothing and restores the watermark', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const client = createFakeClient([
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(transportError('MODEL_UNAVAILABLE', 'timeout-or-cancel')), {
          once: true,
        })
      }),
  ])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: 7, state: 'dirty' })
  const batch = createBatchReader(
    [batchOf([userEvent(8, '新的决定：下周先做验收')], { fromSeq: 7, throughSeq: 8 })],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, cursors, store, clock, softTimeoutMs: 45_000 })

  const pending = extractor.extract({ sessionId: SESSION })
  await tick()
  clock.advance(45_000)
  const result = await pending
  assert.equal(result.status, 'timeout')
  assert.equal(result.reason, 'SOFT_TIMEOUT')
  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0, 'a timed-out call commits nothing')
  assert.deepEqual(batch.calls.commitRead, [], 'the watermark is not advanced')
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, 7, 'the watermark is restored')
  assert.equal(client.state.calls, 1, 'timeouts are not retried')
})

test('E03-02 an external cancellation commits nothing and restores the watermark', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const client = createFakeClient([
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(transportError('MODEL_UNAVAILABLE', 'timeout-or-cancel')), {
          once: true,
        })
      }),
  ])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: 3, state: 'dirty' })
  const batch = createBatchReader(
    [batchOf([userEvent(4, '新的一句话')], { fromSeq: 3, throughSeq: 4 })],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, cursors, store, clock })
  const controller = new AbortController()
  const pending = extractor.extract({ sessionId: SESSION, signal: controller.signal })
  await tick()
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, 3)
  assert.deepEqual(batch.calls.commitRead, [])
})

test('E03-02 model unavailability backs off once, then reports unavailable without changing provider', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const client = createFakeClient([
    () => {
      throw transportError('MODEL_UNAVAILABLE', 'service unreachable', 503)
    },
    chatResult(successContent([GOOD_FACT])),
  ])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, store, clock })
  const pending = extractor.extract({ sessionId: SESSION })
  await tick()
  clock.advance(500) // first backoff window
  const result = await pending
  assert.equal(result.status, 'committed', 'the retry succeeds on the same configured route')
  assert.equal(result.model.attempts.length, 2)
  assert.equal(client.state.calls, 2)
  assert.equal(client.requests[0].model ?? client.config.modelId, client.config.modelId)
  assert.ok(result.model.attempts[0].error.includes('MODEL_UNAVAILABLE'))
})

test('E03-02 exhausted transport retries report unavailable, commit nothing and keep the watermark', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const client = createFakeClient([
    () => {
      throw transportError('MODEL_UNAVAILABLE', 'service unreachable', 503)
    },
    () => {
      throw transportError('MODEL_UNAVAILABLE', 'service unreachable', 503)
    },
  ])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({ client, batch, store, clock })
  const pending = extractor.extract({ sessionId: SESSION })
  await tick()
  clock.advance(500)
  const result = await pending
  assert.equal(result.status, 'unavailable')
  assert.match(String(result.reason), /MODEL_UNAVAILABLE/)
  assert.equal(client.state.calls, 2, 'one original attempt + one backoff retry')
  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1)
})

test('E03-02 a model configuration/4xx failure is not retried and never switches provider', async () => {
  const clock = createClock()
  const client = createFakeClient([
    () => {
      throw transportError('MODEL_BAD_REQUEST', 'bad schema request', 400)
    },
    chatResult(successContent([GOOD_FACT])),
  ])
  const batch = createBatchReader(
    [batchOf([userEvent(2, 'x')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({ client, batch, clock })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'unavailable')
  assert.equal(client.state.calls, 1, 'a 4xx is terminal; BOOP never retries another provider')
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1)
})

/* ── 5. batch/window/CAS edges ───────────────────────────────────────── */

test('E03-02 a gap, an unobserved Session and an empty window produce no model call and no commit', async () => {
  const clock = createClock()
  const cursorless = makeExtractor({
    client: createFakeClient([chatResult(successContent([GOOD_FACT]))]),
    batch: createBatchReader([batchOf([], { fromSeq: -1, throughSeq: -1 })], createCursors(), SCOPE, GENERATION),
    cursors: createCursors(), // deliberately no cursor row
    skipCursorSeed: true,
    clock,
  })
  const unobserved = await cursorless.extractor.extract({ sessionId: SESSION })
  assert.equal(unobserved.status, 'not-observed')
  assert.equal(cursorless.client.state.calls, 0)

  const gapBatch = createBatchReader(
    [batchOf([userEvent(5, 'x')], { fromSeq: -1, throughSeq: 5, gap: true })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const gapRun = makeExtractor({ client: createFakeClient([chatResult(successContent([GOOD_FACT]))]), batch: gapBatch, clock })
  const gap = await gapRun.extractor.extract({ sessionId: SESSION })
  assert.equal(gap.status, 'gap')
  assert.equal(gapRun.client.state.calls, 0)
  assert.deepEqual(gapBatch.calls.commitRead, [])

  const emptyBatch = createBatchReader(
    [batchOf([], { fromSeq: 3, throughSeq: 3 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({
    client: createFakeClient([chatResult(successContent([GOOD_FACT]))]),
    batch: emptyBatch,
    clock: createClock(),
  })
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: 3, state: 'dirty' })
  const empty = await extractor.extract({ sessionId: SESSION })
  assert.equal(empty.status, 'no-op')
  assert.equal(empty.audit.some((event) => event.kind === 'extract/no-op'), true)
})

test('E03-02 two extracts share the single permit: the model is never called concurrently', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  let releaseFirst = null
  const client = createFakeClient([
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve(chatResult(successContent([GOOD_FACT])))
      }),
    chatResult(successContent([{ ...GOOD_FACT, text: '第二条事实' }])),
  ])
  const cursors = createCursors()
  cursors.write({ scopeId: SCOPE, sessionId: SESSION, sourceGeneration: GENERATION, throughSeq: -1, state: 'fresh' })
  const batch = createBatchReader(
    [
      batchOf([userEvent(2, '第一条事实')], { fromSeq: -1, throughSeq: 2 }),
      batchOf([userEvent(2, '第一条事实')], { fromSeq: -1, throughSeq: 2 }),
    ],
    cursors,
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, store, cursors, clock, softTimeoutMs: 45_000 })

  const first = extractor.extract({ sessionId: SESSION })
  await tick()
  const second = extractor.extract({ sessionId: SESSION })
  await tick()
  assert.equal(client.state.maxActive, 1, 'only one BOOP call runs at a time')
  assert.equal(client.state.calls, 1, 'the second job waits for the permit')

  releaseFirst()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.status, 'committed')
  assert.equal(secondResult.status, 'committed')
  assert.equal(client.state.maxActive, 1, 'serialization held for the whole run')
  assert.equal(client.state.calls, 2)
})

test('E03-02 a moved baseline (CAS) discards the candidates and keeps the watermark', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  // Simulate another writer having advanced the snapshot: baseline 3 while the
  // store is already at version 4.
  store.saveMemorySnapshot({ scopeId: SCOPE, ownerType: OWNER.type, ownerId: OWNER.id, body: '', coverage: {}, expectedBaselineVersion: 0 })
  store.saveMemorySnapshot({ scopeId: SCOPE, ownerType: OWNER.type, ownerId: OWNER.id, body: '', coverage: {}, expectedBaselineVersion: 1 })
  store.saveMemorySnapshot({ scopeId: SCOPE, ownerType: OWNER.type, ownerId: OWNER.id, body: '', coverage: {}, expectedBaselineVersion: 2 })
  store.saveMemorySnapshot({ scopeId: SCOPE, ownerType: OWNER.type, ownerId: OWNER.id, body: '', coverage: {}, expectedBaselineVersion: 3 })
  const client = createFakeClient([chatResult(successContent([GOOD_FACT]))])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({ client, batch, store, clock })
  const result = await extractor.extract({ sessionId: SESSION, baselineVersion: 3 })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'BASELINE_MOVED')
  assert.equal(store.facts(SCOPE, OWNER.type, OWNER.id).length, 0)
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, -1, 'CAS failure does not advance the watermark')
  assert.deepEqual(batch.calls.commitRead, [])
})

test('E03-02 an over-budget event tail is deferred to the next batch, never silently skipped', async () => {
  const clock = createClock()
  const client = createFakeClient([chatResult(successContent([{ ...GOOD_FACT, evidenceSeq: 1 }]))])
  const batch = createBatchReader(
    [
      batchOf(
        [userEvent(1, 'a'.repeat(90)), userEvent(2, 'b'.repeat(4000))],
        { fromSeq: -1, throughSeq: 2 },
      ),
    ],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, cursors } = makeExtractor({
    client,
    batch,
    clock,
    // Cap fits the banner + first event, not the second: only a prefix may be
    // processed, and the deferred tail must be retried next batch.
    config: { maxInputTokens: 700, tokensPerChar: 1 },
  })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'committed')
  assert.equal(result.toSeq, 1, 'only the prefix that fit the cap was processed')
  assert.deepEqual(batch.calls.commitRead, [1], 'coverage claims only the processed prefix')
  assert.equal(cursors.get(SCOPE, SESSION, GENERATION).throughSeq, 1)
})

test('E03-02 no valid change still marks the covered range processed (frozen copy rule)', async () => {
  const clock = createClock()
  const store = createMemoryStore()
  const committerCalls = []
  const realCommitter = new MemoryCommitter(store)
  const committer = {
    commit(proposal, owner) {
      committerCalls.push(proposal)
      return realCommitter.commit(proposal, owner)
    },
  }
  const client = createFakeClient([chatResult(successContent([], ['某个未知事项']))])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '只是闲聊，没有新事实')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, store, committer, clock })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'no-change')
  assert.deepEqual(committerCalls, [], 'nothing is written when the model proposes no facts')
  assert.deepEqual(batch.calls.commitRead, [2])
  assert.deepEqual(result.unresolved, ['某个未知事项'])
})

test('E03-02 audit events name the actual route on every model attempt', async () => {
  const clock = createClock()
  const audits = []
  const client = createFakeClient([chatResult(successContent([GOOD_FACT]))])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor } = makeExtractor({ client, batch, clock, onAudit: (event) => audits.push(event) })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'committed')
  const attempt = audits.find((event) => event.kind === 'model/attempt')
  const completed = audits.find((event) => event.kind === 'model/completed')
  assert.equal(attempt.providerId, 'qwen-local')
  assert.equal(attempt.modelId, 'qwen3.8-27b')
  assert.equal(completed.reasoningSeparated, false)
  assert.equal(audits.some((event) => event.kind === 'watermark/committed'), false)
  assert.ok(audits.some((event) => event.kind === 'extract/committed'))
  // The extraction result's own audit trail is returned even without a sink.
  assert.ok(result.audit.some((event) => event.kind === 'model/completed'))
  // Mechanical JSON extraction requests no thinking trace by default; the
  // deployment may keep it on, and the parser still rejects a leaked trace.
  assert.equal(client.requests[0].disableThinking, true)
  assert.equal(client.requests[0].temperature, 0)
  assert.equal(client.requests[0].maxTokens, 2_048)
  assert.equal(client.requests[0].responseFormat.json_schema.name, 'boop_memory_extraction')

  const thinkingOn = makeExtractor({
    client: createFakeClient([chatResult(successContent([GOOD_FACT]))]),
    batch: createBatchReader(
      [batchOf([userEvent(2, '本阶段不部署生产环境')], { fromSeq: -1, throughSeq: 2 })],
      createCursors(),
      SCOPE,
      GENERATION,
    ),
    clock: createClock(),
    config: { disableThinking: false },
  })
  const kept = await thinkingOn.extractor.extract({ sessionId: SESSION })
  assert.equal(kept.status, 'committed')
  assert.equal(thinkingOn.client.requests[0].disableThinking, false)
})

/* ── 5. subject keys: comparable subject, never bare `kind` ───────────── */

test('E03-07 the extraction contract carries a subject key and asks for distinct subjects', () => {
  const factSchema = EXTRACTION_RESPONSE_SCHEMA.properties.facts.items
  assert.deepEqual(factSchema.properties.subjectKey, { type: 'string' })
  assert.equal(
    factSchema.required.includes('subjectKey'),
    false,
    'subjectKey is optional: a model that does not know the subject must be able to omit it',
  )
  assert.match(EXTRACTION_SYSTEM_PROMPT, /subjectKey/u)
  assert.match(EXTRACTION_SYSTEM_PROMPT, /不同对象必须用不同 subjectKey/u)
})

test('E03-07 an unusable subjectKey is dropped from admission, never invented', () => {
  const outcome = admitCandidates({
    parsed: {
      facts: [
        { text: 'A 决策', kind: 'decision', confidence: 0.9, evidenceSeq: 2, authority: 'user_confirmed', subjectKey: ' deploy-policy ' },
        { text: 'B 决策', kind: 'decision', confidence: 0.9, evidenceSeq: 2, authority: 'user_confirmed' },
        { text: 'C 主张', kind: 'claim', confidence: 0.9, evidenceSeq: 2, subjectKey: 42 },
        { text: 'D 主张', kind: 'claim', confidence: 0.9, evidenceSeq: 2, subjectKey: 'x'.repeat(500) },
        { text: 'E 主张', kind: 'claim', confidence: 0.9, evidenceSeq: 2, subjectKey: 'bad\u0000key' },
      ],
    },
    scopeId: SCOPE,
    sessionId: SESSION,
    sourceGeneration: GENERATION,
    fromSeq: -1,
    toSeq: 5,
    readSeqs: new Set([2]),
    existingFactIds: new Set(),
    maxChanges: 50,
  })
  assert.equal(outcome.changes.length, 5, 'an unusable key never rejects the fact itself')
  assert.equal(outcome.changes[0].subjectKey, 'deploy-policy', 'the key is trimmed, not invented')
  for (const index of [1, 2, 3, 4]) {
    assert.equal(Object.hasOwn(outcome.changes[index], 'subjectKey'), false, `change ${index} must carry no key`)
  }
  assert.equal(outcome.candidatesWithSubjectKey, 1, 'only usable keys are counted')
})

test('E03-07 model subject keys reach the committer: different subjects stay active', async () => {
  const clock = createClock()
  const client = createFakeClient([
    chatResult(
      successContent([
        {
          text: '本阶段不部署生产环境',
          kind: 'decision',
          confidence: 0.95,
          evidenceSeq: 2,
          authority: 'user_confirmed',
          subjectKey: 'deploy-policy',
        },
        {
          text: '下周五前完成 E03-04 验收',
          kind: 'decision',
          confidence: 0.9,
          evidenceSeq: 2,
          authority: 'user_exploration',
          subjectKey: 'deadline:e03-04',
        },
      ]),
    ),
  ])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '本阶段不部署生产环境，下周五前完成 E03-04 验收')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, store } = makeExtractor({ client, batch, clock })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(result.changeCount, 2)
  assert.equal(result.candidatesWithSubjectKey, 2)
  assert.deepEqual(result.disputed, [], 'two decisions about different subjects are not a conflict')
  const statuses = store.facts(SCOPE, OWNER.type, OWNER.id).map((fact) => fact.status)
  assert.deepEqual(statuses.sort(), ['active', 'active'])
})

test('E03-07 model subject keys reach the committer: one subject with two values is disputed', async () => {
  const clock = createClock()
  const client = createFakeClient([
    chatResult(
      successContent([
        {
          text: '本阶段不部署生产',
          kind: 'decision',
          confidence: 0.95,
          evidenceSeq: 2,
          authority: 'user_confirmed',
          subjectKey: 'deploy-policy',
        },
        {
          text: '本阶段可以部署生产',
          kind: 'decision',
          confidence: 0.8,
          evidenceSeq: 2,
          authority: 'user_exploration',
          subjectKey: 'deploy-policy',
        },
      ]),
    ),
  ])
  const batch = createBatchReader(
    [batchOf([userEvent(2, '关于是否部署生产有两种说法')], { fromSeq: -1, throughSeq: 2 })],
    createCursors(),
    SCOPE,
    GENERATION,
  )
  const { extractor, store } = makeExtractor({ client, batch, clock })
  const result = await extractor.extract({ sessionId: SESSION })
  assert.equal(result.status, 'committed', JSON.stringify(result))
  assert.equal(result.disputed.length, 2, 'the same subject with different values is flagged')
  const facts = store.facts(SCOPE, OWNER.type, OWNER.id)
  assert.equal(facts.length, 2, 'both sides are kept, no silent overwrite')
  for (const fact of facts) {
    assert.equal(fact.status, 'disputed')
    assert.equal(fact.kind, 'decision', 'a conflict never rewrites kind')
  }
  assert.deepEqual(
    facts.map((fact) => fact.authority).sort(),
    ['user_confirmed', 'user_exploration'],
    'a conflict never downgrades authority',
  )
})
