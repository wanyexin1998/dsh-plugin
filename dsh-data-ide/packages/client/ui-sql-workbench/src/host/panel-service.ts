/**
 * The panel's host-side API: connections plus statement execution.
 *
 * The browser half cannot reach a node service through the Cordis context (the
 * client bundle runs in another process), so these methods are also exposed over
 * same-origin HTTP by `web-routes.ts`. Keeping the logic here — not in the route
 * handlers — means the routes stay thin and this module is testable without a
 * server.
 */

import { randomUUID } from 'node:crypto'

import {
  type ConnectionDraft,
  type DataSource,
  type DatabaseInfo,
  type TestState,
  createDataSource,
  validateDataSource,
} from '../datasource/model.ts'
import type { ExecuteRequest, ExecutionDeps } from '../execute/core.ts'
import { type ExecutionResult, cancelStatement, runExecuteSql, runFetchPage } from '../execute/envelope.ts'
import { type ScriptRequest, type ScriptResponse, executeScript } from '../execute/script.ts'
import type { ConnectionProbe } from '../../mcp/probe.ts'
import type { ConnectionSpec } from './runtime-specs.ts'
import type { DataSourceStore } from '../datasource/store.ts'
import type { SchemaReader, SchemaSnapshot } from './metadata.ts'
import type { CredentialStore } from './credentials.ts'

/** Three-state probe result as the panel consumes it. */
export interface PanelTestResult {
  readonly state: TestState
  readonly info?: DatabaseInfo
  readonly error?: { readonly code: string; readonly message: string; readonly hint?: string }
  readonly durationMs: number
}

/** Execution wiring, injected so tests need neither mysql2 nor a database. */
export interface Execution {
  execute(request: ExecuteRequest): Promise<ExecutionResult>
  fetchPage(request: ExecuteRequest): Promise<ExecutionResult>
  cancel(statementId: string): Promise<{ readonly cancelled: boolean }>
}

/** Everything the panel can ask the host to do. */
export interface PanelApi {
  list(): Promise<readonly DataSource[]>
  active(): Promise<string | null>
  setActive(connId: string | null): Promise<void>
  save(draft: ConnectionDraft): Promise<DataSource>
  remove(connId: string): Promise<boolean>
  test(connId: string): Promise<PanelTestResult>
  execute(request: ExecuteRequest): Promise<ExecutionResult>
  fetchPage(request: ExecuteRequest): Promise<ExecutionResult>
  cancel(statementId: string): Promise<{ readonly cancelled: boolean }>
  /** Tables and columns for completion; cached by the reader. */
  schema(connId: string, options?: { readonly refresh?: boolean }): Promise<SchemaSnapshot>
  /** Run a whole script; one result per statement (docs/03 §4.3). */
  executeScript(request: ScriptRequest): Promise<ScriptResponse | { readonly refusal: { readonly code: string; readonly message: string } }>
}

/** A refusal the route layer turns into a 4xx with a readable code. */
export class PanelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'PanelError'
  }
}

export interface PanelApiDeps {
  readonly dataSources: DataSourceStore
  readonly credentials: CredentialStore
  readonly execution: Execution
  readonly probe: ConnectionProbe
  /** Optional: without it, completion falls back to keywords only. */
  readonly schemaReader?: SchemaReader
  /** Optional: without it the script route refuses instead of half-working. */
  readonly scriptDeps?: ExecutionDeps
  readonly now?: () => number
  readonly newId?: () => string
  readonly isoNow?: () => string
}

/** Resolve the stored connection plus its password, or explain what is missing. */
async function resolveSpec(
  deps: PanelApiDeps,
  connId: string,
  now: () => number,
): Promise<{ readonly spec: ConnectionSpec; readonly source: DataSource } | { readonly refusal: PanelTestResult }> {
  const source = await deps.dataSources.get(connId)
  if (source === undefined) {
    return { refusal: { state: 'NO', durationMs: 0, error: { code: 'CONN_NOT_FOUND', message: `未知连接 ${connId}` } } }
  }
  const password = await deps.credentials.resolve(connId)
  if (password === undefined) {
    return {
      refusal: {
        state: 'UNSURE',
        durationMs: 0,
        error: { code: 'NO_PASSWORD', message: '该连接还没有密码', hint: '打开「配置」重新填写密码后再测试' },
      },
    }
  }
  return {
    source,
    spec: {
      name: source.name,
      dbms: source.dbms,
      host: source.host,
      port: source.port,
      ...(source.database === undefined ? {} : { database: source.database }),
      username: source.username,
      password,
      driverProperties: source.driverProperties,
      writeEnabled: source.writeEnabled,
    },
  }
}

/** Build the panel API over the host seams. */
export function createPanelApi(deps: PanelApiDeps): PanelApi {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const isoNow = deps.isoNow ?? (() => new Date(now()).toISOString())

  return {
    list: () => deps.dataSources.list(),
    active: () => deps.dataSources.active(),
    setActive: connId => deps.dataSources.setActive(connId),

    async save(draft) {
      const validation = validateDataSource(draft)
      if (!validation.ok) throw new PanelError('INVALID_DRAFT', validation.reason, validation.field)

      const id = draft.id ?? newId()
      const existing = draft.id === undefined ? undefined : await deps.dataSources.get(draft.id)
      const base = createDataSource({
        id,
        name: draft.name.trim(),
        dbms: draft.dbms,
        host: draft.host.trim(),
        port: draft.port,
        username: draft.username.trim(),
        ...(draft.database === undefined ? {} : { database: draft.database }),
        ...(draft.driverProperties === undefined ? {} : { driverProperties: draft.driverProperties }),
        ...(draft.writeEnabled === undefined ? {} : { writeEnabled: draft.writeEnabled }),
        ...(draft.comment === undefined ? {} : { comment: draft.comment }),
      })
      // Keep the cached probe facts: re-saving a connection must not forget what
      // the last test learned (docs/04 §2 databaseInfo).
      const source: DataSource = existing === undefined ? base : { ...base, ...pickProbeFacts(existing) }

      await deps.dataSources.save(source)
      if (draft.password !== undefined && draft.password !== '') {
        await deps.credentials.set(id, draft.password, draft.secretStorage ?? 'master_key')
      }
      return source
    },

    remove: connId => deps.dataSources.remove(connId),

    async test(connId) {
      const started = now()
      const resolved = await resolveSpec(deps, connId, now)
      if ('refusal' in resolved) return { ...resolved.refusal, durationMs: now() - started }

      const outcome = await deps.probe(resolved.spec)
      const durationMs = now() - started
      if (outcome.state === 'YES') {
        await deps.dataSources.recordTestResult(connId, 'YES', isoNow(), outcome.info)
        return { state: 'YES', info: outcome.info, durationMs }
      }
      await deps.dataSources.recordTestResult(connId, outcome.state, isoNow())
      return { state: outcome.state, error: outcome.error, durationMs }
    },

    execute: request => deps.execution.execute(request),
    fetchPage: request => deps.execution.fetchPage(request),
    cancel: statementId => deps.execution.cancel(statementId),
    executeScript: request =>
      deps.scriptDeps === undefined
        ? Promise.reject(new PanelError('SCRIPT_UNAVAILABLE', '宿主未提供脚本执行端口'))
        : executeScript(deps.scriptDeps, request),
    schema: (connId, options) => deps.schemaReader === undefined
      ? Promise.reject(new PanelError('SCHEMA_UNAVAILABLE', '宿主未提供表结构读取'))
      : deps.schemaReader.schema(connId, options),
  }
}

/** The probe-derived fields worth carrying across a save. */
function pickProbeFacts(source: DataSource): Partial<DataSource> {
  return {
    ...(source.databaseInfo === undefined ? {} : { databaseInfo: source.databaseInfo }),
    ...(source.lastTestedAt === undefined ? {} : { lastTestedAt: source.lastTestedAt }),
    ...(source.lastTestState === undefined ? {} : { lastTestState: source.lastTestState }),
  }
}

/** Build the execution half the panel reuses from the shared engine. */
export function createExecution(deps: ExecutionDeps): Execution {
  return {
    execute: request => runExecuteSql(deps, request),
    fetchPage: request => runFetchPage(deps, request),
    cancel: statementId => cancelStatement(deps, statementId),
  }
}
