import test from 'node:test'
import assert from 'node:assert/strict'
import { createRobotOperations } from '../lib/relay/robot.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('同群交错完成只提醒原提问人，忽略席位传来的其他 ID，进度和私聊不提醒', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'group-mention-'))
  const bodies = []
  const { operation, diagnostics } = createRobotOperations({ corpId: 'corp', stateDirectory: dir })
  t.after(async () => {
    diagnostics.close()
    await rm(dir, { recursive: true, force: true })
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('accessToken')) return Response.json({ accessToken: 'fixture', expireIn: 7200 })
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (url.endsWith('/deliver'))
      return Response.json({
        success: true,
        result: [
          {
            spaceType: body.imGroupOpenDeliverModel ? 'IM_GROUP' : 'IM_ROBOT',
            spaceId: body.openSpaceId.split('.').pop(),
            success: true,
          },
        ],
      })
    return Response.json({ errcode: 0 })
  })
  const a = {
    conversationId: 'group',
    senderCorpId: 'corp',
    conversationType: 'group',
    senderStaffId: 'a',
    sessionWebhook: 'https://example.test/a',
  }
  const b = { ...a, senderStaffId: 'b', sessionWebhook: 'https://example.test/b' }
  for (const [msg, method, final] of [
    [a, 'text', false],
    [b, 'markdown', true],
    [a, 'text', true],
    [{ ...a, conversationType: 'direct' }, 'text', true],
  ]) {
    assert.equal(await operation(msg, method, { text: 'reply', final, atUserIds: ['other'], isAtAll: true }), true)
  }
  assert.deepEqual(
    bodies.map((b) => b.at),
    [undefined, { atUserIds: ['b'], isAtAll: false }, { atUserIds: ['a'], isAtAll: false }, undefined],
  )
  for (const [msg, mentionSender] of [
    [{ ...b, senderNick: '乙' }, true],
    [{ ...a, senderNick: '甲' }, true],
    [a, false],
    [{ ...b, conversationType: 'direct' }, true],
  ]) {
    assert.ok(await operation(msg, 'card.create', { mentionSender, atUserIds: { other: '其他人' } }))
  }
  const cards = bodies.filter((body) => body.openSpaceId)
  assert.deepEqual(
    bodies.filter((body) => body.cardTemplateId).map((body) => body.cardData.cardParamMap.msgContent),
    ['@乙', '@甲', undefined, undefined],
  )
  assert.deepEqual(
    cards.map((body) => body.imGroupOpenDeliverModel?.atUserIds),
    [{ b: '乙' }, { a: '甲' }, undefined, undefined],
  )
  assert.ok(cards[3].imRobotOpenDeliverModel)
})
