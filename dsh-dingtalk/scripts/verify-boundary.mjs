import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ImTools } from '../lib/im-tools.js'
const req = createRequire(resolve(process.env.DSH_TEST_RUNTIME, 'package.json'))
const load = async (name) => import(pathToFileURL(req.resolve(name)).href)
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { ToolRuntime } = await load('@deepseek-ai/dsh-tools')
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
  for (const name of ['bash', 'unknown', 'subagent']) {
    const result = await execute(name)
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_workspace_policy_unavailable/)
  }
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
