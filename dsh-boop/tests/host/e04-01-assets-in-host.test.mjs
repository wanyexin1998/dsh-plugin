#!/usr/bin/env node
/**
 * E04-01 · The real 3D character is served and loadable.
 *
 * Asserts on the installed rc.2 payload:
 *  - the exact asset routes exist and require the browser session;
 *  - the GLB is served byte-identical to the asset package (sha256 from its
 *    MANIFEST), so the plugin ships the user's approved model, not a rebuild;
 *  - the state PNGs and the player are served with correct types;
 *  - unknown paths are 404 (the whitelist holds);
 *  - ETag revalidation returns 304.
 *
 * Run: node tests/host/e04-01-assets-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { PROJECT_ROOT, anonymousRequest, authorize, bootWeb, createProfile, freePort, makeHome, rpc } from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e04-01-assets-' + Date.now())
const EXPECTED_GLB_SHA = '379e9845c597681f53b90e851bcb88ee31a01a1ace80b3e63478539f4807b56b'
let home
let host
let cookie

before(async () => {
  fs.mkdirSync(WORK, { recursive: true })
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, 'boop-3d', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  const patch = path.join(home, 'profiles/boop-3d/cordis.patch.yml')
  fs.writeFileSync(patch, '- id: boop-api\n  config:\n    pocEnabled: true\n')
  host = await bootWeb({ home, profile: 'boop-3d', port: await freePort() })
  cookie = await authorize(host.base, host.token)
})

after(async () => {
  await host?.stop()
})

test('E04-01 the host boots with the asset row armed and no activation warnings', () => {
  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], warnings.join('\n'))
})

test('E04-01 the model is served byte-identical to the approved asset package', async () => {
  const response = await fetch(`${host.base}/api/boop/model.glb`, { headers: { cookie } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'model/gltf-binary')
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  assert.equal(sha, EXPECTED_GLB_SHA, 'the GLB must be the exact file from the asset package')
  assert.ok(bytes.length > 1_000_000, `unexpected size ${bytes.length}`)
  // GLB magic + declared length must agree with the payload we actually got.
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'glTF magic')
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'declared length matches the body')
})

test('E04-01 the player module and every state PNG are served', async () => {
  const player = await fetch(`${host.base}/api/boop/player.js`, { headers: { cookie } })
  assert.equal(player.status, 200)
  assert.match(player.headers.get('content-type') ?? '', /javascript/)
  const source = await player.text()
  assert.match(source, /export class BoopAssistant/, 'the player keeps its public export')

  for (const state of ['idle', 'listen', 'think', 'success', 'error']) {
    const response = await fetch(`${host.base}/api/boop/state-${state}.png`, { headers: { cookie } })
    assert.equal(response.status, 200, `${state} PNG`)
    assert.equal(response.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.readUInt32BE(0), 0x89504e47, `${state} is a real PNG`)
    assert.equal(bytes[25], 6, `${state} PNG carries an alpha channel (RGBA)`)
  }
})

test('G01 the character assets are NOT public: anonymous access is rejected', () => {
  return (async () => {
    for (const route of ['/api/boop/model.glb', '/api/boop/player.js', '/api/boop/state-idle.png']) {
      const { status } = await anonymousRequest(host.base + route)
      assert.equal(status, 401, `${route} must require the browser session`)
    }
  })()
})

test('E04-01 the whitelist holds: no other path under the prefix is served', async () => {
  for (const probe of ['/api/boop/boop.sqlite', '/api/boop/../package.json', '/api/boop/unknown.bin']) {
    const response = await fetch(`${host.base}${probe}`, { headers: { cookie } })
    assert.ok([400, 403, 404].includes(response.status), `${probe} → ${response.status}`)
  }
})

test('E04-01 ETag revalidation avoids re-sending 1.3 MB', async () => {
  const first = await fetch(`${host.base}/api/boop/model.glb`, { headers: { cookie } })
  const etag = first.headers.get('etag')
  assert.ok(etag, 'an ETag is exposed')
  await first.arrayBuffer()
  const second = await fetch(`${host.base}/api/boop/model.glb`, { headers: { cookie, 'if-none-match': etag } })
  assert.equal(second.status, 304)
})

test('E04-01 the client bundle ships the 3D player and the state mapping', async () => {
  const index = await fetch(`${host.base}/`, { headers: { cookie } })
  const html = await index.text()
  const match = /plugins\/\?\?dsh-boop\/client\.js&rev=([a-f0-9]+)/.exec(html)
  assert.ok(match, 'the BOOP client module is referenced by the index')
  const bundle = await fetch(`${host.base}/plugins/??dsh-boop/client.js&rev=${match[1]}`, { headers: { cookie } })
  const source = await bundle.text()
  assert.match(source, /BoopAssistant/, 'the player is bundled into the client half')
  assert.match(source, /\/api\/boop\/model\.glb/, 'the model URL is the host asset route')
  assert.match(source, /data-boop-3d-fallback/, 'the still-PNG fallback exists')
  assert.match(source, /prefers-reduced-motion/, 'reduced motion is honoured')
})

test('E04-01 bootstrapping still reports a consistent data domain with the asset row present', async () => {
  const { body } = await rpc(host.base, cookie, 'boop/bootstrap')
  assert.equal(body.result.ok, true, JSON.stringify(body.result))
  assert.equal(body.result.value.scope.writeModeEnabled, true)
  assert.ok(Array.isArray(body.result.value.services))
})