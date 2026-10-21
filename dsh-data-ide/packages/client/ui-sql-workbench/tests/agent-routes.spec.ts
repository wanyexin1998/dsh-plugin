import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentDelivery } from '../src/execute/agent-delivery.ts'
import type { AgentDeliveryEvent, AgentRelay } from '../src/host/agent-relay.ts'
import {
  AGENT_ROUTES,
  type AgentRouteCarrier,
  registerAgentRoutes,
} from '../src/host/agent-routes.ts'

function delivery(id = 'd1'): AgentDelivery {
  return {
    schema: 1,
    id,
    label: '月报',
    connId: 'doris',
    consoleId: null,
    sql: 'select 1',
    kind: 'single',
    at: '2026-10-21T00:00:00.000Z',
    single: {
      ok: true,
      columns: [{ name: 'a', typeName: 'INT' }],
      rows: [[1]],
      total: 1,
      hasNextPage: false,
      offset: 0,
      durationMs: 1,
      statementId: 's1',
    },
  }
}

function request(
  method: string,
  url: string | undefined,
  body: string | Buffer = '',
  headers: Record<string, string | string[]> = {},
): IncomingMessage {
  const req = Readable.from(body === '' ? [] : [body]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers })
  return req
}

class ResponseStub extends EventEmitter {
  statusCode = 0
  readonly headers = new Map<string, string>()
  readonly chunks: string[] = []
  ended = false

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    return this
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.chunks.push(chunk)
    this.ended = true
    return this
  }
}

function response(): ServerResponse & ResponseStub {
  return new ResponseStub() as ServerResponse & ResponseStub
}

function relay(history: AgentDeliveryEvent[] = []): AgentRelay & {
  emit(event: AgentDeliveryEvent): void
  off: ReturnType<typeof vi.fn>
} {
  let listener: ((event: AgentDeliveryEvent) => void) | undefined
  const off = vi.fn()
  return {
    cursor: history.at(-1)?.seq ?? 0,
    since: vi.fn((seq: number) => history.filter(event => event.seq > seq)),
    subscribe: vi.fn(next => {
      listener = next
      return off
    }),
    emit(event) {
      listener?.(event)
    },
    off,
    dispose: vi.fn(async () => undefined),
  }
}

function routes() {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>()
  const disposers: Array<ReturnType<typeof vi.fn>> = []
  const carrier: AgentRouteCarrier = {
    register(route) {
      handlers.set(route.path, route.handler)
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    },
  }
  return { carrier, handlers, disposers }
}

function json(res: ResponseStub): unknown {
  return JSON.parse(res.chunks.join('')) as unknown
}

afterEach(() => vi.useRealTimers())

describe('agent routes', () => {
  it('serves polling results and rejects wrong methods or untrusted callers', () => {
    const event = { seq: 2, delivery: delivery() }
    const bridge = relay([event])
    const registered = routes()
    const dispose = registerAgentRoutes(registered.carrier, bridge)
    const handler = registered.handlers.get(AGENT_ROUTES.results)!

    const ok = response()
    handler(request('GET', `${AGENT_ROUTES.results}?since=1`), ok)
    expect(ok.statusCode).toBe(200)
    expect(json(ok)).toMatchObject({ ok: true, cursor: 2, events: [event] })

    const invalidSince = response()
    handler(request('GET', `${AGENT_ROUTES.results}?since=nope`), invalidSince)
    expect(bridge.since).toHaveBeenLastCalledWith(0)

    const defaultUrl = response()
    handler(request('GET', undefined), defaultUrl)
    expect(bridge.since).toHaveBeenLastCalledWith(0)

    const method = response()
    handler(request('POST', AGENT_ROUTES.results), method)
    expect(method.statusCode).toBe(405)

    const fencedRoutes = routes()
    registerAgentRoutes(fencedRoutes.carrier, bridge, () => 403)
    const fenced = response()
    fencedRoutes.handlers.get(AGENT_ROUTES.results)!(request('GET', AGENT_ROUTES.results), fenced)
    expect(fenced.statusCode).toBe(403)
    expect(json(fenced)).toMatchObject({ ok: false, error: { code: 'UNTRUSTED' } })

    const fencedEvents = response()
    fencedRoutes.handlers.get(AGENT_ROUTES.events)!(request('GET', AGENT_ROUTES.events), fencedEvents)
    expect(fencedEvents.statusCode).toBe(403)

    dispose()
    expect(registered.disposers).toHaveLength(2)
    expect(registered.disposers.every(off => off.mock.calls.length === 1)).toBe(true)
  })

  it('streams live and resumed events, then releases the subscriber on close', () => {
    vi.useFakeTimers()
    const bridge = relay([{ seq: 2, delivery: delivery('replayed') }])
    const registered = routes()
    registerAgentRoutes(registered.carrier, bridge)
    const handler = registered.handlers.get(AGENT_ROUTES.events)!
    const req = request('GET', AGENT_ROUTES.events, '', { 'last-event-id': '1' })
    const res = response()

    handler(req, res)
    bridge.emit({ seq: 3, delivery: delivery('live') })
    vi.advanceTimersByTime(15_000)

    expect(res.statusCode).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.chunks.join('')).toContain('retry: 3000')
    expect(res.chunks.join('')).toContain('replayed')
    expect(res.chunks.join('')).toContain('live')
    expect(res.chunks.join('')).toContain(': keep-alive')

    req.emit('close')
    expect(bridge.off).toHaveBeenCalledOnce()
    expect(res.ended).toBe(true)
  })

  it('tolerates a stream write disappearing during live, replay and keep-alive output', () => {
    vi.useFakeTimers()
    const bridge = relay([{ seq: 2, delivery: delivery('replayed') }])
    const registered = routes()
    registerAgentRoutes(registered.carrier, bridge)
    const req = request('GET', AGENT_ROUTES.events, '', { 'last-event-id': '1' })
    const res = response()
    let writes = 0
    res.write = vi.fn(() => {
      writes += 1
      if (writes > 1) throw new Error('gone')
      return true
    }) as ServerResponse['write']

    registered.handlers.get(AGENT_ROUTES.events)!(req, res)
    bridge.emit({ seq: 3, delivery: delivery('live') })
    vi.advanceTimersByTime(15_000)
    req.emit('error', new Error('gone'))

    expect(bridge.off).toHaveBeenCalledOnce()
    expect(res.ended).toBe(true)
  })

  it('ignores a non-string Last-Event-ID header', () => {
    vi.useFakeTimers()
    const bridge = relay([{ seq: 2, delivery: delivery('replayed') }])
    const registered = routes()
    registerAgentRoutes(registered.carrier, bridge)
    const req = request('GET', AGENT_ROUTES.events, '', { 'last-event-id': ['1'] })
    const res = response()
    registered.handlers.get(AGENT_ROUTES.events)!(req, res)
    expect(bridge.since).not.toHaveBeenCalled()
    req.emit('close')
  })

  it('writes a filtered console registry and handles empty, bad and oversized bodies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-routes-'))
    const registryPath = join(dir, 'consoles.json')
    const registered = routes()
    registerAgentRoutes(registered.carrier, relay(), undefined, { registryPath })
    const handler = registered.handlers.get(AGENT_ROUTES.consoles)!

    const ok = response()
    await handler(
      request('POST', AGENT_ROUTES.consoles, Buffer.from(JSON.stringify({
        consoles: [
          { id: 'user-1', owner: 'user', title: 'SQL-1' },
          { id: '', owner: 'user', title: 'invalid' },
        ],
      }))),
      ok,
    )
    expect(json(ok)).toMatchObject({ ok: true, count: 1 })
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      consoles: [{ id: 'user-1', owner: 'user', title: 'SQL-1' }],
    })

    const empty = response()
    await handler(request('POST', AGENT_ROUTES.consoles), empty)
    expect(json(empty)).toMatchObject({ ok: true, count: 0 })

    for (const body of ['1', '{', JSON.stringify({ pad: 'x'.repeat(256 * 1024) })]) {
      const bad = response()
      await handler(request('POST', AGENT_ROUTES.consoles, body), bad)
      expect(bad.statusCode).toBe(400)
    }

    const method = response()
    await handler(request('GET', AGENT_ROUTES.consoles), method)
    expect(method.statusCode).toBe(405)

    const fencedRoutes = routes()
    registerAgentRoutes(fencedRoutes.carrier, relay(), () => 401, { registryPath })
    const fenced = response()
    await fencedRoutes.handlers.get(AGENT_ROUTES.consoles)!(request('POST', AGENT_ROUTES.consoles, '{}'), fenced)
    expect(fenced.statusCode).toBe(401)
    await rm(dir, { recursive: true, force: true })
  })

  it('reports registry write failures and still disposes every registered route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-routes-failure-'))
    const parentFile = join(dir, 'not-a-directory')
    await writeFile(parentFile, 'x', 'utf8')
    const registered = routes()
    const dispose = registerAgentRoutes(registered.carrier, relay(), undefined, {
      registryPath: join(parentFile, 'consoles.json'),
    })
    const res = response()

    await registered.handlers.get(AGENT_ROUTES.consoles)!(request('POST', AGENT_ROUTES.consoles, '{}'), res)
    expect(res.statusCode).toBe(500)
    expect(json(res)).toMatchObject({ ok: false, error: { code: 'REGISTRY_WRITE_FAILED' } })

    dispose()
    expect(registered.disposers).toHaveLength(3)
    expect(registered.disposers.every(off => off.mock.calls.length === 1)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})
