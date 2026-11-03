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
  let executed = 0
  const imCalls = []
  const definition = (name) => ({
    name,
    description: 'Synthetic boundary probe',
    parameters: { type: 'object' },
    output: { schema: {}, render: () => [] },
    execute: async () => {
      executed++
      return { ok: true }
    },
  })
  const fiber = await root.plugin({
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register(definition('dingtalk_call'))
      const agent = { id: 'synthetic-im' }
      const scope = createScope(ctx, agent)
      agent.ctx = scope.ctx
      agent.ctx.tools.register(definition('bash'))
      const im = new ImTools(() => ({
        createTool: (identity) => ({
          ...definition('dingtalk_call'),
          execute: async () => {
            imCalls.push(identity())
            return { ok: true }
          },
        }),
      }))
      im.bind(agent.ctx, { senderCorpId: 'synthetic-corp', senderStaffId: 'synthetic-owner' })
      ctx.provide('probeAgent', agent)
    },
  })
  const agent = fiber.ctx.get('probeAgent')
  for (const name of ['bash']) {
    const result = await root
      .get('tools')
      .execute({ name, callId: name, arguments: {}, agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /im_tool_unavailable/)
  }
  assert.equal(executed, 0)
  const imResult = await root
    .get('tools')
    .execute({ name: 'dingtalk_call', callId: 'im', arguments: {}, agent, signal: new AbortController().signal })
  assert.equal(imResult.isError, false)
  assert.deepEqual(imCalls, [{ corpId: 'synthetic-corp', userId: 'synthetic-owner' }])
  assert.equal(executed, 0, 'IM must use its scoped tool, never the inherited Web implementation')
  const web = await root
    .get('tools')
    .execute({ name: 'dingtalk_call', callId: 'web', arguments: {}, signal: new AbortController().signal })
  assert.equal(web.isError, false)
  assert.equal(executed, 1)
  console.log('PASS: real DSH runtime uses identity-scoped IM tool, blocks other execution, and preserves Web')
} finally {
  await root.fiber.dispose()
}
