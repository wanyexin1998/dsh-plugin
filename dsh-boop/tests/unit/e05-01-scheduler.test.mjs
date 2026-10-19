#!/usr/bin/env node
/**
 * E05-01 · Foreground/background scheduler + patrol + native automation units.
 *
 * Deterministic clock/timers, a scripted batch runner (no model is contacted)
 * and fake native-schedule/patrol ports. What is proven is BOOP's own policy:
 * priority order, 2s same-topic merging, single-permit serialization, foreground
 * blocking of NEW background batches, bounded retry/backoff, the extractor's
 * "two format failures stop the batch and keep the watermark" contract, exact
 * pause/resume/cancel scopes, restart with an empty queue, a read-only patrol
 * that never repairs anything, and a native-automation binding that never
 * touches user reminders.
 *
 * Run: node --test --test-force-exit tests/unit/e05-01-scheduler.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BoopScheduler,
  NativeAutomationBinding,
  NATIVE_AUTOMATION_MARKER,
  SCHEDULER_DEFAULTS,
  jobMatchesScope,
  normalizeControlScope,
} from '../../src/host/scheduler.ts'
import { runPatrol } from '../../src/host/patrol.ts'

/* ── deterministic clock ──────────────────────────────────────────────── */

function createClock() {
  let now = 1_000_000
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

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function settle(times = 8) {
  for (let i = 0; i < times; i += 1) await tick()
}

async function waitUntilIdle(scheduler, maxTicks = 3_000) {
  for (let i = 0; i < maxTicks; i += 1) {
    const status = scheduler.status()
    if (status.running === null && status.queue.total === 0) return status
    await tick()
  }
  throw new Error(`scheduler did not idle: ${JSON.stringify(scheduler.status().queue)}`)
}

/* ── scripted batch runner ────────────────────────────────────────────── */

function committed(overrides = {}) {
  return {
    status: 'committed',
    reason: null,
    version: 1,
    applied: ['fact_1'],
    halted: false,
    formatFailures: 0,
    fromSeq: -1,
    toSeq: 5,
    watermark: { before: -1, after: 5 },
    model: { providerId: 'qwen-local', modelId: 'qwen3.8-27b', attempts: [{ attempt: 1 }], elapsedMs: 4 },
    ...overrides,
  }
}

function invalidOutput(formatFailures, halted = false) {
  return {
    status: 'invalid-output',
    reason: 'EMPTY_OUTPUT',
    halted,
    formatFailures,
    watermark: { before: -1, after: -1 },
    model: { providerId: 'qwen-local', modelId: 'qwen3.8-27b', attempts: [{ attempt: 1 }], elapsedMs: 2 },
  }
}

function createRunner(script) {
  const queue = [...script]
  const calls = []
  const state = { active: 0, maxActive: 0 }
  return {
    calls,
    state,
    async run({ job, signal }) {
      calls.push({ jobId: job.id, label: job.label, scope: job.scope, priority: job.priority, at: job.enqueuedAt })
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      try {
        const step = queue.length > 1 ? queue.shift() : queue[0]
        if (typeof step === 'function') return await step({ job, signal })
        return step
      } finally {
        state.active -= 1
      }
    },
  }
}

function makeScheduler(clock, script, overrides = {}) {
  const runner = createRunner(script)
  const scheduler = new BoopScheduler({
    timers: clock.api,
    runBatch: runner.run,
    mergeWindowMs: overrides.mergeWindowMs ?? SCHEDULER_DEFAULTS.mergeWindowMs,
    maxJobAttempts: overrides.maxJobAttempts ?? 2,
    backoffBaseMs: 500,
    maxBatchesPerIdleWindow: overrides.maxBatchesPerIdleWindow ?? SCHEDULER_DEFAULTS.maxBatchesPerIdleWindow,
    onAudit: overrides.onAudit,
  })
  return { scheduler, runner }
}

/* ── 1. priority / merge / serialization ─────────────────────────────── */

test('E05-01 background priority order is P2 before P3 before P4', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed(), committed(), committed()])
  // Hold the queue while all three are submitted so ordering — not arrival —
  // decides, then release the foreground and let one drain pass run them.
  scheduler.noteUserInput()
  scheduler.submit({ priority: 'P4', label: 'history-learning', scope: { sessionId: 's4' } })
  scheduler.submit({ priority: 'P3', label: 'memory-update', scope: { sessionId: 's3' } })
  scheduler.submit({ priority: 'P2', label: 'task-result-check', scope: { taskId: 't2' } })
  await settle()
  assert.equal(runner.calls.length, 0)
  scheduler.noteForegroundIdle()
  await waitUntilIdle(scheduler)
  assert.deepEqual(
    runner.calls.map((call) => call.label),
    ['task-result-check', 'memory-update', 'history-learning'],
    'lower rank number runs first; FIFO inside one priority',
  )
})

test('E05-01 same-topic events merge after the 2s idle window into ONE batch', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed()])
  const first = scheduler.submit({ priority: 'P3', label: 'memory', topicKey: 'session:a', scope: { sessionId: 'a' } })
  const second = scheduler.submit({ priority: 'P3', label: 'memory', topicKey: 'session:a', scope: { sessionId: 'a' } })
  const third = scheduler.submit({ priority: 'P3', label: 'memory', topicKey: 'session:a', scope: { sessionId: 'a' } })
  assert.equal(first.accepted && first.merged, true)
  assert.equal(second.merged, true)
  assert.equal(third.merged, true)
  await settle()
  assert.equal(runner.calls.length, 0, 'nothing runs before the merge window closes')

  clock.advance(2_000)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 1, 'three events produced ONE batch')
  const status = scheduler.status()
  assert.equal(status.recent[0].topicKey, 'session:a')
  assert.equal(status.counters.merged, 2, 'two events were coalesced into the first one')
  assert.equal(status.counters.enqueued, 1)
})

test('E05-01 different topics never merge and the single permit serializes batches', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed(), committed()])
  scheduler.submit({ priority: 'P3', label: 'a', topicKey: 'session:a', scope: { sessionId: 'a' } })
  scheduler.submit({ priority: 'P3', label: 'b', topicKey: 'session:b', scope: { sessionId: 'b' } })
  clock.advance(2_000)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 2)
  assert.equal(runner.state.maxActive, 1, 'no two background batches overlap')
  const status = scheduler.status()
  assert.equal(status.permits.active, 0)
  assert.equal(status.permits.note.includes('one BOOP-wide model permit'), true)
})

/* ── 2. P1 foreground blocking ────────────────────────────────────────── */

test('E05-01 user input blocks NEW background batches until the foreground goes idle', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed()])
  scheduler.noteUserInput()
  scheduler.submit({ priority: 'P3', label: 'memory', scope: { sessionId: 'a' } })
  await settle()
  assert.equal(runner.calls.length, 0, 'no new background batch starts while the user speaks')
  assert.equal(scheduler.status().queue.total, 1)
  assert.equal(scheduler.status().foreground.active, true)

  scheduler.noteForegroundIdle()
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 1, 'idle again → the queued background batch runs')
  assert.equal(scheduler.status().foreground.active, false)
})

test('E05-01 an in-flight batch pauses at its safe boundary and is not claimed as preempted', async () => {
  const clock = createClock()
  let release = null
  const { scheduler, runner } = makeScheduler(clock, [
    ({ signal }) =>
      new Promise((resolve, reject) => {
        release = () => resolve(committed())
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    committed(),
  ])
  scheduler.submit({ priority: 'P3', label: 'first', scope: { sessionId: 'a' } })
  await settle()
  assert.equal(runner.calls.length, 1)
  scheduler.noteUserInput()
  assert.equal(scheduler.status().running.pauseAfter, true, 'the running batch is marked pause-after')
  release()
  await settle()
  scheduler.submit({ priority: 'P3', label: 'second', scope: { sessionId: 'b' } })
  await settle()
  assert.equal(runner.calls.length, 1, 'the next background batch does not start in foreground')
  scheduler.noteForegroundIdle()
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 2)
  assert.equal(scheduler.status().recent.length >= 2, true)
})

/* ── 3. batch limits, retries, format-failure stop ───────────────────── */

test('E05-01 one idle window runs a bounded number of batches, not an unbounded loop', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed(), committed(), committed()], {
    maxBatchesPerIdleWindow: 2,
  })
  scheduler.submit({ priority: 'P3', label: 'a', scope: { sessionId: 'a' } })
  scheduler.submit({ priority: 'P3', label: 'b', scope: { sessionId: 'b' } })
  scheduler.submit({ priority: 'P3', label: 'c', scope: { sessionId: 'c' } })
  await settle(12)
  assert.equal(runner.calls.length, 2, 'the idle window stopped after two batches')
  assert.equal(scheduler.status().queue.total, 1, 'the third batch waits for a new window')
  clock.advance(2_000)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 3)
})

test('E05-01 transport failures retry once with backoff, then drop honestly', async () => {
  const clock = createClock()
  const unavailable = { status: 'unavailable', reason: 'MODEL_UNAVAILABLE: unreachable' }
  const { scheduler, runner } = makeScheduler(clock, [unavailable])
  scheduler.submit({ priority: 'P3', label: 'memory', scope: { sessionId: 'a' } })
  await settle()
  assert.equal(runner.calls.length, 1)
  const queued = scheduler.status().queue.items
  assert.equal(queued.length, 1)
  assert.notEqual(queued[0].availableAt, null, 'a retry waits for the backoff window')
  assert.equal(scheduler.status().counters.retried, 1)

  clock.advance(500)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 2, 'one original attempt + one backoff retry')
  assert.equal(scheduler.status().counters.dropped, 1)
  assert.equal(scheduler.status().recent.at(-1).reason, 'MODEL_UNAVAILABLE: unreachable')
})

test('E05-01 a soft-timeout batch backs off and a later attempt may commit', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [
    { status: 'timeout', reason: 'SOFT_TIMEOUT', watermark: { before: 3, after: 3 } },
    committed({ watermark: { before: 3, after: 8 } }),
  ])
  scheduler.submit({ priority: 'P3', label: 'memory', scope: { sessionId: 'a' } })
  await settle()
  clock.advance(500)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 2)
  const recent = scheduler.status().recent
  assert.equal(recent[0].status, 'timeout')
  assert.equal(recent[1].status, 'committed')
  assert.deepEqual(recent[1].watermark, { before: 3, after: 8 })
})

test('E05-01 two consecutive format failures stop the batch and preserve the watermark', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [invalidOutput(1, false), invalidOutput(2, true)])
  scheduler.submit({ priority: 'P3', label: 'memory', scope: { sessionId: 'a' } })
  await settle()
  clock.advance(500)
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 2)
  const status = scheduler.status()
  assert.equal(status.recent.at(-1).halted, true)
  assert.equal(status.recent.at(-1).formatFailures, 2)
  assert.equal(status.counters.dropped, 1, 'a halted batch is not retried forever')
  assert.equal(status.queue.total, 0, 'the batch is stopped, not silently advanced')
  assert.deepEqual(status.recent.at(-1).watermark, { before: -1, after: -1 }, 'watermark preserved')
})

test('E05-01 a completed batch never re-enqueues itself (no self-wake loop)', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed()])
  scheduler.submit({ priority: 'P3', label: 'memory', scope: { sessionId: 'a' } })
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 1)
  assert.equal(scheduler.status().counters.enqueued, 1)
  await scheduler.drain()
  await settle()
  assert.equal(runner.calls.length, 1, 'an idle drain neither wakes nor re-enqueues anything')
})

/* ── 4. deterministic control entries ────────────────────────────────── */

test('E05-01 pause is scope-exact and only clears matching queued work', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed(), committed()])
  scheduler.noteUserInput() // hold the queue so nothing runs during the test
  const a1 = scheduler.submit({ priority: 'P3', label: 'a1', scope: { sessionId: 'a' } })
  const a2 = scheduler.submit({ priority: 'P4', label: 'a2', scope: { sessionId: 'a' } })
  const b1 = scheduler.submit({ priority: 'P3', label: 'b1', scope: { sessionId: 'b' } })
  const paused = scheduler.pause({ kind: 'session', id: 'a' })
  assert.equal(paused.ok, true)
  assert.deepEqual(paused.queuedRemoved.sort(), [a1.jobId, a2.jobId].sort())
  assert.equal(paused.stillRunning.length, 0)
  assert.equal(scheduler.status().queue.total, 1, 'session b work is untouched')
  assert.equal(scheduler.status().queue.items[0].jobId, b1.jobId)
  assert.deepEqual(scheduler.status().paused.scopes, [{ kind: 'session', id: 'a' }])

  const blocked = scheduler.submit({ priority: 'P3', label: 'a3', scope: { sessionId: 'a' } })
  assert.equal(blocked.accepted, false)
  assert.equal(blocked.code, 'SCOPE_PAUSED:session:a')

  scheduler.noteForegroundIdle()
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 1, 'only the unpaused work ran')
  assert.equal(runner.calls[0].scope.sessionId, 'b')

  const resumed = scheduler.resume({ kind: 'session', id: 'a' })
  assert.equal(resumed.ok, true)
  assert.equal(scheduler.status().paused.scopes.length, 0)
})

test('E05-01 pause-all holds every background scope and resume releases it', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [committed()])
  scheduler.noteUserInput()
  scheduler.submit({ priority: 'P3', label: 'a', scope: { sessionId: 'a' } })
  const paused = scheduler.pause({ kind: 'all' })
  assert.equal(paused.queuedRemoved.length, 1)
  assert.equal(scheduler.status().paused.all, true)
  scheduler.noteForegroundIdle()
  await settle()
  assert.equal(runner.calls.length, 0, 'paused background never runs even when idle')
  scheduler.resume({ kind: 'all' })
  await waitUntilIdle(scheduler)
  assert.equal(runner.calls.length, 0, 'removed work is not resurrected by resume')
})

test('E05-01 cancel aborts the in-flight client request and never claims a server stop', async () => {
  const clock = createClock()
  const { scheduler, runner } = makeScheduler(clock, [
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('client aborted')), { once: true })
      }),
    committed(),
  ])
  scheduler.submit({ priority: 'P3', label: 'running', scope: { sessionId: 'a' } })
  await settle()
  assert.equal(runner.calls.length, 1)
  const cancelled = scheduler.cancel({ kind: 'session', id: 'a' })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.abortRequested.length, 1)
  assert.match(cancelled.note, /server-side release is not claimed/u)
  await waitUntilIdle(scheduler)
  assert.equal(scheduler.status().recent.at(-1).status, 'cancelled')
  assert.equal(scheduler.status().counters.cancelled, 1)
})

test('E05-01 invalid control scopes are refused, never guessed', () => {
  assert.equal(normalizeControlScope('bogus'), null)
  assert.equal(normalizeControlScope({ kind: 'session' }), null, 'session scope needs an exact id')
  assert.deepEqual(normalizeControlScope('all'), { kind: 'all' })
  assert.deepEqual(normalizeControlScope({ scope: { kind: 'task', id: 't1' } }), { kind: 'task', id: 't1' })
  assert.deepEqual(normalizeControlScope({ kind: 'action', id: 'a1' }), { kind: 'action', id: 'a1' })

  const clock = createClock()
  const { scheduler } = makeScheduler(clock, [committed()])
  const result = scheduler.pause({ kind: 'nope' })
  assert.equal(result.ok, true, 'the scheduler core assumes a normalised scope')
  assert.equal(result.changed, false)
})

test('E05-01 job scope matching is exact by id, all matches everything', () => {
  const job = { scope: { sessionId: 's1', taskId: 't1', actionId: 'a1' } }
  assert.equal(jobMatchesScope(job, { kind: 'all' }), true)
  assert.equal(jobMatchesScope(job, { kind: 'session', id: 's1' }), true)
  assert.equal(jobMatchesScope(job, { kind: 'session', id: 's2' }), false)
  assert.equal(jobMatchesScope(job, { kind: 'task', id: 't1' }), true)
  assert.equal(jobMatchesScope(job, { kind: 'task', id: 't2' }), false)
  assert.equal(jobMatchesScope(job, { kind: 'action', id: 'a1' }), true)
  assert.equal(jobMatchesScope(job, { kind: 'action', id: 'a2' }), false)
  assert.equal(jobMatchesScope(job, { kind: 'task' }), false, 'a missing id never matches')
})

test('E05-01 a restart starts from an empty queue and never replays old background work', async () => {
  const clock = createClock()
  const first = makeScheduler(clock, [committed()], {})
  first.scheduler.noteUserInput()
  first.scheduler.submit({ priority: 'P3', label: 'old', scope: { sessionId: 'a' } })
  assert.equal(first.scheduler.status().queue.total, 1)

  // A new process owns a new in-memory scheduler: nothing is persisted or replayed.
  const second = makeScheduler(clock, [committed()], {})
  assert.equal(second.scheduler.status().queue.total, 0)
  assert.deepEqual(second.scheduler.status().counters, {
    enqueued: 0,
    merged: 0,
    started: 0,
    completed: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    dropped: 0,
  })
  await second.scheduler.drain()
  await settle()
  assert.equal(second.runner.calls.length, 0, 'a restart never runs old background work')
})

/* ── 5. patrol ───────────────────────────────────────────────────────── */

function patrolPorts(overrides = {}) {
  const base = {
    now: () => 1_000_000,
    lease: () => ({ held: true, holder: 'dsh@1', fencingToken: 2, released: false }),
    cursors: () => [
      { sessionId: 's1', sourceGeneration: 'g1', throughSeq: 4, state: 'dirty' },
      { sessionId: 's2', sourceGeneration: 'g2', throughSeq: 8, state: 'gap' },
    ],
    approvals: () => ({
      total: 2,
      pending: 2,
      expiredPending: 1,
      examples: [{ id: 'ap1', status: 'pending', expiresAt: '2026-01-01T00:00:00.000Z' }],
    }),
    outbox: () => ({
      unknown: 1,
      sending: 0,
      blocked: 0,
      prepared: 0,
      examples: [{ actionId: 'act1', state: 'unknown' }],
    }),
    gate: () => ({
      armed: true,
      entries: 1,
      blocked: 1,
      released: 0,
      examples: [{ messageId: 'msg1', actionId: 'act1', sessionId: 's1', state: 'blocked' }],
    }),
    native: () => ({
      schemaVersion: 1,
      state: 'bound',
      available: true,
      service: 'schedule',
      marker: NATIVE_AUTOMATION_MARKER,
      sessionId: 'boop-main',
      taskId: 'schedule-1',
      title: NATIVE_AUTOMATION_MARKER,
      kind: 'daily',
      scheduledAt: '2026-10-19T01:00:00.000Z',
      lastError: null,
      note: 'bound',
    }),
    modelRoute: () => ({ providerId: 'qwen-local', modelId: 'qwen3.8-27b' }),
    writeMode: () => ({ enabled: false, blockedByGates: ['G03', 'G04'] }),
  }
  return { ...base, ...overrides }
}

test('E05-01 patrol is read-only: it reports facts and alerts without repairing anything', () => {
  const facts = runPatrol(patrolPorts())
  assert.equal(facts.readOnly, true)
  assert.equal(facts.modelCalls, 0, 'patrol never calls a model')
  assert.equal(facts.writeMode.value.enabled, false)
  assert.equal(facts.lease.value.held, true)
  assert.equal(facts.cursors.value.gap, 1)
  assert.equal(facts.approvals.value.expiredPending, 1)
  assert.equal(facts.outbox.value.unknown, 1)
  assert.equal(facts.gate.value.blocked, 1)
  const codes = facts.alerts.map((entry) => entry.code)
  for (const code of ['APPROVAL_EXPIRED_PENDING', 'UNKNOWN_OUTBOX', 'GATE_PENDING_RELEASE', 'MEMORY_COVERAGE_GAP', 'MEMORY_BEHIND']) {
    assert.ok(codes.includes(code), `patrol must alert ${code}: ${JSON.stringify(codes)}`)
  }
  assert.deepEqual(facts.notDone, [
    'no business action was executed',
    'no recovery was performed automatically (the recovery gate needs an explicit human release)',
    'no model was called',
    'no watermark, cursor or outbox row was advanced',
  ])
  assert.ok(facts.alerts.findIndex((entry) => entry.severity === 'warn') < facts.alerts.findIndex((entry) => entry.severity === 'info'))
})

test('E05-01 patrol reports every unreadable plane as unavailable, never as empty and healthy', () => {
  const facts = runPatrol(
    patrolPorts({
      lease: () => null,
      cursors: () => null,
      approvals: () => null,
      outbox: () => null,
      gate: () => null,
      native: () => null,
      modelRoute: () => null,
      writeMode: () => null,
    }),
  )
  for (const plane of [facts.lease, facts.cursors, facts.approvals, facts.outbox, facts.gate, facts.native, facts.modelRoute, facts.writeMode]) {
    assert.equal(plane.available, false)
    assert.notEqual(plane.reason, null)
  }
  const codes = facts.alerts.map((entry) => entry.code)
  for (const code of [
    'STORAGE_UNAVAILABLE',
    'PLANE_UNAVAILABLE',
    'NATIVE_SCHEDULE_UNAVAILABLE',
    'MODEL_ROUTE_MISSING',
  ]) {
    assert.ok(codes.includes(code), `missing ${code}: ${JSON.stringify(codes)}`)
  }
})

test('E05-01 patrol treats an unarmed recovery gate as a blocking alert and a lost lease as a warning', () => {
  const facts = runPatrol(
    patrolPorts({
      gate: () => ({ armed: false, entries: 0, blocked: 0, released: 0, examples: [] }),
      lease: () => ({ held: false, holder: 'other@2', fencingToken: 5, released: false }),
    }),
  )
  assert.equal(facts.alerts[0].severity, 'blocking')
  assert.equal(facts.alerts[0].code, 'GATE_NOT_ARMED')
  assert.ok(facts.alerts.some((entry) => entry.code === 'LEASE_NOT_HELD'))
})

test('E05-01 patrol keeps a failed native binding visible and does not pretend it is unavailable or bound', () => {
  const facts = runPatrol(
    patrolPorts({
      native: () => ({
        schemaVersion: 1,
        state: 'failed',
        available: true,
        service: 'schedule',
        marker: NATIVE_AUTOMATION_MARKER,
        sessionId: 'boop-main',
        taskId: null,
        title: null,
        kind: null,
        scheduledAt: null,
        lastError: 'storage refused',
        note: 'binding failed',
      }),
    }),
  )
  const alert = facts.alerts.find((entry) => entry.code === 'NATIVE_SCHEDULE_FAILED')
  assert.ok(alert)
  assert.equal(alert.severity, 'warn')
  assert.equal(alert.detail, 'storage refused')
})

/* ── 6. native automation binding ────────────────────────────────────── */

function fakeSchedulePort(overrides = {}) {
  const tasks = overrides.tasks ?? []
  const calls = { create: [], delete: [], list: 0 }
  let nextId = 0
  return {
    tasks,
    calls,
    available: () => overrides.available !== false,
    async create(sessionId, request) {
      calls.create.push({ sessionId, request })
      if (overrides.createThrows === true) throw new Error('schedule refused')
      const task = {
        id: `schedule-${++nextId}`,
        title: request.title,
        kind: 'daily',
        scheduledAt: '2026-10-19T01:00:00.000Z',
        state: 'active',
      }
      tasks.push(task)
      return task
    },
    async delete(request) {
      calls.delete.push(request)
      if (overrides.deleteRefuses === true) return { code: 'schedule_conflict' }
      const index = tasks.findIndex((task) => task.id === request.id)
      if (index >= 0) tasks.splice(index, 1)
      return { id: request.id, deleted: true }
    },
    async list() {
      calls.list += 1
      return tasks.map((task) => ({ ...task }))
    },
  }
}

test('E05-01 native automation is explicitly unavailable when no schedule service is mounted', async () => {
  const binding = new NativeAutomationBinding({ port: null, sessionId: () => 'boop-main' })
  const status = binding.status()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.available, false)
  assert.match(status.note, /not mounted/u)
  const bound = await binding.bind()
  assert.equal(bound.state, 'unavailable', 'BOOP never fakes a side-channel timer')
})

test('E05-01 native automation waits for the BOOP main Session identity instead of creating one', async () => {
  const port = fakeSchedulePort()
  const binding = new NativeAutomationBinding({ port, sessionId: () => null })
  const status = await binding.bind()
  assert.equal(status.state, 'pending-session')
  assert.equal(port.calls.create.length, 0, 'no hidden Session and no hidden task')
})

test('E05-01 native automation adopts an existing BOOP task instead of duplicating it', async () => {
  const port = fakeSchedulePort({ tasks: [{ id: 'schedule-existing', title: NATIVE_AUTOMATION_MARKER, kind: 'daily' }] })
  const binding = new NativeAutomationBinding({ port, sessionId: () => 'boop-main' })
  const status = await binding.bind()
  assert.equal(status.state, 'bound')
  assert.equal(status.taskId, 'schedule-existing')
  assert.equal(port.calls.create.length, 0, 'no duplicate reminder was created')
})

test('E05-01 native automation creates one daily task and unbind deletes ONLY that task', async () => {
  const userTask = { id: 'schedule-user', title: '我的日程提醒', kind: 'daily' }
  const port = fakeSchedulePort({ tasks: [userTask] })
  const binding = new NativeAutomationBinding({ port, sessionId: () => 'boop-main', dailyTime: '09:00:00', timeZone: 'Asia/Shanghai' })
  const status = await binding.bind()
  assert.equal(status.state, 'bound')
  assert.equal(port.calls.create.length, 1)
  assert.equal(port.calls.create[0].sessionId, 'boop-main')
  assert.deepEqual(port.calls.create[0].request.daily, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  assert.equal(port.calls.create[0].request.title, NATIVE_AUTOMATION_MARKER)

  const unbound = await binding.unbind()
  assert.equal(unbound.state, 'unbound')
  assert.deepEqual(port.calls.delete, [{ sessionId: 'boop-main', id: status.taskId }])
  assert.equal(port.calls.delete[0].id === 'schedule-user', false, 'a user-owned reminder is never deleted')
  assert.deepEqual(port.tasks.map((task) => task.id), ['schedule-user'])
})

test('E05-01 unbind refuses to delete a task whose title no longer matches the BOOP marker', async () => {
  const port = fakeSchedulePort({ tasks: [{ id: 'schedule-1', title: NATIVE_AUTOMATION_MARKER, kind: 'daily' }] })
  const binding = new NativeAutomationBinding({ port, sessionId: () => 'boop-main' })
  await binding.bind()
  port.tasks[0].title = '用户改过的标题'
  const status = await binding.unbind()
  assert.equal(status.state, 'unbound')
  assert.equal(port.calls.delete.length, 0, 'an edited/taken-over task is not deleted by BOOP')
  assert.match(status.note, /already absent/u)
})

test('E05-01 a failing native schedule reports failed, never a fabricated bound state', async () => {
  const port = fakeSchedulePort({ createThrows: true })
  const binding = new NativeAutomationBinding({ port, sessionId: () => 'boop-main' })
  const status = await binding.bind()
  assert.equal(status.state, 'failed')
  assert.equal(status.lastError, 'schedule refused')
  assert.equal(status.taskId, null)
})

test('E05-01 a native delete refusal keeps the binding honest instead of claiming success', async () => {
  const port = fakeSchedulePort({ deleteRefuses: true })
  const binding = new NativeAutomationBinding({ port, sessionId: () => 'boop-main' })
  await binding.bind()
  const status = await binding.unbind()
  assert.equal(status.state, 'failed')
  assert.equal(status.lastError, 'schedule_conflict')
  assert.match(status.note, /may still be registered/u)
})
