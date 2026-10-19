import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { DataSource } from '../src/datasource/model.ts'
import { createDataSource } from '../src/datasource/model.ts'
import { PanelError } from '../src/host/panel-service.ts'
import type { PanelApi } from '../src/host/panel-service.ts'
import { MAX_BODY_BYTES, ROUTES, registerPanelRoutes } from '../src/host/web-routes.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris: DataSource = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' })

/** Collect the routes a carrier was handed, so tests can call one directly. */
function carrier() {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>()
  const disposers: (() => void)[] = []
  return {
    routes,
    disposers,
    register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }) {
      routes.set(route.path, route.handler)
      const dispose = () => routes.delete(route.path)
      disposers.push(dispose)
      return dispose
    },
  }
}

/** A request whose body is the given JSON text. */
function request(method: string, body?: unknown, url?: string): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  ;(stream as { method?: string }).method = method
  if (url !== undefined) (stream as { url?: string }).url = url
  return stream
}

/** A response double capturing status and payload. */
function response() {
  const captured = { status: 0, body: '' }
  const res = {
    set statusCode(value: number) {
      captured.status = value
    },
    get statusCode() {
      return captured.status
    },
    setHeader: () => undefined,
    end: (chunk?: string) => {
      captured.body = chunk ?? ''
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function apiDouble(overrides: Partial<PanelApi> = {}): PanelApi {
  return {
    list: vi.fn(async () => [doris]),
    active: vi.fn(async () => connId),
    setActive: vi.fn(async () => undefined),
    save: vi.fn(async () => doris),
    remove: vi.fn(async () => true),
    test: vi.fn(async () => ({ state: 'YES' as const, durationMs: 12 })),
    execute: vi.fn(async () => ({ ok: true as const, columns: [], rows: [], total: 0, hasNextPage: false, offset: 0, durationMs: 1, statementId: 'ui-1' })),
    fetchPage: vi.fn(async () => ({ ok: true as const, columns: [], rows: [], total: null, hasNextPage: false, offset: 500, durationMs: 1, statementId: 'ui-2' })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    schema: vi.fn(async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const })),
    executeScript: vi.fn(async () => ({ statements: [], durationMs: 0 })),
    ...overrides,
  }
}

/** Fire one route and read what it answered. */
async function call(
  routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>,
  path: string,
  method: string,
  body?: unknown,
  url?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} not registered`)
  const { res, captured } = response()
  await handler(request(method, body, url), res)
  return { status: captured.status, json: JSON.parse(captured.body) as Record<string, unknown> }
}

describe('panel routes', () => {
  it('registers every route and removes them on dispose', () => {
    const sink = carrier()
    const dispose = registerPanelRoutes(sink, apiDouble())

    expect([...sink.routes.keys()].sort()).toEqual(Object.values(ROUTES).sort())

    dispose()
    expect(sink.routes.size).toBe(0)
  })

  it('serves connections and the active selection in one round trip', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    const { status, json } = await call(sink.routes, ROUTES.connections, 'GET')

    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true, activeId: connId })
    expect((json.connections as unknown[]).length).toBe(1)
  })

  it('saves, removes and activates connections', async () => {
    const api = apiDouble()
    const sink = carrier()
    registerPanelRoutes(sink, api)

    const draft = { name: 'dor', dbms: 'doris', host: 'h', port: 9030, username: 'u' }
    const saved = await call(sink.routes, ROUTES.save, 'POST', { draft })
    expect(saved.json).toMatchObject({ ok: true, connection: { id: connId } })

    const removed = await call(sink.routes, ROUTES.remove, 'POST', { connId })
    expect(removed.json).toMatchObject({ ok: true, removed: true })

    const activated = await call(sink.routes, ROUTES.activate, 'POST', { connId: null })
    expect(activated.json).toMatchObject({ ok: true })
    expect(api.setActive).toHaveBeenCalledWith(null)
  })

  it('runs the three-state test and the statement calls', async () => {
    const api = apiDouble()
    const sink = carrier()
    registerPanelRoutes(sink, api)

    expect((await call(sink.routes, ROUTES.test, 'POST', { connId })).json).toMatchObject({ ok: true, result: { state: 'YES' } })
    expect((await call(sink.routes, ROUTES.execute, 'POST', { connId, sql: 'SELECT 1' })).json).toMatchObject({ ok: true })
    expect((await call(sink.routes, ROUTES.fetchPage, 'POST', { connId, sql: 'SELECT 1', offset: 500 })).json).toMatchObject({ ok: true })
    expect((await call(sink.routes, ROUTES.cancel, 'POST', { statementId: 'ui-1' })).json).toMatchObject({ ok: true, result: { cancelled: true } })

    expect(api.execute).toHaveBeenCalledWith({ connId, sql: 'SELECT 1' })
  })

  it('answers 405 for a GET on a POST route', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    const { status, json } = await call(sink.routes, ROUTES.execute, 'GET')

    expect(status).toBe(405)
    expect(json).toMatchObject({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } })
  })

  it('refuses a caller the connection fence rejected', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble(), () => 401)

    for (const path of [ROUTES.connections, ROUTES.execute]) {
      const { status, json } = await call(sink.routes, path, 'POST', { connId, sql: 'SELECT 1' })
      expect(status).toBe(401)
      expect(json).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } })
    }
  })

  it('maps a refusal to its status code and a bad body to 400', async () => {
    const sink = carrier()
    registerPanelRoutes(
      sink,
      apiDouble({
        test: async () => Promise.reject(new PanelError('CONN_NOT_FOUND', '未知连接')),
        save: async () => Promise.reject(new PanelError('INVALID_DRAFT', '名称不能为空', 'name')),
      }),
    )

    const missing = await call(sink.routes, ROUTES.test, 'POST', { connId: 'nope' })
    expect(missing.status).toBe(404)
    expect(missing.json).toMatchObject({ ok: false, error: { code: 'CONN_NOT_FOUND' } })

    const invalid = await call(sink.routes, ROUTES.save, 'POST', {
      draft: { name: '', dbms: 'doris', host: 'h', port: 1, username: 'u' },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.json).toMatchObject({ ok: false, error: { code: 'INVALID_DRAFT', field: 'name' } })

    const noField = await call(sink.routes, ROUTES.remove, 'POST', {})
    expect(noField.status).toBe(400)
    expect(noField.json).toMatchObject({ error: { code: 'BAD_BODY' } })

    const badActivate = await call(sink.routes, ROUTES.activate, 'POST', { connId: 7 })
    expect(badActivate.status).toBe(400)
  })

  it('turns an unexpected throw into a 400 the panel can show', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble({ execute: async () => Promise.reject(new Error('socket gone')) }))

    const { status, json } = await call(sink.routes, ROUTES.execute, 'POST', { connId, sql: 'SELECT 1' })

    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'socket gone' } })
  })

  it('rejects an oversized body', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())
    const handler = sink.routes.get(ROUTES.execute)!

    const big = 'x'.repeat(MAX_BODY_BYTES + 1)
    const stream = Readable.from([Buffer.from(`{"sql":"${big}"}`)]) as unknown as IncomingMessage
    ;(stream as { method?: string }).method = 'POST'
    const { res, captured } = response()

    await handler(stream, res)

    expect(captured.status).toBe(413)
    expect(JSON.parse(captured.body)).toMatchObject({ ok: false, error: { code: 'BODY_TOO_LARGE' } })
  })

  it('accepts an empty body as an empty object', async () => {
    const api = apiDouble()
    const sink = carrier()
    registerPanelRoutes(sink, api)

    const { status, json } = await call(sink.routes, ROUTES.save, 'POST')

    // No draft in the body: the route says so rather than crashing.
    expect(status).toBe(400)
    expect(json).toMatchObject({ error: { code: 'BAD_BODY', message: '缺少字段 draft' } })
  })

  it('logs a client registration failure where the operator can see it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    const { status, json } = await call(sink.routes, ROUTES.clientError, 'POST', {
      message: 'TypeError: slots unavailable',
      stack: 'at apply',
    })

    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true })
    expect(logged.mock.calls[0]?.[0]).toContain('客户端注册失败')
    expect(logged.mock.calls[0]?.[0]).toContain('slots unavailable')
    logged.mockRestore()
  })

  it('accepts a client report without a message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    await call(sink.routes, ROUTES.clientError, 'POST', {})

    expect(logged.mock.calls[0]?.[0]).toContain('(no message)')
    logged.mockRestore()
  })

  it('serves the schema for a connection, with refresh passed through', async () => {
    const api = apiDouble()
    const sink = carrier()
    registerPanelRoutes(sink, api)

    const { status, json } = await call(sink.routes, ROUTES.schema, 'GET', undefined, `${ROUTES.schema}?connId=${connId}&refresh=1`)

    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true, schema: { tables: [] } })
    expect(api.schema).toHaveBeenCalledWith(connId, { refresh: true })
  })

  it('refuses a schema request without a connection', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    const { status, json } = await call(sink.routes, ROUTES.schema, 'GET', undefined, ROUTES.schema)

    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: { code: 'BAD_BODY' } })
  })

  it('maps a schema failure to a status the panel can show', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble({ schema: async () => Promise.reject(new PanelError('CONN_NOT_FOUND', '未知连接')) }))

    const { status, json } = await call(sink.routes, ROUTES.schema, 'GET', undefined, `${ROUTES.schema}?connId=nope`)

    expect(status).toBe(404)
    expect(json).toMatchObject({ ok: false, error: { code: 'CONN_NOT_FOUND' } })
  })

  it('applies the trust fence to the schema route', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble(), () => 401)

    const { status } = await call(sink.routes, ROUTES.schema, 'GET', undefined, `${ROUTES.schema}?connId=${connId}`)

    expect(status).toBe(401)
  })

  it('treats a request without a url as having no parameters', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())

    const { status, json } = await call(sink.routes, ROUTES.schema, 'GET')

    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: { code: 'BAD_BODY' } })
  })

  it('turns an unexpected schema failure into INTERNAL', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble({ schema: async () => Promise.reject(new Error('driver gone')) }))

    const { status, json } = await call(sink.routes, ROUTES.schema, 'GET', undefined, `${ROUTES.schema}?connId=${connId}`)

    expect(status).toBe(400)
    expect(json).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'driver gone' } })
  })

  it('reads a string chunk as well as a Buffer chunk', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())
    const handler = sink.routes.get(ROUTES.remove)!
    const stream = Readable.from(['{"connId":"ds-1"}']) as unknown as IncomingMessage
    ;(stream as { method?: string }).method = 'POST'
    const { res, captured } = response()

    await handler(stream, res)

    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toMatchObject({ ok: true, removed: true })
  })

  it('refuses a JSON body that is not an object', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble())
    const handler = sink.routes.get(ROUTES.remove)!
    const stream = Readable.from([Buffer.from('null')]) as unknown as IncomingMessage
    ;(stream as { method?: string }).method = 'POST'
    const { res, captured } = response()

    await handler(stream, res)

    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body)).toMatchObject({ error: { code: 'BAD_BODY' } })
  })
})

describe('execute-script route', () => {
  it('returns per-statement results', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble({
      executeScript: async () => ({
        durationMs: 9,
        statements: [{ index: 0, sql: 'SELECT 1', ok: true, response: { columns: [], rows: [], total: 0, hasNextPage: false, offset: 0, durationMs: 2, statementId: 's' } }],
      }),
    }))

    const { status, json } = await call(sink.routes, ROUTES.executeScript, 'POST', { connId, sql: 'SELECT 1' })

    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true, script: { durationMs: 9 } })
  })

  it('passes a refusal straight through', async () => {
    const sink = carrier()
    registerPanelRoutes(sink, apiDouble({
      executeScript: async () => ({ refusal: { code: 'EMPTY_SQL', message: '没有可执行的语句' } }),
    }))

    const { json } = await call(sink.routes, ROUTES.executeScript, 'POST', { connId, sql: ' ' })

    expect(json).toMatchObject({ ok: true, refusal: { code: 'EMPTY_SQL' } })
  })
})
