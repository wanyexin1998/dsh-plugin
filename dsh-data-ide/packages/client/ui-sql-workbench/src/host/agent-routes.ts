/**
 * Same-origin routes that carry agent deliveries to the panel (docs/10 §13.1).
 *
 * `GET /agent-events` is a `text/event-stream`: the route carrier hands us the
 * raw `ServerResponse`, which is what makes SSE possible without a second
 * server. `GET /agent-results?since=<seq>` is the polling fallback for proxies
 * that buffer streams.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { parseConsoleRegistry } from '../execute/console-registry.ts'
import type { AgentRelay } from './agent-relay.ts'
import { writeConsoleRegistry } from './console-registry.ts'

export const AGENT_ROUTES = {
  events: '/dsh-data-ide/agent-events',
  results: '/dsh-data-ide/agent-results',
  /** Panel publishes which consoles are the user's (docs/10 §13.3). */
  consoles: '/dsh-data-ide/agent-consoles',
} as const

/** The slice of `webServer` this module registers on. */
export interface AgentRouteCarrier {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

/** Trust fence: the composition's `connection` service, when present. */
export type TrustFence = (req: IncomingMessage) => number | undefined

const KEEP_ALIVE_MS = 15_000

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Read a bounded JSON object body. */
async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > limit) throw new Error('BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('BAD_BODY')
  return parsed as Record<string, unknown>
}

export interface AgentRouteOptions {
  /** Where the console registry snapshot is written; omitted disables the route. */
  readonly registryPath?: string
}

/**
 * Register the agent routes.
 *
 * @param carrier - the composition's `webServer`.
 * @param relay - the running spool tailer.
 * @param fence - optional refusal check from the `connection` service.
 * @param options - registry path for the console-ownership snapshot.
 * @returns one disposer removing every route.
 */
export function registerAgentRoutes(
  carrier: AgentRouteCarrier,
  relay: AgentRelay,
  fence?: TrustFence,
  options: AgentRouteOptions = {},
): () => void {
  const refuse = (req: IncomingMessage, res: ServerResponse): boolean => {
    const status = fence?.(req)
    if (status === undefined) return false
    sendJson(res, status, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
    return true
  }

  const offEvents = carrier.register({
    kind: 'exact',
    path: AGENT_ROUTES.events,
    handler: (req, res) => {
      if (refuse(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 3000\n\n')

      const off = relay.subscribe(event => {
        try {
          res.write(`id: ${event.seq}\nevent: agent-result\ndata: ${JSON.stringify(event.delivery)}\n\n`)
        } catch {
          // Client vanished between the check and the write; `close` cleans up.
        }
      })

      // Resume support (review §15 A6): EventSource reconnects with the last id
      // it saw, and without replay everything delivered during the gap was lost.
      // Replaying after subscribing can duplicate a frame, which the panel
      // applies idempotently; losing one is not recoverable.
      const lastEventId = req.headers['last-event-id']
      const resumeFrom = typeof lastEventId === 'string' ? Number.parseInt(lastEventId, 10) : Number.NaN
      if (Number.isFinite(resumeFrom) && resumeFrom > 0) {
        for (const event of relay.since(resumeFrom)) {
          try {
            res.write(`id: ${event.seq}\nevent: agent-result\ndata: ${JSON.stringify(event.delivery)}\n\n`)
          } catch {
            break
          }
        }
      }

      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n')
        } catch {
          // Same as above.
        }
      }, KEEP_ALIVE_MS)
      keepAlive.unref()

      const close = (): void => {
        clearInterval(keepAlive)
        off()
        res.end()
      }
      req.on('close', close)
      req.on('error', close)
    },
  })

  const offResults = carrier.register({
    kind: 'exact',
    path: AGENT_ROUTES.results,
    handler: (req, res) => {
      if (refuse(req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parsed = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
      const since = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
      sendJson(res, 200, { ok: true, cursor: relay.cursor, events: relay.since(since) })
    },
  })

  let offConsoles: () => void = () => undefined
  const registryPath = options.registryPath
  if (registryPath !== undefined) {
    const target = registryPath
    offConsoles = carrier.register({
      kind: 'exact',
      path: AGENT_ROUTES.consoles,
      handler: async (req, res) => {
        if (refuse(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' } })
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJson(req)
        } catch {
          sendJson(res, 400, { ok: false, error: { code: 'BAD_BODY', message: '请求体必须是 JSON 对象' } })
          return
        }
        const parsed = parseConsoleRegistry({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          consoles: body['consoles'],
        })
        // The wrapper fields above are valid by construction, so parsing cannot
        // return null; only malformed console entries are filtered out.
        const consoles = parsed!.consoles
        try {
          await writeConsoleRegistry(target, consoles)
          sendJson(res, 200, { ok: true, count: consoles.length })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: { code: 'REGISTRY_WRITE_FAILED', message: (error as Error).message },
          })
        }
      },
    })
  }

  return () => {
    offEvents()
    offResults()
    offConsoles()
  }
}
