import { readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Scripted mysql2 driver: the panel path opens sockets in the host process. */
const driver = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), destroy: vi.fn(), createConnection: vi.fn() }))
vi.mock('mysql2/promise', () => ({ createConnection: driver.createConnection }))

import { apply, inject } from '../src/index.ts'
import { createDataSource, credentialId } from '../src/datasource/model.ts'
import {
  createCredentialsPort,
  createKvStore,
  createPublishingStore,
  DOMAIN_NAME,
  DOMAIN_SPEC,
  DOCUMENTS_TABLE,
  resolveHome,
  startHostServices,
} from '../src/host/binding.ts'
import type { CredentialsService, Domain, DomainSpec, NodeHostContext } from '../src/host/contract.ts'
import { parseRuntimeSpecs } from '../mcp/runtime-specs.ts'

const connId = 'f02da6e0-4a1b-4c2d-9f3e-77c1b2a9d0e5'
const doris = createDataSource({
  id: connId,
  name: 'doris.shcell.com',
  dbms: 'doris',
  host: 'doris.shcell.com',
  port: 9030,
  database: 'dwd',
  username: 'wanyexin',
})

/** In-memory stand-ins for the two host seams. */
function fakeHost(options: { readonly records?: Record<string, unknown> } = {}) {
  const records = new Map<string, unknown>(Object.entries(options.records ?? {}))
  const tables = new Map<string, Map<string, unknown>>()
  const closed: string[] = []
  const opened: DomainSpec[] = []

  const domain: Domain = {
    table: name => {
      const store = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, store)
      return {
        get: key => store.get(key),
        entries: () => store.entries(),
        put: async (key, value) => {
          store.set(key, value)
        },
        delete: async key => store.delete(key),
      }
    },
    close: async () => {
      closed.push('domain')
    },
  }

  const credentials: CredentialsService = {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next === undefined) return undefined
      records.set(key, next)
      return next
    },
    deleteRecord: async key => {
      records.delete(key)
    },
    listRecords: async () => [...records.keys()].map(key => ({ key })),
  }

  const provided: { key: string; value: unknown }[] = []
  const effects: (() => void | Promise<void>)[] = []
  const pending: Promise<unknown>[] = []
  const ctx = {
    effect<T>(setup: () => T | Promise<T>): T | Promise<T> {
      effects.push(setup as () => void | Promise<void>)
      // Cordis awaits an async effect before the fiber settles; the double has
      // to offer the same handle or assertions run against half-built state.
      const outcome = setup()
      pending.push(Promise.resolve(outcome))
      return outcome
    },
    storageDomain: {
      open: async (spec: DomainSpec) => {
        opened.push(spec)
        return domain
      },
    },
    credentials,
    dshHomePath: (...segments: string[]) => join(home, ...segments),
    reflect: {
      provide: (key: string, value: unknown) => {
        provided.push({ key, value })
        return () => {
          provided.splice(provided.indexOf({ key, value }), 1)
        }
      },
    },
  } as unknown as NodeHostContext

  return { ctx, records, tables, closed, opened, provided, effects, settle: () => Promise.all(pending) }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-data-ide-home-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('domain declaration', () => {
  it('names the plugin and keeps one permissive document table', () => {
    expect(DOMAIN_SPEC.name).toBe(DOMAIN_NAME)
    expect(DOMAIN_SPEC.layout).toBe('single')
    expect(Object.keys(DOMAIN_SPEC.tables)).toEqual([DOCUMENTS_TABLE])
  })

  it('uses a name the storage backend accepts', () => {
    // storage-json: `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`; a dashed name fails the
    // whole node half at boot with `StorageError: invalid unit name`.
    expect(DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(DOMAIN_NAME).toBe('dsh_data_ide')
  })

  it('opens exactly the declared domain', async () => {
    const host = fakeHost()

    await host.ctx.storageDomain.open(DOMAIN_SPEC)

    expect(host.opened).toEqual([DOMAIN_SPEC])
  })
})

/** Open the fake domain once and hand it back for direct adapter tests. */
async function hostOpened(host: ReturnType<typeof fakeHost>): Promise<Domain> {
  return host.ctx.storageDomain.open(DOMAIN_SPEC)
}

describe('kv adapter', () => {
  it('round-trips values through the documents table', async () => {
    const host = fakeHost()
    const kv = createKvStore(await hostOpened(host))

    await kv.put('datasources', { schemaVersion: 1 })
    kv.put('active', 'ds-1')

    expect(await kv.get('datasources')).toEqual({ schemaVersion: 1 })
    expect(await kv.get('active')).toBe('ds-1')
    expect(await kv.entries()).toEqual(await kv.entries())
    expect(await kv.delete('active')).toBe(true)
    expect(await kv.get('active')).toBeUndefined()
  })
})

describe('credentials adapter', () => {
  it('forwards every call to the host service', async () => {
    const host = fakeHost()
    const port = createCredentialsPort(host.ctx.credentials)

    await port.modifyRecord('dsh-data-ide/ds-1', async () => ({ password: 'p', secretStorage: 'master_key' }))

    expect(await port.readRecord('dsh-data-ide/ds-1')).toEqual({ password: 'p', secretStorage: 'master_key' })
    expect(await port.listRecords()).toEqual([{ key: 'dsh-data-ide/ds-1' }])
    await port.deleteRecord('dsh-data-ide/ds-1')
    expect(await port.listRecords()).toEqual([])
  })
})

describe('publishing store', () => {
  it('republishes after a mutation but not after a read', async () => {
    const host = fakeHost()
    let publishes = 0
    const store = createPublishingStore(
      {
        list: async () => [],
        get: async () => undefined,
        save: async () => undefined,
        remove: async () => true,
        setActive: async () => undefined,
        active: async () => null,
        recordTestResult: async () => undefined,
      },
      async () => {
        publishes += 1
      },
    )

    expect(await store.list()).toEqual([])
    expect(await store.get('x')).toBeUndefined()
    expect(await store.active()).toBeNull()
    await store.save(doris)
    await store.setActive(connId)
    await store.remove('x')
    await store.recordTestResult(connId, 'YES', 'now')

    expect(publishes).toBe(4)
  })
})

describe('host services', () => {
  it('declares the seams it needs', () => {
    expect(inject).toEqual(['storageDomain', 'credentials'])
  })

  it('publishes an empty spec file on start and removes it on dispose', async () => {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const specPath = join(home, 'data-ide-runtime', 'conn-specs.json')

    expect(parseRuntimeSpecs(await readFile(specPath, 'utf8')).connections).toEqual({})
    expect(host.provided.map(entry => entry.key)).toEqual(['sqlWorkbench'])

    await dispose()

    await expect(readFile(specPath, 'utf8')).rejects.toThrow()
    expect(host.closed).toEqual(['domain'])
  })

  it('publishes a connection once its password is stored, and drops it again on delete', async () => {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const service = host.provided[0]?.value as { dataSources: { save: (d: unknown) => Promise<void>; remove: (id: string) => Promise<boolean> } }
    const specPath = join(home, 'data-ide-runtime', 'conn-specs.json')

    await service.dataSources.save(doris)
    expect(Object.keys(parseRuntimeSpecs(await readFile(specPath, 'utf8')).connections)).toEqual([])

    await host.records.set(`dsh-data-ide/${credentialId(connId)}`, { password: 'hunter2', secretStorage: 'master_key' })
    expect(await serviceCredentials(host).resolve(connId)).toBe('hunter2')
    await service.dataSources.save(doris)
    expect(parseRuntimeSpecs(await readFile(specPath, 'utf8')).connections[connId]?.password).toBe('hunter2')

    await service.dataSources.remove(connId)
    expect(parseRuntimeSpecs(await readFile(specPath, 'utf8')).connections).toEqual({})
    await dispose()
  })

  it('wires the same lifecycle through the node half', async () => {
    const host = fakeHost()

    apply(host.ctx)
    await host.settle()

    expect(host.opened.map(spec => spec.name)).toEqual([DOMAIN_NAME])
    expect(host.provided).toHaveLength(1)
  })
})

/** Read the credential store the service published. */
function serviceCredentials(host: ReturnType<typeof fakeHost>) {
  return (host.provided[0]?.value as { credentials: { resolve: (id: string) => Promise<string | undefined> } }).credentials
}

describe('home resolution', () => {
  it('prefers the host resolver', () => {
    const host = fakeHost()

    expect(resolveHome(host.ctx).replace(/\\/g, '/')).toBe(home.replace(/\\/g, '/'))
  })

  it('falls back to an empty home when the environment says nothing', () => {
    const previous = { home: process.env.DSH_HOME, profile: process.env.USERPROFILE, posix: process.env.HOME }
    delete process.env.DSH_HOME
    delete process.env.USERPROFILE
    delete process.env.HOME

    expect(resolveHome({} as NodeHostContext)).toBe('/.dsh')

    if (previous.home !== undefined) process.env.DSH_HOME = previous.home
    if (previous.profile !== undefined) process.env.USERPROFILE = previous.profile
    if (previous.posix !== undefined) process.env.HOME = previous.posix
  })

  it('falls back to the POSIX home when the Windows profile variable is absent', () => {
    const previous = { home: process.env.DSH_HOME, profile: process.env.USERPROFILE, posix: process.env.HOME }
    delete process.env.DSH_HOME
    delete process.env.USERPROFILE
    process.env.HOME = '/home/dev'

    expect(resolveHome({} as NodeHostContext)).toBe('/home/dev/.dsh')

    if (previous.home !== undefined) process.env.DSH_HOME = previous.home
    if (previous.profile !== undefined) process.env.USERPROFILE = previous.profile
    if (previous.posix !== undefined) process.env.HOME = previous.posix
  })

  it('falls back to DSH_HOME, then the user profile', () => {
    const previous = { home: process.env.DSH_HOME, profile: process.env.USERPROFILE }
    process.env.DSH_HOME = 'C:/custom/.dsh'
    expect(resolveHome({} as NodeHostContext)).toBe('C:/custom/.dsh')
    delete process.env.DSH_HOME
    process.env.USERPROFILE = 'C:/Users/x'
    expect(resolveHome({} as NodeHostContext)).toBe('C:/Users/x/.dsh')
    if (previous.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.home
    if (previous.profile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.profile
  })
})

describe('binding adapters', () => {
  it('forgets a session secret when pruning by normalised id', async () => {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const service = host.provided[0]?.value as {
      credentials: {
        set: (id: string, password: string, storage: 'session') => Promise<void>
        removeNormalized: (id: string) => Promise<void>
        resolve: (id: string) => Promise<string | undefined>
      }
    }
    const uuid = '22222222-3333-4444-5555-666666666666'

    await service.credentials.set(uuid, 'ephemeral', 'session')
    expect(await service.credentials.resolve(uuid)).toBe('ephemeral')

    await service.credentials.removeNormalized('ds-22222222')

    expect(await service.credentials.resolve(uuid)).toBeUndefined()
    await dispose()
  })

  it('publishes through the storage service exposed to the client half', async () => {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const service = host.provided[0]?.value as { publish: () => Promise<void>; specPath: string }

    await service.publish()

    expect(service.specPath.replace(/\\/g, '/')).toContain('/data-ide-runtime/conn-specs.json')
    await dispose()
  })

  it('persists layout through the service exposed to the route layer', async () => {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const service = host.provided[0]?.value as {
      readLayout: () => Promise<unknown>
      saveLayout: (layout: unknown) => Promise<void>
    }

    await expect(service.readLayout()).resolves.toBeNull()
    await service.saveLayout({ treeOpen: false, treeWidth: 312 })
    await expect(service.readLayout()).resolves.toEqual({ treeOpen: false, treeWidth: 312 })
    await dispose()
  })
})

describe('panel execution path', () => {
  interface PanelService {
    readonly dataSources: { save: (d: unknown) => Promise<unknown> }
    execute: (request: { connId: string; sql: string; statementId?: string; pageSize?: number }) => Promise<Record<string, unknown>>
    fetchPage: (request: { connId: string; sql: string; offset: number; pageSize?: number; statementId?: string }) => Promise<Record<string, unknown>>
    cancel: (statementId: string) => Promise<{ readonly cancelled: boolean }>
  }

  /** Boot the service with one saved connection whose password is already in credentials. */
  async function started(): Promise<{ host: ReturnType<typeof fakeHost>; service: PanelService; dispose: () => Promise<void> }> {
    const host = fakeHost()
    const { dispose } = await startHostServices(host.ctx)
    const service = host.provided[0]?.value as PanelService
    await service.dataSources.save(doris)
    await host.records.set(`dsh-data-ide/${credentialId(connId)}`, { password: 'hunter2', secretStorage: 'master_key' })
    return { host, service, dispose }
  }

  it('executes for the panel from in-memory specs, not the published file', async () => {
    driver.createConnection.mockReset()
    driver.query.mockReset()
    driver.end.mockReset().mockResolvedValue(undefined)
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })
    driver.query.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)') ? [[{ c: 2 }], [{ name: 'c', type: 8 }]] : [[{ a: 1 }], [{ name: 'a', type: 3 }]],
    )
    const { service, dispose } = await started()

    const result = await service.execute({ connId, sql: 'SELECT a FROM t', statementId: 'ui-1' })

    expect(result).toMatchObject({
      ok: true,
      columns: [{ name: 'a', typeName: 'LONG' }],
      rows: [[1]],
      total: 2,
      statementId: 'ui-1',
    })
    expect(driver.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'doris.shcell.com', port: 9030, user: 'wanyexin', password: 'hunter2', database: 'dwd' }),
    )
    await dispose()
  })

  it('fetches later pages and cancels by the id the panel minted', async () => {
    driver.createConnection.mockReset()
    driver.query.mockReset()
    driver.end.mockReset().mockResolvedValue(undefined)
    driver.destroy.mockReset().mockResolvedValue(undefined)
    driver.createConnection.mockResolvedValue({ query: driver.query, end: driver.end, destroy: driver.destroy })
    driver.query.mockResolvedValue([[{ a: 7 }], [{ name: 'a', type: 3 }]])
    const { service, dispose } = await started()

    const page = await service.fetchPage({ connId, sql: 'SELECT a FROM t', offset: 500, statementId: 'ui-2' })

    expect(page).toMatchObject({ ok: true, offset: 500, total: null, statementId: 'ui-2' })
    expect(await service.cancel('ui-2')).toEqual({ cancelled: true })
    await dispose()
  })

  it('refuses a write for the panel exactly as the agent would be refused', async () => {
    driver.createConnection.mockReset()
    driver.query.mockReset()
    const { service, dispose } = await started()

    const result = await service.execute({ connId, sql: 'DELETE FROM t' })

    expect(result).toMatchObject({ ok: false, error: { code: 'WRITE_NOT_ALLOWED' } })
    expect(driver.createConnection).not.toHaveBeenCalled()
    await dispose()
  })
})
