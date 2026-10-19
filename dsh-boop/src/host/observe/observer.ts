/**
 * Whole-domain light observation (E03-01).
 *
 * Frozen rules (03§10, 02§12):
 *  - observation NEVER creates an Agent, never loads a model, and never writes
 *    into the user's Sessions;
 *  - every read is incremental: a durable read watermark (`source_cursor`) per
 *    (scope, session, source generation) records exactly how far BOOP has read;
 *  - a session that advanced past its watermark becomes `dirty`, and only dirty
 *    sources are re-read;
 *  - a source generation change (edit, fork, compaction) never rewrites an old
 *    memory: the old generation's facts stay addressable by their own evidence.
 *
 * The reader is an interface so the logic is testable without the Host, and so
 * the Host binding stays a thin, verified adapter.
 */

export type CursorState = 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded'

export interface SourceRef {
  sessionId: string
  /** Changes when the Session's content generation changes. */
  sourceGeneration: string
  workspaceId: string | null
  title: string | null
  /**
   * Highest durable seq known for this Session, or `null` when this scan did not
   * resolve it. On rc.2.1 the lightweight corpus listing carries only the
   * SessionHeader, so a head seq requires a bounded per-Session read; `null`
   * means "not determined", never "zero".
   */
  headSeq: number | null
}

export interface EventRecord {
  seq: number
  type: string
  time: number
  /** Only semantic events carry user/assistant text BOOP may learn from. */
  semantic: boolean
  /** Literal text preview, absent for structural events. */
  text?: string
}

export interface SourceReader {
  /**
   * Cold discovery; must not create or wake any Agent. Async (rc.2).
   *
   * `resolveHeadFor` names the sessions whose current head seq the caller needs
   * (the ones BOOP already has a cursor on). A reader may resolve it with a
   * bounded number of reads; everything else may report `headSeq: null`.
   */
  listSources(options?: { resolveHeadFor?: ReadonlySet<string> }): Promise<SourceRef[]> | SourceRef[]
  /** Lightweight records after `afterSeq`, ascending. */
  listEvents(sessionId: string, afterSeq: number, limit: number): Promise<EventRecord[]> | EventRecord[]
}

export interface CursorStore {
  read(scopeId: string, sessionId: string, sourceGeneration: string):
    | { throughSeq: number; state: CursorState }
    | undefined
  write(input: {
    scopeId: string
    sessionId: string
    sourceGeneration: string
    throughSeq: number
    state: CursorState
  }): void
  /** Every cursor of one scope, newest read first. */
  all(scopeId: string): Array<{
    sessionId: string
    sourceGeneration: string
    throughSeq: number
    state: CursorState
  }>
}

export interface ScanResult {
  discovered: number
  fresh: string[]
  dirty: string[]
  /** Sessions whose generation changed: the old generation is never overwritten. */
  generationChanged: string[]
  skippedExcluded: number
  /**
   * Sources whose current head could not be determined in this scan, so BOOP
   * could not prove they advanced. They are NOT marked dirty (no invented
   * movement) and are retried on the next scan. Reported, never hidden.
   */
  headDeferred: string[]
}

export class SourceObserver {
  private readonly scopeId: string
  private readonly reader: SourceReader
  private readonly cursors: CursorStore

  constructor(scopeId: string, reader: SourceReader, cursors: CursorStore) {
    this.scopeId = scopeId
    this.reader = reader
    this.cursors = cursors
  }

  /**
   * Discover every Session in the data domain and mark what needs reading.
   *
   * Read-only: the only writes are BOOP's own cursors.
   */
  async scan(excludedSessionIds: ReadonlySet<string> = new Set()): Promise<ScanResult> {
    const result: ScanResult = {
      discovered: 0,
      fresh: [],
      dirty: [],
      generationChanged: [],
      skippedExcluded: 0,
      headDeferred: [],
    }
    const knownGenerations = new Map<string, string>()
    for (const cursor of this.cursors.all(this.scopeId)) {
      knownGenerations.set(cursor.sessionId, cursor.sourceGeneration)
    }

    // Only sessions BOOP already reads need a current head; new sessions are
    // fresh anyway and a generation change needs no head at all.
    const resolveHeadFor = new Set(knownGenerations.keys())
    const sources = await this.reader.listSources({ resolveHeadFor })

    for (const source of sources) {
      if (excludedSessionIds.has(source.sessionId)) {
        result.skippedExcluded += 1
        continue
      }
      result.discovered += 1
      const known = knownGenerations.get(source.sessionId)
      if (known === undefined) {
        this.cursors.write({
          scopeId: this.scopeId,
          sessionId: source.sessionId,
          sourceGeneration: source.sourceGeneration,
          throughSeq: -1,
          state: 'fresh',
        })
        result.fresh.push(source.sessionId)
        continue
      }
      if (known !== source.sourceGeneration) {
        // A new generation starts from zero but never rewrites the old one.
        this.cursors.write({
          scopeId: this.scopeId,
          sessionId: source.sessionId,
          sourceGeneration: source.sourceGeneration,
          throughSeq: -1,
          state: 'fresh',
        })
        result.generationChanged.push(source.sessionId)
        continue
      }
      const cursor = this.cursors.read(this.scopeId, source.sessionId, source.sourceGeneration)
      if (!cursor || cursor.state === 'excluded') continue
      if (source.headSeq === null) {
        // The reader could not prove the current head this scan. Do not invent
        // movement: retry next scan and report the deferral explicitly.
        result.headDeferred.push(source.sessionId)
        continue
      }
      if (source.headSeq > cursor.throughSeq) {
        this.cursors.write({
          scopeId: this.scopeId,
          sessionId: source.sessionId,
          sourceGeneration: source.sourceGeneration,
          throughSeq: cursor.throughSeq,
          state: 'dirty',
        })
        result.dirty.push(source.sessionId)
      }
    }
    return result
  }

  /**
   * Read the semantic events BOOP has not seen yet.
   *
   * The returned `throughSeq` is the durable boundary of THIS read: memory
   * jobs may claim coverage up to it, and never beyond it.
   */
  async readBatch(input: {
    sessionId: string
    limit?: number
  }): Promise<{ records: EventRecord[]; fromSeq: number; throughSeq: number; gap: boolean }> {
    const limit = input.limit ?? 200
    const cursor = this.latestCursor(input.sessionId)
    const fromSeq = cursor ? cursor.throughSeq : -1
    const records = await this.reader.listEvents(input.sessionId, fromSeq, limit)
    const semantic = records.filter((record) => record.semantic)
    // Coverage must be contiguous from the watermark: any missing seq inside
    // this read (compaction, trim, fork) is a gap, not contiguous coverage.
    let expected = fromSeq + 1
    let gap = false
    for (const record of records) {
      if (record.seq !== expected) gap = true
      expected = record.seq + 1
    }
    if (records.length === 0) {
      return { records: [], fromSeq, throughSeq: fromSeq, gap: false }
    }
    const throughSeq = records[records.length - 1].seq
    if (cursor) {
      this.cursors.write({
        scopeId: this.scopeId,
        sessionId: input.sessionId,
        sourceGeneration: cursor.sourceGeneration,
        throughSeq,
        state: gap ? 'gap' : 'processing',
      })
    }
    return { records: semantic, fromSeq, throughSeq, gap }
  }

  /** Commit the durable boundary after a memory job finished successfully. */
  commitRead(input: { sessionId: string; throughSeq: number }): void {
    const cursor = this.latestCursor(input.sessionId)
    if (!cursor) return
    if (input.throughSeq < cursor.throughSeq) return // never move the watermark backwards
    this.cursors.write({
      scopeId: this.scopeId,
      sessionId: input.sessionId,
      sourceGeneration: cursor.sourceGeneration,
      throughSeq: input.throughSeq,
      state: 'dirty',
    })
  }

  /** Forget a source without deleting history (03§14 forget rule). */
  exclude(sessionId: string, sourceGeneration?: string): void {
    const cursor = sourceGeneration
      ? this.cursors.read(this.scopeId, sessionId, sourceGeneration)
      : this.latestCursor(sessionId)
    if (!cursor) return
    this.cursors.write({
      scopeId: this.scopeId,
      sessionId,
      sourceGeneration: cursor.sourceGeneration,
      throughSeq: cursor.throughSeq,
      state: 'excluded',
    })
  }

  private latestCursor(sessionId: string): { throughSeq: number; state: CursorState; sourceGeneration: string } | null {
    const all = this.cursors
      .all(this.scopeId)
      .filter((cursor) => cursor.sessionId === sessionId)
      .sort((a, b) => (a.sourceGeneration < b.sourceGeneration ? 1 : -1))
    const first = all[0]
    return first ? { throughSeq: first.throughSeq, state: first.state, sourceGeneration: first.sourceGeneration } : null
  }
}

/** Repository-backed cursor store. */
export class LedgerCursorStore implements CursorStore {
  private readonly repo: {
    cursors(scopeId: string): Array<{ sessionId: string; sourceGeneration: string; throughSeq: number; state: string }>
    upsertCursor(input: {
      scopeId: string
      sessionId: string
      sourceGeneration: string
      throughSeq: number
      state: 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded'
    }): void
  }

  constructor(repo: {
    cursors(scopeId: string): Array<{ sessionId: string; sourceGeneration: string; throughSeq: number; state: string }>
    upsertCursor(input: {
      scopeId: string
      sessionId: string
      sourceGeneration: string
      throughSeq: number
      state: 'fresh' | 'dirty' | 'processing' | 'gap' | 'excluded'
    }): void
  }) {
    this.repo = repo
  }

  read(scopeId: string, sessionId: string, sourceGeneration: string) {
    const row = this.repo.cursors(scopeId).find(
      (cursor) => cursor.sessionId === sessionId && cursor.sourceGeneration === sourceGeneration,
    )
    return row ? { throughSeq: row.throughSeq, state: row.state as CursorState } : undefined
  }

  write(input: Parameters<CursorStore['write']>[0]): void {
    this.repo.upsertCursor(input)
  }

  all(scopeId: string) {
    return this.repo.cursors(scopeId).map((cursor) => ({
      sessionId: cursor.sessionId,
      sourceGeneration: cursor.sourceGeneration,
      throughSeq: cursor.throughSeq,
      state: cursor.state as CursorState,
    }))
  }
}