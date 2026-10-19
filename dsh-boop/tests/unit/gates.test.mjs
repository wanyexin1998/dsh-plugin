#!/usr/bin/env node
/**
 * Frozen gate ledger honesty (write-mode gate).
 *
 * The production write mode must be DERIVED from evidence, never a hand-set
 * boolean. These tests pin the pure rules in src/host/gates.ts: a PASS needs
 * evidence, the required set is fixed, and enabling writes needs every required
 * gate PASS.
 *
 * Run: node --test tests/unit/gates.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FROZEN_GATES,
  GATE_LEDGER,
  WRITE_MODE_REQUIRED_GATES,
  assertLedgerHonest,
  gateMap,
  writeModeStatus,
} from '../../src/host/gates.ts'

test('G01–G09 ledger: every frozen gate appears exactly once and is honest', () => {
  assertLedgerHonest(GATE_LEDGER)
  assert.deepEqual(
    GATE_LEDGER.map((entry) => entry.id),
    [...FROZEN_GATES],
    'the ledger order is the frozen gate order',
  )
  for (const entry of GATE_LEDGER) {
    if (entry.state === 'PASS') {
      assert.ok(entry.evidence.trim().length > 0, `${entry.id} is PASS without evidence`)
    }
  }
})

test('the current ledger keeps write mode OFF with every non-PASS required gate listed', () => {
  const status = writeModeStatus()
  assert.equal(status.enabled, false, 'production writes must stay closed until all required gates pass')
  assert.deepEqual(
    [...status.blockedByGates].sort(),
    WRITE_MODE_REQUIRED_GATES.filter((id) => gateMap()[id] !== 'PASS').sort(),
  )
  assert.ok(status.blockedByGates.includes('G05'))
  assert.ok(status.blockedByGates.includes('G08'))
  assert.ok(status.blockedByGates.includes('G09'))
  assert.equal(status.blockedByGates.includes('G03'), false, 'G03 is PASS (real duplicate/disconnect reconciliation)')
  assert.equal(status.blockedByGates.includes('G04'), false, 'G04 is PASS (agent/pre-step runtime gate)')
  assert.equal(status.blockedByGates.includes('G06'), false, 'G06 is PASS (real host memory lifecycle/retrieval E2E)')
  assert.equal(status.blockedByGates.includes('G07'), false, 'optional IM channel gate must not block local writes')
  assert.match(status.note, /write mode stays OFF/u)
})

test('a PASS without evidence is rejected by the integrity check', () => {
  const fabricated = GATE_LEDGER.map((entry) =>
    entry.id === 'G09' ? { ...entry, state: 'PASS', evidence: '   ' } : entry,
  )
  assert.throws(() => assertLedgerHonest(fabricated), /PASS without evidence/u)
})

test('a synthetic all-PASS ledger enables write mode; one missing gate disables it', () => {
  const allPass = FROZEN_GATES.map((id) => ({ id, state: 'PASS', evidence: `synthetic evidence for ${id}` }))
  assert.equal(writeModeStatus(allPass).enabled, true)
  const missing = allPass.map((entry) => (entry.id === 'G05' ? { ...entry, state: 'NOT_RUN' } : entry))
  const status = writeModeStatus(missing)
  assert.equal(status.enabled, false)
  assert.deepEqual(status.blockedByGates, ['G05'])
})

test('BLOCKED is never PASS and is preserved in the map', () => {
  const gates = gateMap()
  assert.equal(gates.G07, 'BLOCKED')
  assert.notEqual(gates.G07, 'PASS')
})
