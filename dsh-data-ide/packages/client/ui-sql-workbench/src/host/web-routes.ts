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
  /** The browser half reports its own activation failures here. */
  clientError: `${ROUTE_PREFIX}/client-error`,
} as const

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

    post(ROUTES.save, async (body, res) => {
      const draft = body['draft'] as ConnectionDraft | undefined
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
