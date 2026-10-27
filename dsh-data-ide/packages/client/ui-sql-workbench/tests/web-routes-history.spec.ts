import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

import { HTTP_ROUTES } from '../src/client/http-api.ts'
import { createPersistenceStore } from '../src/host/binding.ts'
import { createMemoryKvStore } from '../src/host/kv.ts'
import { PanelError, type PanelApi } from '../src/host/panel-service.ts'
import { ROUTES, type RouteCarrier, registerPanelRoutes } from '../src/host/web-routes.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => unknown

/** Router double that keeps **one** handler per path, like the host's table. */
function carrier() {
  const handlers = new Map<string, RouteHandler>()
  const paths: string[] = []
  const register: RouteCarrier['register'] = route => {
    paths.push(route.path)
    handlers.set(route.path, route.handler)
    return () => undefined
  }
  return { paths, handlers, register }
}

function response() {
  const chunks: string[] = []
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value
    },
    end(body?: string) {
      if (body !== undefined) chunks.push(body)
    },
  }
  const text = (): string => chunks.join('')
  return { res, text, json: (): Record<string, unknown> => JSON.parse(text() || 'null') as Record<string, unknown> }
}

function request(method: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text)
    },
  }
}

const entry = {
  id: 'h1',
  connId: 'c1',
  sql: 'SELECT 1',
  at: 1_000,
  durationMs: 5,
  rowCount: 1,
  ok: true,
}

/** API double carrying the optional persistence half. */
function apiDouble() {
  const loadWorkspaceState = vi.fn(async () => ({ activeDocId: 'a', docs: [{ id: 'a' }] }))
  const saveWorkspaceState = vi.fn(async () => undefined)
  const loadHistory = vi.fn(async () => ({ schemaVersion: 1, byConn: { c1: [entry] } }))
  const appendHistory = vi.fn(async () => undefined)
  const loadFavorites = vi.fn(async () => ({ schemaVersion: 1, entries: [] }))
  const saveFavorites = vi.fn(async () => undefined)
  return {
    api: {
      loadWorkspaceState,
      saveWorkspaceState,
      loadHistory,
      appendHistory,
      loadFavorites,
      saveFavorites,
    } as unknown as PanelApi,
    loadWorkspaceState,
    saveWorkspaceState,
    loadHistory,
    appendHistory,
    loadFavorites,
    saveFavorites,
  }
}

async function call(
  routes: ReturnType<typeof carrier>,
  path: string,
  method: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const reply = response()
  await routes.handlers.get(path)?.(request(method, body) as unknown as IncomingMessage, reply.res as unknown as ServerResponse)
  return reply
}

describe('persistence routes', () => {
  it('registers each document path exactly once, like the layout route', () => {
    const routes = carrier()
    registerPanelRoutes(routes, apiDouble().api)

    for (const path of [ROUTES.workspace, ROUTES.history, ROUTES.favorites]) {
      expect(routes.paths.filter(candidate => candidate === path)).toHaveLength(1)
    }
    expect(new Set(routes.paths).size).toBe(routes.paths.length)
  })

  it('mirrors the wire paths the browser half builds', () => {
    expect(HTTP_ROUTES.workspace).toBe(ROUTES.workspace)
    expect(HTTP_ROUTES.history).toBe(ROUTES.history)
    expect(HTTP_ROUTES.favorites).toBe(ROUTES.favorites)
  })

  it('answers GET with the stored workspace document', async () => {
    const routes = carrier()
    const { api, loadWorkspaceState } = apiDouble()
    registerPanelRoutes(routes, api)

    const reply = await call(routes, ROUTES.workspace, 'GET')

    expect(loadWorkspaceState).toHaveBeenCalledTimes(1)
    expect(reply.res.statusCode).toBe(200)
    expect(reply.json()).toEqual({ ok: true, state: { activeDocId: 'a', docs: [{ id: 'a' }] } })
  })

  it('saves the workspace document posted by the panel', async () => {
    const routes = carrier()
    const { api, saveWorkspaceState } = apiDouble()
    registerPanelRoutes(routes, api)
    const state = { schemaVersion: 1, activeDocId: 'a', docs: [] }

    const reply = await call(routes, ROUTES.workspace, 'POST', { state })

    expect(saveWorkspaceState).toHaveBeenCalledWith(state)
    expect(reply.json()).toEqual({ ok: true })
  })

  it('answers GET with the history document and appends one entry on POST', async () => {
    const routes = carrier()
    const { api, loadHistory, appendHistory } = apiDouble()
    registerPanelRoutes(routes, api)

    const read = await call(routes, ROUTES.history, 'GET')
    const written = await call(routes, ROUTES.history, 'POST', { entry })

    expect(read.json()).toEqual({ ok: true, history: { schemaVersion: 1, byConn: { c1: [entry] } } })
    expect(appendHistory).toHaveBeenCalledWith(entry)
    expect(written.json()).toEqual({ ok: true })
  })

  it('returns and stores the favorites document', async () => {
    const routes = carrier()
    const { api, loadFavorites, saveFavorites } = apiDouble()
    registerPanelRoutes(routes, api)
    const favorites = { schemaVersion: 1, entries: [] }

    const read = await call(routes, ROUTES.favorites, 'GET')
    const written = await call(routes, ROUTES.favorites, 'POST', { favorites })

    expect(read.json()).toEqual({ ok: true, favorites })
    expect(saveFavorites).toHaveBeenCalledWith(favorites)
    expect(written.json()).toEqual({ ok: true })
  })

  it('supports older APIs that do not persist anything', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, {} as PanelApi)

    const workspace = await call(routes, ROUTES.workspace, 'GET')
    const history = await call(routes, ROUTES.history, 'GET')
    const favorites = await call(routes, ROUTES.favorites, 'GET')
    const saved = await call(routes, ROUTES.history, 'POST', { entry })

    expect(workspace.json()).toEqual({ ok: true, state: null })
    expect(history.json()).toEqual({ ok: true, history: null })
    expect(favorites.json()).toEqual({ ok: true, favorites: null })
    expect(saved.json()).toEqual({ ok: true })
  })

  it('rejects other methods with a readable body', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, apiDouble().api)

    for (const path of [ROUTES.workspace, ROUTES.history, ROUTES.favorites]) {
      const reply = await call(routes, path, 'PUT')
      expect(reply.res.statusCode).toBe(405)
      expect(reply.json()).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
    }
  })

  it('applies the trust fence before reading or writing', async () => {
    const routes = carrier()
    const { api, loadWorkspaceState, appendHistory, saveFavorites } = apiDouble()
    registerPanelRoutes(routes, api, () => 403)

    const workspace = await call(routes, ROUTES.workspace, 'GET')
    const history = await call(routes, ROUTES.history, 'POST', { entry })
    const favorites = await call(routes, ROUTES.favorites, 'POST', { favorites: { entries: [] } })

    for (const reply of [workspace, history, favorites]) {
      expect(reply.res.statusCode).toBe(403)
      expect(reply.json()).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } })
    }
    expect(loadWorkspaceState).not.toHaveBeenCalled()
    expect(appendHistory).not.toHaveBeenCalled()
    expect(saveFavorites).not.toHaveBeenCalled()
  })

  it('maps a host refusal to its status and code', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, {
      ...apiDouble().api,
      appendHistory: async () => {
        throw new PanelError('BAD_HISTORY', '历史记录缺少 sql')
      },
    } as unknown as PanelApi)

    const reply = await call(routes, ROUTES.history, 'POST', { entry: { id: 'a' } })

    expect(reply.res.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ ok: false, error: { code: 'BAD_HISTORY', message: '历史记录缺少 sql' } })
  })

  it('turns an unexpected storage failure into a readable INTERNAL error', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, {
      ...apiDouble().api,
      saveWorkspaceState: async () => {
        throw new Error('disk offline')
      },
    } as unknown as PanelApi)

    const reply = await call(routes, ROUTES.workspace, 'POST', { state: {} })

    expect(reply.res.statusCode).toBe(400)
    expect(reply.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'disk offline' } })
  })

  it('stores through the real host persistence port end to end', async () => {
    const routes = carrier()
    const kv = createMemoryKvStore()
    registerPanelRoutes(routes, createPersistenceStore(kv) as unknown as PanelApi)

    await call(routes, ROUTES.workspace, 'POST', { state: { schemaVersion: 1, activeDocId: 'a', docs: [] } })
    await call(routes, ROUTES.history, 'POST', { entry })
    await call(routes, ROUTES.favorites, 'POST', { favorites: { schemaVersion: 1, entries: [] } })

    expect((await call(routes, ROUTES.workspace, 'GET')).json()).toEqual({
      ok: true,
      state: { schemaVersion: 1, activeDocId: 'a', docs: [] },
    })
    expect((await call(routes, ROUTES.history, 'GET')).json()).toMatchObject({
      ok: true,
      history: { byConn: { c1: [{ id: 'h1' }] } },
    })
    expect((await call(routes, ROUTES.favorites, 'GET')).json()).toEqual({
      ok: true,
      favorites: { schemaVersion: 1, entries: [] },
    })

    // A malformed entry never reaches the table.
    const bad = await call(routes, ROUTES.history, 'POST', { entry: { id: 'bad' } })
    expect(bad.res.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ ok: false, error: { code: 'BAD_HISTORY' } })
  })
})
