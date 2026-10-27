#!/usr/bin/env node
/**
 * A profile flag cannot open PoC endpoints unless the process was started
 * with BOOP_ALLOW_POC=1. The install steps never set that variable.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { configureApi, POC_API_METHODS, PRODUCTION_API_METHODS } from '../../src/host/api-service.ts'
import { pocRequested } from '../../src/host/poc-switch.ts'

const root = path.resolve(import.meta.dirname, '../..')

test('pocRequested ignores a profile flag unless the test switch is set', () => {
  const previous = process.env.BOOP_ALLOW_POC
  delete process.env.BOOP_ALLOW_POC
  assert.equal(pocRequested(true), false)
  assert.equal(pocRequested(false), false)
  process.env.BOOP_ALLOW_POC = '1'
  assert.equal(pocRequested(true), true)
  assert.equal(pocRequested('true'), false)
  if (previous === undefined) delete process.env.BOOP_ALLOW_POC
  else process.env.BOOP_ALLOW_POC = previous
})

test('configureApi keeps PoC off when only the profile flag is set', () => {
  const previous = process.env.BOOP_ALLOW_POC
  delete process.env.BOOP_ALLOW_POC
  const closed = configureApi({ pocEnabled: true })
  assert.equal(closed.pocEnabled, false)
  process.env.BOOP_ALLOW_POC = '1'
  const open = configureApi({ pocEnabled: true })
  assert.equal(open.pocEnabled, true)
  configureApi({ pocEnabled: false })
  if (previous === undefined) delete process.env.BOOP_ALLOW_POC
  else process.env.BOOP_ALLOW_POC = previous
})

test('the shipped cordis patch does not enable PoC', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.equal(/pocEnabled:\s*true/u.test(patch), false)
})

test('production API registration does not include PoC methods', () => {
  for (const method of PRODUCTION_API_METHODS) {
    assert.equal(method.startsWith('poc'), false, method)
  }
  assert.ok(POC_API_METHODS.length > 0)
  for (const method of POC_API_METHODS) {
    assert.equal(method.startsWith('poc'), true, method)
    assert.equal(PRODUCTION_API_METHODS.includes(method), false)
  }
})
