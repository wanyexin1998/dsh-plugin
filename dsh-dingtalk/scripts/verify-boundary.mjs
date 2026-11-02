import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { installPhaseOneBoundary } from '../lib/phase-one-boundary.js'
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
      installPhaseOneBoundary(agent.ctx)
      ctx.provide('probeAgent', agent)
    },
  })
  const agent = fiber.ctx.get('probeAgent')
  for (const name of ['dingtalk_call', 'bash']) {
    const result = await root
      .get('tools')
      .execute({ name, callId: name, arguments: {}, agent, signal: new AbortController().signal })
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /phase1_web_only/)
  }
  assert.equal(executed, 0)
  const web = await root
    .get('tools')
    .execute({ name: 'dingtalk_call', callId: 'web', arguments: {}, signal: new AbortController().signal })
  assert.equal(web.isError, false)
  assert.equal(executed, 1)
  console.log('PASS: real DSH runtime blocks inherited/scoped IM tools; Web remains available')
} finally {
  await root.fiber.dispose()
}
