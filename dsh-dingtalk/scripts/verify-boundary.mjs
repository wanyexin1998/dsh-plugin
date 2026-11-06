import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ImTools } from '../lib/im-tools.js'
import { WorkspaceToolPolicy } from '../lib/workspace-tool-policy.js'
const req = createRequire(resolve(process.env.DSH_TEST_RUNTIME, 'package.json'))
const load = async (name) => import(pathToFileURL(req.resolve(name)).href)
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { ToolRuntime, TOOL_RUNTIME_SCHEDULER } = await load('@deepseek-ai/dsh-tools')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const root = new Context()
try {
  await root.plugin(SystemPrompt, {})
  await root.plugin(ToolRuntime, { mode: 'native' })
  const executed = []
  const imCalls = []
  const definition = (name) => ({
    name,
    description: 'Synthetic boundary probe',
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: async () => {
      executed.push(name)
      return { ok: true }
    },
  })
  const fiber = await root.plugin({
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register(definition('dingtalk_call'))
      for (const name of ['skill', 'ask_user_question', 'subagent', 'send_file', 'send_image'])
        ctx.tools.register(definition(name))
      ctx.tools.guard((execution) => (execution.name === 'skill' ? 'fixture_host_policy_denied' : undefined))
      const agent = { id: 'synthetic-im' }
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      agent.ctx.tools.register(definition('bash'))
      agent.ctx.tools.register(definition('unknown'))
      const im = new ImTools(() => ({
        createTool: (identity) => ({
          ...definition('dingtalk_call'),
          execute: async () => {
            imCalls.push(identity())
            return { ok: true }
          },
        }),
      }))
      im.install(agent.ctx, agent)
      im.bind(agent.ctx, { senderCorpId: 'synthetic-corp', senderStaffId: 'synthetic-owner' }, agent)
      // Exercise a scope that really inherits this Agent's registrations. Native
      // DSH subagents instead join the parent's preset generation, so this does
      // not claim they inherit the channel boundary or enable their creation.
      const child = { id: 'synthetic-linked-child' }
      child.ctx = createScope(ctx, child, { parent: agent }).ctx
      ctx.provide('probeAgent', agent)
      ctx.provide('probeChild', child)
    },
  })
  const agent = fiber.ctx.get('probeAgent')
  const child = fiber.ctx.get('probeChild')
  const tools = root.get('tools')
  let callId = 0
  const execute = (name, target = agent) =>
    tools.execute({
      name,
      callId: `probe-${++callId}`,
      arguments: {},
      ...(target ? { agent: target } : {}),
      signal: new AbortController().signal,
    })
  for (const name of ['bash', 'unknown']) {
    const result = await execute(name)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_workspace_policy_unavailable/)
  }
  const subagent = await execute('subagent')
  assert.equal(subagent.isError, true)
  assert.match(JSON.stringify(subagent), /im_subagent_inheritance_unavailable/)
  const unregistered = await execute('fixture_unregistered')
  assert.equal(unregistered.isError, true)
  assert.match(JSON.stringify(unregistered), /im_workspace_policy_unavailable/)
  for (const name of ['send_file', 'send_image']) {
    const result = await execute(name)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_file_transfer_unavailable/)
    assert.doesNotMatch(JSON.stringify(result), /im_workspace_policy_unavailable/)
  }
  const deniedSkill = await execute('skill')
  assert.equal(deniedSkill.isError, true)
  assert.match(JSON.stringify(deniedSkill), /fixture_host_policy_denied/)
  assert.deepEqual(executed, [], 'denied and unregistered tools must never execute')
  const imResult = await execute('dingtalk_call')
  assert.equal(imResult.isError, false)
  assert.deepEqual(imCalls, [{ corpId: 'synthetic-corp', userId: 'synthetic-owner' }])
  assert.deepEqual(executed, [], 'IM must use its scoped tool, never the inherited Web implementation')
  assert.equal((await execute('ask_user_question')).isError, false)
  assert.deepEqual(executed, ['ask_user_question'])
  const shadow = tools.get('dingtalk_call', agent)
  assert.equal(tools.get('dingtalk_call', child), shadow, 'the linked child really inherits the same shadow')
  const childResult = await execute('dingtalk_call', child)
  assert.equal(childResult.isError, true)
  assert.match(JSON.stringify(childResult), /im_agent_mismatch/)
  for (const other of [child, { ...agent }, undefined]) {
    await assert.rejects(
      shadow.execute({}, { agent: other, signal: new AbortController().signal }),
      /im_agent_mismatch/,
    )
  }
  assert.equal(imCalls.length, 1, 'a child or replacement Agent must not use the pinned principal')
  assert.deepEqual(executed, ['ask_user_question'])
  const web = await execute('dingtalk_call', null)
  assert.equal(web.isError, false)
  assert.deepEqual(executed, ['ask_user_question', 'dingtalk_call'])
  assert.equal((await execute('send_file', null)).isError, false)
  assert.deepEqual(executed, ['ask_user_question', 'dingtalk_call', 'send_file'])
  const webUnknown = await execute('fixture_unregistered', null)
  assert.equal(webUnknown.isError, true)
  assert.match(JSON.stringify(webUnknown), /unknown tool/)
  assert.equal(imCalls.length, 1)
  console.log(
    'PASS: real DSH ToolRuntime preserves the exact IM shadow and host denial; missing workspace policy, the subagent tool, unknown tools, and independent file/image sending fail closed; linked child/direct calls cannot borrow identity; Web remains unaffected. All tools are offline fixtures.',
  )
} finally {
  await root.fiber.dispose()
}

// This probe uses the real runtime's guard, approval gate, and staged scheduler.
// The channel authority, directory service, and approval answerer are fixtures;
// the separate runtime tests cover their transport and native interaction paths.
const workspaceRoot = new Context()
const temporary = mkdtempSync(join(tmpdir(), 'dsh-personal-policy-probe-'))
const cwd = realpathSync(temporary)
try {
  await workspaceRoot.plugin(SystemPrompt, {})
  await workspaceRoot.plugin(ToolRuntime, { mode: 'native' })
  const bodies = []
  const approvals = []
  let answer = async () => 'allowed-once'
  let currentAuthority
  let dwsIdentityReads = 0
  let pendingBody
  const bindings = new Map()
  const owners = new Map()
  const policy = new WorkspaceToolPolicy({
    authority: () => currentAuthority,
    selectedWorkspace: () => cwd,
    bindings,
    owners,
  })
  const definition = (name) => ({
    name,
    description: 'Offline personal workspace boundary fixture',
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: async (_args, exec) => {
      bodies.push(name)
      if (name === 'edit' && pendingBody) {
        pendingBody.entered.resolve(exec.signal)
        await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
      }
      return { ok: true }
    },
  })
  const message = { senderCorpId: 'synthetic-corp', senderStaffId: 'synthetic-owner' }
  const fixture = await workspaceRoot.plugin({
    inject: ['tools'],
    apply(ctx) {
      ctx.provide('workingDirectory', { get: (session) => session.header.cwd })
      ctx.provide('approval', {
        request: async (request) => {
          approvals.push(request)
          return answer(request)
        },
      })
      for (const name of [
        'read',
        'write',
        'edit',
        'bash',
        'glob',
        'grep',
        'read_image',
        'subagent',
        'spawn_agent',
        'spawn_teammate',
        'workflow',
        'ralph',
        'send_file',
        'send_image',
        'fixture_unreviewed',
        'dingtalk_call',
      ])
        ctx.tools.register(definition(name))
      ctx.tools.guard((exec) => (exec.name === 'grep' ? 'fixture_global_denial' : undefined))
      ctx.on('tools/pre-execute', (exec, next) =>
        exec.name === 'write' ? Promise.resolve({ kind: 'ask', reason: 'fixture approval required' }) : next(),
      )
      const im = new ImTools(
        () => ({
          identity: () => {
            dwsIdentityReads++
            return undefined
          },
          createTool: () => ({
            ...definition('dingtalk_call'),
            execute: async () => ({ status: 'auth_required', reasonCode: 'not_connected' }),
          }),
        }),
        policy,
      )
      const createOwner = (id) => {
        const lease = new AbortController()
        currentAuthority = Object.freeze({
          identity: Object.freeze({ corpId: message.senderCorpId, userId: message.senderStaffId }),
          bindingId: 'synthetic-device',
          profile: cwd,
          signal: lease.signal,
        })
        const agent = { id, session: { id, header: { cwd } } }
        agent.ctx = createScope(ctx, agent).ctx
        agent.ctx.tools.restrict({ deny: ['read_image'] })
        agent.ctx.tools.guard((exec) => (exec.name === 'glob' ? 'fixture_scoped_denial' : undefined))
        im.bind(agent.ctx, message, agent)
        const admission = policy.capture(message, id, cwd)
        const commit = admission.setup(agent.ctx, agent, false)
        bindings.set(id, id)
        return { agent, lease, commit }
      }
      ctx.provide('workspaceProbe', { createOwner })
    },
  })
  const { createOwner } = fixture.ctx.get('workspaceProbe')
  const tools = workspaceRoot.get('tools')
  let sequence = 0
  const input = (name, agent, signal = new AbortController().signal) => ({
    name,
    agent,
    callId: `workspace-${++sequence}`,
    arguments: {},
    signal,
  })
  const execute = (name, agent, signal) => tools.execute(input(name, agent, signal))
  const primary = createOwner('personal-owner')
  assert.equal(policy.allowed(primary.agent), false)
  const unpublished = await execute('read', primary.agent)
  assert.equal(unpublished.isError, true)
  assert.match(JSON.stringify(unpublished), /im_channel_authorization_changed/)
  primary.commit.commit()
  assert.equal(policy.allowed(primary.agent), true)
  assert.equal((await execute('read', primary.agent)).isError, false)
  assert.deepEqual(bodies, ['read'], 'a reviewed non-DWS tool runs only after the ownership commit')
  assert.equal(dwsIdentityReads, 0, 'ordinary workspace tools must not consult data OAuth identity')
  for (const [name, reason] of [
    ['grep', /fixture_global_denial/],
    ['glob', /fixture_scoped_denial/],
  ]) {
    const result = await execute(name, primary.agent)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), reason)
  }
  const restricted = await execute('read_image', primary.agent)
  assert.equal(restricted.isError, true)
  assert.match(JSON.stringify(restricted), /unknown tool/)
  for (const name of ['send_file', 'send_image']) {
    const result = await execute(name, primary.agent)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_file_transfer_unavailable/)
  }
  for (const name of ['subagent', 'spawn_agent']) {
    const result = await execute(name, primary.agent)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_subagent_inheritance_unavailable/)
  }
  for (const name of ['spawn_teammate', 'workflow', 'ralph', 'fixture_unreviewed']) {
    const result = await execute(name, primary.agent)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_tool_inheritance_unreviewed/)
  }
  assert.deepEqual(
    bodies,
    ['read'],
    'other host guards, visibility restrictions and unsupported capabilities remain effective',
  )
  assert.equal((await execute('write', primary.agent)).isError, false)
  answer = async () => 'rejected'
  const rejected = await execute('write', primary.agent)
  assert.equal(rejected.isError, true)
  assert.match(JSON.stringify(rejected), /user rejected/)
  assert.equal(approvals.length, 2, 'allowed-once must ask again for the next call')
  answer = () => new Promise((resolve) => setTimeout(() => resolve('unavailable'), 5))
  const timedOut = await execute('write', primary.agent)
  assert.equal(timedOut.isError, true)
  assert.match(JSON.stringify(timedOut), /no approval channel/)
  assert.deepEqual(bodies, ['read', 'write'])
  const waiting = Promise.withResolvers()
  const decision = Promise.withResolvers()
  answer = async () => {
    waiting.resolve()
    return decision.promise
  }
  const approvalPending = execute('write', primary.agent)
  await waiting.promise
  primary.lease.abort()
  decision.resolve('allowed-once')
  const revokedApproval = await approvalPending
  assert.equal(revokedApproval.isError, true)
  assert.match(JSON.stringify(revokedApproval), /im_channel_authorization_changed/)
  assert.deepEqual(bodies, ['read', 'write'], 'an approval cannot revive a revoked channel grant')

  const queued = createOwner('personal-queued')
  queued.commit.commit()
  // The same staged interface is used by DSH's scheduler. Always prepare through
  // the real host gate first; direct dispatch alone would bypass the guard test.
  const scheduler = tools[TOOL_RUNTIME_SCHEDULER]
  const prepared = await scheduler.prepare(input('bash', queued.agent))
  assert.equal(prepared.kind, 'dispatch')
  queued.lease.abort()
  const dispatched = await scheduler.dispatch(prepared.exec)
  const delayed =
    dispatched.kind === 'post-result'
      ? await scheduler.finalize(prepared.exec, dispatched.result)
      : scheduler.finish(prepared.exec, dispatched.result)
  assert.equal(delayed.isError, true)
  assert.match(JSON.stringify(delayed), /im_channel_authorization_changed/)
  assert.deepEqual(bodies, ['read', 'write'], 'revocation after scheduling prevents the tool body')

  const running = createOwner('personal-running')
  running.commit.commit()
  pendingBody = { entered: Promise.withResolvers() }
  const caller = new AbortController()
  const active = execute('edit', running.agent, caller.signal)
  const bodySignal = await pendingBody.entered.promise
  assert.equal(bodySignal.aborted, false)
  running.lease.abort()
  const cancelled = await active
  assert.equal(bodySignal.aborted, true)
  assert.equal(caller.signal.aborted, false)
  assert.equal(cancelled.isError, true)
  assert.match(JSON.stringify(cancelled), /ABORTED/)
  assert.deepEqual(bodies, ['read', 'write', 'edit'])
  assert.equal(dwsIdentityReads, 0)
  console.log(
    'PASS: real DSH ToolRuntime permits a committed personal owner to use reviewed workspace tools without DWS OAuth; host guards/restrict, independent files/delegation denial, approval outcomes, scheduler-delay revocation, and running-call cancellation remain enforced. Transport/approval answerers are offline fixtures.',
  )
} finally {
  await workspaceRoot.fiber.dispose()
  rmSync(temporary, { recursive: true, force: true })
}
