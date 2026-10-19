/**
 * BOOP workspace & Session management core (E02-04).
 *
 * Frozen rules this module implements (01 FR-04 · 03§04/§07 · 04§08):
 *  - workspace/Session targets are resolved EXACTLY: a stable object id, an
 *    exact id, or a unique exact title. A duplicate title is
 *    `TARGET_AMBIGUOUS` and is never guessed; similar-but-different names are
 *    not candidates at all;
 *  - list / resolve / preview are real read-only operations against the Host
 *    Workspace registry and Session catalog, and they never activate an Agent;
 *  - EVERY write entry point checks BOOP's capability gate FIRST. While
 *    `boop.isWriteModeEnabled()` is false (G02/G05 pending) a commit is
 *    refused fail-closed as `CAPABILITY_UNAVAILABLE` and the refusal is
 *    audited; this module never enables write mode itself;
 *  - removing a workspace registration removes the REGISTRATION only. The
 *    mutation port exposes no file/directory deletion method at all, so there
 *    is no generic rm path that could be reached by accident;
 *  - an archive batch asks the Host's archive-admission providers what still
 *    runs, reports that work per object, and returns a per-object outcome
 *    list; a partial batch is never reported as complete;
 *  - the same rules serve the UI Remote plane, the model-facing tool and any
 *    future IM adapter: all of them call this one core, and the SERVER — not
 *    the UI — refuses an over-reaching request.
 *
 * The core is host-framework-free: it talks to explicit read / mutation /
 * audit ports, so tests drive it with a fake Host and a fake capability gate
 * without booting DSH.
 */

import { createHash } from 'node:crypto'

/* ── result envelope ──────────────────────────────────────────────────── */

/**
 * Structured error codes. The first group comes from 03§07's shared
 * vocabulary; `TARGET_NOT_FOUND` / `TARGET_ACTIVE` / `TARGET_CONFLICT` /
 * `PREVIEW_STALE` / `INVALID_REQUEST` are honest additions this surface needs
 * (the catalog distinguishes "no such object" from "ambiguous target", which
 * the frozen list leaves implicit).
 */
export type WorkspaceErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'VERSION_UNSUPPORTED'
  | 'SCOPE_DENIED'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_ACTIVE'
  | 'TARGET_CONFLICT'
  | 'PREVIEW_STALE'
  | 'INVALID_REQUEST'
  | 'OUTCOME_UNKNOWN'

export interface WorkspaceFailure {
  code: WorkspaceErrorCode
  message: string
  retryable: boolean
  details: Record<string, unknown>
}

export interface WorkspaceAuditReceipt {
  recorded: boolean
  auditId: string | null
}

export type WorkspaceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorkspaceFailure; audit: WorkspaceAuditReceipt | null }

function ok<T>(value: T): WorkspaceResult<T> {
  return { ok: true, value }
}

function fail(
  code: WorkspaceErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  audit: WorkspaceAuditReceipt | null = null,
  retryable = false,
): WorkspaceResult<never> {
  return { ok: false, error: { code, message, retryable, details }, audit }
}

/* ── gate / audit / host ports ────────────────────────────────────────── */

export type GateState = 'NOT_RUN' | 'PASS' | 'BLOCKED'

/** Write-mode gate. The real host reads `boop.isWriteModeEnabled()`. */
export interface WorkspaceWriteGate {
  writeModeEnabled(): boolean
  gates(): Record<string, GateState>
  /** Gates whose state still blocks write mode (frozen default: G02, G05). */
  blockedByGates(): string[]
}

export interface WorkspaceAuditEntry {
  kind: string
  objectId: string | null
  reason: string
  actor: string
}

export interface WorkspaceAuditRecord extends WorkspaceAuditEntry {
  id: string
  time: string
}

export interface WorkspaceAuditSink {
  record(entry: WorkspaceAuditEntry): string
  trail(limit: number): WorkspaceAuditRecord[]
}

/**
 * In-memory audit ring: the honest fallback when BOOP's ledger is
 * unavailable, and what unit tests inspect. It never claims durability; the
 * capabilities report marks the ledger as unavailable in that case.
 */
export class MemoryAuditSink implements WorkspaceAuditSink {
  private readonly entries: WorkspaceAuditRecord[] = []
  private counter = 0
  private readonly capacity: number
  private readonly now: () => string

  constructor(options: { capacity?: number; now?: () => string } = {}) {
    this.capacity = Math.max(1, options.capacity ?? 256)
    this.now = options.now ?? (() => new Date().toISOString())
  }

  record(entry: WorkspaceAuditEntry): string {
    this.counter += 1
    const record: WorkspaceAuditRecord = {
      id: `mem-audit-${this.counter}`,
      time: this.now(),
      kind: entry.kind,
      objectId: entry.objectId,
      reason: entry.reason,
      actor: entry.actor,
    }
    this.entries.push(record)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    return record.id
  }

  trail(limit: number): WorkspaceAuditRecord[] {
    return this.entries
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry }))
  }
}

export interface HostAvailability {
  /**
   * Live Cordis service keys this adapter can see. Keys the core relies on:
   * `workspaceRegistry`, `sessionController`, `sessionQuery`, `activity`,
   * `directoryPicker`.
   */
  services: Record<string, boolean>
  directoryCreate: {
    available: boolean
    backend: string | null
    reason: string | null
  }
  /** Whether audit rows can be persisted in BOOP's own ledger. */
  auditLedger: boolean
}

export interface WorkspaceRecord {
  workspaceId: string
  title: string
  path: string
  directoryStatus: 'ok' | 'missing-dir' | 'unknown'
  sessionIds: string[]
  updatedAt: string | null
}

export interface SessionRecord {
  sessionId: string
  workspaceId: string | null
  title: string | null
  titleKnown: boolean
  cwd: string | null
  live: boolean
  persisted: boolean
  running: boolean
  blank: boolean
  archived: boolean
  updatedAt: number | null
}

export interface SessionCatalogCoverage {
  total: number
  titlesKnown: number
  titlesUnknown: number
  complete: boolean
  source: string
}

export interface SessionCatalog {
  sessions: SessionRecord[]
  coverage: SessionCatalogCoverage
}

export interface ActiveWorkItem {
  id: string
  label: string | null
}

/** One running-work family reported by the archive-admission providers. */
export interface ActiveWork {
  kind: string
  items: ActiveWorkItem[]
}

export interface PathInspection {
  fullyQualified: boolean
  exists: boolean
  isDirectory: boolean
  parentExists: boolean
  parentIsDirectory: boolean
}

/**
 * Read-only Host port. Every method must be safe to call without activating
 * an Agent and without writing anything.
 */
export interface WorkspaceHostPort {
  availability(): Promise<HostAvailability> | HostAvailability
  listWorkspaces(): Promise<WorkspaceRecord[]>
  listSessions(): Promise<SessionCatalog>
  /** Registry-global archive set (Session ids), read from the registry. */
  archivedSessionIds(): string[]
  /** Ask the archive-admission providers what still runs for one Session. */
  sessionActivity(sessionId: string): Promise<ActiveWork[]>
  /** Read-only canonical-path lookup over the Workspace registry. */
  resolveWorkspaceByPath(path: string): Promise<WorkspaceRecord | null>
  /** Read-only `stat` probe used by creation previews; never mutates. */
  inspectPath(path: string): Promise<PathInspection>
}

/**
 * Mutation port. Deliberately has NO delete / arbitrary-file / directory
 * rename method: BOOP cannot delete a project directory or an arbitrary file
 * even if it wanted to. Directory creation is one child segment under an
 * existing fully qualified parent.
 */
export interface WorkspaceMutationPort {
  registerWorkspace(path: string): Promise<{ workspaceId: string; created: boolean }>
  renameWorkspace(workspaceId: string, title: string): Promise<void>
  /** Remove the registration only; returns false when it was already unknown. */
  removeRegistration(workspaceId: string): Promise<boolean>
  archiveSession(sessionId: string, options: { stopActivity: boolean }): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  /** Create one child directory under an existing fully qualified parent. */
  createDirectory(targetPath: string): Promise<string>
}

/* ── request surface ──────────────────────────────────────────────────── */

export const WORKSPACE_OPERATIONS = [
  'archive',
  'unarchive',
  'remove-registration',
  'create-registration',
  'rename',
  'create-directory',
] as const

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number]

export type WorkspaceCaller = 'ui' | 'tool' | 'im' | 'service'

export interface WorkspaceCallMeta {
  caller: WorkspaceCaller
  requestId?: string | null
}

export type ResolveKind = 'workspace' | 'session' | 'any'

/** Authority-bearing fields a client must never be able to submit. */
const AUTHORITY_FIELDS = new Set([
  'ownerId',
  'owner_id',
  'owner',
  'principal',
  'granted',
  'approved',
  'approval',
  'approvalId',
  'approvalNonce',
  'nonce',
  'bypass',
  'force',
  'writeMode',
  'writeModeEnabled',
  'capabilities',
  'capability',
  'actor',
  'actorRole',
  'role',
  'scopeId',
  'policyEpoch',
  'permission',
  'permissions',
  'token',
  'cookie',
  'authorization',
])

const MAX_TARGETS = 64
const MAX_REF_LENGTH = 1024
const MAX_TITLE_LENGTH = 200

const METHOD_FIELDS: Record<string, readonly string[]> = {
  capabilities: [],
  listWorkspaces: [],
  listSessions: [],
  resolveTarget: ['ref', 'kind'],
  previewBatch: ['operation', 'targets', 'options'],
  commitBatch: ['operation', 'targets', 'options', 'previewHash'],
  auditTrail: ['limit'],
}

const OPERATION_OPTION_FIELDS: Record<WorkspaceOperation, readonly string[]> = {
  archive: ['stopActivity'],
  unarchive: [],
  'remove-registration': [],
  'create-registration': [],
  rename: ['title'],
  'create-directory': [],
}

const OPERATION_TARGET_RULE: Record<WorkspaceOperation, { min: number; max: number; label: string }> = {
  archive: { min: 1, max: MAX_TARGETS, label: 'Session refs' },
  unarchive: { min: 1, max: MAX_TARGETS, label: 'Session refs' },
  'remove-registration': { min: 1, max: MAX_TARGETS, label: 'Workspace refs' },
  'create-registration': { min: 1, max: 1, label: 'one directory path' },
  rename: { min: 1, max: 1, label: 'one Workspace ref' },
  'create-directory': { min: 1, max: 1, label: 'one target directory path' },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

function validateEnvelope(
  raw: unknown,
  method: string,
): { ok: true; request: Record<string, unknown> } | { ok: false; failure: WorkspaceFailure } {
  if (raw === undefined || raw === null) return { ok: true, request: {} }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      failure: { code: 'INVALID_REQUEST', message: `${method}: the request must be one plain object`, retryable: false, details: { method } },
    }
  }
  const allowed = METHOD_FIELDS[method] ?? []
  const authority: string[] = []
  const unknown: string[] = []
  for (const key of Object.keys(raw)) {
    if (AUTHORITY_FIELDS.has(key)) authority.push(key)
    else if (!allowed.includes(key)) unknown.push(key)
  }
  if (authority.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'SCOPE_DENIED',
        message: `${method}: the server derives authority; client-supplied authority fields are refused (${authority.join(', ')})`,
        retryable: false,
        details: { method, fields: authority },
      },
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: `${method}: unknown request fields (${unknown.join(', ')})`,
        retryable: false,
        details: { method, fields: unknown },
      },
    }
  }
  return { ok: true, request: raw }
}

function parseOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; failure: WorkspaceFailure } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, failure: { code: 'INVALID_REQUEST', message: `${field} must be a string`, retryable: false, details: { field } } }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: `${field} must be a non-blank string of at most ${maxLength} characters`,
        retryable: false,
        details: { field },
      },
    }
  }
  return { ok: true, value: trimmed }
}

function parseTargets(
  value: unknown,
): { ok: true; targets: string[]; deduplicated: number } | { ok: false; failure: WorkspaceFailure } {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: 'targets must be a non-empty array of exact object ids, exact ids or exact titles',
        retryable: false,
        details: { field: 'targets' },
      },
    }
  }
  if (value.length > MAX_TARGETS) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: `targets must contain at most ${MAX_TARGETS} entries`,
        retryable: false,
        details: { field: 'targets', max: MAX_TARGETS },
      },
    }
  }
  const targets: string[] = []
  const seen = new Set<string>()
  let deduplicated = 0
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return {
        ok: false,
        failure: { code: 'INVALID_REQUEST', message: 'every targets entry must be a string', retryable: false, details: { field: 'targets' } },
      }
    }
    const trimmed = entry.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_REF_LENGTH) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_REQUEST',
          message: `every targets entry must be a non-blank string of at most ${MAX_REF_LENGTH} characters`,
          retryable: false,
          details: { field: 'targets' },
        },
      }
    }
    if (seen.has(trimmed)) {
      deduplicated += 1
      continue
    }
    seen.add(trimmed)
    targets.push(trimmed)
  }
  return { ok: true, targets, deduplicated }
}

function parseOperation(value: unknown): { ok: true; operation: WorkspaceOperation } | { ok: false; failure: WorkspaceFailure } {
  if (typeof value !== 'string' || !(WORKSPACE_OPERATIONS as readonly string[]).includes(value)) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: `operation must be one of: ${WORKSPACE_OPERATIONS.join(', ')}`,
        retryable: false,
        details: { field: 'operation', allowed: [...WORKSPACE_OPERATIONS] },
      },
    }
  }
  return { ok: true, operation: value as WorkspaceOperation }
}

interface ParsedOptions {
  stopActivity: boolean
  title: string | null
}

function parseOptions(
  raw: unknown,
  operation: WorkspaceOperation,
): { ok: true; options: ParsedOptions } | { ok: false; failure: WorkspaceFailure } {
  const result: ParsedOptions = { stopActivity: false, title: null }
  if (raw === undefined || raw === null) {
    if (operation === 'rename') {
      return {
        ok: false,
        failure: { code: 'INVALID_REQUEST', message: 'rename requires options.title', retryable: false, details: { field: 'options.title' } },
      }
    }
    return { ok: true, options: result }
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      failure: { code: 'INVALID_REQUEST', message: 'options must be one plain object', retryable: false, details: { field: 'options' } },
    }
  }
  const allowed = OPERATION_OPTION_FIELDS[operation]
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    return {
      ok: false,
      failure: {
        code: 'INVALID_REQUEST',
        message: `${operation} does not accept options.${unknown.join(', options.')}`,
        retryable: false,
        details: { field: 'options', unknown },
      },
    }
  }
  if (raw.stopActivity !== undefined) {
    if (typeof raw.stopActivity !== 'boolean') {
      return {
        ok: false,
        failure: {
          code: 'INVALID_REQUEST',
          message: 'options.stopActivity must be a boolean',
          retryable: false,
          details: { field: 'options.stopActivity' },
        },
      }
    }
    result.stopActivity = raw.stopActivity
  }
  if (operation === 'rename') {
    const title = parseOptionalString(raw.title, 'options.title', MAX_TITLE_LENGTH)
    if (!title.ok) return title
    if (title.value === null) {
      return {
        ok: false,
        failure: { code: 'INVALID_REQUEST', message: 'rename requires a non-blank options.title', retryable: false, details: { field: 'options.title' } },
      }
    }
    result.title = title.value
  }
  return { ok: true, options: result }
}

function parseKind(value: unknown): { ok: true; kind: ResolveKind } | { ok: false; failure: WorkspaceFailure } {
  if (value === undefined || value === null) return { ok: true, kind: 'any' }
  if (value === 'workspace' || value === 'session' || value === 'any') return { ok: true, kind: value }
  return {
    ok: false,
    failure: { code: 'INVALID_REQUEST', message: 'kind must be workspace, session or any', retryable: false, details: { field: 'kind' } },
  }
}

/* ── stable object ids ────────────────────────────────────────────────── */

export function workspaceObjectId(workspaceId: string): string {
  return `workspace:${workspaceId}`
}

export function sessionObjectId(sessionId: string): string {
  return `session:${sessionId}`
}

/* ── canonical hashing ────────────────────────────────────────────────── */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ── resolution ───────────────────────────────────────────────────────── */

type MatchedBy = 'object-id' | 'exact-id' | 'unique-title'

interface ResolvedWorkspace {
  kind: 'workspace'
  workspace: WorkspaceRecord
  objectId: string
  matchedBy: MatchedBy
}

interface ResolvedSession {
  kind: 'session'
  session: SessionRecord
  objectId: string
  matchedBy: MatchedBy
}

type ResolvedTarget = ResolvedWorkspace | ResolvedSession

interface ResolutionFailure {
  code: 'TARGET_AMBIGUOUS' | 'TARGET_NOT_FOUND' | 'INVALID_REQUEST'
  message: string
  details: Record<string, unknown>
}

export interface ResolveTargetValue {
  objectId: string
  kind: 'workspace' | 'session'
  display: string
  matchedBy: MatchedBy
  /** Stable identity facts: the display title may change without changing objectId. */
  identity: {
    workspaceId: string | null
    sessionId: string | null
  }
  workspace: WorkspaceRecord | null
  session: SessionRecord | null
  coverage: { workspaces: number; sessions: number; titlesUnknown: number }
}

interface Candidate {
  objectId: string
  kind: 'workspace' | 'session'
  title: string
  path: string | null
}

function resolveOne(ref: string, kind: ResolveKind, workspaces: WorkspaceRecord[], catalog: SessionCatalog): ResolvedTarget | ResolutionFailure {
  const sessions = catalog.sessions
  const coverage = { workspaces: workspaces.length, sessions: sessions.length, titlesUnknown: catalog.coverage.titlesUnknown }
  const candidates: Candidate[] = []
  const pushWorkspace = (workspace: WorkspaceRecord): void => {
    candidates.push({ objectId: workspaceObjectId(workspace.workspaceId), kind: 'workspace', title: workspace.title, path: workspace.path })
  }
  const pushSession = (session: SessionRecord): void => {
    candidates.push({ objectId: sessionObjectId(session.sessionId), kind: 'session', title: session.title ?? session.sessionId, path: session.cwd })
  }

  // 1) Prefixed object ids are strict identity: never fall back to a title.
  if (ref.startsWith('workspace:')) {
    if (kind === 'session') {
      return { code: 'INVALID_REQUEST', message: 'the ref names a workspace object but kind=session was requested', details: { ref, kind } }
    }
    const id = ref.slice('workspace:'.length)
    const workspace = workspaces.find((entry) => entry.workspaceId === id)
    if (workspace === undefined) {
      return { code: 'TARGET_NOT_FOUND', message: `no workspace has identity ${JSON.stringify(id)}`, details: { ref, kind: 'workspace', coverage } }
    }
    return { kind: 'workspace', workspace, objectId: workspaceObjectId(workspace.workspaceId), matchedBy: 'object-id' }
  }
  if (ref.startsWith('session:')) {
    if (kind === 'workspace') {
      return { code: 'INVALID_REQUEST', message: 'the ref names a session object but kind=workspace was requested', details: { ref, kind } }
    }
    const id = ref.slice('session:'.length)
    const session = sessions.find((entry) => entry.sessionId === id)
    if (session === undefined) {
      return { code: 'TARGET_NOT_FOUND', message: `no Session has identity ${JSON.stringify(id)}`, details: { ref, kind: 'session', coverage } }
    }
    return { kind: 'session', session, objectId: sessionObjectId(session.sessionId), matchedBy: 'object-id' }
  }

  // 2) Exact raw ids outrank titles.
  if (kind !== 'session') for (const workspace of workspaces) if (workspace.workspaceId === ref) pushWorkspace(workspace)
  if (kind !== 'workspace') for (const session of sessions) if (session.sessionId === ref) pushSession(session)
  if (candidates.length > 0) return exactFromCandidates(candidates, 'exact-id', workspaces, sessions, coverage, ref, kind)

  // 3) Exact title equality only. Similar names are NOT candidates: the frozen
  //    "never guess a same-named target" rule (01 FR-04, AT-06).
  if (kind !== 'session') for (const workspace of workspaces) if (workspace.title === ref) pushWorkspace(workspace)
  if (kind !== 'workspace') for (const session of sessions) if (session.titleKnown && session.title === ref) pushSession(session)
  if (candidates.length > 0) return exactFromCandidates(candidates, 'unique-title', workspaces, sessions, coverage, ref, kind)

  const titlesIncomplete = kind !== 'workspace' && catalog.coverage.titlesUnknown > 0
  return {
    code: 'TARGET_NOT_FOUND',
    message: titlesIncomplete
      ? `no exact object id or title matches ${JSON.stringify(ref)}; ${catalog.coverage.titlesUnknown} Session title(s) could not be read, so this is not a definitive miss`
      : `no exact object id or title matches ${JSON.stringify(ref)}`,
    details: {
      ref,
      kind,
      coverage,
      titleCoverageComplete: !titlesIncomplete,
      // Never guess, and never claim certainty the data does not support.
      definitive: !titlesIncomplete,
    },
  }
}

function exactFromCandidates(
  candidates: Candidate[],
  matchedBy: 'exact-id' | 'unique-title',
  workspaces: WorkspaceRecord[],
  sessions: SessionRecord[],
  coverage: { workspaces: number; sessions: number; titlesUnknown: number },
  ref: string,
  kind: ResolveKind,
): ResolvedTarget | ResolutionFailure {
  if (candidates.length > 1) {
    return {
      code: 'TARGET_AMBIGUOUS',
      message: `${JSON.stringify(ref)} matches ${candidates.length} objects exactly (${matchedBy === 'exact-id' ? 'identity' : 'title'}); refusing to guess — ask the user which one`,
      details: { ref, kind, matchedBy, candidates, coverage },
    }
  }
  const only = candidates[0]!
  if (only.kind === 'workspace') {
    const id = only.objectId.slice('workspace:'.length)
    const workspace = workspaces.find((entry) => entry.workspaceId === id)
    if (workspace === undefined) {
      return { code: 'TARGET_NOT_FOUND', message: `resolved workspace ${JSON.stringify(only.objectId)} disappeared`, details: { ref, coverage } }
    }
    return { kind: 'workspace', workspace, objectId: only.objectId, matchedBy }
  }
  const id = only.objectId.slice('session:'.length)
  const session = sessions.find((entry) => entry.sessionId === id)
  if (session === undefined) {
    return { code: 'TARGET_NOT_FOUND', message: `resolved Session ${JSON.stringify(only.objectId)} disappeared`, details: { ref, coverage } }
  }
  return { kind: 'session', session, objectId: only.objectId, matchedBy }
}

function projectResolved(resolved: ResolvedTarget, domain: { workspaces: WorkspaceRecord[]; catalog: SessionCatalog }): ResolveTargetValue {
  const coverage = {
    workspaces: domain.workspaces.length,
    sessions: domain.catalog.sessions.length,
    titlesUnknown: domain.catalog.coverage.titlesUnknown,
  }
  if (resolved.kind === 'workspace') {
    return {
      objectId: resolved.objectId,
      kind: 'workspace',
      display: resolved.workspace.title,
      matchedBy: resolved.matchedBy,
      identity: { workspaceId: resolved.workspace.workspaceId, sessionId: null },
      workspace: resolved.workspace,
      session: null,
      coverage,
    }
  }
  return {
    objectId: resolved.objectId,
    kind: 'session',
    display: resolved.session.title ?? resolved.session.sessionId,
    matchedBy: resolved.matchedBy,
    identity: { workspaceId: resolved.session.workspaceId, sessionId: resolved.session.sessionId },
    workspace: null,
    session: resolved.session,
    coverage,
  }
}

/* ── capability matrix ────────────────────────────────────────────────── */

export interface CapabilityMethodEntry {
  method: string
  endpoint: string
  kind: 'read' | 'write'
  requires: string[]
  status: 'available' | 'disabled' | 'unavailable'
  reason: string | null
}

export interface CapabilitiesValue {
  schemaVersion: 1
  product: 'BOOP'
  host: HostAvailability
  writeMode: {
    enabled: boolean
    blockedByGates: string[]
    gates: Record<string, GateState>
    source: string
    writeMethodsFailClosed: true
  }
  methods: CapabilityMethodEntry[]
  degradation: Array<{ capability: string; status: 'unavailable' | 'disabled'; reason: string }>
  /** Adapter-reported wiring facts (e.g. which agent tool registered), or null. */
  diagnostics: Record<string, unknown> | null
  rules: {
    exactResolutionOnly: true
    removeRegistrationDeletesDisk: false
    archiveReportsRunningWork: true
    genericFileDelete: false
    serverSideAuthority: true
  }
}

const ENDPOINT_NAMESPACE = 'boopWorkspace'

const READ_REQUIREMENTS: Record<string, readonly string[]> = {
  capabilities: [],
  listWorkspaces: ['workspaceRegistry'],
  listSessions: ['sessions'],
  resolveTarget: ['workspaceRegistry', 'sessions'],
  previewBatch: ['workspaceRegistry', 'sessions'],
  auditTrail: [],
}

const WRITE_REQUIREMENTS: Record<string, readonly string[]> = {
  commitBatch: ['workspaceRegistry', 'sessions'],
}

function missingRequirements(required: readonly string[], availability: HostAvailability): string[] {
  const missing: string[] = []
  for (const key of required) {
    if (key === 'sessions') {
      if (!availability.services.sessionController && !availability.services.sessionQuery) missing.push('sessions (sessionController or sessionQuery)')
      continue
    }
    if (key === 'activity') {
      if (!availability.services.activity) missing.push('activity (workspace/session-activity query)')
      continue
    }
    if (!availability.services[key]) missing.push(key)
  }
  return missing
}

function previewRequirements(operation: WorkspaceOperation): readonly string[] {
  switch (operation) {
    case 'archive':
      return ['workspaceRegistry', 'sessions', 'activity']
    case 'unarchive':
      return ['workspaceRegistry', 'sessions']
    case 'remove-registration':
      return ['workspaceRegistry']
    case 'create-registration':
      return ['workspaceRegistry']
    case 'rename':
      return ['workspaceRegistry']
    case 'create-directory':
      return ['directoryPicker']
    default:
      return ['workspaceRegistry', 'sessions']
  }
}

/* ── preview / commit values ──────────────────────────────────────────── */

export type PreviewItemStatus = 'ready' | 'no-op' | 'would-partially-fail' | 'unavailable' | 'invalid'

export interface PreviewEffects {
  /** Structural fact: no BOOP workspace operation deletes disk content. */
  deletesDisk: false
  /** Structural fact: no BOOP workspace operation deletes Session history. */
  deletesSessions: false
  diskEffect: 'none' | 'create-directory'
  registrationEffect: 'none' | 'create' | 'remove' | 'rename'
  archiveEffect: 'none' | 'archive' | 'unarchive'
  becomesUngrouped: boolean
  clearsPin: boolean
}

export interface BatchPreviewItem {
  objectId: string | null
  targetKind: 'workspace' | 'session' | 'directory' | null
  targetId: string | null
  targetPath: string | null
  display: string
  status: PreviewItemStatus
  code: WorkspaceErrorCode | null
  reason: string | null
  effects: PreviewEffects
  activity: ActiveWork[]
  warnings: string[]
}

export interface BatchPreviewSummary {
  total: number
  ready: number
  noOp: number
  wouldPartiallyFail: number
  unavailable: number
  invalid: number
  activeWork: number
}

export interface BatchPreview {
  operation: WorkspaceOperation
  caller: WorkspaceCaller
  previewId: string
  previewHash: string
  generatedAt: string
  /** True only when every item could be attempted; a preview never executes. */
  feasible: boolean
  executed: false
  requiresApproval: true
  deletesDisk: false
  deletesSessions: false
  items: BatchPreviewItem[]
  summary: BatchPreviewSummary
  warnings: string[]
  writeMode: { enabled: boolean; blockedByGates: string[] }
}

export type CommitItemStatus = 'succeeded' | 'refused' | 'failed' | 'unknown'

export interface CommitItemOutcome {
  objectId: string | null
  targetKind: 'workspace' | 'session' | 'directory' | null
  targetId: string | null
  status: CommitItemStatus
  noOp: boolean
  code: WorkspaceErrorCode | null
  message: string | null
  activity: ActiveWork[]
  retryable: boolean
}

export interface BatchCommitValue {
  operation: WorkspaceOperation
  caller: WorkspaceCaller
  previewHash: string
  executed: true
  items: CommitItemOutcome[]
  summary: { total: number; succeeded: number; refused: number; failed: number; unknown: number; noOp: number }
  /** True only when every item reached its requested end state. */
  claimedComplete: boolean
  /** Never true: a batch is a per-object list, not an all-or-nothing transaction. */
  atomic: false
  notes: string[]
  auditIds: string[]
  writeMode: { enabled: true; blockedByGates: string[] }
}

export interface AuditTrailValue {
  entries: WorkspaceAuditRecord[]
  source: 'ledger' | 'memory'
  writeModeEnabled: boolean
}

interface PreviewInput {
  operation: WorkspaceOperation
  targets: string[]
  options: ParsedOptions
  deduplicated: number
}

interface PreviewBuild {
  input: PreviewInput
  items: BatchPreviewItem[]
  warnings: string[]
  writeMode: { enabled: boolean; blockedByGates: string[] }
}

/* ── preview helpers ──────────────────────────────────────────────────── */

function noneEffects(): PreviewEffects {
  return {
    deletesDisk: false,
    deletesSessions: false,
    diskEffect: 'none',
    registrationEffect: 'none',
    archiveEffect: 'none',
    becomesUngrouped: false,
    clearsPin: false,
  }
}

function previewWarnings(operation: WorkspaceOperation): string[] {
  switch (operation) {
    case 'archive':
      return ['归档只改变分组可见性，不删除 Session 历史；仍在运行的目标会逐项拒绝，结果不是“全部成功”。']
    case 'unarchive':
      return ['恢复只移除归档标记，不改变 Session 历史与工作区归属。']
    case 'remove-registration':
      return ['移除注册只删除注册记录：磁盘目录与 Session 历史保持原样，原 Session 变为未分组。']
    case 'create-registration':
      return ['创建工作区注册要求目录已存在；它不会创建或删除磁盘目录。']
    case 'rename':
      return ['改名只改工作区显示标题，不重命名磁盘目录。']
    case 'create-directory':
      return ['创建磁盘目录是独立动作，不自动创建工作区注册。']
    default:
      return []
  }
}

function makeItem(partial: Partial<BatchPreviewItem> & Pick<BatchPreviewItem, 'display' | 'status'>): BatchPreviewItem {
  return {
    objectId: partial.objectId ?? null,
    targetKind: partial.targetKind ?? null,
    targetId: partial.targetId ?? null,
    targetPath: partial.targetPath ?? null,
    display: partial.display,
    status: partial.status,
    code: partial.code ?? null,
    reason: partial.reason ?? null,
    effects: partial.effects ?? noneEffects(),
    activity: partial.activity ?? [],
    warnings: partial.warnings ?? [],
  }
}

function invalidItem(display: string, failure: { code: WorkspaceErrorCode; message: string }): BatchPreviewItem {
  return makeItem({ display, status: 'invalid', code: failure.code, reason: failure.message })
}

function unavailableItem(display: string, reason: string): BatchPreviewItem {
  return makeItem({ display, status: 'unavailable', code: 'CAPABILITY_UNAVAILABLE', reason })
}

async function safeActivity(port: WorkspaceHostPort, sessionId: string): Promise<{ ok: true; value: ActiveWork[] } | { ok: false; error: string }> {
  try {
    const value = await port.sessionActivity(sessionId)
    return {
      ok: true,
      value: value.map((entry) => ({
        kind: entry.kind,
        items: entry.items.map((item) => ({ id: item.id, label: item.label })),
      })),
    }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

function classifyMutationError(
  error: unknown,
  activity: ActiveWork[],
): { status: CommitItemStatus; code: WorkspaceErrorCode; message: string; retryable: boolean } {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const code = typeof record.code === 'string' ? record.code : ''
  const message = errorText(error)
  if (code === 'workspace/session-active') return { status: 'refused', code: 'TARGET_ACTIVE', message, retryable: false }
  if (code === 'workspace/not-found' || code === 'session/not-found') return { status: 'failed', code: 'TARGET_NOT_FOUND', message, retryable: false }
  if (code === 'workspace/name-conflict') return { status: 'failed', code: 'TARGET_CONFLICT', message, retryable: false }
  if (code === 'workspace/invalid-path' || code === 'gateway/bad-request') return { status: 'failed', code: 'INVALID_REQUEST', message, retryable: false }
  if (code === 'directory-exists') return { status: 'failed', code: 'TARGET_CONFLICT', message, retryable: false }
  if (code === 'directory-create-failed') return { status: 'failed', code: 'INVALID_REQUEST', message, retryable: false }
  if (activity.length > 0) return { status: 'refused', code: 'TARGET_ACTIVE', message, retryable: false }
  // An unclassified failure may have happened before or after a durable write:
  // report it as unknown and never retry automatically (03§09).
  return { status: 'unknown', code: 'OUTCOME_UNKNOWN', message, retryable: false }
}

/* ── core ─────────────────────────────────────────────────────────────── */

export interface WorkspaceManagementDeps {
  gate: WorkspaceWriteGate
  host: WorkspaceHostPort
  /** Null only when the host adapter has no mutation seam on this composition. */
  mutations: WorkspaceMutationPort | null
  audit: WorkspaceAuditSink
  now?: () => string
  /** Optional adapter wiring facts surfaced by the capability matrix (never authority). */
  diagnostics?: () => Record<string, unknown>
}

export class WorkspaceManagement {
  private readonly deps: WorkspaceManagementDeps
  private readonly now: () => string

  constructor(deps: WorkspaceManagementDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /* ── shared helpers ─────────────────────────────────────────────────── */

  private gateSnapshot(): { enabled: boolean; blockedByGates: string[] } {
    let enabled = false
    let blocked: string[] = []
    try {
      enabled = this.deps.gate.writeModeEnabled() === true
    } catch {
      enabled = false
    }
    try {
      blocked = [...this.deps.gate.blockedByGates()]
    } catch {
      blocked = ['G02', 'G05']
    }
    return { enabled, blockedByGates: blocked }
  }

  private gateStates(): Record<string, GateState> {
    try {
      return { ...this.deps.gate.gates() }
    } catch {
      return {}
    }
  }

  private diagnostics(): Record<string, unknown> | null {
    if (this.deps.diagnostics === undefined) return null
    try {
      const value = this.deps.diagnostics()
      return isPlainObject(value) ? { ...value } : null
    } catch {
      return null
    }
  }

  private audit(entry: WorkspaceAuditEntry): WorkspaceAuditReceipt {
    try {
      const auditId = this.deps.audit.record(entry)
      return { recorded: true, auditId: auditId.length > 0 ? auditId : null }
    } catch {
      return { recorded: false, auditId: null }
    }
  }

  private brief(meta: WorkspaceCallMeta): string {
    return `${meta.caller}/${meta.requestId ?? '-'}`
  }

  private auditWriteRefusal(meta: WorkspaceCallMeta, operation: string | null, code: WorkspaceErrorCode, detail: string): WorkspaceAuditReceipt {
    return this.audit({
      kind: code === 'SCOPE_DENIED' ? 'workspace/privilege-refused' : 'workspace/write-refused',
      objectId: operation,
      actor: meta.caller,
      reason: `${this.brief(meta)} ${code}${detail.length > 0 ? ` ${detail}` : ''}`,
    })
  }

  private async availability(): Promise<{ ok: true; value: HostAvailability } | { ok: false; failure: WorkspaceFailure }> {
    try {
      const value = await this.deps.host.availability()
      if (!isPlainObject(value) || !isPlainObject(value.services)) {
        return {
          ok: false,
          failure: { code: 'CAPABILITY_UNAVAILABLE', message: 'the Host capability probe returned no usable surface', retryable: true, details: {} },
        }
      }
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        failure: { code: 'CAPABILITY_UNAVAILABLE', message: `the Host capability probe failed: ${errorText(error)}`, retryable: true, details: {} },
      }
    }
  }

  private async loadDomain(): Promise<
    { ok: true; value: { workspaces: WorkspaceRecord[]; catalog: SessionCatalog } } | { ok: false; failure: WorkspaceFailure }
  > {
    try {
      const [workspaces, catalog] = await Promise.all([this.deps.host.listWorkspaces(), this.deps.host.listSessions()])
      return { ok: true, value: { workspaces, catalog } }
    } catch (error) {
      return {
        ok: false,
        failure: { code: 'CAPABILITY_UNAVAILABLE', message: `the Host domain read failed: ${errorText(error)}`, retryable: true, details: {} },
      }
    }
  }

  /* ── read: capability matrix and degradation table ──────────────────── */

  async capabilities(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<CapabilitiesValue>> {
    const envelope = validateEnvelope(request, 'capabilities')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    const availability = await this.availability()
    if (!availability.ok) return fail(availability.failure.code, availability.failure.message, availability.failure.details, null, true)
    const host = availability.value
    const writeMode = this.gateSnapshot()
    const methods: CapabilityMethodEntry[] = []
    const degradation: CapabilitiesValue['degradation'] = []

    for (const [method, required] of Object.entries(READ_REQUIREMENTS)) {
      const missing = missingRequirements(required, host)
      methods.push({
        method,
        endpoint: `${ENDPOINT_NAMESPACE}/${method}`,
        kind: 'read',
        requires: [...required],
        status: missing.length === 0 ? 'available' : 'unavailable',
        reason: missing.length === 0 ? null : `missing Host service(s): ${missing.join(', ')}`,
      })
      if (missing.length > 0) degradation.push({ capability: method, status: 'unavailable', reason: `missing Host service(s): ${missing.join(', ')}` })
    }
    if (!host.auditLedger) {
      degradation.push({
        capability: 'audit-ledger',
        status: 'unavailable',
        reason: 'BOOP ledger is unavailable; refusals are audited in process memory only (not durable)',
      })
    }
    for (const [method, required] of Object.entries(WRITE_REQUIREMENTS)) {
      const missing = missingRequirements(required, host)
      const disabledByGate = !writeMode.enabled
      methods.push({
        method,
        endpoint: `${ENDPOINT_NAMESPACE}/${method}`,
        kind: 'write',
        requires: [...required],
        status: missing.length > 0 ? 'unavailable' : disabledByGate ? 'disabled' : 'available',
        reason:
          missing.length > 0
            ? `missing Host service(s): ${missing.join(', ')}`
            : disabledByGate
              ? `write mode is disabled; gates pending: ${writeMode.blockedByGates.join(', ')}`
              : null,
      })
      if (missing.length > 0) {
        degradation.push({ capability: method, status: 'unavailable', reason: `missing Host service(s): ${missing.join(', ')}` })
      } else if (disabledByGate) {
        degradation.push({
          capability: method,
          status: 'disabled',
          reason: `fail-closed: BOOP write mode is disabled until ${writeMode.blockedByGates.join(', ')} pass`,
        })
      }
    }
    if (!host.directoryCreate.available) {
      degradation.push({
        capability: 'create-directory',
        status: 'unavailable',
        reason: host.directoryCreate.reason ?? 'the Host exposes no directory-creation primitive',
      })
    }
    return ok({
      schemaVersion: 1,
      product: 'BOOP',
      host,
      writeMode: {
        enabled: writeMode.enabled,
        blockedByGates: writeMode.blockedByGates,
        gates: this.gateStates(),
        source: 'boop.isWriteModeEnabled()',
        writeMethodsFailClosed: true,
      },
      methods,
      degradation,
      diagnostics: this.diagnostics(),
      rules: {
        exactResolutionOnly: true,
        removeRegistrationDeletesDisk: false,
        archiveReportsRunningWork: true,
        genericFileDelete: false,
        serverSideAuthority: true,
      },
    })
  }

  /* ── read: workspaces ───────────────────────────────────────────────── */

  async listWorkspaces(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<{ items: WorkspaceRecord[]; count: number }>> {
    const envelope = validateEnvelope(request, 'listWorkspaces')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    const availability = await this.availability()
    if (!availability.ok) return fail(availability.failure.code, availability.failure.message, availability.failure.details, null, true)
    const missing = missingRequirements(READ_REQUIREMENTS.listWorkspaces ?? [], availability.value)
    if (missing.length > 0) return fail('CAPABILITY_UNAVAILABLE', `listWorkspaces is unavailable: ${missing.join(', ')}`, { missing })
    try {
      const items = await this.deps.host.listWorkspaces()
      return ok({ items, count: items.length })
    } catch (error) {
      return fail('CAPABILITY_UNAVAILABLE', `the Workspace registry read failed: ${errorText(error)}`, {}, null, true)
    }
  }

  /* ── read: Sessions ─────────────────────────────────────────────────── */

  async listSessions(
    request: unknown,
    meta: WorkspaceCallMeta,
  ): Promise<WorkspaceResult<{ sessions: SessionRecord[]; coverage: SessionCatalogCoverage; archived: string[] }>> {
    const envelope = validateEnvelope(request, 'listSessions')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    const availability = await this.availability()
    if (!availability.ok) return fail(availability.failure.code, availability.failure.message, availability.failure.details, null, true)
    const missing = missingRequirements(READ_REQUIREMENTS.listSessions ?? [], availability.value)
    if (missing.length > 0) return fail('CAPABILITY_UNAVAILABLE', `listSessions is unavailable: ${missing.join(', ')}`, { missing })
    try {
      const catalog = await this.deps.host.listSessions()
      let archived: string[] = []
      try {
        archived = this.deps.host.archivedSessionIds()
      } catch {
        archived = []
      }
      return ok({ sessions: catalog.sessions, coverage: catalog.coverage, archived })
    } catch (error) {
      return fail('CAPABILITY_UNAVAILABLE', `the Session catalog read failed: ${errorText(error)}`, {}, null, true)
    }
  }

  /* ── read: exact target resolution ──────────────────────────────────── */

  async resolveTarget(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<ResolveTargetValue>> {
    const envelope = validateEnvelope(request, 'resolveTarget')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    const ref = parseOptionalString(envelope.request.ref, 'ref', MAX_REF_LENGTH)
    if (!ref.ok) return { ok: false, error: ref.failure, audit: null }
    if (ref.value === null) {
      return fail('INVALID_REQUEST', 'resolveTarget requires ref (an object id, an exact id, or an exact title)', { field: 'ref' })
    }
    const kind = parseKind(envelope.request.kind)
    if (!kind.ok) return { ok: false, error: kind.failure, audit: null }

    const availability = await this.availability()
    if (!availability.ok) return fail(availability.failure.code, availability.failure.message, availability.failure.details, null, true)
    const missing = missingRequirements(READ_REQUIREMENTS.resolveTarget ?? [], availability.value)
    if (missing.length > 0) return fail('CAPABILITY_UNAVAILABLE', `resolveTarget is unavailable: ${missing.join(', ')}`, { missing })
    const domain = await this.loadDomain()
    if (!domain.ok) return { ok: false, error: domain.failure, audit: null }

    const resolved = resolveOne(ref.value, kind.kind, domain.value.workspaces, domain.value.catalog)
    if ('code' in resolved) return fail(resolved.code, resolved.message, resolved.details)
    return ok(projectResolved(resolved, domain.value))
  }

  /* ── read: batch preview ────────────────────────────────────────────── */

  async previewBatch(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<BatchPreview>> {
    const envelope = validateEnvelope(request, 'previewBatch')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    const parsed = await this.parseBatchRequest(envelope.request)
    if (!parsed.ok) return { ok: false, error: parsed.failure, audit: null }
    const availability = await this.availability()
    if (!availability.ok) return fail(availability.failure.code, availability.failure.message, availability.failure.details, null, true)
    const missing = missingRequirements(previewRequirements(parsed.value.operation), availability.value)
    if (missing.length > 0) {
      return fail('CAPABILITY_UNAVAILABLE', `previewBatch is unavailable: ${missing.join(', ')}`, { missing, operation: parsed.value.operation })
    }
    const build = await this.buildPreview(parsed.value, availability.value)
    if (!build.ok) return { ok: false, error: build.failure, audit: null }
    return ok(this.finishPreview(build.value, meta))
  }

  /* ── write: gated batch commit ──────────────────────────────────────── */

  async commitBatch(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<BatchCommitValue>> {
    const envelope = validateEnvelope(request, 'commitBatch')
    if (!envelope.ok) {
      const audit = this.auditWriteRefusal(meta, null, envelope.failure.code, 'commit request rejected')
      return { ok: false, error: envelope.failure, audit }
    }
    const parsed = await this.parseBatchRequest(envelope.request)
    if (!parsed.ok) {
      const audit = this.auditWriteRefusal(meta, null, parsed.failure.code, 'commit request rejected')
      return { ok: false, error: parsed.failure, audit }
    }
    const operation = parsed.value.operation
    const previewHash = envelope.request.previewHash
    if (typeof previewHash !== 'string' || !/^[0-9a-f]{64}$/.test(previewHash)) {
      const failure: WorkspaceFailure = {
        code: 'INVALID_REQUEST',
        message: 'commitBatch requires the 64-hex previewHash returned by previewBatch',
        retryable: false,
        details: { field: 'previewHash' },
      }
      return { ok: false, error: failure, audit: this.auditWriteRefusal(meta, operation, failure.code, 'bad previewHash') }
    }

    // Fail closed: the capability gate is checked BEFORE any preview or
    // mutation work, so a closed gate cannot be raced into an execution path.
    const writeMode = this.gateSnapshot()
    if (!writeMode.enabled) {
      const failure: WorkspaceFailure = {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `BOOP write mode is disabled until ${writeMode.blockedByGates.join(', ')} pass; no workspace change was executed`,
        retryable: false,
        details: {
          operation,
          requested: parsed.value.targets.length,
          blockedByGates: writeMode.blockedByGates,
          writeModeEnabled: false,
        },
      }
      return {
        ok: false,
        error: failure,
        audit: this.auditWriteRefusal(
          meta,
          operation,
          failure.code,
          `blockedBy=${writeMode.blockedByGates.join('+')} targets=${parsed.value.targets.length}`,
        ),
      }
    }
    if (this.deps.mutations === null) {
      const failure: WorkspaceFailure = {
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'the Host exposes no workspace mutation seam on this composition; nothing was executed',
        retryable: false,
        details: { operation, missing: 'workspaceController / directoryPicker' },
      }
      return { ok: false, error: failure, audit: this.auditWriteRefusal(meta, operation, failure.code, 'no mutation seam') }
    }

    const availability = await this.availability()
    if (!availability.ok) {
      return {
        ok: false,
        error: availability.failure,
        audit: this.auditWriteRefusal(meta, operation, availability.failure.code, 'capability probe failed'),
      }
    }
    const missing = missingRequirements(previewRequirements(operation), availability.value)
    if (missing.length > 0) {
      const failure: WorkspaceFailure = {
        code: 'CAPABILITY_UNAVAILABLE',
        message: `the operation cannot run on this composition: ${missing.join(', ')}`,
        retryable: false,
        details: { operation, missing },
      }
      return { ok: false, error: failure, audit: this.auditWriteRefusal(meta, operation, failure.code, `missing=${missing.join('+')}`) }
    }

    const build = await this.buildPreview(parsed.value, availability.value)
    if (!build.ok) {
      return {
        ok: false,
        error: build.failure,
        audit: this.auditWriteRefusal(meta, operation, build.failure.code, 'preview re-run failed'),
      }
    }
    const preview = this.finishPreview(build.value, meta)
    const notExecutable = preview.items.filter((item) => item.status === 'invalid' || item.status === 'unavailable')
    if (notExecutable.length > 0) {
      const first = notExecutable[0]!
      const code: WorkspaceErrorCode = first.code ?? 'CAPABILITY_UNAVAILABLE'
      const failure: WorkspaceFailure = {
        code,
        message: `the batch contains ${notExecutable.length} object(s) that cannot be attempted; nothing was executed`,
        retryable: false,
        details: {
          operation,
          items: notExecutable.map((item) => ({ objectId: item.objectId, status: item.status, code: item.code, reason: item.reason })),
        },
      }
      return { ok: false, error: failure, audit: this.auditWriteRefusal(meta, operation, code, 'batch not executable') }
    }
    if (preview.previewHash !== previewHash) {
      const failure: WorkspaceFailure = {
        code: 'PREVIEW_STALE',
        message: 'the workspace/Session state changed since this preview was produced; re-read the preview before committing',
        retryable: true,
        details: { operation, expected: previewHash, current: preview.previewHash },
      }
      return { ok: false, error: failure, audit: this.auditWriteRefusal(meta, operation, failure.code, 'preview stale') }
    }

    return ok(await this.executeBatch(preview, build.value, meta))
  }

  private async parseBatchRequest(
    request: Record<string, unknown>,
  ): Promise<{ ok: true; value: PreviewInput } | { ok: false; failure: WorkspaceFailure }> {
    const operation = parseOperation(request.operation)
    if (!operation.ok) return operation
    const targets = parseTargets(request.targets)
    if (!targets.ok) return targets
    const rule = OPERATION_TARGET_RULE[operation.operation]
    if (targets.targets.length < rule.min || targets.targets.length > rule.max) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_REQUEST',
          message: `${operation.operation} takes ${rule.min === rule.max ? rule.min : `${rule.min}-${rule.max}`} ${rule.label}`,
          retryable: false,
          details: { field: 'targets', operation: operation.operation, min: rule.min, max: rule.max },
        },
      }
    }
    const options = parseOptions(request.options, operation.operation)
    if (!options.ok) return options
    return {
      ok: true,
      value: { operation: operation.operation, targets: targets.targets, options: options.options, deduplicated: targets.deduplicated },
    }
  }

  /* ── read: audit trail ──────────────────────────────────────────────── */

  async auditTrail(request: unknown, meta: WorkspaceCallMeta): Promise<WorkspaceResult<AuditTrailValue>> {
    const envelope = validateEnvelope(request, 'auditTrail')
    if (!envelope.ok) return { ok: false, error: envelope.failure, audit: null }
    let limit = 50
    const rawLimit = envelope.request.limit
    if (rawLimit !== undefined && rawLimit !== null) {
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
        return fail('INVALID_REQUEST', 'limit must be an integer between 1 and 200', { field: 'limit' })
      }
      limit = rawLimit
    }
    let entries: WorkspaceAuditRecord[] = []
    let source: AuditTrailValue['source'] = 'memory'
    try {
      entries = this.deps.audit.trail(limit)
      source = (this.deps.audit as { durable?: boolean }).durable === true ? 'ledger' : 'memory'
    } catch {
      entries = []
    }
    return ok({ entries, source, writeModeEnabled: this.gateSnapshot().enabled })
  }

  /* ── preview engine ─────────────────────────────────────────────────── */

  private async buildPreview(
    input: PreviewInput,
    availability: HostAvailability,
  ): Promise<{ ok: true; value: PreviewBuild } | { ok: false; failure: WorkspaceFailure }> {
    const { operation, targets, options } = input
    const warnings = previewWarnings(operation)
    if (input.deduplicated > 0) warnings.push(`已合并 ${input.deduplicated} 个重复目标。`)
    const items: BatchPreviewItem[] = []

    switch (operation) {
      case 'archive':
      case 'unarchive': {
        const domain = await this.loadDomain()
        if (!domain.ok) return { ok: false, failure: domain.failure }
        const archivedSet = new Set(domain.value.catalog.sessions.filter((session) => session.archived).map((session) => session.sessionId))
        for (const ref of targets) {
          const resolved = resolveOne(ref, 'session', domain.value.workspaces, domain.value.catalog)
          if ('code' in resolved) {
            items.push(invalidItem(ref, { code: resolved.code, message: resolved.message }))
            continue
          }
          const session = resolved.session
          const display = session.title ?? session.sessionId
          if (operation === 'archive') {
            if (archivedSet.has(session.sessionId)) {
              items.push(
                makeItem({
                  objectId: resolved.objectId,
                  targetKind: 'session',
                  targetId: session.sessionId,
                  display,
                  status: 'no-op',
                  reason: 'Session is already archived',
                  effects: { ...noneEffects(), archiveEffect: 'archive', clearsPin: true },
                }),
              )
              continue
            }
            const activity = await safeActivity(this.deps.host, session.sessionId)
            if (!activity.ok) {
              items.push(unavailableItem(display === ref ? ref : `${display} (${ref})`, `running-work probe failed: ${activity.error}`))
              continue
            }
            const effects: PreviewEffects = { ...noneEffects(), archiveEffect: 'archive', clearsPin: true }
            const active = activity.value
            if (active.length > 0) {
              items.push(
                makeItem({
                  objectId: resolved.objectId,
                  targetKind: 'session',
                  targetId: session.sessionId,
                  display,
                  status: options.stopActivity ? 'ready' : 'would-partially-fail',
                  code: options.stopActivity ? null : 'TARGET_ACTIVE',
                  reason: options.stopActivity
                    ? 'running work will be stopped first; the stops settle in the background'
                    : 'still running; this object would be refused, so the batch would be partial',
                  effects,
                  activity: active,
                  warnings: ['归档写入后仍在运行的内容需要停止请求；停止会异步落定，不宣称“已全部完成”。'],
                }),
              )
            } else {
              items.push(
                makeItem({
                  objectId: resolved.objectId,
                  targetKind: 'session',
                  targetId: session.sessionId,
                  display,
                  status: 'ready',
                  effects,
                }),
              )
            }
          } else {
            if (!archivedSet.has(session.sessionId)) {
              items.push(
                makeItem({
                  objectId: resolved.objectId,
                  targetKind: 'session',
                  targetId: session.sessionId,
                  display,
                  status: 'no-op',
                  reason: 'Session is not archived',
                  effects: { ...noneEffects(), archiveEffect: 'unarchive' },
                }),
              )
              continue
            }
            items.push(
              makeItem({
                objectId: resolved.objectId,
                targetKind: 'session',
                targetId: session.sessionId,
                display,
                status: 'ready',
                effects: { ...noneEffects(), archiveEffect: 'unarchive' },
              }),
            )
          }
        }
        break
      }

      case 'remove-registration': {
        const domain = await this.loadDomain()
        if (!domain.ok) return { ok: false, failure: domain.failure }
        for (const ref of targets) {
          const resolved = resolveOne(ref, 'workspace', domain.value.workspaces, domain.value.catalog)
          if ('code' in resolved) {
            items.push(invalidItem(ref, { code: resolved.code, message: resolved.message }))
            continue
          }
          const workspace = resolved.workspace
          const itemWarnings: string[] = ['只删除注册记录，不删除磁盘目录与 Session 历史。']
          if (workspace.directoryStatus === 'missing-dir') itemWarnings.push('注册的目录当前不存在；仍可移除注册（不会删除任何内容）。')
          if (workspace.sessionIds.length > 0) itemWarnings.push(`移除后 ${workspace.sessionIds.length} 个 Session 变为未分组，历史保留。`)
          items.push(
            makeItem({
              objectId: resolved.objectId,
              targetKind: 'workspace',
              targetId: workspace.workspaceId,
              targetPath: workspace.path,
              display: workspace.title,
              status: 'ready',
              effects: {
                ...noneEffects(),
                registrationEffect: 'remove',
                becomesUngrouped: workspace.sessionIds.length > 0,
              },
              warnings: itemWarnings,
            }),
          )
        }
        break
      }

      case 'create-registration': {
        const path = targets[0] ?? ''
        const inspection = await this.inspect(path)
        if (!inspection.ok) {
          items.push(unavailableItem(path, inspection.reason))
          break
        }
        const probe = inspection.value
        const effects: PreviewEffects = { ...noneEffects(), registrationEffect: 'create' }
        if (!probe.fullyQualified) {
          items.push(invalidItem(path, { code: 'INVALID_REQUEST', message: 'the path must be fully qualified (absolute)' }))
          break
        }
        if (!probe.exists) {
          items.push(invalidItem(path, { code: 'TARGET_NOT_FOUND', message: 'the directory does not exist; register an existing directory (create-directory is a separate action)' }))
          break
        }
        if (!probe.isDirectory) {
          items.push(invalidItem(path, { code: 'INVALID_REQUEST', message: 'the path is not a directory' }))
          break
        }
        let existing: WorkspaceRecord | null = null
        try {
          existing = await this.deps.host.resolveWorkspaceByPath(path)
        } catch (error) {
          items.push(unavailableItem(path, `registry path lookup failed: ${errorText(error)}`))
          break
        }
        if (existing !== null) {
          items.push(
            makeItem({
              objectId: workspaceObjectId(existing.workspaceId),
              targetKind: 'directory',
              targetId: existing.workspaceId,
              targetPath: existing.path,
              display: existing.title,
              status: 'no-op',
              reason: 'this directory is already registered as a Workspace',
              effects,
            }),
          )
          break
        }
        items.push(
          makeItem({
            objectId: null,
            targetKind: 'directory',
            targetPath: path,
            display: path,
            status: 'ready',
            effects,
          }),
        )
        break
      }

      case 'rename': {
        const domain = await this.loadDomain()
        if (!domain.ok) return { ok: false, failure: domain.failure }
        const ref = targets[0] ?? ''
        const resolved = resolveOne(ref, 'workspace', domain.value.workspaces, domain.value.catalog)
        if ('code' in resolved) {
          items.push(invalidItem(ref, { code: resolved.code, message: resolved.message }))
          break
        }
        const workspace = resolved.workspace
        const title = options.title ?? ''
        const effects: PreviewEffects = { ...noneEffects(), registrationEffect: 'rename' }
        if (title === workspace.title) {
          items.push(
            makeItem({
              objectId: resolved.objectId,
              targetKind: 'workspace',
              targetId: workspace.workspaceId,
              targetPath: workspace.path,
              display: workspace.title,
              status: 'no-op',
              reason: 'the Workspace already carries this title',
              effects,
            }),
          )
          break
        }
        const conflict = domain.value.workspaces.find((entry) => entry.workspaceId !== workspace.workspaceId && entry.title === title)
        if (conflict !== undefined) {
          items.push(invalidItem(workspace.title, { code: 'TARGET_CONFLICT', message: `another Workspace already uses the title ${JSON.stringify(title)}` }))
          break
        }
        items.push(
          makeItem({
            objectId: resolved.objectId,
            targetKind: 'workspace',
            targetId: workspace.workspaceId,
            targetPath: workspace.path,
            display: `${workspace.title} → ${title}`,
            status: 'ready',
            effects,
            warnings: ['只改显示标题；磁盘目录名不改变。'],
          }),
        )
        break
      }

      case 'create-directory': {
        const target = targets[0] ?? ''
        if (!availability.directoryCreate.available) {
          items.push(unavailableItem(target, availability.directoryCreate.reason ?? 'the Host exposes no directory-creation primitive'))
          break
        }
        const inspection = await this.inspect(target)
        if (!inspection.ok) {
          items.push(unavailableItem(target, inspection.reason))
          break
        }
        const probe = inspection.value
        const effects: PreviewEffects = { ...noneEffects(), diskEffect: 'create-directory' }
        if (!probe.fullyQualified) {
          items.push(invalidItem(target, { code: 'INVALID_REQUEST', message: 'the target directory path must be fully qualified (absolute)' }))
          break
        }
        if (probe.exists) {
          items.push(invalidItem(target, { code: 'TARGET_CONFLICT', message: 'the target directory already exists; BOOP never overwrites or merges' }))
          break
        }
        if (!probe.parentExists || !probe.parentIsDirectory) {
          items.push(invalidItem(target, { code: 'INVALID_REQUEST', message: 'the parent directory must already exist; BOOP creates one segment, not a tree' }))
          break
        }
        items.push(
          makeItem({
            objectId: null,
            targetKind: 'directory',
            targetPath: target,
            display: target,
            status: 'ready',
            effects,
            warnings: ['只创建这一个目录；不自动注册工作区。'],
          }),
        )
        break
      }

      default:
        return {
          ok: false,
          failure: { code: 'INVALID_REQUEST', message: `unsupported operation ${String(operation)}`, retryable: false, details: {} },
        }
    }

    return { ok: true, value: { input, items, warnings, writeMode: this.gateSnapshot() } }
  }

  private async inspect(path: string): Promise<{ ok: true; value: PathInspection } | { ok: false; reason: string }> {
    try {
      return { ok: true, value: await this.deps.host.inspectPath(path) }
    } catch (error) {
      return { ok: false, reason: `path inspection failed: ${errorText(error)}` }
    }
  }

  private finishPreview(build: PreviewBuild, meta: WorkspaceCallMeta): BatchPreview {
    const { input, items } = build
    const canonical = {
      schemaVersion: 1,
      operation: input.operation,
      request: { targets: input.targets, options: input.options },
      items: items.map((item) => ({
        objectId: item.objectId,
        targetKind: item.targetKind,
        targetId: item.targetId,
        targetPath: item.targetPath,
        display: item.display,
        status: item.status,
        code: item.code,
        effects: item.effects,
        activity: item.activity.map((family) => ({ kind: family.kind, ids: family.items.map((entry) => entry.id) })),
      })),
    }
    const previewHash = sha256Hex(stableStringify(canonical))
    const summary: BatchPreviewSummary = {
      total: items.length,
      ready: items.filter((item) => item.status === 'ready').length,
      noOp: items.filter((item) => item.status === 'no-op').length,
      wouldPartiallyFail: items.filter((item) => item.status === 'would-partially-fail').length,
      unavailable: items.filter((item) => item.status === 'unavailable').length,
      invalid: items.filter((item) => item.status === 'invalid').length,
      activeWork: items.reduce((total, item) => total + item.activity.length, 0),
    }
    const feasible = items.every((item) => item.status === 'ready' || item.status === 'no-op' || item.status === 'would-partially-fail')
    return {
      operation: input.operation,
      caller: meta.caller,
      previewId: `preview-${previewHash.slice(0, 16)}`,
      previewHash,
      generatedAt: this.now(),
      feasible,
      executed: false,
      requiresApproval: true,
      deletesDisk: false,
      deletesSessions: false,
      items,
      summary,
      warnings: build.warnings,
      writeMode: build.writeMode,
    }
  }

  /* ── commit engine ──────────────────────────────────────────────────── */

  private async executeBatch(preview: BatchPreview, build: PreviewBuild, meta: WorkspaceCallMeta): Promise<BatchCommitValue> {
    const mutations = this.deps.mutations
    if (mutations === null) throw new Error('workspace commit reached execution without a mutation seam')
    const auditIds: string[] = []
    const outcomes: CommitItemOutcome[] = []
    for (const item of preview.items) {
      const outcome = await this.executeItem(mutations, build.input, item)
      outcomes.push(outcome)
      const auditId = this.audit({
        kind: `workspace/${build.input.operation}`,
        objectId: item.objectId,
        actor: meta.caller,
        reason: `${this.brief(meta)} ${outcome.status}${outcome.noOp ? ' no-op' : ''}${outcome.code === null ? '' : ` ${outcome.code}`}`,
      })
      if (auditId.auditId !== null) auditIds.push(auditId.auditId)
    }
    const summary = {
      total: outcomes.length,
      succeeded: outcomes.filter((entry) => entry.status === 'succeeded').length,
      refused: outcomes.filter((entry) => entry.status === 'refused').length,
      failed: outcomes.filter((entry) => entry.status === 'failed').length,
      unknown: outcomes.filter((entry) => entry.status === 'unknown').length,
      noOp: outcomes.filter((entry) => entry.noOp).length,
    }
    const batchAudit = this.audit({
      kind: 'workspace/batch',
      objectId: build.input.operation,
      actor: meta.caller,
      reason: `${this.brief(meta)} total=${summary.total} succeeded=${summary.succeeded} refused=${summary.refused} failed=${summary.failed} unknown=${summary.unknown} noOp=${summary.noOp}`,
    })
    if (batchAudit.auditId !== null) auditIds.push(batchAudit.auditId)
    const notes: string[] = []
    if (build.input.operation === 'archive') {
      notes.push('归档结果按对象逐项给出；仍在运行的对象可能被拒绝，部分成功不宣称全部成功。')
      if (build.input.options.stopActivity) notes.push('已请求停止仍在运行的内容；停止异步落定，未确认前不宣称已停止。')
    }
    if (build.input.operation === 'remove-registration') {
      notes.push('只移除注册记录；磁盘目录与 Session 历史未被删除。')
    }
    if (build.input.operation === 'create-directory') {
      notes.push('只创建目录；未自动注册工作区。')
    }
    const gate = this.gateSnapshot()
    return {
      operation: build.input.operation,
      caller: meta.caller,
      previewHash: preview.previewHash,
      executed: true,
      items: outcomes,
      summary,
      claimedComplete: outcomes.length > 0 && outcomes.every((entry) => entry.status === 'succeeded'),
      atomic: false,
      notes,
      auditIds,
      writeMode: { enabled: true, blockedByGates: gate.blockedByGates },
    }
  }

  private async executeItem(
    mutations: WorkspaceMutationPort,
    input: PreviewInput,
    item: BatchPreviewItem,
  ): Promise<CommitItemOutcome> {
    const base: CommitItemOutcome = {
      objectId: item.objectId,
      targetKind: item.targetKind,
      targetId: item.targetId,
      status: 'succeeded',
      noOp: false,
      code: null,
      message: null,
      activity: item.activity,
      retryable: false,
    }
    if (item.status === 'no-op') return { ...base, noOp: true, message: item.reason ?? 'no change needed' }
    if (item.status === 'invalid' || item.status === 'unavailable') {
      return {
        ...base,
        status: 'failed',
        code: item.code ?? 'INVALID_REQUEST',
        message: item.reason ?? 'the object cannot be attempted',
      }
    }
    try {
      switch (input.operation) {
        case 'archive': {
          if (item.targetId === null) throw new Error('archive item has no Session id')
          await mutations.archiveSession(item.targetId, { stopActivity: input.options.stopActivity })
          return {
            ...base,
            message: input.options.stopActivity
              ? 'archive written; stop requests issued and settle in the background'
              : 'Session archived',
          }
        }
        case 'unarchive': {
          if (item.targetId === null) throw new Error('unarchive item has no Session id')
          await mutations.unarchiveSession(item.targetId)
          return { ...base, message: 'Session restored from the archive set' }
        }
        case 'remove-registration': {
          if (item.targetId === null) throw new Error('remove-registration item has no Workspace id')
          const deleted = await mutations.removeRegistration(item.targetId)
          if (!deleted) {
            return { ...base, status: 'failed', code: 'TARGET_NOT_FOUND', message: 'the registration was already unknown' }
          }
          return { ...base, message: 'registration removed; directory and Session histories untouched' }
        }
        case 'create-registration': {
          if (item.targetPath === null) throw new Error('create-registration item has no path')
          const result = await mutations.registerWorkspace(item.targetPath)
          return { ...base, objectId: workspaceObjectId(result.workspaceId), targetId: result.workspaceId, noOp: !result.created, message: result.created ? 'Workspace registered' : 'Workspace was already registered' }
        }
        case 'rename': {
          if (item.targetId === null || input.options.title === null) throw new Error('rename item is incomplete')
          await mutations.renameWorkspace(item.targetId, input.options.title)
          return { ...base, message: `Workspace title renamed to ${JSON.stringify(input.options.title)} (directory name unchanged)` }
        }
        case 'create-directory': {
          if (item.targetPath === null) throw new Error('create-directory item has no path')
          const created = await mutations.createDirectory(item.targetPath)
          return { ...base, message: `directory created at ${created}; no workspace registration was created` }
        }
        default:
          return { ...base, status: 'failed', code: 'INVALID_REQUEST', message: `unsupported operation ${String(input.operation)}` }
      }
    } catch (error) {
      const classified = classifyMutationError(error, item.activity)
      return {
        ...base,
        status: classified.status,
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
      }
    }
  }
}
