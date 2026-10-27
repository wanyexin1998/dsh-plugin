/**
 * Ledger-backed InitStore (E03-03 on the Host).
 *
 * Jobs, watermarks, forget rules and tombstones live in the one BOOP ledger.
 * This store does not open Sessions, call a model, or read project files.
 */

import type { BoopRepository } from '../persistence/repository.ts'
import type { InitJob, InitStore } from './lifecycle.ts'

export class LedgerInitStore implements InitStore {
  private readonly repo: BoopRepository
  private readonly scopeId: string
  private readonly sourceCount: () => number

  constructor(repo: BoopRepository, scopeId: string, sourceCount?: () => number) {
    this.repo = repo
    this.scopeId = scopeId
    this.sourceCount = sourceCount ?? (() => repo.cursors(scopeId).length)
  }

  createJob(job: Omit<InitJob, 'id'>): InitJob {
    const created = this.repo.createInitJob({
      scopeId: this.scopeId,
      mode: job.mode,
      processed: job.processed,
      total: job.total,
      state: job.state,
      failures: job.failures,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    })
    return { id: created.id, ...job }
  }

  getJob(id: string): InitJob | null {
    const row = this.repo.getInitJob(id)
    if (!row) return null
    return {
      id: row.id,
      mode: row.mode,
      processed: row.processed,
      total: row.total,
      state: row.state,
      failures: row.failures,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }
  }

  updateJob(id: string, patch: Partial<InitJob>): InitJob {
    this.repo.updateInitJob(id, {
      processed: patch.processed,
      total: patch.total,
      state: patch.state,
      failures: patch.failures,
      finishedAt: patch.finishedAt,
    })
    const next = this.getJob(id)
    if (!next) throw new Error('boop: unknown initialization job')
    return next
  }

  setWatermarkNow(
    scopeId: string,
    heads: Array<{ sessionId: string; sourceGeneration: string; headSeq: number }>,
  ): number {
    let count = 0
    for (const head of heads) {
      if (!Number.isFinite(head.headSeq) || head.headSeq < 0) continue
      this.repo.upsertCursor({
        scopeId,
        sessionId: head.sessionId,
        sourceGeneration: head.sourceGeneration,
        throughSeq: head.headSeq,
        state: 'fresh',
      })
      count += 1
    }
    return count
  }

  countSources(): number {
    return this.sourceCount()
  }

  upsertFact(input: {
    scopeId: string
    factId: string
    ownerType: string
    ownerId: string
    kind: string
    text: string
    authority: string
    status?: string
  }): { version: number } {
    return this.repo.upsertFact(input)
  }

  facts(scopeId: string, ownerType: string, ownerId: string): Array<{ factId: string; status: string }> {
    return this.repo.facts(scopeId, ownerType, ownerId).map((fact) => ({ factId: fact.factId, status: fact.status }))
  }

  saveRule(input: {
    scopeId: string
    sourceFingerprint: string
    selector: unknown
    mode: 'exclude_source' | 'forget_fact' | 'exclude_scope'
  }): { id: string } {
    return this.repo.saveForgetRule(input)
  }

  rules(scopeId: string): Array<{ id: string; sourceFingerprint: string; selector: unknown; mode: string }> {
    return this.repo.forgetRules(scopeId)
  }

  audit(scopeId: string, kind: string, objectId: string | null, actor: string, reason?: string | null): unknown {
    return this.repo.audit(scopeId, kind, objectId, actor, reason ?? null)
  }

  tombstoneFacts(scopeId: string, factIds: string[]): string[] {
    return this.repo.tombstoneFacts(scopeId, factIds)
  }

  factIdsForSession(scopeId: string, sessionId: string): string[] {
    return this.repo.factIdsForSession(scopeId, sessionId)
  }

  activeFactIds(scopeId: string): string[] {
    return this.repo.activeFactIds(scopeId)
  }
}
