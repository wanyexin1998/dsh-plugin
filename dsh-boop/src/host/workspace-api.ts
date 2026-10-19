/**
 * BOOP workspace plane host row (E02-04).
 *
 * This row is an unambiguous Cordis function plugin (`name` / `inject` /
 * `apply`) mounted from `cordis.patch.yml` as `boop-workspace`. It wires the
 * host-free core in `workspace.ts` to the live rc.2.1 surfaces:
 *
 *  - READ  → `ctx.workspaceRegistry` (records, archive/pin sets, canonical path
 *            lookup), `ctx.sessionController.list()` (cold-safe Session rows +
 *            title/running hints; never resumes an Agent), `sessionQuery`
 *            fallback, and the `workspace/session-activity` waterfall for the
 *            "what still runs" preview (read-only: providers are only asked);
 *  - WRITE → `ctx.workspaceController` commands (create/rename/delete/
 *            archiveSession/unarchiveSession) and `ctx.directoryPicker`'s
 *            `browse` createDirectory primitive. The picker's `native` backend
 *            only opens an OS dialog, so BOOP reports directory creation as
 *            unavailable instead of automating UI clicks (03§04, issue
 *            "不可用API不得以UI点击自动化替代");
 *  - AUDIT → BOOP's own ledger (`$DSH_HOME/boop/boop.sqlite`), with an
 *            in-memory fallback that the capabilities report labels honestly.
 *
 * The row registers the `boopWorkspace` Typert Remote service (UI/IM transport
 * plane) and provides `boopWorkspaceRules` for in-process callers; both write
 * through the SAME `WorkspaceManagement` core, so the model-facing tool, an
 * eventual IM adapter and the Remote plane cannot drift apart. It also
 * registers the frozen `boop_workspace_change` tool (preview / gated commit).
 *
 * Write mode is never enabled here: every write goes through
 * `boop.isWriteModeEnabled()`, which stays false until G02/G05 have evidence.
 */

import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { remote } from './remote.ts'
import {
  MemoryAuditSink,
  WorkspaceManagement,
  type ActiveWork,
  type HostAvailability,
  type PathInspection,
  type SessionCatalog,
  type SessionRecord,
  type WorkspaceAuditEntry,
  type WorkspaceAuditRecord,
  type WorkspaceAuditSink,
  type WorkspaceHostPort,
  type WorkspaceMutationPort,
  type WorkspaceRecord,
  type WorkspaceResult,
  type WorkspaceWriteGate,
} from './workspace.ts'

export const name = 'boop-workspace'

/** `boop` carries the write-mode gate and the ledger; the gateway routes Remote methods. */
export const inject = ['boop', 'typertGateway']

export interface BoopWorkspaceConfig {
  /** Audit rows requested by the tool/UI trail read; the Host default is 50. */
  auditLimit?: number
  /** Set false only in isolated diagnostics; the shipped default registers the tool. */
  tool?: boolean
}

const DEFAULT_CONFIG: Required<Pick<BoopWorkspaceConfig, 'auditLimit' | 'tool'>> = { auditLimit: 50, tool: true }

/* ── live-service helpers ─────────────────────────────────────────────── */

function serviceOf(ctx: any, name: string): any {
  try {
    return ctx.reflect?.get?.(name, false) || undefined
  } catch {
    return undefined
  }
}

function errorWithCode(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

const LEDGER_SCOPE_FALLBACK = 'local-scope'

interface LedgerHandle {
  repo: any
  scopeId: string
}

function ledgerOf(ctx: any): LedgerHandle | null {
  try {
    const storage = ctx.boop?.storage?.()
    const repo = storage?.repo
    const scopeId = storage?.identity?.scopeId
    if (repo && typeof repo.audit === 'function' && typeof repo.auditTrail === 'function' && typeof scopeId === 'string' && scopeId.length > 0) {
      return { repo, scopeId }
    }
  } catch {
    /* ledger absence is reported, never thrown from the audit path */
  }
  return null
}

/* ── live workspace/Session read port ─────────────────────────────────── */

class CordisWorkspaceHost implements WorkspaceHostPort {
  private readonly ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  availability(): HostAvailability {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    const picker = serviceOf(this.ctx, 'directoryPicker')
    return {
      services: {
        workspaceRegistry: registry !== undefined,
        sessionController: serviceOf(this.ctx, 'sessionController') !== undefined,
        sessionQuery: serviceOf(this.ctx, 'sessionQuery') !== undefined,
        sessions: serviceOf(this.ctx, 'sessions') !== undefined,
        directoryPicker: picker !== undefined,
        activity: typeof this.ctx.waterfall === 'function',
        agentLoop: serviceOf(this.ctx, 'agentLoop') !== undefined,
        schedule: serviceOf(this.ctx, 'schedule') !== undefined,
        jobs: serviceOf(this.ctx, 'jobs') !== undefined,
      },
      directoryCreate: directoryCreateProbe(picker),
      auditLedger: ledgerOf(this.ctx) !== null,
    }
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const registry = this.requireService('workspaceRegistry')
    const entities: any[] = registry.list()
    const records: WorkspaceRecord[] = []
    for (const entity of entities) {
      let directoryStatus: WorkspaceRecord['directoryStatus'] = 'unknown'
      try {
        const status = await entity.status?.()
        if (status === 'ok' || status === 'missing-dir') directoryStatus = status
      } catch {
        directoryStatus = 'unknown'
      }
      records.push({
        workspaceId: String(entity.id),
        title: String(entity.title ?? ''),
        path: String(entity.path ?? ''),
        directoryStatus,
        sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map((id: unknown) => String(id)) : [],
        updatedAt: entity.updatedAt === undefined || entity.updatedAt === null ? null : String(entity.updatedAt),
      })
    }
    return records
  }

  async listSessions(): Promise<SessionCatalog> {
    const controller = serviceOf(this.ctx, 'sessionController')
    const query = serviceOf(this.ctx, 'sessionQuery')
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (controller === undefined && query === undefined) {
      throw errorWithCode('neither sessionController nor sessionQuery is composed', 'CAPABILITY_UNAVAILABLE')
    }

    // Workspace membership is derived from the registry's accounted Session
    // ids; a Session that belongs to no Workspace is valid (grouping is not
    // ownership).
    const workspaceBySession = new Map<string, string>()
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const entity of registry.list() as any[]) {
          const sessionIds: unknown[] = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
          for (const sessionId of sessionIds) workspaceBySession.set(String(sessionId), String(entity.id))
        }
      } catch {
        /* membership is a display fact; absence must not hide Session rows */
      }
    }

    const archived = new Set<string>(this.archivedSessionIdsRaw())
    const byId = new Map<string, SessionRecord>()

    if (query !== undefined && typeof query.listSessions === 'function') {
      const rows: any[] = (await query.listSessions()) ?? []
      for (const row of rows) {
        const header = (row?.header ?? {}) as Record<string, unknown>
        const sessionId = String(header.id ?? row?.id ?? row?.sessionId ?? '')
        if (sessionId.length === 0) continue
        byId.set(sessionId, {
          sessionId,
          workspaceId: workspaceBySession.get(sessionId) ?? null,
          title: null,
          titleKnown: false,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          live: row?.live === true,
          persisted: row?.persisted === true,
          running: false,
          blank: false,
          archived: archived.has(sessionId),
          updatedAt: typeof header.createdAt === 'number' ? header.createdAt : null,
        })
      }
    }

    let controllerRead = false
    if (controller !== undefined && typeof controller.list === 'function') {
      const result = await controller.list()
      const items: any[] = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
      controllerRead = true
      for (const item of items) {
        const sessionId = String(item?.sessionId ?? '')
        if (sessionId.length === 0) continue
        const existing = byId.get(sessionId)
        const projectionTitle = item?.projections?.values?.title
        const title = typeof projectionTitle === 'string' && projectionTitle.length > 0 ? projectionTitle : null
        const record: SessionRecord = existing ?? {
          sessionId,
          workspaceId: workspaceBySession.get(sessionId) ?? null,
          title: null,
          titleKnown: false,
          cwd: null,
          live: true,
          persisted: false,
          running: false,
          blank: false,
          archived: archived.has(sessionId),
          updatedAt: null,
        }
        record.title = title
        record.titleKnown = title !== null
        record.running = item?.running === true
        record.blank = item?.blank === true
        if (typeof item?.cwd === 'string') record.cwd = item.cwd
        if (typeof item?.updatedAt === 'number') record.updatedAt = item.updatedAt
        byId.set(sessionId, record)
      }
    }

    const sessions = [...byId.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    const titlesKnown = sessions.filter((session) => session.titleKnown).length
    return {
      sessions,
      coverage: {
        total: sessions.length,
        titlesKnown,
        titlesUnknown: sessions.length - titlesKnown,
        complete: titlesKnown === sessions.length,
        source: controllerRead ? 'sessionController+sessionQuery' : 'sessionQuery',
      },
    }
  }

  archivedSessionIds(): string[] {
    return this.archivedSessionIdsRaw()
  }

  private archivedSessionIdsRaw(): string[] {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (registry === undefined) return []
    try {
      const ids = registry.archivedSessionIds
      return Array.isArray(ids) ? ids.map((id: unknown) => String(id)) : []
    } catch {
      return []
    }
  }

  async sessionActivity(sessionId: string): Promise<ActiveWork[]> {
    if (typeof this.ctx.waterfall !== 'function') {
      throw errorWithCode('the host exposes no Cordis waterfall (workspace/session-activity query)', 'CAPABILITY_UNAVAILABLE')
    }
    // Read-only: the archive-admission providers are asked what runs; nothing
    // is stopped and nothing is written here.
    const raw = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    if (!Array.isArray(raw)) return []
    return raw.map((entry: any) => ({
      kind: String(entry?.kind ?? 'unknown'),
      items: Array.isArray(entry?.items)
        ? entry.items.map((item: any) => ({
            id: String(item?.id ?? ''),
            label: typeof item?.label === 'string' ? item.label : null,
          }))
        : [],
    }))
  }

  async resolveWorkspaceByPath(path: string): Promise<WorkspaceRecord | null> {
    const registry = this.requireService('workspaceRegistry')
    if (typeof registry.resolveByPath !== 'function') return null
    const entity = await registry.resolveByPath(path)
    if (entity === undefined || entity === null) return null
    return {
      workspaceId: String(entity.id),
      title: String(entity.title ?? ''),
      path: String(entity.path ?? ''),
      directoryStatus: 'ok',
      sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map((id: unknown) => String(id)) : [],
      updatedAt: entity.updatedAt === undefined || entity.updatedAt === null ? null : String(entity.updatedAt),
    }
  }

  async inspectPath(path: string): Promise<PathInspection> {
    const fullyQualified = typeof path === 'string' && path.length > 0 && isAbsolute(path)
    let exists = false
    let isDirectory = false
    let parentExists = false
    let parentIsDirectory = false
    if (fullyQualified) {
      try {
        const info = await stat(path)
        exists = true
        isDirectory = info.isDirectory()
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
      try {
        const parent = dirname(path)
        const info = await stat(parent)
        parentExists = true
        parentIsDirectory = info.isDirectory()
      } catch (error) {
        if (!isMissingPath(error)) throw error
      }
    }
    return { fullyQualified, exists, isDirectory, parentExists, parentIsDirectory }
  }

  private requireService(key: string): any {
    const value = serviceOf(this.ctx, key)
    if (value === undefined) throw errorWithCode(`the Host has no ${key} service on this composition`, 'CAPABILITY_UNAVAILABLE')
    return value
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function directoryCreateProbe(picker: any): HostAvailability['directoryCreate'] {
  if (picker === undefined) {
    return { available: false, backend: null, reason: 'the directoryPicker service is not composed on this Host' }
  }
  let capability: any = null
  let backend: string | null = null
  try {
    capability = typeof picker.capability === 'function' ? picker.capability() : null
    backend = typeof capability?.kind === 'string' ? capability.kind : null
  } catch {
    capability = null
    backend = null
  }
  if (backend === 'browse' && typeof capability?.createDirectory === 'function') {
    return { available: true, backend, reason: null }
  }
  if (backend === 'native') {
    return {
      available: false,
      backend,
      reason: 'the native directory-picker backend only opens an OS dialog; BOOP never automates UI clicks for directory creation',
    }
  }
  if (backend === 'browse') {
    return { available: false, backend, reason: 'the browse directory-picker backend exposes no createDirectory primitive' }
  }
  return {
    available: false,
    backend,
    reason: `the directory-picker backend (${backend ?? 'unknown'}) exposes no createDirectory primitive`,
  }
}

/* ── live mutation port ───────────────────────────────────────────────── */

class CordisWorkspaceMutations implements WorkspaceMutationPort {
  private readonly ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  private requireController(): any {
    const controller = serviceOf(this.ctx, 'workspaceController')
    if (controller === undefined) throw errorWithCode('the Host has no workspaceController service on this composition', 'CAPABILITY_UNAVAILABLE')
    return controller
  }

  async registerWorkspace(path: string): Promise<{ workspaceId: string; created: boolean }> {
    const result = await this.requireController().create({ path })
    const workspace = result?.workspace ?? result
    const workspaceId = String(workspace?.workspaceId ?? workspace?.id ?? '')
    if (workspaceId.length === 0) throw errorWithCode('workspace/create returned no workspace identity', 'OUTCOME_UNKNOWN')
    return { workspaceId, created: result?.created === true }
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    await this.requireController().rename({ workspaceId, title })
  }

  async removeRegistration(workspaceId: string): Promise<boolean> {
    const result = await this.requireController().delete({ workspaceId })
    return result?.deleted === true
  }

  async archiveSession(sessionId: string, options: { stopActivity: boolean }): Promise<void> {
    const request: Record<string, unknown> = { sessionId }
    if (options.stopActivity) request.stopActivity = true
    await this.requireController().archiveSession(request)
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    await this.requireController().unarchiveSession({ sessionId })
  }

  async createDirectory(targetPath: string): Promise<string> {
    const picker = serviceOf(this.ctx, 'directoryPicker')
    if (picker === undefined) throw errorWithCode('the Host has no directoryPicker service', 'CAPABILITY_UNAVAILABLE')
    const capability = typeof picker.capability === 'function' ? picker.capability() : null
    if (capability?.kind !== 'browse' || typeof capability?.createDirectory !== 'function') {
      throw errorWithCode('the composed directory picker exposes no createDirectory primitive', 'directory-create-failed')
    }
    const parent = dirname(targetPath)
    const name = basename(targetPath)
    if (name.length === 0 || name === '.' || name === '..' || /[/\\]/u.test(name)) {
      throw errorWithCode(`cannot create "${targetPath}": the target must name one single path segment`, 'directory-create-failed')
    }
    return String(await capability.createDirectory(parent, name))
  }
}

/* ── audit sink: BOOP's own ledger, memory fallback ───────────────────── */

class LedgerWorkspaceAuditSink implements WorkspaceAuditSink {
  /** Reported to the UI so a memory-only trail is never mistaken for durable audit. */
  readonly durable: boolean
  private readonly ctx: any
  private readonly fallback: MemoryAuditSink

  constructor(ctx: any, fallback: MemoryAuditSink) {
    this.ctx = ctx
    this.fallback = fallback
    this.durable = ledgerOf(ctx) !== null
  }

  record(entry: WorkspaceAuditEntry): string {
    const ledger = ledgerOf(this.ctx)
    if (ledger !== null) {
      try {
        const row = ledger.repo.audit(ledger.scopeId, entry.kind, entry.objectId, entry.actor, entry.reason)
        if (row !== undefined && row !== null && row.id !== undefined) return String(row.id)
      } catch {
        /* fall through to memory; the capabilities report exposes the degradation */
      }
    }
    return this.fallback.record(entry)
  }

  trail(limit: number): WorkspaceAuditRecord[] {
    const ledger = ledgerOf(this.ctx)
    if (ledger !== null) {
      try {
        const rows: any[] = ledger.repo.auditTrail(ledger.scopeId ?? LEDGER_SCOPE_FALLBACK, limit) ?? []
        return rows.map((row) => ({
          id: String(row.id),
          time: String(row.time),
          kind: String(row.kind),
          objectId: row.objectId === null || row.objectId === undefined ? null : String(row.objectId),
          actor: String(row.actor),
          reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
        }))
      } catch {
        /* fall through to memory */
      }
    }
    return this.fallback.trail(limit)
  }
}

/* ── capability gate read from the BOOP runtime service ───────────────── */

function workspaceGate(ctx: any): WorkspaceWriteGate {
  const readGates = (): Record<string, 'NOT_RUN' | 'PASS' | 'BLOCKED'> => {
    try {
      const gates = ctx.boop?.state?.()?.gates
      return gates && typeof gates === 'object' ? { ...gates } : {}
    } catch {
      return {}
    }
  }
  return {
    writeModeEnabled(): boolean {
      try {
        return ctx.boop?.isWriteModeEnabled?.() === true
      } catch {
        return false
      }
    },
    gates: readGates,
    blockedByGates(): string[] {
      // One source of truth: the frozen gate ledger derives write mode. Never
      // hard-code a gate list here (G02 became PASS on 2026-10-18).
      try {
        const blocked = ctx.boop?.writeMode?.()?.blockedByGates
        if (Array.isArray(blocked)) return [...blocked]
      } catch {
        /* fall through to the gate map */
      }
      const gates = readGates()
      return Object.entries(gates)
        .filter(([, state]) => state !== 'PASS')
        .map(([gate]) => gate)
    },
  }
}

/* ── Remote service (the UI/IM transport plane) ───────────────────────── */

/**
 * Typert Remote owner for the generated `boopWorkspace` namespace. Every
 * method takes ONE `request` object parameter (the rc.2.1 SRC-marker wire
 * convention: `ctx.connection.rpc.call('/api', 'boopWorkspace/<method>',
 * { args: { request: {...} } })`).
 */
class BoopWorkspaceApi extends TypertRemoteService {
  private readonly core: WorkspaceManagement

  constructor(ctx: any, core: WorkspaceManagement) {
    super(ctx, 'boopWorkspace', { namespace: 'boopWorkspace' })
    this.core = core
  }

  capabilities(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.capabilities(request, { caller: 'ui' })
  }

  listWorkspaces(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.listWorkspaces(request, { caller: 'ui' })
  }

  listSessions(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.listSessions(request, { caller: 'ui' })
  }

  resolveTarget(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.resolveTarget(request, { caller: 'ui' })
  }

  previewBatch(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.previewBatch(request, { caller: 'ui' })
  }

  commitBatch(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.commitBatch(request, { caller: 'ui' })
  }

  auditTrail(request?: unknown): Promise<WorkspaceResult<unknown>> {
    return this.core.auditTrail(request, { caller: 'ui' })
  }
}

for (const method of ['capabilities', 'listWorkspaces', 'listSessions', 'resolveTarget', 'previewBatch', 'commitBatch', 'auditTrail']) {
  remote(method)(BoopWorkspaceApi.prototype)
}

/* ── in-process facade (tool / future IM adapters) ────────────────────── */

export interface BoopWorkspaceService {
  capabilities(request?: unknown): Promise<WorkspaceResult<unknown>>
  listWorkspaces(request?: unknown): Promise<WorkspaceResult<unknown>>
  listSessions(request?: unknown): Promise<WorkspaceResult<unknown>>
  resolveTarget(request?: unknown): Promise<WorkspaceResult<unknown>>
  previewBatch(request?: unknown): Promise<WorkspaceResult<unknown>>
  commitBatch(request?: unknown): Promise<WorkspaceResult<unknown>>
  auditTrail(request?: unknown): Promise<WorkspaceResult<unknown>>
}

function createFacade(core: WorkspaceManagement): BoopWorkspaceService {
  return {
    capabilities: (request?: unknown) => core.capabilities(request, { caller: 'service' }),
    listWorkspaces: (request?: unknown) => core.listWorkspaces(request, { caller: 'service' }),
    listSessions: (request?: unknown) => core.listSessions(request, { caller: 'service' }),
    resolveTarget: (request?: unknown) => core.resolveTarget(request, { caller: 'service' }),
    previewBatch: (request?: unknown) => core.previewBatch(request, { caller: 'service' }),
    commitBatch: (request?: unknown) => core.commitBatch(request, { caller: 'service' }),
    auditTrail: (request?: unknown) => core.auditTrail(request, { caller: 'service' }),
  }
}

/* ── the frozen model-facing tool ─────────────────────────────────────── */

/**
 * Register the frozen model-facing tool over the in-process rule facade.
 * `planeState` is a mutable wiring flag surfaced by `capabilities.diagnostics`:
 * a failed tool registration must be visible, never silently swallowed.
 */
function registerTool(ctx: any, service: BoopWorkspaceService, planeState: { tool: string }): void {
  ctx.inject(['tools'], (child: any) => {
    try {
      child.tools.register(
        defineTool({
          name: 'boop_workspace_change',
          description:
            'BOOP workspace/Session change gate. Preview or commit ONE explicit workspace management operation over exact objects: ' +
            'archive / unarchive a Session, remove a workspace registration, create a workspace registration for an existing directory, ' +
            'rename a workspace title, or create one disk directory. It returns a per-object batch preview (effects, running work, risk) ' +
            'and, on commit, a per-object partial-success list — never an "all succeeded" claim when some objects were refused. ' +
            'Removing a registration never deletes the project directory or Session history, and this tool has NO generic file operation. ' +
            'While BOOP write mode is disabled (gates pending) every commit is refused with CAPABILITY_UNAVAILABLE.',
          parameters: {
            operation: {
              type: 'string',
              required: true,
              description: 'One of: archive, unarchive, remove-registration, create-registration, rename, create-directory',
            },
            targets: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description:
                'Exact object refs: a stable objectId (workspace:<id> / session:<id>), an exact id, or an exact unique title. ' +
                'For create-registration/create-directory pass the fully qualified directory path; for rename pass one workspace ref.',
            },
            mode: { type: 'string', description: "'preview' (default) or 'commit'. Commit requires preview_hash." },
            title: { type: 'string', description: 'rename only: the new non-blank workspace display title.' },
            stop_activity: {
              type: 'boolean',
              description: 'archive only: true stops running work first instead of refusing the object; stops settle in the background.',
            },
            preview_hash: { type: 'string', description: 'commit only: the previewHash returned by the matching preview call.' },
            request_id: { type: 'string', description: 'Optional caller correlation id recorded in the BOOP audit trail.' },
          },
          output: {
            // Value-schema DSL: object schemas must state additionalProperties
            // explicitly and do not accept a top-level `required` list.
            schema: { type: 'object', additionalProperties: true },
            render: (_args: unknown, value: any) => [
              {
                type: 'text',
                text:
                  `BOOP workspace ${String(value?.mode ?? 'preview')}: ` +
                  `${value?.ok === true ? 'ok' : `refused (${String(value?.result?.error?.code ?? 'unknown')})`}` +
                  `${value?.ok === true ? ' — read the per-object effects/outcomes; a batch is never an all-success claim.' : ''}`,
              },
            ],
          },
          execute: async (args: any) => {
            const operation = args?.operation
            const targets = args?.targets
            const mode = args?.mode === 'commit' ? 'commit' : 'preview'
            const request: Record<string, unknown> = { operation, targets }
            const options: Record<string, unknown> = {}
            if (args?.title !== undefined) options.title = args.title
            if (args?.stop_activity !== undefined) options.stopActivity = args.stop_activity
            if (Object.keys(options).length > 0) request.options = options
            if (args?.preview_hash !== undefined) request.previewHash = args.preview_hash
            const result =
              mode === 'commit' ? await service.commitBatch(request) : await service.previewBatch(request)
            return { mode, ok: result.ok, result } as any
          },
        }),
      )
      planeState.tool = 'registered'
    } catch (error) {
      planeState.tool = 'failed'
      child.logger?.warn?.('[boop] workspace tool registration failed; workspace plane keeps running', error)
    }
  })
}

/* ── row lifecycle ────────────────────────────────────────────────────── */

export function apply(ctx: any, config?: BoopWorkspaceConfig): void {
  const effective = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  try {
    const host = new CordisWorkspaceHost(ctx)
    const memoryAudit = new MemoryAuditSink()
    const audit = new LedgerWorkspaceAuditSink(ctx, memoryAudit)
    // Wiring facts only (never authority): the capability matrix reports whether
    // the frozen agent tool actually registered on this composition.
    const planeState = { tool: effective.tool ? 'pending' : 'disabled' }
    const core = new WorkspaceManagement({
      gate: workspaceGate(ctx),
      host,
      mutations: new CordisWorkspaceMutations(ctx),
      audit,
      diagnostics: () => ({
        workspaceTool: planeState.tool,
        remoteService: 'boopWorkspace',
        rulesFacade: 'boopWorkspaceRules',
        endpoints: [
          'capabilities',
          'listWorkspaces',
          'listSessions',
          'resolveTarget',
          'previewBatch',
          'commitBatch',
          'auditTrail',
        ],
      }),
    })
    // The Remote service itself registers `boopWorkspace` on this row's context:
    // one service key owns the Typert binding, so the gateway claims every
    // endpoint from the live marker. The in-process facade is a SEPARATE key:
    // tools (and any future IM adapter) must not construct a second service that
    // shadows the Remote owner.
    new BoopWorkspaceApi(ctx, core)
    const rules = createFacade(core)
    ctx.provide('boopWorkspaceRules', rules)
    if (effective.tool) registerTool(ctx, rules, planeState)
    ctx.logger?.info?.(
      '[boop] workspace plane armed: exact resolution + read/preview available; commit is fail-closed until write mode passes its gates',
    )
  } catch (error) {
    // A throwing optional row must warn, never break the host boot (03§05).
    try {
      ctx.logger?.warn?.('[boop] workspace plane failed to arm; host continues', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
