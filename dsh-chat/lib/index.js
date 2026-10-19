/**
 * Host half of dsh-chat.
 *
 * One responsibility, on the composition's `webServer`: it runs a loopback
 * reverse proxy for the DeepSeek Chat web app so the browser half can frame it
 * (see `bridge-proxy.js`), and hands the browser half that origin plus this
 * boot's session token.
 *
 * Every route sits behind the composition's `connection` trust fence when that
 * service exists; the bridge session token is a second, independent gate on the
 * proxied origin itself.
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { resolveBridgeConfig } from './config.js'
import { startBridgeProxy } from './bridge-proxy.js'
import { ROUTE_PREFIX, SESSION_PATH, TICKET_PATH } from './shared.js'

/** Cordis function-plugin name. */
export const name = 'dsh-chat'

/**
 * The route carrier; `connection` is read opportunistically through `ctx.get`,
 * never injected, so the plugin still activates in a composition without it.
 */
export const inject = ['webServer']

/**
 * No `Config` export on purpose.
 *
 * Cordis validates an exported `Config` through its schema object, and this
 * plugin keeps zero runtime dependencies, so the Loader row's config map is
 * normalized by {@link resolveBridgeConfig} inside `apply` instead. The keys it
 * accepts are `target`, `port`, `credentialsPath`, `seed`, and `startInChat`.
 */

const MAX_BODY_BYTES = 8 * 1024

/** Head-injection id and view values the client half reads back at render time. */
const SNAPSHOT_ID = 'dsh-chat-startup'
const VIEW_CHAT = 'chat'
const VIEW_WORK = 'work'

/** JSON response with no-store caching. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Resolve the DSH home directory the way the harness does. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(process.env.USERPROFILE ?? '', '.dsh')
}

/** Derive a stable preferred port from the DSH home so one install keeps one origin. */
function preferredPort() {
  const digest = createHash('sha1').update(dshHome()).digest()
  return 34_000 + (digest.readUInt16BE(0) % 900)
}

/**
 * Bind a loopback port for the bridge, falling back to an OS-assigned one when
 * the preferred port is taken.
 *
 * @param preferred - the port to try first.
 * @param log - diagnostic sink for the fallback decision.
 * @returns a listening server on 127.0.0.1.
 */
function listenLoopback(preferred, log) {
  const attempt = (port) => new Promise((resolve, reject) => {
    const server = createServer()
    const onError = (error) => { server.close(); reject(error) }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve(server)
    })
  })
  return attempt(preferred).catch((error) => {
    log(`preferred port ${String(preferred)} unavailable (${String(error?.code ?? error)}); asking the OS`)
    return attempt(0)
  })
}

/** Answer a request that fails the trust fence or a method check. */
function refuse(res, status, message) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(message)
}

/** Read a bounded request body as text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Activate the bridge.
 *
 * @param ctx - plugin context carrying the composition's `webServer`.
 * @param rawConfig - the Loader row's config map, normalized here.
 */
export function apply(ctx, rawConfig) {
  const log = (message) => {
    const line = `[dsh-chat] ${message}`
    if (typeof ctx.logger?.info === 'function') ctx.logger.info(line)
    else console.info(line)
  }
  const config = resolveBridgeConfig(rawConfig)
  const sessionToken = randomBytes(32).toString('hex')
  const credentialsPath = config.credentialsPath ?? join(dshHome(), '.credentials.yaml')
  /** This boot's bridge endpoint; undefined until the listener is up. */
  let bridge
  const hasSeed = Object.keys(config.seed).length > 0

  ctx.effect(() => {
    let disposed = false
    void (async () => {
      try {
        const server = await listenLoopback(config.port > 0 ? config.port : preferredPort(), log)
        if (disposed) {
          server.close()
          return
        }
        const started = await startBridgeProxy({
          target: config.target,
          sessionToken,
          seed: hasSeed ? { localStorage: config.seed } : undefined,
          log: (...args) => { log(args.map(String).join(' ')) },
          server,
        })
        if (disposed) {
          await started.dispose()
          return
        }
        bridge = started
        log(`ready at ${started.origin} (upstream ${config.target})`)
      } catch (error) {
        log(`failed to start: ${String(error)}`)
      }
    })()
    return () => {
      disposed = true
      const active = bridge
      bridge = undefined
      if (active !== undefined) void active.dispose()
    }
  }, 'dsh-chat: loopback proxy')

  /** The composition's connection service, when this profile has one. */
  const connection = () => {
    const service = ctx.get('connection')
    return typeof service?.requestRejection === 'function' ? service : undefined
  }

  /** True when the caller passed the composition's trust fence. */
  const fencePassed = (req) => {
    const service = connection()
    if (service === undefined) return true
    return service.requestRejection(req) === undefined
  }

  /** Answer an untrusted caller; true when the request was rejected. */
  const rejected = (req, res) => {
    const service = connection()
    if (service === undefined) return false
    const rejection = service.requestRejection(req)
    if (rejection === undefined) return false
    refuse(res, rejection, 'dsh-chat: untrusted caller')
    return true
  }

  // The startup view is published as a head injection so the client's first
  // paint already shows the configured tab instead of flashing the other one.
  ctx.effect(() => ctx.webServer.tapIndex(html => {
    const view = config.startInChat ? VIEW_CHAT : VIEW_WORK
    const row = `<meta id="${SNAPSHOT_ID}" data-view="${view}">`
    // `tapIndex` receives a full document, so the injection goes right after
    // the opening head tag.
    return html.replace('<head>', `<head>${row}`)
  }), 'dsh-chat: startup view injection')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SESSION_PATH,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        refuse(res, 405, 'GET only')
        return
      }
      if (bridge === undefined) {
        sendJson(res, 503, { ready: false })
        return
      }
      sendJson(res, 200, {
        ready: true,
        origin: bridge.origin,
        sessionToken,
        target: config.target,
        seeded: Object.keys(config.seed ?? {}).length > 0,
        startInChat: config.startInChat,
      })
    },
  }), `dsh-chat: GET ${SESSION_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TICKET_PATH,
    handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        refuse(res, 405, 'POST only')
        return
      }
      if (bridge === undefined) {
        sendJson(res, 503, { ready: false })
        return
      }
      const body = readBoundedBody(req).then(text => {
        if (text === null) {
          sendJson(res, 413, { code: 'too-large' })
          return
        }
        sendJson(res, 200, { url: bridge.mintTicket() })
      })
      void body
    },
  }), `dsh-chat: POST ${TICKET_PATH}`)

  // Keep the prefix registered so a future probe or deep link under the plugin
  // namespace answers JSON instead of falling through to the SPA shell.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/probe`,
    handler: (req, res) => {
      if (!fencePassed(req)) {
        refuse(res, 403, 'dsh-chat: untrusted caller')
        return
      }
      sendJson(res, 200, { plugin: name, bridge: bridge?.origin ?? null, ready: bridge !== undefined })
    },
  }), `dsh-chat: GET ${ROUTE_PREFIX}/probe`)
}
