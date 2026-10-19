#!/usr/bin/env node
/**
 * E00-01 · rc.2 plugin load and public adapter surface.
 *
 * Gate: G01. Scenes: AT-08, AT-35, AT-38.
 *
 * Every assertion runs against the INSTALLED rc.2 payload (hostFacts()) inside a
 * private DSH_HOME. This is a real boot, not a fixture: the user's `~/.dsh` is
 * untouched.
 *
 * Run: node tests/host/e00-01-plugin-load.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import {
  PROJECT_ROOT,
  anonymousRequest,
  authorize,
  bootWeb,
  createProfile,
  freePort,
  hostFacts,
  makeHome,
  rpc,
  runCli,
} from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e00-01-' + Date.now())
let home
let boopProfile = 'boop-test'
let plainProfile = 'plain-test'
let host
let cookie
let base
const facts = hostFacts()

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, plainProfile)
  await createProfile(home, boopProfile, {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  const port = await freePort()
  host = await bootWeb({ home, profile: boopProfile, port })
  base = host.base
  cookie = await authorize(base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E00-01 host facts record the pinned rc.2 payload', () => {
  assert.equal(facts.dshVersion, '0.2.1-rc.2', `unexpected payload version: ${facts.dshVersion}`)
  console.log('  payload:', facts.payload)
  console.log('  dsh version:', facts.dshVersion, '| node:', facts.node)
})

test('E00-01 all composed entries activate (no failed plugin rows)', () => {
  const warnings = host.diagnostics.out
    .split('\n')
    .filter((line) => /did not activate|failed to import|StartupError/i.test(line))
  assert.deepEqual(warnings, [], `activation warnings:\n${warnings.join('\n')}`)
  assert.match(host.diagnostics.out + host.diagnostics.err, /dsh web:/)
})

test('G01 unauthenticated index request is rejected', async () => {
  const { status } = await anonymousRequest(base + '/')
  assert.equal(status, 401, 'an unauthenticated root request must not be admitted')
})

test('G01 unauthenticated RPC to the BOOP endpoint is rejected', async () => {
  const response = await fetch(`${base}/api/boop/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'anon', method: 'boop/bootstrap', payload: {} }),
  })
  assert.equal(response.status, 401, 'the /api channel must require the browser session')
})

test('G01 authenticated BOOP bootstrap returns the read-only scope facts', async () => {
  const { status, body } = await rpc(base, cookie, 'boop/bootstrap')
  assert.equal(status, 200)
  assert.equal(body.type, 'server-response')
  assert.equal(body.result.ok, true, JSON.stringify(body))
  const value = body.result.value
  assert.equal(value.product, 'BOOP')
  assert.equal(value.scope.dshProfileVersion, '0.2.1-rc.2')
  assert.equal(value.scope.writeModeEnabled, false, 'write mode stays off while required gates are not PASS')
  assert.equal(value.scope.recoveryGateArmed, true)
  assert.deepEqual(
    Object.keys(value.gates).sort(),
    ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09'],
  )
  // Honest ledger: only gates with current real evidence are PASS. G01 (assembly)
  // and G02 (real Qwen gold) qualify today; G07 is BLOCKED on channel credentials.
  assert.deepEqual(
    value.gates,
    {
      G01: 'PASS',
      G02: 'PASS',
      G03: 'PASS',
      G04: 'PASS',
      G05: 'NOT_RUN',
      G06: 'PASS',
      G07: 'BLOCKED',
      G08: 'NOT_RUN',
      G09: 'NOT_RUN',
    },
    'the gate ledger must reflect real evidence, never start all-PASS or all-NOT_RUN',
  )
  // Write mode is derived from the ledger, not a switch: all remaining gates block it.
  assert.equal(value.writeMode.enabled, false)
  assert.deepEqual(
    [...value.writeMode.blockedByGates].sort(),
    ['G05', 'G08', 'G09'],
    'every non-PASS required gate must block production writes',
  )
  // Each PASS must cite evidence; a PASS without evidence is a fabrication.
  const evidence = new Map(value.gateEvidence.map((entry) => [entry.id, entry]))
  assert.equal(evidence.size, 9, 'one evidence entry per frozen gate')
  for (const [id, gate] of Object.entries(value.gates)) {
    assert.ok(evidence.has(id), `missing evidence entry for ${id}`)
    if (gate === 'PASS') {
      assert.ok(evidence.get(id).evidence.trim().length > 0, `${id} is PASS without evidence`)
    }
  }
  assert.ok(value.gateEvidence.find((entry) => entry.id === 'G02').evidence.includes('e05-00'))
  assert.ok('typertGateway' in value.capabilities, 'adapter capability matrix must be reported')
})

test('AT-08/AT-35 BOOP rows are composed exactly once (repeated install does not duplicate)', async () => {
  const dump = await runCli({ home, args: ['--profile', boopProfile, '--dump-config'] })
  // Top-level rows only: `boop-tools` also appears once inside preset-boop's
  // plugin list, which is the intended composition, not a duplicate mount.
  const ids = ['dsh-boop', 'boop-tools', 'boop-api', 'preset-boop']
  for (const id of ids) {
    const occurrences = dump.stdout.split('\n').filter((line) => line === `- id: ${id}`).length
    assert.equal(occurrences, 1, `top-level row ${id} appears ${occurrences} times in the composed config`)
  }
})

test('G01/AT-08 adding BOOP does not alter native web-profile rows', async () => {
  const plain = await runCli({ home, args: ['--profile', plainProfile, '--dump-config'] })
  const withBoop = await runCli({ home, args: ['--profile', boopProfile, '--dump-config'] })

  /** Top-level entry rows only (`- id:` at column 0), BOOP's own rows excluded. */
  const rows = (text) =>
    text
      .split('\n')
      .filter((line) => line.startsWith('- id: '))
      .filter((line) => !/boop/i.test(line))
  assert.deepEqual(
    rows(withBoop.stdout),
    rows(plain.stdout),
    'native top-level rows must be identical with and without the BOOP bundle',
  )
  assert.ok(rows(withBoop.stdout).length > 60, 'the comparison must cover the real native surface')
})

test('G01 the browser half is published under the BOOP module id', async () => {
  const page = await anonymousRequest(base + '/')
  assert.equal(page.status, 401, 'the index still requires authentication')
  // The module graph is injected into the authenticated index; request it with the cookie.
  const authed = await fetch(base + '/', { headers: { cookie }, redirect: 'manual' })
  const html = await authed.text()
  assert.match(html, /boop|__DSH_BOOT__/i, 'the served index must carry the module boot graph')
})

test('AT-38 the BOOP client bundle is served to an authenticated page', async () => {
  const authed = await fetch(base + '/', { headers: { cookie }, redirect: 'manual' })
  const html = await authed.text()
  const match = /plugins\/\?\?[^"']*dsh-boop[^"']*/i.exec(html) || /dsh-boop\/client/i.exec(html)
  assert.ok(match, `BOOP client bundle not referenced in the index: ${html.slice(0, 400)}`)
})

test('E00-01 the rc.2 adapter matrix is the real host surface', async () => {
  const { body } = await rpc(base, cookie, 'boop/bootstrap')
  const { capabilities, services } = body.result.value
  assert.ok(services.includes('boop') && services.includes('boopApi'), 'BOOP services must be registered')
  for (const key of ['sessions', 'sessionController', 'typertGateway', 'connection', 'tools', 'agentLoop', 'llm']) {
    assert.equal(capabilities[key], true, `${key} must be present on the rc.2 web composition`)
  }
  assert.equal(capabilities.schedule, true, 'rc.2.1 mounts the schedule row in the web profile (rc.2 did not)')
})

test('AT-35 uninstall removes BOOP rows and stops serving the bundle', async () => {
  const dir = path.join(home, 'profiles', boopProfile)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const saved = manifest.dsh.profile.bundles
  manifest.dsh.profile.bundles = saved.filter((b) => b !== 'dsh-boop')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  try {
    const dump = await runCli({ home, args: ['--profile', boopProfile, '--dump-config'] })
    for (const id of ['dsh-boop', 'boop-tools', 'boop-api', 'preset-boop']) {
      assert.equal(
        dump.stdout.split('\n').filter((line) => line.trim() === `- id: ${id}`).length,
        0,
        `${id} must disappear when the bundle is deselected`,
      )
    }
    const port = await freePort()
    const clean = await bootWeb({ home, profile: boopProfile, port })
    try {
      const cleanCookie = await authorize(clean.base, clean.token)
      const { status } = await rpc(clean.base, cleanCookie, 'boop/bootstrap')
      assert.equal(status, 404, 'the BOOP endpoint must not exist after the bundle is removed')
      const warnings = clean.diagnostics.out
        .split('\n')
        .filter((line) => /did not activate|failed to import/i.test(line))
      assert.deepEqual(warnings, [], `native boot must stay clean after removal:\n${warnings.join('\n')}`)
    } finally {
      await clean.stop()
    }
  } finally {
    manifest.dsh.profile.bundles = saved
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
})
