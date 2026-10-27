/**
 * Same-origin HTTP routes the browser half calls.
 *
 * The panel runs in the web frontend, which is a different process from the node
 * half; a Cordis service cannot be reached across that boundary. `webServer` is
 * the composition's route carrier (`packages/host/webserver`), and dsh-chat
 * establishes the precedent for an external plugin mounting its own namespace on
 * it, so this module is the transport for `PanelApi`.
 *
 * Every handler is POST (or GET for the read-only state), answers JSON, and
 * never leaks a password: `test` returns only the three-state verdict.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ConnectionDraft } from '../datasource/model.ts'
import type { ExecuteRequest } from '../execute/core.ts'
import type { ScriptRequest } from '../execute/script.ts'
import { PanelError } from './panel-service.ts'
import type { PanelApi } from './panel-service.ts'

/** Route namespace; also the prefix the client builds URLs from. */
export const ROUTE_PREFIX = '/dsh-data-ide'

export const ROUTES = {
  connections: `${ROUTE_PREFIX}/connections`,
  save: `${ROUTE_PREFIX}/save`,
  remove: `${ROUTE_PREFIX}/remove`,
  activate: `${ROUTE_PREFIX}/activate`,
  test: `${ROUTE_PREFIX}/test`,
  execute: `${ROUTE_PREFIX}/execute`,
  executeScript: `${ROUTE_PREFIX}/execute-script`,
  fetchPage: `${ROUTE_PREFIX}/fetch-page`,
  schema: `${ROUTE_PREFIX}/schema`,
  cancel: `${ROUTE_PREFIX}/cancel`,
  /** Layout document: split sizes and object-browser state (docs/09 B3). */
  layout: `${ROUTE_PREFIX}/layout`,
  /** Console tabs + active tab + page size (SQL-201/202); never result sets. */
  workspace: `${ROUTE_PREFIX}/workspace`,
  /** Whole query-history document; POST appends one run (SQL-203/204). */
  history: `${ROUTE_PREFIX}/history`,
  /** Named pinned queries (SQL-205). */
  favorites: `${ROUTE_PREFIX}/favorites`,
  /** The browser half reports its own activation failures here. */
  clientError: `${ROUTE_PREFIX}/client-error`,
} as const

/**
 * Optional persistence half of the panel API (SQL-201/202/203/205).
 *
 * Every method is optional so older host builds and the repo's API doubles keep
 * type-checking; the routes below answer exactly like the layout document when a
 * method is absent (GET returns `null`, POST is a no-op). The values cross the
 * wire unvalidated on read and are normalised by the client parsers
 * (`client/state/history.ts`); the host only guarantees that it stores JSON
 * objects.
 */
export interface PersistenceApi {
  /** Console tabs + active tab + page size from the last session. */
  loadWorkspaceState?(): Promise<unknown>
  saveWorkspaceState?(state: unknown): Promise<void>
  /** History document, `{ schemaVersion, byConn }`. */
  loadHistory?(): Promise<unknown>
  /** Append one run; the host owns the per-connection ring buffer. */
  appendHistory?(entry: unknown): Promise<void>
  /** Favorites document, `{ schemaVersion, entries }`. */
  loadFavorites?(): Promise<unknown>
  saveFavorites?(document: unknown): Promise<void>
}

/** Ceiling for a request body: a statement is text, not a payload. */
export const MAX_BODY_BYTES = 256 * 1024

/** The slice of `webServer` this module registers on. */
export interface RouteCarrier {
  register(route: {
    readonly kind: 'exact'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

/** Trust fence: the composition's `connection` service, when present. */
export type TrustFence = (req: IncomingMessage) => number | undefined

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Read a bounded JSON object body; throws on oversize or bad JSON. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new PanelError('BODY_TOO_LARGE', `请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new PanelError('BAD_BODY', '请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** Narrow one body field to a string, or explain which one is wrong. */
function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value === '') throw new PanelError('BAD_BODY', `缺少字段 ${field}`)
  return value
}

/** Translate a thrown refusal into a status code. */
function statusFor(error: PanelError): number {
  if (error.code === 'CONN_NOT_FOUND') return 404
  if (error.code === 'BODY_TOO_LARGE') return 413
  return 400
}

/**
 * Register every panel route.
 *
 * @param carrier - the composition's `webServer`.
 * @param api - the panel API the routes drive.
 * @param fence - optional refusal check from the `connection` service.
 * @returns one disposer removing all routes.
 */
export function registerPanelRoutes(carrier: RouteCarrier, api: PanelApi, fence?: TrustFence): () => void {
  const post = (
    path: string,
    handler: (body: Record<string, unknown>, res: ServerResponse) => Promise<void>,
  ): (() => void) =>
    carrier.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const refused = fence?.(req)
        if (refused !== undefined) {
          sendJson(res, refused, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' } })
          return
        }
        try {
          await handler(await readJsonBody(req), res)
        } catch (error) {
          const refusal = error instanceof PanelError ? error : new PanelError('INTERNAL', (error as Error).message)
          sendJson(res, statusFor(refusal), { ok: false, error: { code: refusal.code, message: refusal.message, field: refusal.field } })
        }
      },
    })

  /**
   * Optional persistence half of the API (SQL-201/202/203/205).
   *
   * `PanelApi` predates these documents and every test double implements only a
   * subset, so the methods are read opportunistically instead of by widening the
   * shared interface; absent means "this host does not persist it".
   */
  const persistence = api as PanelApi & PersistenceApi

  /**
   * One GET/POST registration for a persisted JSON document.
   *
   * A single registration per path is mandatory: the host's route table keeps
   * one handler per path, so a second registration shadows the first (the layout
   * route learned that the hard way on 2026-10-21).
   *
   * @param path - route path.
   * @param readField - response field carrying the document on GET.
   * @param writeField - request field carrying the value on POST.
   * @param read - optional host reader; absent answers `null`.
   * @param write - optional host writer; absent makes POST a no-op.
   */
  const documentRoute = (
    path: string,
    readField: string,
    writeField: string,
    read: (() => Promise<unknown>) | undefined,
    write: ((value: unknown) => Promise<void>) | undefined,
  ): (() => void) =>
    carrier.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const refused = fence?.(req)
        if (refused !== undefined) {
          sendJson(res, refused, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
          return
        }
        if (req.method === 'GET') {
          const document = read === undefined ? null : await read()
          sendJson(res, 200, { ok: true, [readField]: document })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET / POST' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (write !== undefined) await write(body[writeField])
          sendJson(res, 200, { ok: true })
        } catch (error) {
          const refusal = error instanceof PanelError ? error : new PanelError('INTERNAL', (error as Error).message)
          sendJson(res, statusFor(refusal), {
            ok: false,
            error: { code: refusal.code, message: refusal.message, field: refusal.field },
          })
        }
      },
    })

  const disposers = [
    // Read-only state: the panel asks for both halves in one round trip.
    carrier.register({
      kind: 'exact',
      path: ROUTES.connections,
      handler: async (req, res) => {
        const refused = fence?.(req)
        if (refused !== undefined) {
          sendJson(res, refused, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
          return
        }
        const [connections, activeId] = await Promise.all([api.list(), api.active()])
        sendJson(res, 200, { ok: true, connections, activeId })
      },
    }),

    /**
     * Layout document (09 B3) — **one** registration for both methods.
     *
     * Registering the path twice (GET through `carrier.register`, POST through
     * `post()`) made the host answer `405` with an **empty body**: its route table
     * holds one handler per path, so the later registration shadowed the earlier
     * one and a GET landed on a POST-only handler (reported 2026-10-21).
     */
    carrier.register({
      kind: 'exact',
      path: ROUTES.layout,
      handler: async (req, res) => {
        const refused = fence?.(req)
        if (refused !== undefined) {
          sendJson(res, refused, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
          return
        }
        if (req.method === 'GET') {
          const layout = api.readLayout === undefined ? null : await api.readLayout()
          sendJson(res, 200, { ok: true, layout })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET / POST' } })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (api.saveLayout !== undefined) await api.saveLayout(body['layout'])
          sendJson(res, 200, { ok: true })
        } catch (error) {
          const refusal = error instanceof PanelError ? error : new PanelError('INTERNAL', (error as Error).message)
          sendJson(res, statusFor(refusal), {
            ok: false,
            error: { code: refusal.code, message: refusal.message, field: refusal.field },
          })
        }
      },
    }),

    /**
     * Console workspace, query history and favorites (SQL-201/202/203/205).
     *
     * Same GET/POST contract as the layout document: GET hands back whatever the
     * host stored (`null` when this host build does not persist it), POST stores
     * one document or appends one history entry. Shapes are documented in
     * `client/state/history.ts`; the client parses defensively, so the host never
     * has to know about tabs or search filters.
     */
    documentRoute(
      ROUTES.workspace,
      'state',
      'state',
      persistence.loadWorkspaceState?.bind(persistence),
      persistence.saveWorkspaceState?.bind(persistence),
    ),
    documentRoute(
      ROUTES.history,
      'history',
      'entry',
      persistence.loadHistory?.bind(persistence),
      persistence.appendHistory?.bind(persistence),
    ),
    documentRoute(
      ROUTES.favorites,
      'favorites',
      'favorites',
      persistence.loadFavorites?.bind(persistence),
      persistence.saveFavorites?.bind(persistence),
    ),

    post(ROUTES.save, async (body, res) => {      const draft = body['draft'] as ConnectionDraft | undefined
      if (draft === undefined) throw new PanelError('BAD_BODY', '缺少字段 draft')
      sendJson(res, 200, { ok: true, connection: await api.save(draft) })
    }),

    post(ROUTES.remove, async (body, res) => {
      sendJson(res, 200, { ok: true, removed: await api.remove(requireString(body, 'connId')) })
    }),

    post(ROUTES.activate, async (body, res) => {
      const connId = body['connId']
      if (connId !== null && typeof connId !== 'string') throw new PanelError('BAD_BODY', 'connId 必须是字符串或 null')
      await api.setActive(connId)
      sendJson(res, 200, { ok: true })
    }),

    post(ROUTES.test, async (body, res) => {
      sendJson(res, 200, { ok: true, result: await api.test(requireString(body, 'connId')) })
    }),

    post(ROUTES.execute, async (body, res) => {
      sendJson(res, 200, { ok: true, result: await api.execute(body as unknown as ExecuteRequest) })
    }),

    // A whole script: one entry per statement, stopped at the first failure.
    post(ROUTES.executeScript, async (body, res) => {
      const outcome = await api.executeScript(body as unknown as ScriptRequest)
      if ('refusal' in outcome) {
        sendJson(res, 200, { ok: true, refusal: outcome.refusal })
        return
      }
      sendJson(res, 200, { ok: true, script: outcome })
    }),

    post(ROUTES.fetchPage, async (body, res) => {
      sendJson(res, 200, { ok: true, result: await api.fetchPage(body as unknown as ExecuteRequest) })
    }),

    // Completion metadata: GET, because it is a read and the browser caches it.
    carrier.register({
      kind: 'exact',
      path: ROUTES.schema,
      handler: async (req, res) => {
        const refused = fence?.(req)
        if (refused !== undefined) {
          sendJson(res, refused, { ok: false, error: { code: 'UNTRUSTED', message: '调用方未通过连接信任校验' } })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const connId = url.searchParams.get('connId')
          if (connId === null || connId === '') throw new PanelError('BAD_BODY', '缺少参数 connId')
          const refresh = url.searchParams.get('refresh') === '1'
          sendJson(res, 200, { ok: true, schema: await api.schema(connId, { refresh }) })
        } catch (error) {
          const refusal = error instanceof PanelError ? error : new PanelError('INTERNAL', (error as Error).message)
          sendJson(res, statusFor(refusal), { ok: false, error: { code: refusal.code, message: refusal.message } })
        }
      },
    }),

    post(ROUTES.cancel, async (body, res) => {
      sendJson(res, 200, { ok: true, result: await api.cancel(requireString(body, 'statementId')) })
    }),

    // Diagnostics sink: the browser half cannot write files or reach the node
    // console, so a failed client entry posts its reason here and the operator
    // sees it in the process log (where client errors otherwise never appear).
    post(ROUTES.clientError, async (body, res) => {
      const message = typeof body['message'] === 'string' ? body['message'] : '(no message)'
      const stack = typeof body['stack'] === 'string' ? `\n${body['stack']}` : ''
      console.error(`dsh-data-ide: 客户端注册失败 — ${message}${stack}`)
      sendJson(res, 200, { ok: true })
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
