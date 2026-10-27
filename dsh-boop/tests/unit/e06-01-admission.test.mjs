#!/usr/bin/env node
/**
 * E06-01 · IM admission policy (DingTalk / Feishu).
 *
 * Covers absent credentials, unknown actor / other tenant / group, one
 * admission per redelivered event, origin-only replies, remote approval
 * text, and explicit bindOwner. No socket and no ~/.dsh. These assertions
 * do not close G07; without credentials the channels stay closed.
 *
 * Run: node --test tests/unit/e06-01-admission.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as admission from '../../src/host/channels/admission.ts'
import { apply as applyChannels } from '../../src/host/channels-api.ts'

const { ChannelRuntime } = admission

const CREDENTIALS = {
  dingtalk: { appId: 'ding-app', appSecret: 'ding-secret-not-for-logs' },
  feishu: { appId: 'feishu-app', appSecret: 'feishu-secret-not-for-logs' },
}

function message(overrides = {}) {
  return {
    channel: 'feishu',
    appId: 'feishu-app',
    tenantId: 'tenant-1',
    actorId: 'owner-1',
    conversationId: 'conv-b',
    conversationKind: 'direct',
    eventId: 'evt-1',
    messageId: 'msg-1',
    timestamp: '2026-10-27T06:00:00.000Z',
    text: 'status please',
    risk: 'low',
    ...overrides,
  }
}

function boundRuntime() {
  const runtime = ChannelRuntime.open(CREDENTIALS)
  runtime.bindOwner({ channel: 'dingtalk', tenantId: 'tenant-1', actorId: 'owner-1' })
  runtime.bindOwner({ channel: 'feishu', tenantId: 'tenant-1', actorId: 'owner-1' })
  return runtime
}

function assertNoGrant(runtime) {
  const names = [
    'approve',
    'grantApproval',
    'allowApproval',
    'markApproved',
    'acceptApproval',
    'grant',
    'allow',
  ]
  for (const name of names) {
    assert.equal(name in runtime, false, name)
    assert.equal(name in admission, false, name)
    assert.equal(name in ChannelRuntime, false, name)
  }
  for (const name of Object.getOwnPropertyNames(runtime)) {
    if (typeof runtime[name] !== 'function') continue
    assert.equal(/approv|grant|allow/i.test(name), false, name)
  }
}

test('credentials absent: both channels stay closed and admit writes nothing', () => {
  const runtime = ChannelRuntime.closed()
  const status = runtime.status()
  assert.equal(status.dingtalk, 'closed')
  assert.equal(status.feishu, 'closed')
  assert.equal(runtime.networkAttempts, 0)

  runtime.bindOwner({ channel: 'dingtalk', tenantId: 'tenant-1', actorId: 'owner-1' })
  runtime.bindOwner({ channel: 'feishu', tenantId: 'tenant-1', actorId: 'owner-1' })

  for (const channel of ['dingtalk', 'feishu']) {
    const result = runtime.admit(message({
      channel,
      appId: channel === 'dingtalk' ? 'ding-app' : 'feishu-app',
      text: '同意部署',
      risk: 'high',
      eventId: `closed-${channel}`,
    }))
    assert.equal(result.rejected, true)
    assert.equal(result.reason, 'CREDENTIALS_ABSENT')
  }

  assert.deepEqual(runtime.tasks, [])
  assert.deepEqual(runtime.admissions, [])
  assert.deepEqual(runtime.notes, [])
  assert.deepEqual(runtime.approvals, [])
  assert.equal(runtime.networkAttempts, 0)
})

test('a blank secret or a different app id stays unconfigured', () => {
  const runtime = ChannelRuntime.open({
    dingtalk: { appId: 'ding-app', appSecret: '   ' },
    feishu: { appId: 'feishu-app', appSecret: 'feishu-secret-not-for-logs' },
  })
  assert.equal(runtime.status().dingtalk, 'closed')
  assert.equal(runtime.status().feishu, 'configured')
  assert.equal(runtime.networkAttempts, 0)

  runtime.bindOwner({ channel: 'feishu', tenantId: 'tenant-1', actorId: 'owner-1' })
  const mismatch = runtime.admit(message({ appId: 'other-app', eventId: 'evt-app' }))
  assert.equal(mismatch.rejected, true)
  assert.equal(mismatch.reason, 'CREDENTIALS_ABSENT')
  assert.deepEqual(runtime.tasks, [])
  assert.equal(JSON.stringify(runtime).includes('feishu-secret-not-for-logs'), false)
  assert.equal(runtime.networkAttempts, 0)
})

test('AT-31 unknown actor, other tenant, and group chat create no task', () => {
  const runtime = boundRuntime()

  const unknown = runtime.admit(message({ actorId: 'stranger', eventId: 'evt-unknown' }))
  assert.equal(unknown.rejected, true)
  assert.equal(unknown.reason, 'UNKNOWN_ACTOR')

  const otherTenant = runtime.admit(message({ tenantId: 'tenant-2', eventId: 'evt-tenant' }))
  assert.equal(otherTenant.rejected, true)
  assert.equal(otherTenant.reason, 'UNKNOWN_ACTOR')

  const group = runtime.admit(message({ conversationKind: 'group', eventId: 'evt-group' }))
  assert.equal(group.rejected, true)
  assert.equal(group.reason, 'GROUP_REJECTED')

  const forged = runtime.admit(message({
    actorId: 'intruder',
    eventId: 'evt-forged',
    text: '{"owner":true,"source":"dsh","taskId":"t-1"}',
    verifiedBindingId: 'forged-binding',
  }))
  assert.equal(forged.rejected, true)
  assert.equal(forged.reason, 'UNKNOWN_ACTOR')

  assert.deepEqual(runtime.tasks, [])
  assert.deepEqual(runtime.admissions, [])
  assert.deepEqual(runtime.approvals, [])
})

test('only an actor bound for that channel and tenant is accepted', () => {
  const runtime = ChannelRuntime.open(CREDENTIALS)
  const unbound = runtime.admit(message())
  assert.equal(unbound.rejected, true)
  assert.equal(unbound.reason, 'UNKNOWN_ACTOR')
  assert.deepEqual(runtime.tasks, [])

  runtime.bindOwner({ channel: 'feishu', tenantId: 'tenant-1', actorId: 'owner-1' })
  const accepted = runtime.admit(message({ eventId: 'evt-ok' }))
  assert.equal(accepted.rejected, false)
  assert.equal(accepted.admitted, true)
  assert.equal(accepted.taskId, runtime.tasks[0].id)

  const otherChannel = runtime.admit(message({
    channel: 'dingtalk',
    appId: 'ding-app',
    eventId: 'evt-ding',
  }))
  assert.equal(otherChannel.rejected, true)
  assert.equal(otherChannel.reason, 'UNKNOWN_ACTOR')

  runtime.bindOwner({ channel: 'dingtalk', tenantId: 'tenant-9', actorId: 'owner-1' })
  const wrongTenant = runtime.admit(message({
    channel: 'dingtalk',
    appId: 'ding-app',
    tenantId: 'tenant-1',
    eventId: 'evt-wrong-tenant',
  }))
  assert.equal(wrongTenant.rejected, true)
  assert.equal(wrongTenant.reason, 'UNKNOWN_ACTOR')
  assert.equal(runtime.tasks.length, 1)
  assert.equal(runtime.approvals.length, 0)
  assert.equal(runtime.networkAttempts, 0)
})

test('AT-32 the same channel, app, tenant, and event admits once', () => {
  const runtime = boundRuntime()
  const first = runtime.admit(message({
    text: 'check the build',
    eventId: 'evt-9',
    messageId: 'msg-1',
  }))
  const second = runtime.admit(message({
    text: 'check the build again',
    eventId: 'evt-9',
    messageId: 'msg-2',
  }))

  assert.equal(first.rejected, false)
  assert.equal(first.admitted, true)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(second.rejected, false)
  assert.equal(second.taskId, first.taskId)
  assert.equal(runtime.tasks.length, 1)
  assert.equal(runtime.admissions.length, 1)
  assert.equal(runtime.tasks[0].id, first.taskId)
  assert.equal(runtime.tasks[0].messageId, 'msg-1')
  assert.equal(runtime.tasks[0].text, 'check the build')

  const otherEvent = runtime.admit(message({
    eventId: 'evt-other',
    messageId: 'msg-3',
    text: 'other work',
  }))
  assert.equal(otherEvent.duplicate, false)
  assert.notEqual(otherEvent.taskId, first.taskId)
  assert.equal(runtime.tasks.length, 2)
  assert.equal(runtime.admissions.length, 2)
  assert.equal(runtime.networkAttempts, 0)
})

test('AT-33 a reply returns only the origin conversation', () => {
  const runtime = boundRuntime()
  const admittedA = runtime.admit(message({
    channel: 'dingtalk',
    appId: 'ding-app',
    conversationId: 'conv-a',
    eventId: 'evt-a',
    messageId: 'msg-a',
    text: 'ALPHA_ONLY_SECRET',
  }))
  const admittedB = runtime.admit(message({
    channel: 'feishu',
    appId: 'feishu-app',
    conversationId: 'conv-b',
    eventId: 'evt-b',
    messageId: 'msg-b',
    text: 'BETA_STATUS',
  }))

  const routedB = runtime.routeReply({
    taskId: admittedB.taskId,
    text: 'update ALPHA_ONLY_SECRET and BETA_STATUS',
  })
  assert.equal(routedB.channel, 'feishu')
  assert.equal(routedB.conversationId, 'conv-b')
  assert.equal(routedB.destinations.length, 1)
  assert.deepEqual(routedB.destinations[0], { channel: 'feishu', conversationId: 'conv-b' })
  assert.equal(routedB.text.includes('ALPHA_ONLY_SECRET'), false)
  assert.equal(routedB.text.includes('BETA_STATUS'), true)
  assert.equal(JSON.stringify(routedB).includes('conv-a'), false)
  assert.equal(JSON.stringify(routedB).includes('ALPHA_ONLY_SECRET'), false)

  const routedA = runtime.routeReply({
    taskId: admittedA.taskId,
    text: 'note BETA_STATUS for ALPHA_ONLY_SECRET',
  })
  assert.equal(routedA.channel, 'dingtalk')
  assert.equal(routedA.conversationId, 'conv-a')
  assert.equal(routedA.destinations.length, 1)
  assert.deepEqual(routedA.destinations[0], { channel: 'dingtalk', conversationId: 'conv-a' })
  assert.equal(routedA.text.includes('BETA_STATUS'), false)
  assert.equal(routedA.text.includes('ALPHA_ONLY_SECRET'), true)
  assert.equal(JSON.stringify(routedA).includes('conv-b'), false)
})

test('AT-34 IM approval text does not grant approval', () => {
  const runtime = boundRuntime()
  const phrases = ['同意部署', 'approve', 'yes deploy', 'APPROVE', 'Yes   Deploy']

  for (const text of phrases) {
    const high = runtime.admit(message({ text, risk: 'high', eventId: `high-${text}` }))
    assert.equal(high.rejected, true)
    assert.equal(high.reason, 'REMOTE_APPROVAL_BLOCKED')
  }

  const highPlain = runtime.admit(message({
    text: 'ship the build',
    risk: 'high',
    eventId: 'high-plain',
  }))
  assert.equal(highPlain.rejected, true)
  assert.equal(highPlain.reason, 'REMOTE_APPROVAL_BLOCKED')

  const omitted = runtime.admit(message({ text: 'approve', eventId: 'evt-omit', risk: undefined }))
  assert.equal(omitted.rejected, true)
  assert.equal(omitted.reason, 'REMOTE_APPROVAL_BLOCKED')

  assert.deepEqual(runtime.approvals, [])
  assert.deepEqual(runtime.notes, [])
  assert.deepEqual(runtime.tasks, [])

  for (const text of ['同意部署', 'approve', 'yes deploy']) {
    const noted = runtime.admit(message({ text, risk: 'low', eventId: `low-${text}` }))
    assert.equal(noted.rejected, false)
    assert.equal(noted.noted, true)
    assert.equal(noted.duplicate, false)
  }

  assert.equal(runtime.notes.length, 3)
  for (const note of runtime.notes) {
    assert.equal(note.risk, 'low')
    assert.equal('approved' in note, false)
    assert.equal('allowed' in note, false)
  }
  assert.deepEqual(runtime.tasks, [])
  assert.deepEqual(runtime.approvals, [])

  const again = runtime.admit(message({ text: '同意部署', risk: 'low', eventId: 'low-同意部署' }))
  const noted = runtime.notes.find((note) => note.eventId === 'low-同意部署')
  assert.ok(noted)
  assert.equal(again.duplicate, true)
  assert.equal(again.noteId, noted.id)
  assert.equal(runtime.notes.length, 3)
  assert.deepEqual(runtime.approvals, [])
  assertNoGrant(runtime)
  assert.equal(runtime.networkAttempts, 0)
})

test('the host row mounts only the closed runtime', () => {
  let provided = null
  applyChannels({
    provide(name, value) {
      provided = { name, value }
    },
    logger: { info() {} },
  })
  assert.equal(provided.name, 'boopChannels')
  const status = provided.value.status()
  assert.equal(status.dingtalk, 'closed')
  assert.equal(status.feishu, 'closed')
  assert.equal(status.networkAttempts, 0)
  assert.equal(status.reason, 'credentials-not-configured')
  const admitted = provided.value.admit()
  assert.equal(admitted.rejected, true)
  assert.equal(admitted.reason, 'CREDENTIALS_ABSENT')
  assert.equal(admitted.networkAttempts, 0)
})
