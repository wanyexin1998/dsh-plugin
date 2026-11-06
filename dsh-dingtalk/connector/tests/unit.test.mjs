import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, readdir, stat, writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorState } from '../lib/connector.mjs'
import { ServerOAuth } from '../lib/connector.mjs'
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
    assert.throws(() => parseConnectorConfig({ ...env, ...oauth, DSH_CONNECTOR_CLIENT_ID: '' }), /incomplete|CLIENT_ID/)
    assert.throws(() => parseConnectorConfig({ ...env, ...oauth, DSH_CONNECTOR_OAUTH_TLS_CERT: 'cert.pem' }), /TLS/)
    assert.throws(
      () => parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_DWS_ENV: JSON.stringify({ DWS_PRIVATE_TOKEN: 'x' }) }),
      /TEST_DWS_ENV/,
    )
    assert.throws(
      () => parseConnectorConfig({ ...env, DSH_CONNECTOR_TEST_DWS_ENV: JSON.stringify({ DWS_CLIENT_SECRET: 'x' }) }),
      /TEST_DWS_ENV/,
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
test('server OAuth requires HTTPS proxy headers, exact origin, one-time state and unexpired proof', async () => {
  let now = 1_000_000
  let exchanges = 0
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
    {
      exchange: async (callerId, code, signal) => {
        exchanges++
        assert.equal(callerId, 'caller-a')
        assert.equal(code, 'synthetic-code')
        assert.equal(signal.aborted, false)
        return { state: 'connected' }
      },
    },
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
    const start = oauth.begin('caller-a', 'https://dsh.test', '/session/1?panel=chat#draft')
    assert.equal(new URL(start.authorizeUrl).origin, 'https://connector.test')
    assert.ok(!start.authorizeUrl.includes('token') && !start.authorizeUrl.includes('code'))
    assert.throws(() => oauth.begin('caller-a', 'https://evil.test', '/'), { reasonCode: 'invalid_request' })
    assert.throws(() => oauth.begin('caller-a', 'https://dsh.test', '//evil.test'), { reasonCode: 'invalid_request' })
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
    assert.equal(provider.searchParams.get('redirect_uri'), 'https://connector.test/dsh-dingtalk/callback')
    const cookie = started.headers['set-cookie'][0].split(';')[0]
    const callbackPath = `/dsh-dingtalk/callback?state=${provider.searchParams.get('state')}&authCode=synthetic-code`
    assert.equal(
      (await call(callbackPath, { host: 'connector.test', 'x-forwarded-proto': 'https' })).status,
      400,
      'proof cookie required',
    )
    assert.equal(
      (await call(callbackPath, { host: 'connector.test', 'x-forwarded-proto': 'https', cookie: 'wrong=1' })).status,
      400,
    )
    const callback = await call(callbackPath, { host: 'connector.test', 'x-forwarded-proto': 'https', cookie })
    assert.equal(callback.status, 200)
    assert.equal(callback.body.includes('synthetic-code'), false)
    assert.equal(callback.body.includes('dsh-dingtalk:auth'), true)
    assert.equal(oauth.status(start.transactionId, 'caller-a').state, 'connected')
    assert.equal(
      (await call(callbackPath, { host: 'connector.test', 'x-forwarded-proto': 'https', cookie })).status,
      400,
      'replay rejected',
    )
    assert.equal(exchanges, 1)
    const expired = oauth.begin('caller-a', 'https://dsh.test', '/')
    now += 121_000
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
    const cancelled = oauth.begin('caller-a', 'https://dsh.test', '/')
    assert.equal(oauth.cancel(cancelled.transactionId, 'caller-a').state, 'user_cancelled')
    assert.throws(() => oauth.status(cancelled.transactionId, 'caller-b'), { reasonCode: 'invalid_auth_state' })
    const hostHeader = await call(
      `/dsh-dingtalk/start?t=${new URL(oauth.begin('caller-a', 'https://dsh.test', '/').authorizeUrl).searchParams.get('t')}`,
      { host: 'connector.test' },
    )
    assert.equal(hostHeader.status, 403)
  } finally {
    await oauth.dispose()
  }
})
