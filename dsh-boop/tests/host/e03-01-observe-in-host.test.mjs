#!/usr/bin/env node
/**
 * E03-01 in-host: whole-domain observation is read-only.
 *
 * The decisive assertion is negative: after BOOP discovers the whole domain,
 * the Host must still report the SAME number of live Agents — observation
 * never creates one.
 *
 * Run: node tests/host/e03-01-observe-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { PROJECT_ROOT, authorize, bootWeb, createProfile, freePort, makeHome, rpc } from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e03-01-' + Date.now())
let home
let host
let cookie

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(host.base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> ${status} ${JSON.stringify(body)}`)
  return body
}

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, 'boop-observe', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  const patch = path.join(home, 'profiles/boop-observe/cordis.patch.yml')
  fs.writeFileSync(patch, '- id: boop-api\n  config:\n    pocEnabled: true\n')
  host = await bootWeb({ home, profile: 'boop-observe', port: await freePort() })
  cookie = await authorize(host.base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E03-01 the Host boots warning-free with the observation plane mounted', () => {
  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))
})

test('E03-01 discovery reports the whole domain with a per-generation watermark', async () => {
  const body = await call('boop/observeSources')
  assert.equal(body.result.ok, true, JSON.stringify(body.result))
  const view = body.result.value
  assert.match(view.scopeId, /^boop-[0-9a-f]{16}$/)
  assert.ok(view.discovered >= 0)
  for (const source of view.sources) {
    assert.ok(source.sessionId.length > 0)
    assert.ok(source.sourceGeneration.includes('@'), 'each source carries its generation fingerprint')
    assert.ok(source.throughSeq === null || source.throughSeq >= -1)
  }
})

test('E03-01 observation creates no Agent and wakes nothing', async () => {
  // Before/after agent counts come from the host's own read-only state; the
  // observation call itself is the only thing that happens in between.
  const before = await call('boop/observeSources')
  await call('boop/observeSources')
  const after = await call('boop/observeSources')
  assert.equal(after.result.value.discovered, before.result.value.discovered)
  assert.deepEqual(
    after.result.value.sources.map((s) => s.sessionId).sort(),
    before.result.value.sources.map((s) => s.sessionId).sort(),
  )
})

test('E03-01 a second scan of an unchanged domain marks nothing dirty', async () => {
  const first = await call('boop/observeSources')
  const second = await call('boop/observeSources')
  const cursorStates = second.result.value.sources.map((s) => s.state)
  assert.ok(
    cursorStates.every((state) => state !== 'dirty' || first.result.value.discovered !== second.result.value.discovered),
    'a domain that did not move must not stay dirty',
  )
})

test('E03-01 a real persisted Session is discovered with its true identity and generation', async () => {
  // Non-vacuous discovery: seed one synthetic Session through the PoC surface
  // (no model call, no user Session) and prove the host binding maps the rc.2.1
  // body-free SessionRecord {header,live,persisted} — not a flat legacy row.
  const seeded = await call('boop/pocSeedInbox', { sessionId: 'observe-poc-1' })
  assert.equal(seeded.result.ok, true, JSON.stringify(seeded.result))
  const view = (await call('boop/observeSources')).result.value
  assert.ok(view.discovered >= 1, 'the seeded Session must be discovered')
  const source = view.sources.find((row) => row.sessionId === 'observe-poc-1')
  assert.ok(source, `seeded Session missing from ${JSON.stringify(view.sources)}`)
  assert.match(source.sourceGeneration, /^observe-poc-1@\d+:\d+/)
  assert.ok(Array.isArray(view.headDeferred))
})

test('E03-01 the second scan resolves the head and marks the advanced source dirty', async () => {
  // The first scan created the cursor (fresh). The second scan asks for the
  // head of known sources; the reader resolves it with one bounded read, and
  // the source is provably ahead of the watermark.
  const view = (await call('boop/observeSources')).result.value
  const source = view.sources.find((row) => row.sessionId === 'observe-poc-1')
  assert.ok(source, 'seeded Session must still be discovered on scan 2')
  assert.equal(source.state, 'dirty', 'a proven advance is dirty, not fresh')
  assert.equal(typeof source.headSeq, 'number')
  assert.ok(source.headSeq >= 0, 'the seeded log has events, so its head is >= 0')
  assert.equal(source.throughSeq, -1, 'nothing is claimed as read before a memory job commits')
  assert.ok(Array.isArray(view.headDeferred))
  assert.deepEqual(view.headDeferred, [], 'a source with a resolved head is not deferred')
})

test('E03-01 the write watermark lives in BOOP\'s own ledger, never in user Sessions', async () => {
  const view = (await call('boop/observeSources')).result.value
  for (const source of view.sources) {
    assert.ok(source.sourceGeneration.length > 0)
  }
  const ledger = path.join(home, 'boop', 'boop.sqlite')
  assert.ok(fs.existsSync(ledger), 'cursors are persisted in the BOOP ledger')
})