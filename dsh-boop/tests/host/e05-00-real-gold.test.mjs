#!/usr/bin/env node
/**
 * E05-00 · REAL-GOLD integration probe (Gate G02).
 *
 * This test talks to the user's actual self-hosted Qwen service. It is opt-in:
 * without `BOOP_QWEN_BASE_URL` + `BOOP_QWEN_MODEL` it SKIPS (never fakes PASS).
 * The frozen progress is never inferred from the model name or the "196k"
 * label — the effective context integer comes from the service and every
 * capability is exercised with a real request.
 *
 * Run:
 *   $env:BOOP_QWEN_BASE_URL="http://172.26.0.49:8000/v1"
 *   $env:BOOP_QWEN_MODEL="qwen3.8-27b"
 *   node --test --test-force-exit tests/host/e05-00-real-gold.test.mjs
 *
 * Evidence writer (also records near/over-limit observations):
 *   node tools/qwen-gold.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL_CONFIG } from '../../src/host/model/qwen-adapter.ts'
import { NO_CREDENTIAL } from '../../src/host/model/qwen-client.ts'
import { runGoldProbe } from '../../src/host/model/qwen-probe.ts'

const BASE_URL = process.env.BOOP_QWEN_BASE_URL?.trim() ?? ''
const MODEL_ID = process.env.BOOP_QWEN_MODEL?.trim() ?? ''
const ENABLED = BASE_URL !== '' && MODEL_ID !== ''

const config = {
  ...DEFAULT_MODEL_CONFIG,
  providerId: process.env.BOOP_QWEN_PROVIDER_ID?.trim() || 'qwen-vllm-local',
  modelId: MODEL_ID || null,
  baseUrl: BASE_URL || null,
  credentialRef: process.env.BOOP_QWEN_KEY ? 'env:BOOP_QWEN_KEY' : NO_CREDENTIAL,
  declaredContext: process.env.BOOP_QWEN_DECLARED_CONTEXT?.trim() || '196k',
  quantization: process.env.BOOP_QWEN_QUANTIZATION?.trim() || '4bit',
}

// One probe per file: the ladder is expensive (real prefill of 8k/32k/64k).
let evidencePromise = null
async function probe() {
  if (!ENABLED) return null
  evidencePromise ??= runGoldProbe(config)
  return await evidencePromise
}

test('E05-00 the live service is configured (real gold is opt-in)', { skip: ENABLED ? false : 'set BOOP_QWEN_BASE_URL and BOOP_QWEN_MODEL to run the real gold probe' }, async () => {
  assert.ok(BASE_URL, 'BOOP_QWEN_BASE_URL is required')
  assert.ok(MODEL_ID, 'BOOP_QWEN_MODEL is required')
})

test('E05-00 the configured model is actually served; the context integer comes from the service', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  console.log('  served models:', gold.server.servedModelIds.join(', '))
  console.log('  server max_model_len:', gold.server.maxModelLen, '| root:', gold.server.root)
  assert.equal(gold.server.modelFound, true, 'the configured model id must exist on the service, never be renamed')
  assert.equal(typeof gold.contextWindowTokens, 'number')
  assert.ok((gold.contextWindowTokens ?? 0) > 64 * 1024, 'the verified limit must exceed the 64k ladder rung')
  // The label "196k" is 196000; the service integer must not be copied from it.
  assert.notEqual(gold.contextWindowTokens, 196_000, '196000 must never be inferred from the label; the service integer wins')
})

test('E05-00 basic response, tool call, Unicode arguments and multi-step chain pass on the real service', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  const byId = new Map(gold.steps.map((step) => [step.id, step]))
  for (const id of ['basic-response', 'tool-call', 'unicode-arguments', 'multi-step']) {
    const step = byId.get(id)
    assert.equal(step?.state, 'PASS', `${id} -> ${step?.state}: ${step?.detail}`)
  }
  assert.equal(byId.get('tool-call')?.state, 'PASS', 'no tool call means BOOP may only chat read-only')
})

test('E05-00 strict JSON extraction and truncated-output rejection pass on the real service', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  const step = gold.steps.find((entry) => entry.id === 'strict-json')
  assert.equal(step?.state, 'PASS', `strict-json -> ${step?.state}: ${step?.detail}`)
  assert.match(
    step?.detail ?? '',
    /tiny-budget .*guard=ok/iu,
    'a truncated output must never be committable (the guard must be proven, not assumed)',
  )
})

test('E05-00 cancellation settles on the client without claiming a server stop', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  const step = gold.steps.find((entry) => entry.id === 'cancel')
  assert.equal(step?.state, 'PASS', `cancel -> ${step?.state}: ${step?.detail}`)
  assert.match(step?.detail ?? '', /server-side release is not claimed/iu)
})

test('E05-00 the real context ladder runs at 8k/32k/64k and the measured integers are honest', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  const step = gold.steps.find((entry) => entry.id === 'context-ladder')
  assert.equal(step?.state, 'PASS', `context-ladder -> ${step?.state}: ${step?.detail}`)
  const observed = gold.observations.ladderPromptTokens
  assert.equal(observed.length, 3)
  for (const [index, target] of [8000, 32000, 64000].entries()) {
    const actual = observed[index] ?? 0
    assert.ok(actual >= target * 0.75 && actual <= target * 1.5, `${target} target measured ${actual}`)
  }
  console.log('  ladder prompt tokens:', observed.join(' / '))
})

test('E05-00 token accounting is present and consistent; no advertised capacity is used as budget', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  const step = gold.steps.find((entry) => entry.id === 'token-accounting')
  assert.equal(step?.state, 'PASS', `token-accounting -> ${step?.state}: ${step?.detail}`)
  assert.equal(gold.config.externalFallbackAllowed, false, 'external fallback is structurally disabled')
})

test('G02 the probe outcome maps to capability gates, never to a score', { skip: ENABLED ? false : 'opt-in' }, async () => {
  const gold = await probe()
  assert.ok(gold)
  assert.equal(gold.outcome.allowed.readOnlyChat, true)
  assert.equal(gold.outcome.allowed.memoryJobs, true)
  assert.equal(gold.outcome.allowed.autonomousDispatch, true, 'tool-call + multi-step verified on the real service')
  assert.equal(gold.outcome.allowed.historyBatchLearning, true, 'strict JSON + ladder + verified context')
  assert.equal(gold.outcome.effectiveContextLimit, gold.contextWindowTokens)
})
