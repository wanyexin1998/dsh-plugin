/**
 * Regressions for the b92fa37 review. Each test fails on the old behavior.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { DelegationService } from '../../src/host/delegation/service.ts'
import { HomeService } from '../../src/host/home/service.ts'
import { gateHomeReferences, installHomeReferenceGuard } from '../../src/host/home/reference-guard.ts'
import { contextFromEvents, directHumanOrigin, interpretTarget } from '../../src/host/home/observe-facts.ts'
import { REPLY_OUTPUT } from '../../src/host/tools.ts'
import { encodeSessionReferenceUri, formatSessionReferenceMention, parseSessionReferenceText } from '../../src/shared/session-mention.ts'
import { readWorkChoice } from '../../src/client/home/read-work-choice.ts'
import { insertDraftText, insertSessionReference } from '../../src/client/home/draft-input.ts'
import { HomeController } from '../../src/client/home/controller.ts'

test('catalog envelope passes the tool output schema', () => {
  const tool = defineTool({
    name: 'boop_catalog_probe',
    description: 'probe',
    parameters: {},
    output: REPLY_OUTPUT,
    execute: async () => ({}),
  })
  const reply = {
    schemaVersion: 2,
    kind: 'boop.catalog',
    ok: true,
    data: { mode: 'work', originUserMessageId: 'u', sourceSeq: 1, generatedAt: 't', candidates: [], truncated: false },
  }
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, reply, 'value'), [])
})

test('a denied label cannot be parsed back into a session URI', () => {
  const secret = encodeSessionReferenceUri('secret-session')
  const text = formatSessionReferenceMention({ sessionId: 'blocked-outer', label: `see ${secret}` })
  const gated = gateHomeReferences([{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }], {
    decide: () => 'deny',
  })
  assert.equal(gated.length, 1)
  assert.equal(gated[0].id, 'm1')
  assert.equal(gated[0].role, 'user')
  const body = gated[0].content.map((block) => block.text).join('\n')
  assert.equal(parseSessionReferenceText(body).references.length, 0)
  assert.equal(body.includes(secret), false)
})

test('the reference guard is installed once per agent', () => {
  let listeners = 0
  const agent = { ctx: { on() { listeners += 1 } } }
  const policy = { decide: () => 'allow' }
  assert.equal(installHomeReferenceGuard(agent, policy), true)
  assert.equal(installHomeReferenceGuard(agent, policy), true)
  assert.equal(listeners, 1)
})

test('v1 main session is reused and a conflicting bind does not claim ready', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-home-legacy-'))
  const cwd = path.resolve(path.join(dshHome, 'boop', 'home'))
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.bootstrap()
  db.db.prepare(`UPDATE scopes SET main_session_id = ? WHERE scope_id = ?`).run('boop-old', 'scope-1')
  db.db.prepare(`INSERT INTO scopes(scope_id,owner_id,main_session_id,policy_epoch,schema_version,created_at) VALUES('scope-1','owner-1','boop-old',1,2,'t')`).run()
  const created = []
  const native = {
    async observe(sessionId) {
      return { exists: sessionId === 'boop-old', subagent: false, archived: false, preset: sessionId === 'boop-old' ? 'boop' : null, cwd: sessionId === 'boop-old' ? cwd : '/elsewhere' }
    },
    async resolve(sessionId) {
      return { ok: sessionId === 'boop-old', agent: { session: { id: sessionId }, ctx: { on() {} } } }
    },
    async create(input) {
      created.push(input)
      return { sessionId: input.sessionId }
    },
    async flush() { return true },
    async modelAvailable() { return true },
  }
  const service = new HomeService({
    db, scopeId: 'scope-1', ownerId: 'owner-1', dshHome, native, policy: { decide: () => 'allow' }, fenceOk: () => true,
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const ready = await service.ensureHome({ requestId: 'legacy' })
  assert.equal(ready.data.state, 'ready')
  assert.equal(ready.data.mainSessionId, 'boop-old')
  assert.equal(created.length, 0)
  assert.equal(service.currentIdentity().sessionId, 'boop-old')
  db.close()
  fs.rmSync(dshHome, { recursive: true, force: true })
})

test('a home session without a cwd is not treated as ready', async () => {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-home-cwd-'))
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.bootstrap()
  db.db.prepare(`INSERT INTO scopes(scope_id,owner_id,main_session_id,policy_epoch,schema_version,created_at) VALUES('scope-1','owner-1','boop-old',1,2,'t')`).run()
  const service = new HomeService({
    db,
    scopeId: 'scope-1',
    ownerId: 'owner-1',
    dshHome,
    native: {
      async observe() { return { exists: true, subagent: false, archived: false, preset: 'boop', cwd: null } },
      async resolve() { return { ok: true, agent: { session: {}, ctx: { on() {} } } } },
      async create(input) { return { sessionId: input.sessionId } },
      async flush() { return true },
      async modelAvailable() { return true },
    },
    policy: { decide: () => 'allow' },
    fenceOk: () => true,
    now: () => '2026-10-28T00:00:00.000Z',
  })
  const view = await service.ensureHome({ requestId: 'cwd' })
  assert.equal(view.data.state, 'repair_required')
  db.close()
  fs.rmSync(dshHome, { recursive: true, force: true })
})

test('observation reads human text and does not treat a loaded session as busy', () => {
  const observed = interpretTarget({
    header: { id: 'sess', parentSession: undefined, agentPreset: 'coder', cwd: '/work' },
    events: [
      { type: 'user/message', seq: 3, data: { id: 'user-3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不要部署' }] } },
      { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
    agentStatus: 'idle',
    workspaceId: 'ws',
    title: '原会话',
    homeSessionId: 'home',
    revision: 'rev-1',
  })
  assert.equal(observed.busy, false)
  assert.equal(observed.subagent, false)
  assert.equal(observed.latestDirectUserSeq, 3)
  assert.equal(observed.headSeq, 8)
  const events = contextFromEvents([
    { type: 'user/message', seq: 3, data: { id: 'user-3', source: { kind: 'user' }, content: [{ type: 'text', text: '不要部署' }] } },
    { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } },
  ], 'sess', 'rev-1', 10, null)
  assert.equal(events[0].text, '不要部署')
  assert.equal(events.some((event) => event.text === 'turn/end'), false)
  assert.equal(directHumanOrigin([
    { type: 'user/message', seq: 1, data: { id: 'user-1', source: { kind: 'user' }, content: [] } },
    { type: 'user/message', seq: 2, data: { id: 'boopres_1', source: { kind: 'boop-result' }, content: [] } },
  ], 'model-call'), null)
})

function serviceWorld() {
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.bootstrap()
  db.db.prepare(`INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('scope-1','owner-1',1,2,'t')`).run()
  const sessions = new Map()
  const calls = { followup: 0, cancel: 0 }
  const ports = {
    now: () => '2026-10-28T00:00:00.000Z',
    nowMs: () => Date.parse('2026-10-28T00:00:00.000Z'),
    fenceOk: () => true,
    async listSessions() { return [...sessions.values()] },
    async observe(sessionId) { return sessions.get(sessionId) ?? null },
    async readEvents(sessionId) { return sessions.get(sessionId)?.events ?? [] },
    excluded(sessionId) { return sessions.get(sessionId)?.excluded === true },
    hostCanRead(sessionId) { return sessions.has(sessionId) },
    async followup(sessionId, message) {
      calls.followup += 1
      sessions.get(sessionId).inbox.push(message)
      return 'enqueued'
    },
    async flush() { return true },
    async pending(sessionId, messageId) { return sessions.get(sessionId).inbox.some((message) => message.id === messageId) },
    async visible(sessionId, messageId) { return sessions.get(sessionId).visible.has(messageId) },
    async remove() { return false },
    async cancelTurn() { calls.cancel += 1 },
    async mainIdle() { return true },
  }
  const service = new DelegationService(db, 'scope-1', ports)
  service.inheritAccess('owner-1', 'test')
  const call = { originRef: 'user-msg-1', originKind: 'user', mainSessionId: 'boop-main', bindingVersion: 1, policyEpoch: 1, holder: 'owner-1', fence: 1 }
  function add(sessionId, extra = {}) {
    sessions.set(sessionId, {
      reachable: true, busy: false, pendingHuman: false, archived: false, subagent: false, home: false,
      title: sessionId, workspaceId: 'ws-1', workspaceTitle: null, activity: 'idle', lastActivityAt: null, preview: null,
      sourceGeneration: 'gen-1', headSeq: 4, latestDirectUserSeq: 3, latestDirectUserMessageId: 'user-msg-1',
      pendingMessage: false, turnId: null, turnTerminal: false, ownership: 'not_started', approvalId: null,
      summary: null, deliverable: false, checks: [], artifacts: [], missing: [], evidenceSeq: 4,
      events: [{ seq: 3, text: '不要部署', sessionId, sourceGeneration: 'gen-1' }],
      inbox: [], visible: new Set(), excluded: false, ...extra,
    })
  }
  return { db, service, sessions, calls, call, add }
}

test('omitted revision fields keep the previous limits and a workspace grant can dispatch', async () => {
  const env = serviceWorld()
  env.add('sess-a')
  env.service.setAccess({ requestId: 'acc', expectedPolicyEpoch: 1, mode: 'selected', workspaceIds: ['ws-1'], sessionIds: [] }, { ...env.call, originKind: 'ui', policyEpoch: 1 })
  const context = await env.service.readContext({ targetSessionId: 'sess-a', call: { ...env.call, policyEpoch: 2 } })
  assert.equal(context.ok, true, JSON.stringify(context))
  const prepared = await env.service.prepare({
    requestId: 'req', targetSessionId: 'sess-a', contextToken: context.data.contextToken, goal: '改标题', instruction: '改标题。',
    criteria: ['标题不溢出'], exclusions: ['不要部署'],
  }, { ...env.call, policyEpoch: 2 })
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  const again = await env.service.readContext({ targetSessionId: 'sess-a', call: { ...env.call, originRef: 'user-2', policyEpoch: 2 } })
  const revised = await env.service.revise({
    requestId: 'rev', taskId: prepared.data.taskId, expectedTaskVersion: 1, contextToken: again.data.contextToken, instruction: '再改页脚',
  }, { ...env.call, originRef: 'user-2', policyEpoch: 2 })
  assert.equal(revised.ok, true, JSON.stringify(revised))
  const task = env.db.db.prepare(`SELECT criteria_json, exclusions_json FROM task WHERE id = ?`).get(prepared.data.taskId)
  assert.deepEqual(JSON.parse(task.criteria_json), ['标题不溢出'])
  assert.deepEqual(JSON.parse(task.exclusions_json), ['不要部署'])
  env.db.close()
})

test('revoking access and a stale context do not send, and stop does not report the old run as stopped', async () => {
  const env = serviceWorld()
  env.add('sess-a', { ownership: 'exclusive', turnId: 'turn-1', busy: false })
  const context = await env.service.readContext({ targetSessionId: 'sess-a', call: env.call })
  const prepared = await env.service.prepare({
    requestId: 'req', targetSessionId: 'sess-a', contextToken: context.data.contextToken, goal: '改标题', instruction: '改标题。', exclusions: ['不要部署'],
  }, env.call)
  env.sessions.get('sess-a').latestDirectUserSeq = 8
  env.sessions.get('sess-a').headSeq = 8
  const stale = await env.service.prepare({
    requestId: 'req-2', targetSessionId: 'sess-a', contextToken: context.data.contextToken, goal: '改标题', instruction: '改标题。', exclusions: ['不要部署'],
  }, env.call)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'CONTEXT_CHANGED')
  env.sessions.get('sess-a').latestDirectUserSeq = 3
  env.sessions.get('sess-a').headSeq = 4
  await env.service.tick()
  assert.equal(env.calls.followup, 1)
  env.db.db.prepare(`UPDATE action SET state = 'running' WHERE id = ?`).run(prepared.data.actionId)
  const second = await env.service.readContext({ targetSessionId: 'sess-a', call: { ...env.call, originRef: 'user-2' } })
  const revised = await env.service.revise({
    requestId: 'rev', taskId: prepared.data.taskId, expectedTaskVersion: 1, contextToken: second.data.contextToken, instruction: '再改一点',
  }, { ...env.call, originRef: 'user-2' })
  assert.equal(revised.ok, true)
  const stopped = await env.service.stop({ requestId: 'stop', taskId: prepared.data.taskId, expectedTaskVersion: 2 }, { ...env.call, originKind: 'ui' })
  assert.equal(stopped.data.disposition, 'stop_requested')
  const running = env.db.db.prepare(`SELECT state FROM action WHERE id = ?`).get(prepared.data.actionId)
  assert.equal(running.state, 'running')
  assert.equal(env.calls.cancel, 1)
  env.db.close()
})

test('revoking access after queue does not send the old action', async () => {
  const env = serviceWorld()
  env.add('sess-a', { busy: true })
  const context = await env.service.readContext({ targetSessionId: 'sess-a', call: env.call })
  const prepared = await env.service.prepare({
    requestId: 'req', targetSessionId: 'sess-a', contextToken: context.data.contextToken, goal: '改标题', instruction: '改标题。', exclusions: ['不要部署'],
  }, env.call)
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  const revoked = await env.service.setAccess({ requestId: 'none', expectedPolicyEpoch: 1, mode: 'none', workspaceIds: [], sessionIds: [] }, { ...env.call, originKind: 'ui' })
  assert.equal(revoked.ok, true, JSON.stringify(revoked))
  env.sessions.get('sess-a').busy = false
  await env.service.tick()
  assert.equal(env.calls.followup, 0)
  const state = env.db.db.prepare(`SELECT state FROM action WHERE id = ?`).get(prepared.data.actionId).state
  assert.equal(state, 'rejected')
  env.db.close()
})

test('an unknown delivery is not sent again after it was consumed', async () => {
  const env = serviceWorld()
  env.add('boop-main', { home: true })
  env.db.db.exec(`INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,created_at,updated_at,state_seq,engine_version,stop_requested) VALUES('tsk','scope-1','目标','active','not_requested',1,'[]','[]','t','t',0,2,0)`)
  env.db.db.exec(`INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,created_at) VALUES('tsk','scope-1',1,'{}','t')`)
  env.db.db.exec(`INSERT INTO action(id,scope_id,task_id,task_version,target_session_id,payload_hash,payload_json,state,policy_epoch,origin_ref,created_at,updated_at) VALUES('act','scope-1','tsk',1,'sess','h','{}','settled',1,'user','t','t')`)
  env.db.db.prepare(
    `INSERT INTO task_result(id,scope_id,task_id,task_version,action_id,logical_key,kind,source_generation,event_seq,outcome,deliverable,summary,artifacts_json,evidence_json,checks_json,missing_json,created_at)
     VALUES('res','scope-1','tsk',1,'act','k','final','g',1,'completed',1,'done','[]','[]','[]','[]','t')`,
  ).run()
  env.db.db.prepare(
    `INSERT INTO result_outbox(result_id,scope_id,native_message_id,target_main_session_id,target_binding_version,state,attempt,updated_at)
     VALUES('res','scope-1','boopres_res','boop-main',1,'unknown',1,'t')`,
  ).run()
  await env.service.deliver()
  assert.equal(env.calls.followup, 0)
  env.sessions.get('boop-main').visible.add('boopres_res')
  await env.service.deliver()
  const state = env.db.db.prepare(`SELECT state FROM result_outbox WHERE result_id = 'res'`).get().state
  assert.equal(state, 'sent')
  env.db.close()
})

test('a newer user message retires the previous candidate card', () => {
  const mention = formatSessionReferenceMention({ sessionId: 'sess-1', label: '原开发' })
  const value = { schemaVersion: 2, kind: 'boop.catalog', ok: true, data: { mode: 'work', originUserMessageId: 'u1', sourceSeq: 4, generatedAt: 't', truncated: false, candidates: [{ sessionId: 'sess-1', workspaceId: null, title: '原开发', workspaceTitle: null, mention, selectionKey: 'k', activity: 'idle', lastActivityAt: null, preview: null }] } }
  const card = { kind: 'tool-result', name: 'boop_catalog', isError: false, call: { id: 'c' }, content: [{ type: 'text', text: JSON.stringify(value) }] }
  assert.equal(readWorkChoice([card, { kind: 'user', source: { kind: 'user' } }]), null)
  assert.equal(readWorkChoice([{ kind: 'user' }, card])?.candidates.length, 1)
})

test('candidate insertion keeps the captured span and continue does not replace the draft', () => {
  const spans = []
  const actions = {
    captureInsertion: () => ({ start: 2, end: 2, draftRev: 7 }),
    insertReference: (_reference, span) => { spans.push(span); return true },
    insertText: (text, span) => { spans.push({ text, span }); return true },
    setDraft: () => { throw new Error('setDraft replaces the draft') },
  }
  assert.equal(insertSessionReference(actions, { mention: 'dsh-session:abc', label: '原会话' }), true)
  assert.equal(spans[0].draftRev, 7)
  assert.equal(insertDraftText(actions, '继续处理'), true)
  assert.equal(spans[1].text, '继续处理')
  assert.equal(insertSessionReference({ setDraft() { return true } }, { mention: 'x', label: 'y' }), false)
})

test('a failed refresh keeps the last task list', async () => {
  let fail = false
  const controller = new HomeController({
    async call(endpoint) {
      if (endpoint === 'boop/ensureHome') {
        return { data: { state: 'ready', mainSessionId: 'boop-main', bindingVersion: 1, capabilities: { send: true, readSources: true, delegate: true, stop: true, reasonCodes: [] } } }
      }
      if (fail) return { ok: false, error: { message: '连接断了' } }
      return { data: { items: [{ taskId: 't1', title: '还在', productState: 'running', statusText: '正在处理', target: { sessionId: 's', workspaceId: null, sessionTitle: '原会话', workspaceTitle: null }, taskVersion: 1, stateSeq: 1, needsAttentionReason: null, latestAction: null, latestResult: null, confirmation: { state: 'unavailable' }, verification: { state: 'not_checked', summary: '', checks: [] }, availableActions: ['view'], updatedAt: 't' }] } }
    },
    retain() { return { id: 'boop-main', native: { id: 'boop-main' }, ready: Promise.resolve(), release() {} } },
    connection: { getSnapshot: () => 'connected', subscribe: () => () => undefined, reconnect() {} },
    selectPanel() {},
    openSource() {},
    async insertReference() { return false },
    async setDraftText() { return false },
  })
  try {
    await controller.mount()
    assert.equal(controller.getSnapshot().tasks.length, 1)
    fail = true
    await controller.refreshTasks()
    assert.equal(controller.getSnapshot().tasks.length, 1)
    assert.match(controller.getSnapshot().notice ?? '', /连接断了/)
  } finally {
    controller.destroy()
  }
})
