import assert from 'node:assert/strict'
import test from 'node:test'
import { ImTools } from '../lib/im-tools.js'

function fixture() {
  const guards = [],
    definitions = []
  const ctx = {
    tools: {
      register(tool) {
        definitions.push(tool)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    get(name) {
      return name
    },
  }
  const im = new ImTools(() => ({
    createTool(identity, host) {
      return { name: 'dingtalk_call', execute: async () => ({ identity: identity(), host: host() }) }
    },
  }))
  return { ctx, im, guards, definitions }
}

test('IM shadows the Web tool, installs once, and permits only scoped DingTalk and interaction tools', () => {
  const f = fixture()
  f.im.install(f.ctx)
  f.im.install(f.ctx)
  assert.equal(f.definitions.length, 1)
  assert.equal(f.guards.length, 1)
  for (const name of ['dingtalk_call', 'skill', 'ask_user_question']) assert.equal(f.guards[0]({ name }), undefined)
  for (const name of ['bash', 'run_code', 'send_file', 'spawn_agent', 'unknown'])
    assert.match(f.guards[0]({ name }), /im_tool_unavailable/)
})

test('trusted message identity is pinned per Agent; model arguments and another chat cannot select it', async () => {
  const f = fixture(),
    second = fixture()
  f.im.bind(f.ctx, { senderCorpId: 'corp-a', senderStaffId: 'owner' })
  second.im.bind(second.ctx, { senderCorpId: 'corp-b', senderStaffId: 'owner' })
  const call = await f.definitions[0].execute({ corpId: 'corp-b', userId: 'attacker' })
  assert.deepEqual(call.identity, { corpId: 'corp-a', userId: 'owner' })
  assert.ok(Object.isFrozen(call.identity))
  assert.equal(call.host.approval, 'approval')
  assert.equal((await second.definitions[0].execute()).identity.corpId, 'corp-b')
  assert.throws(() => f.im.bind(f.ctx, { senderCorpId: 'corp-b', senderStaffId: 'owner' }), /im_identity_changed/)
  assert.throws(() => f.im.bind(f.ctx, {}), /im_identity_changed/)
  assert.equal((await f.definitions[0].execute()).identity.corpId, 'corp-a')
})

test('missing message identity or Host services never falls back to the global Web tool', async () => {
  const f = fixture()
  f.im.bind(f.ctx, { senderStaffId: 'owner', chatbotCorpId: 'corp-a' })
  assert.equal((await f.definitions[0].execute()).identity, undefined)
  assert.throws(() => new ImTools(() => undefined).install(f.ctx), /im_connection_service_unavailable/)
  assert.throws(() => f.im.install({ tools: {} }), /im_tool_boundary_unavailable/)
})
