import assert from 'node:assert/strict'
import test from 'node:test'
import { ImTools } from '../lib/im-tools.js'

function fixture(relay) {
  const guards = [],
    definitions = [],
    wrappers = []
  const ctx = {
    on(event, fn) {
      assert.equal(event, 'tools/execute')
      wrappers.push(fn)
      return () => wrappers.pop()
    },
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
      if (name === 'dingtalkRelay') return relay
      return name
    },
  }
  const im = new ImTools(() => ({
    createTool(identity, host) {
      return { name: 'dingtalk_call', execute: async () => ({ identity: identity(), host: host() }) }
    },
  }))
  const agent = { id: 'session', ctx }
  return { ctx, agent, im, guards, definitions, wrappers }
}

test('enterprise read queries use the verified sender, exact permitted audience and current lease through dispatch', async () => {
  const query = 'mcp__doris__exec_query'
  const owner = { corpId: 'corp', userId: 'a' }
  const message = {
    senderCorpId: 'corp',
    senderStaffId: 'a',
    conversationType: 'group',
    conversationId: 'permitted',
    atUsers: [{ userId: 'b' }],
  }
  const lease = new AbortController()
  let current = owner
  const relay = {
    enterpriseQueries: (msg) =>
      msg === message
        ? (name) => (name === query ? { identity: current, signal: lease.signal } : undefined)
        : undefined,
  }
  const f = fixture(relay)
  const guard = (name = query, agent = f.agent) => f.guards[0]({ name, agent })
  f.im.install(f.ctx, f.agent)
  assert.match(guard(), /im_enterprise_query_unavailable/)
  f.im.bind(f.ctx, message, f.agent)
  assert.equal(guard(), undefined)
  for (const name of [
    'mcp__openmetadata__patch_entity',
    'mcp__doris__kill_query',
    'mcp__doris__exec_query_more',
    'bash',
    'read',
  ])
    assert.match(guard(name), /im_workspace_policy_unavailable/)
  assert.match(guard('mcp__wren__run_semantic_sql'), /im_enterprise_query_unavailable/)
  assert.match(guard(query, { ...f.agent }), /im_agent_mismatch/)
  assert.throws(() => f.im.bind(f.ctx, { ...message, conversationType: 'direct' }, f.agent), /im_conversation_changed/)
  const exec = { name: query, agent: f.agent, signal: new AbortController().signal }
  for (current of [undefined, { ...owner, corpId: 'other' }, { ...owner, userId: 'b' }]) {
    assert.match(guard(), /im_enterprise_query_unavailable/)
    await assert.rejects(
      f.wrappers[0](exec, () => assert.fail('must not dispatch')),
      /im_enterprise_query_unavailable/,
    )
  }
  current = owner
  const original = exec.signal
  assert.equal(f.guards[0](exec), undefined)
  await assert.rejects(
    f.wrappers[0](exec, async () => {
      current = undefined
      return 'sensitive-result'
    }),
    /im_enterprise_query_unavailable/,
  )
  current = owner
  assert.equal(f.guards[0](exec), undefined)
  await assert.rejects(
    f.wrappers[0](exec, async () => {
      assert.equal(exec.signal.aborted, false)
      lease.abort()
      assert.equal(exec.signal.aborted, true)
    }),
    /im_enterprise_query_unavailable/,
  )
  assert.equal(exec.signal, original)
  assert.match(guard(), /im_enterprise_query_unavailable/)
  // A similar object from a different receiver carries no real delivery receipt.
  const other = fixture(relay)
  other.im.bind(other.ctx, { ...message }, other.agent)
  assert.match(other.guards[0]({ name: query, agent: other.agent }), /im_enterprise_query_unavailable/)
})

test('IM shadows the Web tool, installs once, and permits only scoped DingTalk and interaction tools', () => {
  const f = fixture()
  f.im.install(f.ctx, f.agent)
  f.im.install(f.ctx, f.agent)
  assert.equal(f.definitions.length, 1)
  assert.equal(f.guards.length, 1)
  for (const name of ['dingtalk_call', 'skill', 'ask_user_question'])
    assert.equal(f.guards[0]({ name, agent: f.agent }), undefined)
  for (const name of ['bash', 'run_code', 'unknown'])
    assert.match(f.guards[0]({ name, agent: f.agent }), /im_workspace_policy_unavailable/)
  for (const name of ['subagent', 'spawn_agent'])
    assert.match(f.guards[0]({ name, agent: f.agent }), /im_subagent_inheritance_unavailable/)
  for (const name of ['send_file', 'send_image'])
    assert.match(f.guards[0]({ name, agent: f.agent }), /im_file_transfer_unavailable/)
})

test('a committed workspace policy still denies the unverified PTC entry while allowing reviewed tools', () => {
  const guards = []
  const ctx = {
    tools: {
      register: () => () => {},
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    get: () => undefined,
  }
  const im = new ImTools(() => ({ createTool: () => ({ name: 'dingtalk_call', execute: async () => ({}) }) }), {
    allowed: () => true,
  })
  const agent = { id: 'session', ctx }
  im.install(ctx, agent)
  assert.equal(guards[0]({ name: 'bash', agent }), undefined)
  assert.match(guards[0]({ name: 'run_code', agent }), /im_tool_inheritance_unreviewed/)
})
test('trusted message identity is pinned per Agent; model arguments and another chat cannot select it', async () => {
  const f = fixture(),
    second = fixture()
  f.im.bind(f.ctx, { senderCorpId: 'corp-a', senderStaffId: 'owner' }, f.agent)
  second.im.bind(second.ctx, { senderCorpId: 'corp-b', senderStaffId: 'owner' }, second.agent)
  const call = await f.definitions[0].execute({ corpId: 'corp-b', userId: 'attacker' }, { agent: f.agent })
  assert.deepEqual(call.identity, { corpId: 'corp-a', userId: 'owner' })
  assert.ok(Object.isFrozen(call.identity))
  assert.equal(call.host.approval, 'approval')
  assert.equal((await second.definitions[0].execute({}, { agent: second.agent })).identity.corpId, 'corp-b')
  assert.throws(
    () => f.im.bind(f.ctx, { senderCorpId: 'corp-b', senderStaffId: 'owner' }, f.agent),
    /im_identity_changed/,
  )
  assert.throws(() => f.im.bind(f.ctx, {}, f.agent), /im_identity_changed/)
  assert.equal((await f.definitions[0].execute({}, { agent: f.agent })).identity.corpId, 'corp-a')
})

test('missing message identity or Host services never falls back to the global Web tool', async () => {
  const f = fixture()
  f.im.bind(f.ctx, { senderStaffId: 'owner', chatbotCorpId: 'corp-a' }, f.agent)
  assert.equal((await f.definitions[0].execute({}, { agent: f.agent })).identity, undefined)
  assert.throws(() => new ImTools(() => undefined).install(f.ctx, f.agent), /im_connection_service_unavailable/)
  assert.throws(() => f.im.install({ tools: {} }, f.agent), /im_tool_boundary_unavailable/)
})

test('a child, foreign or replacement Agent cannot inherit the pinned identity or guard', async () => {
  const f = fixture()
  f.im.bind(f.ctx, { senderCorpId: 'corp-a', senderStaffId: 'owner' }, f.agent)
  for (const agent of [undefined, { id: 'child', ctx: f.ctx }, { ...f.agent }]) {
    assert.equal(f.guards[0]({ name: 'dingtalk_call', agent }), 'im_agent_mismatch')
    await assert.rejects(f.definitions[0].execute({}, { agent }), /im_agent_mismatch/)
  }
  assert.throws(() => f.im.install(f.ctx, { ...f.agent }), /im_agent_changed/)
})

test('failed guard installation removes the shadow and allows a safe setup retry', () => {
  const f = fixture()
  let registered = 0
  f.ctx.tools.register = () => {
    registered++
    return () => registered--
  }
  const guard = f.ctx.tools.guard
  f.ctx.tools.guard = () => {
    throw new Error('guard_registration_failed')
  }
  assert.throws(() => f.im.install(f.ctx, f.agent), /guard_registration_failed/)
  assert.equal(registered, 0)
  f.ctx.tools.guard = guard
  f.im.install(f.ctx, f.agent)
  assert.equal(registered, 1)
  assert.equal(f.guards.length, 1)
})
