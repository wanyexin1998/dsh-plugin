const originalFetch = globalThis.fetch
import { Renderer } from '../lib/renderer.js'
import { createRobotOperations } from '../lib/relay/robot.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Gateway } from '../lib/relay/gateway.js'
import { RelayClient } from '../lib/relay/client.js'
import { RobotConnection } from '../lib/relay/controller.js'
import WebSocket from 'ws'
import { Peer } from '../lib/relay/protocol.js'

async function fixture(
  t,
  { personal = false, groupMentionSenders, exchange = async (code) => ({ corpId: 'corp', userId: code }) } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-'))
  const notices = [],
    operations = [],
    clients = []
  const reserve = createServer()
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r))
  const selectedPort = reserve.address().port
  await new Promise((r) => reserve.close(r))
  const opts = {
    stateFile: join(dir, 'gateway.json'),
    port: selectedPort,
    login: {
      publicOrigin: `http://127.0.0.1:${selectedPort}`,
      clientId: 'fixture-app',
      exchange,
    },
    allowedCorpId: 'corp',
    allowedGroups: ['group'],
    groupMentionSenders,
    allowUnclaimedPersonalLogin: personal,
    notice: async (msg, text) => notices.push({ user: msg.senderStaffId, text }),
    operation: async (msg, method, data) => {
      operations.push({ user: msg.senderStaffId, method, data, destination: msg.sessionWebhook })
      return true
    },
  }
  const gateway = new Gateway(opts),
    port = await gateway.start()
  t.after(async () => {
    clients.forEach((c) => c.stop())
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  })
  const message = (user, text = 'query', extra = {}) => ({
    msgId: crypto.randomUUID(),
    conversationId: `dm-${user}`,
    conversationType: 'direct',
    senderStaffId: user,
    senderCorpId: 'corp',
    senderNick: user,
    text,
    createAt: String(Date.now()),
    sessionWebhook: `https://original.invalid/${user}`,
    ...extra,
  })
  async function client(user, suffix = user, onMessage, enterprise) {
    let identity = user === undefined ? undefined : { corpId: 'corp', userId: user }
    const received = [],
      callbacks = []
    const file = join(dir, `${suffix}.json`)
    const c = enterprise
      ? new RobotConnection({ root: dir, home: dir, profile: join(dir, suffix), identity: () => identity, enterprise })
      : new RelayClient(file, () => identity, { channelOwned: personal, expectedCorpId: () => 'corp' })
    clients.push(c)
    // Exercise enterprise receipt and grants on an actual local pairing without an external WSS endpoint.
    await RelayClient.prototype.start.call(c, {
      onMessage: async (msg) => {
        received.push(msg)
        if (onMessage) return onMessage(msg, c)
        await c.operation(msg.sessionWebhook, 'text', { text: 'result' })
      },
      onCardCallback: (cb) => {
        callbacks.push(cb)
        return { handled: true }
      },
    })
    const pending = await RelayClient.prototype.connect.call(c, `ws://127.0.0.1:${port}/relay`)
    return {
      c,
      received,
      callbacks,
      file,
      pending,
      change: (value) => {
        identity = value
      },
    }
  }
  async function finish(f, user, denied = false) {
    const start = await fetch(f.pending.authorizeUrl, { redirect: 'manual' })
    assert.equal(start.status, 302)
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    const callback = `http://127.0.0.1:${port}/relay/callback?state=${state}&${denied ? 'error=access_denied' : `code=${user}&authCode=${user}`}`
    const response = await fetch(callback, { headers: { cookie: start.headers.get('set-cookie').split(';')[0] } })
    await new Promise((r) => setTimeout(r, 20))
    return response
  }
  async function pair(f, user) {
    assert.equal((await finish(f, user)).status, 200)
    assert.equal(f.c.status().status, 'connected')
  }
  async function restore(file, onMessage = async () => {}) {
    const c = new RelayClient(file, () => undefined, { channelOwned: personal, expectedCorpId: () => 'corp' })
    clients.push(c)
    await c.start({ onMessage })
    return c
  }
  return { dir, opts, gateway, port, message, client, pair, finish, restore, notices, operations }
}

test('enterprise direct and group query grants belong only to the live receiver of the actual sender', async (t) => {
  const f = await fixture(t)
  const query = 'mcp__doris__exec_query'
  const config = {
    mode: 'enterprise',
    corpId: 'corp',
    clientId: 'app',
    displayName: 'Test',
    gatewayUrl: 'wss://example.org/relay',
    queryTools: [query],
  }
  const a = await f.client('a', 'enterprise-a', undefined, config)
  const b = await f.client('b', 'enterprise-b', undefined, config)
  await f.pair(a, 'a')
  await f.pair(b, 'b')
  await f.gateway.receive(f.message('a'))
  const grant = a.c.enterpriseQueries(a.received[0])
  assert.ok(grant(query))
  assert.equal(grant('mcp__doris__kill_query'), undefined)
  assert.equal(a.c.enterpriseQueries({ ...a.received[0] }), undefined)
  assert.equal(b.c.enterpriseQueries(a.received[0]), undefined)
  for (const user of ['a', 'b'])
    await f.gateway.receive(
      f.message(user, 'query', { conversationType: 'group', conversationId: 'group', atUsers: [{ userId: 'a' }] }),
    )
  assert.deepEqual(a.c.enterpriseQueries(a.received[1])(query).identity, { corpId: 'corp', userId: 'a' })
  assert.deepEqual(b.c.enterpriseQueries(b.received[0])(query).identity, { corpId: 'corp', userId: 'b' })
  a.change({ corpId: 'corp', userId: 'b' })
  assert.equal(grant(query), undefined)
  a.change({ corpId: 'corp', userId: 'a' })
  const old = grant(query)
  a.c.stop()
  assert.equal(old.signal.aborted, true)
  assert.equal(grant(query), undefined)
  assert.equal(a.c.enterpriseQueries(a.received[0]), undefined)
})

test('personal pairing derives its owner from robot login and survives DWS logout or account change', async (t) => {
  const f = await fixture(t, { personal: true }),
    a = await f.client(undefined, 'personal')
  assert.equal(a.c.channelBinding(), undefined)
  await f.pair(a, 'a')
  const binding = a.c.channelBinding()
  assert.deepEqual(binding.identity, { corpId: 'corp', userId: 'a' })
  assert.ok(Object.isFrozen(binding))
  assert.ok(Object.isFrozen(binding.identity))
  assert.equal(binding.signal.aborted, false)
  assert.equal(f.gateway.authorizes(binding.identity, binding.bindingId), true)
  assert.equal(f.gateway.authorizes({ corpId: 'corp', userId: 'b' }, binding.bindingId), false)
  assert.equal(f.gateway.authorizes(binding.identity, 'different-device'), false)
  assert.equal('token' in binding, false)
  assert.equal('token' in a.c.status(), false)
  await f.gateway.receive(f.message('a'))
  a.change({ corpId: 'other-corp', userId: 'other-user' })
  await f.gateway.receive(f.message('a'))
  a.change(undefined)
  await f.gateway.receive(f.message('a'))
  await f.gateway.receive(f.message('b'))
  await f.gateway.receive(f.message('a', 'query', { senderCorpId: 'foreign' }))
  assert.equal(a.received.length, 3)
  assert.equal(a.c.status().status, 'connected')
  assert.equal(a.c.channelBinding().bindingId, binding.bindingId)
  assert.equal(binding.signal.aborted, false)
  await a.c.disconnect()
  assert.equal(binding.signal.aborted, true)
  assert.equal(a.c.channelBinding(), undefined)
  assert.equal(f.gateway.authorizes(binding.identity, binding.bindingId), false)
})

test('personal replacement revokes the old lease while the new device has a distinct channel binding', async (t) => {
  const f = await fixture(t, { personal: true }),
    a = await f.client(undefined, 'first')
  await f.pair(a, 'a')
  const old = a.c.channelBinding()
  const replacement = await f.client(undefined, 'replacement')
  await f.pair(replacement, 'a')
  assert.equal(old.signal.aborted, true)
  assert.equal(a.c.channelBinding(), undefined)
  assert.equal(f.gateway.authorizes(old.identity, old.bindingId), false)
  const current = replacement.c.channelBinding()
  assert.notEqual(current.bindingId, old.bindingId)
  assert.equal(f.gateway.authorizes(current.identity, current.bindingId), true)
  replacement.c.stop()
  assert.equal(current.signal.aborted, true)
  assert.equal(replacement.c.channelBinding(), undefined)
})

test('personal restart authenticates saved token, migrates legacy device metadata and keeps binding ID', async (t) => {
  const f = await fixture(t, { personal: true }),
    a = await f.client(undefined, 'restored')
  await f.pair(a, 'a')
  const original = a.c.channelBinding()
  a.c.stop()
  const saved = JSON.parse(await readFile(a.file, 'utf8'))
  delete saved.device
  delete saved.confirmed
  await writeFile(a.file, JSON.stringify(saved))
  const received = []
  const restored = await f.restore(a.file, async (msg) => received.push(msg))
  const current = restored.channelBinding()
  assert.ok(current)
  assert.equal(current.bindingId, original.bindingId)
  assert.equal(original.signal.aborted, true)
  assert.notEqual(current.signal, original.signal)
  assert.equal(current.signal.aborted, false)
  const migrated = JSON.parse(await readFile(a.file, 'utf8'))
  assert.equal(migrated.device, original.bindingId)
  assert.equal(migrated.confirmed, true)
  assert.equal(f.gateway.status().boundUsers, 1)
  await f.gateway.receive(f.message('a'))
  assert.equal(received.length, 1)
  await writeFile(f.opts.stateFile, '[]')
  assert.equal(
    f.gateway.authorizes(current.identity, current.bindingId),
    false,
    'persisted revocation denies authority',
  )
})

test('personal OAuth must match configured enterprise and verified sender; default relay still requires DWS', async (t) => {
  const f = await fixture(t, {
    personal: true,
    exchange: async (code) => ({ corpId: code === 'foreign' ? 'foreign-corp' : 'corp', userId: code }),
  })
  const wrong = await f.client(undefined, 'wrong-corp')
  assert.equal((await f.finish(wrong, 'foreign')).status, 400)
  assert.equal(wrong.c.channelBinding(), undefined)
  assert.equal(f.gateway.status().boundUsers, 0)
  const a = await f.client(undefined, 'valid')
  await f.pair(a, 'a')
  const route = f.gateway.online.get(JSON.stringify(['corp', 'a']))
  await assert.rejects(
    route.peer.call('message', {
      requestId: 'forged',
      message: f.message('b', 'forged', { sessionWebhook: 'forged' }),
    }),
  )
  assert.equal(a.received.length, 0)
  const legacy = new RelayClient(join(f.dir, 'legacy.json'), () => undefined)
  await assert.rejects(legacy.connect(`ws://127.0.0.1:${f.port}/relay`), /auth_required/)
})

test('unclaimed personal login remains native-only and is disabled for ordinary gateways', async (t) => {
  const personal = await fixture(t, { personal: true })
  const browser = new WebSocket(`ws://127.0.0.1:${personal.port}/relay`, { origin: 'http://127.0.0.1' })
  const code = await new Promise((resolve, reject) => {
    browser.once('close', resolve)
    browser.once('error', reject)
  })
  assert.equal(code, 1008)
  assert.equal(personal.gateway.status().boundUsers, 0)
  const ordinary = await fixture(t)
  const socket = new WebSocket(`ws://127.0.0.1:${ordinary.port}/relay`)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  try {
    const peer = new Peer(socket, async () => assert.fail('unexpected gateway challenge'))
    await assert.rejects(peer.call('hello', {}))
    assert.equal(ordinary.gateway.status().boundUsers, 0)
  } finally {
    socket.close()
  }
})

test('two real sockets bind through verified browser login and route to their own DSH; original reply destination stays gateway-side', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    b = await f.client('b')
  await f.gateway.receive(f.message('b', '/bind obsolete'))
  assert.equal(a.c.status().status, 'authorizing')
  await f.pair(a, 'a')
  await f.pair(b, 'b')
  await Promise.all([f.gateway.receive(f.message('a')), f.gateway.receive(f.message('b'))])
  assert.equal(a.received.length, 1)
  assert.equal(b.received.length, 1)
  assert.equal(a.received[0].senderStaffId, 'a')
  assert.equal(b.received[0].senderStaffId, 'b')
  assert.doesNotMatch(a.received[0].sessionWebhook, /^https:/)
  assert.deepEqual(f.operations.map((x) => [x.user, x.destination]).sort(), [
    ['a', 'https://original.invalid/a'],
    ['b', 'https://original.invalid/b'],
  ])
  await assert.rejects(b.c.operation(a.received[0].sessionWebhook, 'text', { text: 'forged' }))
  const disk = await readFile(f.opts.stateFile, 'utf8'),
    device = JSON.parse(await readFile(a.file, 'utf8'))
  assert.ok(!disk.includes(device.token))
  assert.ok(!disk.includes('query'))
})

test('group routes by sender; duplicates, foreign enterprise and unapproved group never execute', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    b = await f.client('b')
  await f.pair(a, 'a')
  await f.pair(b, 'b')
  const group = { conversationType: 'group', conversationId: 'group' }
  const msg = f.message('a', 'query', group)
  await f.gateway.receive(msg)
  await f.gateway.receive(msg)
  await f.gateway.receive(f.message('b', 'query', group))
  await f.gateway.receive(f.message('a', 'query', { senderCorpId: 'foreign' }))
  await f.gateway.receive(f.message('a', 'query', { ...group, conversationId: 'blocked' }))
  assert.equal(a.received.length, 1)
  assert.equal(b.received.length, 1)
})

for (const audience of [['a'], 'all']) {
  test(`a robot mention in a new group routes the actual sender for audience ${JSON.stringify(audience)}`, async (t) => {
    const f = await fixture(t, { groupMentionSenders: audience })
    const a = await f.client('a')
    const b = await f.client('b')
    await f.pair(a, 'a')
    await f.pair(b, 'b')
    const group = { conversationType: 'group', conversationId: 'new-group', robotMentioned: true }
    await Promise.all(['a', 'b'].map((user) => f.gateway.receive(f.message(user, '@colleague query', group))))
    await f.gateway.receive(f.message('a', '@robot query', { ...group, robotMentioned: false }))
    await f.gateway.receive(f.message('a', 'query', { ...group, senderCorpId: 'foreign' }))
    await f.gateway.receive(f.message('a', 'query', { ...group, senderCorpId: undefined }))
    await f.gateway.receive(f.message('unbound', 'query', group))
    assert.deepEqual(
      a.received.map((msg) => msg.senderStaffId),
      ['a'],
    )
    assert.deepEqual(
      b.received.map((msg) => msg.senderStaffId),
      audience === 'all' ? ['b'] : [],
    )
  })
}

test('OAuth revoke/change does not borrow another identity; same owner reconnect restores without pairing', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    b = await f.client('b')
  await f.pair(a, 'a')
  await f.pair(b, 'b')
  a.change(undefined)
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 0)
  assert.match(f.notices.at(-1).text, /重新连接/)
  await f.gateway.receive(f.message('b'))
  assert.equal(b.received.length, 1)
  a.change({ corpId: 'corp', userId: 'b' })
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 0)
  a.change({ corpId: 'corp', userId: 'a' })
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 1)
})

test('card callback must match original sender and cannot be claimed by another connection', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    b = await f.client('b')
  await f.pair(a, 'a')
  await f.pair(b, 'b')
  await f.gateway.receive(f.message('a'))
  await a.c.operation(a.received[0].sessionWebhook, 'interaction.create', { outTrackId: 'approval-1' })
  await f.gateway.card({ outTrackId: 'approval-1', userId: 'b', actionIds: ['approve'], params: {} })
  assert.equal(a.callbacks.length, 0)
  await f.gateway.card({ outTrackId: 'approval-1', userId: 'a', actionIds: ['approve'], params: {} })
  assert.equal(a.callbacks.length, 1)
  assert.equal(b.callbacks.length, 0)
})

test('offline and restored device; binding persists, unbinding removes it', async (t) => {
  const f = await fixture(t),
    a = await f.client('a')
  await f.pair(a, 'a')
  a.c.stop()
  await new Promise((r) => setTimeout(r, 30))
  await f.gateway.receive(f.message('a'))
  assert.match(f.notices.at(-1).text, /离线/)
  await a.c.start({
    onMessage: (msg) => {
      a.received.push(msg)
    },
  })
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 1)
  await a.c.disconnect()
  await f.gateway.receive(f.message('a'))
  assert.match(f.notices.at(-1).text, /连接机器人/)
})

test('new browser login automatically replaces the old device; revoked device stops reconnecting and cannot reclaim on restart', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    other = await f.client('a', 'a2')
  await f.pair(a, 'a')
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 1)
  await f.pair(other, 'a')
  await f.gateway.receive(f.message('a'))
  assert.equal(a.c.status().status, 'replaced')
  assert.equal(a.received.length, 1)
  assert.equal(other.received.length, 1)
  const saved = JSON.parse(await readFile(a.file, 'utf8'))
  assert.equal(saved.replaced, true)
  assert.equal(saved.token, undefined)
  await a.c.start({ onMessage: (msg) => a.received.push(msg) })
  await f.gateway.receive(f.message('a'))
  assert.equal(other.received.length, 2)
  assert.equal(f.gateway.status().onlineUsers, 1)
})

test('cancelled or mismatching browser login leaves the original route and credentials usable', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    wrong = await f.client('a', 'wrong')
  await f.pair(a, 'a')
  assert.equal((await f.finish(wrong, 'b')).status, 400)
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 1)
  assert.equal(wrong.received.length, 0)
  const cancel = await f.client('a', 'cancel')
  assert.equal((await f.finish(cancel, 'a', true)).status, 400)
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length, 2)
  assert.equal(a.c.status().status, 'connected')
  assert.equal(cancel.c.status().status, 'cancelled')
})

test('concurrent successful logins have one final route and revoked devices cannot reply', async (t) => {
  const f = await fixture(t),
    a = await f.client('a'),
    b = await f.client('a', 'new')
  await Promise.all([f.finish(a, 'a'), f.finish(b, 'a')])
  assert.equal(f.gateway.status().boundUsers, 1)
  assert.equal(f.gateway.status().onlineUsers, 1)
  await f.gateway.receive(f.message('a'))
  assert.equal(a.received.length + b.received.length, 1)
  assert.deepEqual([a.c.status().status, b.c.status().status].sort(), ['connected', 'replaced'])
})

test('Renderer text deltas cross real relay sockets into the real AI Card API adapter; Done follows final delivery', async (t) => {
  const f = await fixture(t),
    api = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://api.dingtalk.com/')) return originalFetch(url, options)
    const body = JSON.parse(options.body)
    api.push({ path: new URL(url).pathname, body })
    if (String(url).endsWith('/deliver'))
      return Response.json({ success: true, result: [{ spaceType: 'IM_GROUP', spaceId: 'group', success: true }] })
    return new Response(
      JSON.stringify(String(url).includes('accessToken') ? { accessToken: 'test-token', expireIn: 7200 } : {}),
      { status: 200 },
    )
  })
  const robot = createRobotOperations({
    clientId: 'fixture',
    clientSecret: 'fixture-secret',
    corpId: 'corp',
    publicOrigin: 'http://127.0.0.1',
    stateDirectory: f.dir,
  })
  t.after(() => robot.diagnostics.close())
  f.opts.operation = robot.operation
  const events = []
  const a = await f.client('a', 'streaming', async (msg, c) => {
    const renderer = new Renderer({
      config: {
        replyMode: { direct: 'aicard', group: 'aicard' },
        streaming: { enabled: true, throttleMs: 1, maxCardChars: 15000 },
        asyncMode: false,
        emotionFirstResponse: true,
      },
      outbound: {
        sendText: async () => assert.fail('unexpected fallback'),
        sendMarkdown: async () => assert.fail('unexpected fallback'),
      },
      emotion: {
        recall: (id, conversation) => c.emotion('recall', id, conversation),
        done: (id, conversation) => c.emotion('done', id, conversation),
      },
      createCard: (target, origin, mentionSender) => c.createCard(target, origin.sessionWebhook, mentionSender),
      log() {},
      observe: (name) => events.push(name),
    })
    void c.emotion('add', msg.msgId, msg.conversationId)
    const settled = renderer.onInbound('session', msg)
    renderer.onAssistantStream(
      { id: 'session' },
      { type: 'chunk', revision: 1, chunk: { type: 'text-delta', text: 'first' } },
    )
    renderer.onAssistantStream(
      { id: 'session' },
      { type: 'chunk', revision: 1, chunk: { type: 'text-delta', text: 'duplicate' } },
    )
    for (let i = 0; i < 100 && !api.some((x) => x.path.endsWith('/streaming')); i++)
      await new Promise((r) => setTimeout(r, 5))
    assert.ok(api.some((x) => x.path.endsWith('/streaming') && !x.body.isFinalize))
    renderer.onSessionEvent(
      { id: 'session' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'finished' }] } } },
    )
    renderer.onSessionEvent({ id: 'session' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settled
  })
  await f.pair(a, 'a')
  await f.gateway.receive(
    f.message('a', 'query', { conversationType: 'group', conversationId: 'group', senderNick: '测试员工' }),
  )
  assert.ok(events.includes('renderer.text-delta'))
  assert.equal(events.filter((x) => x === 'renderer.agent-stream').length, 1)
  const deliveries = api.filter((x) => x.path.endsWith('/deliver'))
  assert.deepEqual(
    deliveries.map((x) => x.body.userIdType),
    [1],
  )
  assert.deepEqual(
    deliveries.map((x) => x.body.imGroupOpenDeliverModel.atUserIds),
    [{ a: '测试员工' }],
  )
  assert.equal(api.find((x) => x.body.cardTemplateId).body.cardData.cardParamMap.msgContent, '@测试员工')
  const frames = api.filter((x) => x.path.endsWith('/streaming'))
  assert.ok(frames.every((x) => x.body.content.startsWith('@测试员工\n\n')))
  assert.equal(frames.find((x) => x.body.isFinalize).body.content, '@测试员工\n\nfinished')
  assert.equal(
    api.find((x) => x.body.cardData?.cardParamMap?.flowStatus === '3').body.cardData.cardParamMap.msgContent,
    '@测试员工\n\nfinished',
  )
  assert.equal(api.at(-1).body.emotionName, '🥳 Done')
  assert.ok(
    api.findIndex((x) => x.body.emotionName === '🥳 Done') >
      api.findIndex((x) => x.body.cardData?.cardParamMap?.flowStatus === '3'),
  )
})
