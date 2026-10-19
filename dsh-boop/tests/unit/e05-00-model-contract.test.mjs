#!/usr/bin/env node
/**
 * E05-00 · Self-hosted Qwen adapter contract (Gate G02 preparation).
 *
 * These are CONTRACT tests against the adapter logic with an explicit test
 * double for the transport. They prove BOOP's own behaviour — refusal to guess
 * parameters, conservative clamping, capability gating, no external fallback.
 * They do NOT prove that the user's quantized service answers correctly: that
 * needs real credentials (IN-01/IN-02/IN-03) and stays BLOCKED.
 *
 * Run: node tests/unit/e05-00-model-contract.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_MODEL_CONFIG,
  ModelConfigurationError,
  PROBE_LADDER,
  assertConfigured,
  clampRequest,
  evaluateCapabilities,
} from '../../src/host/model/qwen-adapter.ts'

const configured = {
  ...DEFAULT_MODEL_CONFIG,
  baseUrl: 'https://qwen.internal/v1',
  providerId: 'qwen-local',
  modelId: 'qwen3.8-27b',
  credentialRef: 'env:QWEN_API_KEY',
  declaredContext: '196k',
  quantization: '4bit',
}

test('E05-00 an unconfigured route is refused, never guessed', () => {
  assert.throws(() => assertConfigured(DEFAULT_MODEL_CONFIG), ModelConfigurationError)
  assert.throws(() => assertConfigured(DEFAULT_MODEL_CONFIG), /never guesses/)
})

test('E05-00 the declared 196k label is not a budget', () => {
  // Declared, unverified: requests must be refused rather than sized from 196k.
  assert.throws(() => clampRequest(10_000, 2_000, configured), /contextWindowTokens is unknown/)
  const measured = { ...configured, contextWindowTokens: 32_768 }
  const clamped = clampRequest(10_000, 2_000, measured)
  assert.equal(clamped, 10_000)
  // Beyond the verified limit the request is clamped, not rejected silently.
  assert.ok(clampRequest(1_000_000, 2_000, measured) < 32_768)
})

test('E05-00 an output reserve that cannot fit is refused', () => {
  const tiny = { ...configured, contextWindowTokens: 2_000 }
  assert.throws(() => clampRequest(10, 1_900, tiny), /exceed the verified context limit/)
})

test('G02 capability gating: failures narrow what BOOP may do', () => {
  const nothing = evaluateCapabilities(PROBE_LADDER.map((p) => ({ id: p.id, state: 'NOT_RUN' })), null)
  assert.equal(nothing.allowed.readOnlyChat, false)
  assert.equal(nothing.allowed.autonomousDispatch, false)

  const chatOnly = evaluateCapabilities(
    [
      { id: 'basic-response', state: 'PASS' },
      { id: 'tool-call', state: 'FAIL' },
      { id: 'strict-json', state: 'NOT_RUN' },
      { id: 'multi-step', state: 'NOT_RUN' },
      { id: 'context-ladder', state: 'NOT_RUN' },
    ],
    null,
  )
  assert.equal(chatOnly.allowed.readOnlyChat, true)
  assert.equal(chatOnly.allowed.memoryJobs, false, 'no strict JSON means no memory extraction')
  assert.equal(chatOnly.allowed.autonomousDispatch, false, 'no tool call means no autonomous dispatch')
  assert.equal(chatOnly.allowed.historyBatchLearning, false, 'no verified context means no batch learning')

  const full = evaluateCapabilities(
    [
      { id: 'basic-response', state: 'PASS' },
      { id: 'tool-call', state: 'PASS' },
      { id: 'strict-json', state: 'PASS' },
      { id: 'multi-step', state: 'PASS' },
      { id: 'context-ladder', state: 'PASS' },
    ],
    32_768,
  )
  assert.equal(full.allowed.autonomousDispatch, true)
  assert.equal(full.allowed.historyBatchLearning, true)
  assert.equal(full.effectiveContextLimit, 32_768)
})

test('G02 external fallback stays disabled even when a route is configured', () => {
  assert.throws(() => assertConfigured({ ...configured, externalFallbackAllowed: true }), /fallback must stay disabled/)
  assert.equal(configured.externalFallbackAllowed, false)
})

test('E05-00 the probe ladder keeps the frozen order', () => {
  assert.deepEqual(
    PROBE_LADDER.map((p) => p.id),
    ['basic-response', 'tool-call', 'unicode-arguments', 'multi-step', 'strict-json', 'cancel', 'context-ladder', 'token-accounting'],
  )
})

test('G02 ledger stays honest: no probe result may be assumed', () => {
  const all = evaluateCapabilities(
    PROBE_LADDER.map((p) => ({ id: p.id, state: 'NOT_RUN' })),
    32_768,
  )
  assert.ok(all.capabilities.every((c) => c.state === 'NOT_RUN'))
  assert.equal(all.allowed.readOnlyChat, false, 'an unverified service is not usable')
})
