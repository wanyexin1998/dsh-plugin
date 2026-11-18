import { toolSurface } from './helpers/tool-surface.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, link, symlink, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { imToolFactory } from './helpers/im-tool-factory.mjs'

// Only transport and rendering are replaced. Public apply composes the real
// Bridge, Commands, ImTools, QuestionManager and WorkspaceToolPolicy.
const connections = [],
  renderers = []
class RelayClient {}
class RobotConnection extends RelayClient {
  constructor(options) {
    super()
    this.directory = path.join(options.root, 'personal-runtime')
    this.profile = options.profile
    this.enterprise = options.enterprise
    this.received = new WeakSet()
    this.operations = []
    this.generation = 0
    this.pair()
    connections.push(this)
  }
  pair(identity = { corpId: 'corp-a', userId: 'owner-a' }) {
    this.controller?.abort()
    this.controller = new AbortController()
    this.current = Object.freeze({
      identity: Object.freeze({ ...identity }),
      bindingId: `pair-${++this.generation}`,
      profile: this.profile,
      signal: this.controller.signal,
    })
  }
  reconnect() {
    this.controller?.abort()
    this.controller = new AbortController()
    if (this.current) this.current = Object.freeze({ ...this.current, signal: this.controller.signal })
  }
  revoke() {
    this.controller.abort()
    this.current = undefined
  }
  authority() {
    return this.enterprise ? undefined : this.current
  }
  workspaceRoot() {
    return this.enterprise?.workspaceTools?.root
  }
  workspaceEmployee() {
    if (this.enterprise?.workspaceTools)
      return { corpId: this.enterprise.corpId, userId: this.enterprise.workspaceTools.userId }
  }
  enterpriseAuthority() {
    return this.enterprise?.workspaceTools?.userId === this.current?.identity.userId &&
      this.enterprise.corpId === this.current.identity.corpId
      ? this.current
      : undefined
  }
  enterpriseWorkspace(message) {
    return this.received.has(message) ? this.enterpriseAuthority() : undefined
  }
  status() {
    return { mode: this.enterprise ? 'enterprise' : 'personal' }
  }
  async start(source) {
    this.source = source
  }
  async stop() {}
  async close() {
    this.revoke()
  }
  async operation(target, name, value) {
    this.operations.push({ target, name, value })
    return name !== 'interaction.create'
  }
  async sendAttachment(requestId, media, signal) {
    signal.throwIfAborted()
    this.operations.push({ target: requestId, name: 'attachment.send', value: media })
    return { status: 'accepted', processQueryKey: 'test-receipt' }
  }
  requestFor() {
    return 'fixture-request'
  }
  async createCard() {
    return null
  }
  async emotion() {
    return true
  }
}
class Renderer {
  constructor() {
    this.pending = new Map()
    renderers.push(this)
  }
  onInbound(id, msg) {
    return msg.text === 'hold' ? new Promise((resolve) => this.pending.set(id, resolve)) : Promise.resolve()
  }
  release(id, completed = false) {
    this.pending.get(id)?.(completed)
    this.pending.delete(id)
  }
  releaseAll() {
    for (const id of this.pending.keys()) this.release(id)
  }
  notifyInterleaved() {}
  onSessionEvent() {}
  onAssistantStream() {}
}
mock.module('../lib/relay/client.js', { namedExports: { RelayClient } })
mock.module('../lib/relay/controller.js', { namedExports: { RobotConnection } })
mock.module('../lib/renderer.js', { namedExports: { Renderer } })
const { apply, Config } = await import('../lib/index.js')

async function waitUntil(check) {
  const deadline = performance.now() + 5_000
  while (!check()) {
    if (performance.now() >= deadline) assert.fail('personal runtime did not reach the expected state')
    await delay(5)
  }
}
async function flush() {
  for (let count = 0; count < 5; count++) await new Promise((resolve) => setImmediate(resolve))
}

async function fixture(
  t,
  {
    legacy = false,
    foreign = false,
    missing,
    revokeAtCommit = false,
    resolveModelInfo,
    enterprise = false,
    outsideWorkspace = false,
  } = {},
) {
  const container = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-channel-workspace-')))
  const root = enterprise ? path.join(container, 'employee-a') : container
  await mkdir(root, { recursive: true })
  const other = path.join(container, 'employee-b')
  await mkdir(other)
  const target = path.join(root, 'target')
  await mkdir(target)
  const state = path.join(root, 'state')
  const account = path.join(state, 'personal-runtime', 'accounts', 'shared')
  if (legacy) {
    await mkdir(account, { recursive: true })
    await writeFile(path.join(account, 'bindings.json'), JSON.stringify({ direct: 'legacy-session' }))
  }
  if (outsideWorkspace) {
    await mkdir(account, { recursive: true })
    await writeFile(path.join(account, 'workspaces.json'), JSON.stringify({ direct: other }))
  }
  const previous = process.env.DSH_DINGTALK_STATE_DIR
  process.env.DSH_DINGTALK_STATE_DIR = state
  const lifecycle = new Context()
  const followups = [],
    attempts = [],
    executed = []
  const live = new Map(),
    headers = new Map(),
    workspaces = new Map()
  const foreignAgent = {
    id: 'legacy-session',
    marker: 'foreign',
    followup() {
      assert.fail('borrowed foreign Agent')
    },
  }
  if (foreign) live.set(foreignAgent.id, foreignAgent)
  let resumeCalls = 0
  let connection, renderer
  t.after(async () => {
    renderer?.releaseAll()
    await flush()
    await lifecycle.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = previous
    await rm(container, { recursive: true, force: true })
  })
  const registerWorkspace = (dir) => {
    const workspace = {
      path: dir,
      sessionIds: [],
      async attachSession(id) {
        assert.equal(await realpath(headers.get(id).cwd), dir)
        if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
      },
    }
    workspaces.set(dir, workspace)
    return workspace
  }
  registerWorkspace(root)
  registerWorkspace(target)
  if (enterprise) registerWorkspace(other)
  const prepare = async (options) => {
    const tools = new Map(),
      guards = [],
      listeners = new Map()
    const inherited = toolSurface([
      'load_workspace_dependencies',
      'skill',
      'bash',
      'read',
      'write',
      'edit',
      'present',
      'visualize',
      'working_directory',
      'todo_write',
      'get_goal',
      'exit_plan_mode',
      'subagent',
    ])
    const agentCtx = {
      tools: {
        ...inherited,
        schemas: () =>
          [
            ...inherited.schemas(),
            ...[...tools.values()].filter(({ name }) =>
              ['dingtalk_call', 'ask_user_question', 'send_file', 'send_image'].includes(name),
            ),
          ].map(({ name }) => ({ name })),
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
        guard(fn) {
          guards.push(fn)
          return () => guards.splice(guards.indexOf(fn), 1)
        },
      },
      on(name, listener, placement) {
        const list = listeners.get(name) ?? []
        placement?.prepend ? list.unshift(listener) : list.push(listener)
        listeners.set(name, list)
        return () => list.splice(list.indexOf(listener), 1)
      },
      get(name) {
        if (name === 'approval')
          return {
            request: (request) => {
              assert.notEqual(request.toolName, 'send_file', 'native attachment must not request approval')
              return listeners.get('approval/request')[0](request)
            },
          }
        if (name === 'commands')
          return {
            async execute(agent, line, attachments, signal) {
              assert.equal(line, '/plan')
              assert.deepEqual(attachments, [])
              signal.throwIfAborted()
              agent.planMode = true
              return { result: { kind: 'success' } }
            },
          }
        if (name === 'workingDirectory' && missing !== 'workingDirectory')
          return { get: (session) => session.header.cwd }
      },
    }
    // Host policy remains installed independently of the IM guard.
    agentCtx.tools.guard((exec) => (!enterprise && exec.name === 'bash' ? 'host_tool_disabled' : undefined))
    const agent = {
      id: options.sessionId,
      ctx: agentCtx,
      status: 'idle',
      ...(missing === 'session' ? {} : { session: { id: options.sessionId, header: { ...options.meta } } }),
      followup(message) {
        followups.push({ agent, message })
      },
      cancel() {
        renderer.release(this.id)
      },
      steer() {
        assert.fail('unexpected steering')
      },
      guard(name, args) {
        return guards.map((fn) => fn({ name, agent, arguments: args })).find(Boolean)
      },
      requestApproval(signal) {
        return listeners.get('approval/request')[0]({ agent, toolName: 'bash', signal })
      },
      async invoke(name, args = {}) {
        const definition = tools.get(name)
        if (!definition) throw new Error('tool_not_registered')
        const reason = this.guard(name, args)
        if (reason) throw new Error(reason)
        const exec = { name, agent, arguments: args, callId: crypto.randomUUID(), signal: new AbortController().signal }
        const dispatch = (listeners.get('tools/execute') ?? []).reduceRight(
          (next, listener) => () => listener(exec, next),
          () => definition.execute(args, exec),
        )
        const value = await dispatch()
        const project = (listeners.get('tools/post-execute') ?? []).reduceRight(
          (next, listener) => () => listener(exec, { isError: false, value, content: [] }, next),
          () => Promise.resolve({ kind: 'accept' }),
        )
        await project()
        for (const listener of listeners.get('tools/result') ?? []) listener(exec, { isError: false, value })
        return value
      },
    }
    const attempt = { agent }
    attempts.push(attempt)
    try {
      const setup = await options.setup?.(agentCtx, agent)
      attempt.beforeCommit = agent.guard('read')
      assert.equal(typeof setup?.commit, 'function', 'personal sessions need a setup commit')
      if (revokeAtCommit) connection.revoke()
      setup.commit()
    } catch (error) {
      attempt.error = error.message
      throw error
    }
    headers.set(agent.id, options.meta)
    live.set(agent.id, agent)
    return {
      agent,
      async dispose() {
        renderer.release(agent.id)
        live.delete(agent.id)
      },
    }
  }
  const noDwsIdentity = {
    ...imToolFactory,
    identity: () => (enterprise ? { corpId: 'corp-a', userId: 'owner-a' } : undefined),
  }
  await apply(
    {
      effect: (...args) => lifecycle.effect(...args),
      provide() {},
      credentials: { async resolve() {} },
      ...(resolveModelInfo ? { llm: { resolveModelInfo } } : {}),
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      agents: {
        get: (id) => live.get(id),
        create: prepare,
        async resume(options) {
          resumeCalls++
          const header = headers.get(options.resumeSessionId)
          if (!header) throw new Error('unexpected_legacy_resume')
          return prepare({ sessionId: options.resumeSessionId, meta: header, setup: options.setup })
        },
      },
      on() {
        return () => {}
      },
      get(name) {
        if (name === 'dingtalkImTools') return noDwsIdentity
        if (name === 'profileContext') return { dir: path.join(root, 'profiles', 'web') }
        if (name === 'sessionPersistence') return { list: async () => [] }
        if (name === 'workspaceRegistry')
          return {
            resolveByPath: async (dir) => workspaces.get(await realpath(dir)),
            create: async (dir) => registerWorkspace(await realpath(dir)),
            list: async () => [...workspaces.values()],
          }
        if (name === 'agentPresets')
          return {
            resolve: async () => ({ id: 'fixture-preset' }),
            async mount(ctx) {
              for (const name of ['read', 'write', 'bash', 'todo_write', 'get_goal', 'exit_plan_mode', 'present'])
                ctx.tools.register({
                  name,
                  async execute(args, exec) {
                    executed.push(name)
                    if (name === 'write') {
                      const destination = path.join(exec.agent.session.header.cwd, args.name)
                      await writeFile(destination, args.data)
                      return destination
                    }
                    return exec.agent.session.header.cwd
                  },
                })
            },
          }
      },
    },
    Config({
      accounts: [],
      digitalEmployees: [],
      workspace: root,
      ...(enterprise
        ? {
            robotConnection: {
              mode: 'enterprise',
              corpId: 'corp-a',
              clientId: 'app',
              displayName: 'Fixture',
              gatewayUrl: 'wss://example.org/relay',
              workspaceTools: { userId: 'owner-a', root },
            },
          }
        : {}),
      tools: { enabled: false },
      replyMode: { direct: 'text', group: 'text' },
      streaming: { enabled: false },
      emotionFirstResponse: false,
      rejectNotice: false,
    }),
  )
  connection = connections.at(-1)
  renderer = renderers.at(-1)
  assert.ok(connection instanceof RobotConnection)
  if (!enterprise) assert.equal(noDwsIdentity.identity(), undefined)
  let sequence = 0
  const send = (text, overrides = {}) => {
    const message = {
      msgId: `message-${++sequence}`,
      createAt: String(sequence),
      text,
      conversationId: 'direct',
      conversationType: 'direct',
      senderCorpId: 'corp-a',
      senderStaffId: 'owner-a',
      senderNick: 'Fixture',
      sessionWebhook: 'fixture-request',
      ...overrides,
    }
    connection.received.add(message)
    return connection.source.onMessage(message)
  }
  const failures = () =>
    connection.operations.filter((op) => op.name === 'markdown' && /未能开始处理/.test(op.value.text)).length
  return {
    root,
    other,
    target,
    account,
    connection,
    renderer,
    send,
    failures,
    attempts,
    followups,
    executed,
    live,
    foreignAgent,
    get resumeCalls() {
      return resumeCalls
    },
  }
}

test('enterprise public apply creates a workbook only in its employee workspace and rejects foreign routes and cwd', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('create workbook')
  await waitUntil(() => h.followups.length === 1)
  const agent = h.followups[0].agent
  assert.equal(agent.guard('write'), undefined)
  assert.equal(agent.guard('bash'), undefined)
  const workbook = await readFile(new URL('./fixtures/workspace.xlsx', import.meta.url))
  const output = await agent.invoke('write', { name: 'report.xlsx', data: workbook })
  assert.equal(output, path.join(h.root, 'report.xlsx'))
  assert.deepEqual(await readFile(output), workbook)
  await h.send('foreign user', { senderStaffId: 'owner-b' })
  assert.equal(h.followups.length, 1)
  await h.send('/ws')
  assert.doesNotMatch(h.connection.operations.at(-1).value.text, /employee-b/)
  await h.send(`/cd ${h.other}`)
  assert.match(h.connection.operations.at(-1).value.text, /不在当前用户允许/)
  assert.equal(await agent.invoke('read'), h.root)
  agent.session.header.cwd = h.other
  await assert.rejects(
    agent.invoke('write', { name: 'forbidden.xlsx', data: workbook }),
    /im_channel_authorization_changed/,
  )
  await assert.rejects(readFile(path.join(h.other, 'forbidden.xlsx')), { code: 'ENOENT' })
  agent.session.header.cwd = h.root
  await h.send('/cd 2')
  await assert.rejects(agent.invoke('read'), /im_channel_authorization_changed/)
  await h.send('new workspace')
  await waitUntil(() => h.followups.length === 2)
  const next = h.followups[1].agent
  assert.equal(await next.invoke('read'), h.target)
  h.connection.revoke()
  await assert.rejects(next.invoke('read'), /im_channel_authorization_changed/)
})

test('enterprise attachment sends without approval only from the employee workspace to its original DM', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('send workbook', { sessionWebhook: 'original-request' })
  await waitUntil(() => h.followups.length === 1)
  const agent = h.followups[0].agent
  const directTools = agent.ctx.tools.schemas().map(({ name }) => name)
  assert.ok(directTools.includes('load_workspace_dependencies'))
  assert.ok(directTools.includes('send_file'))
  assert.ok(!directTools.includes('send_image'))
  for (const name of ['present', 'working_directory', 'todo_write', 'get_goal', 'exit_plan_mode'])
    assert.ok(directTools.includes(name), name)
  for (const name of ['visualize', 'subagent', 'run_code']) assert.ok(!directTools.includes(name), name)
  const workbook = await readFile(new URL('./fixtures/workspace.xlsx', import.meta.url))
  const file = path.join(h.root, '验收.xlsx')
  const foreign = path.join(h.other, 'foreign.xlsx')
  await writeFile(file, workbook)
  await writeFile(foreign, 'private')
  await link(foreign, path.join(h.root, 'hard-link.xlsx'))
  await symlink(h.other, path.join(h.root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  const attempts = () => h.connection.operations.filter((op) => op.name === 'attachment.send')
  for (const unsafe of [foreign, '../employee-b/foreign.xlsx', 'hard-link.xlsx', 'outside/foreign.xlsx']) {
    await assert.rejects(agent.invoke('send_file', { path: unsafe }), /file_outside_workspace/)
  }
  await assert.rejects(agent.invoke('send_file', { path: file, userId: 'owner-b' }), /file_invalid_arguments/)
  assert.equal(attempts().length, 0)
  await h.send('group task', { conversationType: 'group', conversationId: 'group' })
  await waitUntil(() => h.followups.length === 2)
  const group = h.followups[1].agent
  for (const name of ['send_file', 'present', 'visualize', 'exit_plan_mode']) {
    assert.ok(!group.ctx.tools.schemas().some((schema) => schema.name === name), name)
    assert.match(group.guard(name), /im_private_reply_required|im_file_transfer_unavailable/, name)
  }
  assert.ok(group.ctx.tools.schemas().some(({ name }) => name === 'working_directory'))
  assert.match(group.guard('working_directory', { cd: h.target }), /im_private_reply_required/)
  await assert.rejects(h.followups[1].agent.invoke('send_file', { path: file }), /tool_not_registered/)
  assert.equal(attempts().length, 0)
  assert.deepEqual(await agent.invoke('send_file', { path: '验收.xlsx' }), {
    status: 'accepted',
    processQueryKey: 'test-receipt',
  })
  const pending = agent.invoke('send_file', { path: file })
  h.connection.reconnect()
  await assert.rejects(pending, /file_authorization_changed/)
  await assert.rejects(agent.invoke('send_file', { path: file }), /im_channel_authorization_changed/)
  assert.equal(attempts().length, 1)
  assert.equal(attempts()[0].target, 'original-request')
  assert.equal(attempts()[0].value.name, '验收.xlsx')
  assert.deepEqual(Buffer.from(attempts()[0].value.data), workbook)
})

test('employee tools retain the original private recipient and switch workspace after successful settlement', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('hold', { sessionWebhook: 'first-batch-request' })
  await waitUntil(() => h.followups.length === 1)
  const agent = h.followups[0].agent
  assert.deepEqual(await agent.invoke('working_directory'), { cwd: h.root })
  assert.equal(await agent.invoke('todo_write'), h.root)
  assert.equal(await agent.invoke('get_goal'), h.root)
  await assert.rejects(agent.invoke('working_directory', { cd: h.other }), /employee_workspace_access_denied/)
  await assert.rejects(agent.invoke('present', { files: [{ path: h.other }] }), /employee_workspace_access_denied/)

  assert.deepEqual(await agent.invoke('working_directory', { cd: 'target' }), {
    cwd: h.root,
    pending: h.target,
  })
  assert.equal(await agent.invoke('read'), h.root)
  await h.send('queued under previous workspace')
  h.renderer.release(agent.id, true)
  await waitUntil(() =>
    h.connection.operations.some((op) => op.name === 'markdown' && op.value.text.includes('已切换工作目录')),
  )
  assert.equal(h.followups.length, 1)
  assert.match(agent.guard('read'), /im_channel_authorization_changed/)
  await h.send('next workspace')
  await waitUntil(() => h.followups.length === 2)
  assert.equal(await h.followups[1].agent.invoke('read'), h.target)
})

test('enterprise /plan enters the host plan mode only from the bound private chat', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('/plan prepare workbook', { conversationType: 'group', conversationId: 'group' })
  await h.send('/plan')
  assert.equal(h.followups.length, 0)
  await h.send('/plan prepare workbook')
  await waitUntil(() => h.followups.length === 1)
  const { agent, message } = h.followups[0]
  assert.equal(agent.planMode, true)
  assert.deepEqual(message.content, [{ type: 'text', text: 'prepare workbook' }])
  assert.ok(agent.ctx.tools.schemas().some(({ name }) => name === 'exit_plan_mode'))
})

test('failed turns and lost employee authorization cannot commit a requested workspace switch', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('hold')
  await waitUntil(() => h.followups.length === 1)
  const agent = h.followups[0].agent
  await agent.invoke('working_directory', { cd: 'target' })
  h.renderer.release(agent.id)
  await h.send('hold')
  await waitUntil(() => h.followups.length === 2)
  const sameAgent = h.followups[1].agent
  assert.equal(await sameAgent.invoke('read'), h.root)
  await sameAgent.invoke('working_directory', { cd: 'target' })
  h.connection.reconnect()
  h.renderer.release(sameAgent.id, true)
  await h.send('fresh connection')
  await waitUntil(() => h.followups.length === 3)
  assert.equal(await h.followups[2].agent.invoke('read'), h.root)
  assert.ok(h.connection.operations.every((op) => !op.value?.text?.includes('已切换工作目录')))
})

test('enterprise legacy directory override is reported before task admission and reset restores its own workspace', async (t) => {
  const h = await fixture(t, { enterprise: true, outsideWorkspace: true })
  await h.send('task in old directory')
  assert.equal(h.followups.length, 0)
  assert.match(h.connection.operations.at(-1).value.text, /工作区不可用.*cd reset/)
  await h.send('/cd reset')
  await h.send('task after reset')
  await waitUntil(() => h.followups.length === 1)
  assert.equal(await h.followups[0].agent.invoke('read'), h.root)
})

test('enterprise pending approval cannot survive reconnect or move to a replacement employee', async (t) => {
  const h = await fixture(t, { enterprise: true })
  await h.send('hold')
  await waitUntil(() => h.followups.length === 1)
  const old = h.followups[0].agent
  const request = new AbortController()
  t.after(() => request.abort())
  const outcome = old.requestApproval(request.signal)
  await waitUntil(() => h.connection.operations.some((op) => /回复 `确认/.test(op.value.text ?? '')))
  h.connection.reconnect()
  assert.equal(await outcome, 'cancelled')
  await assert.rejects(old.invoke('read'), /im_channel_authorization_changed/)
  h.renderer.release(old.id)
  await h.send('fresh task')
  await waitUntil(() => h.followups.length === 2)
  assert.equal(await h.followups[1].agent.invoke('read'), h.root)
  h.connection.pair({ corpId: 'corp-a', userId: 'owner-b' })
  await h.send('replacement employee', { senderStaffId: 'owner-b' })
  assert.equal(h.followups.length, 2)
  await assert.rejects(h.followups[1].agent.invoke('write'), /im_channel_authorization_changed/)
})

test('personal public apply uses channel identity without DWS OAuth and preserves host tool guards', async (t) => {
  const h = await fixture(t)
  await h.send('ordinary task')
  await waitUntil(() => h.followups.length === 1)
  const agent = h.followups[0].agent
  assert.match(h.attempts[0].beforeCommit, /im_channel_authorization_changed/)
  assert.equal(agent.guard('read'), undefined)
  assert.equal(await agent.invoke('read'), h.root)
  await assert.rejects(agent.invoke('bash'), /host_tool_disabled/)
  await assert.rejects(agent.invoke('unregistered'), /tool_not_registered/)
  for (const name of ['send_file', 'send_image', 'spawn_agent', 'subagent'])
    assert.match(agent.guard(name), /im_tool_unavailable/)
  assert.deepEqual(h.executed, ['read'])
  for (const overrides of [{ senderStaffId: 'owner-b' }, { senderCorpId: 'corp-b' }, { senderCorpId: undefined }]) {
    await h.send('foreign task', overrides)
  }
  await flush()
  assert.equal(h.followups.length, 1)
})

for (const change of ['revoke', 'repair']) {
  test(`personal queued admission cannot borrow a later binding: ${change}`, async (t) => {
    const h = await fixture(t)
    await h.send('hold')
    await waitUntil(() => h.followups.length === 1)
    const agent = h.followups[0].agent
    await h.send('old queued task')
    change === 'revoke' ? h.connection.revoke() : h.connection.pair()
    assert.match(agent.guard('read'), /im_channel_authorization_changed/)
    h.renderer.release(agent.id)
    await waitUntil(() => h.failures() === 1)
    assert.equal(h.followups.length, 1)
    if (change === 'revoke') h.connection.pair()
    await h.send('fresh task')
    await waitUntil(() => h.followups.length === 2)
    assert.notEqual(h.followups[1].agent.id, agent.id)
    assert.equal(await h.followups[1].agent.invoke('read'), h.root)
  })
}

test('personal /cd invalidates old active and queued work before opening the selected cwd', async (t) => {
  const h = await fixture(t)
  await h.send('hold')
  await waitUntil(() => h.followups.length === 1)
  const old = h.followups[0].agent
  await h.send('old workspace queued task')
  await h.send(`/cd ${h.target}`)
  await assert.rejects(old.invoke('read'), /im_channel_authorization_changed/)
  h.renderer.release(old.id)
  await waitUntil(() => h.failures() === 1)
  assert.equal(h.followups.length, 1)
  await h.send('selected workspace task')
  await waitUntil(() => h.followups.length === 2)
  const current = h.followups[1].agent
  assert.notEqual(current.id, old.id)
  assert.equal(await current.invoke('read'), h.target)
  const owners = JSON.parse(await readFile(path.join(h.account, 'workspace-session-owners.json'), 'utf8'))
  assert.equal(owners[current.id].cwd, h.target)
  assert.equal(owners[current.id].bindingId, h.connection.authority().bindingId)
})

for (const change of ['revoke', 'replace', 'reconnect', '/cd', '/new', '/model use fixture/new', '/model reset']) {
  test(`personal pre-dispatch approval is cancelled by ${change} without consuming the next task`, async (t) => {
    const h = await fixture(t)
    await h.send('first task')
    await waitUntil(() => h.followups.length === 1)
    const request = new AbortController()
    t.after(() => request.abort())
    let settled = false
    const outcome = h.followups[0].agent.requestApproval(request.signal).then((value) => {
      settled = true
      return value
    })
    const approvalTexts = () =>
      h.connection.operations.filter((op) => op.name === 'markdown' && /回复 `确认/.test(op.value.text))
    await waitUntil(() => approvalTexts().length === 1)
    if (change === 'revoke') h.connection.revoke()
    else if (change === 'replace') h.connection.pair({ corpId: 'corp-a', userId: 'new-owner' })
    else if (change === 'reconnect') h.connection.pair()
    else await h.send(change === '/cd' ? `/cd ${h.target}` : change)
    await waitUntil(() => settled)
    assert.equal(await outcome, 'cancelled')
    assert.equal(request.signal.aborted, false, 'channel cancellation does not abort the host controller')
    if (change === 'revoke') h.connection.pair()
    await h.send('new task after cancelled approval', change === 'replace' ? { senderStaffId: 'new-owner' } : {})
    await waitUntil(() => h.followups.length === 2)
    const next = h.followups[1].agent
    assert.notEqual(next, h.followups[0].agent)
    let freshSettled = false
    const fresh = next.requestApproval(request.signal).then((value) => {
      freshSettled = true
      return value
    })
    await waitUntil(() => approvalTexts().length === 2)
    await flush()
    assert.equal(freshSettled, false, 'old generation cleanup must not cancel the new approval')
    const code = approvalTexts()[1].value.text.match(/确认 ([A-F0-9]{6})/)[1]
    await h.send(`确认 ${code}`, change === 'replace' ? { senderStaffId: 'new-owner' } : {})
    assert.equal(await fresh, 'allowed-once')
    assert.equal(h.followups.length, 2, 'the approval answer is consumed only by the new generation')
  })
}

test('personal workspace cancellation isolates concurrent routes and leaves both new and unrelated approvals intact', async (t) => {
  const h = await fixture(t)
  await h.send('first task')
  await h.send('other task', { conversationId: 'other' })
  await waitUntil(() => h.followups.length === 2)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const old = h.followups[0].agent.requestApproval(controller.signal)
  let otherSettled = false
  const other = h.followups[1].agent.requestApproval(controller.signal).then((value) => {
    otherSettled = true
    return value
  })
  const texts = () => h.connection.operations.filter((op) => op.name === 'markdown' && /回复 `确认/.test(op.value.text))
  await waitUntil(() => texts().length === 2)
  const oldCode = texts()[0].value.text.match(/确认 ([A-F0-9]{6})/)[1]
  const otherCode = texts()[1].value.text.match(/确认 ([A-F0-9]{6})/)[1]
  await h.send(`/cd ${h.target}`)
  assert.equal(await old, 'cancelled')
  assert.equal(otherSettled, false)
  await h.send('new task')
  await waitUntil(() => h.followups.length === 3)
  let freshSettled = false
  const fresh = h.followups[2].agent.requestApproval(controller.signal).then((value) => {
    freshSettled = true
    return value
  })
  await waitUntil(() => texts().length === 3)
  await h.send(`确认 ${oldCode}`)
  assert.equal(freshSettled, false, 'a stale confirmation cannot settle the new approval')
  await h.send(`确认 ${otherCode}`, { conversationId: 'other' })
  assert.equal(await other, 'allowed-once')
  assert.equal(freshSettled, false, 'another route cannot settle this approval')
  const freshCode = texts()[2].value.text.match(/确认 ([A-F0-9]{6})/)[1]
  await h.send(`确认 ${freshCode}`)
  assert.equal(await fresh, 'allowed-once')
})

for (const change of ['/cd', '/cd away and back', '/new']) {
  test(`personal message delayed before queue admission cannot cross ${change}`, async (t) => {
    let release,
      checkingImages = false
    const modelInfo = new Promise((resolve) => {
      release = resolve
    })
    const h = await fixture(t, {
      resolveModelInfo: () => {
        checkingImages = true
        return modelInfo
      },
    })
    const delayed = h.send('old image task', { imageDownloadCodes: ['fixture-image'] })
    await waitUntil(() => checkingImages)
    assert.equal(h.attempts.length, 0, 'the old message has not reached Agent setup or the queue')
    if (change === '/new') await h.send('/new')
    else {
      await h.send(`/cd ${h.target}`)
      if (change === '/cd away and back') await h.send(`/cd ${h.root}`)
    }
    release({ inputModalities: ['image'] })
    await delayed
    await flush()
    assert.equal(h.attempts.length, 0, 'receipt-time workspace authority cannot be replaced after an await')
    assert.equal(h.followups.length, 0)
    await h.send('fresh context task')
    await waitUntil(() => h.followups.length === 1)
    assert.equal(await h.followups[0].agent.invoke('read'), change === '/cd' ? h.target : h.root)
  })
}

test('personal owned session resumes with a new scoped Agent and the same selected workspace', async (t) => {
  const h = await fixture(t)
  await h.send(`/cd ${h.target}`)
  await h.send('first task')
  await waitUntil(() => h.followups.length === 1)
  const first = h.followups[0].agent
  h.live.delete(first.id)
  await h.send('resume task')
  await waitUntil(() => h.followups.length === 2)
  const restored = h.followups[1].agent
  assert.equal(restored.id, first.id)
  assert.notEqual(restored, first)
  assert.equal(h.resumeCalls, 1)
  await assert.rejects(first.invoke('read'), /im_channel_authorization_changed/)
  assert.equal(await restored.invoke('read'), h.target)
})

test('personal same-device reconnect resumes the owned session instead of starting a new one', async (t) => {
  const h = await fixture(t)
  await h.send('first task')
  await waitUntil(() => h.followups.length === 1)
  const first = h.followups[0].agent
  h.connection.reconnect()
  await h.send('after reconnect')
  await waitUntil(() => h.followups.length === 2)
  const resumed = h.followups[1].agent
  assert.equal(resumed.id, first.id)
  assert.notEqual(resumed, first)
  assert.equal(h.resumeCalls, 1)
  await assert.rejects(first.invoke('read'), /im_channel_authorization_changed/)
  assert.equal(await resumed.invoke('read'), h.root)
})

test('personal setup cannot publish an Agent when its pairing is revoked before commit', async (t) => {
  const h = await fixture(t, { revokeAtCommit: true })
  await h.send('stale setup')
  await waitUntil(() => h.failures() === 1)
  assert.equal(h.live.size, 0)
  assert.equal(h.followups.length, 0)
  assert.match(h.attempts[0].error, /im_channel_authorization_changed/)
})

for (const foreign of [false, true]) {
  test(`personal startup legacy session does not confer ownership (live=${foreign})`, async (t) => {
    const h = await fixture(t, { legacy: true, foreign })
    await h.send('fresh owned task')
    await waitUntil(() => h.followups.length === 1)
    assert.notEqual(h.followups[0].agent.id, 'legacy-session')
    assert.equal(h.resumeCalls, 0)
    if (foreign) assert.equal(h.live.get('legacy-session'), h.foreignAgent)
  })
}

for (const missing of ['session', 'workingDirectory']) {
  test(`personal host without ${missing} fails closed before followup`, async (t) => {
    const h = await fixture(t, { missing })
    await h.send('task without host context')
    await waitUntil(() => h.failures() === 1)
    assert.equal(h.followups.length, 0)
    assert.equal(h.live.size, 0)
    assert.match(h.attempts[0].error, /im_workspace_context_unavailable/)
  })
}
