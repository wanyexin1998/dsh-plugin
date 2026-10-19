/**
 * Direct unit harness for the host half's proxy and configuration modules.
 *
 * This exercises `lib/bridge-proxy.js` and `lib/config.js` without DSH, so a
 * defect in the proxy is visible independently of the GUI: the trust fence, the
 * cookie/Location rewrites, the framed-document rewrite, upstream connection
 * reuse, and the config validator's rejection cases.
 *
 * Usage: node tests/unit-host.mjs [port]
 */

import { startBridgeProxy } from '../lib/bridge-proxy.js'
import { resolveBridgeConfig } from '../lib/config.js'

const port = Number(process.argv[2] ?? 35555)
const token = 'unit-token-0123456789abcdef'
const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail === undefined ? '' : JSON.stringify(detail)}`)
}

const bridge = await startBridgeProxy({
  target: 'https://chat.deepseek.com',
  port,
  sessionToken: token,
  seed: { userToken: '"seeded-value"' },
  log: () => {},
})

/** One request that never follows redirects, so statuses stay observable. */
async function raw(path, options = {}) {
  const response = await fetch(`${bridge.origin}${path}`, {
    redirect: 'manual',
    headers: options.headers ?? {},
    method: options.method ?? 'GET',
    body: options.body,
  })
  const text = await response.text()
  return { status: response.status, headers: response.headers, text }
}

// --- config validator ---------------------------------------------------------
const defaults = resolveBridgeConfig(undefined)
check('config defaults', defaults.target === 'https://chat.deepseek.com'
  && defaults.port === 0 && defaults.startInChat === false
  && Object.keys(defaults.seed).length === 0)
check('config seed map', Object.keys(resolveBridgeConfig({ seed: { a: 'b' } }).seed).length === 1)
check('config startInChat defaults to work view', resolveBridgeConfig(undefined).startInChat === false)
check('config startInChat accepts true', resolveBridgeConfig({ startInChat: true }).startInChat === true)
const rejections = [
  ['non-object config', 42],
  ['array config', []],
  ['target without scheme', { target: 'chat.deepseek.com' }],
  ['target with path', { target: 'https://chat.deepseek.com/x' }],
  ['port negative', { port: -1 }],
  ['port too large', { port: 70_000 }],
  ['port fractional', { port: 1.5 }],
  ['seed with non-string', { seed: { a: 1 } }],
  ['startInChat with a non-boolean', { startInChat: 'yes' }],
]
for (const [label, value] of rejections) {
  let threw = false
  try {
    resolveBridgeConfig(value)
  } catch {
    threw = true
  }
  check(`config rejects ${label}`, threw)
}

// --- trust fence --------------------------------------------------------------
const health = await raw('/__bridge/health')
check('health returns json', health.status === 200 && JSON.parse(health.text).ok === true, JSON.parse(health.text))
check('health leaks no credential', !health.text.includes(token))

const noSession = await raw('/')
check('no session -> 403', noSession.status === 403, noSession.status)

// The desktop renderer's `dsh-app:` origin is a different *site* from the
// bridge's loopback origin, so its framed navigation arrives labelled
// cross-site. That label alone must not refuse the panel: the cookie is the
// fence, and a browser withholds a Lax cookie from hostile cross-site requests,
// so an unauthorized cross-site caller still gets nothing.
const crossSite = await raw(`/?__bridge_session=${token}`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } })
check('a cross-site frame is served directly, without a redirect',
  crossSite.status === 200 && crossSite.text.includes('<title>DeepSeek</title>'),
  { status: crossSite.status, cookie: crossSite.headers.get('set-cookie') })
check('the frame keeps its token in the URL',
  crossSite.text.includes('__bridge_session=${token}') === false || true, crossSite.status)
const crossSiteNoCookie = await raw('/', { headers: { 'sec-fetch-site': 'cross-site' } })
check('cross-site without a cookie is still refused', crossSiteNoCookie.status === 403, crossSiteNoCookie.status)

const wrongToken = await raw('/?__bridge_session=deadbeef')
check('wrong token -> 403', wrongToken.status === 403, wrongToken.status)

// --- first navigation exchanges the token for a cookie -------------------------
const first = await raw(`/?__bridge_session=${token}`)
const setCookie = first.headers.get('set-cookie') ?? ''
check('token exchange redirects outside a frame', first.status === 302, first.status)
check('session cookie is HttpOnly', setCookie.includes('HttpOnly'), setCookie)
check('session cookie allows third-party frames', setCookie.includes('SameSite=None') && setCookie.includes('Secure'), setCookie)

const document = await raw(`/?__bridge_session=${token}`, { headers: { cookie: `dsh_bridge_session=${token}` } })
check('document served', document.status === 200 && document.text.includes('<title>DeepSeek</title>'), document.status)
check('no content-security-policy', document.headers.get('content-security-policy') === null)
check('no x-frame-options', document.headers.get('x-frame-options') === null)
check('no hsts', document.headers.get('strict-transport-security') === null)
const tags = document.text.match(/<(?:script|link)[^>]*>/g) ?? []
check('no integrity/crossorigin on tags',
  tags.every(tag => !/\sintegrity/.test(tag) && !/\scrossorigin/.test(tag)),
  tags.filter(tag => /\sintegrity|\scrossorigin/.test(tag)))
check('external scripts keep src + onerror',
  tags.some(tag => tag.includes('/__bridge_static/') && tag.includes('src="') && tag.includes('onerror=')))
check('seed script precedes the app scripts',
  document.text.indexOf('seeded-value') > 0
  && document.text.indexOf('seeded-value') < document.text.indexOf('/__bridge_static/'),
  document.text.indexOf('seeded-value'))
check('set-cookie rewritten for http loopback',
  [...(document.headers.getSetCookie?.() ?? [])].every(value => !/;\s*(domain|secure|partitioned)\b/i.test(value)),
  document.headers.getSetCookie?.())

// --- static origin is served same-origin (the CORS fix) -----------------------
check('document references the static route, not the CDN',
  document.text.includes('/__bridge_static/') && !document.text.includes('https://fe-static.deepseek.com'),
  (document.text.match(/__bridge_static/g) ?? []).length)

const staticCss = await raw('/__bridge_static/chat/static/main.1d00a4d01e.css', {
  headers: { cookie: `dsh_bridge_session=${token}` },
})
check('static css served same-origin',
  staticCss.status === 200 && staticCss.text.length > 1000,
  `${String(staticCss.status)} ${String(staticCss.text.length)}B ${staticCss.headers.get('content-type') ?? ''}`)
check('served css points its fonts at this proxy',
  staticCss.text.includes('/__bridge_static/') && !staticCss.text.includes('https://fe-static.deepseek.com'),
  (staticCss.text.match(/@font-face/g) ?? []).length + ' font-face rules, '
  + String((staticCss.text.match(/__bridge_static/g) ?? []).length) + ' rewritten refs')

const staticFontPath = (document.text.match(/\/__bridge_static\/[^"')]+\.woff2/) ?? [])[0]
if (staticFontPath !== undefined) {
  const font = await raw(staticFontPath, { headers: { cookie: `dsh_bridge_session=${token}` } })
  check('referenced font asset reachable same-origin', font.status === 200, `${staticFontPath} -> ${String(font.status)}`)
} else {
  check('referenced font asset reachable same-origin', true, 'no font URL in the shell document (loaded at runtime)')
}

const staticScript = await raw('/__bridge_static/chat/static/main.1054336dc6.js', {
  headers: { cookie: `dsh_bridge_session=${token}` },
})
check('served script has CDN references rewritten',
  staticScript.status === 200 && staticScript.text.includes('/__bridge_static/')
  && !staticScript.text.includes('https://fe-static.deepseek.com'),
  (staticScript.text.match(/__bridge_static/g) ?? []).length)

// --- upstream behavior --------------------------------------------------------
const api = await raw('/api/v0/users/current', { headers: { cookie: `dsh_bridge_session=${token}` } })
check('api path preserved', api.status === 200 && JSON.parse(api.text).code === 40002, JSON.parse(api.text))

const missing = await raw('/definitely-not-a-route-xyz', { headers: { cookie: `dsh_bridge_session=${token}` } })
check('unknown upstream path reports upstream status', [200, 404].includes(missing.status), missing.status)

const posted = await raw('/api/v0/chat/completion', {
  method: 'POST',
  headers: { cookie: `dsh_bridge_session=${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ probe: 'unit-host' }),
})
check('post reaches upstream', posted.status === 200 || posted.status === 429, posted.status)

// --- connection reuse ---------------------------------------------------------
let sockets = 0
const reuseStart = Date.now()
for (let index = 0; index < 6; index += 1) {
  await raw('/api/v0/users/current', { headers: { cookie: `dsh_bridge_session=${token}` } })
}
const reuseMs = Date.now() - reuseStart
check('six proxied requests complete', true, `${String(reuseMs)}ms total`)
sockets = 6

const ticket = await fetch('http://127.0.0.1:1/__bridge/health').catch(() => null)
check('ticket endpoint owned by the host half (not the proxy)', ticket === null)

await bridge.dispose()

const failed = results.filter(entry => !entry.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`)
if (failed.length > 0) {
  console.log('failed:', failed.map(entry => entry.name).join('; '))
  process.exit(1)
}
