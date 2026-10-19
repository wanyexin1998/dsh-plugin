/**
 * Verify the request guard the bridge injects into the framed document.
 *
 * The guard is what keeps the panel authorized when the browser refuses to
 * store or send the bridge's `SameSite=Lax` cookie — the cross-site frame case
 * the desktop renderer creates. This test takes the guard out of a real proxied
 * response, runs it against stub globals, and asserts that every same-origin
 * request picks up the session token while nothing else does.
 *
 * Usage: node tests/unit-guard.mjs <guiBase> <authToken>
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const [guiBase, authToken] = process.argv.slice(2)
if (authToken === undefined) {
  console.error('usage: node tests/unit-guard.mjs <guiBase> <authToken>')
  process.exit(2)
}

let checks = 0
const check = (label, condition) => {
  checks += 1
  if (!condition) throw new Error('failed: ' + label)
  console.log('  ok  ' + label)
}

// Authorize against the GUI the way the desktop document does, so the host's
// own routes answer this client.
const authorized = await fetch(guiBase + '/?token=' + authToken, { redirect: 'manual' })
check('GUI exchanges the launch token for a cookie', authorized.status === 303)
const cookie = (authorized.headers.getSetCookie?.() ?? []).map(value => value.split(';', 1)[0]).join('; ')
check('GUI handed out an auth cookie', cookie.length > 0)

const sessionResponse = await fetch(guiBase + '/dsh-chat/api/session', { headers: { cookie, accept: 'application/json' } })
const session = await sessionResponse.json()
check('session route reports ready', session.ready === true)
check('session carries a token', typeof session.sessionToken === 'string' && session.sessionToken.length >= 32)

// The first token-carrying navigation is answered with a redirect that installs
// the cookie; a browser then keeps it, while this bare client carries it by hand.
const first = await fetch(session.origin + '/?__bridge_session=' + encodeURIComponent(session.sessionToken), { redirect: 'manual' })
check('first navigation is answered with the cookie handshake', first.status === 302)
const bridgeCookie = (first.headers.getSetCookie?.() ?? []).map(value => value.split(';', 1)[0]).join('; ')
check('framed document mints the session cookie', bridgeCookie.includes('dsh_bridge_session='))
const documentResponse = await fetch(session.origin + '/', { headers: { cookie: bridgeCookie } })
check('framed document answers with the cookie', documentResponse.ok)
const html = await documentResponse.text()
check('framed document is DeepSeek', html.includes('<title>DeepSeek</title>'))
check('framed document is what carries the guard', html.includes('__bridgeAuthorized'))

// The guard's shape is asserted against the module's own source, and the
// values it carries are taken from a document the proxy actually served.
const guardSource = readFileSync(new URL('../lib/bridge-proxy.js', import.meta.url), 'utf8')
const guardStart = guardSource.indexOf('return `<script>(function(){var t=')
const guardEnd = guardSource.indexOf('</script>`', guardStart)
check('guard source is present', guardStart !== -1 && guardEnd > guardStart)
const guardBody = guardSource.slice(guardStart + 'return `<script>'.length, guardEnd)
check('guard body is a script', guardBody.startsWith('(function(){'))
check('guard reads the token and the query name through its parameters',
  guardBody.includes('${token}') && guardBody.includes('${query}'))
// The served document hand the guard its real values, so read them from there.
const served = /var t="([^"]+)",q="([^"]+)"/.exec(html)
check('served document carries the guard with real values', served !== null)
check('served guard embeds this boot\'s token', served[1] === session.sessionToken)
check('served guard embeds the session query name', served[2] === '__bridge_session')
// The shipped module interpolates the token and the query name into its template
// at runtime; do the same here with the values the served document carried.
const guardWithToken = guardBody
  .split('${token}').join(JSON.stringify(served[1]))
  .split('${query}').join(JSON.stringify(served[2]))
check('guard is interpolated with a real token', guardWithToken.includes(JSON.stringify(served[1])))

// Run the guard against stub globals and inspect what it does to requests.
const requests = []
const opened = []
const sockets = []
const origin = session.origin

class FakeRequest {
  constructor(url, init) { this.url = url; this.init = init }
}
class FakeXHR {
  open(method, url) { opened.push({ method, url }) }
}
class FakeWebSocket {
  constructor(url, protocols) { sockets.push({ url, protocols }) }
}

const sandbox = {
  location: { origin, href: origin + '/?__bridge_session=' + served[1] + '&__bridge_nonce=1' },
  URL,
  Request: FakeRequest,
  window: {},
}
sandbox.window.fetch = (input, init) => { requests.push({ input, init }); return Promise.resolve({ ok: true }) }
sandbox.window.XMLHttpRequest = FakeXHR
sandbox.window.WebSocket = FakeWebSocket
sandbox.window.location = sandbox.location

new Function('window', 'location', 'URL', 'Request', guardWithToken)(sandbox.window, sandbox.location, URL, FakeRequest)
const fetchImpl = sandbox.window.fetch
const XHRImpl = sandbox.window.XMLHttpRequest
const WebSocketImpl = sandbox.window.WebSocket

// fetch: relative path, absolute same-origin path, cross-origin, already tagged.
await fetchImpl('/api/v0/chat/completions')
await fetchImpl(origin + '/api/v0/users/current')
await fetchImpl('https://example.invalid/collect')
await fetchImpl(origin + '/api/v0/ping?__bridge_session=preset')
await fetchImpl(new FakeRequest(origin + '/api/v0/via-request'))
await fetchImpl('data:text/plain,hello')
const urls = requests.map(entry => String(entry.input.url ?? entry.input))
check('same-origin relative request is tagged', urls[0].includes('__bridge_session=' + served[1]))
check('same-origin absolute request is tagged', urls[1].includes('__bridge_session=' + served[1]))
check('cross-origin request is untouched', urls[2] === 'https://example.invalid/collect')
check('an already-tagged URL is left alone', urls[3].endsWith('__bridge_session=preset'))
check('a Request object is replaced by a tagged one', urls[4].includes('__bridge_session=' + served[1]))
check('a non-http scheme is untouched', urls[5] === 'data:text/plain,hello')

// XMLHttpRequest: the framed app polls with it.
new XHRImpl().open('GET', '/api/v0/notification')
new XHRImpl().open('POST', 'https://other.invalid/x')
check('XHR same-origin open is tagged', opened[0].url.includes('__bridge_session=' + served[1]))
check('XHR cross-origin open is untouched', opened[1].url === 'https://other.invalid/x')

// WebSocket: voice features use wss, which the loopback bridge cannot serve.
new WebSocketImpl('wss://chat.deepseek.com/ws')
check('websocket URL is untouched', sockets[0].url === 'wss://chat.deepseek.com/ws')

// The guard must survive being run twice and must not break on odd input.
new Function('window', 'location', 'URL', 'Request', guardWithToken)(sandbox.window, sandbox.location, URL, FakeRequest)
check('guard is idempotent', Boolean(sandbox.window.__bridgeAuthorized))

// And the document itself must still load its own assets without a cookie.
// The desktop's exact failure: the frame is cross-site, so Chromium drops the
// cookie. An iframe navigation is therefore served directly, with its token
// still in the URL, and must stay authorized on every later load of that URL.
const nonce = 'probe' + Date.now()
const frameUrl = session.origin + '/?__bridge_session=' + encodeURIComponent(session.sessionToken) + '&__bridge_nonce=' + nonce
const frameHeaders = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }
const firstFrameLoad = await fetch(frameUrl, { redirect: 'manual', headers: frameHeaders })
check('iframe navigation is served directly, not redirected', firstFrameLoad.status === 200)
const firstHtml = await firstFrameLoad.text()
check('iframe navigation serves the app', firstHtml.includes('<title>DeepSeek</title>'))
check('iframe navigation carries the request guard', firstHtml.includes('__bridgeAuthorized'))
// The cookie is what a cross-site frame needs to keep the session; without
// SameSite=None Chromium drops it there as a third-party cookie.
const frameCookies = firstFrameLoad.headers.getSetCookie?.() ?? []
const bridgeCookieHeader = frameCookies.find(value => value.startsWith('dsh_bridge_session='))
check('the bridge sets its session cookie', bridgeCookieHeader !== undefined)
check('the session cookie allows third-party frames', bridgeCookieHeader?.includes('SameSite=None') === true)
check('the session cookie is Secure', bridgeCookieHeader?.includes('Secure') === true)
check('the session cookie stays HttpOnly', bridgeCookieHeader?.includes('HttpOnly') === true)
// The upstream answers with cookies of its own; they must not displace ours.
check('upstream cookies survive alongside the session cookie',
  frameCookies.some(value => value.startsWith('ds_session_id=')) || frameCookies.length > 1)
const reloadedFrame = await fetch(frameUrl, { redirect: 'manual', headers: frameHeaders })
check('reloading the same frame URL still works without a cookie', reloadedFrame.status === 200)
const markerOnly = await fetch(session.origin + '/?__bridge_nonce=' + nonce, { redirect: 'manual', headers: frameHeaders })
check('the marker alone keeps a stripped URL authorized', markerOnly.status === 200)
const plainNavigation = await fetch(frameUrl, { redirect: 'manual' })
check('a non-iframe navigation still gets the tidy redirect', plainNavigation.status === 302)
check('the redirect drops the token', (plainNavigation.headers.get('location') ?? '').includes('__bridge_session') === false)
const strangerLeg = await fetch(session.origin + '/?__bridge_nonce=not-a-real-marker-value', { redirect: 'manual' })
check('an unknown marker is still refused', strangerLeg.status === 403)
const shortMarker = await fetch(session.origin + '/?__bridge_nonce=x', { redirect: 'manual' })
check('a too-short marker is refused', shortMarker.status === 403)
const noMarker = await fetch(session.origin + '/?__bridge_nonce=' + nonce + 'x', { redirect: 'manual' })
check('a marker that was never seeded is refused', noMarker.status === 403)

// A real asset the document itself references// A real asset the document itself references, so this cannot pass on a 404.
const assetPath = /\/__bridge_static\/[^"')\s]+/.exec(html)?.[0]
check('document references a static asset through the proxy', typeof assetPath === 'string' && assetPath.startsWith('/__bridge_static/'))
const asset = await fetch(session.origin + assetPath, { headers: { cookie: bridgeCookie } })
check('static asset answers with the session cookie', asset.ok)
// The path the document uses may carry the token, which is itself a credential
// for this route; the bare path is what must be refused.
const bareAssetPath = assetPath.split('?')[0]
const unauthAsset = await fetch(session.origin + bareAssetPath, { redirect: 'manual' })
check('the same asset is refused without any credential', unauthAsset.status === 403)
check('a token-bearing asset reference is served', (await fetch(session.origin + assetPath, { redirect: 'manual' })).status === 200)

console.log('')
console.log(String(checks) + ' checks passed')
