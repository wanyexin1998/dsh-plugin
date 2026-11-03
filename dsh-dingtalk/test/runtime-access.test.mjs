import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { strictAgentContext } from './helpers/strict-agent-context.mjs'
import { imToolFactory } from './helpers/im-tool-factory.mjs'

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream'
import { apply } from '../lib/index.js'

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('等待公开运行时行为超时')
}

function baseConfig(workspace, access) {
  return {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    workspace,
    markdownTitle: 'DSH',
    interactionCardTemplateId: '',
    ownerStaffId: 'owner',
    senderAccess: access.senderAccess,
    allowedSenders: access.allowedSenders,
    groupAccess: access.groupAccess,
    groupAllowlist: access.groupAllowlist,
    replyMode: { direct: 'text', group: 'text' },
    streaming: { enabled: false, throttleMs: 500, maxCardChars: 15_000 },
    asyncMode: false,
    ackText: '处理中',
    queueAckText: '排队中',
    questionTimeoutMs: 300_000,
    approvalTimeoutMs: 300_000,
    tools: { enabled: false },
    sessionScope: 'chat-sender',
    imageMode: 'never',
    emotionFirstResponse: false,
    rejectNotice: false,
    debug: false,
  }
}

function createHost(workspace) {
  const lifecycle = new Context()
  const eventHandlers = new Map()
  const agents = new Map()
  const created = []
  const followups = []
  const workspaceSessions = []

  const emit = (name, ...args) => {
    for (const handler of eventHandlers.get(name) ?? []) handler(...args)
  }
  const registry = {
    get: (id) => agents.get(id),
    resume: async () => {
      throw new Error('测试不应恢复旧会话')
    },
    create: async (options) => {
      const scopedHandlers = new Map()
      const scope = strictAgentContext()
      lifecycle.effect(() => scope.dispose)
      const agentCtx = scope.ctx.extend({
        on(name, handler) {
          const off = scope.ctx.on(name, handler)
          scopedHandlers.set(name, handler)
          return () => {
            off()
            scopedHandlers.delete(name)
          }
        },
      })
      const agent = {
        id: options.sessionId,
        status: 'idle',
        ctx: agentCtx,
        followup(message) {
          followups.push({ sessionId: options.sessionId, message })
          queueMicrotask(() => {
            emit(
              'session/event',
              { id: options.sessionId },
              {
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: '已处理' }] } },
              },
            )
            emit('session/event', { id: options.sessionId }, { type: 'turn/end', data: { reason: {} } })
          })
        },
        steer() {},
        cancel() {},
      }
      await options.setup?.(agentCtx, agent)
      agents.set(options.sessionId, agent)
      created.push({ sessionId: options.sessionId, cwd: options.meta?.cwd, agent, scopedHandlers })
      return { agent, dispose: async () => {} }
    },
  }
  const linkedWorkspace = {
    path: workspace,
    sessionIds: workspaceSessions,
    async attachSession(sessionId) {
      if (!workspaceSessions.includes(sessionId)) workspaceSessions.push(sessionId)
    },
  }
  const ctx = {
    effect: (...args) => lifecycle.effect(...args),
    agents: registry,
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'model' }) },
    credentials: { resolve: async () => undefined },
    get(name) {
      if (name === 'dingtalkImTools') return imToolFactory
      if (name === 'workspaceRegistry') {
        return {
          resolveByPath: async () => linkedWorkspace,
          create: async () => linkedWorkspace,
        }
      }
      return undefined
    },
    on(name, handler) {
      const handlers = eventHandlers.get(name) ?? []
      handlers.push(handler)
      eventHandlers.set(name, handlers)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
  }
  return {
    ctx,
    created,
    followups,
    dispose: () => lifecycle.fiber.dispose(),
  }
}

function delivery(messageId, senderStaffId, conversationId, conversationType = '2', text = `消息-${messageId}`) {
  return {
    headers: { messageId },
    data: JSON.stringify({
      msgId: messageId,
      msgtype: 'text',
      conversationType,
      conversationId,
      senderStaffId,
      senderNick: '测试用户',
      text: { content: text },
      createAt: messageId,
      sessionWebhook: 'https://example.test/session',
    }),
  }
}

test('公开插件运行时执行发送者和群策略，并按群成员隔离会话', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-access-'))
  const originalStateDir = process.env.DSH_DINGTALK_STATE_DIR
  const originalFetch = globalThis.fetch
  const originalConnect = DWClient.prototype.connect
  const originalDisconnect = DWClient.prototype.disconnect
  const originalRegister = DWClient.prototype.registerCallbackListener
  const originalCallbackResponse = DWClient.prototype.socketCallBackResponse
  const streamClients = []
  const runtimeHosts = []
  const sent = []

  t.after(async () => {
    for (const host of runtimeHosts) await host.dispose()
    if (originalStateDir === undefined) delete process.env.DSH_DINGTALK_STATE_DIR
    else process.env.DSH_DINGTALK_STATE_DIR = originalStateDir
    globalThis.fetch = originalFetch
    DWClient.prototype.connect = originalConnect
    DWClient.prototype.disconnect = originalDisconnect
    DWClient.prototype.registerCallbackListener = originalRegister
    DWClient.prototype.socketCallBackResponse = originalCallbackResponse
    await rm(root, { recursive: true, force: true })
  })

  DWClient.prototype.registerCallbackListener = function (topic, callback) {
    let record = streamClients.find((item) => item.client === this)
    if (!record) {
      record = { client: this, callbacks: new Map() }
      streamClients.push(record)
    }
    record.callbacks.set(topic, callback)
  }
  DWClient.prototype.connect = async function () {
    const socket = new EventEmitter()
    socket.readyState = 1
    socket.ping = () => {}
    this.socket = socket
  }
  DWClient.prototype.disconnect = async function () {
    if (this.socket) this.socket.readyState = 3
  }
  DWClient.prototype.socketCallBackResponse = () => {}
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'test-token', expireIn: 7200 }) }
    }
    sent.push({ url, body: JSON.parse(init.body) })
    return { ok: true, text: async () => '' }
  }

  process.env.DSH_DINGTALK_STATE_DIR = path.join(root, 'allowlist-state')
  const allowlistHost = createHost(path.join(root, 'allowlist-workspace'))
  runtimeHosts.push(allowlistHost)
  await apply(
    allowlistHost.ctx,
    baseConfig(path.join(root, 'allowlist-workspace'), {
      senderAccess: 'allowlist',
      allowedSenders: ['member-a', 'member-b'],
      groupAccess: 'allowlist',
      groupAllowlist: ['group-a'],
    }),
  )
  const allowlistInbound = streamClients[0].callbacks.get(TOPIC_ROBOT)

  await allowlistInbound(delivery('member', 'member-a', 'group-a'))
  await allowlistInbound(delivery('intruder', 'intruder', 'group-a'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(allowlistHost.followups.length, 0, 'phase one denies even previously allowlisted members')
  await allowlistInbound(delivery('owner', 'owner', 'group-a'))
  await waitFor(() => allowlistHost.followups.length === 1)
  await allowlistInbound(delivery('owner-dm', 'owner', 'owner-dm', '1'))
  await waitFor(() => allowlistHost.followups.length === 2)
  assert.notEqual(allowlistHost.created[0].sessionId, allowlistHost.created[1].sessionId)
  const repliesBeforeFailure = sent.length
  allowlistHost.ctx.agents.create = async () => {
    throw new Error('synthetic_private_setup_failure')
  }
  await allowlistInbound(delivery('dispatch-failure', 'owner', 'fresh-owner-dm', '1'))
  await waitFor(() =>
    sent.slice(repliesBeforeFailure).some((reply) => reply.body.markdown?.text?.includes('未能开始处理')),
  )
  assert.equal(
    sent.slice(repliesBeforeFailure).filter((reply) => reply.body.markdown?.text?.includes('未能开始处理')).length,
    1,
  )
  assert.ok(!JSON.stringify(sent.slice(repliesBeforeFailure)).includes('synthetic_private_setup_failure'))
})
