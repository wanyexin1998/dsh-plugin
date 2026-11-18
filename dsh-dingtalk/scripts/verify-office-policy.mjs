import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImTools } from '../lib/im-tools.js'
import { WorkspaceToolPolicy } from '../lib/workspace-tool-policy.js'

const tree = process.env.DSH_TEST_TREE
const source = process.env.DSH_PRIMARY_RUNTIME
assert.ok(tree && source, 'Set DSH_TEST_TREE and DSH_PRIMARY_RUNTIME to the built host and bundled runtime')
const load = (relative) => import(pathToFileURL(join(tree, relative, 'lib/index.js')).href)
const { Context } = await load('vendor/cordis')
const { createScope } = await load('packages/core/scope')
const systemPrompt = await load('packages/core/system-prompt')
const toolsPlugin = await load('packages/core/tools')
const skills = await load('packages/skill/skill')
const office = await load('packages/skill/skill-office')
const dependencies = await load('packages/skill/tool-workspace-dependencies')
const root = new Context()
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-office-policy-')))
const cwd = join(temp, 'employee')
mkdirSync(cwd)
const identity = { corpId: 'fixture-corp', userId: 'fixture-owner' }
const authority = { identity, bindingId: 'fixture-pair', profile: 'fixture', signal: new AbortController().signal }
const bindings = new Map([['chat', 'im']])
const message = { senderCorpId: identity.corpId, senderStaffId: identity.userId }
const policy = new WorkspaceToolPolicy({
  root: cwd,
  authority: () => authority,
  selectedWorkspace: () => cwd,
  bindings,
  owners: new Map(),
})
try {
  await root.plugin(systemPrompt.default ?? systemPrompt)
  await root.plugin(toolsPlugin.default ?? toolsPlugin)
  await root.plugin(skills.default ?? skills)
  await root.plugin(office.default ?? office, {
    assetRoot: join(dirname(source), 'office-skills'),
    node: join(source, 'dependencies/node/bin/node'),
    cli: join(dirname(source), 'kit/cli.js'),
  })
  await root.plugin(dependencies.default ?? dependencies, { source })
  root.provide('workingDirectory', { get: (session) => session.header.cwd })
  let agents
  await root.plugin({
    inject: ['tools', 'workingDirectory'],
    apply(ctx) {
      const definition = {
        name: 'dingtalk_call',
        description: 'Offline test stub',
        parameters: {},
        output: { schema: {}, render: () => [] },
        execute: async () => ({}),
      }
      ctx.tools.register({ ...definition, name: 'present' })
      const make = (id) => {
        const agent = { id, session: { id, header: { cwd } } }
        agent.ctx = createScope(ctx, agent).ctx
        return agent
      }
      const web = make('web')
      const im = make('im')
      const unbound = make('unbound')
      const imTools = new ImTools(
        () => ({ createTool: () => definition }),
        policy,
        () => false,
      )
      imTools.install(im.ctx, im)
      policy.capture(message, 'chat', cwd).setup(im.ctx, im, false).commit()
      imTools.bind(im.ctx, message, im)
      imTools.install(unbound.ctx, unbound)
      agents = { web, im, unbound }
    },
  })
  const { web, im, unbound } = agents
  assert.ok((await root.skills.list()).some(({ name }) => name === 'office-xlsx'))
  const tool = 'load_workspace_dependencies'
  const appears = (agent, name) => root.tools.schemas(agent).some((schema) => schema.name === name)
  assert.ok(appears(web, 'present'))
  assert.ok(!appears(im, 'present'))
  assert.ok(!appears(unbound, tool))
  const execute = (agent, name) =>
    root.tools.execute({
      name,
      agent,
      callId: agent.id + '-' + name,
      arguments: {},
      signal: new AbortController().signal,
    })
  assert.equal((await execute(im, 'present')).isError, true)
  assert.equal((await execute(unbound, tool)).isError, true)
  for (const agent of [web, im]) {
    assert.ok(appears(agent, tool))
    const result = await execute(agent, tool)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(realpathSync(result.value.python).startsWith(realpathSync(source)))
    assert.ok(result.value.pythonDistributions.openpyxl)
    execFileSync(
      result.value.python,
      [
        '-B',
        '-c',
        [
          'from openpyxl import Workbook, load_workbook',
          'from openpyxl.styles import Font',
          'import sys',
          'w = Workbook()',
          'w.active["A1"] = "Office 验收"',
          'w.active["A1"].font = Font(bold=True)',
          'w.active["B1"] = "=SUM(3,4)"',
          'w.save(sys.argv[1])',
          'v = load_workbook(sys.argv[1]).active',
          'assert (v["A1"].value, v["A1"].font.bold, v["B1"].value) == ("Office 验收", True, "=SUM(3,4)")',
        ].join('\n'),
        join(cwd, agent.id + '.xlsx'),
      ],
      { cwd },
    )
    console.log('OFFICE_POLICY_OK', agent.id, 'openpyxl=' + result.value.pythonDistributions.openpyxl)
  }
} finally {
  policy.close()
  await root.fiber.dispose()
  rmSync(temp, { recursive: true, force: true })
}
