// Real nginx + synthetic local upstream. Never calls DingTalk or uses real credentials.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { openSync, closeSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const nginx = process.env.NGINX_BIN || 'nginx'
const available = spawnSync(nginx, ['-v']).status === 0 && spawnSync('openssl', ['version']).status === 0
if (!available && process.env.REQUIRE_NGINX === '1') throw new Error('Real nginx and openssl are required')
const template = await readFile(new URL('../deploy/nginx-oauth.conf.example', import.meta.url), 'utf8')
const secrets = Object.fromEntries(
  [
    'ticket',
    'state',
    'code',
    'authCode',
    'token',
    'cookie',
    'authorization',
    'referer',
    'host',
    'path',
    'requestId',
    'location',
    'upstream',
  ].map((key) => [key, `synthetic-sensitive-${key}-never-log`]),
)
const query = `?t=${secrets.ticket}&state=${secrets.state}&code=${secrets.code}&authCode=${secrets.authCode}&token=${secrets.token}`
const keys = [
  'time',
  'request_id',
  'stage',
  'error_code',
  'status',
  'upstream_status',
  'request_time',
  'upstream_connect_time',
  'upstream_header_time',
  'upstream_response_time',
]
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
async function unusedPort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
function get(port, path, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: extra.body ? 'POST' : 'GET',
        // An ephemeral, synthetic localhost certificate. No production TLS settings are changed.
        rejectUnauthorized: false,
        servername: '',
        agent: false,
        headers: {
          Host: secrets.host,
          Cookie: `proof=${secrets.cookie}`,
          Authorization: `Bearer ${secrets.authorization}`,
          Referer: `https://example.invalid/?token=${secrets.referer}`,
          'X-Request-ID': secrets.requestId,
          ...(extra.body ? { 'Content-Length': Buffer.byteLength(extra.body) } : {}),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error('test request timed out')))
    req.on('error', reject)
    req.end(extra.body)
  })
}
async function startProxy(root, upstreamPort, unsafe = false) {
  const port = await unusedPort()
  const cert = join(root, 'cert.pem')
  const key = join(root, 'key.pem')
  const generated = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-keyout',
    key,
    '-out',
    cert,
  ])
  assert.equal(generated.status, 0, 'generate ephemeral test certificate')
  let config = template
    .replace('listen 8443 ssl;', `listen 127.0.0.1:${port} ssl;`)
    .replace('/etc/nginx/tls/fullchain.pem', cert)
    .replace('/etc/nginx/tls/privkey.pem', key)
    .replace('http://127.0.0.1:8787', `http://127.0.0.1:${upstreamPort}`)
    .replace('proxy_read_timeout 30s;', 'proxy_read_timeout 200ms;')
  if (unsafe) config = config.replace('error_log /dev/null;', 'error_log /dev/stderr warn;')
  const conf = join(root, 'nginx.conf')
  await writeFile(
    conf,
    `daemon off;\nmaster_process off;\npid ${root}/nginx.pid;\nerror_log ${root}/global-error.log notice;\nevents {}\nhttp {\naccess_log ${root}/inherited-access.log combined;\nclient_body_temp_path ${root}/body;\nproxy_temp_path ${root}/proxy;\n${config}\n}\n`,
  )
  // Node's pipe stdio can be a socket that /dev/stdout cannot reopen. Back both streams
  // with files so we test the production log destinations unchanged and capture every byte.
  const stdoutPath = join(root, 'stdout.log'),
    stderrPath = join(root, 'stderr.log')
  const stdoutFd = openSync(stdoutPath, 'a'),
    stderrFd = openSync(stderrPath, 'a')
  const args = ['-p', `${root}/`, '-e', join(root, 'global-error.log'), '-c', conf]
  let child
  try {
    const parsed = spawnSync(nginx, [...args, '-t'], { stdio: ['ignore', stdoutFd, stderrFd] })
    assert.equal(parsed.status, 0, await readFile(stderrPath, 'utf8'))
    child = spawn(nginx, args, { stdio: ['ignore', stdoutFd, stderrFd] })
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }
  const exited = once(child, 'exit')
  const proxy = {
    port,
    async logs() {
      const files = await Promise.all(
        ['global-error.log', 'inherited-access.log'].map((file) => readFile(join(root, file), 'utf8').catch(() => '')),
      )
      const stdout = await readFile(stdoutPath, 'utf8'),
        stderr = await readFile(stderrPath, 'utf8')
      return { stdout, stderr, files, all: [stdout, stderr, ...files].join('\n') }
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    },
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`nginx exited: ${await readFile(stderrPath, 'utf8')}`)
      try {
        await get(port, '/ready')
        return proxy
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error
        await delay(20)
      }
    }
    throw new Error('nginx did not become ready')
  } catch (error) {
    await proxy.close()
    throw error
  }
}

test('real nginx: unsafe error-log control exposes a synthetic callback query', { skip: !available }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nginx-control-'))
  let proxy
  try {
    proxy = await startProxy(root, await unusedPort(), true)
    assert.equal((await get(proxy.port, `/dsh-dingtalk/callback${query}`)).status, 502)
    await proxy.close()
    assert.ok(
      (await proxy.logs()).stderr.includes(secrets.code),
      'positive control must exercise the original raw error-log leak',
    )
  } finally {
    await proxy?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'real nginx: failures retain correlated diagnostics without sensitive request/upstream data',
  { skip: !available },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nginx-safe-'))
    let mode = 'ok',
      proxy
    const observed = [],
      sockets = new Set()
    const upstream = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      let input = ''
      socket.on('data', (data) => {
        input += data
        if (!input.includes('\r\n\r\n')) return
        socket.removeAllListeners('data')
        observed.push({ request: input, id: input.match(/\r\nX-Request-ID: ([^\r]+)/i)?.[1] })
        if (mode === 'timeout') return
        if (mode === 'reset') return socket.destroy()
        if (mode === 'invalid') return socket.end(`HTTP/1.1 200 OK\r\nInvalid Header ${secrets.upstream}\r\n\r\n`)
        const status = mode === 'redirect' ? '302 Found' : mode === 'unavailable' ? '503 Unavailable' : '200 OK'
        socket.end(
          `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\nX-Request-ID: ${secrets.upstream}\r\n${mode === 'redirect' ? `Location: https://provider.invalid/?code=${secrets.location}\r\n` : ''}\r\n`,
        )
      })
    })
    const port = await listen(upstream)
    const responses = []
    async function check(nextMode, path, status, stage, errorCode, extra) {
      mode = nextMode
      const count = observed.length
      const response = await get(proxy.port, path, extra)
      assert.equal(response.status, status, nextMode)
      const id = response.headers['x-request-id']
      assert.match(id, /^[a-f0-9]{32}$/)
      assert.ok(!responses.some((item) => item.id === id), 'server generates a fresh request ID')
      if (observed.length > count) {
        assert.equal(observed.at(-1).id, id, 'upstream receives the generated ID, not the spoofed browser value')
        assert.ok(observed.at(-1).request.includes(query), 'proxy must preserve the OAuth query for the Connector')
      }
      responses.push({ id, status, stage, errorCode })
    }
    try {
      proxy = await startProxy(root, port)
      await check('ok', `/dsh-dingtalk/callback${query}`, 200, 'oauth_callback', 'http_ok')
      await check('redirect', `/dsh-dingtalk/start${query}`, 302, 'oauth_start', 'http_redirect')
      await check('invalid', `/dsh-dingtalk/callback${query}`, 502, 'oauth_callback', 'upstream_failed')
      await check('reset', `/dsh-dingtalk/callback${query}`, 502, 'oauth_callback', 'upstream_failed')
      await check('timeout', `/dsh-dingtalk/start${query}`, 504, 'oauth_start', 'upstream_timeout')
      await check('unavailable', `/dsh-dingtalk/callback${query}`, 503, 'oauth_callback', 'service_unavailable')
      await check('ok', `/${secrets.path}${query}`, 404, 'other', 'route_not_found')
      await check('ok', `/dsh-dingtalk/callback${query}`, 413, 'oauth_callback', 'request_too_large', {
        body: 'x'.repeat(17000),
      })
      await check('ok', `/${secrets.path}${query}&padding=${'x'.repeat(10000)}`, 414, 'other', 'http_other')
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => upstream.close(resolve))
      await check('refused', `/dsh-dingtalk/callback${query}`, 502, 'oauth_callback', 'upstream_failed')
      await proxy.close()
      const logs = await proxy.logs()
      for (const value of Object.values(secrets)) assert.ok(!logs.all.includes(value), `must not log ${value}`)
      assert.equal(logs.files[1], '', 'raw parent access log must not be inherited')
      const entries = logs.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(
        entries.length,
        responses.length + 1,
        'one safe completion diagnostic per request, including readiness',
      )
      for (const entry of entries) assert.deepEqual(Object.keys(entry), keys)
      for (const { id, status, stage, errorCode } of responses) {
        const entry = entries.find((item) => item.request_id === id)
        assert.ok(entry, 'response request ID locates its diagnostic')
        assert.equal(entry.status, String(status))
        assert.equal(entry.stage, stage)
        assert.equal(entry.error_code, errorCode)
        if (status === 502 || status === 504) assert.equal(entry.upstream_status, String(status))
      }
    } finally {
      for (const socket of sockets) socket.destroy()
      if (upstream.listening) await new Promise((resolve) => upstream.close(resolve))
      await proxy?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
