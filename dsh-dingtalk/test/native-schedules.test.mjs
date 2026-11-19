import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { NativeSchedules } from '../lib/native-schedules.js'

async function setup(t) {
  const state = await realpath(await mkdtemp(join(tmpdir(), 'native-schedule-test-')))
  t.after(() => rm(state, { force: true, recursive: true }))
  const id = randomUUID()
  const agent = { id }
  const sent = []
  let route = 'original-dm'
  let authority = {
    identity: { corpId: 'corp', userId: 'employee' },
    profile: 'profile',
    bindingId: 'device',
    signal: new AbortController().signal,
  }
  let query
  let adapter
  const manager = () => {
    const instance = new NativeSchedules({
      state,
      authority: () => authority,
      ownsSession: (session, origin) => session === id && origin.conversation === route,
      allowsAgent: (subject) => subject === agent,
      restore: async () => agent,
      query: (name, authorized) => (name === 'mcp__doris__exec_query' ? authorized : undefined),
      configure: (_agent, grant) => {
        query = grant
      },
      send: async (binding, text) => {
        sent.push({ binding, text })
      },
      log: () => {},
    })
    instance.install({
      registerManagedDelivery: (name, handlers) => {
        adapter = { ...handlers, name }
        return () => {}
      },
    })
    return instance
  }
  const create = (instance) => {
    const input = { id: randomUUID(), source: { kind: 'user' } }
    instance.inboundMessage(agent, input.id, route, state, authority, '每天早上九点查订单')
    assert.equal(adapter.select(agent), undefined)
    instance.claim(agent, input, 1)
    assert.equal(instance.creationTiming(agent), 'either')
    const task = {
      sessionId: id,
      record: { id: 'schedule-' + randomUUID() },
      managed: { provider: adapter.name, payload: adapter.select(agent) },
    }
    instance.event(id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    assert.equal(instance.creationTiming(agent), undefined)
    return task
  }
  return {
    state,
    sent,
    manager,
    create,
    agent,
    adapter: () => adapter,
    query: () => query,
    authority: () => authority,
    changeRoute: () => {
      route = 'other-chat'
    },
    changeAuthority: () => {
      authority = { ...authority, bindingId: 'other-device' }
    },
  }
}

const first = '2099-12-31T04:00:00.000Z'
const claim = async (fixture, manager, task, turn) => {
  const adapter = fixture.adapter()
  const input = { id: randomUUID(), source: { kind: 'schedule', managedProvider: adapter.name } }
  const agent = await adapter.resolve(task)
  adapter.track(agent, task, first, input)
  manager.claim(agent, input, turn)
  return { input, agent }
}

test('a private native task survives restart and sends only the report from its own turn', async (t) => {
  const f = await setup(t)
  const task = f.create(f.manager())
  const restarted = f.manager()
  const { input, agent } = await claim(f, restarted, task, 2)
  assert.equal(restarted.rendersSeparately(agent.id), true)
  assert.equal(f.adapter().accepts(agent, input), true)
  assert.equal(f.query()('mcp__doris__exec_query'), f.authority())
  assert.equal(f.query()('mcp__doris__write'), undefined)
  const source = join(f.state, 'orders.txt')
  await writeFile(source, 'latest orders: 12')
  const latest = await readFile(source, 'utf8')
  const report = '今日经营日报\n' + latest
  await writeFile(join(f.state, 'report.txt'), report)
  restarted.event(agent.id, {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'text', text: 'preliminary' }, { type: 'tool-call' }] } },
  })
  restarted.event(agent.id, {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: 'unrelated earlier response' }] } },
  })
  restarted.event(agent.id, {
    type: 'assistant/message',
    data: { turn: 2, message: { content: [{ type: 'text', text: report }] } },
  })
  assert.equal(restarted.event(agent.id, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }), true)
  await restarted.drain()
  assert.deepEqual(f.sent, [{ binding: f.authority(), text: '定时任务结果\n' + report }])
  const replay = f.manager()
  const repeated = await claim(f, replay, task, 3)
  assert.equal(f.adapter().accepts(agent, repeated.input), false)
  replay.event(agent.id, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await replay.drain()
  assert.equal(f.sent.length, 1)
})

test('mixed input, a different original chat, and a rebound device cannot inherit delivery', async (t) => {
  const f = await setup(t)
  const manager = f.manager()
  const task = f.create(manager)
  const { input, agent } = await claim(f, manager, task, 2)
  assert.equal(f.adapter().accepts({ ...agent }, input), false)
  manager.claim(agent, { id: randomUUID(), source: { kind: 'user' } }, 2)
  assert.equal(f.adapter().accepts(agent, input), false)
  manager.event(agent.id, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await manager.drain()
  assert.equal(f.sent.length, 0)
  f.changeRoute()
  await assert.rejects(f.adapter().resolve(task), /scheduled_origin_changed/)

  const bound = f.create(manager)
  const running = await claim(f, manager, bound, 3)
  f.changeAuthority()
  assert.equal(f.adapter().accepts(agent, running.input), false)
  assert.equal(f.query()('mcp__doris__exec_query'), undefined)
  manager.event(agent.id, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await manager.drain()
  assert.equal(f.sent.length, 0)
})

test('timing comes from the verified input and ignores quotes and per-run wording', async (t) => {
  const f = await setup(t)
  const manager = f.manager()
  const inputs = [
    ['创建成功后 3 分钟触发一次。到点只提醒我「请每天核对订单」', 'once'],
    ['7 分钟后执行一次，到点查最新订单生成报告', 'once'],
    ['三分钟后提醒我看订单', 'once'],
    ['每隔 3 分钟检查一次订单', 'either'],
    ['每两天检查一次订单', 'either'],
    ['每分钟运行一次', 'either'],
    ['每天早上 9 点查账，每次只发送一次', 'either'],
    ['把「只执行一次」写进报告', 'either'],
  ]
  for (const [index, [text, timing]] of inputs.entries()) {
    const input = { id: randomUUID(), source: { kind: 'user' } }
    const { agent } = f
    const turn = index + 1
    manager.inboundMessage(agent, input.id, 'original-dm', f.state, f.authority(), text)
    assert.equal(manager.creationTiming(agent), undefined)
    manager.claim(agent, input, turn)
    assert.equal(manager.creationTiming(agent), timing, text)
    manager.event(agent.id, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    assert.equal(manager.creationTiming(agent), undefined)
  }
})
