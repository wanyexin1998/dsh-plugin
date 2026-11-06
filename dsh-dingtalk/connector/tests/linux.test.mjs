import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmod, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  artifactAvailable,
  adminRequest,
  adminToken,
  browserFlow,
  businessRequest,
  connectorEnv,
  dwsBinary,
  dwsLock,
  dwsVersion,
  freePort,
  freePortExcept,
  rmState,
  syntheticServer,
  tmpState,
  writeMcpUrl,
} from './fixtures/harness.mjs'

const skip = !artifactAvailable || process.platform !== 'linux'
const fakeDws = join(import.meta.dirname, 'fixtures', 'fake-dws.mjs')
const connector = await import('../lib/connector.mjs')
const remote = await import('../../enhancements/lib/adapters/remote/index.js')
const serviceModule = await import('../../enhancements/lib/shared/service.js')
const { DEFAULT_LIMITS } = await import('../../enhancements/lib/shared/config.js')

async function startConnector(env) {
  const server = new connector.ConnectorServer(connector.parseConnectorConfig(env))
  await server.start()
  return server
}
async function bind(env, callerId, corpId, userId) {
  const result = await adminRequest(env, '/admin/v1/test-identity', { callerId, corpId, userId })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  await writeMcpUrl(env.DSH_CONNECTOR_STATE_DIR, callerId, env.__base)
}
async function remoteFor(env, callerId, limits = DEFAULT_LIMITS) {
  return remote.createRemoteConnection(
    {
      endpoint: { socketPath: join(env.DSH_CONNECTOR_STATE_DIR, 'sockets', callerId, 'dsh.sock') },
      trustedOrigins: ['https://dsh.example.test'],
      testTransport: false,
    },
    limits,
  )
}
async function prepare(connection) {
  return connection.ui('browser', { origin: 'https://dsh.example.test', returnPath: '/chat' }, async () => {
    connection.prepareStart()
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = connection.prepareStatus()
      if (state.state === 'ready') return state
      if (state.state === 'failed') throw new Error(`prepare failed: ${state.reasonCode}`)
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('prepare timeout')
  })
}
async function authorize(service, connection, env) {
  return connection.ui('browser', { origin: 'https://dsh.example.test', returnPath: '/chat' }, async () => {
    const start = await service.beginAuthorization({ sessionRef: 's1' })
    const flow = await browserFlow(env, start.authorizeUrl)
    assert.equal(flow.callback.status, 200)
    for (let attempt = 0; attempt < 400; attempt++) {
      const status = await service.getAuthorizationStatus(start.transactionId)
      if (status.state !== 'authorizing') return status
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error('authorization timeout')
  })
}
async function fakeEnv(overrides = {}) {
  await chmod(fakeDws, 0o755)
  const synthetic = await syntheticServer()
  const isolated = tmpState()
  const oauthPort = await freePortExcept(await freePort())
  const env = connectorEnv({
    synthetic,
    stateDir: isolated.stateDir,
    port: 0,
    oauthPort,
    transport: 'unix',
    extra: { DSH_CONNECTOR_TEST_DWS_BINARY: fakeDws, ...overrides },
  })
  env.__base = synthetic.base
  return { synthetic, isolated, env }
}
test('pinned linux-amd64 DWS artifact matches the lock and runs', { skip }, async () => {
  const lock = JSON.parse(await readFile(dwsLock, 'utf8'))
  const expected = lock.dws.binaryChecksums['linux-x64']
  const bytes = await readFile(dwsBinary)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected)
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46')
  assert.equal(bytes[4], 2)
  assert.equal(bytes[5], 1)
  assert.equal(bytes.readUInt16LE(18), 0x3e)
  assert.equal(lock.dws.version, '1.0.66')
  assert.equal(lock.dws.commit, 'f215043e676d6889e1ddce3464828d8b1ec40c31')
  const version = dwsVersion()
  assert.match(version, /^dws version v1\.0\.66 \(f215043e676d6889e1ddce3464828d8b1ec40c31,/)
  assert.equal((await stat(dwsBinary)).mode & 0o111, 0o111)
})
test(
  'linux unix-socket connector: two callers stay isolated through authorization, invoke, revoke and restart',
  { skip, timeout: 300000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv()
    let server
    let ownerA
    let ownerB
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      await bind(env, 'caller-b', 'test-corp', 'test-user-b')
      // Private filesystem shape: 0700 caller socket directories, 0600 sockets, no capability tokens on the unix transport.
      const socketsDirectory = join(isolated.stateDir, 'sockets')
      assert.equal((await stat(socketsDirectory)).mode & 0o777, 0o700)
      for (const callerId of ['caller-a', 'caller-b']) {
        assert.equal((await stat(join(socketsDirectory, callerId))).mode & 0o777, 0o700)
        assert.equal((await stat(join(socketsDirectory, callerId, 'dsh.sock'))).mode & 0o777, 0o600)
        assert.equal((await stat(join(isolated.stateDir, 'callers', callerId))).mode & 0o777, 0o700)
        assert.equal((await stat(join(isolated.stateDir, 'callers', callerId, 'dws'))).mode & 0o777, 0o700)
      }
      const a = await remoteFor(env, 'caller-a')
      const b = await remoteFor(env, 'caller-b')
      ownerA = serviceModule.createConnectionService(a.backend)
      ownerB = serviceModule.createConnectionService(b.backend)
      assert.equal((await ownerA.service.status()).state, 'unlinked')
      assert.equal((await ownerB.service.status()).state, 'unlinked')
      assert.equal((await ownerA.service.invoke({ operationId: 'identity.getSelf', args: {} })).status, 'auth_required')
      await prepare(a)
      await prepare(b)
      const authorizedA = await authorize(ownerA.service, a, env)
      assert.equal(authorizedA.state, 'connected', JSON.stringify(authorizedA))
      const authorizedB = await authorize(ownerB.service, b, env)
      assert.equal(authorizedB.state, 'connected', JSON.stringify(authorizedB))
      assert.equal((await ownerA.service.status()).state, 'connected')
      assert.equal((await ownerB.service.status()).state, 'connected')
      assert.deepEqual(a.identity(), { corpId: 'test-corp', userId: 'test-user-a' })
      assert.deepEqual(b.identity(), { corpId: 'test-corp', userId: 'test-user-b' })
      const selfA = await ownerA.service.invoke({ operationId: 'identity.getSelf', args: {} })
      const selfB = await ownerB.service.invoke({ operationId: 'identity.getSelf', args: {} })
      assert.equal(selfA.status, 'ok')
      assert.equal(selfB.status, 'ok')
      assert.equal(JSON.stringify(selfA.data).includes('test-user-a'), true)
      assert.equal(JSON.stringify(selfB.data).includes('test-user-b'), true)
      assert.equal(
        (await ownerA.service.invoke({ operationId: 'calendar.listEvents', args: { limit: 5 } })).status,
        'ok',
      )
      assert.equal(
        (await ownerA.service.invoke({ operationId: 'docs.search', args: { query: '合成', limit: 5 } })).status,
        'ok',
      )
      // Credentials stay on the private volume; business responses never contain them.
      const profileState = await readFile(
        join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'profiles.json'),
        'utf8',
      )
      assert.ok(profileState.length > 0)
      assert.ok(!/token|secret|keychain/i.test(JSON.stringify(await ownerA.service.status())))
      // Forged identity fields are rejected by the Host before any Connector call.
      const forged = await ownerA.service.invoke({ operationId: 'identity.getSelf', args: { userId: 'test-user-b' } })
      assert.equal(forged.status, 'failed')
      assert.equal(forged.reasonCode, 'invalid_request')
      // Operations outside the server allowlist are denied locally and by the Connector.
      assert.equal(
        (
          await ownerA.service.invoke({
            operationId: 'dws.execute',
            args: { command: 'calendar event create', parameters: {} },
          })
        ).status,
        'denied',
      )
      const unsupported = await businessRequest(env, 'caller-a', '/v1/invoke', 'POST', {
        operationId: 'dws.execute',
        args: { command: 'x', parameters: {} },
      })
      assert.equal(unsupported.status, 403)
      assert.equal(unsupported.body.error.code, 'command_unavailable')
      // A caller's online DWS identity must match its binding; a mismatch is denied.
      await writeFile(join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'wrong_identity'), '1')
      const wrong = await ownerA.service.invoke({ operationId: 'calendar.listEvents', args: {} })
      assert.equal(wrong.status, 'denied')
      assert.equal(wrong.reasonCode, 'identity_mismatch')
      await rm(join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'wrong_identity'))
      // A binding change is refused rather than silently reusing the previous account's credentials.
      assert.equal(
        (
          await adminRequest(env, '/admin/v1/test-identity', {
            callerId: 'caller-a',
            corpId: 'test-corp',
            userId: 'test-user-b',
          })
        ).status,
        200,
      )
      const rebound = await ownerA.service.invoke({ operationId: 'calendar.listEvents', args: {} })
      assert.ok(['auth_required', 'denied'].includes(rebound.status), JSON.stringify(rebound))
      assert.equal(
        (
          await adminRequest(env, '/admin/v1/test-identity', {
            callerId: 'caller-a',
            corpId: 'test-corp',
            userId: 'test-user-a',
          })
        ).status,
        200,
      )
      assert.equal(
        (await ownerA.service.status()).state,
        'unlinked',
        'a changed binding requires a fresh authorization',
      )
      // Revoking A leaves B untouched.
      assert.equal((await adminRequest(env, '/admin/v1/revoke', { callerId: 'caller-a' })).status, 200)
      assert.equal((await ownerA.service.status()).state, 'unlinked')
      assert.equal((await ownerB.service.invoke({ operationId: 'calendar.listEvents', args: {} })).status, 'ok')
      // Connector restart keeps B's authorization from the private volume.
      await ownerA.dispose()
      await ownerB.dispose()
      await server.close()
      server = undefined
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      const b2 = await remoteFor(env, 'caller-b')
      const ownerB2 = serviceModule.createConnectionService(b2.backend)
      assert.equal((await ownerB2.service.status()).state, 'connected')
      assert.equal((await ownerB2.service.invoke({ operationId: 'calendar.listEvents', args: {} })).status, 'ok')
      await ownerB2.dispose()
      // Health and admin surfaces expose no credentials.
      const health = await businessRequest(env, 'caller-b', '/v1/health', 'GET')
      assert.equal(health.status, 200)
      assert.ok(!/token|secret|keychain|stateDirectory/i.test(JSON.stringify(health.body)))
      const admin = await adminRequest(env, '/admin/v1/callers')
      assert.equal(admin.status, 200)
      assert.ok(!JSON.stringify(admin.body).includes('test-user-a'))
    } finally {
      await ownerA?.dispose().catch(() => {})
      await ownerB?.dispose().catch(() => {})
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)
test(
  'linux unix-socket connector: bounded timeout, cancellation and admin-token enforcement',
  { skip, timeout: 180000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv({ DSH_CONNECTOR_TIMEOUT_MS: '1500' })
    let server
    let owner
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      const connection = await remoteFor(env, 'caller-a', { ...DEFAULT_LIMITS, timeoutMs: 1500 })
      owner = serviceModule.createConnectionService(connection.backend)
      await prepare(connection)
      const authorized = await authorize(owner.service, connection, env)
      assert.equal(authorized.state, 'connected', JSON.stringify(authorized))
      const delayFile = join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'delay_ms')
      await writeFile(delayFile, '4000')
      const started = Date.now()
      const timedOut = await owner.service.invoke({ operationId: 'calendar.listEvents', args: {} })
      assert.equal(timedOut.status, 'failed')
      assert.ok(Date.now() - started < 15000, 'timeout is bounded')
      await writeFile(delayFile, '0')
      await writeFile(delayFile, '3000')
      const controller = new AbortController()
      const pending = owner.service.invoke(
        { operationId: 'calendar.listEvents', args: {} },
        { signal: controller.signal },
      )
      setTimeout(() => controller.abort(), 100)
      const cancelled = await pending
      assert.notEqual(cancelled.status, 'ok')
      await writeFile(delayFile, '0')
      // Admin surface requires the private admin token.
      const noToken = await businessRequest({ ...env, __adminToken: '' }, 'caller-a', '/admin/v1/health', 'POST', {})
      assert.notEqual(noToken.status, 200)
      await owner.dispose()
    } finally {
      await owner?.dispose().catch(() => {})
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)
test('linux unix-socket connector: binding creates exactly one caller socket', { skip }, async () => {
  const { synthetic, isolated, env } = await fakeEnv()
  let server
  try {
    server = await startConnector(env)
    env.__adminToken = await adminToken(env)
    await bind(env, 'caller-a', 'test-corp', 'test-user-a')
    const files = await readdir(join(isolated.stateDir, 'sockets'))
    assert.deepEqual(files.sort(), ['caller-a'])
    assert.deepEqual((await readdir(join(isolated.stateDir, 'sockets', 'caller-a'))).sort(), ['dsh.sock'])
    assert.equal((await readFile(join(isolated.stateDir, 'admin.token'), 'utf8')).trim().length, 64)
  } finally {
    await server?.close().catch(() => {})
    await synthetic.close()
    await rmState(isolated.root)
  }
})

test(
  'duplicate test-bind is idempotent and never creates a false revocation state',
  { skip, timeout: 180000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv()
    let server
    let ownerA
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      assert.equal((await (await remoteFor(env, 'caller-a')).backend.status()).state, 'unlinked')
      const a = await remoteFor(env, 'caller-a')
      ownerA = serviceModule.createConnectionService(a.backend)
      await prepare(a)
      const authorized = await authorize(ownerA.service, a, env)
      assert.equal(authorized.state, 'connected', JSON.stringify(authorized))
      const trace = join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'trace.log')
      const logoutCount = async () =>
        (await readFile(trace, 'utf8')).split('\n').filter((line) => line.includes('auth logout')).length
      assert.equal(await logoutCount(), 0)
      // Re-running initialization with the same identity must keep the live authorization.
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      assert.equal((await ownerA.service.status()).state, 'connected')
      assert.equal((await ownerA.service.invoke({ operationId: 'calendar.listEvents', args: {} })).status, 'ok')
      assert.equal(await logoutCount(), 0, 'duplicate binding must not log out an authorized caller')
      // Explicit revocation still performs one real logout.
      assert.equal((await adminRequest(env, '/admin/v1/revoke', { callerId: 'caller-a' })).status, 200)
      assert.equal((await ownerA.service.status()).state, 'unlinked')
      assert.equal(await logoutCount(), 1)
      // A caller that was never authorized is revoked without a meaningless logout or pending marker.
      await bind(env, 'caller-c', 'test-corp', 'test-user-c')
      assert.equal((await adminRequest(env, '/admin/v1/revoke', { callerId: 'caller-c' })).status, 200)
      const c = await remoteFor(env, 'caller-c')
      const statusC = await c.backend.status()
      assert.equal(statusC.state, 'unlinked')
      assert.notEqual(statusC.reasonCode, 'revocation_failed')
      const traceC = join(isolated.stateDir, 'callers', 'caller-c', 'dws', 'trace.log')
      const lines = await readFile(traceC, 'utf8').catch(() => '')
      assert.ok(!lines.includes('auth logout'))
      await ownerA.dispose()
    } finally {
      await ownerA?.dispose().catch(() => {})
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)
test(
  'client abort cancels the server-side execution and frees the queue without affecting another caller',
  { skip, timeout: 180000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv()
    let server
    let ownerA
    let ownerB
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      for (const callerId of ['caller-a', 'caller-b']) {
        await bind(env, callerId, 'test-corp', `test-user-${callerId.slice(-1)}`)
      }
      const a = await remoteFor(env, 'caller-a')
      const b = await remoteFor(env, 'caller-b')
      ownerA = serviceModule.createConnectionService(a.backend)
      ownerB = serviceModule.createConnectionService(b.backend)
      await prepare(a)
      await prepare(b)
      assert.equal((await authorize(ownerA.service, a, env)).state, 'connected')
      assert.equal((await authorize(ownerB.service, b, env)).state, 'connected')
      const delayFile = join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'delay_ms')
      await writeFile(delayFile, '4000')
      const controller = new AbortController()
      const started = Date.now()
      const pending = ownerA.service.invoke(
        { operationId: 'calendar.listEvents', args: {} },
        { signal: controller.signal },
      )
      await new Promise((done) => setTimeout(done, 150))
      // The other caller is a separate session/socket and is not blocked by A's slow execution.
      const otherStarted = Date.now()
      assert.equal((await ownerB.service.invoke({ operationId: 'calendar.listEvents', args: {} })).status, 'ok')
      assert.ok(Date.now() - otherStarted < 3000, 'another caller is unaffected')
      controller.abort()
      const aborted = await pending
      assert.notEqual(aborted.status, 'ok')
      assert.ok(Date.now() - started < 10000, 'client abort returns promptly')
      await writeFile(delayFile, '0')
      const after = Date.now()
      assert.equal((await ownerA.service.invoke({ operationId: 'calendar.listEvents', args: {} })).status, 'ok')
      assert.ok(Date.now() - after < 3000, 'the per-caller queue is released after abort')
      await ownerA.dispose()
      await ownerB.dispose()
    } finally {
      await ownerA?.dispose().catch(() => {})
      await ownerB?.dispose().catch(() => {})
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)
test(
  'caller socket directory is recreated at the same path after a Connector restart',
  { skip, timeout: 120000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv()
    let server
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      const socketPath = join(isolated.stateDir, 'sockets', 'caller-a', 'dsh.sock')
      const before = await stat(socketPath)
      await server.close()
      server = undefined
      assert.equal(
        await stat(socketPath).then(
          () => true,
          () => false,
        ),
        false,
        'socket is removed on shutdown',
      )
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      const after = await stat(socketPath)
      assert.equal(after.mode & 0o777, 0o600)
      assert.notEqual(after.ino, before.ino, 'socket is recreated, not reused')
      const connection = await remoteFor(env, 'caller-a')
      assert.equal((await connection.backend.status()).state, 'unlinked')
      await connection.backend.dispose()
    } finally {
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)

test(
  'failed or unknown logout stays a visible revocation block instead of being cleared',
  { skip, timeout: 180000 },
  async () => {
    const { synthetic, isolated, env } = await fakeEnv()
    let server
    let ownerA
    try {
      server = await startConnector(env)
      env.__adminToken = await adminToken(env)
      await bind(env, 'caller-a', 'test-corp', 'test-user-a')
      const a = await remoteFor(env, 'caller-a')
      ownerA = serviceModule.createConnectionService(a.backend)
      await prepare(a)
      assert.equal((await authorize(ownerA.service, a, env)).state, 'connected')
      await writeFile(join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'fail_logout'), '1')
      assert.equal((await adminRequest(env, '/admin/v1/revoke', { callerId: 'caller-a' })).status, 200)
      const blocked = await ownerA.service.status()
      assert.equal(blocked.state, 'unknown')
      assert.equal(blocked.reasonCode, 'revocation_failed')
      // A retry clears the marker only after a real successful logout.
      await rm(join(isolated.stateDir, 'callers', 'caller-a', 'dws', 'fail_logout'))
      assert.equal((await adminRequest(env, '/admin/v1/revoke', { callerId: 'caller-a' })).status, 200)
      const cleared = await (await remoteFor(env, 'caller-a')).backend.status()
      assert.equal(cleared.state, 'unlinked')
      assert.notEqual(cleared.reasonCode, 'revocation_failed')
      await ownerA.dispose()
    } finally {
      await ownerA?.dispose().catch(() => {})
      await server?.close().catch(() => {})
      await synthetic.close()
      await rmState(isolated.root)
    }
  },
)
