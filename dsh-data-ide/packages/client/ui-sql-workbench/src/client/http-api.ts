/**
 * `WorkbenchApi` over the host's same-origin HTTP routes.
 *
 * The browser half cannot reach a node service through the Cordis context, so
 * this is the real transport in the web frontend; `workbenchApi()` stays as the
 * in-process path used by tests and by any future same-process carrier.
 *
 * Shapes mirror `web-routes.ts`: every response is `{ ok, ... }`, and a failure
 * is thrown as an `Error` carrying the host's message, which the panel's state
 * machines already render (docs/03 §5 error states).
 */

import type { ConnectionDraft, DataSource } from '../datasource/model.ts'
import type { ExecuteRequest } from '../execute/core.ts'
import type { ExecutionResult } from '../execute/envelope.ts'
import type { ScriptRequest, ScriptResponse } from '../execute/script.ts'
import type { SchemaSnapshot } from '../host/metadata.ts'
import { type TestResult, type WorkbenchApi } from './api.ts'
import type { QueryHistoryEntry } from './state/history.ts'

/** Wire paths; must match `src/host/web-routes.ts`. */
export const HTTP_ROUTES = {
  connections: '/dsh-data-ide/connections',
  save: '/dsh-data-ide/save',
  remove: '/dsh-data-ide/remove',
  activate: '/dsh-data-ide/activate',
  test: '/dsh-data-ide/test',
  execute: '/dsh-data-ide/execute',
  fetchPage: '/dsh-data-ide/fetch-page',
  cancel: '/dsh-data-ide/cancel',
  schema: '/dsh-data-ide/schema',
  executeScript: '/dsh-data-ide/execute-script',
  layout: '/dsh-data-ide/layout',
  workspace: '/dsh-data-ide/workspace',
  history: '/dsh-data-ide/history',
  favorites: '/dsh-data-ide/favorites',
} as const

/** Minimal fetch surface, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface Envelope {
  readonly ok?: boolean
  readonly error?: { readonly code?: string; readonly message?: string; readonly field?: string }
}

/**
 * Read the envelope and throw the host's message on failure.
 *
 * A **empty** body is its own diagnosis, not a JSON parse error: it means the
 * route is not mounted (the host is an older build, or another dsh instance owns
 * the port) or the handler died before writing. Letting `response.json()` throw
 * `SyntaxError: Unexpected end of JSON input` produced exactly the unreadable
 * unhandled rejection users reported (2026-10-21).
 */
async function unwrap<T extends Envelope>(response: Response, route: string): Promise<T> {
  const text = await response.text()
  if (text.trim() === '') {
    throw new Error(
      `EMPTY_RESPONSE: ${route} 返回了空响应（HTTP ${String(response.status)}）——` +
        '该路由可能只注册了别的方法，或宿主是旧版本；请完全退出 dsh 后重启',
    )
  }
  let payload: T
  try {
    payload = JSON.parse(text) as T
  } catch {
    throw new Error(
      `BAD_RESPONSE: ${route} 的响应不是 JSON（HTTP ${String(response.status)}）：${text.slice(0, 120)}`,
    )
  }
  if (!response.ok || payload.ok === false) {
    const code = payload.error?.code ?? `HTTP_${response.status}`
    const message = payload.error?.message ?? `请求失败（${response.status}）`
    throw new Error(`${code}: ${message}`)
  }
  return payload
}

/**
 * Build the HTTP-backed API.
 *
 * @param fetchImpl - fetch implementation; defaults to the global one.
 */
export function createHttpApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): WorkbenchApi {
  const post = async <T extends Envelope>(path: string, body: unknown): Promise<T> =>
    unwrap<T>(
      await fetchImpl(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      path,
    )

  return {
    async list() {
      const payload = await unwrap<Envelope & { connections?: readonly DataSource[] }>(
        await fetchImpl(HTTP_ROUTES.connections, { method: 'GET' }),
        HTTP_ROUTES.connections,
      )
      return payload.connections ?? []
    },

    async active() {
      const payload = await unwrap<Envelope & { activeId?: string | null }>(
        await fetchImpl(HTTP_ROUTES.connections, { method: 'GET' }),
        HTTP_ROUTES.connections,
      )
      return payload.activeId ?? null
    },

    async setActive(connId) {
      await post(HTTP_ROUTES.activate, { connId })
    },

    async save(draft: ConnectionDraft) {
      const payload = await post<Envelope & { connection?: DataSource }>(HTTP_ROUTES.save, { draft })
      if (payload.connection === undefined) throw new Error('保存连接失败：宿主未返回连接')
      return payload.connection
    },

    async remove(connId) {
      const payload = await post<Envelope & { removed?: boolean }>(HTTP_ROUTES.remove, { connId })
      return payload.removed === true
    },

    async test(connId) {
      const payload = await post<Envelope & { result?: TestResult }>(HTTP_ROUTES.test, { connId })
      if (payload.result === undefined) throw new Error('测试连接失败：宿主未返回结果')
      return payload.result
    },

    async execute(request: ExecuteRequest): Promise<ExecutionResult> {
      const payload = await post<Envelope & { result?: ExecutionResult }>(HTTP_ROUTES.execute, request)
      if (payload.result === undefined) throw new Error('执行失败：宿主未返回结果')
      return payload.result
    },

    async fetchPage(request: ExecuteRequest): Promise<ExecutionResult> {
      const payload = await post<Envelope & { result?: ExecutionResult }>(HTTP_ROUTES.fetchPage, request)
      if (payload.result === undefined) throw new Error('翻页失败：宿主未返回结果')
      return payload.result
    },

    async cancel(statementId) {
      const payload = await post<Envelope & { result?: { cancelled: boolean } }>(HTTP_ROUTES.cancel, { statementId })
      return payload.result ?? { cancelled: false }
    },

    async layout() {
      const payload = await unwrap<Envelope & { layout?: unknown }>(
        await fetchImpl(HTTP_ROUTES.layout, { method: 'GET' }),
        HTTP_ROUTES.layout,
      )
      return payload.layout ?? null
    },

    async saveLayout(layout) {
      // Best effort: a failed save must not surface as a query error.
      try {
        await post(HTTP_ROUTES.layout, { layout })
      } catch {
        // Layout is a convenience, not data.
      }
    },

    async loadWorkspaceState() {
      const payload = await unwrap<Envelope & { state?: unknown }>(
        await fetchImpl(HTTP_ROUTES.workspace, { method: 'GET' }),
        HTTP_ROUTES.workspace,
      )
      return payload.state ?? null
    },

    async saveWorkspaceState(state) {
      // Best effort: losing the next restore is better than failing the query UI.
      try {
        await post(HTTP_ROUTES.workspace, { state })
      } catch {
        // The panel keeps the live tabs; only a reload loses them.
      }
    },

    async loadHistory() {
      const payload = await unwrap<Envelope & { history?: unknown }>(
        await fetchImpl(HTTP_ROUTES.history, { method: 'GET' }),
        HTTP_ROUTES.history,
      )
      return payload.history ?? null
    },

    async appendHistory(entry: QueryHistoryEntry) {
      // Best effort: a missed history row must never fail the run that made it.
      try {
        await post(HTTP_ROUTES.history, { entry })
      } catch {
        // The panel's in-memory list still shows the row.
      }
    },

    async loadFavorites() {
      const payload = await unwrap<Envelope & { favorites?: unknown }>(
        await fetchImpl(HTTP_ROUTES.favorites, { method: 'GET' }),
        HTTP_ROUTES.favorites,
      )
      return payload.favorites ?? null
    },

    async saveFavorites(document) {
      // Best effort, like the other two persistence documents.
      try {
        await post(HTTP_ROUTES.favorites, { favorites: document })
      } catch {
        // Favorites are a convenience; the in-memory list is still there.
      }
    },

    async executeScript(request) {
      const payload = await post<Envelope & { script?: ScriptResponse; refusal?: { code: string; message: string } }>(
        HTTP_ROUTES.executeScript,
        request,
      )
      if (payload.refusal !== undefined) return { refusal: payload.refusal }
      if (payload.script === undefined) throw new Error('脚本执行失败：宿主未返回结果')
      return payload.script
    },

    async schema(connId, options = {}) {
      const suffix = options.refresh === true ? '&refresh=1' : ''
      const query = `?connId=${encodeURIComponent(connId)}${suffix}`
      const payload = await unwrap<Envelope & { schema?: SchemaSnapshot }>(
        await fetchImpl(`${HTTP_ROUTES.schema}${query}`, { method: 'GET' }),
        HTTP_ROUTES.schema,
      )
      if (payload.schema === undefined) throw new Error('读取表结构失败：宿主未返回结果')
      return payload.schema
    },
  }
}
