import assert from 'node:assert/strict'
import test from 'node:test'

import { CardCapability, CardCapabilityError } from '../lib/aicard.js'
import { Renderer } from '../lib/renderer.js'

test('缺少 Card.Streaming.Write 时能力熔断并保留诊断信息', () => {
  const capability = new CardCapability()
  const error = new Error(
    'card PUT failed 403: Forbidden.AccessDenied.AccessTokenPermissionDenied [Card.Streaming.Write]',
  )

  assert.equal(capability.recordFailure(error), true)
  assert.equal(capability.available, false)
  assert.match(capability.reason ?? '', /Card\.Streaming\.Write/)
  assert.throws(() => capability.assertAvailable(), CardCapabilityError)
})

test('流式权限错误只尝试一次，本轮直接降级 markdown', async () => {
  const sent = []
  let streamCalls = 0
  let finishCalls = 0
  const card = {
    async stream() {
      streamCalls++
      throw new CardCapabilityError('missing Card.Streaming.Write')
    },
    async finish() {
      finishCalls++
    },
    async fail() {
      finishCalls++
    },
  }
  const renderer = new Renderer({
    config: {
      replyMode: { direct: 'aicard', group: 'aicard' },
      streaming: { enabled: true, throttleMs: 1 },
      asyncMode: false,
      ackText: 'ack',
      markdownTitle: 'DSH',
      emotionFirstResponse: false,
    },
    outbound: {
      async sendMarkdown(_webhook, _title, text) {
        sent.push(text)
        return true
      },
      async sendText(_webhook, text) {
        sent.push(text)
        return true
      },
    },
    emotion: { async recall() {} },
    async createCard() {
      return card
    },
    log() {},
  })
  const msg = {
    msgId: 'm1',
    conversationId: 'c1',
    conversationType: 'direct',
    senderStaffId: 'u1',
    senderNick: 'Raph',
    text: 'hello',
    createAt: '1',
    sessionWebhook: 'https://example.test',
  }
  const settled = renderer.onInbound('s1', msg)
  renderer.onSessionEvent(
    { id: 's1' },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '第一段' } } },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  renderer.onSessionEvent(
    { id: 's1' },
    { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '第二段' } } },
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  renderer.onSessionEvent(
    { id: 's1' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终答案' }] } } },
  )
  renderer.onSessionEvent({ id: 's1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await settled
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(streamCalls, 1)
  assert.equal(finishCalls, 0)
  assert.deepEqual(sent, ['最终答案'])
})

test('目标群明确拒收才回退；缺少目标回执或超时只更新原卡，不标 Done', async (t) => {
  const { AICard } = await import('../lib/aicard.js')
  const { DeliveryOutcomeUnknown } = await import('../lib/errors.js')
  const target = { type: 'group', openConversationId: 'g' }
  const opts = { target, token: async () => 'fixture', robotCode: 'bot', log() {} }
  let receipt
  let deliveries = 0
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (!url.endsWith('/deliver')) return Response.json({})
    deliveries++
    if (receipt instanceof Error) throw receipt
    return Response.json(receipt)
  })
  for (receipt of [
    { success: false },
    { success: true, result: [{ spaceType: 'IM_GROUP', spaceId: 'g', success: false }] },
  ])
    assert.equal(await AICard.create(opts), null)
  for (receipt of [
    {},
    { result: [{ spaceType: 'IM_GROUP', spaceId: 'other', success: true }] },
    new Error('timeout'),
  ]) {
    const card = await AICard.create(opts)
    assert.ok(card)
    await assert.rejects(card.finish('reply'), DeliveryOutcomeUnknown)
  }
  assert.equal(deliveries, 5)
})
