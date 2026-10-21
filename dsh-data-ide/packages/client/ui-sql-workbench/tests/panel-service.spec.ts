import { describe, expect, it, vi } from 'vitest'

import { createDataSource } from '../src/datasource/model.ts'
import type { DataSource } from '../src/datasource/model.ts'
import type { DataSourceStore } from '../src/datasource/store.ts'
import { createPanelApi, createExecution, PanelError } from '../src/host/panel-service.ts'
import type { CredentialStore } from '../src/host/credentials.ts'
import type { ConnectionProbe } from '../mcp/probe.ts'
import { createStatementRegistry } from '../src/execute/core.ts'
import type { QueryExecutor } from '../src/execute/core.ts'

const connId = '22222222-3333-4444-5555-666666666666'
const stored: DataSource = {
  ...createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'doris.shcell.com', username: 'wanyexin' }),
  databaseInfo: {
    product: 'Doris',
    version: '5.7.99',
    driverVersion: 'mysql2',
    dbms: 'Doris',
    identifierQuoteString: '`',
    caseSensitivity: { plain: 'exact', quoted: 'exact' },
  },
}

/** In-memory store double; records the last write for assertions. */
function storeDouble(options: { readonly saved?: DataSource; readonly active?: string | null } = {}) {
  const saved: DataSource[] = []
  const tests: { connId: string; state: string; at: string; info?: unknown }[] = []
  const store: DataSourceStore = {
    list: async () => (options.saved === undefined ? [] : [options.saved]),
    get: async id => (options.saved !== undefined && options.saved.id === id ? options.saved : undefined),
    save: async source => {
      saved.push(source)
    },
    remove: async () => true,
    setActive: async () => undefined,
    active: async () => options.active ?? null,
    recordTestResult: async (id, state, at, info) => {
      tests.push({ connId: id, state, at, ...(info === undefined ? {} : { info }) })
    },
  }
  return { store, saved, tests }
}

/** Credential double with one optional secret. */
function credentialsDouble(password: string | undefined) {
  const set = vi.fn(async () => undefined)
  const credentials: CredentialStore = {
    set,
    resolve: async () => password,
    remove: async () => undefined,
    removeNormalized: async () => undefined,
    storedIds: async () => [],
    sessionCount: () => 0,
  }
  return { credentials, set }
}

const yesProbe: ConnectionProbe = async () => ({ state: 'YES', info: stored.databaseInfo! })
const noProbe: ConnectionProbe = async () => ({ state: 'NO', error: { code: 'AUTH_FAILED', message: 'Access denied' } })

const schemaReader = { schema: async () => ({ tables: [], fetchedAt: '1970-01-01T00:00:00.000Z', truncated: false, source: 'information_schema' as const }) }

const execution = {
  execute: vi.fn(async () => ({ ok: true as const, columns: [], rows: [], total: 0, hasNextPage: false, offset: 0, durationMs: 1, statementId: 'ui-1' })),
  fetchPage: vi.fn(async () => ({ ok: true as const, columns: [], rows: [], total: null, hasNextPage: false, offset: 0, durationMs: 1, statementId: 'ui-2' })),
  cancel: vi.fn(async () => ({ cancelled: true })),
}

describe('panel api: connections', () => {
  it('passes the store calls straight through', async () => {
    const { store } = storeDouble({ saved: stored, active: connId })
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    expect(await api.list()).toEqual([stored])
    expect(await api.active()).toBe(connId)
    await api.setActive(null)
    expect(await api.remove(connId)).toBe(true)
  })

  it('refuses an incomplete draft with the field the form should highlight', async () => {
    const { store, saved } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble(undefined).credentials, execution, probe: yesProbe })

    await expect(api.save({ name: ' ', dbms: 'doris', host: 'h', port: 9030, username: 'u' })).rejects.toMatchObject({
      code: 'INVALID_DRAFT',
      field: 'name',
    })
    expect(saved).toHaveLength(0)
  })

  it('creates a connection, trims the text fields and stores the password', async () => {
    const { store, saved } = storeDouble()
    const { credentials, set } = credentialsDouble(undefined)
    const api = createPanelApi({
      dataSources: store,
      credentials,
      execution,
      schemaReader,
      probe: yesProbe,
      newId: () => connId,
      isoNow: () => '2026-10-17T00:00:00.000Z',
    })

    const source = await api.save({
      name: '  doris  ',
      dbms: 'doris',
      host: ' doris.shcell.com ',
      port: 9030,
      username: ' wanyexin ',
      database: 'dwd',
      password: 'secret',
      secretStorage: 'session',
    })

    expect(source).toMatchObject({ id: connId, name: 'doris', host: 'doris.shcell.com', username: 'wanyexin', database: 'dwd' })
    expect(saved[0]).toEqual(source)
    expect(set).toHaveBeenCalledWith(connId, 'secret', 'session')
  })

  it('defaults the secret to the persisted store and skips an empty password', async () => {
    const { store } = storeDouble()
    const { credentials, set } = credentialsDouble(undefined)
    const api = createPanelApi({ dataSources: store, credentials, execution, probe: yesProbe, newId: () => connId })

    await api.save({ name: 'd', dbms: 'doris', host: 'h', port: 9030, username: 'u', password: 'p' })
    expect(set).toHaveBeenLastCalledWith(connId, 'p', 'master_key')

    await api.save({ name: 'd', dbms: 'doris', host: 'h', port: 9030, username: 'u', password: '' })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('keeps the cached probe facts when an existing connection is re-saved', async () => {
    const { store, saved } = storeDouble({
      saved: { ...stored, lastTestedAt: '2026-10-17T00:00:00.000Z', lastTestState: 'YES' },
    })
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    const source = await api.save({ id: connId, name: 'renamed', dbms: 'doris', host: 'h', port: 9030, username: 'u' })

    expect(source.name).toBe('renamed')
    expect(source.databaseInfo).toEqual(stored.databaseInfo)
    expect(source.lastTestedAt).toBe('2026-10-17T00:00:00.000Z')
    expect(source.lastTestState).toBe('YES')
    expect(saved[0]).toEqual(source)
  })

  it('keeps a database name in the spec it probes', async () => {
    const withDatabase: DataSource = { ...stored, database: 'dwd' }
    const { store } = storeDouble({ saved: withDatabase })
    const probe = vi.fn(yesProbe)
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe })

    await api.test(connId)

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ database: 'dwd' }))
  })

  it('re-saves a connection that has no cached facts yet', async () => {
    const bare = createDataSource({ id: connId, name: 'doris', dbms: 'doris', host: 'h', username: 'u' })
    const { store, saved } = storeDouble({ saved: bare })
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    const source = await api.save({ id: connId, name: 'fresh', dbms: 'doris', host: 'h', port: 9030, username: 'u' })

    expect(source.name).toBe('fresh')
    expect(source.lastTestedAt).toBeUndefined()
    expect(saved[0]).toEqual(source)
  })

  it('carries every optional field the form can set', async () => {
    const { store, saved } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    const source = await api.save({
      name: 'd',
      dbms: 'mysql',
      host: 'h',
      port: 3306,
      username: 'u',
      driverProperties: { connectTimeout: '5000' },
      writeEnabled: true,
      comment: '只读库',
    })

    // The default id factory is the host's UUID generator.
    expect(source.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(source).toMatchObject({ driverProperties: { connectTimeout: '5000' }, writeEnabled: true, comment: '只读库' })
    expect(saved[0]).toEqual(source)
  })
})

describe('panel api: connection test', () => {
  it('records a success together with the product facts', async () => {
    const { store, tests } = storeDouble({ saved: stored })
    let clock = 0
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      schemaReader,
      probe: yesProbe,
      now: () => (clock += 5),
      isoNow: () => '2026-10-17T00:00:00.000Z',
    })

    const result = await api.test(connId)

    expect(result).toMatchObject({ state: 'YES', durationMs: 5 })
    expect(tests[0]).toMatchObject({ connId, state: 'YES', at: '2026-10-17T00:00:00.000Z', info: stored.databaseInfo })
  })

  it('records a failure without product facts and keeps the hint', async () => {
    const { store, tests } = storeDouble({ saved: stored })
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: noProbe })

    const result = await api.test(connId)

    expect(result).toMatchObject({ state: 'NO', error: { code: 'AUTH_FAILED' } })
    expect(tests[0]).toMatchObject({ state: 'NO' })
    expect(tests[0]?.info).toBeUndefined()
  })

  it('stamps the record with the wall clock when no clock is injected', async () => {
    const { store, tests } = storeDouble({ saved: stored })
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    await api.test(connId)

    expect(tests[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('explains an unknown connection', async () => {
    const { store } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    expect(await api.test('nope')).toMatchObject({ state: 'NO', error: { code: 'CONN_NOT_FOUND' } })
  })

  it('asks for a password before touching the driver', async () => {
    const { store } = storeDouble({ saved: stored })
    const probe = vi.fn(yesProbe)
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble(undefined).credentials, execution, probe })

    expect(await api.test(connId)).toMatchObject({ state: 'UNSURE', error: { code: 'NO_PASSWORD' } })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('panel api: execution', () => {
  it('forwards every statement call to the shared engine', async () => {
    const { store } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    await api.execute({ connId, sql: 'SELECT 1' })
    await api.fetchPage({ connId, sql: 'SELECT 1', offset: 500 })
    await api.cancel('ui-1')

    expect(execution.execute).toHaveBeenCalledWith({ connId, sql: 'SELECT 1' })
    expect(execution.fetchPage).toHaveBeenCalledWith({ connId, sql: 'SELECT 1', offset: 500 })
    expect(execution.cancel).toHaveBeenCalledWith('ui-1')
  })

  it('builds an execution face over the real engine deps', async () => {
    const executor: QueryExecutor = {
      query: vi.fn(async () => ({ fields: [{ name: 'a', typeName: 'LONG' }], rows: [[1]] })),
      cancel: vi.fn(async () => undefined),
    }
    const face = createExecution({
      specs: async () => ({ connections: {} }),
      executor,
      registry: createStatementRegistry(),
    })

    expect(await face.execute({ connId: 'missing', sql: 'SELECT 1' })).toMatchObject({ ok: false, error: { code: 'CONN_NOT_FOUND' } })
    expect(await face.fetchPage({ connId: 'missing', sql: 'SELECT 1', offset: 0 })).toMatchObject({
      ok: false,
      error: { code: 'CONN_NOT_FOUND' },
    })
    expect(await face.cancel('ui-9')).toEqual({ cancelled: true })
  })

  it('is a PanelError so the route layer can map it', () => {
    expect(new PanelError('BAD_BODY', 'x').name).toBe('PanelError')
  })
})

describe('panel api: schema', () => {
  it('reads through to the schema reader', async () => {
    const { store } = storeDouble()
    const reader = { schema: vi.fn(async () => ({ tables: [], fetchedAt: '2026-10-19T00:00:00.000Z', truncated: false, source: 'information_schema' as const })) }
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
      schemaReader: reader,
    })

    await api.schema(connId, { refresh: true })

    expect(reader.schema).toHaveBeenCalledWith(connId, { refresh: true })
  })

  it('explains a host without schema support', async () => {
    const { store } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    await expect(api.schema(connId)).rejects.toMatchObject({ code: 'SCHEMA_UNAVAILABLE' })
  })
})

describe('panel api: script without ports', () => {
  it('refuses instead of half-working when the host gave no script deps', async () => {
    const { store } = storeDouble()
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
    })

    await expect(api.executeScript({ connId, sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'SCRIPT_UNAVAILABLE' })
  })

  it('runs a script through the injected ports', async () => {
    const { store } = storeDouble()
    const scriptDeps = {
      specs: async () => ({ schemaVersion: 1, generatedAt: '', connections: {} }),
      executor: { query: vi.fn(async () => ({ fields: [], rows: [] })), cancel: vi.fn(async () => undefined) },
      registry: { next: () => 'st', forget: () => {}, register: () => {}, get: () => undefined },
    }
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
      scriptDeps: scriptDeps as unknown as Parameters<typeof createPanelApi>[0]['scriptDeps'],
    })

    const outcome = await api.executeScript({ connId, sql: 'SELECT 1' })

    expect('refusal' in outcome).toBe(false)
    if ('refusal' in outcome) return
    expect(outcome.statements[0]).toMatchObject({ ok: false })
    expect(outcome.statements[0]?.ok === false && outcome.statements[0].error.code).toBe('CONN_NOT_FOUND')
  })
})

describe('panel api: layout', () => {
  it('returns null and treats save as a no-op without a key-value store', async () => {
    const { store } = storeDouble()
    const api = createPanelApi({ dataSources: store, credentials: credentialsDouble('p').credentials, execution, probe: yesProbe })

    await expect(api.readLayout!()).resolves.toBeNull()
    await expect(api.saveLayout!({ treeOpen: true })).resolves.toBeUndefined()
  })

  it('loads and saves an object through the key-value store', async () => {
    const { store } = storeDouble()
    const get = vi.fn(async () => ({ treeOpen: false }))
    const put = vi.fn(async () => undefined)
    const kv = { get, put, delete: vi.fn(), entries: vi.fn() }
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
      kv: kv as never,
    })

    await expect(api.readLayout!()).resolves.toEqual({ treeOpen: false })
    await api.saveLayout!({ treeOpen: true })
    expect(put).toHaveBeenCalledWith('layout', { treeOpen: true })
  })

  it('maps a missing stored layout to null', async () => {
    const { store } = storeDouble()
    const kv = { get: vi.fn(async () => undefined), put: vi.fn(), delete: vi.fn(), entries: vi.fn() }
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
      kv: kv as never,
    })
    await expect(api.readLayout!()).resolves.toBeNull()
  })

  it('rejects primitive, null and array layouts', async () => {
    const { store } = storeDouble()
    const kv = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), entries: vi.fn() }
    const api = createPanelApi({
      dataSources: store,
      credentials: credentialsDouble('p').credentials,
      execution,
      probe: yesProbe,
      kv: kv as never,
    })

    for (const value of [null, [], 'wide']) {
      await expect(api.saveLayout!(value)).rejects.toMatchObject({ code: 'BAD_LAYOUT' })
    }
    expect(kv.put).not.toHaveBeenCalled()
  })
})
