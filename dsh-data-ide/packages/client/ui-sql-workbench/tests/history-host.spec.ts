import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Scripted mysql2 driver: the host bundle opens sockets only when executing. */
const driver = vi.hoisted(() => ({ createConnection: vi.fn() }))
vi.mock('mysql2/promise', () => ({ createConnection: driver.createConnection }))

import type { QueryHistoryEntry } from '../src/client/state/history.ts'
import { toWorkspaceState } from '../src/client/state/history.ts'
import type { DocumentTab } from '../src/client/state/documents.ts'
import { INITIAL_QUERY } from '../src/client/state/query.ts'
import {
  DOCUMENTS_TABLE,
  FAVORITES_KEY,
  HISTORY_KEY,
  HISTORY_LIMIT,
  WORKSPACE_KEY,
  appendHistoryEntry,
  createPersistenceStore,
  startHostServices,
} from '../src/host/binding.ts'
import type { CredentialsService, Domain, DomainSpec, NodeHostContext } from '../src/host/contract.ts'
import type { PersistenceApi } from '../src/host/web-routes.ts'

const entry = (id: string, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id,
  connId: 'c1',
  sql: `SELECT ${id}`,
  at: 1_000,
  durationMs: 5,
  rowCount: 1,
  ok: true,
  ...overrides,
})

/** In-memory stand-ins for the two host seams `startHostServices` needs. */
function fakeHost() {
  const tables = new Map<string, Map<string, unknown>>()
  const published: { readonly key: string; readonly value: unknown }[] = []

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
    close: async () => undefined,
  }

  const credentials: CredentialsService = {
    readRecord: async () => undefined,
    modifyRecord: async () => undefined,
    deleteRecord: async () => undefined,
    listRecords: async () => [],
  }

  const ctx = {
    effect<T>(setup: () => T): T {
      return setup()
    },
    storageDomain: {
      open: async (spec: DomainSpec) => {
        expect(spec.name).toBe('dsh_data_ide')
        return domain
      },
    },
    credentials,
    dshHomePath: (...segments: string[]) => join(home, ...segments),
    reflect: {
      provide: (key: string, value: unknown) => {
        published.push({ key, value })
        return () => undefined
      },
    },
  } as unknown as NodeHostContext

  return { ctx, tables, published }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-data-ide-history-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('appendHistoryEntry', () => {
  it('creates the document for a fresh store', () => {
    expect(appendHistoryEntry(null, entry('a'))).toEqual({
      schemaVersion: 1,
      byConn: { c1: [entry('a')] },
    })
  })

  it('prepends newer runs and separates connections', () => {
    const first = appendHistoryEntry(null, entry('a'))
    const second = appendHistoryEntry(first, entry('b'))
    const other = appendHistoryEntry(second, entry('x', { connId: 'c2' }))

    expect(other.byConn['c1']?.map(item => item.id)).toEqual(['b', 'a'])
    expect(other.byConn['c2']?.map(item => item.id)).toEqual(['x'])
    expect(other.byConn['c1']).toHaveLength(2)
  })

  it('replaces a repeated id instead of stacking duplicate rows', () => {
    const first = appendHistoryEntry(null, entry('a', { ok: false, errorCode: 'E0' }))
    const rerun = appendHistoryEntry(first, entry('a', { durationMs: 42, rowCount: 7 }))

    expect(rerun.byConn['c1']).toHaveLength(1)
    expect(rerun.byConn['c1']?.[0]).toMatchObject({ id: 'a', durationMs: 42, rowCount: 7 })
  })

  it('trims each connection to the ring limit', () => {
    const full = {
      schemaVersion: 1 as const,
      byConn: {
        c1: Array.from({ length: HISTORY_LIMIT }, (_, index) => entry(`e${String(index)}`)),
        c2: [entry('other', { connId: 'c2' })],
      },
    }

    const next = appendHistoryEntry(full, entry('newest'))

    expect(next.byConn['c1']).toHaveLength(HISTORY_LIMIT)
    expect(next.byConn['c1']?.[0]?.id).toBe('newest')
    expect(next.byConn['c1']?.[HISTORY_LIMIT - 1]?.id).toBe(`e${String(HISTORY_LIMIT - 2)}`)
    expect(next.byConn['c2']?.map(item => item.id)).toEqual(['other'])
  })

  it('tolerates a missing or corrupt stored document', () => {
    expect(appendHistoryEntry('nope', entry('a')).byConn['c1']).toHaveLength(1)
    expect(appendHistoryEntry({}, entry('a')).byConn['c1']).toHaveLength(1)
    expect(appendHistoryEntry({ byConn: [] }, entry('a')).byConn['c1']).toHaveLength(1)

    const mixed = appendHistoryEntry({ byConn: { c1: 'nope', c2: [null, entry('kept')] } }, entry('fresh'))

    expect(mixed.byConn['c1']?.map(item => item.id)).toEqual(['fresh'])
    expect(mixed.byConn['c2']?.map(item => item.id)).toEqual(['kept'])
  })

  it('normalises a sparse entry and drops unknown fields', () => {
    const document = appendHistoryEntry(null, { id: 'sparse', connId: 'c1', sql: 'SELECT 1', extra: 'ignored' })

    expect(document.byConn['c1']?.[0]).toEqual({
      id: 'sparse',
      connId: 'c1',
      sql: 'SELECT 1',
      at: 0,
      durationMs: 0,
      rowCount: null,
      ok: false,
    })
    expect(document.byConn['c1']?.[0]).not.toHaveProperty('extra')
  })

  it('keeps the error code of a failed run', () => {
    const document = appendHistoryEntry(null, entry('bad', { ok: false, errorCode: 'ER_PARSE_ERROR' }))

    expect(document.byConn['c1']?.[0]).toMatchObject({ ok: false, errorCode: 'ER_PARSE_ERROR' })
  })

  it('refuses a body it cannot store, with a readable code', () => {
    expect(() => appendHistoryEntry(null, 'not-an-object')).toThrowError(/历史记录必须是 JSON 对象/)
    expect(() => appendHistoryEntry(null, {})).toThrowError(/缺少 id/)
    expect(() => appendHistoryEntry(null, { id: '' })).toThrowError(/缺少 id/)
    expect(() => appendHistoryEntry(null, { id: 'a' })).toThrowError(/缺少 connId/)
    expect(() => appendHistoryEntry(null, { id: 'a', connId: '' })).toThrowError(/缺少 connId/)
    expect(() => appendHistoryEntry(null, { id: 'a', connId: 'c1', sql: 7 })).toThrowError(/缺少 sql/)

    try {
      appendHistoryEntry(null, {})
    } catch (error) {
      expect(error).toMatchObject({ name: 'PanelError', code: 'BAD_HISTORY' })
    }
  })
})

describe('createPersistenceStore', () => {
  it('stores and returns the workspace and favorites documents', async () => {
    const records = new Map<string, unknown>()
    const kv = {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => {
        records.set(key, value)
      },
      delete: async (key: string) => records.delete(key),
      entries: async () => [...records].map(([key, value]) => ({ key, value })),
    }
    const store = createPersistenceStore(kv)

    expect(await store.loadWorkspaceState()).toBeNull()
    expect(await store.loadFavorites()).toBeNull()
    expect(await store.loadHistory()).toBeNull()

    await store.saveWorkspaceState({ activeDocId: 'a', docs: [{ id: 'a', sql: 'SELECT 1' }] })
    await store.saveFavorites({ schemaVersion: 1, entries: [] })

    expect(await store.loadWorkspaceState()).toEqual({ activeDocId: 'a', docs: [{ id: 'a', sql: 'SELECT 1' }] })
    expect(await store.loadFavorites()).toEqual({ schemaVersion: 1, entries: [] })
  })

  it('refuses non-object documents', async () => {
    const store = createPersistenceStore({
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => true,
      entries: async () => [],
    })

    await expect(store.saveWorkspaceState(null)).rejects.toThrowError(/workspace 必须是 JSON 对象/)
    await expect(store.saveWorkspaceState([])).rejects.toThrowError(/workspace 必须是 JSON 对象/)
    await expect(store.saveFavorites('nope')).rejects.toThrowError(/favorites 必须是 JSON 对象/)
  })

  it('appends history through the host-owned ring buffer', async () => {
    const records = new Map<string, unknown>()
    const kv = {
      get: async (key: string) => records.get(key),
      put: async (key: string, value: unknown) => {
        records.set(key, value)
      },
      delete: async (key: string) => records.delete(key),
      entries: async () => [...records].map(([key, value]) => ({ key, value })),
    }
    const store = createPersistenceStore(kv)

    await store.appendHistory(entry('a'))
    await store.appendHistory(entry('b'))

    const stored = records.get(HISTORY_KEY) as { byConn: Record<string, { id: string }[]> }
    expect(stored.byConn['c1']?.map(item => item.id)).toEqual(['b', 'a'])
    expect(await store.loadHistory()).toEqual(stored)
  })
})

describe('host services expose persistence to the route layer', () => {
  it('attaches the document ports to the panel API it returns', async () => {
    const host = fakeHost()
    const { api, dispose } = await startHostServices(host.ctx)
    const persistence = api as unknown as PersistenceApi

    expect(typeof persistence.loadWorkspaceState).toBe('function')
    await persistence.saveWorkspaceState?.({
      schemaVersion: 1,
      activeDocId: 'a',
      docs: [{ id: 'a', title: 'console_1', connId: 'c1', sql: 'SELECT 1', pageSize: 500, cursor: 2 }],
    })
    await expect(persistence.loadWorkspaceState?.()).resolves.toEqual({
      schemaVersion: 1,
      activeDocId: 'a',
      docs: [{ id: 'a', title: 'console_1', connId: 'c1', sql: 'SELECT 1', pageSize: 500, cursor: 2 }],
    })

    await persistence.appendHistory?.(entry('a'))
    const stored = await persistence.loadHistory?.()
    expect(stored).toMatchObject({ schemaVersion: 1, byConn: { c1: [{ id: 'a' }] } })
    expect(persistence.loadHistory).toBeDefined()
    await expect(persistence.loadFavorites?.()).resolves.toBeNull()
    await persistence.saveFavorites?.({ schemaVersion: 1, entries: [] })
    await expect(persistence.loadFavorites?.()).resolves.toEqual({ schemaVersion: 1, entries: [] })

    await dispose()
  })

  it('never stores result rows with the console documents', async () => {
    const host = fakeHost()
    const { api, dispose } = await startHostServices(host.ctx)
    const persistence = api as unknown as PersistenceApi
    const tab: DocumentTab = {
      id: 'a',
      title: 'console_1',
      connId: 'c1',
      query: {
        ...INITIAL_QUERY,
        sql: 'SELECT 1',
        result: { columns: [{ name: 'a', typeName: 'INT' }], rows: [[1], [2]], total: 2, hasNextPage: false, offset: 0, durationMs: 1, statementId: 's' },
      },
      script: null,
      lastRunSql: '',
    }

    await persistence.saveWorkspaceState?.(toWorkspaceState([tab], 'a'))

    const table = host.tables.get(DOCUMENTS_TABLE)
    const serialized = JSON.stringify(table?.get(WORKSPACE_KEY))
    expect(serialized).toContain('SELECT 1')
    expect(serialized).not.toContain('"rows"')
    expect(serialized).not.toContain('"result"')
    await dispose()
  })

  it('surfaces a broken history body as a PanelError instead of storing it', async () => {
    const host = fakeHost()
    const { api, dispose } = await startHostServices(host.ctx)
    const persistence = api as unknown as PersistenceApi

    await expect(persistence.appendHistory?.({ id: 'a' })).rejects.toMatchObject({ code: 'BAD_HISTORY' })

    const table = host.tables.get(DOCUMENTS_TABLE)
    expect(table?.has(HISTORY_KEY)).toBe(false)
    await dispose()
  })
})
