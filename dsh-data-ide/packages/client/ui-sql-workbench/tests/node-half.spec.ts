import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, injectOptional } from '../src/index.ts'
import type { NodeHostContext } from '../src/host/contract.ts'
import { AGENT_ROUTES } from '../src/host/agent-routes.ts'
import { ROUTES } from '../src/host/web-routes.ts'

/** Panel routes plus the agent delivery routes, in registration order. */
/** Panel + agent routes as a set: registration order is not part of the contract. */
const ALL_ROUTES = [...Object.values(ROUTES), ...Object.values(AGENT_ROUTES)].sort()
// One path can be registered twice (GET + POST), so compare unique paths.
const sorted = (routes: readonly string[]): string[] => [...new Set(routes)].sort()

/** Minimal host double: records what the node half asked for. */
function fakeCtx(options: { readonly webServer?: boolean; readonly connection?: () => number | undefined; readonly home?: boolean } = {}) {
  const opened: string[] = []
  const closed: string[] = []
  const provided: string[] = []
  const routes: string[] = []
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
  /** What each effect handed back — Cordis requires a disposer or nothing. */
  const effectResults: unknown[] = []
  const pending: Promise<unknown>[] = []

  const webServer = {
    register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
      routes.push(route.path)
      handlers.set(route.path, route.handler)
      return () => {}
    },
  }

  const connection = options.connection === undefined ? undefined : { requestRejection: options.connection }

  const ctx = {
    effect<T>(setup: () => T | Promise<T>): T | Promise<T> {
      const outcome = setup()
      pending.push(Promise.resolve(outcome).then(value => effectResults.push(value)))
      return outcome
    },
    storageDomain: {
      open: async (spec: { name: string }) => {
        opened.push(spec.name)
        return {
          table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](), put: async () => {}, delete: async () => false }),
          close: async () => {
            closed.push('domain')
          },
        }
      },
    },
    credentials: {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
      deleteRecord: async () => {},
      listRecords: async () => [],
    },
    ...(options.home === false ? {} : { dshHomePath: () => 'C:/tmp/dsh-data-ide-node-half-test' }),
    reflect: {
      provide: (key: string) => {
        provided.push(key)
        return () => {}
      },
    },
    get: (name: string) => {
      if (options.webServer !== true) return undefined
      if (name === 'webServer') return webServer
      if (name === 'connection') return connection
      return undefined
    },
  } as unknown as NodeHostContext

  return {
    ctx,
    opened,
    closed,
    provided,
    routes,
    handlers,
    effectResults,
    settled: () => Promise.all(pending),
  }
}

describe('node half', () => {
  it('declares the host seams it needs', () => {
    expect(inject).toEqual(['storageDomain', 'credentials'])
    // webServer carries the panel's routes; connection is the trust fence.
    expect(injectOptional).toEqual(['webServer', 'connection'])
  })

  it('opens the storage domain and publishes its services', async () => {
    const host = fakeCtx({ webServer: true })

    apply(host.ctx)
    await host.settled()

    // storage-json unit names are `/^[a-z][a-z0-9_]*$/`; the dashed package name
    // is rejected at boot, so the domain uses underscores.
    expect(host.opened).toEqual(['dsh_data_ide'])
    expect(host.provided).toEqual(['sqlWorkbench'])
  })

  it('hands Cordis a disposer, not an object', async () => {
    const host = fakeCtx({ webServer: true })

    apply(host.ctx)
    await host.settled()

    // `TypeError: Invalid effect` is what an effect resolving to
    // `{ service, api, dispose }` produced: the node entry died and the panel
    // silently lost its backend.
    expect(host.effectResults).toHaveLength(1)
    expect(host.effectResults[0]).toBeTypeOf('function')
  })

  it('mounts the panel routes on the composition webserver', async () => {
    const host = fakeCtx({ webServer: true })

    apply(host.ctx)
    await host.settled()

    expect(sorted(host.routes)).toEqual(ALL_ROUTES)
  })

  it('rejects every caller when the host did not provide connection', async () => {
    const host = fakeCtx({ webServer: true })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    apply(host.ctx)
    await host.settled()

    const res = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await host.handlers.get(ROUTES.connections)!({ method: 'GET' }, res)

    expect(sorted(host.routes)).toEqual(ALL_ROUTES)
    expect(res.statusCode).toBe(401)
    expect(res.body).toContain('UNTRUSTED')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('connection'))
    logged.mockRestore()
  })

  it('refuses a caller the connection fence rejected', async () => {
    const host = fakeCtx({ webServer: true, connection: () => 401 })
    apply(host.ctx)
    await host.settled()

    const res = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await host.handlers.get(ROUTES.connections)!({}, res)

    expect(res.statusCode).toBe(401)
    expect(res.body).toContain('UNTRUSTED')
  })

  it('admits callers once connection mounts after apply()', async () => {
    let lateConnection: { requestRejection: () => number | undefined } | undefined
    const host = fakeCtx({ webServer: true })
    const originalGet = host.ctx.get!
    ;(host.ctx as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'connection' ? lateConnection : originalGet(name)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    apply(host.ctx)
    await host.settled()

    const beforeRes = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await host.handlers.get(ROUTES.connections)!({ method: 'GET' }, beforeRes)
    expect(beforeRes.statusCode).toBe(401)

    lateConnection = { requestRejection: () => undefined }
    const afterRes = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await host.handlers.get(ROUTES.connections)!({ method: 'GET' }, afterRes)
    expect(afterRes.statusCode).toBe(200)
    logged.mockRestore()
  })

  it('mounts panel routes once webServer attaches after apply()', async () => {
    const lateRoutes: string[] = []
    const lateHandlers = new Map<string, (req: unknown, res: unknown) => Promise<void> | void>()
    const latePending: Promise<unknown>[] = []
    let onWebServer: ((webCtx: NodeHostContext) => void) | undefined
    const host = fakeCtx()
    ;(host.ctx as { inject?: (deps: readonly string[], cb: (webCtx: NodeHostContext) => void) => { dispose(): void } }).inject = (
      deps,
      cb,
    ) => {
      if (deps.includes('webServer')) onWebServer = cb
      return { dispose() {} }
    }

    apply(host.ctx)
    await host.settled()
    expect(lateRoutes).toEqual([])
    expect(onWebServer).toBeTypeOf('function')

    const lateWebServer = {
      register(route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) {
        lateRoutes.push(route.path)
        lateHandlers.set(route.path, route.handler)
        return () => {}
      },
    }
    const lateConnection = { requestRejection: () => undefined }
    onWebServer!({
      ...host.ctx,
      effect<T>(setup: () => T | Promise<T>): T | Promise<T> {
        const outcome = setup()
        latePending.push(Promise.resolve(outcome))
        return outcome
      },
      get: (name: string) => (name === 'webServer' ? lateWebServer : name === 'connection' ? lateConnection : undefined),
    } as unknown as NodeHostContext)
    await Promise.all(latePending)

    expect(sorted(lateRoutes)).toEqual(ALL_ROUTES)
    const res = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await lateHandlers.get(ROUTES.connections)!({ method: 'GET' }, res)
    expect(res.statusCode).toBe(200)
  })

  it('never reads uninjected properties directly when ctx.get is present (Cordis 4 strict proxy)', async () => {
    const host = fakeCtx({ webServer: true })
    Object.defineProperty(host.ctx, 'connection', {
      get() {
        throw new Error('cannot get property "connection" without inject')
      },
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    apply(host.ctx)
    await host.settled()

    const res = { statusCode: 0, body: '', setHeader() {}, end(chunk: string) { this.body = chunk } }
    await host.handlers.get(ROUTES.connections)!({ method: 'GET' }, res)
    expect(res.statusCode).toBe(401)
    logged.mockRestore()
  })

  it('works on a context without a service lookup', async () => {
    // Older compositions expose the service as a plain property only.
    const registered: string[] = []
    const pending: Promise<unknown>[] = []
    const ctx = {
      effect: <T>(setup: () => T | Promise<T>): T | Promise<T> => {
        const outcome = setup()
        pending.push(Promise.resolve(outcome))
        return outcome
      },
      storageDomain: {
        open: async () => ({
          table: () => ({ get: () => undefined, entries: () => [][Symbol.iterator](), put: async () => {}, delete: async () => false }),
          close: async () => {},
        }),
      },
      credentials: {
        readRecord: async () => undefined,
        modifyRecord: async () => undefined,
        deleteRecord: async () => {},
        listRecords: async () => [],
      },
      dshHomePath: () => 'C:/tmp/dsh-data-ide-node-half-test',
      reflect: { provide: () => () => {} },
      webServer: {
        register(route: { path: string }) {
          registered.push(route.path)
          return () => {}
        },
      },
    } as unknown as NodeHostContext

    apply(ctx)
    await Promise.all(pending)

    expect(sorted(registered)).toEqual(ALL_ROUTES)
  })

  it('says why the panel cannot work when there is no webserver', async () => {
    const host = fakeCtx()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    apply(host.ctx)
    await host.settled()

    expect(host.routes).toEqual([])
    expect(logged.mock.calls[0]?.[0]).toContain('webServer')
    logged.mockRestore()
  })

  it('mounts panel routes but disables agent delivery without a home resolver', async () => {
    const previous = process.env.DSH_HOME
    const fallbackHome = await mkdtemp(join(tmpdir(), 'dsh-data-ide-no-resolver-'))
    process.env.DSH_HOME = fallbackHome
    const host = fakeCtx({ webServer: true, home: false })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    apply(host.ctx)
    await host.settled()

    expect(sorted(host.routes)).toEqual(Object.values(ROUTES).sort())
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('dshHomePath'))
    logged.mockRestore()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(fallbackHome, { recursive: true, force: true })
  })

  it('tears the domain down when the plugin unloads', async () => {
    const host = fakeCtx({ webServer: true })
    apply(host.ctx)
    await host.settled()

    const dispose = host.effectResults[0] as () => Promise<void>
    await dispose()

    expect(host.closed).toEqual(['domain'])
  })

  it('unloads cleanly even without routes to remove', async () => {
    const host = fakeCtx()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    apply(host.ctx)
    await host.settled()

    await (host.effectResults[0] as () => Promise<void>)()

    expect(host.closed).toEqual(['domain'])
    logged.mockRestore()
  })
})
