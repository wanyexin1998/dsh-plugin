#!/usr/bin/env node
/**
 * E02-04 · workspace & Session management core (host-free fake ports).
 *
 * Gates: G01 (exact/read-only behavior), G05 (server-side authority + capability
 * gate), G09 (per-object partial results usable by the UI). Scenes: AT-06,
 * AT-08, AT-09, AT-38.
 *
 * No DSH boot here: the core talks to fake read/mutation/audit ports, so the
 * frozen rules are exercised deterministically. MATRIX (read/preview real,
 * commit fail-closed) is verified again on the real rc.2.1 host in
 * tests/host/e02-04-workspace-in-host.test.mjs.
 *
 * Run: node tests/unit/e02-04-workspace.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  MemoryAuditSink,
  WorkspaceManagement,
  sessionObjectId,
  workspaceObjectId,
} from '../../src/host/workspace.ts'

/* ── fake Host ────────────────────────────────────────────────────────── */

const AVAILABLE_ALL = {
  services: {
    workspaceRegistry: true,
    sessionController: true,
    sessionQuery: true,
    directoryPicker: true,
    activity: true,
  },
  directoryCreate: { available: false, backend: 'native', reason: 'native backend only opens an OS dialog' },
  auditLedger: false,
}

const AVAILABLE_BROWSE = {
  ...AVAILABLE_ALL,
  directoryCreate: { available: true, backend: 'browse', reason: null },
}

function workspace(id, title, dir, sessionIds = [], directoryStatus = 'ok') {
  return { workspaceId: id, title, path: dir, directoryStatus, sessionIds, updatedAt: '2026-10-18T00:00:00.000Z' }
}

function session(id, options = {}) {
  const title = options.title ?? null
  return {
    sessionId: id,
    workspaceId: options.workspaceId ?? null,
    title,
    titleKnown: title !== null,
    cwd: options.cwd ?? null,
    live: options.live ?? true,
    persisted: options.persisted ?? true,
    running: options.running ?? false,
    blank: false,
    archived: options.archived ?? false,
    updatedAt: options.updatedAt ?? 1,
  }
}

class FakeHost {
  constructor(state) {
    this.state = state
    this.activityCalls = []
    this.inspectCalls = []
  }

  availability() {
    return this.state.availability
  }

  async listWorkspaces() {
    return this.state.workspaces.map((entry) => ({ ...entry, sessionIds: [...entry.sessionIds] }))
  }

  async listSessions() {
    const sessions = this.state.sessions
    const titlesKnown = sessions.filter((entry) => entry.titleKnown).length
    return {
      sessions: sessions.map((entry) => ({ ...entry })),
      coverage: {
        total: sessions.length,
        titlesKnown,
        titlesUnknown: sessions.length - titlesKnown,
        complete: titlesKnown === sessions.length,
        source: 'fake',
      },
    }
  }

  archivedSessionIds() {
    return this.state.sessions.filter((entry) => entry.archived).map((entry) => entry.sessionId)
  }

  async sessionActivity(sessionId) {
    this.activityCalls.push(sessionId)
    const value = this.state.activity?.get(sessionId)
    if (value instanceof Error) throw value
    return value ?? []
  }

  async resolveWorkspaceByPath(dir) {
    return this.state.workspaces.find((entry) => entry.path === dir) ?? null
  }

  async inspectPath(target) {
    this.inspectCalls.push(target)
    const known = this.state.inspections?.[target]
    if (known) return known
    return { fullyQualified: path.isAbsolute(target), exists: false, isDirectory: false, parentExists: true, parentIsDirectory: true }
  }
}

class FakeMutations {
  constructor(state) {
    this.state = state
    this.calls = []
    this.fail = new Map()
  }

  failNext(operation, code) {
    this.fail.set(operation, code)
  }

  maybeFail(operation) {
    const code = this.fail.get(operation)
    if (code === undefined) return
    this.fail.delete(operation)
    const error = new Error(`${operation} refused by the fake host`)
    error.code = code
    throw error
  }

  async registerWorkspace(targetPath) {
    this.calls.push(['register-workspace', targetPath])
    this.maybeFail('register-workspace')
    return { workspaceId: 'ws-new', created: true }
  }

  async renameWorkspace(workspaceId, title) {
    this.calls.push(['rename-workspace', workspaceId, title])
    this.maybeFail('rename-workspace')
  }

  async removeRegistration(workspaceId) {
    this.calls.push(['remove-registration', workspaceId])
    this.maybeFail('remove-registration')
    const index = this.state.workspaces.findIndex((entry) => entry.workspaceId === workspaceId)
    if (index < 0) return false
    this.state.workspaces.splice(index, 1)
    return true
  }

  async archiveSession(sessionId, options) {
    this.calls.push(['archive-session', sessionId, options.stopActivity])
    const active = this.state.activity?.get(sessionId) ?? []
    if (active.length > 0 && options.stopActivity !== true) {
      const error = new Error('session is active')
      error.code = 'workspace/session-active'
      throw error
    }
    this.state.sessions = this.state.sessions.map((entry) => (entry.sessionId === sessionId ? { ...entry, archived: true } : entry))
  }

  async unarchiveSession(sessionId) {
    this.calls.push(['unarchive-session', sessionId])
    this.maybeFail('unarchive-session')
    this.state.sessions = this.state.sessions.map((entry) => (entry.sessionId === sessionId ? { ...entry, archived: false } : entry))
  }

  async createDirectory(targetPath) {
    this.calls.push(['create-directory', targetPath])
    this.maybeFail('create-directory')
    return targetPath
  }
}

function makeCore(options = {}) {
  const state = {
    availability: options.availability ?? AVAILABLE_ALL,
    workspaces: options.workspaces ?? [],
    sessions: options.sessions ?? [],
    activity: options.activity ?? new Map(),
    inspections: options.inspections ?? {},
    writeModeEnabled: options.writeModeEnabled ?? false,
    blocked: options.blocked ?? ['G02', 'G05'],
  }
  const host = new FakeHost(state)
  const mutations = new FakeMutations(state)
  const audit = new MemoryAuditSink({ now: () => '2026-10-18T00:00:00.000Z' })
  const gate = {
    writeModeEnabled: () => state.writeModeEnabled,
    gates: () => ({ G01: 'PASS', G02: 'NOT_RUN', G03: 'NOT_RUN', G04: 'NOT_RUN', G05: 'NOT_RUN' }),
    blockedByGates: () => state.blocked,
  }
  const core = new WorkspaceManagement({
    gate,
    host,
    mutations,
    audit,
    now: () => '2026-10-18T00:00:00.000Z',
  })
  return { core, state, host, mutations, audit, gate }
}

const meta = { caller: 'ui', requestId: 'req-1' }

/* ── capability matrix / degradation ─────────────────────────────────── */

test('E02-04 capability matrix: reads available, commit fail-closed, no generic file delete', async () => {
  const { core } = makeCore()
  const result = await core.capabilities(undefined, meta)
  assert.equal(result.ok, true)
  const value = result.value
  assert.equal(value.product, 'BOOP')
  assert.equal(value.writeMode.enabled, false)
  assert.deepEqual(value.writeMode.blockedByGates, ['G02', 'G05'])
  const byMethod = Object.fromEntries(value.methods.map((entry) => [entry.method, entry]))
  for (const method of ['capabilities', 'listWorkspaces', 'listSessions', 'resolveTarget', 'previewBatch', 'auditTrail']) {
    assert.equal(byMethod[method].status, 'available', `${method} must be a real read on this composition`)
    assert.equal(byMethod[method].kind, 'read')
  }
  assert.equal(byMethod.commitBatch.kind, 'write')
  assert.equal(byMethod.commitBatch.status, 'disabled', 'write mode is off until G02/G05 pass')
  assert.match(byMethod.commitBatch.reason, /G02/)
  assert.deepEqual(value.rules, {
    exactResolutionOnly: true,
    removeRegistrationDeletesDisk: false,
    archiveReportsRunningWork: true,
    genericFileDelete: false,
    serverSideAuthority: true,
  })
  assert.equal(value.diagnostics, null, 'no adapter diagnostics are invented for a bare core')
  const degraded = value.degradation.map((entry) => `${entry.capability}:${entry.status}`)
  assert.ok(degraded.includes('commitBatch:disabled'))
  assert.ok(degraded.includes('audit-ledger:unavailable'), 'a memory-only audit trail must be disclosed')
  assert.ok(degraded.includes('create-directory:unavailable'), 'the native picker has no directory-creation primitive')
})

test('G05 a client-supplied authority field is refused before any read or write', async () => {
  const { core, mutations } = makeCore()
  const result = await core.capabilities({ granted: true, ownerId: 'root' }, meta)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SCOPE_DENIED')
  assert.deepEqual(result.error.details.fields.sort(), ['granted', 'ownerId'])
  assert.deepEqual(mutations.calls, [])
})

test('E02-04 a missing Host service is reported unavailable, never faked as an empty success', async () => {
  const { core } = makeCore({
    availability: { ...AVAILABLE_ALL, services: { ...AVAILABLE_ALL.services, workspaceRegistry: false } },
  })
  const capabilities = await core.capabilities(undefined, meta)
  assert.equal(capabilities.ok, true)
  const listWorkspaces = capabilities.value.methods.find((entry) => entry.method === 'listWorkspaces')
  assert.equal(listWorkspaces.status, 'unavailable')
  assert.match(listWorkspaces.reason, /workspaceRegistry/)

  const listed = await core.listWorkspaces(undefined, meta)
  assert.equal(listed.ok, false, 'an unavailable registry must not look like an empty registry')
  assert.equal(listed.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(listed.error.message, /workspaceRegistry/)
})

/* ── reads ────────────────────────────────────────────────────────────── */

test('E02-04 listWorkspaces and listSessions report the real registry/catalog facts', async () => {
  const dir = '/home/user/project-a'
  const { core } = makeCore({
    workspaces: [workspace('ws-1', 'Project A', dir, ['s-1'])],
    sessions: [session('s-1', { title: 'Fix the narrow layout', workspaceId: 'ws-1' }), session('s-2', { title: null })],
  })
  const workspaces = await core.listWorkspaces(undefined, meta)
  assert.equal(workspaces.ok, true)
  assert.equal(workspaces.value.count, 1)
  assert.equal(workspaces.value.items[0].workspaceId, 'ws-1')
  assert.equal(workspaces.value.items[0].directoryStatus, 'ok')
  assert.deepEqual(workspaces.value.items[0].sessionIds, ['s-1'])

  const sessions = await core.listSessions(undefined, meta)
  assert.equal(sessions.ok, true)
  assert.equal(sessions.value.sessions.length, 2)
  assert.equal(sessions.value.coverage.titlesKnown, 1)
  assert.equal(sessions.value.coverage.titlesUnknown, 1)
  assert.equal(sessions.value.coverage.complete, false, 'an unreadable title must be disclosed, not invented')
  const titled = sessions.value.sessions.find((entry) => entry.sessionId === 's-1')
  assert.equal(titled.title, 'Fix the narrow layout')
  assert.equal(titled.workspaceId, 'ws-1')
})

/* ── exact resolution (AT-06) ─────────────────────────────────────────── */

test('AT-06 exact object id resolves without touching the display title', async () => {
  const { core } = makeCore({
    workspaces: [workspace('ws-1', 'Project A', '/home/user/a', ['s-1'])],
    sessions: [session('s-1', { title: 'Session one', workspaceId: 'ws-1' })],
  })
  const resolved = await core.resolveTarget({ ref: workspaceObjectId('ws-1') }, meta)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.value.kind, 'workspace')
  assert.equal(resolved.value.objectId, 'workspace:ws-1')
  assert.equal(resolved.value.matchedBy, 'object-id')
  assert.equal(resolved.value.identity.workspaceId, 'ws-1')

  const sessionResolved = await core.resolveTarget({ ref: 's-1', kind: 'session' }, meta)
  assert.equal(sessionResolved.ok, true)
  assert.equal(sessionResolved.value.objectId, 'session:s-1')
})

test('E02-04 a unique exact title resolves; a similar name does NOT', async () => {
  const { core } = makeCore({
    workspaces: [workspace('ws-1', 'boop-plugin', '/home/user/boop-plugin')],
    sessions: [],
  })
  const exact = await core.resolveTarget({ ref: 'boop-plugin' }, meta)
  assert.equal(exact.ok, true)
  assert.equal(exact.value.objectId, 'workspace:ws-1')
  assert.equal(exact.value.matchedBy, 'unique-title')

  const similar = await core.resolveTarget({ ref: 'boop plugin' }, meta)
  assert.equal(similar.ok, false)
  assert.equal(similar.error.code, 'TARGET_NOT_FOUND', 'a similar name is not a candidate')
  assert.equal(similar.error.details.definitive, true)
})

test('AT-06 two Workspaces with the same exact title are TARGET_AMBIGUOUS and never guessed', async () => {
  const { core } = makeCore({
    workspaces: [
      workspace('ws-1', 'project', '/home/user/a/project'),
      workspace('ws-2', 'project', '/home/user/b/project'),
    ],
  })
  const resolved = await core.resolveTarget({ ref: 'project', kind: 'workspace' }, meta)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.error.code, 'TARGET_AMBIGUOUS')
  assert.equal(resolved.error.details.candidates.length, 2)
  assert.deepEqual(
    resolved.error.details.candidates.map((entry) => entry.objectId).sort(),
    ['workspace:ws-1', 'workspace:ws-2'],
  )
})

test('AT-06 a workspace title that also names a Session is ambiguous across kinds', async () => {
  const { core } = makeCore({
    workspaces: [workspace('ws-1', 'same-name', '/home/user/same-name')],
    sessions: [session('s-1', { title: 'same-name' })],
  })
  const resolved = await core.resolveTarget({ ref: 'same-name' }, meta)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.error.code, 'TARGET_AMBIGUOUS')
  assert.equal(resolved.error.details.candidates.length, 2)
})

test('AT-38 an unreadable Session title never becomes a definitive miss', async () => {
  const { core } = makeCore({
    workspaces: [],
    sessions: [session('s-1', { title: null })],
  })
  const resolved = await core.resolveTarget({ ref: 'some title' }, meta)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.error.code, 'TARGET_NOT_FOUND')
  assert.equal(resolved.error.details.definitive, false)
  assert.equal(resolved.error.details.titleCoverageComplete, false)
  assert.match(resolved.error.message, /not a definitive miss/)
})

test('E02-04 object ids stay stable across rename, reorder and updatedAt changes', async () => {
  const workspaces = [workspace('ws-1', 'Old title', '/home/user/a'), workspace('ws-2', 'Other', '/home/user/b')]
  const { core, state } = makeCore({ workspaces })
  const before = await core.resolveTarget({ ref: workspaceObjectId('ws-1') }, meta)
  assert.equal(before.ok, true)
  const stableId = before.value.objectId

  // Rename + reorder + timestamp move: identity must not move with the title.
  state.workspaces = [workspace('ws-2', 'Other', '/home/user/b'), workspace('ws-1', 'New title', '/home/user/a')]
  const after = await core.resolveTarget({ ref: stableId }, meta)
  assert.equal(after.ok, true)
  assert.equal(after.value.objectId, stableId)
  assert.equal(after.value.display, 'New title')
  assert.equal(after.value.matchedBy, 'object-id')

  const byOldTitle = await core.resolveTarget({ ref: 'Old title' }, meta)
  assert.equal(byOldTitle.ok, false, 'a stale title is not an identity')
})

test('E02-04 a prefixed object ref of the wrong kind is an invalid request, not a silent fallback', async () => {
  const { core } = makeCore({
    workspaces: [workspace('ws-1', 'Project', '/home/user/p')],
    sessions: [session('s-1', { title: 'Session' })],
  })
  const resolved = await core.resolveTarget({ ref: workspaceObjectId('ws-1'), kind: 'session' }, meta)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.error.code, 'INVALID_REQUEST')
})

/* ── preview (AT-08/AT-09) ───────────────────────────────────────────── */

test('AT-09 archive preview reports running work per object and never claims success', async () => {
  const activity = new Map([
    ['s-run', [{ kind: 'turn', items: [{ id: 'turn-1', label: 'running turn' }] }]],
  ])
  const { core, mutations } = makeCore({
    sessions: [session('s-idle', { title: 'Idle' }), session('s-run', { title: 'Running' })],
    activity,
  })
  const preview = await core.previewBatch(
    { operation: 'archive', targets: [sessionObjectId('s-idle'), sessionObjectId('s-run')] },
    meta,
  )
  assert.equal(preview.ok, true)
  const value = preview.value
  assert.equal(value.executed, false)
  assert.equal(value.requiresApproval, true)
  assert.equal(value.deletesDisk, false)
  assert.match(value.previewHash, /^[0-9a-f]{64}$/)
  assert.equal(value.items.length, 2)
  assert.equal(value.items[0].status, 'ready')
  assert.equal(value.items[1].status, 'would-partially-fail')
  assert.equal(value.items[1].code, 'TARGET_ACTIVE')
  assert.equal(value.items[1].activity[0].kind, 'turn')
  assert.equal(value.summary.activeWork, 1)
  assert.equal(value.summary.wouldPartiallyFail, 1)
  assert.equal(value.feasible, true, 'the batch is still attemptable: one object would be refused')
  for (const item of value.items) {
    assert.equal(item.effects.deletesDisk, false)
    assert.equal(item.effects.deletesSessions, false)
  }
  assert.deepEqual(mutations.calls, [], 'preview must never mutate')
  assert.deepEqual(value.warnings.length > 0, true)
})

test('AT-09 archive preview with stopActivity marks the running object ready-to-stop', async () => {
  const activity = new Map([['s-run', [{ kind: 'job', items: [{ id: 'job-1', label: null }] }]]])
  const { core } = makeCore({ sessions: [session('s-run', { title: 'Running' })], activity })
  const preview = await core.previewBatch(
    { operation: 'archive', targets: ['session:s-run'], options: { stopActivity: true } },
    meta,
  )
  assert.equal(preview.ok, true)
  assert.equal(preview.value.items[0].status, 'ready')
  assert.match(preview.value.items[0].reason, /stop/i)
  assert.match(preview.value.items[0].warnings.join(' '), /异步|background/)
})

test('E02-04 the preview hash is stable while state is stable and moves when it changes', async () => {
  const activity = new Map()
  const { core, state } = makeCore({ sessions: [session('s-1', { title: 'One' })], activity })
  const request = { operation: 'archive', targets: ['session:s-1'] }
  const first = await core.previewBatch(request, meta)
  const second = await core.previewBatch(request, meta)
  assert.equal(first.value.previewHash, second.value.previewHash)

  state.activity.set('s-1', [{ kind: 'turn', items: [{ id: 'turn-9', label: null }] }])
  const third = await core.previewBatch(request, meta)
  assert.notEqual(third.value.previewHash, first.value.previewHash, 'new running work must invalidate the old preview hash')
})

test('AT-08 remove-registration preview states the exact non-destructive effects', async () => {
  const { core, mutations } = makeCore({
    workspaces: [workspace('ws-1', 'Project A', '/home/user/a', ['s-1', 's-2'])],
    sessions: [session('s-1'), session('s-2')],
  })
  const preview = await core.previewBatch({ operation: 'remove-registration', targets: ['workspace:ws-1'] }, meta)
  assert.equal(preview.ok, true)
  const item = preview.value.items[0]
  assert.equal(item.status, 'ready')
  assert.equal(item.effects.registrationEffect, 'remove')
  assert.equal(item.effects.deletesDisk, false)
  assert.equal(item.effects.deletesSessions, false)
  assert.equal(item.effects.becomesUngrouped, true)
  assert.deepEqual(item.warnings.length >= 2, true)
  assert.deepEqual(mutations.calls, [])
})

test('E02-04 create-registration preview validates the directory without creating it', async () => {
  const dir = '/home/user/new-project'
  const { core } = makeCore({
    inspections: {
      '/home/user/new-project': { fullyQualified: true, exists: true, isDirectory: true, parentExists: true, parentIsDirectory: true },
      '/home/user/missing': { fullyQualified: true, exists: false, isDirectory: false, parentExists: true, parentIsDirectory: true },
      'relative/dir': { fullyQualified: false, exists: false, isDirectory: false, parentExists: false, parentIsDirectory: false },
    },
  })
  const ready = await core.previewBatch({ operation: 'create-registration', targets: [dir] }, meta)
  assert.equal(ready.ok, true)
  assert.equal(ready.value.items[0].status, 'ready')
  assert.equal(ready.value.items[0].effects.registrationEffect, 'create')
  assert.equal(ready.value.items[0].effects.diskEffect, 'none', 'registration itself never touches disk')

  const missing = await core.previewBatch({ operation: 'create-registration', targets: ['/home/user/missing'] }, meta)
  assert.equal(missing.ok, true)
  assert.equal(missing.value.items[0].status, 'invalid')
  assert.equal(missing.value.items[0].code, 'TARGET_NOT_FOUND')

  const relative = await core.previewBatch({ operation: 'create-registration', targets: ['relative/dir'] }, meta)
  assert.equal(relative.value.items[0].status, 'invalid')
  assert.match(relative.value.items[0].reason, /fully qualified/)
})

test('E02-04 create-directory is unavailable on a native picker and ready on browse', async () => {
  const target = '/home/user/parent/new-dir'
  const inspections = {
    [target]: { fullyQualified: true, exists: false, isDirectory: false, parentExists: true, parentIsDirectory: true },
  }
  const native = makeCore({ inspections })
  const unavailable = await native.core.previewBatch({ operation: 'create-directory', targets: [target] }, meta)
  assert.equal(unavailable.ok, true)
  assert.equal(unavailable.value.items[0].status, 'unavailable')
  assert.equal(unavailable.value.items[0].code, 'CAPABILITY_UNAVAILABLE')
  assert.match(unavailable.value.items[0].reason, /native|OS dialog/)
  assert.equal(unavailable.value.feasible, false)

  const browse = makeCore({ availability: AVAILABLE_BROWSE, inspections })
  const ready = await browse.core.previewBatch({ operation: 'create-directory', targets: [target] }, meta)
  assert.equal(ready.value.items[0].status, 'ready')
  assert.equal(ready.value.items[0].effects.diskEffect, 'create-directory')
  assert.equal(ready.value.items[0].effects.deletesDisk, false)
})

/* ── G05: capability gate fail-closed ─────────────────────────────────── */

test('G05 every write path is refused fail-closed while write mode is off, with audit', async () => {
  const { core, mutations, audit } = makeCore({
    sessions: [session('s-1', { title: 'One' })],
    workspaces: [workspace('ws-1', 'Project', '/home/user/a')],
  })
  const preview = await core.previewBatch({ operation: 'archive', targets: ['session:s-1'] }, meta)
  assert.equal(preview.ok, true)

  const commit = await core.commitBatch(
    { operation: 'archive', targets: ['session:s-1'], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(commit.error.details.writeModeEnabled, false)
  assert.deepEqual(commit.error.details.blockedByGates, ['G02', 'G05'])
  assert.equal(commit.audit.recorded, true)
  assert.deepEqual(mutations.calls, [], 'a closed gate must never reach the mutation port')
  const trail = audit.trail(10)
  const refusal = trail.find((entry) => entry.kind === 'workspace/write-refused')
  assert.ok(refusal, 'a refused write must leave an audit row')
  assert.match(refusal.reason, /CAPABILITY_UNAVAILABLE/)
})

test('G05 a gate that closes between preview and commit still refuses', async () => {
  const { core, state, mutations } = makeCore({
    sessions: [session('s-1', { title: 'One' })],
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'archive', targets: ['session:s-1'] }, meta)
  assert.equal(preview.ok, true)
  state.writeModeEnabled = false
  const commit = await core.commitBatch(
    { operation: 'archive', targets: ['session:s-1'], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(mutations.calls, [])
})

test('G05 forged authority never changes the outcome for UI or tool callers', async () => {
  const { core, audit } = makeCore({ sessions: [session('s-1')] })
  const preview = await core.previewBatch({ operation: 'archive', targets: ['session:s-1'] }, meta)

  for (const caller of ['ui', 'tool', 'im']) {
    const forged = await core.commitBatch(
      {
        operation: 'archive',
        targets: ['session:s-1'],
        previewHash: preview.value.previewHash,
        granted: true,
        ownerId: 'root',
        writeModeEnabled: true,
      },
      { caller, requestId: `req-${caller}` },
    )
    assert.equal(forged.ok, false)
    assert.equal(forged.error.code, 'SCOPE_DENIED', `caller ${caller} must get the same server-side refusal`)
    assert.equal(forged.audit.recorded, true)
  }
  const privilegeRows = audit.trail(20).filter((entry) => entry.kind === 'workspace/privilege-refused')
  assert.equal(privilegeRows.length, 3)
})

test('G05 commit requires a valid preview hash', async () => {
  const { core, mutations } = makeCore({ sessions: [session('s-1')], writeModeEnabled: true })
  const commit = await core.commitBatch({ operation: 'archive', targets: ['session:s-1'], previewHash: 'not-a-hash' }, meta)
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'INVALID_REQUEST')
  assert.deepEqual(mutations.calls, [])
})

test('G05 a stale preview hash is refused before anything executes', async () => {
  const activity = new Map()
  const { core, state, mutations } = makeCore({
    sessions: [session('s-1', { title: 'One' })],
    activity,
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'archive', targets: ['session:s-1'] }, meta)
  state.activity.set('s-1', [{ kind: 'turn', items: [{ id: 'turn-1', label: null }] }])
  const commit = await core.commitBatch(
    { operation: 'archive', targets: ['session:s-1'], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'PREVIEW_STALE')
  assert.deepEqual(mutations.calls, [])
})

/* ── open-gate internal path (test-only injection) ─────────────────────
 *
 * The real Host never has write mode enabled (G02/G05 pending), so the
 * per-object partial-success and non-destructive semantics are proven here by
 * injecting an open gate into the SAME core. The real wiring still reads
 * `boop.isWriteModeEnabled()`; nothing in src/ can flip it.
 */
test('AT-09 an archive batch returns a per-object partial-success list, never "all succeeded"', async () => {
  const activity = new Map([['s-run', [{ kind: 'turn', items: [{ id: 'turn-7', label: 'running' }] }]]])
  const { core, mutations, audit } = makeCore({
    sessions: [session('s-idle', { title: 'Idle' }), session('s-run', { title: 'Running' })],
    activity,
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch(
    { operation: 'archive', targets: ['session:s-idle', 'session:s-run'] },
    { caller: 'tool', requestId: 'req-partial' },
  )
  assert.equal(preview.ok, true)
  const commit = await core.commitBatch(
    {
      operation: 'archive',
      targets: ['session:s-idle', 'session:s-run'],
      previewHash: preview.value.previewHash,
    },
    { caller: 'tool', requestId: 'req-partial' },
  )
  assert.equal(commit.ok, true, 'the RPC itself succeeds; the per-object results carry the refusals')
  const value = commit.value
  assert.equal(value.executed, true)
  assert.equal(value.atomic, false)
  assert.equal(value.claimedComplete, false, 'one object was still running: this is a partial success')
  assert.deepEqual(value.summary, { total: 2, succeeded: 1, refused: 1, failed: 0, unknown: 0, noOp: 0 })
  assert.equal(value.items[0].status, 'succeeded')
  assert.equal(value.items[1].status, 'refused')
  assert.equal(value.items[1].code, 'TARGET_ACTIVE')
  assert.equal(value.items[1].activity[0].kind, 'turn')
  assert.match(value.notes.join(' '), /部分成功|逐项/)
  assert.deepEqual(
    mutations.calls.map((call) => call[0]),
    ['archive-session', 'archive-session'],
  )
  assert.equal(audit.trail(20).filter((entry) => entry.kind === 'workspace/archive').length, 2)
  assert.equal(audit.trail(20).filter((entry) => entry.kind === 'workspace/batch').length, 1)
})

test('AT-08 removing a workspace registration never touches the project directory on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-e02-04-'))
  try {
    fs.writeFileSync(path.join(dir, 'project.txt'), 'keep me', 'utf8')
    const { core, mutations } = makeCore({
      workspaces: [workspace('ws-1', 'Real project', dir, [])],
      writeModeEnabled: true,
    })
    const preview = await core.previewBatch({ operation: 'remove-registration', targets: ['workspace:ws-1'] }, meta)
    const commit = await core.commitBatch(
      { operation: 'remove-registration', targets: ['workspace:ws-1'], previewHash: preview.value.previewHash },
      meta,
    )
    assert.equal(commit.ok, true)
    assert.equal(commit.value.items[0].status, 'succeeded')
    assert.deepEqual(mutations.calls, [['remove-registration', 'ws-1']])
    assert.ok(fs.existsSync(dir), 'the project directory MUST still exist')
    assert.ok(fs.existsSync(path.join(dir, 'project.txt')), 'project files MUST still exist')

    // The mutation port itself has no deletion API: no code path can delete a
    // directory or an arbitrary file, even if a future caller asks for it.
    const portMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(mutations))
    for (const forbidden of ['delete', 'rm', 'rmdir', 'unlink', 'remove', 'removePath', 'deletePath', 'deleteDirectory']) {
      assert.equal(portMethods.includes(forbidden), false, `mutation port must expose no ${forbidden}() method`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('E02-04 create-directory commit executes one segment and creates no registration', async () => {
  const target = '/home/user/parent/new-dir'
  const { core, mutations } = makeCore({
    availability: AVAILABLE_BROWSE,
    inspections: { [target]: { fullyQualified: true, exists: false, isDirectory: false, parentExists: true, parentIsDirectory: true } },
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'create-directory', targets: [target] }, meta)
  const commit = await core.commitBatch(
    { operation: 'create-directory', targets: [target], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, true)
  assert.equal(commit.value.claimedComplete, true)
  assert.deepEqual(mutations.calls, [['create-directory', target]])
  assert.equal(mutations.calls.some((call) => call[0] === 'register-workspace'), false)
})

test('E02-04 an invalid batch object blocks the whole commit before execution', async () => {
  const { core, mutations } = makeCore({
    workspaces: [workspace('ws-1', 'project', '/a/project'), workspace('ws-2', 'project', '/b/project')],
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'remove-registration', targets: ['project'] }, meta)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.items[0].status, 'invalid')
  assert.equal(preview.value.items[0].code, 'TARGET_AMBIGUOUS')
  const commit = await core.commitBatch(
    { operation: 'remove-registration', targets: ['project'], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, false)
  assert.equal(commit.error.code, 'TARGET_AMBIGUOUS')
  assert.deepEqual(mutations.calls, [], 'nothing executes when the batch still contains an ambiguous object')
})

test('E02-04 rename commit is a title change only', async () => {
  const { core, mutations } = makeCore({
    workspaces: [workspace('ws-1', 'Old', '/home/user/project')],
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'rename', targets: ['workspace:ws-1'], options: { title: 'New' } }, meta)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.items[0].effects.registrationEffect, 'rename')
  const commit = await core.commitBatch(
    { operation: 'rename', targets: ['workspace:ws-1'], options: { title: 'New' }, previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, true)
  assert.deepEqual(mutations.calls, [['rename-workspace', 'ws-1', 'New']])
})

test('E02-04 unarchive commit restores exactly the archived objects', async () => {
  const { core, mutations, state } = makeCore({
    sessions: [session('s-archived', { title: 'Archived', archived: true })],
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'unarchive', targets: ['session:s-archived'] }, meta)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.items[0].status, 'ready')
  assert.equal(preview.value.items[0].effects.archiveEffect, 'unarchive')
  const commit = await core.commitBatch(
    { operation: 'unarchive', targets: ['session:s-archived'], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, true)
  assert.equal(commit.value.claimedComplete, true)
  assert.deepEqual(mutations.calls, [['unarchive-session', 's-archived']])
  assert.equal(state.sessions[0].archived, false, 'the Session is restored, not deleted or recreated')

  // Restoring an already-restored object is a transparent no-op.
  const again = await core.previewBatch({ operation: 'unarchive', targets: ['session:s-archived'] }, meta)
  assert.equal(again.value.items[0].status, 'no-op')
  const noopCommit = await core.commitBatch(
    { operation: 'unarchive', targets: ['session:s-archived'], previewHash: again.value.previewHash },
    meta,
  )
  assert.equal(noopCommit.ok, true)
  assert.equal(noopCommit.value.claimedComplete, true, 'nothing left to do still reaches the requested end state')
  assert.equal(noopCommit.value.summary.noOp, 1)
  assert.deepEqual(mutations.calls, [['unarchive-session', 's-archived']], 'a no-op must not call the mutation port again')
})

test('E02-04 create-registration commit registers the existing directory only', async () => {
  const dir = '/home/user/existing-project'
  const { core, mutations } = makeCore({
    inspections: { [dir]: { fullyQualified: true, exists: true, isDirectory: true, parentExists: true, parentIsDirectory: true } },
    writeModeEnabled: true,
  })
  const preview = await core.previewBatch({ operation: 'create-registration', targets: [dir] }, meta)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.items[0].status, 'ready')
  const commit = await core.commitBatch(
    { operation: 'create-registration', targets: [dir], previewHash: preview.value.previewHash },
    meta,
  )
  assert.equal(commit.ok, true)
  assert.equal(commit.value.claimedComplete, true)
  assert.equal(commit.value.items[0].objectId, 'workspace:ws-new')
  assert.deepEqual(mutations.calls, [['register-workspace', dir]])
})

test('E02-04 mutations never change the Host while the gate is closed', async () => {
  const workspaces = [workspace('ws-1', 'Project', '/home/user/a', ['s-1'])]
  const sessions = [session('s-1', { title: 'One' })]
  const { core, state, mutations } = makeCore({ workspaces, sessions })
  const snapshot = JSON.stringify(state.workspaces) + JSON.stringify(state.sessions)
  for (const request of [
    { operation: 'archive', targets: ['session:s-1'] },
    { operation: 'unarchive', targets: ['session:s-1'] },
    { operation: 'remove-registration', targets: ['workspace:ws-1'] },
    { operation: 'rename', targets: ['workspace:ws-1'], options: { title: 'Changed' } },
    { operation: 'create-registration', targets: ['/home/user/a'] },
  ]) {
    const preview = await core.previewBatch(request, meta)
    const commit = await core.commitBatch({ ...request, previewHash: preview.value.previewHash }, meta)
    assert.equal(commit.ok, false)
    assert.equal(commit.error.code, 'CAPABILITY_UNAVAILABLE')
  }
  assert.equal(JSON.stringify(state.workspaces) + JSON.stringify(state.sessions), snapshot)
  assert.deepEqual(mutations.calls, [])
})

/* ── audit trail read (evidence surface) ─────────────────────────────── */

test('E02-04 auditTrail returns the refused attempts newest first', async () => {
  const { core } = makeCore({ sessions: [session('s-1')] })
  const preview = await core.previewBatch({ operation: 'archive', targets: ['session:s-1'] }, meta)
  await core.commitBatch({ operation: 'archive', targets: ['session:s-1'], previewHash: preview.value.previewHash }, meta)
  await core.commitBatch({ operation: 'archive', targets: ['session:s-1'], granted: true }, { caller: 'tool', requestId: 'r2' })
  const trail = await core.auditTrail({ limit: 10 }, meta)
  assert.equal(trail.ok, true)
  assert.equal(trail.value.source, 'memory')
  assert.equal(trail.value.writeModeEnabled, false)
  assert.equal(trail.value.entries[0].kind, 'workspace/privilege-refused', 'newest refusal is first')
  assert.ok(trail.value.entries.some((entry) => entry.kind === 'workspace/write-refused'))
})
