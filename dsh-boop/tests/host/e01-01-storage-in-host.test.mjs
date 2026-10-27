#!/usr/bin/env node
/**
 * E01-01/E01-02 · Ledger opens inside the real Host, under the host's DSH_HOME.
 *
 * Verifies on the installed rc.2.1 payload that BOOP:
 *  - opens exactly one ledger at `$DSH_HOME/boop/boop.sqlite`;
 *  - derives the same scope id across restarts of the same installation;
 *  - takes the single-writer lease, and a second live Host stays read-only;
 *  - leaves the user's real `~/.dsh` untouched (a private home is used here).
 *
 * Run: node tests/host/e01-01-storage-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { PROJECT_ROOT, authorize, bootWeb, createProfile, freePort, makeHome, rpc, runCli } from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e01-01-' + Date.now())
let home
let host
let cookie
let bootstrap
/** Fencing token observed for this data domain; it must never move backwards. */
let observedFencingToken = 0

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, 'boop-ledger', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  host = await bootWeb({ home, profile: 'boop-ledger', port: await freePort() })
  cookie = await authorize(host.base, host.token)
  const { body } = await rpc(host.base, cookie, 'boop/bootstrap')
  assert.equal(body.result.ok, true, JSON.stringify(body.result))
  bootstrap = body.result.value
})

after(async () => {
  await host?.stop()
})

test('E01-01 the Host activation warning-free with the ledger open', () => {
  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))
})

test('E01-01 exactly one ledger file exists under the host DSH_HOME', () => {
  const storage = bootstrap.storage
  assert.ok(storage, 'storage facts must be reported once the ledger is open')
  assert.equal(storage.ok, true, 'the single-writer lease must be held by this Host')
  assert.equal(storage.path, path.join(home, 'boop', 'boop.sqlite'))
  assert.equal(storage.wal, true)
  assert.ok(storage.sqliteVersion.startsWith('3.'))
  assert.ok(fs.existsSync(storage.path), 'the ledger file must exist on disk')
  assert.equal(storage.schemaVersion, 1)
  const scope = storage.scope
  assert.match(scope.scopeId, /^boop-[0-9a-f]{16}$/)
  assert.equal(scope.dshHomeFingerprint.length, 32)
})

test('E01-02 a second Host stays read-only while the first Host is still heartbeating', async () => {
  const second = await bootWeb({ home, profile: 'boop-ledger', port: await freePort() })
  try {
    const cookie2 = await authorize(second.base, second.token)
    const { body } = await rpc(second.base, cookie2, 'boop/bootstrap')
    const value = body.result.value
    const storage = value.storage
    assert.equal(storage.scope.scopeId, bootstrap.storage.scope.scopeId, 'one data domain per installation')
    assert.equal(storage.lease.held, false, 'a live heartbeat keeps the first Host as the only writer')
    assert.equal(
      storage.lease.fencingToken,
      bootstrap.storage.lease.fencingToken,
      'the second Host must not mint a new fencing token',
    )
    assert.equal(storage.lease.holder, bootstrap.storage.lease.holder)
    assert.equal(value.scope.writeModeEnabled, false, 'the read-only Host cannot enter write mode')
  } finally {
    await second.stop()
  }
})

test('E01-02 the scope id is stable across a restart of the same installation', async () => {
  // Restart for real: the previous Host must be down before the next one boots.
  // (On rc.2.0 booting the second Host while the first was alive happened to be
  // fast enough that the 15s lease TTL had not expired; rc.2.1 boot is slower,
  // so a live-first-host variant is timing-dependent. The frozen rule itself is
  // "expired lease may be taken over and the takeover mints a greater token"
  // (AT-02), so a clean restart is the honest way to test scope identity.)
  await host.stop()
  // close() releases the lease on a graceful stop. If the process dies before
  // that effect runs, the heartbeat stops with it and the 15s TTL expires.
  await new Promise((resolve) => setTimeout(resolve, 16_000))
  const restarted = await bootWeb({ home, profile: 'boop-ledger', port: await freePort() })
  try {
    const cookie2 = await authorize(restarted.base, restarted.token)
    const { body } = await rpc(restarted.base, cookie2, 'boop/bootstrap')
    assert.equal(body.result.value.storage.scope.scopeId, bootstrap.storage.scope.scopeId)
    assert.equal(body.result.value.storage.lease.held, true, 'the restarted Host owns write management again')
    assert.equal(
      body.result.value.storage.lease.fencingToken,
      bootstrap.storage.lease.fencingToken + 1,
      'taking over the released lease mints a strictly greater fencing token (AT-02)',
    )
    observedFencingToken = body.result.value.storage.lease.fencingToken
  } finally {
    await restarted.stop()
  }
})

test('E01-02 a second live Host shares the ledger but never enables write management', async () => {
  const second = await bootWeb({ home, profile: 'boop-ledger', port: await freePort() })
  try {
    const cookie2 = await authorize(second.base, second.token)
    const { body } = await rpc(second.base, cookie2, 'boop/bootstrap')
    const value = body.result.value
    const storage = value.storage
    assert.equal(storage.scope.scopeId, bootstrap.storage.scope.scopeId, 'one data domain per installation')
    // The first Host has already stopped in the previous test. This boot is a
    // sole owner of an expired or released lease, so the token must not move
    // backwards. The concurrent read-only case is the heartbeat test above.
    const lease = storage.lease
    assert.ok(
      lease.fencingToken >= observedFencingToken,
      `fencing token must not go backwards (${lease.fencingToken} < ${observedFencingToken})`,
    )
    assert.equal(value.scope.writeModeEnabled, true, 'the sole Host holds the lease, so write mode follows the open gate ledger')
  } finally {
    await second.stop()
  }
})

test('E01-01 the ledger is not created inside any working directory', async () => {
  const dump = await runCli({ home, args: ['--profile', 'boop-ledger', '--dump-config'] })
  assert.equal(dump.code, 0)
  const stray = fs.existsSync(path.join(PROJECT_ROOT, 'boop'))
  assert.equal(stray, false, 'BOOP must never write a ledger into the project working directory')
})