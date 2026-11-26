/**
 * BOOP main-Session navigation policy (E04-01 batch 2 — FE-02/FE-05).
 *
 * The BOOP fixed entry never owns a chat editor: it locates (or creates) exactly
 * ONE native DSH Session and opens it through the native Conversation
 * (`ctx.uiWorkspace.openSession`, which retains the Session, returns the main
 * area to Conversation and keeps the native draft/scroll behaviour).
 *
 * Identity rules:
 *  - the durable identity lives in BOOP's own host ledger (`boop/mainSession`);
 *    the host endpoint is idempotent and read-mostly;
 *  - when the host plane is unavailable, a fixed fallback id is used and the
 *    state is reported as degraded — never as a bound identity;
 *  - a repeated click locates the SAME id from the client Session catalog before
 *    asking the Host to create anything (FE-02: 重复点击只定位同一主会话);
 *  - if the Host ever mints a different Session for the named identity (the
 *    named Session had already started), both ids are reported; the next click
 *    opens the exact Session this browser actually uses instead of minting a
 *    third one, and the conflict is surfaced honestly.
 *
 * This module is intentionally plain TypeScript (no React) so the policy can be
 * unit-rendered in jsdom through a Node test bundle.
 */

/** Fallback id used only when the host identity plane cannot answer. */
export const MAIN_SESSION_ID = 'boop-main'
/** Agent preset id from `presets/boop.patch.yml`. Ordinary Sessions keep the user's default. */
export const BOOP_AGENT_PRESET_ID = 'boop'
/** Client-side cache of the last resolved identity (decoration hint only). */
export const MAIN_SESSION_STORAGE_KEY = 'dsh.boop.mainSessionId'

export interface BoopRpcError {
  code?: string
  message?: string
}

export interface BoopRpcResult {
  ok: boolean
  value?: unknown
  error?: BoopRpcError
}

/** One host call over the authenticated connection (`/api`). */
export type BoopCall = (endpoint: string, args?: Record<string, unknown>) => Promise<BoopRpcResult>

export interface MainSessionHostFacts {
  schemaVersion?: number
  state: 'bound' | 'unavailable'
  mainSessionId: string
  scopeId: string | null
  writable: boolean
  durable: boolean
  reason: string | null
  storage: {
    ok: boolean
    path: string
    scopeId: string
    leaseHeld: boolean
  } | null
  workspacePath?: string | null
  workspaceId?: string | null
}

export interface MainSessionState {
  /** Durable/main identity the host reports (or the fallback before resolution). */
  mainSessionId: string | null
  /** The exact Session this browser opened last; differs on an identity conflict. */
  activeSessionId: string | null
  host: MainSessionHostFacts | null
  phase: 'unknown' | 'resolving' | 'ready' | 'degraded'
  error: string | null
  /** A native Session was minted although the named identity already existed. */
  identityConflict: boolean
}

export interface MainSessionStore {
  getSnapshot(): MainSessionState
  subscribe(listener: () => void): () => void
  set(next: Partial<MainSessionState>): void
}

export function createMainSessionStore(initial?: Partial<MainSessionState>): MainSessionStore {
  let state: MainSessionState = {
    mainSessionId: null,
    activeSessionId: null,
    host: null,
    phase: 'unknown',
    error: null,
    identityConflict: false,
    ...initial,
  }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: Partial<MainSessionState>): void {
      const merged = { ...state, ...next }
      if (
        merged.mainSessionId === state.mainSessionId &&
        merged.activeSessionId === state.activeSessionId &&
        merged.host === state.host &&
        merged.phase === state.phase &&
        merged.error === state.error &&
        merged.identityConflict === state.identityConflict
      ) {
        return
      }
      state = merged
      for (const listener of listeners) listener()
    },
  }
}

/* ── decoration hint cache (never the authority) ───────────────────────── */

export function readCachedMainSessionId(storage?: { getItem(key: string): string | null } | null): string | null {
  try {
    const target = storage ?? globalThis.localStorage
    const value = target?.getItem(MAIN_SESSION_STORAGE_KEY) ?? null
    return typeof value === 'string' && value.trim() !== '' ? value : null
  } catch {
    return null
  }
}

export function writeCachedMainSessionId(
  sessionId: string,
  storage?: { setItem(key: string, value: string): void } | null,
): void {
  try {
    const target = storage ?? globalThis.localStorage
    target?.setItem(MAIN_SESSION_STORAGE_KEY, sessionId)
  } catch {
    /* private mode / no storage: decoration falls back to the resolved store */
  }
}

/* ── identity resolution ──────────────────────────────────────────────── */

export interface ResolveMainSessionDeps {
  call: BoopCall
  store: MainSessionStore
}

export interface ResolveMainSessionOutcome {
  mainSessionId: string
  host: MainSessionHostFacts | null
  /** true when the host plane could not confirm a durable identity. */
  degraded: boolean
  error: string | null
}

function normalizeHostFacts(value: unknown): MainSessionHostFacts | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const mainSessionId = typeof record.mainSessionId === 'string' ? record.mainSessionId.trim() : ''
  if (mainSessionId === '') return null
  const storage = record.storage && typeof record.storage === 'object' ? (record.storage as Record<string, unknown>) : null
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : undefined,
    state: record.state === 'bound' ? 'bound' : 'unavailable',
    mainSessionId,
    scopeId: typeof record.scopeId === 'string' ? record.scopeId : null,
    writable: record.writable === true,
    durable: record.durable === true,
    reason: typeof record.reason === 'string' ? record.reason : null,
    storage: storage
      ? {
          ok: storage.ok === true,
          path: typeof storage.path === 'string' ? storage.path : '',
          scopeId: typeof storage.scopeId === 'string' ? storage.scopeId : '',
          leaseHeld: storage.leaseHeld === true,
        }
      : null,
    workspacePath: typeof record.workspacePath === 'string' && record.workspacePath !== '' ? record.workspacePath : null,
    workspaceId: typeof record.workspaceId === 'string' && record.workspaceId !== '' ? record.workspaceId : null,
  }
}

/**
 * Ask the host for the one durable BOOP main-Session identity and publish it.
 *
 * This is navigation-free: it never creates a Session and never changes the
 * selected panel. Activation uses it so the main-Session decorations (header
 * identity, initialization card) can render on a restored Session page load.
 */
export async function resolveMainSessionIdentity(
  deps: ResolveMainSessionDeps,
): Promise<ResolveMainSessionOutcome> {
  const current = deps.store.getSnapshot()
  const provisional = current.mainSessionId ?? readCachedMainSessionId() ?? MAIN_SESSION_ID
  deps.store.set({ mainSessionId: provisional, phase: 'resolving', error: null })

  let host: MainSessionHostFacts | null = null
  let error: string | null = null
  try {
    const result = await deps.call('boop/mainSession')
    if (result?.ok && result.value !== undefined) host = normalizeHostFacts(result.value)
    if (!result?.ok) error = result?.error?.message ?? '主会话身份查询失败'
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  const mainSessionId = host?.mainSessionId ?? provisional
  const degraded = host === null || host.state !== 'bound' || host.durable !== true
  deps.store.set({
    mainSessionId,
    host,
    phase: degraded ? 'degraded' : 'ready',
    error: degraded ? (host?.reason ?? error ?? '主会话身份未绑定') : null,
  })
  writeCachedMainSessionId(mainSessionId)
  return { mainSessionId, host, degraded, error }
}

/* ── native Session catalog / open ────────────────────────────────────── */

export interface SessionsListSnapshot {
  ids?: string[]
  byId?: Record<string, unknown>
  phase?: string
}

export interface SessionsLike {
  list?: { getSnapshot?: () => SessionsListSnapshot }
  refresh?: () => Promise<unknown>
  create?: (request: { sessionId?: string; cwd?: string; workspaceId?: string; agentPreset?: string }) => Promise<unknown>
}

export interface UiWorkspaceLike {
  openSession?: (sessionId: string) => void
}

export interface OpenMainSessionDeps {
  call: BoopCall
  store: MainSessionStore
  sessions: SessionsLike | null | undefined
  uiWorkspace: UiWorkspaceLike | null | undefined
  /** Bounded wait for the client catalog refresh (default 2500ms). */
  catalogWaitMs?: number
  /**
   * Switch a still-blank Session onto the BOOP preset. Started Sessions are
   * locked by the host (`agent-preset/locked`); failures are ignored.
   */
  selectAgentPreset?: (sessionId: string, presetId: string) => Promise<unknown>
}

export type OpenMainSessionOutcome =
  | {
      ok: true
      sessionId: string
      mainSessionId: string
      created: boolean
      identityConflict: boolean
      degraded: boolean
      host: MainSessionHostFacts | null
    }
  | {
      ok: false
      reason: 'sessions-unavailable' | 'session-create-failed' | 'navigation-unavailable' | 'open-failed'
      message: string
      mainSessionId: string
    }

function catalogHas(sessions: SessionsLike | null | undefined, sessionId: string): boolean {
  try {
    const snapshot = sessions?.list?.getSnapshot?.()
    if (!snapshot) return false
    if (snapshot.byId && Object.prototype.hasOwnProperty.call(snapshot.byId, sessionId)) return true
    return Array.isArray(snapshot.ids) && snapshot.ids.includes(sessionId)
  } catch {
    return false
  }
}

async function refreshCatalog(sessions: SessionsLike | null | undefined, waitMs: number): Promise<void> {
  if (typeof sessions?.refresh !== 'function') return
  if (waitMs <= 0) {
    try {
      await sessions.refresh()
    } catch {
      /* an offline refresh leaves the cached catalog in charge */
    }
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(sessions.refresh()).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeDir(value: string): string {
  return value.replace(/[\\/]+$/g, '').replace(/\\/g, '/').toLowerCase()
}

function sameDir(left: string | null, right: string | null): boolean {
  if (!left || !right) return false
  return normalizeDir(left) === normalizeDir(right)
}

function summaryOf(sessions: SessionsLike | null | undefined, sessionId: string): { cwd: string | null; blank: boolean | null } | null {
  if (!catalogHas(sessions, sessionId)) return null
  try {
    const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
    if (!row || typeof row !== 'object') return { cwd: null, blank: null }
    const record = row as Record<string, unknown>
    const cwd = typeof record.cwd === 'string' && record.cwd.trim() !== '' ? record.cwd : null
    const blank = record.blank === true ? true : record.blank === false ? false : null
    return { cwd, blank }
  } catch {
    return { cwd: null, blank: null }
  }
}

function findPlacedSession(
  sessions: SessionsLike | null | undefined,
  workspacePath: string,
  prefer: string | null,
): string | null {
  try {
    const snapshot = sessions?.list?.getSnapshot?.()
    if (!snapshot) return null
    const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId ?? {})
    const matches = ids.filter((id) => {
      const row = snapshot.byId?.[id]
      const cwd = row && typeof row === 'object' && typeof (row as { cwd?: unknown }).cwd === 'string'
        ? (row as { cwd: string }).cwd
        : null
      return sameDir(cwd, workspacePath)
    })
    if (prefer && matches.includes(prefer)) return prefer
    return matches[0] ?? null
  } catch {
    return null
  }
}

function withBoopPreset<T extends Record<string, unknown>>(request: T): T & { agentPreset: string } {
  return { ...request, agentPreset: BOOP_AGENT_PRESET_ID }
}

function listedAgentPreset(sessions: SessionsLike | null | undefined, sessionId: string): string | null {
  try {
    const row = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
    if (!row || typeof row !== 'object') return null
    const values = (row as { projectionValues?: { agentPreset?: unknown } }).projectionValues
    return typeof values?.agentPreset === 'string' && values.agentPreset !== '' ? values.agentPreset : null
  } catch {
    return null
  }
}

async function ensureBoopAgentPreset(deps: OpenMainSessionDeps, sessionId: string): Promise<void> {
  if (typeof deps.selectAgentPreset !== 'function') return
  if (listedAgentPreset(deps.sessions, sessionId) === BOOP_AGENT_PRESET_ID) return
  try {
    await deps.selectAgentPreset(sessionId, BOOP_AGENT_PRESET_ID)
  } catch {
    /* locked after the first turn; AGENTS.md still overlays the voice contract */
  }
}

function createMainRequest(mainSessionId: string, workspacePath: string | null, reuseNamed: boolean): Record<string, unknown> {
  const request: Record<string, unknown> = {}
  if (reuseNamed) request.sessionId = mainSessionId
  if (workspacePath) request.cwd = workspacePath
  return withBoopPreset(request)
}

function createdSessionId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  for (const key of ['sessionId', 'id'] as const) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  if (typeof record.value === 'string' && record.value.trim() !== '') return record.value.trim()
  if (record.value && typeof record.value === 'object') {
    const nested = record.value as Record<string, unknown>
    if (typeof nested.sessionId === 'string' && nested.sessionId.trim() !== '') return nested.sessionId.trim()
  }
  return null
}

/**
 * Locate or create the ONE BOOP main Session, then open it in the native
 * Conversation. Repeated clicks resolve to the same Session (FE-02); the native
 * Session keeps its own draft and scroll state across the navigation (FE-05).
 */
export async function openMainSession(deps: OpenMainSessionDeps): Promise<OpenMainSessionOutcome> {
  const resolution = await resolveMainSessionIdentity({ call: deps.call, store: deps.store })
  let mainSessionId = resolution.mainSessionId
  const state = deps.store.getSnapshot()
  const workspacePath = typeof state.host?.workspacePath === 'string' && state.host.workspacePath !== '' ? state.host.workspacePath : null

  let sessionId: string | null = null
  let created = false
  let identityConflict = false

  const keepNamed = (summary: { cwd: string | null; blank: boolean | null } | null): boolean => {
    if (!summary) return false
    if (!workspacePath) return true
    if (sameDir(summary.cwd, workspacePath)) return true
    // A blank Session whose directory is the desktop profile, or any other
    // project, is not BOOP's workspace. Leave it and open one created inside
    // the BOOP directory. A Session that already has history stays.
    return summary.blank === false
  }

  if (keepNamed(summaryOf(deps.sessions, mainSessionId))) {
    sessionId = mainSessionId
  } else if (!catalogHas(deps.sessions, mainSessionId)) {
    // The cached catalog may lag a Session created in another tab: refresh once
    // before asking the Host to create anything, so repeat clicks cannot mint
    // a second main Session.
    await refreshCatalog(deps.sessions, deps.catalogWaitMs ?? 2500)
    if (keepNamed(summaryOf(deps.sessions, mainSessionId))) {
      sessionId = mainSessionId
    } else if (catalogHas(deps.sessions, mainSessionId)) {
      sessionId = null
    } else if (state.activeSessionId !== null && catalogHas(deps.sessions, state.activeSessionId) && (!workspacePath || sameDir(summaryOf(deps.sessions, state.activeSessionId)?.cwd ?? null, workspacePath) || state.identityConflict)) {
      // This browser already opened the Session the Host minted for the conflict.
      sessionId = state.activeSessionId
      identityConflict = state.identityConflict
    } else if (state.identityConflict && state.activeSessionId !== null) {
      sessionId = state.activeSessionId
      identityConflict = true
    } else if (!workspacePath) {
      if (typeof deps.sessions?.create !== 'function') {
        return {
          ok: false,
          reason: 'sessions-unavailable',
          message: '客户端会话服务不可用，无法创建 BOOP 主会话。',
          mainSessionId,
        }
      }
      try {
        const createdId = createdSessionId(await deps.sessions.create(createMainRequest(mainSessionId, null, true)))
        if (createdId === null) {
          return {
            ok: false,
            reason: 'session-create-failed',
            message: '宿主没有返回 BOOP 主会话标识。',
            mainSessionId,
          }
        }
        sessionId = createdId
        created = true
        if (createdId !== mainSessionId) {
          // The named identity already had started: the Host minted a new one.
          identityConflict = true
          deps.store.set({ activeSessionId: createdId, identityConflict: true, phase: 'degraded', error: 'main-session-identity-conflict' })
          writeCachedMainSessionId(createdId)
        }
      } catch (error) {
        return { ok: false, reason: 'session-create-failed', message: messageOf(error), mainSessionId }
      }
    }
  }

  // The named Session is blank and its directory is not the BOOP workspace.
  // The host freezes cwd at creation, so open a Session created inside the
  // BOOP directory. Do not pass the existing id: that call is refused.
  if (sessionId === null && workspacePath) {
    const placed = findPlacedSession(deps.sessions, workspacePath, state.activeSessionId)
    if (placed) {
      sessionId = placed
    } else if (typeof deps.sessions?.create !== 'function') {
      return {
        ok: false,
        reason: 'sessions-unavailable',
        message: '客户端会话服务不可用，无法创建 BOOP 主会话。',
        mainSessionId,
      }
    } else {
      try {
        const minted = createdSessionId(await deps.sessions.create(
          createMainRequest(mainSessionId, workspacePath, !catalogHas(deps.sessions, mainSessionId)),
        ))
        if (minted === null) {
          return {
            ok: false,
            reason: 'session-create-failed',
            message: '宿主没有返回 BOOP 主会话标识。',
            mainSessionId,
          }
        }
        sessionId = minted
        created = true
      } catch (error) {
        return { ok: false, reason: 'session-create-failed', message: messageOf(error), mainSessionId }
      }
    }
  }

  if (sessionId === null) {
    return { ok: false, reason: 'sessions-unavailable', message: '无法定位 BOOP 主会话。', mainSessionId }
  }
  if (workspacePath && sessionId !== mainSessionId) {
    try {
      const adopted = await deps.call('boop/adoptPlacedMainSession', { sessionId })
      const adoptedId = adopted?.ok && adopted.value && typeof adopted.value === 'object'
        ? (adopted.value as { mainSessionId?: unknown }).mainSessionId
        : null
      if (typeof adoptedId === 'string' && adoptedId !== '') mainSessionId = adoptedId
    } catch {
      /* the placed Session still opens; the ledger keeps the previous id */
    }
  }
  await ensureBoopAgentPreset(deps, sessionId)
  if (typeof deps.uiWorkspace?.openSession !== 'function') {
    return {
      ok: false,
      reason: 'navigation-unavailable',
      message: '原生会话导航不可用，无法打开 BOOP 主会话。',
      mainSessionId,
    }
  }
  try {
    // The native navigation retains the Session, returns the main area to the
    // Conversation and keeps the native composer draft; BOOP adds no editor.
    deps.uiWorkspace.openSession(sessionId)
  } catch (error) {
    return { ok: false, reason: 'open-failed', message: messageOf(error), mainSessionId }
  }

  const shownMainId = sessionId === resolution.mainSessionId ? mainSessionId : sessionId
  deps.store.set({
    mainSessionId: shownMainId,
    activeSessionId: sessionId,
    phase: resolution.degraded || identityConflict ? 'degraded' : 'ready',
    identityConflict,
    error: identityConflict ? 'main-session-identity-conflict' : resolution.error,
  })
  writeCachedMainSessionId(shownMainId)

  return {
    ok: true,
    sessionId,
    mainSessionId: shownMainId,
    created,
    identityConflict,
    degraded: resolution.degraded,
    host: resolution.host,
  }
}

/** True only for the exact BOOP main Session — ordinary Sessions render nothing. */
export function isMainSession(mainSessionId: string | null | undefined, sessionId: string | null | undefined): boolean {
  return typeof mainSessionId === 'string' && mainSessionId !== '' && mainSessionId === sessionId
}

/** Honest one-line status for the main-Session header chip. */
export function mainSessionStatusLine(state: MainSessionState): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (state.phase === 'resolving' || state.phase === 'unknown') return { tone: 'warn', text: '正在连接' }
  if (state.identityConflict) return { tone: 'bad', text: '主会话身份冲突' }
  if (state.host === null) return { tone: 'warn', text: '数据域不可用' }
  if (state.host.state === 'bound' && state.host.durable) return { tone: 'ok', text: '已连接' }
  if (state.host.reason === 'ledger-unavailable') return { tone: 'warn', text: '数据域不可用' }
  return { tone: 'warn', text: '身份未持久绑定' }
}

/** Human hint for the reason codes the host identity plane can return. */
export function mainSessionReasonText(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null
    case 'ledger-unavailable':
      return 'BOOP 记忆账本不可用；主聊天仍可用，但身份没有持久绑定。'
    case 'read-only-ledger':
      return '另一个 BOOP 进程正在管理数据域；本次身份只能只读使用。'
    case 'bind-failed':
      return '主会话身份写入失败；重试后仍会定位同一个会话。'
    case 'ledger-read-failed':
      return '账本身份读取失败；没有当作成功处理。'
    default:
      return reason
  }
}
