#!/usr/bin/env node
/**
 * E02-04 in-host · workspace & Session management plane on DSH 0.2.1-rc.2.
 *
 * Gates: G01 (compose/auth/read-only adapter surface), G05 (server-side
 * authority + fail-closed writes), G09 (per-object results). Scenes: AT-06,
 * AT-08, AT-09, AT-38.
 *
 * Every assertion runs against the INSTALLED rc.2.1 payload inside a private
 * DSH_HOME under `.work/test-runs/e02-04-*`; the user's real `~/.dsh` is never
 * read or modified. Native workspace RPCs are used only where the test itself
 * plays the native client (proving the rc.2.1 primitives BOOP delegates to);
 * BOOP's own write endpoints must stay fail-closed.
 *
 * Run: node --test tests/host/e02-04-workspace-in-host.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, before, after } from 'node:test'
import { PROJECT_ROOT, authorize, bootWeb, createProfile, freePort, makeHome, rpc, runCli } from '../helpers/test-host.mjs'

const WORK = path.join(PROJECT_ROOT, '.work/test-runs/e02-04-' + Date.now())
const DIRS = path.join(WORK, 'dirs')
const DIR_A = path.join(DIRS, 'a', 'project')
const DIR_B = path.join(DIRS, 'b', 'project')
const DIR_SINGLE = path.join(DIRS, 'single')
const MARKER_A = path.join(DIR_A, 'keep-me.txt')
const MARKER_SINGLE = path.join(DIR_SINGLE, 'keep-me.txt')

let home
let host
let cookie

const call = async (endpoint, args = {}) => {
  const { status, body } = await rpc(host.base, cookie, endpoint, args)
  assert.equal(status, 200, `${endpoint} -> ${status} ${JSON.stringify(body)}`)
  return body
}

/**
 * BOOP workspace Remote plane: one named `request` argument (SRC wire
 * convention). The RPC wraps the business value, which is itself the BOOP
 * result envelope `{ ok, value | error, audit }`.
 */
const boop = async (method, request) => {
  const body = await call(`boopWorkspace/${method}`, request === undefined ? {} : { request })
  assert.equal(body.result.ok, true, `${method} RPC failed: ${JSON.stringify(body.result)}`)
  return body.result.value
}

const native = async (endpoint, request) => {
  const body = await call(endpoint, { request })
  return body.result
}

let singleObjectId = null
let singleWorkspaceId = null
let workspaceAId = null
let previewHash = null

before(async () => {
  for (const dir of [DIR_A, DIR_B, DIR_SINGLE]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(MARKER_A, 'AT-08: removing a registration must not delete this file\n', 'utf8')
  fs.writeFileSync(MARKER_SINGLE, 'E02-04: registration removal keeps project files\n', 'utf8')
  home = path.join(WORK, 'dsh-home')
  makeHome(home)
  await createProfile(home, 'boop-workspace', {
    dependencies: { 'dsh-boop': `link:${PROJECT_ROOT.replace(/\\/g, '/')}` },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-boop'],
  })
  host = await bootWeb({ home, profile: 'boop-workspace', port: await freePort() })
  cookie = await authorize(host.base, host.token)
})

after(async () => {
  await host?.stop()
})

/* ── composition ──────────────────────────────────────────────────────── */

test('E02-04 the boop-workspace row activates with no failed rows or import warnings', () => {
  const warnings = (host.diagnostics.out + host.diagnostics.err)
    .split('\n')
    .filter((line) => /did not activate|failed to import|startup failed/i.test(line))
  assert.deepEqual(warnings, [], `activation warnings:\n${warnings.join('\n')}`)
  assert.match(host.diagnostics.out + host.diagnostics.err, /dsh web:/, 'the Web Host booted')
})

test('E02-04 the new row is composed exactly once and does not rewrite native top-level rows', async () => {
  const compiled = await runCli({ home, args: ['--profile', 'boop-workspace', '--dump-config'] })
  assert.equal(compiled.code, 0, compiled.stderr)
  const rowCount = compiled.stdout.split('\n').filter((line) => line === '- id: boop-workspace').length
  assert.equal(rowCount, 1, `boop-workspace must be inserted exactly once (got ${rowCount})`)

  // Same isolation wording as E00-01: compare the native top-level rows with and
  // without the BOOP bundle (package.json edit is restored in `finally`).
  const profileDir = path.join(home, 'profiles', 'boop-workspace')
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const saved = manifest.dsh.profile.bundles
  try {
    manifest.dsh.profile.bundles = saved.filter((bundle) => bundle !== 'dsh-boop')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const plain = await runCli({ home, args: ['--profile', 'boop-workspace', '--dump-config'] })
    assert.equal(plain.code, 0, plain.stderr)
    assert.equal(
      plain.stdout.split('\n').filter((line) => line.trim() === '- id: boop-workspace').length,
      0,
      'deselecting the bundle removes the new row (AT-35 uninstall has no residue)',
    )
    const nativeRows = (text) =>
      text
        .split('\n')
        .filter((line) => line.startsWith('- id: '))
        .filter((line) => !/boop/i.test(line))
    assert.deepEqual(nativeRows(compiled.stdout), nativeRows(plain.stdout), 'native top-level rows must be identical')
    assert.ok(nativeRows(plain.stdout).length > 60, 'the comparison must cover the real native surface')
  } finally {
    manifest.dsh.profile.bundles = saved
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
})

/* ── capability matrix on the real host ──────────────────────────────── */

test('E02-04/AT-38 capabilities: reads real, writes fail-closed, degradation stated honestly', async () => {
  const result = await boop('capabilities')
  assert.equal(result.ok, true, JSON.stringify(result))
  const value = result.value
  assert.equal(value.product, 'BOOP')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.writeMode.enabled, false, 'write mode stays off until its gates pass')
  assert.equal(value.writeMode.source, 'boop.isWriteModeEnabled()')
  assert.ok(!value.writeMode.blockedByGates.includes('G02'), 'G02 is PASS on the current ledger; '+JSON.stringify(value.writeMode.blockedByGates))
  assert.ok(value.writeMode.blockedByGates.includes('G05'))

  const byMethod = Object.fromEntries(value.methods.map((entry) => [entry.method, entry]))
  for (const method of ['capabilities', 'listWorkspaces', 'listSessions', 'resolveTarget', 'previewBatch', 'auditTrail']) {
    assert.equal(byMethod[method].status, 'available', `${method} must be available on the rc.2.1 web composition`)
  }
  assert.equal(byMethod.commitBatch.status, 'disabled')

  assert.equal(value.host.services.workspaceRegistry, true, 'ctx.workspaceRegistry is mounted by the web profile')
  assert.equal(value.host.services.sessionController, true, 'ctx.sessionController is mounted by the web profile')
  assert.equal(value.host.services.activity, true, 'the workspace/session-activity waterfall is queryable')

  // Directory creation is reported from the live picker backend, never assumed.
  const directoryCreate = value.host.directoryCreate
  assert.ok(['native', 'browse'].includes(directoryCreate.backend), JSON.stringify(directoryCreate))
  if (directoryCreate.backend === 'native') {
    assert.equal(directoryCreate.available, false, 'the native picker only opens an OS dialog')
    assert.match(directoryCreate.reason, /dialog|UI/i)
  } else {
    assert.equal(directoryCreate.available, true)
  }
  const degraded = value.degradation.map((entry) => `${entry.capability}:${entry.status}`)
  assert.ok(degraded.includes('commitBatch:disabled'))
  assert.equal(value.rules.removeRegistrationDeletesDisk, false)
  assert.equal(value.rules.genericFileDelete, false)
  assert.equal(value.rules.archiveReportsRunningWork, true)

  // The frozen agent tool must really be registered over the same rule core.
  assert.equal(value.diagnostics.workspaceTool, 'registered', JSON.stringify(value.diagnostics))
  assert.equal(value.diagnostics.remoteService, 'boopWorkspace')
  assert.equal(value.diagnostics.rulesFacade, 'boopWorkspaceRules')
  assert.ok(value.diagnostics.endpoints.includes('commitBatch'))
})

test('E02-04 the native BOOP bootstrap still reports writeModeEnabled=false after the new row', async () => {
  const body = await call('boop/bootstrap')
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.scope.writeModeEnabled, false)
  assert.equal(body.result.value.scope.recoveryGateArmed, true)
  // The same core is reachable in-process (tools / future IM adapters) and as
  // the Remote transport plane; two keys, one rule set.
  const services = body.result.value.services
  assert.ok(services.includes('boopWorkspace'), 'the Remote transport service is registered')
  assert.ok(services.includes('boopWorkspaceRules'), 'the in-process rule facade for tools/IM is registered')
})

/* ── real reads against the native registry ──────────────────────────── */

test('E02-04 native creates three Workspaces (the test plays the native client)', async () => {
  for (const dir of [DIR_A, DIR_B, DIR_SINGLE]) {
    const created = await native('workspace/create', { path: dir })
    assert.equal(created.ok, true, `workspace/create ${dir}: ${JSON.stringify(created)}`)
  }
  const listed = await native('workspace/create', { path: DIR_SINGLE })
  assert.equal(listed.ok, true)
  assert.equal(listed.value.created, false, 're-registering the same directory is idempotent')
})

test('G01/E02-04 BOOP lists the real Workspaces without creating anything', async () => {
  const result = await boop('listWorkspaces')
  assert.equal(result.ok, true, JSON.stringify(result))
  const items = result.value.items
  assert.equal(items.length, 3, JSON.stringify(items.map((entry) => entry.title)))
  for (const item of items) {
    assert.ok(item.workspaceId.length > 0)
    assert.ok(item.title.length > 0)
    assert.equal(item.directoryStatus, 'ok')
    assert.ok(fs.existsSync(item.path), `workspace dir ${item.path} exists`)
  }
  const single = items.find((entry) => entry.path.toLowerCase().endsWith('single'))
  assert.ok(single, 'the single workspace must be listed')
  singleWorkspaceId = single.workspaceId
  const a = items.find((entry) => entry.path.toLowerCase().endsWith(path.join('a', 'project').toLowerCase()))
  assert.ok(a)
  workspaceAId = a.workspaceId
  assert.ok(!workspaceAId || workspaceAId !== singleWorkspaceId)
})

test('AT-06 two Workspaces titled "project" are TARGET_AMBIGUOUS; BOOP refuses to guess', async () => {
  const result = await boop('resolveTarget', { ref: 'project', kind: 'workspace' })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.error.code, 'TARGET_AMBIGUOUS')
  const candidates = result.error.details.candidates
  assert.equal(candidates.length, 2, JSON.stringify(candidates))
  assert.ok(candidates.every((entry) => entry.title === 'project'))
  assert.equal(result.error.details.matchedBy, 'unique-title')
})

test('E02-04 an exact title resolves, and the objectId stays stable across a native rename', async () => {
  const resolved = await boop('resolveTarget', { ref: 'single', kind: 'workspace' })
  assert.equal(resolved.ok, true, JSON.stringify(resolved))
  assert.equal(resolved.value.objectId, `workspace:${singleWorkspaceId}`)
  assert.equal(resolved.value.matchedBy, 'unique-title')
  singleObjectId = resolved.value.objectId

  const renamed = await native('workspace/rename', { workspaceId: singleWorkspaceId, title: 'single-renamed' })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))

  const byIdentity = await boop('resolveTarget', { ref: singleObjectId })
  assert.equal(byIdentity.ok, true, JSON.stringify(byIdentity))
  assert.equal(byIdentity.value.objectId, singleObjectId, 'the stable identity must not move with the title')
  assert.equal(byIdentity.value.display, 'single-renamed')
  assert.equal(byIdentity.value.matchedBy, 'object-id')

  const staleTitle = await boop('resolveTarget', { ref: 'single', kind: 'workspace' })
  assert.equal(staleTitle.ok, false, 'the old display title is not an identity')
  assert.equal(staleTitle.error.code, 'TARGET_NOT_FOUND')
})

test('AT-38 BOOP lists Sessions cold-safely and discloses title coverage', async () => {
  const result = await boop('listSessions')
  assert.equal(result.ok, true, JSON.stringify(result))
  const value = result.value
  assert.ok(Array.isArray(value.sessions), 'page must be a real array')
  assert.equal(typeof value.coverage.total, 'number')
  assert.equal(value.coverage.titlesUnknown, value.coverage.total - value.coverage.titlesKnown)
  assert.equal(value.coverage.complete, value.coverage.titlesUnknown === 0)
  assert.equal(typeof value.coverage.source, 'string')
  for (const session of value.sessions) {
    assert.ok(session.sessionId.length > 0)
    assert.equal(typeof session.titleKnown, 'boolean')
    assert.equal(typeof session.archived, 'boolean')
  }
})

/* ── preview: real, read-only, non-destructive ───────────────────────── */

test('AT-08 remove-registration preview is real and non-destructive', async () => {
  const result = await boop('previewBatch', { operation: 'remove-registration', targets: [singleObjectId] })
  assert.equal(result.ok, true, JSON.stringify(result))
  const preview = result.value
  assert.equal(preview.executed, false)
  assert.equal(preview.requiresApproval, true)
  assert.equal(preview.deletesDisk, false)
  assert.equal(preview.deletesSessions, false)
  assert.match(preview.previewHash, /^[0-9a-f]{64}$/)
  const item = preview.items[0]
  assert.equal(item.objectId, singleObjectId)
  assert.equal(item.status, 'ready')
  assert.equal(item.effects.registrationEffect, 'remove')
  assert.equal(item.effects.deletesDisk, false)
  assert.equal(item.effects.deletesSessions, false)
  previewHash = preview.previewHash

  // The preview itself must not change the registry or the directory.
  const after = await boop('listWorkspaces')
  assert.equal(after.value.items.length, 3, 'preview never removes a registration')
  assert.ok(fs.existsSync(MARKER_SINGLE), 'preview never touches project files')
})

test('AT-09 previewing an archive of an unknown Session is a definite invalid object; commit refuses it', async () => {
  const preview = await boop('previewBatch', { operation: 'archive', targets: ['session:no-such-session'] })
  assert.equal(preview.ok, true, 'preview reports per-object truth instead of failing the whole batch')
  assert.equal(preview.value.feasible, false)
  assert.equal(preview.value.items[0].status, 'invalid')
  assert.equal(preview.value.items[0].code, 'TARGET_NOT_FOUND')
  assert.equal(preview.value.summary.invalid, 1)

  // A batch that still contains an invalid object must execute nothing at all.
  const commit = await boop('commitBatch', {
    operation: 'archive',
    targets: ['session:no-such-session'],
    previewHash: preview.value.previewHash,
  })
  assert.equal(commit.ok, false)
  assert.ok(['TARGET_NOT_FOUND', 'CAPABILITY_UNAVAILABLE'].includes(commit.error.code))
})

/* ── G05 fail-closed commits on the real host ─────────────────────────── */

test('G05/AT-08 a commit is refused with CAPABILITY_UNAVAILABLE and leaves an audit row', async () => {
  const result = await boop('commitBatch', {
    operation: 'remove-registration',
    targets: [singleObjectId],
    previewHash,
  })
  assert.equal(result.ok, false, 'BOOP write mode is off; the Commit RPC must fail closed')
  assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(result.error.details.writeModeEnabled, false)
  assert.ok(!result.error.details.blockedByGates.includes('G02'), 'G02 is PASS')
  assert.ok(result.error.details.blockedByGates.includes('G05'))
  assert.equal(result.audit.recorded, true, 'a refused write must be audited')

  const after = await boop('listWorkspaces')
  assert.equal(after.value.items.length, 3, 'nothing was executed')
  assert.ok(fs.existsSync(DIR_SINGLE), 'the project directory still exists')
  assert.ok(fs.existsSync(MARKER_SINGLE), 'the project file still exists')

  const trail = await boop('auditTrail', { limit: 20 })
  assert.equal(trail.ok, true, JSON.stringify(trail))
  const refusal = trail.value.entries.find((entry) => entry.kind === 'workspace/write-refused')
  assert.ok(refusal, `expected a workspace/write-refused audit row: ${JSON.stringify(trail.value.entries)}`)
  assert.equal(refusal.objectId, 'remove-registration', 'the audit row names the refused operation')
  assert.match(refusal.reason, /CAPABILITY_UNAVAILABLE/)
  assert.equal(refusal.actor, 'ui')
  const capabilities = await boop('capabilities')
  assert.equal(
    trail.value.source === 'ledger',
    capabilities.value.host.auditLedger,
    'the audit trail source must match the reported ledger availability',
  )
})

test('G05 forged authority is refused server-side and audited, not trusted from the client', async () => {
  const result = await boop('commitBatch', {
    operation: 'remove-registration',
    targets: [singleObjectId],
    previewHash,
    granted: true,
    ownerId: 'root',
    writeModeEnabled: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SCOPE_DENIED')
  assert.deepEqual(result.error.details.fields.sort(), ['granted', 'ownerId', 'writeModeEnabled'])
  assert.equal(result.audit.recorded, true)

  const trail = await boop('auditTrail', { limit: 20 })
  assert.ok(trail.value.entries.some((entry) => entry.kind === 'workspace/privilege-refused'))
  assert.equal(trail.value.writeModeEnabled, false)

  const after = await boop('listWorkspaces')
  assert.equal(after.value.items.length, 3, 'no forged authority changed the registry')
})

test('G05 every BOOP write entry point on this row is the gated commit', async () => {
  const capabilities = await boop('capabilities')
  const writes = capabilities.value.methods.filter((entry) => entry.kind === 'write')
  assert.deepEqual(writes.map((entry) => entry.method), ['commitBatch'])
  assert.ok(writes.every((entry) => entry.status === 'disabled'))
})

/* ── AT-08 native rc.2.1 primitive: removal keeps the directory ──────── */

test('AT-08 the rc.2.1 workspace/delete primitive BOOP delegates to never deletes the directory', async () => {
  assert.ok(workspaceAId, 'the first workspace id must be known')
  assert.ok(fs.existsSync(MARKER_A))
  const deleted = await native('workspace/delete', { workspaceId: workspaceAId })
  assert.equal(deleted.ok, true, JSON.stringify(deleted))
  assert.equal(deleted.value.deleted, true)

  assert.ok(fs.existsSync(DIR_A), 'rc.2.1 removes only the registration, never the directory')
  assert.ok(fs.existsSync(MARKER_A), 'project files survive registration removal')

  const listed = await boop('listWorkspaces')
  assert.equal(listed.value.items.length, 2, 'the registration is gone from the registry')
  const gone = await boop('resolveTarget', { ref: `workspace:${workspaceAId}` })
  assert.equal(gone.ok, false)
  assert.equal(gone.error.code, 'TARGET_NOT_FOUND')
})
