/**
 * BOOP main-Session identity and read-only interaction facts (E04-01, batch 2).
 *
 * Design rules this module implements (04§02–05, 04§09):
 *  - the BOOP main chat IS a native DSH Session; BOOP only owns its identity
 *    (`scopes.main_session_id`, durable per data domain) and its local
 *    decorations. No second chat surface, no write dispatch from this path;
 *  - the identity endpoint is idempotent and read-mostly: it binds exactly once,
 *    then only reads. It never creates the DSH Session itself — the browser
 *    creates it through the native `session/create` surface so the normal Agent
 *    lifecycle (persistence, preset, history) stays the Host's own;
 *  - Sources/project facts are read straight from BOOP's ledger cursors and the
 *    read-only Session query plane. An unavailable plane is reported as such —
 *    never as an empty list (FE-11: 断线不是空任务列表);
 *  - the three E03-03 initialization modes are not wired into the Host runtime
 *    yet. The endpoint returns the REAL reason and the real evidence and says
 *    `available: false`; it never fake-succeeds (03§14, G05/G06 still NOT_RUN).
 */

/** The stable BOOP main-Session identity. One per data domain; never a title guess. */
export const MAIN_SESSION_ID = 'boop-main'

/** E03-03 initialization modes (frozen copy). */
export const INIT_MODES = ['from_now', 'learn_history', 'import_memory'] as const
export type InitMode = (typeof INIT_MODES)[number]

export const INIT_MODE_LABELS: Readonly<Record<InitMode, string>> = {
  from_now: '从现在开始',
  learn_history: '学习已有会话',
  import_memory: '导入记忆',
}

export type InitModePlanState = 'available' | 'unavailable'

export interface MainSessionFacts {
  schemaVersion: 1
  /**
   * `bound` — the durable ledger binding exists (or was created by this call).
   * `unavailable` — no writable ledger; the fallback identity is reported but is
   * NOT durable, and the UI must say so instead of claiming a bound identity.
   */
  state: 'bound' | 'unavailable'
  /** The exact Session id the native Conversation must open. */
  mainSessionId: string
  scopeId: string | null
  /** This Host currently owns BOOP's single-writer lease. */
  writable: boolean
  durable: boolean
  reason: string | null
  /** Diagnostic only; never a business fact. */
  detail: string | null
  storage: {
    ok: boolean
    path: string
    scopeId: string
    leaseHeld: boolean
  } | null
}

export type SourceCoverage = 'full' | 'behind' | 'unseen' | 'unverified' | 'processing' | 'gap' | 'excluded'
export type SourceCursorState = 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded' | 'unseen'

export interface SourceRowFacts {
  sessionId: string
  title: string | null
  /** Content generation of the Session; changes on fork/compaction/restore. */
  sourceGeneration: string
  /** Latest seq of the Session when it could be read; null = not read in this snapshot. */
  headSeq: number | null
  /** Highest seq BOOP has durably read for THIS generation; null = never read. */
  throughSeq: number | null
  state: SourceCursorState
  coverage: SourceCoverage
}

export interface SourcesFacts {
  schemaVersion: 1
  /** false means "cannot read", which is NOT the same as "no sources". */
  available: boolean
  reason: string | null
  detail: string | null
  scopeId: string | null
  /** Sessions the read-only query plane currently sees. */
  discovered: number
  /** Cursor rows BOOP's ledger actually holds (all generations). */
  known: number
  /** Cursor rows whose source generation is no longer the current one. */
  staleGenerations: number
  sources: SourceRowFacts[]
}

export interface InitPlanFacts {
  schemaVersion: 1
  mode: InitMode
  label: string
  state: InitModePlanState
  /** False unless this call actually wrote the ledger. */
  executed: boolean
  reason: string
  copy: string
  writeModeEnabled: boolean
  gates: Record<string, string>
  storage: { ok: boolean; path: string; scopeId: string; writable: boolean } | null
  sources: { discovered: number; known: number; fresh: number; dirty: number; gap: number; excluded: number } | null
  /** Frozen progress copy semantics: processed/total per object, no fake percent. */
  processed: number
  total: number | null
}

interface CursorRow {
  sessionId: string
  sourceGeneration: string
  throughSeq: number
  state: string
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cursorRows(storage: any, scopeId: string): CursorRow[] {
  try {
    const rows = storage?.repo?.cursors?.(scopeId)
    return Array.isArray(rows) ? (rows as CursorRow[]) : []
  } catch {
    return []
  }
}

/**
 * Read (and on a writable first use, durably bind) the BOOP main-Session id.
 *
 * Idempotent: repeat calls return the same id and perform no further writes.
 */
export function mainSessionFacts(ctx: any): MainSessionFacts {
  const state = ctx.boop.state()
  const storage = ctx.boop.storage()
  const storageFacts = state.storage
  const scopeId: string | null =
    storage?.identity?.scopeId ?? storageFacts?.scope?.scopeId ?? null
  const writable = storageFacts?.ok === true

  const base: MainSessionFacts = {
    schemaVersion: 1,
    state: 'unavailable',
    mainSessionId: MAIN_SESSION_ID,
    scopeId,
    writable,
    durable: false,
    reason: 'ledger-unavailable',
    detail: null,
    storage: storageFacts
      ? {
          ok: storageFacts.ok === true,
          path: String(storageFacts.path ?? ''),
          scopeId: String(storageFacts.scope?.scopeId ?? ''),
          leaseHeld: storageFacts.lease?.held === true,
        }
      : null,
  }

  if (!storage || !scopeId) return base

  try {
    let scope = storage.repo.getScope(scopeId)
    if (scope?.mainSessionId) {
      return {
        ...base,
        state: 'bound',
        mainSessionId: String(scope.mainSessionId),
        durable: true,
        reason: null,
      }
    }
    if (!writable) {
      // The identity is not durable yet. Say so; the browser may still open the
      // fallback id, but the UI must not present it as a bound identity.
      return { ...base, reason: 'read-only-ledger' }
    }
    try {
      const bound = storage.repo.bindMainSession(scopeId, MAIN_SESSION_ID)
      return {
        ...base,
        state: 'bound',
        mainSessionId: String(bound?.mainSessionId ?? MAIN_SESSION_ID),
        durable: true,
        reason: null,
      }
    } catch (error) {
      // Another writer won the race (or a different id is already bound): the
      // ledger is authoritative, so report its value instead of inventing one.
      scope = storage.repo.getScope(scopeId)
      if (scope?.mainSessionId) {
        return {
          ...base,
          state: 'bound',
          mainSessionId: String(scope.mainSessionId),
          durable: true,
          reason: null,
        }
      }
      return { ...base, reason: 'bind-failed', storage: base.storage }
    }
  } catch (error) {
    return { ...base, reason: 'ledger-read-failed', detail: detailOf(error) }
  }
}

/**
 * Read-only projection of the Source coverage BOOP's ledger actually holds.
 *
 * The corpus listing comes from `ctx.sessionQuery.listSessions()` (live-preferred
 * records over persisted headers — no Agent is created, no Session is woken).
 * Head seq is only resolved for the main Session and for sources BOOP has a
 * cursor on, so a plain snapshot never loads every Session log. Anything the
 * plane cannot answer is reported as unavailable, never as an empty list.
 */
export async function sourcesFacts(ctx: any): Promise<SourcesFacts> {
  const storage = ctx.boop.storage()
  const scopeId: string | null = storage?.identity?.scopeId ?? null
  const blank: SourcesFacts = {
    schemaVersion: 1,
    available: false,
    reason: 'ledger-unavailable',
    detail: null,
    scopeId,
    discovered: 0,
    known: 0,
    staleGenerations: 0,
    sources: [],
  }
  if (!storage || !scopeId) return blank

  const query = sessionQueryOf(ctx)
  if (query === null) return { ...blank, reason: 'source-reader-unavailable' }

  let records: SessionQueryRecord[]
  try {
    records = await query.listSessions()
  } catch (error) {
    return { ...blank, reason: 'source-read-failed', detail: detailOf(error) }
  }
  if (!Array.isArray(records)) return { ...blank, reason: 'source-read-failed', detail: 'session query returned no listing' }

  const corpus = records
    .map((record) => {
      const header = record.header ?? {}
      const sessionId = String(header.id ?? '')
      return { sessionId, sourceGeneration: generationOf(sessionId, header), live: record.live === true }
    })
    .filter((record) => record.sessionId !== '')

  const titles = await readTitles(query, corpus.map((record) => record.sessionId))
  const cursors = cursorRows(storage, scopeId)
  const currentKeys = new Set(corpus.map((record) => `${record.sessionId}\u0000${record.sourceGeneration}`))
  const staleGenerations = cursors.filter(
    (cursor) => !currentKeys.has(`${cursor.sessionId}\u0000${cursor.sourceGeneration}`),
  ).length

  // Resolve head seq only where it changes the honest coverage sentence: the
  // BOOP main Session and sources that actually have a read cursor.
  let mainSessionId: string | null = null
  try {
    mainSessionId = storage.repo.getScope(scopeId)?.mainSessionId ?? null
  } catch {
    mainSessionId = null
  }
  const headTargets = new Set<string>()
  for (const record of corpus) {
    if (cursors.some((cursor) => cursor.sessionId === record.sessionId && cursor.sourceGeneration === record.sourceGeneration)) {
      headTargets.add(record.sessionId)
    }
  }
  if (mainSessionId !== null) headTargets.add(mainSessionId)
  const heads = new Map<string, number>()
  let observed = 0
  for (const sessionId of headTargets) {
    if (observed >= 25) break
    observed += 1
    const head = await readHeadSeq(query, sessionId)
    if (head !== null && head >= 0) heads.set(sessionId, head)
  }

  const sources: SourceRowFacts[] = corpus.map((record) => {
    const cursor = cursors.find(
      (row) => row.sessionId === record.sessionId && row.sourceGeneration === record.sourceGeneration,
    )
    const throughSeq = cursor ? Number(cursor.throughSeq) : null
    const state = (cursor?.state as SourceCursorState | undefined) ?? 'unseen'
    const headSeq = heads.has(record.sessionId) ? (heads.get(record.sessionId) as number) : null
    let coverage: SourceCoverage
    if (state === 'excluded') coverage = 'excluded'
    else if (state === 'gap') coverage = 'gap'
    else if (state === 'processing') coverage = 'processing'
    else if (throughSeq === null || throughSeq < 0) coverage = 'unseen'
    else if (headSeq === null) coverage = 'unverified'
    else coverage = throughSeq >= headSeq ? 'full' : 'behind'
    return {
      sessionId: record.sessionId,
      title: titles.get(record.sessionId) ?? null,
      sourceGeneration: record.sourceGeneration,
      headSeq,
      throughSeq,
      state,
      coverage,
    }
  })

  return {
    schemaVersion: 1,
    available: true,
    reason: null,
    detail: null,
    scopeId,
    discovered: corpus.length,
    known: cursors.length,
    staleGenerations,
    sources,
  }
}

/* ── read-only Session query plane adapter ────────────────────────────── */

interface SessionQueryRecord {
  header?: Record<string, unknown>
  live?: boolean
  persisted?: boolean
  formatStatus?: string
}

interface SessionQueryLike {
  listSessions?: () => Promise<SessionQueryRecord[]>
  readTitleSnapshots?: (sessionIds: string[]) => Promise<
    Array<{ sessionId?: string; status?: string; value?: { title?: { title?: string } } }>
  >
  observeSession?: (sessionId: string, options?: { projectionMode?: 'all' | 'none' }) => Promise<{ cursor?: number }>
}

/** The read-only Session query service, or null when this composition has none. */
function sessionQueryOf(ctx: any): SessionQueryLike | null {
  try {
    const direct = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (direct && typeof direct.listSessions === 'function') return direct as SessionQueryLike
  } catch {
    /* fall through to the reflected lookup */
  }
  try {
    const reflected = ctx.reflect?.get?.('sessionQuery', false)
    if (reflected && typeof reflected.listSessions === 'function') return reflected as SessionQueryLike
  } catch {
    /* unavailable below */
  }
  return null
}

function generationOf(sessionId: string, header: Record<string, unknown>): string {
  const version = header.version === undefined ? '' : String(header.version)
  const createdAt = header.createdAt === undefined ? '' : String(header.createdAt)
  return `${sessionId}@${version}:${createdAt}`
}

/** Real log-backed titles, batch-read; optional — a title never fails the plane. */
async function readTitles(query: SessionQueryLike, sessionIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (sessionIds.length === 0 || typeof query.readTitleSnapshots !== 'function') return titles
  try {
    const results = await query.readTitleSnapshots(sessionIds)
    for (const result of results ?? []) {
      if (result?.status !== 'fulfilled') continue
      const title = result.value?.title?.title
      if (typeof result.sessionId === 'string' && typeof title === 'string' && title.trim() !== '') {
        titles.set(result.sessionId, title)
      }
    }
  } catch {
    /* titles are decoration; coverage stays authoritative */
  }
  return titles
}

/** Head seq of one exact Session, read through a disposable observation. */
async function readHeadSeq(query: SessionQueryLike, sessionId: string): Promise<number | null> {
  if (typeof query.observeSession !== 'function') return null
  let observation: unknown
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'none' })
    const cursor = Number((observation as { cursor?: unknown })?.cursor)
    return Number.isFinite(cursor) ? cursor : null
  } catch {
    return null
  } finally {
    try {
      const disposable = observation as { dispose?: () => void; [key: symbol]: unknown } | undefined
      if (typeof disposable?.dispose === 'function') disposable.dispose()
      else {
        const symbolDispose = (Symbol as unknown as { dispose?: symbol }).dispose
        const release = symbolDispose === undefined ? undefined : disposable?.[symbolDispose]
        if (typeof release === 'function') (release as () => void).call(disposable)
      }
    } catch {
      /* releasing one observation must not fail the snapshot */
    }
  }
}


function modeOf(mode: unknown): InitMode {
  if (typeof mode === 'string' && (INIT_MODES as readonly string[]).includes(mode)) return mode as InitMode
  throw new Error(`boop: unknown initialization mode ${JSON.stringify(mode)}`)
}

function initReason(mode: InitMode, hasLedger: boolean, writable: boolean, writeModeEnabled: boolean): string {
  if (!hasLedger) return 'ledger-unavailable'
  if (!writable) return 'read-only-ledger'
  if (!writeModeEnabled) return 'write-mode-disabled'
  if (mode === 'import_memory') return 'import-pipeline-unavailable'
  return 'init-jobs-not-wired'
}

function initCopy(mode: InitMode, reason: string, discovered: number): string {
  if (reason === 'ledger-unavailable') return '记忆账本当前不可用，初始化不能开始。没有写入任何数据。'
  if (reason === 'read-only-ledger') return '另一个 BOOP 进程正在管理数据域，本次只能只读，不会写入任何数据。'
  if (reason === 'write-mode-disabled') return '写模式在 G01–G06 与 G08、G09 通过前保持关闭，初始化不会写入任何数据。'
  if (mode === 'import_memory') return '导入校验/预览流水线尚未接通；本次不会读取任何文件，也没有写入任何数据。'
  if (mode === 'learn_history') {
    return `后台历史整理作业尚未接线；已发现 ${discovered} 个会话，但本次没有读取或写入任何历史。`
  }
  return '后台初始化作业尚未接线；本次没有设置任何读取水位，也没有写入任何数据。'
}

/**
 * What one E03-03 initialization mode would do right now, and why it cannot run.
 *
 * Read-only: no cursor, fact or job row is written. `available` stays false until
 * the E03-03 job store is composed, so the card can never claim a fake PASS.
 */
export async function initPlanFacts(ctx: any, modeInput: unknown): Promise<InitPlanFacts> {
  const mode = modeOf(modeInput)
  const state = ctx.boop.state()
  const storage = ctx.boop.storage()
  const storageFacts = state.storage
  const writable = storageFacts?.ok === true
  const storageOk = Boolean(storage)
  const sources = await sourcesFacts(ctx)
  const discovered = sources.available ? sources.discovered : 0
  const writeModeEnabled = state.writeModeEnabled === true
  const reason = initReason(mode, storageOk, writable, writeModeEnabled)
  const importNeedsPreview = writeModeEnabled && writable && storageOk && mode === 'import_memory'
  const ready = writeModeEnabled && writable && storageOk && mode !== 'import_memory'
  const reportedReason = importNeedsPreview ? 'import-needs-preview' : ready ? 'ready' : reason
  const copy = importNeedsPreview
    ? '导入必须先给出已确认的预览。这一步没有读取任何文件，也没有写入任何数据。'
    : ready
      ? '写模式已打开。确认后才会写入水位或整理作业，这一步还没有执行。'
      : initCopy(mode, reason, discovered)

  return {
    schemaVersion: 1,
    mode,
    label: INIT_MODE_LABELS[mode],
    state: ready ? 'available' : 'unavailable',
    executed: false,
    reason: reportedReason,
    copy,
    writeModeEnabled: writeModeEnabled,
    gates: { ...(state.gates ?? {}) },
    storage: storageFacts
      ? {
          ok: storageFacts.ok === true,
          path: String(storageFacts.path ?? ''),
          scopeId: String(storageFacts.scope?.scopeId ?? ''),
          writable,
        }
      : null,
    sources: sources.available
      ? {
          discovered: sources.discovered,
          known: sources.known,
          fresh: sources.sources.filter((row) => row.state === 'fresh').length,
          dirty: sources.sources.filter((row) => row.state === 'dirty').length,
          gap: sources.sources.filter((row) => row.state === 'gap').length,
          excluded: sources.sources.filter((row) => row.state === 'excluded').length,
        }
      : null,
    processed: 0,
    total: mode === 'learn_history' && sources.available ? sources.discovered : null,
  }
}
