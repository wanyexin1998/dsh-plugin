import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactAvailable, dwsBinary, freePort, tmpState } from './fixtures/harness.mjs'

const skip = !artifactAvailable
const entry = fileURLToPath(new URL('../lib/main.mjs', import.meta.url))
const node = process.execPath

test('built CLI entry has exactly one shebang and runs version', { skip }, () => {
  const text = readFileSync(entry, 'utf8')
  assert.equal(text.split('\n')[0], '#!/usr/bin/env node')
  assert.equal(
    text.split('\n').filter((line) => line.startsWith('#!')).length,
    1,
    'duplicate shebang breaks node execution',
  )
  const version = spawnSync(node, [entry, 'version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^dsh-dingtalk-connector 0\.1\.0 \(protocol 1\)$/m)
})
test(
  'built CLI serve starts and health succeeds with the loopback test transport',
  { skip, timeout: 60000 },
  async () => {
    const isolated = tmpState()
    const port = await freePort()
    const env = {
      ...process.env,
      DSH_CONNECTOR_STATE_DIR: isolated.stateDir,
      DSH_CONNECTOR_DWS_BINARY: dwsBinary,
      DSH_CONNECTOR_TRANSPORT: 'loopback',
      DSH_CONNECTOR_ALLOW_TEST_TRANSPORT: '1',
      DSH_CONNECTOR_LOOPBACK_PORT: String(port),
    }
    const child = spawn(node, [entry, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    try {
      for (let attempt = 0; attempt < 200 && !stdout.includes('connector.started'); attempt++)
        await new Promise((done) => setTimeout(done, 25))
      assert.match(stdout, /"event":"connector\.started"/, stderr)
      const health = spawnSync(node, [entry, 'health'], { encoding: 'utf8', env, timeout: 20000 })
      assert.equal(health.status, 0, health.stderr)
      const report = JSON.parse(health.stdout)
      assert.equal(report.ok, true)
      assert.equal(report.value.protocol, 1)
      const version = spawnSync(node, [entry, 'version'], { encoding: 'utf8', env })
      assert.equal(version.status, 0)
      const token = (await readFile(join(isolated.stateDir, 'admin.token'), 'utf8')).trim()
      assert.equal(token.length, 64)
      const bundle = readFileSync(fileURLToPath(new URL('../lib/connector.mjs', import.meta.url)), 'utf8')
      assert.ok(!/fake-dws|tests\/fixtures/.test(bundle), 'test fixtures must not be bundled into the runtime entry')
    } finally {
      child.kill()
      await new Promise((done) => child.once('exit', done))
      await rm(isolated.root, { recursive: true, force: true })
    }
  },
)
test('built CLI exits 2 for invalid configuration', { skip }, async () => {
  const isolated = await mkdtemp(join(tmpdir(), 'dsh-cli-invalid-'))
  try {
    const result = spawnSync(node, [entry, 'serve'], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        DSH_CONNECTOR_STATE_DIR: isolated,
        DSH_CONNECTOR_DWS_BINARY: '',
        DSH_CONNECTOR_TRANSPORT: 'unix',
      },
    })
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /DSH_CONNECTOR_DWS_BINARY/)
  } finally {
    await rm(isolated, { recursive: true, force: true })
  }
})
