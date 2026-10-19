/**
 * Loopback reverse proxy for `https://chat.deepseek.com`.
 *
 * The DeepSeek Chat web app refuses to be framed (`content-security-policy:
 * frame-ancestors 'none'`), so the bridge cannot embed the origin directly.
 * This proxy serves the same site from `http://127.0.0.1:<port>` and removes
 * the headers that make framing impossible, which lets the plugin render the
 * real web app inside a DSH panel. Everything else is passed through: bodies
 * stream unmodified (SSE included), upstream TLS connections are pooled, and
 * the process keeps no credential of its own — it borrows whatever session the
 * bridging browser already holds for the loopback origin.
 *
 * Trust: the listener binds loopback only, and every request must carry the
 * bridge session cookie that `dsh-chat` minted for this boot.
 * A foreign local process that has not been handed the token is answered 403.
 */

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Agent as HttpAgent } from 'node:http'
import { request, Agent as HttpsAgent } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEALTH_PATH, NONCE_QUERY, SESSION_COOKIE, SESSION_QUERY, TICKET_QUERY } from './shared.js'

/** Response headers that make third-party framing impossible, or that would break an http origin. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
])

/** Request headers the proxy owns; the browser's loopback values never reach the upstream. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
  'transfer-encoding', 'accept-encoding', 'origin', 'referer', 'cookie',
  'content-length', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
])

/** Hop-by-hop response headers that must not be forwarded verbatim. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade'])

/**
 * The chat app's static origin. Its responses are fetched in CORS mode for
 * fonts and WebAssembly, and the CDN answers `access-control-allow-origin:
 * https://*.deepseek.com` — a literal value that can never match a loopback
 * origin, so those requests fail whenever the app is framed. Scripts and
 * stylesheets survive without CORS only because the attribute strip above
 * makes them no-cors; fonts and `fetch()`ed wasm cannot be rescued that way.
 * Serving the same assets under this proxy keeps them same-origin, which makes
 * the CORS check moot. Absolute references in the document and in every script
 * body are rewritten to this prefix.
 */
const STATIC_UPSTREAM_ORIGIN = 'https://fe-static.deepseek.com'

/** Same-origin prefix that mirrors {@link STATIC_UPSTREAM_ORIGIN}. */
const STATIC_ROUTE_PREFIX = '/__bridge_static'

/**
 * The bridge's own session cookie.
 *
 * `SameSite=None` is what lets it into the panel's cross-site frame at all; with
 * `Lax` Chromium treats it as third-party and drops it, and the frame is left
 * with nothing to authorize it. `None` requires `Secure`, which Chromium accepts
 * on loopback because it treats `http://127.0.0.1` as a trustworthy origin. The
 * cookie stays `HttpOnly` and is still minted per boot, so the token itself
 * remains the only thing that authorizes a first request.
 */
function sessionCookie(sessionToken) {
  return `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=None; Secure`
}

/**
 * Where the optional request trace goes, or null when it is off.
 *
 * Set `DSH_BRIDGE_TRACE` to a file path to record every request the bridge
 * receives: the path, whether the session token or the cookie arrived, and what
 * the browser said about the request's origin. It is off by default because it
 * writes to disk on every request.
 */
const TRACE_PATH = typeof process.env.DSH_BRIDGE_TRACE === 'string' && process.env.DSH_BRIDGE_TRACE.trim() !== ''
  ? process.env.DSH_BRIDGE_TRACE.trim()
  : join(tmpdir(), 'dsh-bridge-trace.jsonl')

/** Append one line describing how a request was answered, best effort. */
function traceResponse(status, url) {
  try {
    appendFileSync(TRACE_PATH, JSON.stringify({
      at: new Date().toISOString(),
      kind: 'response',
      status,
      path: url.pathname,
      query: [...url.searchParams.keys()],
    }) + '\n')
  } catch {
    // A trace that cannot be written must never affect the request.
  }
}

/** Append one line describing a received request, best effort. */
function traceRequest(req, url) {
  try {
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      query: [...url.searchParams.keys()],
      hasToken: url.searchParams.has(SESSION_QUERY),
      hasNonce: url.searchParams.has(NONCE_QUERY),
      hasCookie: headerOf(req.headers, 'cookie') !== undefined,
      cookieHasSession: (headerOf(req.headers, 'cookie') ?? '').includes(SESSION_COOKIE + '='),
      fetchSite: headerOf(req.headers, 'sec-fetch-site') ?? null,
      fetchDest: headerOf(req.headers, 'sec-fetch-dest') ?? null,
      fetchMode: headerOf(req.headers, 'sec-fetch-mode') ?? null,
      origin: headerOf(req.headers, 'origin') ?? null,
      referer: headerOf(req.headers, 'referer') ?? null,
      accept: headerOf(req.headers, 'accept') ?? null,
    }
    appendFileSync(TRACE_PATH, JSON.stringify(entry) + '\n')
  } catch {
    // A trace that cannot be written must never affect the request.
  }
}

/** Absolute references to the static origin inside HTML, scripts, and JSON. */
const STATIC_ABSOLUTE_REFERENCE = /https?:\/\/fe-static\.deepseek\.com/gi

/** Root-relative paths the static host also serves (`/chat/...`, `/static/...`). */
const STATIC_ROOT_RELATIVE_ASSET = /(["'(])\/(?:static|chat)\//g

/**
 * Attributes whose presence breaks the CDN handshake under a loopback origin:
 * `integrity` fails because the CDN only allows DeepSeek origins, and
 * `crossorigin` forces a CORS preflight the CDN answers without the loopback
 * origin. The bytes of the script are untouched, so dropping the attributes
 * changes nothing about what executes.
 */
const FRAMED_TAG_ATTRIBUTES = /\s(?:integrity|crossorigin)(?:="[^"]*")?/gi

/** Case-insensitive header lookup on a Node header bag. */
function headerOf(headers, name) {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Rewrite one `set-cookie` value for an http loopback origin: `Domain` and
 * `Secure` would make the browser drop it, and a `Strict` session cookie would
 * not survive the cross-site frame the panel creates.
 */
function rewriteSetCookie(value) {
  return value
    .split(';')
    .map(part => part.trim())
    .filter(part => {
      const name = part.split('=', 1)[0].trim().toLowerCase()
      return part !== '' && name !== 'domain' && name !== 'secure' && name !== 'partitioned'
    })
    .map(part => (part.toLowerCase().startsWith('samesite=strict') ? 'SameSite=Lax' : part))
    .join('; ')
}

/**
 * Map an absolute upstream redirect back onto the loopback origin.
 *
 * The comparison is on parsed origins, not string prefixes: a prefix test would
 * also match a look-alike host such as `https://chat.deepseek.com.evil.example/`
 * and turn it into a same-origin URL. A `Location` that is not an absolute URL
 * on the route's own origin (root-relative, or another host) is left untouched.
 *
 * @param value - the upstream `Location` header.
 * @param localOrigin - this proxy's own origin.
 * @param upstreamOrigin - the origin the response came from, per route.
 * @returns the redirect the framing browser must follow.
 */
function rewriteLocation(value, localOrigin, upstreamOrigin) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    // A relative Location is already correct for the framing browser.
    return value
  }
  if (parsed.origin !== upstreamOrigin) return value
  return `${localOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/**
 * Build the framed document: drop the CDN-breaking attributes, point every
 * static reference at this proxy, then append the scripts that keep the framed
 * app authorized, and the configured storage seed before anything else runs.
 *
 * @param html - the upstream document.
 * @param seed - optional storage seed.
 * @param sessionToken - the per-boot token; when present, the document carries a
 *   guard that tags its own requests with it.
 */
function rewriteDocument(html, seed, sessionToken) {
  const framed = html
    .replace(FRAMED_TAG_ATTRIBUTES, '')
    .replace(STATIC_ABSOLUTE_REFERENCE, STATIC_ROUTE_PREFIX)
    .replace(STATIC_ROOT_RELATIVE_ASSET, `$1${STATIC_ROUTE_PREFIX}/`)
  let out = framed
  if (sessionToken !== undefined) {
    // The browser fetches icons and the web-app manifest on its own: no script
    // runs for them, so the request guard cannot tag them. Their URLs are
    // rewritten here to carry the token instead.
    out = out.replace(
      /(<link[^>]+rel="(?:icon|shortcut icon|apple-touch-icon|manifest)"[^>]*?href=")([^"]+)(")/gi,
      (whole, before, url, after) => before + url + (url.includes('?') ? '&' : '?') + SESSION_QUERY + '=' + encodeURIComponent(sessionToken) + after)
    const guard = requestGuardScript(sessionToken)
    out = out.includes('<head>') ? out.replace('<head>', `<head>${guard}`) : `${guard}${out}`
  }
  if (seed === undefined) return out
  const payload = JSON.stringify(seed).replace(/</g, '\\u003c')
  const script = `<script>(function(){try{var s=${payload};if(s.localStorage)for(var k in s.localStorage)localStorage.setItem(k,s.localStorage[k]);if(s.sessionStorage)for(var k in s.sessionStorage)sessionStorage.setItem(k,s.sessionStorage[k])}catch(e){}})()</script>`
  return out.includes('<head>') ? out.replace('<head>', `<head>${script}`) : `${script}${out}`
}

/**
 * A bootstrap that keeps the framed app authorized without relying on cookies.
 *
 * The panel is a cross-site frame: the desktop renderer's origin is not the same
 * site as the bridge's loopback origin, so the bridge's `SameSite=Lax` cookie is
 * third-party there. Chromium may refuse to store or send it, and then the
 * request that follows the proxy's own token-stripping redirect arrives with
 * nothing to authorize it — the panel answers `bridge: no-session` while the
 * same code works in a browser whose page sits on the bridge origin.
 *
 * The document is already authorized when it is written, so it can hand its own
 * token to its runtime: every same-origin `fetch`, `XMLHttpRequest` and
 * `WebSocket` then carries the session in its URL. The token stays confined to
 * the loopback bridge — the page never crosses origins with it — and the cookie
 * path is untouched for deployments where it works.
 *
 * @param sessionToken - the per-boot session token.
 * @returns an inline script tag to place at the top of the document.
 */
function requestGuardScript(sessionToken) {
  const token = JSON.stringify(sessionToken).replace(/</g, '\\u003c')
  const query = JSON.stringify(SESSION_QUERY)
  return `<script>(function(){var t=${token},q=${query},o=location.origin;
function tagged(u){try{var a=new URL(typeof u==='string'?u:String(u),location.href);
if(a.origin!==o||a.searchParams.has(q))return null;a.searchParams.set(q,t);return a.href}catch(e){return null}}
var f=window.fetch;
if(f)window.fetch=function(i,n){try{if(typeof i==='string'){var g=tagged(i);if(g!==null)i=g}
else if(i&&i.url){var h=tagged(i.url);if(h!==null)i=new Request(h,i)}}catch(e){}return f.call(this,i,n)};
var X=window.XMLHttpRequest;
if(X&&X.prototype&&X.prototype.open){var op=X.prototype.open;
X.prototype.open=function(m,u){var g=tagged(u);return arguments.length>2?op.call(this,m,g===null?u:g,arguments[2]):op.call(this,m,g===null?u:g)}}
var W=window.WebSocket;
if(W){var G=function(u,p){var g=tagged(u);return p===undefined?new W(g===null?u:g):new W(g===null?u:g,p)};
G.prototype=W.prototype;try{Object.defineProperty(G,'name',{value:'WebSocket'})}catch(e){}window.WebSocket=G}
try{window.__bridgeAuthorized=!0}catch(e){}})()</script>`
}

/**
 * Rewrite the static origin out of a text asset body. The app builds static
 * URLs at runtime in its scripts, and its stylesheets declare `@font-face`
 * sources on the static origin; both have to point back at this proxy, because
 * the CDN answers every CORS-mode request from a loopback origin with
 * `access-control-allow-origin: https://*.deepseek.com`, which can never match.
 */
function rewriteTextAsset(body) {
  return body.replace(STATIC_ABSOLUTE_REFERENCE, STATIC_ROUTE_PREFIX)
}

/** Whether a response body is a text asset this proxy rewrites. */
function isRewritableTextType(contentType) {
  const essence = contentType.split(';', 1)[0].trim().toLowerCase()
  return essence === 'text/javascript' || essence === 'application/javascript' || essence === 'text/ecmascript'
    || essence === 'text/css'
}

/** Decode a response body according to its `content-encoding` so it can be rewritten. */
function decodeBody(buffer, encoding) {
  const value = String(encoding ?? '').toLowerCase()
  if (value === 'gzip' || value === 'x-gzip') return gunzipSync(buffer)
  if (value === 'deflate') return inflateSync(buffer)
  if (value === 'br') return brotliDecompressSync(buffer)
  return buffer
}

/**
 * Start the bridge listener.
 *
 * @param options - bridge configuration.
 * @param options.target - upstream origin, e.g. `https://chat.deepseek.com`.
 * @param options.port - loopback port; `0` asks the OS for a free one.
 * @param options.sessionToken - secret every proxied request must present.
 * @param options.ticketTtlMs - lifetime of a one-shot external-open ticket.
 * @param options.seed - optional storage values installed into the framed document.
 * @param options.log - diagnostic sink for refused or failed requests.
 * @param options.server - an already-listening loopback server to reuse; the
 * caller owns the chosen port in that case and `options.port` is ignored.
 * @returns the listening origin, the effective port, and a disposer.
 */
export async function startBridgeProxy(options) {
  const { target, sessionToken, seed, log = () => {} } = options
  const ticketTtlMs = options.ticketTtlMs ?? 120_000
  const targetUrl = new URL(target)
  const staticUrl = new URL(STATIC_UPSTREAM_ORIGIN)
  // One pool per protocol: an http target and an https target cannot share
  // sockets, and the static origin is always https.
  const agent = targetUrl.protocol === 'http:'
    ? new HttpAgent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12, maxFreeSockets: 6, timeout: 60_000 })
    : new HttpsAgent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 12, maxFreeSockets: 6, timeout: 60_000 })
  /** Pool for the static origin; it is a different host with its own sockets. */
  const staticAgent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 16,
    maxFreeSockets: 8,
    timeout: 60_000,
  })
  /** One-shot tickets minted for an externally opened bridge window. */
  const tickets = new Map()
  /**
   * Navigation markers that were authorized with the session token, oldest
   * first. They let a frame whose cookie was refused stay authorized without
   * keeping the token itself in the address bar.
   */
  const navigations = new Map()
  const navOrder = []
  const MAX_NAVIGATIONS = 64

  // The listener is attached here, after `handle` is defined below, and
  // regardless of whether the caller supplied an already-bound server: a
  // server handed over by the caller has no request listener of its own, and
  // forgetting this makes every request hang until the client gives up.
  const server = options.server ?? createServer()
  server.on('request', (req, res) => {
    void handle(req, res)
  })
  // Long-lived SSE turns must not be cut by a socket idle timeout.
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  /** Serve the proxy's own health document (never forwarded upstream). */
  function health(res) {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ ok: true, upstream: targetUrl.origin, port }))
  }

  /** Reject a request that does not belong to this browser session. */
  function refuse(res, status, code) {
    res.statusCode = status
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end(`bridge: ${code}`)
  }

  /** Read the bridge session cookie out of the request's cookie header. */
  function cookieToken(req) {
    const header = headerOf(req.headers, 'cookie')
    if (header === undefined) return undefined
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=')
      if (name === SESSION_COOKIE) return rest.join('=')
    }
    return undefined
  }

  /** Consume a one-shot external-open ticket, if the request carries a valid one. */
  function consumeTicket(req) {
    const url = new URL(String(req.url), `http://127.0.0.1:${port}`)
    const value = url.searchParams.get(TICKET_QUERY)
    if (value === null) return undefined
    const expiresAt = tickets.get(value)
    if (expiresAt === undefined) return undefined
    tickets.delete(value)
    if (expiresAt < Date.now()) return undefined
    return value
  }

  /**
   * Whether this URL names a navigation the proxy already authorized.
   *
   * The panel's frame is cross-site, so Chromium refuses to store the bridge's
   * `SameSite=Lax` cookie there — measured on the desktop, the redirect that
   * carries the cookie away arrives with no cookie at all. The navigation marker
   * is therefore remembered: the first request carries the session token and
   * seeds it, and later requests carrying only the marker stay authorized.
   *
   * Seeding requires the token, so a hostile page cannot mint a marker; and the
   * marker is a value the client generated, not a guessable constant.
   */
  function navigationAuthorized(req, url) {
    const nonce = url.searchParams.get(NONCE_QUERY)
    if (nonce === null || nonce.length < 8 || nonce.length > 128) return false
    return navigations.has(nonce)
  }

  /** Remember a navigation marker, bounded so a long session cannot grow it. */
  function rememberNavigation(url, seed) {
    const nonce = url.searchParams.get(NONCE_QUERY)
    if (nonce === null || nonce.length < 8 || nonce.length > 128) return undefined
    if (!navigations.has(nonce)) {
      navOrder.push(nonce)
      while (navOrder.length > MAX_NAVIGATIONS) {
        const oldest = navOrder.shift()
        if (oldest !== undefined) navigations.delete(oldest)
      }
    }
    navigations.set(nonce, seed)
    return nonce
  }

  async function handle(req, res) {
    try {
      const url = new URL(String(req.url), `http://127.0.0.1:${port}`)

      if (url.pathname === HEALTH_PATH) {
        health(res)
        return
      }

      // Optional request trace, off unless the operator asks for it. A refusal
      // says only that nothing authorized the request; what the framing client
      // actually sent — token or cookie or neither — is what identifies the
      // cause, and that is exactly what this records.
      if (TRACE_PATH !== null) {
        traceRequest(req, url)
        res.once('finish', () => { traceResponse(res.statusCode, url) })
      }

      // The session cookie is the whole trust fence: it is minted per boot, it
      // is HttpOnly, and `SameSite=Lax` keeps a browser from attaching it to any
      // genuine cross-site request, so guessing the token is the only way in.
      //
      // A `Sec-Fetch-Site` rejection deliberately does NOT sit here. The desktop
      // renderer's own origin is the `dsh-app:` scheme, which is not the same
      // *site* as the bridge's loopback origin, so the browser labels the
      // plugin's legitimately framed navigation `cross-site` and such a rule
      // would refuse the panel on every desktop launch. Nothing is given up: a
      // hostile page cannot reach an authorized response anyway, because the
      // browser withholds a Lax cookie from the cross-site requests it makes.
      let authorized = cookieToken(req) === sessionToken
      // The CDN mirror serves fonts, scripts, styles and images the framed app
      // loads. A subresource naming this boot's token may read it: these come
      // from document markup — icons, the web-app manifest — rather than from
      // script, so the page's request guard never sees them and tagging them in
      // the served document is the only way to authorize them.
      const isStatic = url.pathname.startsWith(`${STATIC_ROUTE_PREFIX}/`)
      if (!authorized && isStatic && url.searchParams.get(SESSION_QUERY) === sessionToken) {
        authorized = true
      }
      if (!authorized && !isStatic) {
        const query = url.searchParams.get(SESSION_QUERY)
        if (query === sessionToken) {
          // An iframe navigation is served directly, with its token still in the
          // URL. The redirect below is what a browser needs to get the token out
          // of the address bar, but it is also the step that loses the frame: the
          // panel is cross-site, Chromium discards the `SameSite=Lax` cookie
          // there, and the redirected request then arrives with neither the token
          // nor the cookie. Keeping the token in the frame's URL removes that
          // dependency entirely — every later navigation of that frame, including
          // the plugin's own reload, carries it and stays authorized.
          res.setHeader('set-cookie', sessionCookie(sessionToken))
          if (headerOf(req.headers, 'sec-fetch-dest') === 'iframe') {
            rememberNavigation(url, sessionToken)
            authorized = true
          } else {
            url.searchParams.delete(SESSION_QUERY)
            authorized = true
            // The marker outlives this redirect, which is what keeps the frame
            // authorized on a client that discards the cookie.
            rememberNavigation(url, sessionToken)
            // Redirect once so the token leaves the address bar and the page
            // reloads with a stable URL.
            res.statusCode = 302
            res.setHeader('location', `${url.pathname}${url.search}`)
            res.end()
            return
          }
        }
      }
      if (!authorized && navigationAuthorized(req, url)) {
        // The frame's own marker: this navigation was authorized before, and the
        // client that carried it kept the marker because the cookie did not
        // survive. Nothing else is accepted this way.
        authorized = true
      }
      if (!authorized && consumeTicket(req) !== undefined) {
        res.setHeader('set-cookie', sessionCookie(sessionToken))
        url.searchParams.delete(TICKET_QUERY)
        rememberNavigation(url, sessionToken)
        res.statusCode = 302
        res.setHeader('location', `${url.pathname}${url.search}`)
        res.end()
        return
      }
      if (!authorized) {
        refuse(res, 403, 'no-session')
        return
      }

      forward(req, res, url.pathname.startsWith(`${STATIC_ROUTE_PREFIX}/`)
        ? {
          path: url.pathname.slice(STATIC_ROUTE_PREFIX.length) + url.search,
          hostname: staticUrl.hostname,
          host: staticUrl.host,
          origin: STATIC_UPSTREAM_ORIGIN,
          protocol: staticUrl.protocol,
          port: staticUrl.port === '' ? 443 : Number(staticUrl.port),
          agent: staticAgent,
          referer: `${STATIC_UPSTREAM_ORIGIN}/`,
        }
        : {
          path: `${url.pathname}${url.search}`,
          hostname: targetUrl.hostname,
          host: targetUrl.host,
          origin: targetUrl.origin,
          protocol: targetUrl.protocol,
          port: targetUrl.port === '' ? (targetUrl.protocol === 'https:' ? 443 : 80) : Number(targetUrl.port),
          agent,
          referer: `${targetUrl.origin}${url.pathname}`,
        })
    } catch (error) {
      log('bridge request failed', error)
      if (!res.headersSent) refuse(res, 502, 'bad-request')
      else res.destroy()
    }
  }

  /** Send one request upstream and stream its response back. */
  function forward(req, res, upstreamTarget) {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue
      headers[name] = value
    }
    headers['accept-encoding'] = 'identity'
    headers['user-agent'] = headerOf(req.headers, 'user-agent') ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DSH-Chat'
    headers['host'] = upstreamTarget.host
    headers['referer'] = upstreamTarget.referer
    headers['x-forwarded-host'] = upstreamTarget.host

    const upstream = request({
      protocol: upstreamTarget.protocol,
      hostname: upstreamTarget.hostname,
      port: upstreamTarget.port,
      method: req.method,
      path: upstreamTarget.path,
      headers,
      agent: upstreamTarget.agent,
      servername: upstreamTarget.hostname,
    }, upstreamRes => {
      const status = upstreamRes.statusCode ?? 502
      res.statusCode = status
      const contentType = String(headerOf(upstreamRes.headers, 'content-type') ?? '')
      const contentTypeEssence = contentType.split(';', 1)[0].trim().toLowerCase()
      const isDocument = req.method !== 'HEAD' && contentTypeEssence === 'text/html'
      // Scripts and stylesheets are rewritten too: the app builds static URLs
      // at runtime and declares fonts inside its CSS, so a served body would
      // otherwise send the browser back to the CORS-blocked CDN. Both kinds are
      // buffered, so both lose the upstream length and encoding headers.
      const isRewritten = req.method !== 'HEAD'
        && (isDocument || isRewritableTextType(contentType))

      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const lower = name.toLowerCase()
        if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(lower) || DROPPED_RESPONSE_HEADERS.has(lower)) continue
        if (lower === 'set-cookie') {
          // The upstream's own cookies are appended to whatever this proxy has
          // already decided to set. Replacing the header here would drop the
          // bridge's session cookie on every document the app answers with a
          // cookie of its own — which is most of them — and the panel would be
          // left with nothing to authorize its next request.
          const mine = res.getHeader('set-cookie')
          const existing = mine === undefined ? [] : (Array.isArray(mine) ? mine : [mine])
          const cookies = (Array.isArray(value) ? value : [value]).map(cookie => rewriteSetCookie(cookie))
          res.setHeader('set-cookie', [...existing, ...cookies])
          continue
        }
        if (lower === 'location') {
          res.setHeader(name, rewriteLocation(String(value), origin, upstreamTarget.origin))
          continue
        }
        if (isRewritten && (lower === 'content-length' || lower === 'content-encoding')) continue
        res.setHeader(name, value)
      }
      res.setHeader('cache-control', isDocument ? 'no-store' : (headerOf(upstreamRes.headers, 'cache-control') ?? 'no-store'))

      if (!isRewritten) {
        upstreamRes.pipe(res)
        return
      }
      collect(upstreamRes).then(body => {
        const decoded = decodeBody(body, headerOf(upstreamRes.headers, 'content-encoding'))
        const text = decoded.toString('utf8')
        const out = Buffer.from(isDocument ? rewriteDocument(text, seed, sessionToken) : rewriteTextAsset(text), 'utf8')
        res.setHeader('content-length', String(out.byteLength))
        res.end(out)
      }).catch(error => {
        log('bridge body rewrite failed', error)
        res.destroy()
      })
    })

    upstream.on('error', error => {
      log('bridge upstream failed', error)
      if (!res.headersSent) refuse(res, 502, 'upstream')
      else res.destroy()
    })
    req.on('aborted', () => { upstream.destroy() })
    // Only a client that goes away mid-response ends the upstream request: a
    // request whose body was fully sent has `writableEnded` false forever, so
    // destroying on every response close would defeat connection pooling.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }

  /** Buffer a fully-read stream (documents only; every other route streams). */
  async function collect(stream) {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  if (options.server === undefined) {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  }

  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    /**
     * Mint a one-shot ticket so an already-authorized user can open the same
     * session in a separate browser window.
     * @returns the absolute URL carrying the ticket.
     */
    mintTicket() {
      const ticket = cryptoRandomId()
      tickets.set(ticket, Date.now() + ticketTtlMs)
      return `${origin}/?${TICKET_QUERY}=${ticket}`
    },
    /** Stop listening and drop pooled upstream sockets. */
    async dispose() {
      tickets.clear()
      agent.destroy()
      staticAgent.destroy()
      await new Promise(resolve => { server.close(() => { resolve() }) })
    },
  }
}

/** Random hex id for tickets and sessions. */
function cryptoRandomId() {
  return randomBytes(24).toString('hex')
}
