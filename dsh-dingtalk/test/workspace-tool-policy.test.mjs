import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceToolPolicy } from '../lib/workspace-tool-policy.js'
import { ImTools } from '../lib/im-tools.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-owner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = realpathSync(root),
    other = join(cwd, 'other')
  await mkdir(other)
  let selected = cwd,
    lease = new AbortController()
  let authority = {
    identity: { corpId: 'corp-a', userId: 'owner-a' },
    bindingId: 'pair-a',
    profile: '/fixture/profile-a',
    signal: lease.signal,
  }
  const owners = new Map(),
    bindings = new Map()
  const options = { authority: () => authority, selectedWorkspace: () => selected, owners, bindings }
  const policy = new WorkspaceToolPolicy(options)
  const message = { senderCorpId: 'corp-a', senderStaffId: 'owner-a' }
  function agent(id = 'session-a', directory = cwd) {
    const listeners = new Map(),
      guards = [],
      tools = new Map()
    const ctx = {
      on(name, handler) {
        listeners.set(name, handler)
        return () => listeners.delete(name)
      },
      get(name) {
        if (name === 'workingDirectory') return { get: (session) => session.header.cwd }
      },
      tools: {
        register(tool) {
          tools.set(tool.name, tool)
          return () => tools.delete(tool.name)
        },
        guard(check) {
          guards.push(check)
          return () => guards.splice(guards.indexOf(check), 1)
        },
      },
    }
    return { id, ctx, session: { id, header: { cwd: directory } }, listeners, guards, tools }
  }
  function commit(target = agent(), admission = policy.capture(message, 'chat', selected), restoring = false) {
    new ImTools(
      () => ({ createTool: () => ({ name: 'dingtalk_call', execute: async () => ({ status: 'auth_required' }) }) }),
      policy,
    ).bind(target.ctx, message, target)
    const setup = admission.setup(target.ctx, target, restoring)
    setup.commit()
    bindings.set('chat', target.id)
    return target
  }
  return {
    cwd,
    other,
    message,
    owners,
    bindings,
    options,
    policy,
    agent,
    commit,
    capture: () => policy.capture(message, 'chat', selected),
    select: (value) => {
      selected = value
    },
    authority: () => authority,
    replace: (patch) => {
      lease.abort()
      lease = new AbortController()
      authority = { ...authority, ...patch, signal: lease.signal }
    },
    revoke: () => {
      lease.abort()
      authority = undefined
    },
  }
}

test('personal owner ordinary tools require commit, exact workspace and channel pairing, independently of DWS', async (t) => {
  const f = await fixture(t),
    target = f.agent(),
    admission = f.capture()
  const setup = admission.setup(target.ctx, target, false)
  assert.equal(f.policy.allowed(target), false)
  setup.commit()
  assert.equal(f.policy.allowed(target), false, 'the session must also belong to the channel binding')
  f.bindings.set('chat', target.id)
  assert.equal(f.policy.allowed(target), true)
  const im = new ImTools(
    () => ({ createTool: () => ({ name: 'dingtalk_call', execute: async () => ({ status: 'auth_required' }) }) }),
    f.policy,
  )
  im.bind(target.ctx, f.message, target)
  assert.equal(target.guards[0]({ name: 'read', agent: target }), undefined)
  for (const name of ['workflow', 'ralph', 'spawn_teammate', 'custom_delegation', 'unknown'])
    assert.match(target.guards[0]({ name, agent: target }), /im_tool_inheritance_unreviewed/)
  assert.equal((await target.tools.get('dingtalk_call').execute({}, { agent: target })).status, 'auth_required')
  for (const name of ['send_file', 'send_image', 'subagent', 'spawn_agent'])
    assert.match(target.guards[0]({ name, agent: target }), /im_tool_unavailable/)
  assert.equal(f.policy.allowed({ ...target }), false)
})

test('queued admission, setup and commit cannot cross channel revocation or re-pair even for the same owner', async (t) => {
  const f = await fixture(t),
    queued = f.capture(),
    target = f.agent()
  const setup = queued.setup(target.ctx, target, false)
  f.replace({ bindingId: 'pair-b' })
  assert.throws(queued.check, /im_channel_authorization_changed/)
  assert.throws(setup.commit, /im_channel_authorization_changed/)
  assert.equal(f.owners.size, 0)
  const fresh = f.commit()
  assert.equal(f.policy.allowed(fresh), true)
  f.revoke()
  assert.equal(f.policy.allowed(fresh), false)
  assert.throws(() => f.capture(), /im_channel_authorization_unavailable/)
})

test('restart resumes only the same channel pairing, principal, profile, session and canonical workspace', async (t) => {
  const f = await fixture(t),
    first = f.commit()
  // New process/connection lease, same durable pairing. No new user binding.
  f.replace({})
  const restart = new WorkspaceToolPolicy(f.options),
    admission = restart.capture(f.message, 'chat', f.cwd)
  assert.equal(admission.canResume(first.id), true)
  const restored = f.agent(first.id)
  admission.setup(restored.ctx, restored, true).commit()
  assert.equal(restart.allowed(restored), true)
  assert.equal(f.policy.allowed(first), false, 'old process/connection grant is never revived')
  assert.equal(admission.canResume('legacy-unowned-session'), false)
  const legacy = f.agent('legacy-unowned-session')
  assert.throws(() => admission.setup(legacy.ctx, legacy, true), /im_session_owner_mismatch/)
  for (const patch of [
    { bindingId: 'different-pair' },
    { identity: { corpId: 'corp-b', userId: 'owner-a' } },
    { profile: '/fixture/profile-b' },
  ]) {
    const options = { ...f.options, authority: () => ({ ...f.authority(), ...patch }) }
    const different = new WorkspaceToolPolicy(options)
    const identity = options.authority().identity
    const next = different.capture({ senderCorpId: identity.corpId, senderStaffId: identity.userId }, 'chat', f.cwd)
    assert.equal(next.canResume(first.id), false)
  }
  f.select(f.other)
  assert.equal(restart.capture(f.message, 'chat', f.other).canResume(first.id), false)
})

test('/cd invalidates running and queued work even when the owner changes back to the original directory', async (t) => {
  const f = await fixture(t),
    queued = f.capture(),
    target = f.commit()
  f.policy.invalidate('chat')
  f.select(f.other)
  f.policy.invalidate('chat')
  f.select(f.cwd)
  assert.throws(queued.check, /im_channel_authorization_changed/)
  assert.equal(f.policy.allowed(target), false)
  const fresh = f.commit(f.agent('session-new'))
  assert.equal(f.policy.allowed(fresh), true)
})

test('missing/mismatched host workspace and symlink retargeting cannot inherit tools', async (t) => {
  const f = await fixture(t),
    admission = f.capture()
  const wrong = f.agent('wrong', f.other)
  assert.throws(() => admission.setup(wrong.ctx, wrong, false), /im_workspace_context_unavailable/)
  const missing = f.agent('missing')
  delete missing.session
  assert.throws(() => admission.setup(missing.ctx, missing, false), /im_workspace_context_unavailable/)
  const target = f.commit()
  target.session.header.cwd = f.other
  assert.equal(f.policy.allowed(target), false)
  const alias = join(f.cwd, 'alias')
  await symlink(f.cwd, alias, 'dir')
  f.select(alias)
  const queued = f.policy.capture(f.message, 'chat', alias)
  await rm(alias)
  await symlink(f.other, alias, 'dir')
  assert.throws(queued.check, /im_workspace_changed/)
})

test('dispatch rechecks after scheduling and aborts in-flight work on channel revocation', async (t) => {
  const f = await fixture(t),
    target = f.commit()
  const dispatch = target.listeners.get('tools/execute')
  const caller = new AbortController(),
    exec = { agent: target, signal: caller.signal }
  let entered = false
  const result = dispatch(exec, async () => {
    entered = true
    await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
    return 'cancelled'
  })
  assert.equal(entered, true)
  f.revoke()
  assert.equal(await result, 'cancelled')
  assert.equal(exec.signal, caller.signal, 'middleware restores the original signal')
  await assert.rejects(
    dispatch(exec, async () => assert.fail('revoked body ran')),
    /im_channel_authorization_changed/,
  )
})
