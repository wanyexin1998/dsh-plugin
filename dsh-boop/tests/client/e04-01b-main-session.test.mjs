#!/usr/bin/env node
/**
 * E04-01 batch 2 · main-Session navigation policy (FE-02 / FE-05 / AT-01).
 *
 * Renders nothing here: this suite drives the real navigation policy module
 * (built by build.mjs into lib/main-session.test.bundle.cjs) against fake client
 * services, so the following rules are proven without a browser:
 *  - the host's durable identity is used; an unavailable host plane degrades
 *    honestly and never claims a bound identity;
 *  - the first click creates the named Session through the native client
 *    session service, then opens it via native Conversation navigation;
 *  - a repeated click locates the SAME id from the catalog and creates nothing
 *    (FE-02), even while the catalog refresh is failing/offline;
 *  - an identity conflict (Host minted a different Session for the named id) is
 *    surfaced and does not mint a third Session on the next click;
 *  - navigation failures are reported as failures, never as success.
 *
 * Run: node --test --test-force-exit tests/client/e04-01b-main-session.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAIN_SESSION_ID,
  createMainSessionStore,
  isMainSession,
  mainSessionReasonText,
  mainSessionStatusLine,
  openMainSession,
  readCachedMainSessionId,
  resolveMainSessionIdentity,
  writeCachedMainSessionId,
} from '../../lib/main-session.test.bundle.cjs'

/** Minimal in-memory native-client surface the policy talks to. */
function makeServices({ rows = [], refreshError = null } = {}) {
  const catalog = new Map(rows.map((row) => [row, { id: row, blank: true }]))
  const created = []
  const opened = []
  const sessions = {
    list: { getSnapshot: () => ({ byId: Object.fromEntries(catalog), ids: [...catalog.keys()], phase: 'ready' }) },
    refresh: async () => {
      if (refreshError) throw refreshError
      return undefined
    },
    create: async (request) => {
      created.push(request)
      const id = request.sessionId
      catalog.set(id, { id, blank: true })
      return id
    },
  }
  const uiWorkspace = {
    openSession: (id) => {
      opened.push(id)
    },
  }
  return { sessions, uiWorkspace, created, opened, catalog }
}

function hostCall(facts) {
  const calls = []
  const call = async (endpoint, args) => {
    calls.push({ endpoint, args })
    if (endpoint === 'boop/mainSession') return { ok: true, value: facts }
    return { ok: false, error: { message: `unexpected endpoint ${endpoint}` } }
  }
  return { call, calls }
}

const BOUND = {
  schemaVersion: 1,
  state: 'bound',
  mainSessionId: MAIN_SESSION_ID,
  scopeId: 'boop-abc123',
  writable: true,
  durable: true,
  reason: null,
  storage: { ok: true, path: '/tmp/x/boop.sqlite', scopeId: 'boop-abc123', leaseHeld: true },
}

test('E04-01 first click opens the named Session through native navigation and creates it once', async () => {
  const services = makeServices()
  const { call, calls } = hostCall(BOUND)
  const store = createMainSessionStore()
  const outcome = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal(outcome.sessionId, MAIN_SESSION_ID)
  assert.equal(outcome.created, true)
  assert.deepEqual(services.created, [{ sessionId: MAIN_SESSION_ID }], 'one native create, by the exact id')
  assert.deepEqual(services.opened, [MAIN_SESSION_ID], 'opened by the native Conversation navigation')
  assert.deepEqual(calls.map((entry) => entry.endpoint), ['boop/mainSession'])
  const state = store.getSnapshot()
  assert.equal(state.mainSessionId, MAIN_SESSION_ID)
  assert.equal(state.activeSessionId, MAIN_SESSION_ID)
  assert.equal(state.phase, 'ready')
})

test('E04-01 repeated click locates the same Session and creates nothing (FE-02)', async () => {
  const services = makeServices()
  const { call } = hostCall(BOUND)
  const store = createMainSessionStore()
  await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  const second = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(second.sessionId, MAIN_SESSION_ID)
  assert.equal(services.created.length, 1, 'no second creation on repeat')
  assert.deepEqual(services.opened, [MAIN_SESSION_ID, MAIN_SESSION_ID], 'same exact Session opened twice')
})

test('E04-01 an offline catalog refresh does not mint a duplicate Session', async () => {
  const services = makeServices({ rows: [MAIN_SESSION_ID], refreshError: new Error('connection reset') })
  const { call } = hostCall(BOUND)
  const store = createMainSessionStore()
  const outcome = await openMainSession({
    call,
    store,
    sessions: services.sessions,
    uiWorkspace: services.uiWorkspace,
    catalogWaitMs: 5,
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.created, false, 'the cached catalog still located the Session')
  assert.equal(services.created.length, 0)
})

test('E04-01 a host identity plane failure degrades honestly to the fallback id', async () => {
  const store = createMainSessionStore()
  const resolution = await resolveMainSessionIdentity({
    call: async () => ({ ok: false, error: { message: 'connection refused' } }),
    store,
  })
  assert.equal(resolution.degraded, true)
  assert.equal(resolution.mainSessionId, MAIN_SESSION_ID)
  assert.equal(resolution.host, null)
  const state = store.getSnapshot()
  assert.equal(state.phase, 'degraded')
  assert.match(state.error ?? '', /connection refused/)
  const status = mainSessionStatusLine(state)
  assert.equal(status.tone, 'warn')
  assert.notEqual(status.text, '已连接', 'a fallback identity must never read as connected')
})

test('E04-01 the host storage-unavailable answer is reported, not hidden', async () => {
  const store = createMainSessionStore()
  const resolution = await resolveMainSessionIdentity({
    call: async () => ({
      ok: true,
      value: {
        schemaVersion: 1,
        state: 'unavailable',
        mainSessionId: MAIN_SESSION_ID,
        scopeId: 'boop-abc123',
        writable: false,
        durable: false,
        reason: 'read-only-ledger',
        storage: { ok: false, path: '/x', scopeId: 'boop-abc123', leaseHeld: false },
      },
    }),
    store,
  })
  assert.equal(resolution.degraded, true)
  assert.equal(resolution.mainSessionId, MAIN_SESSION_ID)
  const status = mainSessionStatusLine(store.getSnapshot())
  assert.equal(status.tone, 'warn')
  assert.match(status.text, /未持久绑定/)
  assert.match(mainSessionReasonText('read-only-ledger') ?? '', /另一个 BOOP 进程/)
})

test('E04-01 a catalog-plus-create failure is a failure, never a silent success', async () => {
  const services = makeServices()
  services.sessions.create = async () => {
    throw new Error('session/conflict: named session belongs to another directory')
  }
  const { call } = hostCall(BOUND)
  const store = createMainSessionStore()
  const outcome = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'session-create-failed')
  assert.match(outcome.message, /session\/conflict/)
  assert.equal(services.opened.length, 0)
})

test('E04-01 a navigation throw is reported as open-failed', async () => {
  const services = makeServices({ rows: [MAIN_SESSION_ID] })
  services.uiWorkspace.openSession = () => {
    throw new Error('sessions.retain: unknown session')
  }
  const { call } = hostCall(BOUND)
  const store = createMainSessionStore()
  const outcome = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'open-failed')
})

test('E04-01 a Host-minted identity conflict is surfaced and does not mint a third Session', async () => {
  const services = makeServices()
  services.sessions.create = async (request) => {
    // The named Session had already started: the native surface mints a new id.
    const minted = `session-minted-${services.created.length + 1}`
    services.created.push(request)
    services.catalog.set(minted, { id: minted, blank: false })
    return minted
  }
  const { call } = hostCall(BOUND)
  const store = createMainSessionStore()
  const first = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(first.ok, true)
  assert.equal(first.identityConflict, true)
  assert.equal(first.sessionId, 'session-minted-1')
  assert.equal(store.getSnapshot().phase, 'degraded')

  const second = await openMainSession({ call, store, sessions: services.sessions, uiWorkspace: services.uiWorkspace })
  assert.equal(second.ok, true)
  assert.equal(second.created, false, 'the second click must not mint another Session')
  assert.equal(second.sessionId, 'session-minted-1')
  assert.equal(services.created.length, 1)
})

test('E04-01 only the exact main Session is decorated; ordinary Sessions are untouched (FE-01)', () => {
  assert.equal(isMainSession(MAIN_SESSION_ID, MAIN_SESSION_ID), true)
  assert.equal(isMainSession(MAIN_SESSION_ID, 'session-ordinary'), false)
  assert.equal(isMainSession(null, MAIN_SESSION_ID), false)
  assert.equal(isMainSession(undefined, undefined), false)
})

test('E04-01 the decoration hint cache round-trips and tolerates a throwing storage', () => {
  const map = new Map()
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }
  assert.equal(readCachedMainSessionId(storage), null)
  writeCachedMainSessionId(MAIN_SESSION_ID, storage)
  assert.equal(readCachedMainSessionId(storage), MAIN_SESSION_ID)
  const throwing = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
  }
  assert.equal(readCachedMainSessionId(throwing), null)
  writeCachedMainSessionId('x', throwing) // must not throw
})
