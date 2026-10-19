/**
 * Data source store: the host-side single writer for connection definitions
 * (docs/02 §3). Every mutation goes through the storage seam, so a malformed
 * record is isolated instead of taking the whole store down (docs/04 §3).
 */

import type { KvStore } from '../host/kv.ts'
import { type DataSource, type TestState } from './model.ts'

const DATA_SOURCES_KEY = 'datasources'
const ACTIVE_KEY = 'active'

/** Persisted envelope; `schemaVersion` drives migrations. */
interface DataSourcesDocument {
  readonly schemaVersion: 1
  readonly dataSources: readonly DataSource[]
  readonly activeConnId: string | null
}

/** Migrations keyed by the version they produce; v1 is the initial shape. */
const MIGRATIONS: Readonly<Record<number, (document: unknown) => DataSourcesDocument | undefined>> = {
  1: raw => {
    const record = raw as Partial<DataSourcesDocument> | undefined
    const list = Array.isArray(record?.dataSources) ? record.dataSources : []
    const active = typeof record?.activeConnId === 'string' ? record.activeConnId : null
    return { schemaVersion: 1, dataSources: list.filter(isDataSource), activeConnId: active }
  },
}

/** Structural check: enough to keep a bad record from poisoning the list. */
function isDataSource(value: unknown): value is DataSource {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['name'] === 'string' &&
    (record['dbms'] === 'doris' || record['dbms'] === 'mysql') &&
    typeof record['host'] === 'string' &&
    typeof record['port'] === 'number' &&
    typeof record['username'] === 'string' &&
    typeof record['writeEnabled'] === 'boolean'
  )
}

export interface DataSourceStore {
  list(): Promise<readonly DataSource[]>
  get(connId: string): Promise<DataSource | undefined>
  save(dataSource: DataSource): Promise<void>
  remove(connId: string): Promise<boolean>
  setActive(connId: string | null): Promise<void>
  active(): Promise<string | null>
  /** Record a connection-test outcome together with its cached product facts. */
  recordTestResult(connId: string, state: TestState, at: string, databaseInfo?: DataSource['databaseInfo']): Promise<void>
}

/** Build the store over any key/value seam. */
export function createDataSourceStore(store: KvStore): DataSourceStore {
  async function read(): Promise<DataSourcesDocument> {
    const raw = await store.get(DATA_SOURCES_KEY)
    if (raw === undefined) return { schemaVersion: 1, dataSources: [], activeConnId: null }
    const migrate = MIGRATIONS[1]
    /* v8 ignore next -- v1 迁移对任何输入都返回文档，分支仅在未来版本表缺项时可达 */
    return migrate?.(raw) ?? { schemaVersion: 1, dataSources: [], activeConnId: null }
  }

  async function write(document: DataSourcesDocument): Promise<void> {
    await store.put(DATA_SOURCES_KEY, document)
    await store.put(ACTIVE_KEY, document.activeConnId)
  }

  return {
    async list() {
      return (await read()).dataSources
    },

    async get(connId) {
      return (await read()).dataSources.find(entry => entry.id === connId)
    },

    async save(dataSource) {
      const document = await read()
      const rest = document.dataSources.filter(entry => entry.id !== dataSource.id)
      await write({ ...document, dataSources: [...rest, dataSource] })
    },

    async remove(connId) {
      const document = await read()
      const remaining = document.dataSources.filter(entry => entry.id !== connId)
      if (remaining.length === document.dataSources.length) return false
      await write({
        ...document,
        dataSources: remaining,
        activeConnId: document.activeConnId === connId ? null : document.activeConnId,
      })
      return true
    },

    async setActive(connId) {
      const document = await read()
      await write({ ...document, activeConnId: connId })
    },

    async active() {
      return (await read()).activeConnId
    },

    async recordTestResult(connId, state, at, databaseInfo) {
      const document = await read()
      const dataSources = document.dataSources.map(entry =>
        entry.id === connId
          ? {
              ...entry,
              lastTestState: state,
              lastTestedAt: at,
              ...(databaseInfo === undefined ? {} : { databaseInfo }),
            }
          : entry,
      )
      await write({ ...document, dataSources })
    },
  }
}
