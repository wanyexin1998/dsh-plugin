/**
 * Host binding: turns the dsh node-half seams into the ports the plugin logic
 * depends on, and owns the runtime spec file that carries resolved connections
 * to the MCP server.
 *
 * Storage is domain-based in 0.1.7 (docs/04 §3): this module declares the
 * `dsh-data-ide` domain and maps its generic `documents` table onto `KvStore`,
 * so `src/datasource/store.ts` never learns about domains or zod.
 */

import { z } from 'zod'

import { type DataSourceStore, createDataSourceStore } from '../datasource/store.ts'
import { type ExecuteRequest, createStatementRegistry } from '../execute/core.ts'
import { type ExecutionResult, cancelStatement, runExecuteSql, runFetchPage } from '../execute/envelope.ts'
import { createMysqlExecutor } from '../execute/mysql.ts'
import { probeMysql } from '../../mcp/probe-mysql.ts'
import type { ConnectionProbe } from '../../mcp/probe.ts'
import { type PanelApi, LAYOUT_KEY, PanelError, createExecution, createPanelApi } from './panel-service.ts'
import { createSchemaReader } from './metadata.ts'
import { type KvStore } from './kv.ts'
import { type CredentialStore, createCredentialStore } from './credentials.ts'
import type { PersistenceApi } from './web-routes.ts'
import type { QueryHistoryEntry } from '../client/state/history.ts'
import type { CredentialsService, Domain, DomainSpec, NodeHostContext } from './contract.ts'
import { buildRuntimeSpecs, removeRuntimeSpecs, runtimeSpecPath, writeRuntimeSpecs } from './runtime-specs.ts'
import { resolveSpec } from '../../mcp/runtime-specs.ts'
import type { ConnectionSpec, RuntimeSpecDocument } from './runtime-specs.ts'

/**
 * Domain name; doubles as the JSON unit name under the storage backend root.
 *
 * storage-json accepts `/^[a-z][a-z0-9_]*$/` only (`UNIT_NAME_RE`,
 * packages/storage/storage/lib/index.js), so the dashed package name is not a
 * legal unit name — the first real boot failed with `invalid unit name`.
 * The credential record prefix stays `dsh-data-ide/<connId>`; only the storage
 * unit uses underscores.
 */
export const DOMAIN_NAME = 'dsh_data_ide'

/** Table holding the three documents (`datasources`, `active`, later history/layout). */
export const DOCUMENTS_TABLE = 'documents'

/**
 * Document keys the panel persists through the same table (SQL-201/202/203/205).
 *
 * Keys are session-independent on purpose: the right sidebar instantiates one
 * panel per session, but the user's consoles and history are one person's
 * working memory, not a conversation's.
 */
export const WORKSPACE_KEY = 'workspace'
/** Per-connection query history (04 §3 reserved this key). */
export const HISTORY_KEY = 'history'
/** Named pinned queries (SQL-205). */
export const FAVORITES_KEY = 'favorites'

/**
 * Per-connection ring-buffer ceiling (04 §5).
 *
 * Mirrors `MAX_HISTORY` in `client/state/history.ts`; the host trims again on
 * append so a hand-edited document cannot grow without bound. Kept as a literal
 * (rather than an import) so the node bundle never pulls client React code in.
 */
export const HISTORY_LIMIT = 200

/**
 * Domain declaration.
 *
 * One permissive table keeps the port honest: validation of connection shapes
 * already lives in `src/datasource/store.ts`, so a second schema here would be
 * a third place to keep in sync.
 */
export const DOMAIN_SPEC: DomainSpec = {
  name: DOMAIN_NAME,
  version: 1,
  layout: 'single',
  tables: { [DOCUMENTS_TABLE]: { keySchema: z.string(), valueSchema: z.unknown() } },
}

/** Map the domain's document table onto the key/value port. */
export function createKvStore(domain: Domain): KvStore {
  const table = domain.table(DOCUMENTS_TABLE)
  return {
    get: async key => table.get(key),
    put: async (key, value) => {
      await table.put(key, value)
    },
    delete: async key => table.delete(key),
    entries: async () => [...table.entries()].map(([key, value]) => ({ key, value })),
  }
}

/** Persisted history document; mirrors `HistoryDocument` in `client/state/history.ts`. */
export interface StoredHistoryDocument {
  readonly schemaVersion: 1
  readonly byConn: Readonly<Record<string, readonly QueryHistoryEntry[]>>
}

/** True for a plain JSON object; arrays and `null` are never documents. */
function isDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow one reported run; a broken body is a readable 400, not stored junk. */
function normalizeHistoryEntry(value: unknown): QueryHistoryEntry {
  if (!isDocument(value)) throw new PanelError('BAD_HISTORY', '历史记录必须是 JSON 对象')
  const id = value['id']
  const connId = value['connId']
  const sql = value['sql']
  if (typeof id !== 'string' || id === '') throw new PanelError('BAD_HISTORY', '历史记录缺少 id')
  if (typeof connId !== 'string' || connId === '') throw new PanelError('BAD_HISTORY', '历史记录缺少 connId')
  if (typeof sql !== 'string') throw new PanelError('BAD_HISTORY', '历史记录缺少 sql')
  const errorCode = value['errorCode']
  return {
    id,
    connId,
    sql,
    at: typeof value['at'] === 'number' ? value['at'] : 0,
    durationMs: typeof value['durationMs'] === 'number' ? value['durationMs'] : 0,
    rowCount: typeof value['rowCount'] === 'number' ? value['rowCount'] : null,
    ok: value['ok'] === true,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
  }
}

/** Read the stored history document, tolerating a missing or corrupt one. */
function readHistoryDocument(stored: unknown): Record<string, readonly QueryHistoryEntry[]> {
  if (!isDocument(stored)) return {}
  const byConn = stored['byConn']
  if (!isDocument(byConn)) return {}
  const grouped: Record<string, readonly QueryHistoryEntry[]> = {}
  for (const [connId, entries] of Object.entries(byConn)) {
    if (Array.isArray(entries)) {
      grouped[connId] = entries.filter(entry => isDocument(entry)) as unknown as readonly QueryHistoryEntry[]
    }
  }
  return grouped
}

/**
 * Add one run to the persisted history document.
 *
 * Pure so the ring buffer and the corrupt-document tolerance are unit-testable
 * without a storage backend. A repeated id replaces the old row (re-running a
 * statement updates it), and the per-connection list is trimmed to
 * {@link HISTORY_LIMIT}; other connections are untouched.
 */
export function appendHistoryEntry(stored: unknown, entry: unknown): StoredHistoryDocument {
  const byConn = readHistoryDocument(stored)
  const normalized = normalizeHistoryEntry(entry)
  const previous = byConn[normalized.connId] ?? []
  const next = [normalized, ...previous.filter(item => item.id !== normalized.id)].slice(0, HISTORY_LIMIT)
  return { schemaVersion: 1, byConn: { ...byConn, [normalized.connId]: next } }
}

/** Store one JSON document, refusing non-objects with a readable code. */
async function writeDocument(kv: KvStore, key: string, value: unknown, label: string): Promise<void> {
  if (!isDocument(value)) throw new PanelError('BAD_DOCUMENT', `${label} 必须是 JSON 对象`)
  await kv.put(key, value)
}

/**
 * Build the persistence half attached to the panel API (SQL-201/202/203/205).
 *
 * The host is the single writer (docs/02 §3): the browser posts documents and
 * the host validates + stores them; nothing is read back from the browser during
 * a save, so two sessions cannot interleave a document write.
 */
export function createPersistenceStore(kv: KvStore): Required<PersistenceApi> {
  return {
    loadWorkspaceState: async () => (await kv.get(WORKSPACE_KEY)) ?? null,
    saveWorkspaceState: state => writeDocument(kv, WORKSPACE_KEY, state, 'workspace'),
    loadHistory: async () => (await kv.get(HISTORY_KEY)) ?? null,
    appendHistory: async entry => {
      await kv.put(HISTORY_KEY, appendHistoryEntry(await kv.get(HISTORY_KEY), entry))
    },
    loadFavorites: async () => (await kv.get(FAVORITES_KEY)) ?? null,
    saveFavorites: document => writeDocument(kv, FAVORITES_KEY, document, 'favorites'),
  }
}

/** Adapt the host credential service to the narrow port the store needs. */
export function createCredentialsPort(credentials: CredentialsService) {
  return {
    readRecord: async (key: string) => credentials.readRecord(key),
    modifyRecord: async (key: string, mutate: (current: unknown) => Promise<unknown>) =>
      credentials.modifyRecord(key, mutate),
    deleteRecord: async (key: string) => credentials.deleteRecord(key),
    listRecords: async () => credentials.listRecords(),
  }
}

/** Wrap a store so every mutation republishes the runtime specs. */
export function createPublishingStore(inner: DataSourceStore, publish: () => Promise<void>): DataSourceStore {
  const after = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = await run()
    await publish()
    return result
  }
  return {
    list: () => inner.list(),
    get: connId => inner.get(connId),
    save: dataSource => after(() => inner.save(dataSource)),
    remove: connId => after(() => inner.remove(connId)),
    setActive: connId => after(() => inner.setActive(connId)),
    active: () => inner.active(),
    recordTestResult: (connId, state, at, databaseInfo) =>
      after(() => inner.recordTestResult(connId, state, at, databaseInfo)),
  }
}

/**
 * Resolve a connection exactly the way `execute` does.
 *
 * The panel's statements go through `createExecution(execution)`, which builds the
 * runtime document (only connections whose password resolved) and picks the spec
 * out of it. Introspection must not invent a second path: when it did, an account
 * whose password lived only in the session map ran SQL fine while the schema
 * route answered "no password" (reported 2026-10-19). One resolver, two callers.
 */
export function createConnectionResolver(deps: {
  readonly specs: () => Promise<RuntimeSpecDocument>
  readonly dataSources: DataSourceStore
  readonly credentials: CredentialStore
}): (connId: string) => Promise<ConnectionSpec | undefined> {
  return async connId => {
    const resolved = resolveSpec(await deps.specs(), connId)
    if (resolved.ok) return resolved.spec

    // Not in the document yet (saved but never published): rebuild the same spec
    // from the store plus the secret store — the very inputs the document uses.
    const source = await deps.dataSources.get(connId)
    if (source === undefined) {
      // Visible in the host log: a schema failure must never be a silent blank.
      console.error('[dsh-data-ide] schema resolve: connection not in the store', connId)
      return undefined
    }
    const password = await deps.credentials.resolve(connId)
    if (password === undefined) {
      console.error(
        '[dsh-data-ide] schema resolve: no secret for',
        connId,
        'stored=',
        await deps.credentials.storedIds(),
        'session=',
        deps.credentials.sessionCount(),
      )
      return undefined
    }
    return {
      name: source.name,
      dbms: source.dbms,
      host: source.host,
      port: source.port,
      ...(source.database === undefined ? {} : { database: source.database }),
      username: source.username,
      password,
      driverProperties: source.driverProperties,
      writeEnabled: source.writeEnabled,
    }
  }
}

/** Host-side API published to the client half and used by the node half. */
export interface SqlWorkbenchService {
  readonly dataSources: DataSourceStore
  readonly credentials: CredentialStore
  /** Rewrite the runtime spec file from current connections and secrets. */
  publish(): Promise<void>
  /** Absolute path of the runtime spec file. */
  readonly specPath: string
  /**
   * Execute for the panel.
   *
   * Same engine the MCP tools use (`src/execute/`), so the grid and the agent
   * cannot disagree about paging, refusal codes or truncation. The host resolves
   * secrets in-process; nothing about the panel path touches the spec file.
   */
  execute(request: ExecuteRequest): Promise<ExecutionResult>
  /** Another page, without re-counting. */
  fetchPage(request: ExecuteRequest): Promise<ExecutionResult>
  /** Abort a statement by the id the panel minted. */
  cancel(statementId: string): Promise<{ readonly cancelled: boolean }>
  /** Last saved layout document (docs/09 B3), unvalidated. */
  readLayout(): Promise<unknown>
  saveLayout(layout: unknown): Promise<void>
}

/** Resolve the harness home the same way the bundle patch does. */
export function resolveHome(ctx: NodeHostContext): string {
  if (typeof ctx.dshHomePath === 'function') return ctx.dshHomePath()
  return process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh`
}

/**
 * Open the domain, build the stores, publish the first spec file, register the
 * service, and hand back the panel API the web routes drive.
 *
 * The panel API is built here rather than in `index.ts` so the whole
 * composition — storage, credentials, engine, probe — is one testable function.
 */
export async function startHostServices(
  ctx: NodeHostContext,
  options: { readonly probe?: ConnectionProbe } = {},
): Promise<{ readonly service: SqlWorkbenchService; readonly api: PanelApi; readonly dispose: () => Promise<void> }> {
  const domain = await ctx.storageDomain.open(DOMAIN_SPEC)
  const credentials = createCredentialStore(createCredentialsPort(ctx.credentials))
  /** One handle per table: connections and layout share the documents table. */
  const kv = createKvStore(domain)
  const inner = createDataSourceStore(kv)
  const specPath = runtimeSpecPath(resolveHome(ctx))

  const publish = async (): Promise<void> => {
    const outcome = await buildRuntimeSpecs(await inner.list(), connId => credentials.resolve(connId))
    await writeRuntimeSpecs(specPath, outcome.document)
  }

  // The panel's execution path: same engine, same ports, but the specs are
  // resolved in memory rather than read back from the published file.
  const execution = {
    specs: async () => (await buildRuntimeSpecs(await inner.list(), connId => credentials.resolve(connId))).document,
    executor: createMysqlExecutor(),
    registry: createStatementRegistry(),
  }

  const dataSources = createPublishingStore(inner, publish)
  const service: SqlWorkbenchService = {
    dataSources,
    credentials,
    publish,
    specPath,
    execute: request => runExecuteSql(execution, request),
    fetchPage: request => runFetchPage(execution, request),
    cancel: statementId => cancelStatement(execution, statementId),
    readLayout: async () => (await kv.get(LAYOUT_KEY)) ?? null,
    saveLayout: async layout => {
      await kv.put(LAYOUT_KEY, layout)
    },
  }

  // Persistence (SQL-201/202/203/205) rides the same panel API object the route
  // layer already receives: the methods are optional on `PanelApi`, so attaching
  // them here keeps `index.ts` and every existing API double unchanged.
  const api: PanelApi = Object.assign(
    createPanelApi({
      dataSources,
      credentials,
      kv,
      execution: createExecution(execution),
      probe: options.probe ?? probeMysql,
      scriptDeps: execution,
      schemaReader: createSchemaReader({
        resolve: createConnectionResolver({ specs: execution.specs, dataSources, credentials }),
        executor: execution.executor,
      }),
    }),
    createPersistenceStore(kv),
  )

  await publish()
  ctx.reflect.provide('sqlWorkbench', service)

  return {
    service,
    api,
    dispose: async () => {
      await removeRuntimeSpecs(specPath)
      await domain.close()
    },
  }
}
