import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, readdir, stat, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorServer, ConnectorState } from '../lib/connector.mjs'
import { DEVICE_LOGIN_TTL_MS, ServerOAuth, parseDevicePrompt } from '../lib/connector.mjs'
import { parseConnectorConfig } from '../lib/connector.mjs'

const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-connector-unit-'))
  return { root, state: join(root, 'state'), dispose: () => rm(root, { recursive: true, force: true }) }
}
const baseEnv = (stateDir, overrides = {}) => ({
  DSH_CONNECTOR_STATE_DIR: stateDir,
  DSH_CONNECTOR_DWS_BINARY: join(stateDir, 'bin', process.platform === 'win32' ? 'dws.exe' : 'dws'),
  DSH_CONNECTOR_TRANSPORT: 'loopback',
  DSH_CONNECTOR_ALLOW_TEST_TRANSPORT: '1',
  DSH_CONNECTOR_LOOPBACK_PORT: '45123',
  ...overrides,
})
test('configuration fails closed for transport, paths, OAuth origins and test seams', async () => {
  const isolated = await temporary()
  try {
    const env = baseEnv(isolated.state)
    assert.equal(parseConnectorConfig(env).transport, 'loopback')
    assert.throws(() => parseConnectorConfig({ ...env, DSH_CONNECTOR_ALLOW_TEST_TRANSPORT: undefined }), /test-only/)
    assert.throws(() => parseConnectorConfig({ ...env, DSH_CONNECTOR_DWS_BINARY: 'dws' }), /absolute/)
    assert.throws(() => parseConnectorConfig({ ...env, DSH_CONNECTOR_TRANSPORT: 'tcp' }), /DSH_CONNECTOR_TRANSPORT/)
    assert.throws(() => parseConnectorConfig({ ...env, DSH_CONNECTOR_SOCKET_MODE: '0777' }), /SOCKET_MODE/)
    assert.throws(() => parseConnectorConfig({ ...env, DSH_CONNECTOR_MAX_OUTPUT_BYTES: '99999999' }), /invalid/)
    const oauth = {
      DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN: 'https://connector.test',
      DSH_CONNECTOR_OAUTH_LISTEN_PORT: '8787',
      DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS: 'https://dsh.test',
      DSH_CONNECTOR_CLIENT_ID: 'synthetic-app',
      DSH_CONNECTOR_SCOPES: 'openid corpid',
    }
    assert.equal(parseConnectorConfig({ ...env, ...oauth }).oauth.publicOrigin, 'https://connector.test')
    assert.throws(
      () => parseConnectorConfig({ ...env, ...oauth, DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN: 'http://connector.test' }),
      /trusted origin/,
    )
    assert.throws(
      () =>
        parseConnectorConfig({
          ...env,
          ...oauth,
          DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS: 'https://dsh.test,http://evil.test',
        }),
      /https/,
    )
    assert.equal(
      parseConnectorConfig({ ...env, ...oauth, DSH_CONNECTOR_CLIENT_ID: undefined, DSH_CONNECTOR_SCOPES: undefined })
        .oauth.publicOrigin,
      'https://connector.test',
    )
    assert.throws(() => parseConnectorConfig({ ...env, ...oauth, DSH_CONNECTOR_OAUTH_TLS_CERT: 'cert.pem' }), /TLS/)
    assert.throws(
      () => parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_DWS_ENV: JSON.stringify({ DWS_PRIVATE_TOKEN: 'x' }) }),
      /TEST_DWS_ENV/,
    )
    assert.throws(
      () => parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_DWS_ENV: JSON.stringify({ DWS_CLIENT_SECRET: 'x' }) }),
      /TEST_DWS_ENV/,
    )
    assert.equal(
      parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_COMMIT_GATE: join(isolated.state, 'gate') }).testCommitGate,
      join(isolated.state, 'gate'),
    )
    assert.throws(
      () => parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_COMMIT_GATE: 'gate' }),
      /TEST_COMMIT_GATE must be absolute/,
    )
    assert.throws(
      () =>
        parseConnectorConfig({
          ...env,
          DSH_CONNECTOR_TRANSPORT: 'unix',
          DSH_CONNECTOR_ALLOW_TEST_TRANSPORT: undefined,
          DSH_CONNECTOR_TEST_COMMIT_GATE: join(isolated.state, 'gate'),
        }),
      /TEST_COMMIT_GATE requires an explicit test mode/,
    )
  } finally {
    await isolated.dispose()
  }
})
test('state provisions private per-user directories and rejects forged bindings', async () => {
  const isolated = await temporary()
  try {
    const state = new ConnectorState(isolated.state)
    await state.init()
    const token = await state.adminToken()
    assert.match(token, /^[a-f0-9]{64}$/)
    if (process.platform !== 'win32')
      assert.equal((await stat(join(isolated.state, 'admin.token'))).mode & 0o777, 0o600)
    await state.setBinding('caller-a', { corpId: 'test-corp', userId: 'test-user-a' })
    const paths = await state.provisionUser('caller-a')
    for (const directory of [paths.root, paths.home, paths.dwsConfig, paths.keychain]) {
      assert.equal((await stat(directory)).isDirectory(), true)
      if (process.platform !== 'win32') assert.equal((await stat(directory)).mode & 0o777, 0o700, directory)
    }
    assert.deepEqual((await state.readBindings()).bindings['caller-a'].corpId, 'test-corp')
    await assert.rejects(state.setBinding('../escape', { corpId: 'test-corp', userId: 'test-user-a' }))
    await assert.rejects(state.setBinding('caller-a', { corpId: 'bad corp', userId: 'test-user-a' }))
    await writeFile(
      state.bindingsPath,
      JSON.stringify({
        version: 1,
        bindings: { '../evil': { corpId: 'test-corp', userId: 'test-user-a', createdAt: '' } },
      }),
    )
    await assert.rejects(state.readBindings())
    await writeFile(
      state.bindingsPath,
      JSON.stringify({
        version: 1,
        bindings: { 'caller-a': { corpId: 'test-corp', userId: 'test-user-a', createdAt: '' } },
      }),
    )
    assert.equal(await state.removeBinding('caller-a'), true)
    assert.equal((await state.readBindings()).bindings['caller-a'], undefined)
    let entered = 0
    const first = state.withRefreshLock('caller-a', async () => {
      entered++
      await new Promise((done) => setTimeout(done, 50))
      return 1
    })
    await new Promise((done) => setTimeout(done, 10))
    await assert.rejects(
      state.withRefreshLock('caller-a', async () => 2),
      /authorization_busy/,
    )
    assert.equal(await first, 1)
    assert.equal(entered, 1)
    assert.equal(await state.withRefreshLock('caller-a', async () => 3), 3)
  } finally {
    await isolated.dispose()
  }
})
const deviceOperations = (
  next = () => new Promise(() => {}),
  verificationUrl = 'https://login.synthetic.test/device?user_code=ABCD-EFGH',
) => ({
  startDevice: () => ({
    prompt: Promise.resolve({
      userCode: 'ABCD-EFGH',
      verificationUrl,
    }),
    completion: next(),
  }),
})
test('device prompt parser reads the official CLI stderr', () => {
  const text =
    ' 授权码: \u001b[1mABCD-EFGH\u001b[0m\n 授权链接（已填入授权码）：\nhttps://login.dingtalk.com/device?user_code=ABCD-EFGH\n'
  assert.deepEqual(parseDevicePrompt(text), {
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://login.dingtalk.com/device?user_code=ABCD-EFGH',
  })
  assert.equal(parseDevicePrompt('still waiting'), undefined)
  assert.equal(parseDevicePrompt(text.slice(0, text.indexOf('/device?'))), undefined)
})
test('server OAuth opens the official device login and ignores the old callback', async () => {
  let now = 1_000_000
  let finish = () => {}
  let opened = 0
  const port = await new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
  const oauth = new ServerOAuth(
    {
      publicOrigin: 'https://connector.test',
      trustedOrigins: ['https://dsh.test'],
      clientId: 'synthetic-app',
      scopes: 'openid corpid',
      listenPort: port,
    },
    deviceOperations(() => {
      opened += 1
      if (opened > 1) return new Promise(() => {})
      return new Promise((resolve) => {
        finish = () => resolve({ state: 'connected' })
      })
    }),
    () => now,
    'https://login.synthetic.test/oauth2/auth',
  )
  const call = (path, headers, method = 'GET') =>
    new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      })
      req.on('error', reject)
      req.end()
    })
  try {
    await oauth.listen()
    const start = await oauth.begin('caller-a', 'https://dsh.test', '/session/1?panel=chat#draft')
    assert.equal(new URL(start.authorizeUrl).origin, 'https://connector.test')
    assert.ok(!start.authorizeUrl.includes('token') && !start.authorizeUrl.includes('code'))
    await assert.rejects(() => oauth.begin('caller-a', 'https://evil.test', '/'), { reasonCode: 'invalid_request' })
    await assert.rejects(() => oauth.begin('caller-a', 'https://dsh.test', '//evil.test'), {
      reasonCode: 'invalid_request',
    })
    const ticket = new URL(start.authorizeUrl).searchParams.get('t')
    assert.equal(
      (await call(`/dsh-dingtalk/start?t=${ticket}`)).status,
      403,
      'plain HTTP without trusted proxy header is rejected',
    )
    assert.equal(
      (await call(`/dsh-dingtalk/start?t=${ticket}`, { host: 'evil.test', 'x-forwarded-proto': 'https' })).status,
      403,
    )
    const started = await call(`/dsh-dingtalk/start?t=${ticket}`, {
      host: 'connector.test',
      'x-forwarded-proto': 'https',
    })
    assert.equal(started.status, 302)
    const provider = new URL(started.headers.location)
    assert.equal(provider.origin, 'https://login.synthetic.test')
    assert.equal(provider.searchParams.get('user_code'), 'ABCD-EFGH')
    assert.equal(provider.searchParams.get('redirect_uri'), null)
    const cookie = started.headers['set-cookie'][0].split(';')[0]
    for (const replayCookie of ['', cookie + 'invalid']) {
      const replay = await call(`/dsh-dingtalk/start?t=${ticket}`, {
        host: 'connector.test',
        'x-forwarded-proto': 'https',
        cookie: replayCookie,
      })
      assert.equal(replay.status, 400)
      assert.equal(replay.headers.location, undefined)
    }
    const refreshed = await call(`/dsh-dingtalk/start?t=${ticket}`, {
      host: 'connector.test',
      'x-forwarded-proto': 'https',
      cookie,
    })
    assert.equal(refreshed.status, 302)
    assert.equal(
      (
        await call('/dsh-dingtalk/callback?state=old&authCode=synthetic-code', {
          host: 'connector.test',
          'x-forwarded-proto': 'https',
        })
      ).status,
      404,
    )
    finish()
    let connected = oauth.status(start.transactionId, 'caller-a')
    for (let attempt = 0; connected.state === 'authorizing' && attempt < 20; attempt++) {
      await new Promise((done) => setTimeout(done, 10))
      connected = oauth.status(start.transactionId, 'caller-a')
    }
    assert.equal(connected.state, 'connected')
    const expired = await oauth.begin('caller-a', 'https://dsh.test', '/')
    now += DEVICE_LOGIN_TTL_MS + 1_000
    assert.equal(oauth.status(expired.transactionId, 'caller-a').state, 'auth_timeout')
    assert.equal(
      (
        await call(`/dsh-dingtalk/start?t=${new URL(expired.authorizeUrl).searchParams.get('t')}`, {
          host: 'connector.test',
          'x-forwarded-proto': 'https',
        })
      ).status,
      400,
    )
    const cancelled = await oauth.begin('caller-a', 'https://dsh.test', '/')
    assert.equal(oauth.cancel(cancelled.transactionId, 'caller-a').state, 'user_cancelled')
    assert.throws(() => oauth.status(cancelled.transactionId, 'caller-b'), { reasonCode: 'invalid_auth_state' })
    const again = await oauth.begin('caller-a', 'https://dsh.test', '/')
    const hostHeader = await call(`/dsh-dingtalk/start?t=${new URL(again.authorizeUrl).searchParams.get('t')}`, {
      host: 'connector.test',
    })
    assert.equal(hostHeader.status, 403)
  } finally {
    await oauth.dispose()
  }
})
test('server OAuth compares the exact public host:port and preserves a non-443 public port', async () => {
  const port = await new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
  const oauth = new ServerOAuth(
    {
      publicOrigin: 'https://callback.test:8443',
      trustedOrigins: ['https://dsh.test'],
      clientId: 'synthetic-app',
      scopes: 'openid corpid',
      listenPort: port,
    },
    deviceOperations(undefined, 'https://login.synthetic.test/device'),
    Date.now,
    'https://login.synthetic.test/oauth2/auth',
  )
  const call = (path, headers) =>
    new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        )
      })
      req.on('error', reject)
      req.end()
    })
  try {
    await oauth.listen()
    const start = await oauth.begin('caller-a', 'https://dsh.test', '/')
    const ticket = new URL(start.authorizeUrl).searchParams.get('t')
    const withPort = await call(`/dsh-dingtalk/start?t=${ticket}`, {
      host: 'callback.test:8443',
      'x-forwarded-proto': 'https',
    })
    assert.equal(withPort.status, 200)
    assert.match(withPort.body, /ABCD-EFGH/)
    assert.match(withPort.body, /href="https:\/\/login\.synthetic\.test\/device"/)
    assert.equal(withPort.headers['cache-control'], 'no-store')
    assert.equal(withPort.headers['referrer-policy'], 'no-referrer')
    const withoutPort = await call(`/dsh-dingtalk/start?t=${ticket}`, {
      host: 'callback.test',
      'x-forwarded-proto': 'https',
    })
    assert.equal(withoutPort.status, 403, 'a dropped public port must be rejected, not repaired')
    const wrongPort = await call(`/dsh-dingtalk/start?t=${ticket}`, {
      host: 'callback.test:8444',
      'x-forwarded-proto': 'https',
    })
    assert.equal(wrongPort.status, 403)
  } finally {
    await oauth.dispose()
  }
})
function post(port, path, body, headers = {}) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode, body: text })
          }
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}
function bindLoopback(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const fail = (error) => {
      server.close(() => reject(error))
    }
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', fail)
      resolve(server)
    })
  })
}
async function portPair() {
  let last
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = createServer()
    const port = await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => resolve(probe.address().port))
    })
    await new Promise((resolve) => probe.close(resolve))
    let first
    let second
    try {
      first = await bindLoopback(port)
      second = await bindLoopback(port + 1)
      await new Promise((resolve) => second.close(resolve))
      await new Promise((resolve) => first.close(resolve))
      return port
    } catch (error) {
      last = error
      await new Promise((resolve) => (second ? second.close(resolve) : resolve()))
      await new Promise((resolve) => (first ? first.close(resolve) : resolve()))
    }
  }
  throw last instanceof Error ? last : new Error('no free port pair')
}
async function startConnector(stateDir, extra = {}) {
  let last
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = await portPair()
    const server = new ConnectorServer(
      parseConnectorConfig(baseEnv(stateDir, { DSH_CONNECTOR_LOOPBACK_PORT: String(port), ...extra })),
    )
    try {
      await server.start()
      return { server, port }
    } catch (error) {
      last = error
      await server.close().catch(() => {})
      if (!['EACCES', 'EADDRINUSE'].includes(error?.code)) throw error
    }
  }
  throw last
}
test('production binding accepts a real seat identity and ordinary DWS calls are not command_unavailable', async () => {
  const isolated = await temporary()
  const started = await startConnector(isolated.state, { DSH_CONNECTOR_TEST_IDENTITY: '1' })
  const server = started.server
  const port = started.port
  let plain
  try {
    const admin = (path, body, token = server.adminTokenValue) =>
      post(port + 1, path, body, token ? { 'x-dsh-connector-admin-token': token } : {})
    const bound = await admin('/admin/v1/bindings', { callerId: 'seat-1', corpId: 'dingrealco', userId: 'staff01' })
    assert.equal(bound.status, 200, JSON.stringify(bound.body))
    assert.equal(bound.body.value.bound, true)
    assert.equal(
      (await admin('/admin/v1/bindings', { callerId: 'seat-1', corpId: 'dingrealco', userId: 'staff01' })).status,
      200,
    )
    const synthetic = await admin('/admin/v1/bindings', {
      callerId: 'seat-2',
      corpId: 'test-corp',
      userId: 'test-user-a',
    })
    assert.equal(synthetic.status, 400)
    assert.equal(synthetic.body.error.code, 'invalid_request')
    const realOnTest = await admin('/admin/v1/test-identity', {
      callerId: 'seat-3',
      corpId: 'dingrealco',
      userId: 'staff01',
    })
    assert.equal(realOnTest.status, 400)
    assert.equal(realOnTest.body.error.code, 'invalid_request')
    const syntheticOnTest = await admin('/admin/v1/test-identity', {
      callerId: 'seat-3',
      corpId: 'test-corp',
      userId: 'test-user-a',
    })
    assert.equal(syntheticOnTest.status, 200, JSON.stringify(syntheticOnTest.body))
    assert.equal(
      (await admin('/admin/v1/bindings', { callerId: 'seat-4', corpId: 'dingrealco', userId: 'staff02' }, '')).status,
      400,
    )
    const token = (await readFile(join(isolated.state, 'callers', 'seat-1', 'capability.token'), 'utf8')).trim()
    const business = (path, body) => post(port, path, body, { authorization: `Bearer ${token}` })
    const crossSeat = await business('/v1/invoke', {
      operationId: 'identity.getSelf',
      args: {},
      expectedProfile: 'dingrealco:staff02',
    })
    assert.equal(crossSeat.body.error.code, 'identity_mismatch')
    const forged = await business('/v1/invoke', { operationId: 'identity.getSelf', args: { userId: 'staff02' } })
    assert.equal(forged.status, 400)
    assert.equal(forged.body.error.code, 'invalid_request')
    const outside = await business('/v1/invoke', { operationId: 'message.send', args: {} })
    assert.equal(outside.status, 403)
    assert.equal(outside.body.error.code, 'command_unavailable')
    const allowed = await business('/v1/invoke', {
      operationId: 'dws.execute',
      args: { command: 'doc search', parameters: {} },
    })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
    assert.equal(allowed.body.value.result.status, 'auth_required')
    assert.equal(allowed.body.value.result.reasonCode, 'not_connected')
    const jobs = await business('/v1/invoke', {
      operationId: 'dws.jobs',
      args: { action: 'list' },
      sessionId: 'session-1',
    })
    assert.equal(jobs.status, 200, JSON.stringify(jobs.body))
    assert.equal(jobs.body.value.result.reasonCode, 'not_connected')
    const badFlag = await business('/v1/invoke', {
      operationId: 'dws.execute',
      args: { command: 'doc search', parameters: {} },
      confirmed: 'yes',
    })
    assert.equal(badFlag.status, 400)
    assert.equal(badFlag.body.error.code, 'invalid_request')
    const crossed = await post(
      port,
      '/admin/v1/bindings',
      { callerId: 'seat-9', corpId: 'dingrealco', userId: 'staff09' },
      { authorization: `Bearer ${token}`, 'x-dsh-connector-admin-token': server.adminTokenValue },
    )
    assert.equal(crossed.status, 404)
    await server.close()
    const restarted = await startConnector(isolated.state)
    plain = restarted.server
    const plainPort = restarted.port
    const plainAdmin = (path, body) =>
      post(plainPort + 1, path, body, { 'x-dsh-connector-admin-token': plain.adminTokenValue })
    const blockedTest = await plainAdmin('/admin/v1/test-identity', {
      callerId: 'seat-5',
      corpId: 'test-corp',
      userId: 'test-user-b',
    })
    assert.equal(blockedTest.status, 400)
    assert.equal(blockedTest.body.error.code, 'invalid_request')
    const real = await plainAdmin('/admin/v1/bindings', { callerId: 'seat-5', corpId: 'dingrealco', userId: 'staff05' })
    assert.equal(real.status, 200, JSON.stringify(real.body))
  } finally {
    await server.close()
    await plain?.close()
    await isolated.dispose()
  }
})
test(
  'ConnectorServer refuses to start when the private state volume is not writable',
  { skip: process.platform === 'win32' },
  async () => {
    const isolated = await temporary()
    await mkdir(isolated.state, { recursive: true })
    try {
      await chmod(isolated.state, 0o500)
      const server = new ConnectorServer(parseConnectorConfig(baseEnv(isolated.state)))
      await assert.rejects(server.start(), (error) => error?.reasonCode === 'service_unavailable')
    } finally {
      await chmod(isolated.state, 0o700).catch(() => {})
      await isolated.dispose()
    }
  },
)
