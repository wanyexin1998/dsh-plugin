/**
 * Memory commit (E03-02).
 *
 * The extractor (model-backed) is BLOCKED without credentials, so this module
 * owns everything that must be true BEFORE a fact may enter a snapshot:
 *
 *  - every change cites evidence inside the declared read window
 *    ([fromSeq, toSeq]); an unsupported change is rejected, not stored;
 *  - a proposal may not lower a fact's authority or silently overwrite a
 *    newer version (CAS against `baselineVersion`);
 *  - two effective facts that disagree become `disputed`, never "last write
 *    wins"; "disagree" is evaluated on a comparable subject, not on `kind`
 *    alone (see the conflict rule below);
 *  - coverage is explicit: a snapshot knows exactly which source generation it
 *    covers up to which seq, so a stale answer is visible instead of silent;
 *  - session memories aggregate into the workspace view without copying text
 *    twice: the workspace snapshot references fact ids and coverage only.
 *
 * Conflict rule (03§11 "冲突事实同时保留，避免 last-write-wins"; 02§12 B
 * "相互冲突但证据不足时创建 conflict，不自选赢家"; 03§13):
 *
 *  - a conflict needs a PROVABLE comparable subject: same `kind` AND the same
 *    non-empty `subjectKey`, with different text (values). Two decisions about
 *    deployment policy and about a deadline are different subjects, so they
 *    coexist `active` — `kind` alone never proves that two claims contradict;
 *  - a DIFFERENT `subjectKey` on the same kind is an explicit statement of a
 *    different subject: neither fact is disputed (no silent overwrite either,
 *    they are independent rows);
 *  - when EITHER side has no `subjectKey` (older rows, a model that omitted it,
 *    a store that cannot expose it) the conservative rule stays: same `kind` +
 *    different text ⇒ disputed. Text inequality alone is not proof of
 *    compatibility, and letting both stand would risk a last-write-wins read;
 *  - nothing is overwritten to "resolve" a disagreement: both facts stay in the
 *    ledger with their own text and evidence, only their `status` becomes
 *    `disputed`; kind and authority are never rewritten by a conflict;
 *  - only pairs that involve a fact THIS proposal wrote are evaluated, so a new
 *    commit never retroactively disputes older independent facts.
 *
 * Frozen rules: 03§11, 03§13, 03§14.
 */

import type { MemoryChange, MemoryProposal, Snapshot } from '../../shared/types.ts'

export interface MemoryCommitResult {
  status: 'committed' | 'rejected'
  version?: number
  coverage?: Record<string, { sourceGeneration: string; throughSeq: number }>
  applied: string[]
  rejected: Array<{ index: number; reason: string }>
  disputed: string[]
}

/** Authority order: a lower number is stronger. Never silently downgraded. */
const AUTHORITY_ORDER: Record<string, number> = {
  user_confirmed: 0,
  user_exploration: 1,
  agent_reported: 2,
  tool_observed: 3,
  import_unverified: 4,
  inference: 5,
}

export function authorityRank(authority: string): number {
  return AUTHORITY_ORDER[authority] ?? AUTHORITY_ORDER.inference
}

/** A subject key is a comparison hint, not a payload: bounded and opaque. */
export const MAX_SUBJECT_KEY_CHARS = 120

/**
 * Normalize a model/tool-provided subject key.
 *
 * Returns `undefined` ("unknown") for anything that cannot be compared safely:
 * a non-string, an empty/whitespace value, control characters or an over-long
 * value. An unusable key never rejects the fact itself — it only means the
 * conflict check falls back to the conservative rule.
 */
export function normalizeSubjectKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SUBJECT_KEY_CHARS) return undefined
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined
  return trimmed
}

export interface MemoryStore {
  currentVersion(scopeId: string, ownerType: string, ownerId: string): number
  /** Facts of one owner with their version and status. */
  facts(scopeId: string, ownerType: string, ownerId: string): Array<{
    factId: string
    kind: string
    text: string
    status: string
    authority: string
    version: number
    /**
     * Optional forward-compatible seam: a store that CAN expose the fact's
     * subject key lets a later proposal compare it exactly instead of falling
     * back to the conservative rule. The current ledger adapter does not
     * persist it (no schema column yet), so real cross-proposal comparisons
     * stay conservative — reported, never hidden.
     */
    subjectKey?: string
  }>
  upsertFact(input: {
    scopeId: string
    factId: string
    ownerType: string
    ownerId: string
    kind: string
    text: string
    authority: string
    status?: string
    subjectKey?: string
  }): { version: number }
  addEvidence(input: { scopeId: string; factId: string; sessionId?: string; seq?: number; sourceHash: string }): void
  saveMemorySnapshot(input: {
    scopeId: string
    ownerType: string
    ownerId: string
    body: string
    coverage: Record<string, { sourceGeneration: string; throughSeq: number }>
    expectedBaselineVersion: number
  }): { version: number }
  latestMemorySnapshot(scopeId: string, ownerType: string, ownerId: string): { version: number; body: string; coverage: Record<string, { sourceGeneration: string; throughSeq: number }> } | null
}

export class MemoryCommitter {
  private readonly store: MemoryStore

  constructor(store: MemoryStore) {
    this.store = store
  }

  /**
   * Commit one proposal against an explicit baseline.
   *
   * Nothing is written when the baseline moved: the caller must re-read and
   * re-propose instead of overwriting a newer snapshot (CAS).
   */
  commit(proposal: MemoryProposal, owner: { type: string; id: string }): MemoryCommitResult {
    const scopeId = proposal.scopeId
    const current = this.store.currentVersion(scopeId, owner.type, owner.id)
    if (current !== proposal.baselineVersion) {
      return {
        status: 'rejected',
        applied: [],
        rejected: [{ index: -1, reason: 'BASELINE_MOVED' }],
        disputed: [],
      }
    }

    const applied: string[] = []
    const rejected: Array<{ index: number; reason: string }> = []
    /**
     * The subject key each fact this proposal wrote carries. The ledger adapter
     * may not persist it, so the in-proposal comparison must read it from here;
     * otherwise a model's own subject hints would be lost immediately.
     */
    const touchedKeys = new Map<string, string | undefined>()
    /** Facts the caller declared as conflicts outright (`op: 'conflict'`). */
    const declaredConflicts = new Set<string>()

    proposal.changes.forEach((change: MemoryChange, index: number) => {
      const reason = this.validate(change, proposal)
      if (reason) {
        rejected.push({ index, reason })
        return
      }
      const factId = change.factId ?? stableFactId(change)
      const subjectKey = normalizeSubjectKey(change.subjectKey)
      const existing = this.store
        .facts(scopeId, owner.type, owner.id)
        .find((fact) => fact.factId === factId)

      if (existing && existing.status === 'tombstoned') {
        rejected.push({ index, reason: 'FACT_TOMBSTONED' })
        return
      }
      if (existing && change.op !== 'add' && authorityRank(change.authority) > authorityRank(existing.authority)) {
        // A weaker source may not overwrite a stronger one.
        rejected.push({ index, reason: 'AUTHORITY_DOWNGRADE' })
        return
      }
      if (change.op === 'supersede' && existing && existing.status === 'active') {
        this.store.upsertFact({
          scopeId,
          factId,
          ownerType: owner.type,
          ownerId: owner.id,
          kind: change.kind,
          text: existing.text,
          authority: existing.authority,
          status: 'superseded',
          ...(existing.subjectKey === undefined ? {} : { subjectKey: existing.subjectKey }),
        })
      }

      this.store.upsertFact({
        scopeId,
        factId,
        ownerType: owner.type,
        ownerId: owner.id,
        kind: change.kind,
        text: change.text,
        authority: change.authority,
        status: change.status ?? (change.op === 'conflict' ? 'disputed' : 'active'),
        ...(subjectKey === undefined ? {} : { subjectKey }),
      })
      touchedKeys.set(factId, subjectKey)
      if (change.op === 'conflict' || change.status === 'disputed') declaredConflicts.add(factId)
      for (const evidence of change.evidenceRefs) {
        this.store.addEvidence({
          scopeId,
          factId,
          sessionId: evidence.sessionId,
          seq: evidence.seq,
          sourceHash: evidence.hash ?? `${evidence.sourceGeneration}#${evidence.seq}`,
        })
      }
      applied.push(factId)
    })

    // Conflict evaluation over the effective facts this proposal touched: a
    // pair is disputed only when it is provably about the SAME subject with
    // different values (see the rule at the top). Untouched pairs are not
    // re-litigated on every commit — they were evaluated when they were written,
    // and re-scoring them here would dispute older independent facts by accident.
    const disputedIds = new Set<string>(declaredConflicts)
    const activeFacts = this.store.facts(scopeId, owner.type, owner.id).filter((fact) => fact.status === 'active')
    const subjectKeyOf = (fact: { factId: string; subjectKey?: string }): string | undefined =>
      touchedKeys.has(fact.factId) ? touchedKeys.get(fact.factId) : fact.subjectKey
    for (let i = 0; i < activeFacts.length; i += 1) {
      const left = activeFacts[i]
      if (!left || !touchedKeys.has(left.factId)) continue
      for (let j = 0; j < activeFacts.length; j += 1) {
        if (i === j) continue
        const right = activeFacts[j]
        if (!right) continue
        if (!isConflictPair(left, subjectKeyOf(left), right, subjectKeyOf(right))) continue
        disputedIds.add(left.factId)
        disputedIds.add(right.factId)
      }
    }
    const disputed = [...disputedIds]
    for (const factId of disputed) {
      const fact = activeFacts.find((row) => row.factId === factId)
      if (!fact) continue // already disputed (declared) or no longer active
      const key = subjectKeyOf(fact)
      // `disputed` is a STATUS, never a rewrite: text, kind and authority stay
      // exactly as committed so neither side wins and the authority order holds.
      this.store.upsertFact({
        scopeId,
        factId,
        ownerType: owner.type,
        ownerId: owner.id,
        kind: fact.kind,
        text: fact.text,
        authority: fact.authority,
        status: 'disputed',
        ...(key === undefined ? {} : { subjectKey: key }),
      })
    }

    if (applied.length === 0) {
      return { status: 'rejected', applied, rejected, disputed }
    }

    const previous = this.store.latestMemorySnapshot(scopeId, owner.type, owner.id)
    // Coverage must name the REAL source generation it read: the extraction
    // path passes it explicitly; only legacy callers omit it and fall back to
    // the previous snapshot key. This key is what makes staleness visible later.
    const generation = proposal.sourceGeneration ?? currentGenerationOf(proposal, previous)
    const coverage = mergeCoverage(previous?.coverage ?? {}, {
      [`${proposal.sessionId}#${generation}`]: {
        sourceGeneration: generation,
        throughSeq: proposal.toSeq,
      },
    })

    const saved = this.store.saveMemorySnapshot({
      scopeId,
      ownerType: owner.type,
      ownerId: owner.id,
      // The body is rendered from the store, with the subject keys this
      // proposal wrote merged back in (the ledger adapter may not persist them).
      body: renderSnapshotBody(
        this.store
          .facts(scopeId, owner.type, owner.id)
          .map((fact) => (touchedKeys.has(fact.factId) ? { ...fact, subjectKey: touchedKeys.get(fact.factId) } : fact)),
      ),
      coverage,
      expectedBaselineVersion: proposal.baselineVersion,
    })

    return { status: 'committed', version: saved.version, coverage, applied, rejected, disputed }
  }

  /** One change is admissible only with evidence inside the read window. */
  private validate(change: MemoryChange, proposal: MemoryProposal): string | null {
    if (!change.text || change.text.trim() === '') return 'EMPTY_TEXT'
    if (!change.kind) return 'MISSING_KIND'
    if (!(change.authority in AUTHORITY_ORDER)) return 'UNKNOWN_AUTHORITY'
    if (!Array.isArray(change.evidenceRefs) || change.evidenceRefs.length === 0) return 'NO_EVIDENCE'
    for (const evidence of change.evidenceRefs) {
      if (evidence.scopeId !== proposal.scopeId) return 'EVIDENCE_SCOPE_MISMATCH'
      if (evidence.sessionId !== proposal.sessionId) return 'EVIDENCE_SESSION_MISMATCH'
      if (typeof evidence.seq !== 'number') return 'EVIDENCE_SEQ_MISSING'
      if (evidence.seq < proposal.fromSeq || evidence.seq > proposal.toSeq) return 'EVIDENCE_OUT_OF_WINDOW'
    }
    return null
  }
}

function stableFactId(change: MemoryChange): string {
  const key = `${change.kind}::${change.text.trim()}`
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return `fact_${hash.toString(16)}`
}

/**
 * Are two effective facts provably about the same subject but incompatible?
 *
 * The subject is `(kind, subjectKey)`. Different kinds are different statement
 * types (a decision and a tool observation may both be true). Different
 * non-empty keys are different subjects, so the facts coexist. Only an absent
 * key on either side falls back to the conservative rule: same kind and
 * different text are marked disputed, because text inequality cannot prove the
 * two claims are compatible and BOOP must not let a reader assume last-write-wins.
 */
function isConflictPair(
  left: { kind: string; text: string },
  leftKey: string | undefined,
  right: { kind: string; text: string },
  rightKey: string | undefined,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.text.trim() === right.text.trim()) return false
  if (leftKey !== undefined && rightKey !== undefined) return leftKey === rightKey
  return true
}

function currentGenerationOf(proposal: MemoryProposal, previous: { coverage: Record<string, unknown> } | null): string {
  const key = Object.keys(previous?.coverage ?? {}).find((entry) => entry.startsWith(`${proposal.sessionId}#`))
  return key ? key.split('#')[1] : 'current'
}

function mergeCoverage(
  previous: Record<string, { sourceGeneration: string; throughSeq: number }>,
  next: Record<string, { sourceGeneration: string; throughSeq: number }>,
): Record<string, { sourceGeneration: string; throughSeq: number }> {
  const merged = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key]
    if (!existing || value.throughSeq > existing.throughSeq) merged[key] = value
  }
  return merged
}

function renderSnapshotBody(
  facts: Array<{
    factId: string
    kind: string
    text: string
    status: string
    authority: string
    version: number
    subjectKey?: string
  }>,
): string {
  return facts
    .filter((fact) => fact.status !== 'superseded')
    .map(
      (fact) =>
        `- [${fact.status}] ${fact.kind}: ${fact.text} (${fact.authority} v${fact.version}${
          fact.subjectKey === undefined ? '' : `, key=${fact.subjectKey}`
        })`,
    )
    .join('\n')
}

/**
 * Workspace view (E03-02 aggregation): coverage is the union of its sessions'
 * coverage, and the body references facts instead of copying their text.
 */
export function aggregateWorkspace(input: {
  snapshots: Array<{ ownerId: string; snapshot: Snapshot | null }>
}): { coverage: Record<string, { sourceGeneration: string; throughSeq: number }>; referenced: string[]; freshness: Snapshot['freshness'] } {
  const coverage: Record<string, { sourceGeneration: string; throughSeq: number }> = {}
  const referenced: string[] = []
  let current = true
  for (const entry of input.snapshots) {
    referenced.push(entry.ownerId)
    if (!entry.snapshot) {
      current = false
      continue
    }
    for (const [key, value] of Object.entries(entry.snapshot.coverage ?? {})) {
      const existing = coverage[key]
      if (!existing || value.throughSeq > existing.throughSeq) coverage[key] = value
    }
    if (entry.snapshot.freshness !== 'current') current = false
  }
  return { coverage, referenced, freshness: current ? 'current' : 'stale' }
}