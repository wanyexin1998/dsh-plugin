/**
 * Host binding for the whole-domain observer (E03-01).
 *
 * Read-only by construction: the only host calls are `sessionQuery` reads.
 * No Agent is created, no model is loaded, nothing is appended to a Session.
 *
 * rc.2.1 shape notes (re-baselined 2026-10-18):
 *  - `sessionQuery.listSessions()` returns body-free `SessionRecord`s:
 *    `{ header: SessionHeader, live, persisted }`. The old flat `{id,title,…}`
 *    rows do not exist; this adapter reads the nested header and tolerates the
 *    legacy flat shape only as a fallback.
 *  - `listEvents()` returns body-free records `{sessionId,seq,type,time,surface}`
 *    with NO text. Semantic text comes from `filterEvents(id, [])`, whose
 *    documents carry the extracted `text`; `listEvents` is only the fallback.
 *  - SessionHeader has no event count, so a current head seq needs one
 *    per-Session read. Resolution is bounded per scan and only requested for
 *    sessions BOOP already has a cursor on; everything else reports
 *    `headSeq: null` (unknown, never zero) so the observer can defer honestly.
 */

import type { EventRecord, SourceReader, SourceRef } from './observer.ts'

/** Event types whose text BOOP may learn from (03§11). */
const SEMANTIC_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'turn/end',
  'notice',
  'user/approval',
])

/** Bound on full-log reads per discovery scan (one read resolves one head). */
const HEAD_READ_LIMIT = 25

/** rc.2.1 body-free SessionRecord (plus the legacy flat row as a fallback). */
interface SessionRecordLike {
  header?: {
    id?: string
    version?: number
    createdAt?: number
    parentSession?: string
    isSeeded?: boolean
    [key: string]: unknown
  }
  live?: boolean
  persisted?: boolean
  // Legacy shapes tolerated for older payloads and test doubles.
  id?: string
  sessionId?: string
  workspaceId?: string | null
  title?: string | null
}

interface SemanticDocument {
  seq: number
  type: string
  time: number
  text?: string
}

export class HostSourceReader implements SourceReader {
  private readonly ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  private query(): any | null {
    return this.ctx.reflect?.get?.('sessionQuery', false) ?? null
  }

  async listSources(options: { resolveHeadFor?: ReadonlySet<string> } = {}): Promise<SourceRef[]> {
    const query = this.query()
    if (!query || typeof query.listSessions !== 'function') return []
    const records: SessionRecordLike[] = (await query.listSessions()) ?? []
    const workspaceBySession = this.workspaceMap()
    const refs: SourceRef[] = records
      .map((record) => this.toSourceRef(record, workspaceBySession))
      .filter((ref) => ref.sessionId !== '')

    // Only the sessions BOOP already reads need a current head. The read is a
    // full-log load, so it is bounded and everything else stays `null`.
    const wanted = options.resolveHeadFor ?? new Set<string>()
    const heads = new Map<string, number>()
    let budget = HEAD_READ_LIMIT
    for (const ref of refs) {
      if (!wanted.has(ref.sessionId)) continue
      if (budget <= 0) break
      budget -= 1
      const head = await this.readHead(query, ref.sessionId)
      if (head !== null) heads.set(ref.sessionId, head)
    }
    return refs.map((ref) => ({
      ...ref,
      headSeq: heads.has(ref.sessionId) ? (heads.get(ref.sessionId) as number) : null,
    }))
  }

  /**
   * The current head seq of one Session, or null when it cannot be read.
   *
   * `readSurface` validates the whole log and reports `capturedThroughSeq`; an
   * empty log is -1, which is the same "nothing read yet" value the watermark
   * uses. Failures stay isolated: one unreadable Session never aborts a scan.
   */
  private async readHead(query: any, sessionId: string): Promise<number | null> {
    if (typeof query.readSurface !== 'function') return null
    try {
      const surface = await query.readSurface(sessionId)
      const captured = surface?.capturedThroughSeq
      return typeof captured === 'number' && Number.isFinite(captured) ? captured : -1
    } catch {
      return null
    }
  }

  /** Best-effort session → workspace mapping from the durable registry. */
  private workspaceMap(): Map<string, string> {
    const map = new Map<string, string>()
    try {
      const registry = this.ctx.reflect?.get?.('workspaceRegistry', false)
      const workspaces = registry?.list?.() ?? []
      for (const workspace of workspaces) {
        const id = String(workspace?.id ?? '')
        if (id === '') continue
        for (const sessionId of workspace?.sessionIds ?? []) map.set(String(sessionId), id)
      }
    } catch {
      /* the registry is optional here; unknown workspace stays null, never guessed */
    }
    return map
  }

  private toSourceRef(record: SessionRecordLike, workspaceBySession: Map<string, string>): SourceRef {
    const header = (record.header ?? {}) as Record<string, unknown>
    const sessionId = String(header.id ?? record.id ?? record.sessionId ?? '')
    const workspaceId =
      workspaceBySession.get(sessionId) ??
      (record.workspaceId === null || record.workspaceId === undefined ? null : String(record.workspaceId))
    return {
      sessionId,
      // A generation fingerprint that changes whenever the Session's identity
      // (format version, creation moment, parent lineage) changes. Session
      // forks get a new Session id; content changes advance the head instead.
      sourceGeneration: generationOf(sessionId, header),
      workspaceId,
      title: record.title === null || record.title === undefined ? null : String(record.title),
      headSeq: null,
    }
  }

  async listEvents(sessionId: string, afterSeq: number, limit: number): Promise<EventRecord[]> {
    const query = this.query()
    if (!query) return []
    // The observation contract wants EVERY event in ascending order plus a
    // `semantic` flag: gap detection depends on contiguous seqs. rc.2.1's
    // `listEvents` gives the body-free sequence (all events), while
    // `filterEvents` gives semantic documents WITH text. Merge them by seq so a
    // real Session is not mistaken for a permanent READ_GAP.
    const all: Array<{ seq: number; type: string; time: number }> =
      typeof query.listEvents === 'function'
        ? ((await query.listEvents(sessionId)) ?? []).map((record: Record<string, unknown>) => ({
            seq: Number(record.seq),
            type: String(record.type ?? ''),
            time: Number(record.time ?? 0),
          }))
        : []
    const documents = await this.readSemanticDocuments(query, sessionId)
    const documentBySeq = new Map(documents.map((document) => [document.seq, document]))
    const merged: EventRecord[] =
      all.length > 0
        ? all.map((record) => this.toEventRecord(record, documentBySeq.get(record.seq)))
        : documents.map((document) => this.toEventRecord(document, document))
    return merged
      .filter((record) => record.seq > afterSeq)
      .slice(0, limit)
      .sort((a, b) => a.seq - b.seq)
  }

  private toEventRecord(
    record: { seq: number; type: string; time: number },
    document: SemanticDocument | undefined,
  ): EventRecord {
    const type = document?.type ?? record.type
    const text = typeof document?.text === 'string' && document.text.length > 0 ? document.text : undefined
    return {
      seq: record.seq,
      type,
      time: document?.time ?? record.time,
      semantic: SEMANTIC_EVENT_TYPES.has(type) && text !== undefined,
      ...(text === undefined ? {} : { text }),
    }
  }

  /**
   * Semantic event documents with extracted text (rc.2.1 `filterEvents`).
   * Falls back to the body-free `listEvents` records on hosts that lack it, in
   * which case no text exists and the records stay non-semantic — recorded
   * honestly instead of pretending the log was read.
   */
  private async readSemanticDocuments(query: any, sessionId: string): Promise<SemanticDocument[]> {
    if (typeof query.filterEvents === 'function') {
      const documents = (await query.filterEvents(sessionId, [])) ?? []
      return documents.map((document: Record<string, unknown>) => ({
        seq: Number(document.seq),
        type: String(document.type ?? ''),
        time: Number(document.time ?? 0),
        text: typeof document.text === 'string' ? document.text : undefined,
      }))
    }
    if (typeof query.listEvents !== 'function') return []
    const records = (await query.listEvents(sessionId)) ?? []
    return records.map((record: Record<string, unknown>) => ({
      seq: Number(record.seq),
      type: String(record.type ?? ''),
      time: Number(record.time ?? 0),
    }))
  }
}

function generationOf(sessionId: string, header: Record<string, unknown>): string {
  const version = header.version === undefined ? '' : String(header.version)
  const createdAt = header.createdAt === undefined ? '' : String(header.createdAt)
  const parent = header.parentSession === undefined ? '' : String(header.parentSession)
  return `${sessionId}@${version}:${createdAt}:${parent}`
}
