/**
 * Host initialization executor (E03-03 wired to the ledger).
 *
 * `initPlan` stays read-only. `applyInitialization` writes only when this
 * process holds the writer lease AND the frozen gate ledger has enabled write
 * mode. Otherwise it returns the same honest refusal as the plan, with
 * `executed: false` and zero ledger writes.
 *
 * 从现在开始 sets watermarks to heads the reader actually resolved.
 * 学习已有会话 reads each resolved source once and records a failure when the
 * log cannot be read. It does not call the model.
 * 导入记忆 never reads a path and never executes a file; a click without a
 * confirmed preview writes nothing.
 */

import type { InitPlanFacts } from '../main-session.ts'
import { initPlanFacts } from '../main-session.ts'
import { LedgerInitStore } from './ledger-init-store.ts'
import { MemoryLifecycle, type InitMode } from './lifecycle.ts'

export interface InitHead {
  sessionId: string
  sourceGeneration: string
  headSeq: number | null
}

export async function collectInitHeads(ctx: any): Promise<InitHead[]> {
  const reader = ctx.boop?.sourceReader?.()
  if (!reader || typeof reader.listSources !== 'function') return []
  const listed = await reader.listSources({})
  const ids = new Set<string>()
  for (const row of listed ?? []) {
    if (typeof row?.sessionId === 'string' && row.sessionId !== '') ids.add(row.sessionId)
  }
  const sources = ids.size === 0 ? listed : await reader.listSources({ resolveHeadFor: ids })
  return (sources ?? []).map((row: InitHead) => ({
    sessionId: String(row.sessionId ?? ''),
    sourceGeneration: String(row.sourceGeneration ?? ''),
    headSeq: typeof row.headSeq === 'number' ? row.headSeq : null,
  }))
}

export async function applyInitialization(
  ctx: any,
  modeInput: unknown,
  heads: InitHead[] = [],
): Promise<InitPlanFacts> {
  const plan = await initPlanFacts(ctx, modeInput)
  const storage = ctx.boop?.storage?.()
  const writable = plan.writeModeEnabled === true && plan.storage?.writable === true && storage?.repo
  if (!writable) return plan

  const scopeId = storage.identity.scopeId as string
  const resolved = heads.filter(
    (head): head is { sessionId: string; sourceGeneration: string; headSeq: number } =>
      typeof head.sessionId === 'string' &&
      typeof head.sourceGeneration === 'string' &&
      typeof head.headSeq === 'number' &&
      head.headSeq >= 0,
  )
  const lifecycle = new MemoryLifecycle(new LedgerInitStore(storage.repo, scopeId, () => resolved.length))
  const mode = plan.mode as InitMode

  if (mode === 'import_memory') {
    return {
      ...plan,
      state: 'unavailable',
      executed: false,
      reason: 'import-needs-preview',
      copy: '导入必须先给出已确认的预览。本次没有读取任何文件，也没有执行任何内容。',
    }
  }

  if (mode === 'from_now') {
    const job = lifecycle.startInitialization(scopeId, 'from_now')
    const done = lifecycle.applyFromNow({ scopeId, jobId: job.id, heads: resolved })
    const unresolved = heads.length - resolved.length
    const gap = unresolved > 0 ? `另有 ${unresolved} 个来源的水位还读不到，没有把它们记成已覆盖。` : ''
    return {
      ...plan,
      state: 'available',
      executed: true,
      reason: 'watermarked',
      processed: done.processed,
      total: done.processed,
      copy: `已从当前水位开始。${done.processed} 个来源只记录此后的新内容，没有导入旧历史。${gap}`,
    }
  }

  const job = lifecycle.startInitialization(scopeId, 'learn_history')
  const results = await readLearnSources(ctx, resolved)
  const done = lifecycle.advanceLearnHistory({ scopeId, jobId: job.id, results })
  return {
    ...plan,
    state: 'available',
    executed: true,
    reason: done.state === 'done' ? 'learned' : 'job-running',
    processed: done.processed,
    total: done.total,
    copy: lifecycle.progressCopy(done),
  }
}

async function readLearnSources(
  ctx: any,
  heads: Array<{ sessionId: string; sourceGeneration: string; headSeq: number }>,
): Promise<Array<{ objectId: string; ok: boolean; reason?: string }>> {
  const reader = ctx.boop?.sourceReader?.()
  const results: Array<{ objectId: string; ok: boolean; reason?: string }> = []
  for (const head of heads) {
    if (typeof reader?.listEvents !== 'function') {
      results.push({ objectId: head.sessionId, ok: false, reason: 'reader-unavailable' })
      continue
    }
    try {
      await reader.listEvents(head.sessionId, 0, 1)
      results.push({ objectId: head.sessionId, ok: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unreadable'
      results.push({ objectId: head.sessionId, ok: false, reason })
    }
  }
  return results
}
