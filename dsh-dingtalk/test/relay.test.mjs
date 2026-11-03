import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Gateway } from '../lib/relay/gateway.js'
import { RelayClient } from '../lib/relay/client.js'

async function fixture(t) {
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
      exchange: async (code) => ({ corpId: 'corp', userId: code }),
    },
    allowedCorpId: 'corp',
    allowedGroups: ['group'],
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
  async function client(user, suffix = user) {
    let identity = { corpId: 'corp', userId: user }
    const received = [],
      callbacks = []
    const file = join(dir, `${suffix}.json`)
    const c = new RelayClient(file, () => identity)
    clients.push(c)
    await c.start({
      onMessage: async (msg) => {
        received.push(msg)
        await c.operation(msg.sessionWebhook, 'text', { text: 'result' })
      },
      onCardCallback: (cb) => {
        callbacks.push(cb)
        return { handled: true }
      },
    })
    const pending = await c.connect(`ws://127.0.0.1:${port}/relay`)
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
  return { dir, opts, gateway, port, message, client, pair, finish, notices, operations }
}

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
