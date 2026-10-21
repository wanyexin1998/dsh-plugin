import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it, vi } from 'vitest'

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

function apiDouble() {
  const readLayout = vi.fn(async () => ({ treeOpen: false, treeWidth: 320, editorHeight: 300 }))
  const saveLayout = vi.fn(async () => undefined)
  return { api: { readLayout, saveLayout } as unknown as PanelApi, readLayout, saveLayout }
}

describe('layout route', () => {
  it('is registered exactly once, because the host keeps one handler per path', () => {
    const routes = carrier()
    registerPanelRoutes(routes, apiDouble().api)

    // Two registrations made the host answer 405 with an empty body: the later
    // POST handler shadowed the GET one (reported 2026-10-21).
    expect(routes.paths.filter(path => path === ROUTES.layout)).toHaveLength(1)
    expect(new Set(routes.paths).size).toBe(routes.paths.length)
  })

  it('answers GET with the stored layout', async () => {
    const routes = carrier()
    const { api, readLayout } = apiDouble()
    registerPanelRoutes(routes, api)

    const reply = response()
    await routes.handlers.get(ROUTES.layout)?.(request('GET') as unknown as IncomingMessage, reply.res as unknown as ServerResponse)

    expect(readLayout).toHaveBeenCalledTimes(1)
    expect(reply.res.statusCode).toBe(200)
    expect(reply.json()).toEqual({ ok: true, layout: { treeOpen: false, treeWidth: 320, editorHeight: 300 } })
  })

  it('accepts POST and saves the document', async () => {
    const routes = carrier()
    const { api, saveLayout } = apiDouble()
    registerPanelRoutes(routes, api)

    const reply = response()
    await routes.handlers.get(ROUTES.layout)?.(
      request('POST', { layout: { treeWidth: 300 } }) as unknown as IncomingMessage,
      reply.res as unknown as ServerResponse,
    )

    expect(saveLayout).toHaveBeenCalledWith({ treeWidth: 300 })
    expect(reply.json()).toEqual({ ok: true })
  })

  it('rejects other methods with a readable body, not an empty one', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, apiDouble().api)

    const reply = response()
    await routes.handlers.get(ROUTES.layout)?.(request('PUT') as unknown as IncomingMessage, reply.res as unknown as ServerResponse)

    expect(reply.res.statusCode).toBe(405)
    expect(reply.json()).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
  })

  it('applies the trust fence before reading or saving layout', async () => {
    const routes = carrier()
    const { api, readLayout, saveLayout } = apiDouble()
    registerPanelRoutes(routes, api, () => 403)

    const reply = response()
    await routes.handlers.get(ROUTES.layout)?.(request('GET') as unknown as IncomingMessage, reply.res as unknown as ServerResponse)

    expect(reply.res.statusCode).toBe(403)
    expect(reply.json()).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } })
    expect(readLayout).not.toHaveBeenCalled()
    expect(saveLayout).not.toHaveBeenCalled()
  })

  it('supports older APIs without layout methods', async () => {
    const routes = carrier()
    registerPanelRoutes(routes, {} as PanelApi)

    const getReply = response()
    await routes.handlers.get(ROUTES.layout)?.(request('GET') as unknown as IncomingMessage, getReply.res as unknown as ServerResponse)
    expect(getReply.json()).toEqual({ ok: true, layout: null })

    const postReply = response()
    await routes.handlers.get(ROUTES.layout)?.(
      request('POST', { layout: { treeOpen: true } }) as unknown as IncomingMessage,
      postReply.res as unknown as ServerResponse,
    )
    expect(postReply.json()).toEqual({ ok: true })
  })

  it('maps layout validation and unexpected failures to JSON errors', async () => {
    const validationRoutes = carrier()
    registerPanelRoutes(validationRoutes, {
      ...apiDouble().api,
      saveLayout: async () => { throw new PanelError('BAD_LAYOUT', 'layout 必须是 JSON 对象') },
    })
    const validationReply = response()
    await validationRoutes.handlers.get(ROUTES.layout)?.(
      request('POST', { layout: [] }) as unknown as IncomingMessage,
      validationReply.res as unknown as ServerResponse,
    )
    expect(validationReply.res.statusCode).toBe(400)
    expect(validationReply.json()).toMatchObject({ ok: false, error: { code: 'BAD_LAYOUT' } })

    const failedRoutes = carrier()
    registerPanelRoutes(failedRoutes, {
      ...apiDouble().api,
      saveLayout: async () => { throw new Error('disk offline') },
    })
    const failedReply = response()
    await failedRoutes.handlers.get(ROUTES.layout)?.(
      request('POST', { layout: {} }) as unknown as IncomingMessage,
      failedReply.res as unknown as ServerResponse,
    )
    expect(failedReply.res.statusCode).toBe(400)
    expect(failedReply.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'disk offline' } })
  })
})
