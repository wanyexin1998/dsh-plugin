import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ImTools } from '../lib/im-tools.js'
import { WorkspaceToolPolicy } from '../lib/workspace-tool-policy.js'
import { EmployeeWorkspace, installEmployeeWorkspace } from '../lib/employee-workspace.js'
import { EmployeeChannelTools } from '../lib/employee-channel-tools.js'

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
const directory = await load('packages/session/tool-working-directory')
const root = new Context()
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-office-policy-')))
const cwd = join(temp, 'employee')
mkdirSync(cwd)
const outside = join(temp, 'another-employee')
const target = join(cwd, 'next')
mkdirSync(outside)
mkdirSync(target)
writeFileSync(join(cwd, 'own.txt'), 'owned')
writeFileSync(join(outside, 'shared.txt'), 'foreign')
const owned = new EmployeeWorkspace([cwd])
const identity = { corpId: 'fixture-corp', userId: 'fixture-owner' }
const authority = { identity, bindingId: 'fixture-pair', profile: 'fixture', signal: new AbortController().signal }
const bindings = new Map([['chat', 'im']])
const message = { senderCorpId: identity.corpId, senderStaffId: identity.userId, conversationType: 'direct' }
const policy = new WorkspaceToolPolicy({
  employeeWorkspace: owned,
  authority: () => authority,
  selectedWorkspace: () => cwd,
  bindings,
  owners: new Map(),
})
try {
  await root.plugin(systemPrompt.default ?? systemPrompt)
  await root.plugin(toolsPlugin.default ?? toolsPlugin)
  await root.plugin(skills.default ?? skills)
  const assetRoot = join(dirname(source), 'office-skills')
  await root.plugin(
    office.default ?? office,
    existsSync(assetRoot)
      ? {
          assetRoot,
          node: join(source, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
          cli: join(dirname(source), 'kit/cli.js'),
        }
      : {},
  )
  await root.plugin(dependencies.default ?? dependencies, { source })
  root.provide('workingDirectory', {
    get: (session) => session.header.cwd,
    ensure: (agent) => agent.session.header.cwd,
  })
  await root.plugin(directory.default ?? directory)
  let agents
  let allowRecipient = true
  const channel = new EmployeeChannelTools(owned, 'https://cellgent.test', () => allowRecipient)
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
      installEmployeeWorkspace(ctx, owned)
      ctx.tools.register({
        ...definition,
        name: 'present',
        parameters: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } } } } },
      })
      ctx.tools.register({
        ...definition,
        name: 'visualize',
        execute: async (_args, exec) => ({
          type: 'cellgent.visualize/1',
          callId: exec.callId,
          sessionId: exec.agent.id,
          revision: JSON.stringify([exec.agent.id, exec.callId]),
        }),
      })
      const make = (id, selected = cwd) => {
        const agent = { id, session: { id, header: { cwd: selected } } }
        agent.ctx = createScope(ctx, agent).ctx
        return agent
      }
      const web = make('web')
      const im = make('im')
      const unbound = make('unbound')
      const foreign = make('foreign', outside)
      const imTools = new ImTools(
        () => ({ createTool: () => definition }),
        policy,
        () => allowRecipient,
        channel,
      )
      imTools.install(im.ctx, im)
      policy.capture(message, 'chat', cwd).setup(im.ctx, im, false).commit()
      imTools.bind(im.ctx, message, im, () => channel.bind(im, message))
      imTools.install(unbound.ctx, unbound)
      agents = { web, im, unbound, foreign, imTools }
    },
  })
  const { web, im, unbound, foreign, imTools } = agents
  assert.ok((await root.skills.list()).some(({ name }) => name === 'office-xlsx'))
  const tool = 'load_workspace_dependencies'
  const appears = (agent, name) => root.tools.schemas(agent).some((schema) => schema.name === name)
  assert.ok(appears(web, 'present'))
  assert.ok(appears(im, 'present'))
  assert.ok(!appears(unbound, tool))
  const execute = (agent, name, args = {}) =>
    root.tools.execute({
      name,
      agent,
      callId: agent.id + '-' + name,
      arguments: args,
      signal: new AbortController().signal,
    })
  for (const agent of [web, im]) {
    const own = await execute(agent, 'present', { files: [{ path: 'own.txt' }] })
    assert.equal(own.isError, false, JSON.stringify(own))
    assert.match(
      (await execute(agent, 'present', { files: [{ path: join(outside, 'shared.txt') }] })).error.message,
      /employee_workspace_access_denied/,
    )
    assert.equal((await execute(agent, 'working_directory')).value.cwd, cwd)
  }
  assert.match((await execute(foreign, tool)).error.message, /employee_workspace_access_denied/)
  assert.equal((await execute(unbound, tool)).isError, true)
  assert.equal((await execute(im, 'working_directory', { cd: 'next' })).value.pending, target)

  assert.equal((await execute(im, 'visualize')).isError, false)
  const original = channel.settle(im, message, true)
  assert.equal(original.directory, target)
  const [link] = original.charts
  const [, encoded] = new URL(link).hash.split('=')
  assert.deepEqual(JSON.parse(decodeURIComponent(encoded)), ['im', JSON.stringify(['im', 'im-visualize'])])
  allowRecipient = false
  imTools.bind(im.ctx, message, im, () => channel.bind(im, message))
  assert.ok(!appears(im, 'visualize'))
  assert.ok(!appears(im, 'present'))
  assert.match((await execute(im, 'working_directory', { cd: 'next' })).error.message, /im_private_reply_required/)
  assert.equal(channel.settle(im, message, true), undefined)
  for (const agent of [web, im]) {
    assert.ok(appears(agent, tool))
    const result = await execute(agent, tool)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.ok(realpathSync(result.value.python).startsWith(realpathSync(join(source, 'dependencies'))))
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
    const word = result.value.pythonDistributions['python-docx']
    const slides = result.value.pythonDistributions['python-pptx']
    if (word && slides) {
      execFileSync(
        result.value.python,
        [
          '-B',
          '-c',
          [
            'from docx import Document',
            'from pptx import Presentation',
            'import sys',
            'docx = Document(); docx.add_paragraph("Office 验收"); docx.save(sys.argv[1])',
            'assert Document(sys.argv[1]).paragraphs[0].text == "Office 验收"',
            'pptx = Presentation(); slide = pptx.slides.add_slide(pptx.slide_layouts[0]); slide.shapes.title.text = "Office 验收"; pptx.save(sys.argv[2])',
            'assert Presentation(sys.argv[2]).slides[0].shapes.title.text == "Office 验收"',
          ].join('\n'),
          join(cwd, agent.id + '.docx'),
          join(cwd, agent.id + '.pptx'),
        ],
        { cwd },
      )
    }
    console.log(
      'OFFICE_POLICY_OK',
      agent.id,
      'openpyxl=' + result.value.pythonDistributions.openpyxl,
      'word=' + (word ?? 'unavailable'),
      'pptx=' + (slides ?? 'unavailable'),
    )
  }
} finally {
  policy.close()
  await root.fiber.dispose()
  rmSync(temp, { recursive: true, force: true })
}
