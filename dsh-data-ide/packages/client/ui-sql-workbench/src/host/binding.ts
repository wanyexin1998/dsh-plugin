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
import { type PanelApi, LAYOUT_KEY, createExecution, createPanelApi } from './panel-service.ts'
import { createSchemaReader } from './metadata.ts'
import { type KvStore } from './kv.ts'
import { type CredentialStore, createCredentialStore } from './credentials.ts'
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

  const api = createPanelApi({
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
  })

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
