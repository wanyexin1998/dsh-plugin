/**
 * BOOP v0.2 delegation controller.
 *
 * Synthetic sessions only. No host, no model, no user DSH_HOME.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoopDatabase } from '../../src/host/persistence/database.ts'
import { CORE_DDL } from '../../src/host/persistence/schema.ts'
import { migrate } from '../../src/host/persistence/migrate.ts'
import { BoopRepository } from '../../src/host/persistence/repository.ts'
import { DelegationService } from '../../src/host/delegation/service.ts'
import { gateHomeReferences } from '../../src/host/home/reference-guard.ts'
import { encodeSessionReferenceUri, formatSessionReferenceMention, parseSessionReferenceText } from '../../src/shared/session-mention.ts'
import { projectTask } from '../../src/host/delegation/projection.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function world() {
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.bootstrap()
  const repo = new BoopRepository(db, () => '2026-10-28T00:00:00.000Z', () => 'legacy')
  repo.ensureScope('scope-1', 'owner-1')
  const sessions = new Map()
  const calls = { followup: [], flush: 0, cancel: [], remove: [] }
  let clock = Date.parse('2026-10-28T00:00:00.000Z')
  const ports = {
    now: () => new Date(clock).toISOString(),
    nowMs: () => clock,
    fenceOk: () => true,
    async listSessions() {
      return [...sessions.values()]
    },
    async observe(sessionId) {
      return sessions.get(sessionId) ?? null
    },
    async readEvents(sessionId) {
      const session = sessions.get(sessionId)
      return session?.events ?? []
    },
    excluded(sessionId) {
      return sessions.get(sessionId)?.excluded === true
    },
    hostCanRead(sessionId) {
      return sessions.has(sessionId)
    },
    async followup(sessionId, message) {
      calls.followup.push({ sessionId, message })
      const session = sessions.get(sessionId)
      if (!session) return 'before-enqueue'
      if (session.fail === 'before') return 'before-enqueue'
      if (session.fail === 'unknown') throw new Error('socket dropped')
      session.inbox.push(message)
      return 'enqueued'
    },
    async flush() {
      calls.flush += 1
      return true
    },
    async pending(sessionId, messageId) {
      return Boolean(sessions.get(sessionId)?.inbox.some((message) => message.id === messageId))
    },
    async visible(sessionId, messageId) {
      return Boolean(sessions.get(sessionId)?.visible?.has(messageId))
    },
    async remove(sessionId, messageId) {
      calls.remove.push(messageId)
      const session = sessions.get(sessionId)
      if (!session) return false
      const before = session.inbox.length
      session.inbox = session.inbox.filter((message) => message.id !== messageId)
      return session.inbox.length !== before
    },
    async cancelTurn(sessionId) {
      calls.cancel.push(sessionId)
      const session = sessions.get(sessionId)
      if (session) session.cancelled = true
    },
    async mainIdle() {
      return sessions.get('boop-main')?.busy !== true
    },
  }
  const service = new DelegationService(db, 'scope-1', ports)
  service.inheritAccess('owner-1', 'test')
  function addSession(sessionId, extra = {}) {
    sessions.set(sessionId, {
      reachable: true,
      busy: false,
      pendingHuman: false,
      archived: false,
      subagent: false,
      home: false,
      title: extra.title ?? sessionId,
      workspaceId: extra.workspaceId ?? 'ws-1',
      workspaceTitle: '演示项目',
      activity: extra.busy ? 'running' : 'idle',
      lastActivityAt: '2026-10-28T00:00:00.000Z',
      preview: extra.preview ?? null,
      sourceGeneration: 'gen-1',
      headSeq: 4,
      latestDirectUserSeq: 3,
      latestDirectUserMessageId: 'user-1',
      pendingMessage: false,
      turnId: null,
      turnTerminal: false,
      ownership: 'not_started',
      approvalId: null,
      summary: null,
      deliverable: false,
      checks: [],
      artifacts: [],
      missing: [],
      evidenceSeq: 8,
      events: [{ seq: 3, text: '先不要部署。', sessionId, sourceGeneration: 'gen-1' }],
      inbox: [],
      visible: new Set(),
      excluded: false,
      ...extra,
    })
  }
  addSession('boop-main', { home: true, title: '波波' })
  const call = {
    originRef: 'user-msg-1',
    originKind: 'user',
    mainSessionId: 'boop-main',
    bindingVersion: 1,
    policyEpoch: 1,
    holder: 'owner-1',
    fence: 1,
  }
  return { db, service, sessions, calls, call, addSession, setClock: (value) => { clock = value } }
}

async function delegate(env, sessionId = 'sess-a') {
  const context = await env.service.readContext({ targetSessionId: sessionId, question: '近况', call: env.call })
  assert.equal(context.ok, true, JSON.stringify(context))
  const prepared = await env.service.prepare({
    requestId: 'req-1',
    targetSessionId: sessionId,
    contextToken: context.data.contextToken,
    goal: '检查窄屏标题',
    instruction: '修复演示页面的窄屏标题换行，并运行对应检查。不提交、不部署。',
    criteria: ['窄屏标题不溢出'],
    exclusions: ['不提交', '不部署'],
  }, env.call)
  return { context, prepared }
}

test('ordinary chat does not create a task', async () => {
  const env = world()
  const page = env.service.list()
  assert.equal(page.items.length, 0)
  const catalog = await env.service.catalog({ mode: 'capabilities', originUserMessageId: null, sourceSeq: null, capabilities: env.service.capabilities(true) })
  assert.equal(catalog.ok, true)
  assert.equal(env.service.list().items.length, 0)
  env.db.close()
})

test('a repeated request creates one action and a busy target does not block an idle one', async () => {
  const env = world()
  env.addSession('sess-busy', { busy: true, title: '忙碌会话' })
  env.addSession('sess-idle', { title: '空闲会话' })
  const firstContext = await env.service.readContext({ targetSessionId: 'sess-busy', call: env.call })
  const first = await env.service.prepare({
    requestId: 'busy-1',
    targetSessionId: 'sess-busy',
    contextToken: firstContext.data.contextToken,
    goal: '等忙碌会话',
    instruction: '等它空闲后再核对。',
    exclusions: ['不部署'],
  }, env.call)
  assert.equal(first.ok, true)
  const again = await env.service.prepare({
    requestId: 'busy-1',
    targetSessionId: 'sess-busy',
    contextToken: firstContext.data.contextToken,
    goal: '等忙碌会话',
    instruction: '等它空闲后再核对。',
    exclusions: ['不部署'],
  }, env.call)
  assert.equal(again.ok, true)
  assert.equal(again.replayed, true)
  assert.equal(again.data.actionId, first.data.actionId)
  const secondContext = await env.service.readContext({ targetSessionId: 'sess-idle', call: { ...env.call, originRef: 'user-msg-2' } })
  const second = await env.service.prepare({
    requestId: 'idle-1',
    targetSessionId: 'sess-idle',
    contextToken: secondContext.data.contextToken,
    goal: '先做空闲会话',
    instruction: '空闲的先做。',
    exclusions: ['不部署'],
  }, { ...env.call, originRef: 'user-msg-2' })
  assert.equal(second.ok, true)
  await env.service.tick()
  const busy = env.service.detail(first.data.taskId)
  const idle = env.service.detail(second.data.taskId)
  assert.equal(busy.productState, 'waiting_target')
  assert.equal(idle.productState, 'accepted')
  assert.equal(env.calls.followup.length, 1)
  assert.equal(env.calls.followup[0].sessionId, 'sess-idle')
  assert.equal(env.calls.followup[0].message.source.kind, 'boop-command')
  const active = env.db.db.prepare(`SELECT COUNT(*) c FROM action WHERE scope_id = 'scope-1' AND managed_v2 = 1 AND state IN ('dispatching','accepted','running','outcome_unknown')`).get().c
  assert.equal(active, 1)
  env.db.close()
})

test('confirm does not turn failed checks into passed', async () => {
  const env = world()
  env.addSession('sess-a', { title: '原开发会话' })
  const { prepared } = await delegate(env)
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  await env.service.tick()
  const session = env.sessions.get('sess-a')
  session.inbox = []
  session.turnId = 'turn-1'
  session.turnTerminal = true
  session.ownership = 'ended'
  session.summary = '调整了标题换行。'
  session.deliverable = true
  session.checks = [{ criterion: '窄屏标题不溢出', state: 'failed', evidence: [{ sessionId: 'sess-a', sourceGeneration: 'gen-1', seq: 8 }] }]
  session.missing = ['自动检查没有通过']
  session.visible.add(env.calls.followup[0].message.id)
  await env.service.tick()
  const delivered = env.service.detail(prepared.data.taskId)
  assert.equal(delivered.productState, 'delivered')
  assert.equal(delivered.verification.state, 'failed')
  assert.equal(delivered.confirmation.state, 'pending')
  const accepted = await env.service.confirm({
    requestId: 'acc-1',
    taskId: prepared.data.taskId,
    expectedTaskVersion: 1,
    resultId: delivered.latestResult.resultId,
    decision: 'accept',
  }, { ...env.call, originKind: 'ui', originRef: 'ui-confirm' })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.data.verificationChangedToPassed, false)
  const after = env.service.detail(prepared.data.taskId)
  assert.equal(after.confirmation.state, 'accepted')
  assert.equal(after.verification.state, 'failed')
  assert.equal(after.verification.checks[0].state, 'failed')
  const task = env.db.db.prepare(`SELECT verification, lifecycle FROM task WHERE id = ?`).get(prepared.data.taskId)
  assert.equal(task.verification, 'waived')
  assert.equal(task.lifecycle, 'completed')
  const model = await env.service.confirm({
    requestId: 'acc-2',
    taskId: prepared.data.taskId,
    expectedTaskVersion: 1,
    resultId: delivered.latestResult.resultId,
    decision: 'accept',
  }, env.call)
  assert.equal(model.ok, false)
  assert.equal(model.error.code, 'SCOPE_DENIED')
  env.db.close()
})

test('stop does not cancel a turn the user has taken over', async () => {
  const env = world()
  env.addSession('sess-a')
  const { prepared } = await delegate(env)
  await env.service.tick()
  const session = env.sessions.get('sess-a')
  session.inbox = []
  session.turnId = 'turn-user'
  session.ownership = 'user_takeover'
  session.pendingMessage = false
  const stopped = await env.service.stop({
    requestId: 'stop-1',
    taskId: prepared.data.taskId,
    expectedTaskVersion: 1,
  }, { ...env.call, originKind: 'ui', originRef: 'ui-stop' })
  assert.equal(stopped.ok, true, JSON.stringify(stopped))
  assert.equal(stopped.data.disposition, 'stopped_future_only')
  assert.equal(env.calls.cancel.length, 0)
  const view = env.service.detail(prepared.data.taskId)
  assert.notEqual(view.productState, 'stopped')
  env.db.close()
})

test('a lost followup stays unknown and reconcile does not send it again', async () => {
  const env = world()
  env.addSession('sess-a', { fail: 'unknown' })
  const { prepared } = await delegate(env)
  await env.service.tick()
  const unknown = env.service.detail(prepared.data.taskId)
  assert.equal(unknown.productState, 'needs_attention')
  assert.equal(env.calls.followup.length, 1)
  env.sessions.get('sess-a').fail = undefined
  env.sessions.get('sess-a').reachable = true
  env.sessions.get('sess-a').turnId = null
  env.sessions.get('sess-a').pendingMessage = false
  await env.service.reconcile(prepared.data.taskId)
  assert.equal(env.calls.followup.length, 1, 'reconcile must not send the instruction again')
  const after = env.service.detail(prepared.data.taskId)
  assert.equal(after.latestResult.outcome, 'inconclusive')
  assert.notEqual(after.verification.state, 'passed')
  env.db.close()
})

test('revise keeps the old result and does not reuse acceptance', async () => {
  const env = world()
  env.addSession('sess-a')
  const { prepared } = await delegate(env)
  await env.service.tick()
  const session = env.sessions.get('sess-a')
  session.inbox = []
  session.turnTerminal = true
  session.turnId = 'turn-1'
  session.ownership = 'ended'
  session.summary = '第一版结果'
  session.deliverable = true
  session.checks = [{ criterion: '窄屏标题不溢出', state: 'unknown', evidence: [] }]
  await env.service.tick()
  const delivered = env.service.detail(prepared.data.taskId)
  await env.service.confirm({
    requestId: 'acc-1',
    taskId: prepared.data.taskId,
    expectedTaskVersion: 1,
    resultId: delivered.latestResult.resultId,
    decision: 'accept',
  }, { ...env.call, originKind: 'ui', originRef: 'ui-1' })
  const context = await env.service.readContext({ targetSessionId: 'sess-a', taskId: prepared.data.taskId, call: { ...env.call, originRef: 'user-2' } })
  const revised = await env.service.revise({
    requestId: 'rev-1',
    taskId: prepared.data.taskId,
    expectedTaskVersion: 1,
    contextToken: context.data.contextToken,
    instruction: '标题还要再收窄一点。',
    exclusions: ['不部署'],
  }, { ...env.call, originRef: 'user-2' })
  assert.equal(revised.ok, true, JSON.stringify(revised))
  assert.equal(revised.data.appliedTaskVersion, 2)
  const view = env.service.detail(prepared.data.taskId)
  assert.equal(view.taskVersion, 2)
  assert.equal(view.confirmation.state, 'unavailable')
  assert.notEqual(view.verification.state, 'passed')
  const old = env.db.db.prepare(`SELECT task_version, summary FROM task_result WHERE task_id = ? AND task_version = 1`).get(prepared.data.taskId)
  assert.equal(old.summary, '第一版结果')
  env.db.close()
})

test('excluded mentions are not left as readable URIs', () => {
  const secret = 'sess-secret'
  const allowed = 'sess-ok'
  const text = `请看 ${formatSessionReferenceMention({ sessionId: secret, label: '保密会话' })} 和 ${formatSessionReferenceMention({ sessionId: allowed, label: '可看会话' })} 以及 ${encodeSessionReferenceUri(secret)}`
  const gated = gateHomeReferences([{ source: { kind: 'user' }, content: [{ type: 'text', text }] }], {
    decide(sessionId) {
      return sessionId === allowed ? 'allow' : 'deny'
    },
  })
  const body = gated[0].content[0].text
  assert.equal(body.includes(encodeSessionReferenceUri(secret)), false)
  assert.equal(body.includes('保密会话'), true)
  assert.equal(body.includes(encodeSessionReferenceUri(allowed)), true)
  const parsed = parseSessionReferenceText(body)
  assert.deepEqual(parsed.references.map((item) => item.sessionId), [allowed])
})

test('v1 rows survive schema 2 and a failed backup does not upgrade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-mvp-mig-'))
  const file = path.join(dir, 'boop.sqlite')
  const db = new BoopDatabase({ path: file, fts: false })
  db.db.exec(CORE_DDL)
  db.db.exec(`INSERT INTO meta(key,value) VALUES('schema_version','1')`)
  db.db.exec(`INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'t')`)
  db.db.exec(`INSERT INTO task(id,scope_id,goal,lifecycle,verification,version,criteria_json,exclusions_json,created_at,updated_at) VALUES('old','s','旧目标','active','pending',1,'[]','["不部署"]','t','t')`)
  db.db.exec(`INSERT INTO task_revision(task_id,scope_id,version,snapshot_json,created_at) VALUES('old','s',1,'{}','t')`)
  db.db.exec(`INSERT INTO task_target(task_id,scope_id,workspace_id,session_id,role,resource_key) VALUES('old','s','ws','sess','executor','k')`)
  assert.throws(() => migrate(db), /backup directory/)
  assert.equal(db.schemaVersion(), 1)
  const report = migrate(db, { backupDir: path.join(dir, 'backups') })
  assert.equal(report.to, 2)
  assert.equal(report.integrity, 'ok')
  const task = db.db.prepare(`SELECT goal, exclusions_json, engine_version, state_seq FROM task WHERE id = 'old'`).get()
  assert.equal(task.goal, '旧目标')
  assert.equal(task.exclusions_json, '["不部署"]')
  assert.equal(task.engine_version, 1)
  assert.equal(task.state_seq, 0)
  const target = db.db.prepare(`SELECT workspace_id, session_id FROM task_target WHERE task_id = 'old'`).get()
  assert.equal(target.session_id, 'sess')
  assert.equal(target.workspace_id, 'ws')
  const backup = fs.readdirSync(path.join(dir, 'backups')).find((name) => name.endsWith('.sqlite'))
  assert.ok(backup)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('missing meta on a business database is not treated as empty', () => {
  const db = new BoopDatabase({ path: ':memory:', wal: false, fts: false })
  db.db.exec(CORE_DDL)
  db.db.exec(`INSERT INTO scopes(scope_id,owner_id,policy_epoch,schema_version,created_at) VALUES('s','o',1,1,'t')`)
  db.db.exec(`DELETE FROM meta`)
  const inspection = db.inspect()
  assert.equal(inspection.kind, 'corrupt')
  assert.throws(() => db.bootstrap(), /MIGRATION_FAILED/)
  assert.equal(db.db.prepare(`SELECT goal FROM task`).get(), undefined)
  db.close()
})

test('projection keeps delivery and verification apart when the reply only says done', () => {
  const view = projectTask({
    taskId: 't',
    taskVersion: 1,
    stateSeq: 2,
    title: '检查窄屏',
    updatedAt: '2026-10-28T00:00:00.000Z',
    engineVersion: 2,
    recovery: false,
    target: { sessionId: 's', workspaceId: null, sessionTitle: '原会话', workspaceTitle: null },
    action: { actionId: 'a', executionState: 'settled', stopRequested: false, queueReason: null, ownership: 'ended', nativeApprovalId: null },
    result: {
      resultId: 'r',
      taskVersion: 1,
      actionId: 'a',
      kind: 'final',
      outcome: 'inconclusive',
      deliverable: false,
      summary: '完成了',
      artifacts: [],
      evidence: [],
      checks: [],
      missing: ['没有可定位结果'],
      deliveryState: 'sent',
      createdAt: '2026-10-28T00:00:00.000Z',
    },
    acceptance: null,
  })
  assert.equal(view.productState, 'received_reply')
  assert.equal(view.verification.state, 'not_checked')
  assert.equal(view.confirmation.state, 'unavailable')
  assert.equal(view.availableActions.includes('confirm'), false)
})
