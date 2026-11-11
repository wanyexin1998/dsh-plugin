// Connector integration harness: real pinned DWS binary + synthetic loopback endpoints.
// All identities and business payloads are synthetic test fixtures; nothing here is production.
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function freePort() {
  return new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}
export async function freePortExcept(...exclude) {
  for (;;) {
    const candidate = await freePort()
    if (!exclude.includes(candidate)) return candidate
  }
}
export async function syntheticServer() {
  const state = {
    user: 'test-user-a',
    corp: 'test-corp',
    exchangeFailure: false,
    businessFailure: false,
    wrongIdentity: false,
    delay: 0,
    calls: [],
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'))
        back.searchParams.set('state', url.searchParams.get('state'))
        back.searchParams.set('authCode', 'synthetic-code')
        back.searchParams.set('code', 'synthetic-code')
        res.writeHead(302, { Location: back.href })
        res.end()
        return
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      let value
      if (url.pathname === '/oauth2/getToken' || url.pathname === '/oauth2/refreshToken') {
        state.calls.push({ type: 'exchange' })
        if (state.exchangeFailure) {
          res.statusCode = 500
          value = {}
        } else
          value = {
            accessToken: `synthetic-${state.user}-access`,
            refreshToken: `synthetic-${state.user}-refresh`,
            expiresIn: 7200,
            corpId: state.corp,
          }
      } else if (url.pathname === '/oauth2/revokeToken') value = { success: true }
      else if (body.method === 'initialize')
        value = {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'synthetic-test', version: '1' },
          },
        }
      else if (body.method === 'tools/call') {
        const user =
          (req.headers['x-user-access-token'] ?? '').replace(/^synthetic-/, '').replace(/-access$/, '') || state.user
        const name = body.params.name
        state.calls.push({ type: 'tool', name, user })
        if (state.delay) await new Promise((done) => setTimeout(done, state.delay))
        if (state.businessFailure && name !== 'get_current_user_profile') {
          res.statusCode = 403
          value = { error: 'synthetic' }
        } else {
          const result =
            name === 'get_current_user_profile'
              ? [{ orgEmployeeModel: { corpId: state.corp, userId: state.wrongIdentity ? 'test-user-b' : user } }]
              : name === 'search_documents'
                ? {
                    success: true,
                    documents: [{ name: '合成文档', nodeId: 'synthetic-node' }],
                    hasMore: false,
                    nextPageToken: '',
                  }
                : { result: { items: [{ title: '合成日程' }] } }
          value = {
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
          }
        }
      } else throw new Error('unexpected synthetic request')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(value))
    } catch {
      res.statusCode = 500
      res.end('{}')
    }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    state,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}
export function tmpState() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-connector-'))
  return { root, stateDir: join(root, 'state') }
}
const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..', '..') // dsh-dingtalk
export const dwsBinary =
  process.env.DSH_TEST_DWS_BINARY || resolve(PACKAGE_ROOT, '.cache/dingtalk-g0/bin-amd64/dws.exe')
export const dwsLock = resolve(PACKAGE_ROOT, 'enhancements/dws.lock.json')
export const artifactAvailable = existsSync(dwsBinary)
export function dwsVersion() {
  try {
    return execFileSync(dwsBinary, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim()
  } catch {
    return ''
  }
}
export async function writeMcpUrl(stateDir, callerId, base) {
  const directory = join(stateDir, 'callers', callerId, 'dws')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'mcp_url'), base)
}
export function connectorEnv({
  synthetic,
  stateDir,
  port,
  oauthPort,
  extra = {},
  oauth = true,
  transport = 'loopback',
}) {
  const env = {
    DSH_CONNECTOR_STATE_DIR: stateDir,
    DSH_CONNECTOR_DWS_BINARY: dwsBinary,
    DSH_DINGTALK_DWS_LOCK: dwsLock,
    DSH_CONNECTOR_TRANSPORT: transport,
    ...(transport === 'loopback'
      ? { DSH_CONNECTOR_ALLOW_TEST_TRANSPORT: '1', DSH_CONNECTOR_LOOPBACK_PORT: String(port) }
      : {}),
    DSH_CONNECTOR_TEST_IDENTITY: '1',
    DSH_CONNECTOR_TEST_DWS_ENV: JSON.stringify({
      DWS_ALLOW_HTTP_ENDPOINTS: '1',
      DWS_TRUSTED_DOMAINS: '127.0.0.1',
      DINGTALK_CONTACT_MCP_URL: `${synthetic.base}/contact`,
      DINGTALK_CALENDAR_MCP_URL: `${synthetic.base}/calendar`,
      DINGTALK_DOC_MCP_URL: `${synthetic.base}/doc`,
      FAKE_DEVICE_URL: `${synthetic.base}/authorize?user_code=ABCD-EFGH`,
    }),
    ...(oauth
      ? {
          DSH_CONNECTOR_OAUTH_PUBLIC_ORIGIN: 'https://connector.test',
          DSH_CONNECTOR_OAUTH_LISTEN_PORT: String(oauthPort),
          DSH_CONNECTOR_OAUTH_TRUSTED_ORIGINS: 'https://dsh.example.test',
          DSH_CONNECTOR_CLIENT_ID: 'synthetic-app',
          DSH_CONNECTOR_SCOPES: 'openid corpid',
          DSH_CONNECTOR_TEST_PROVIDER_URL: `${synthetic.base}/authorize`,
        }
      : {}),
    ...extra,
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
}
function adminEndpoint(env, path) {
  return env.DSH_CONNECTOR_TRANSPORT === 'unix'
    ? { socketPath: join(env.DSH_CONNECTOR_STATE_DIR, 'admin', 'admin.sock'), path }
    : { host: '127.0.0.1', port: Number(env.DSH_CONNECTOR_LOOPBACK_PORT) + 1, path }
}
export function adminRequest(env, path, body = {}) {
  const payload = JSON.stringify(body)
  return new Promise((done, reject) => {
    const req = httpRequest(
      {
        ...adminEndpoint(env, path),
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          'x-dsh-connector-admin-token': env.__adminToken,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}
export async function adminToken(env) {
  return (await readFile(join(env.DSH_CONNECTOR_STATE_DIR, 'admin.token'), 'utf8')).trim()
}
export function businessRequest(env, callerId, path, method, payload, token) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const target =
    env.DSH_CONNECTOR_TRANSPORT === 'unix'
      ? { socketPath: join(env.DSH_CONNECTOR_STATE_DIR, 'sockets', callerId, 'dsh.sock'), path }
      : { host: '127.0.0.1', port: Number(env.DSH_CONNECTOR_LOOPBACK_PORT), path }
  return new Promise((done, reject) => {
    const headers = {
      ...(payload === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    }
    const req = httpRequest({ ...target, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          parsed = undefined
        }
        done({ status: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
/** Drive the HTTPS-bound server OAuth flow through the plain loopback listener with trusted proxy headers. */
export function browserFlow(env, authorizeUrl) {
  const oauthPort = Number(env.DSH_CONNECTOR_OAUTH_LISTEN_PORT)
  const startPath = new URL(authorizeUrl).pathname + new URL(authorizeUrl).search
  const step = (path, method, headers) =>
    new Promise((res, rej) => {
      const req = httpRequest({ host: '127.0.0.1', port: oauthPort, path, method, headers }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          res({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      })
      req.on('error', rej)
      req.end()
    })
  return (async () => {
    const start = await step(startPath, 'GET', { host: 'connector.test', 'x-forwarded-proto': 'https' })
    if (start.status !== 302) throw new Error(`start failed: ${start.status} ${start.body}`)
    const provider = new URL(start.headers.location)
    if (!provider.href.includes('user_code=ABCD-EFGH')) throw new Error(`unexpected device url: ${provider.href}`)
    return { start, provider }
  })()
}
export async function rmState(root) {
  await rm(root, { recursive: true, force: true })
}
