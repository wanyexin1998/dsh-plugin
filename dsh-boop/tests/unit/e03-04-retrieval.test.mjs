#!/usr/bin/env node
/**
 * E03-04 · Layered context assembly and lightweight retrieval.
 *
 * Run: node tests/unit/e03-04-retrieval.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ContextAssembler, consumedFactIds } from '../../src/host/memory/retrieval.ts'

function fact(overrides) {
  return {
    factId: 'f',
    layer: 'owner',
    kind: 'decision',
    text: '本阶段不部署生产',
    authority: 'user_confirmed',
    status: 'active',
    version: 1,
    evidence: [{ scopeId: 'scope', sessionId: 's1', sourceGeneration: 'g1', seq: 4 }],
    ...overrides,
  }
}

const facts = [
  fact({ factId: 'f-owner', layer: 'owner', text: '用户偏好中文简洁汇报' }),
  fact({ factId: 'f-ws', layer: 'workspace', text: '项目分屏方案按最新方案推进' }),
  fact({ factId: 'f-global', layer: 'global', text: '安全规则不可被记忆改写' }),
  fact({ factId: 'f-old', layer: 'owner', status: 'superseded', text: '旧版本结论' }),
  fact({ factId: 'f-forgot', layer: 'owner', text: '被遗忘的内容' }),
]

test('E03-04 layers stay separate and superseded facts never enter context', () => {
  const assembler = new ContextAssembler(null)
  const view = assembler.assemble({ scopeId: 'scope', query: '方案', facts, excludedFactIds: new Set(['f-forgot']) })
  assert.ok(view.body.includes('[owner/'))
  assert.ok(view.body.includes('[workspace/'))
  assert.ok(view.body.includes('[global/'))
  assert.equal(view.body.includes('旧版本结论'), false)
  assert.equal(view.body.includes('被遗忘的内容'), false)
  assert.deepEqual(new Set(view.hits.map((h) => h.layer)), new Set(['owner', 'workspace', 'global']))
})

test('E03-04 without the derived index retrieval degrades to exact match and says so', () => {
  const assembler = new ContextAssembler({ available: false, search: () => [] })
  const view = assembler.assemble({ scopeId: 'scope', query: '分屏方案', facts })
  assert.equal(view.degraded, true)
  assert.equal(view.hits[0].factId, 'f-ws', 'the exact match leads the context')
  assert.equal(view.hits[0].score, 1)
  // Standing facts stay in the context (they are the working memory), but they
  // never outrank a query match.
  const rest = view.hits.slice(1)
  assert.ok(rest.length > 0, 'unrelated facts are still available as standing context')
  assert.ok(rest.every((hit) => hit.score === 0))
})

test('E03-04 with FTS the ranking comes from the index and degradation is off', () => {
  const assembler = new ContextAssembler({
    available: true,
    search: () => [
      { factId: 'f-global', score: 9 },
      { factId: 'f-owner', score: 4 },
    ],
  })
  const view = assembler.assemble({ scopeId: 'scope', query: '安全', facts })
  assert.equal(view.degraded, false)
  assert.equal(view.hits[0].factId, 'f-global', 'the highest-scoring fact leads')
  assert.equal(view.hits[0].score, 9)
})

test('E03-04 every hit keeps its evidence address', () => {
  const assembler = new ContextAssembler(null)
  const view = assembler.assemble({ scopeId: 'scope', query: '中文', facts })
  for (const hit of view.hits) {
    assert.ok(hit.evidence.length > 0, 'a hit without evidence is not a hit')
    for (const evidence of hit.evidence) {
      assert.ok(evidence.scopeId && evidence.sessionId && evidence.sourceGeneration)
      assert.equal(typeof evidence.seq, 'number')
    }
  }
  assert.deepEqual(consumedFactIds(view.hits).map((row) => row.factId), view.hits.map((hit) => hit.factId))
})

test('E03-04 a moved source generation marks the hit stale instead of refreshing it', () => {
  const assembler = new ContextAssembler(null)
  const view = assembler.assemble({ scopeId: 'scope', query: '中文', facts })
  const moved = assembler.markStale(view.hits, new Map([['s1', 'g2']]))
  assert.ok(moved.every((hit) => hit.freshness === 'stale'))
  assert.equal(moved[0].text, view.hits[0].text, 'the text is not silently rewritten')
})

test('E03-04 the context budget is respected and truncation is reported', () => {
  const assembler = new ContextAssembler(null)
  const many = Array.from({ length: 20 }, (_, i) => fact({ factId: `f${i}`, layer: 'owner', text: `事实${i}` }))
  const view = assembler.assemble({
    scopeId: 'scope',
    query: '',
    facts: many,
    options: { budgetChars: 120, perLayerLimit: 50 },
  })
  assert.equal(view.truncated, true)
  assert.ok(view.body.length <= 120, 'the assembled body stays inside its budget')
})

test('E03-04 per-layer limits apply independently', () => {
  const assembler = new ContextAssembler(null)
  const many = [
    ...Array.from({ length: 5 }, (_, i) => fact({ factId: `o${i}`, layer: 'owner', text: `owner${i}` })),
    ...Array.from({ length: 2 }, (_, i) => fact({ factId: `w${i}`, layer: 'workspace', text: `ws${i}` })),
  ]
  const view = assembler.assemble({ scopeId: 'scope', query: '', facts: many, options: { budgetChars: 100000, perLayerLimit: 2 } })
  assert.equal(view.hits.filter((h) => h.layer === 'owner').length, 2)
  assert.equal(view.hits.filter((h) => h.layer === 'workspace').length, 2)
})