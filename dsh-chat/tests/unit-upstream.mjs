/**
 * Controlled-upstream tests for the bridge proxy.
 *
 * The production upstream only emits root-relative redirects and lives on
 * https:443, so two behaviours cannot be observed against it: absolute
 * `Location` rewriting, and honouring the configured target's scheme and port.
 * This harness runs its own HTTP origin and points the proxy at it.
 *
 * Usage: node tests/unit-upstream.mjs
 */

import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { startBridgeProxy } from '../lib/bridge-proxy.js'

const token = 'controlled-upstream-token'
const received = []
const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

/** A minimal origin that answers the routes under test. */
const upstream = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, host: req.headers.host, referer: req.headers.referer, body: Buffer.concat(chunks).toString('utf8') })
    const path = new URL(req.url, 'http://upstream.invalid').pathname
    if (path === '/absolute-redirect') {
      res.writeHead(302, { location: `${origin}/sign_in?from=absolute` })
      res.end()
    } else if (path === '/moved') {
      res.writeHead(307, { location: `${origin}/chat` })
      res.end()
    } else if (path === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString('utf8') }))
    } else if (path === '/set-cookie') {
      res.writeHead(200, { 'set-cookie': ['a=1; Domain=.example.com; Secure; Path=/; HttpOnly; SameSite=Strict; Partitioned'], 'content-type': 'text/plain' })
      res.end('cookie')
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found upstream')
    }
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port
const origin = `http://127.0.0.1:${upstreamPort}`

// A deliberate http: + non-443 target, which used to be dialled over TLS on 443.
const bridge = await startBridgeProxy({ target: origin, port: 0, sessionToken: token })
const cookie = { cookie: `dsh_bridge_session=${token}` }

/**
 * One request through node:http rather than fetch. undici's teardown aborts
 * under Node 24 on Windows when a closed server is in the same process, which
 * would replace this harness's exit status with a crash.
 */
function call(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        location: res.headers.location,
        setCookie: res.headers['set-cookie'] ?? [],
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** One proxied request without following redirects. */
const get = (path, headers = cookie) => call(`${bridge.origin}${path}`, { headers })

const echo = await get('/echo')
check('plain request reaches the configured origin', echo.status === 200 && received.at(-1)?.host === `127.0.0.1:${String(upstreamPort)}`,
  { status: echo.status, upstreamHost: received.at(-1)?.host, upstreamPort, expectedHost: `127.0.0.1:${String(upstreamPort)}` })
check('referer is rewritten to the upstream origin',
  String(received.at(-1)?.referer ?? '').startsWith(origin), received.at(-1)?.referer)

const posted = await get('/echo')
check('post body forwarded', posted.status === 200)
const post = await call(`${bridge.origin}/echo`, {
  method: 'POST',
  headers: { ...cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ hello: 'world' }),
})
check('post payload arrives byte-exact', JSON.parse(post.text).body === '{"hello":"world"}', post.text)

const absolute = await get('/absolute-redirect')
check('absolute Location rewritten to the bridge origin',
  absolute.status === 302 && absolute.location === `${bridge.origin}/sign_in?from=absolute`,
  { status: absolute.status, location: absolute.location })

const moved = await get('/moved')
check('second absolute Location also rewritten', moved.location === `${bridge.origin}/chat`, moved.location)

const missing = await get('/nothing-here')
check('upstream 404 passes through with its body', missing.status === 404 && missing.text === 'not found upstream',
  { status: missing.status, body: missing.text })

const cookies = await get('/set-cookie')
check('Domain/Secure/Partitioned stripped from set-cookie',
  cookies.setCookie.length > 0 && cookies.setCookie.every(value => !/;\s*(domain|secure|partitioned)\b/i.test(value)),
  cookies.setCookie)

await bridge.dispose()
await new Promise(resolve => upstream.close(resolve))

const failed = results.filter(entry => !entry.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
// Exit rather than drain: undici's fetch teardown plus a closed server aborts
// under Node 24 on Windows (libuv async.c:94), and a pending timer would let
// that abort replace this run's exit status.
if (failed.length > 0) {
  console.log('failed:', failed.map(entry => entry.name).join('; '))
}
process.exit(failed.length === 0 ? 0 : 1)
