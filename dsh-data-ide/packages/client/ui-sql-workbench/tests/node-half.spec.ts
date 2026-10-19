import { describe, expect, it, vi } from 'vitest'

import { apply, inject, injectOptional } from '../src/index.ts'
import type { NodeHostContext } from '../src/host/contract.ts'
import { ROUTES } from '../src/host/web-routes.ts'

/** Minimal host double: records what the node half asked for. */
function fakeCtx(options: { readonly webServer?: boolean; readonly connection?: () => number | undefined } = {}) {
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
    dshHomePath: () => 'C:/tmp/dsh-data-ide-node-half-test',
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

    expect(host.routes).toEqual(Object.values(ROUTES))
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

    expect(registered).toEqual(Object.values(ROUTES))
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
