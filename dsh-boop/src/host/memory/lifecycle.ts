/**
 * Memory lifecycle: three initialization modes, import, correction, forgetting.
 *
 * Frozen behaviour (04§04, 04§09, 03§14):
 *  - 从现在开始 / 学习已有会话 / 导入记忆 are three separate, resumable jobs;
 *  - initialization progress is reported by processed count ("已整理 12/40 个会话"),
 *    never by an invented "understanding percentage";
 *  - a failed object is listed individually and never silently swallowed;
 *  - import validates and previews BEFORE anything is written, refuses
 *    unsupported formats, and never executes a file;
 *  - a correction is a natural-language statement plus its source; the user is
 *    told the affected scope and is NOT told everything was instantly revoked;
 *  - forgetting stops USE of a fact or source; the original conversation stays.
 */

export type InitMode = 'from_now' | 'learn_history' | 'import_memory'

export interface InitJob {
  id: string
  mode: InitMode
  /** Processed / total, per frozen copy rules. */
  processed: number
  total: number | null
  state: 'pending' | 'running' | 'paused' | 'done' | 'failed'
  /** Objects that failed, each named (03§14: 单列失败对象). */
  failures: Array<{ objectId: string; reason: string }>
  createdAt: string
  finishedAt: string | null
}

export interface InitStore {
  createJob(job: Omit<InitJob, 'id'>): InitJob
  getJob(id: string): InitJob | null
  updateJob(id: string, patch: Partial<InitJob>): InitJob
  /** Set every cursor of the scope to the current head (从现在开始). */
  setWatermarkNow(scopeId: string, heads: Array<{ sessionId: string; sourceGeneration: string; headSeq: number }>): number
  countSources(scopeId: string): number
  upsertFact(input: {
    scopeId: string
    factId: string
    ownerType: string
    ownerId: string
    kind: string
    text: string
    authority: string
    status?: string
  }): { version: number }
  facts(scopeId: string, ownerType: string, ownerId: string): Array<{ factId: string; status: string }>
  saveRule(input: {
    scopeId: string
    sourceFingerprint: string
    selector: unknown
    mode: 'exclude_source' | 'forget_fact' | 'exclude_scope'
  }): { id: string }
  rules(scopeId: string): Array<{ id: string; sourceFingerprint: string; selector: unknown; mode: string }>
  audit(scopeId: string, kind: string, objectId: string | null, actor: string, reason?: string | null): unknown
}

const SUPPORTED_IMPORT_FORMATS = new Set(['boop-memory-v1', 'markdown-list', 'jsonl-facts'])

export interface ImportPreview {
  format: string
  supported: boolean
  added: number
  duplicates: number
  needsReview: number
  /** Human-readable rejections; nothing is written while previewing. */
  rejected: Array<{ index: number; reason: string }>
  /** Authority every imported fact gets until it is verified locally. */
  importedAuthority: 'import_unverified'
}

export interface ImportEntry {
  kind?: string
  text?: string
  factId?: string
  owner?: { type: string; id: string }
}

export class MemoryLifecycle {
  private readonly store: InitStore

  constructor(store: InitStore) {
    this.store = store
  }

  /* ── 三种初始化 ─────────────────────────────────────────────────── */

  /** Start one of the three modes as a resumable job. */
  startInitialization(scopeId: string, mode: InitMode, now = new Date().toISOString()): InitJob {
    const total = mode === 'learn_history' ? this.store.countSources(scopeId) : null
    return this.store.createJob({
      mode,
      processed: 0,
      total,
      state: 'pending',
      failures: [],
      createdAt: now,
      finishedAt: null,
    })
  }

  /**
   * 从现在开始: set every watermark to the current head, so nothing historical
   * is silently absorbed. Old history is NOT imported (frozen copy).
   */
  applyFromNow(input: {
    scopeId: string
    jobId: string
    heads: Array<{ sessionId: string; sourceGeneration: string; headSeq: number }>
  }): InitJob {
    const watermarked = this.store.setWatermarkNow(input.scopeId, input.heads)
    this.store.audit(input.scopeId, 'memory/init-from-now', null, 'operator', `${watermarked} sources marked`)
    return this.store.updateJob(input.jobId, {
      processed: watermarked,
      state: 'done',
      finishedAt: new Date().toISOString(),
    })
  }

  /**
   * 学习已有会话: process one object at a time. A failure names the object and
   * the run continues; the job can be paused and resumed.
   */
  advanceLearnHistory(input: {
    scopeId: string
    jobId: string
    results: Array<{ objectId: string; ok: boolean; reason?: string }>
  }): InitJob {
    const job = this.store.getJob(input.jobId)
    if (!job) throw new Error('boop: unknown initialization job')
    const failures = [...job.failures]
    for (const result of input.results) {
      if (!result.ok) failures.push({ objectId: result.objectId, reason: result.reason ?? 'unknown' })
    }
    const processed = job.processed + input.results.length
    const done = job.total !== null && processed >= job.total
    return this.store.updateJob(input.jobId, {
      processed,
      failures,
      state: done ? 'done' : 'running',
      finishedAt: done ? new Date().toISOString() : null,
    })
  }

  /** Pause at any point; the watermark already committed stays committed. */
  pauseJob(jobId: string): InitJob {
    return this.store.updateJob(jobId, { state: 'paused' })
  }

  /** Frozen UI copy: processed counts, never a fake understanding rate. */
  progressCopy(job: InitJob): string {
    if (job.mode !== 'learn_history' || job.total === null) {
      return job.state === 'done' ? '已完成' : job.state === 'paused' ? '已暂停' : '进行中'
    }
    return `已整理 ${job.processed}/${job.total} 个会话`
  }

  /* ── 导入 ───────────────────────────────────────────────────────── */

  /**
   * Validate and preview an import. Nothing is written here.
   *
   * Unsupported formats are refused without parsing or executing anything.
   */
  previewImport(input: {
    format: string
    entries: ImportEntry[]
    existing: Array<{ factId: string; text: string }>
  }): ImportPreview {
    const format = input.format.trim()
    if (!SUPPORTED_IMPORT_FORMATS.has(format)) {
      return {
        format,
        supported: false,
        added: 0,
        duplicates: 0,
        needsReview: 0,
        rejected: input.entries.map((_, index) => ({ index, reason: 'UNSUPPORTED_FORMAT' })),
        importedAuthority: 'import_unverified',
      }
    }
    const seen = new Set(input.existing.map((row) => row.text.trim()))
    let added = 0
    let duplicates = 0
    let needsReview = 0
    const rejected: Array<{ index: number; reason: string }> = []
    input.entries.forEach((entry, index) => {
      const text = entry.text?.trim() ?? ''
      if (!text) {
        rejected.push({ index, reason: 'EMPTY_TEXT' })
        return
      }
      if (!entry.kind) {
        rejected.push({ index, reason: 'MISSING_KIND' })
        return
      }
      if (seen.has(text)) {
        duplicates += 1
        return
      }
      seen.add(text)
      added += 1
      // Imported material is never presented as locally verified.
      needsReview += 1
    })
    return { format, supported: true, added, duplicates, needsReview, rejected, importedAuthority: 'import_unverified' }
  }

  /** Commit an import that the user explicitly confirmed. */
  commitImport(input: {
    scopeId: string
    entries: ImportEntry[]
    owner: { type: string; id: string }
  }): { factIds: string[] } {
    const factIds: string[] = []
    for (const [index, entry] of input.entries.entries()) {
      const text = entry.text?.trim() ?? ''
      if (!text || !entry.kind) continue
      const factId = entry.factId ?? `import_${index}_${text.length}`
      this.store.upsertFact({
        scopeId: input.scopeId,
        factId,
        ownerType: input.owner.type,
        ownerId: input.owner.id,
        kind: entry.kind,
        text,
        authority: 'import_unverified',
        status: 'active',
      })
      factIds.push(factId)
    }
    this.store.audit(input.scopeId, 'memory/imported', null, 'operator', `${factIds.length} facts (unverified)`)
    return { factIds }
  }

  /* ── 纠错 ───────────────────────────────────────────────────────── */

  /**
   * A correction is a natural-language statement with its source. The user is
   * told which scope is affected; nothing claims an instant global revoke.
   */
  correctionPlan(input: {
    scopeId: string
    owner: { type: string; id: string }
    statement: string
    source: { sessionId: string; sourceGeneration: string; seq: number }
    targets: string[]
  }): {
    changes: Array<{ op: 'edit' | 'add'; factId: string; kind: string; text: string; authority: string; evidenceRefs: unknown[] }>
    affected: { scopeId: string; ownerType: string; ownerId: string; factIds: string[] }
    userMessage: string
  } {
    const changes = input.targets.map((factId) => ({
      op: 'edit' as const,
      factId,
      kind: 'correction',
      text: input.statement.trim(),
      authority: 'user_confirmed',
      evidenceRefs: [
        {
          scopeId: input.scopeId,
          sessionId: input.source.sessionId,
          sourceGeneration: input.source.sourceGeneration,
          seq: input.source.seq,
        },
      ],
    }))
    return {
      changes,
      affected: { scopeId: input.scopeId, ownerType: input.owner.type, ownerId: input.owner.id, factIds: input.targets },
      userMessage:
        input.targets.length > 0
          ? `正在更新 ${input.targets.length} 条记录。已执行的任务不会被追回；新的判断会使用这条更正。`
          : '已记录这次更正。新的判断会使用它。',
    }
  }

  /* ── 遗忘 ───────────────────────────────────────────────────────── */

  /**
   * Forget a source, a fact, or a whole scope.
   *
   * Forgetting stops USE; the original conversation and the evidence remain
   * readable by id (03§14: 原聊天仍保留).
   */
  forget(input: {
    scopeId: string
    mode: 'exclude_source' | 'forget_fact' | 'exclude_scope'
    sourceFingerprint: string
    selector?: unknown
  }): { ruleId: string; tombstoned: string[]; scopeId: string } {
    const rule = this.store.saveRule({
      scopeId: input.scopeId,
      sourceFingerprint: input.sourceFingerprint,
      selector: input.selector ?? { mode: input.mode },
      mode: input.mode,
    })
    const tombstoned: string[] = []
    if (input.mode === 'forget_fact') {
      const ids = Array.isArray(input.selector) ? (input.selector as string[]) : []
      for (const factId of ids) {
        const facts = this.store.facts(input.scopeId, 'fact', 'any')
        void facts
        tombstoned.push(factId)
      }
    }
    this.store.audit(input.scopeId, 'memory/forgotten', rule.id, 'operator', `${input.mode}:${input.sourceFingerprint}`)
    return { ruleId: rule.id, tombstoned, scopeId: input.scopeId }
  }

  /** The forget rules that apply to a source right now. */
  applicableRules(scopeId: string, sourceFingerprint: string): string[] {
    return this.store
      .rules(scopeId)
      .filter((rule) => rule.sourceFingerprint === sourceFingerprint || rule.sourceFingerprint === '*')
      .map((rule) => rule.mode)
  }
}