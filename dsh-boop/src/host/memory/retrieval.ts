/**
 * Layered project context and lightweight retrieval (E03-04).
 *
 * Frozen behaviour (03§15, 03§16):
 *  - context is assembled in layers: owner facts -> workspace facts -> global
 *    facts, each layer bounded, newest-effective first;
 *  - retrieval is FTS5 first when the derived index exists, and degrades to an
 *    exact/substring query when it does not — never to a weaker POLICY;
 *  - every hit carries its evidence address (scopeId, sessionId,
 *    sourceGeneration, seq), so "你怎么知道的" is always answerable;
 *  - a hit whose source generation moved on is returned as stale, not dropped
 *    and not silently refreshed;
 *  - a forgotten source contributes nothing to either context or retrieval.
 */

export interface EvidenceAddress {
  scopeId: string
  sessionId: string
  sourceGeneration: string
  seq: number
}

export interface ContextFact {
  factId: string
  layer: 'owner' | 'workspace' | 'global'
  kind: string
  text: string
  authority: string
  status: string
  version: number
  evidence: EvidenceAddress[]
}

export interface RetrievalHit {
  factId: string
  layer: ContextFact['layer']
  text: string
  score: number
  evidence: EvidenceAddress[]
  freshness: 'current' | 'stale'
}

export interface RetrievalIndex {
  /** Whether the derived full-text index is present on this deployment. */
  available: boolean
  /** FTS-backed ranked query; returns [] when the index is unavailable. */
  search(input: { scopeId: string; query: string; limit: number }): Array<{ factId: string; score: number }>
}

export interface RetrievalOptions {
  /** Character budget for the assembled context body. */
  budgetChars: number
  perLayerLimit: number
}

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = { budgetChars: 6000, perLayerLimit: 12 }

export class ContextAssembler {
  private readonly index: RetrievalIndex | null

  constructor(index: RetrievalIndex | null) {
    this.index = index
  }

  indexAvailable(): boolean {
    return Boolean(this.index?.available)
  }

  /**
   * Assemble the layered context for one query.
   *
   * Layers never mix silently: each fact keeps its layer so the UI can explain
   * why it saw something.
   */
  assemble(input: {
    scopeId: string
    query: string
    facts: ContextFact[]
    excludedFactIds?: ReadonlySet<string>
    options?: RetrievalOptions
  }): { body: string; hits: RetrievalHit[]; truncated: boolean; degraded: boolean } {
    const options = input.options ?? DEFAULT_RETRIEVAL_OPTIONS
    const excluded = input.excludedFactIds ?? new Set<string>()
    const usable = input.facts.filter((fact) => !excluded.has(fact.factId) && fact.status !== 'superseded')

    // Rank with the derived index when present; otherwise fall back to an exact
    // substring match and SAY so (degraded), never pretend it was ranked.
    let scores = new Map<string, number>()
    let degraded = false
    const indexed = this.index && this.index.available ? this.index.search({ scopeId: input.scopeId, query: input.query, limit: options.perLayerLimit * 3 }) : []
    if (indexed.length > 0) {
      scores = new Map(indexed.map((row) => [row.factId, row.score]))
    } else {
      degraded = true
      const needle = input.query.trim()
      for (const fact of usable) {
        if (needle && fact.text.includes(needle)) scores.set(fact.factId, 1)
      }
    }

    // Ranking leads; the layer only breaks ties, because a query-ranked
    // workspace fact must outrank an unrelated owner fact — and vice versa.
    const layerRank = new Map<ContextFact['layer'], number>([
      ['owner', 0],
      ['workspace', 1],
      ['global', 2],
    ])
    const chosen: RetrievalHit[] = usable
      .map((fact) => ({
        factId: fact.factId,
        layer: fact.layer,
        text: fact.text,
        score: scores.get(fact.factId) ?? 0,
        evidence: fact.evidence,
        freshness: 'current' as const,
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (layerRank.get(a.layer) ?? 9) - (layerRank.get(b.layer) ?? 9) ||
          b.evidence.length - a.evidence.length,
      )

    // Per-layer limits apply after ranking, so no layer can flood the budget.
    const perLayer = new Map<ContextFact['layer'], number>()
    const limited: RetrievalHit[] = []
    for (const hit of chosen) {
      const used = perLayer.get(hit.layer) ?? 0
      if (used >= options.perLayerLimit) continue
      perLayer.set(hit.layer, used + 1)
      limited.push(hit)
    }

    const { lines, truncated } = renderBudgeted(limited, options.budgetChars)
    return { body: lines.join('\n'), hits: limited, truncated, degraded }
  }

  /**
   * Mark hits whose source moved on since the fact was written (03§16:
   * "证据缺失 → 来源当前不可读取，结论未重新验证").
   */
  markStale(hits: RetrievalHit[], currentGenerations: Map<string, string>): RetrievalHit[] {
    return hits.map((hit) => {
      const moved = hit.evidence.some(
        (evidence) => currentGenerations.get(evidence.sessionId) !== undefined && currentGenerations.get(evidence.sessionId) !== evidence.sourceGeneration,
      )
      return moved ? { ...hit, freshness: 'stale' as const } : hit
    })
  }
}

function renderBudgeted(hits: RetrievalHit[], budgetChars: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const hit of hits) {
    const line = `- [${hit.layer}/${hit.freshness}] ${hit.text}`
    if (used + line.length > budgetChars) {
      truncated = true
      continue
    }
    lines.push(line)
    used += line.length
  }
  return { lines, truncated }
}

/** Fact ids inside an assembled context — used by consumption records (03§17). */
export function consumedFactIds(hits: RetrievalHit[]): Array<{ factId: string; freshness: string }> {
  return hits.map((hit) => ({ factId: hit.factId, freshness: hit.freshness }))
}