import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'
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
  revoke() {
    this.controller.abort()
    this.current = undefined
  }
  authority() {
    return this.current
  }
  status() {
    return { mode: 'personal' }
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
  release(id) {
    this.pending.get(id)?.()
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
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('personal runtime did not reach the expected state')
}
async function flush() {
  for (let count = 0; count < 5; count++) await new Promise((resolve) => setImmediate(resolve))
}

async function fixture(t, { legacy = false, foreign = false, missing, revokeAtCommit = false, resolveModelInfo } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-personal-workspace-')))
  const target = path.join(root, 'target')
  await mkdir(target)
  const state = path.join(root, 'state')
  const account = path.join(state, 'personal-runtime', 'accounts', 'shared')
  if (legacy) {
    await mkdir(account, { recursive: true })
    await writeFile(path.join(account, 'bindings.json'), JSON.stringify({ direct: 'legacy-session' }))
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
    await rm(root, { recursive: true, force: true })
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
  const prepare = async (options) => {
    const tools = new Map(),
      guards = [],
      listeners = new Map()
    const agentCtx = {
      tools: {
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
        if (name === 'workingDirectory' && missing !== 'workingDirectory')
          return { get: (session) => session.header.cwd }
      },
    }
    // Host policy remains installed independently of the IM guard.
    agentCtx.tools.guard((exec) => (exec.name === 'bash' ? 'host_tool_disabled' : undefined))
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
      guard(name) {
        return guards.map((fn) => fn({ name, agent })).find(Boolean)
      },
      requestApproval(signal) {
        return listeners.get('approval/request')[0]({ agent, toolName: 'bash', signal })
      },
      async invoke(name) {
        const definition = tools.get(name)
        if (!definition) throw new Error('tool_not_registered')
        const reason = this.guard(name)
        if (reason) throw new Error(reason)
        const exec = { name, agent, signal: new AbortController().signal }
        const dispatch = (listeners.get('tools/execute') ?? []).reduceRight(
          (next, listener) => () => listener(exec, next),
          () => definition.execute({}, exec),
        )
        return dispatch()
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
  const noDwsIdentity = { ...imToolFactory, identity: () => undefined }
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
              for (const name of ['read', 'bash'])
                ctx.tools.register({
                  name,
                  async execute(_args, exec) {
                    executed.push(name)
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
  assert.equal(noDwsIdentity.identity(), undefined)
  let sequence = 0
  const send = (text, overrides = {}) =>
    connection.source.onMessage({
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
    })
  const failures = () =>
    connection.operations.filter((op) => op.name === 'markdown' && /未能开始处理/.test(op.value.text)).length
  return {
    root,
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
