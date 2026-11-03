import assert from 'node:assert/strict'
import { test } from 'node:test'
import { messageIdentity, sameIdentity } from '../lib/identity.js'

test('message identity uses enterprise and staff ID, never nicknames or encrypted sender IDs', () => {
  const a = messageIdentity({ senderCorpId: 'ding-a', senderStaffId: 'user-a' })
  assert.deepEqual(a, { corpId: 'ding-a', userId: 'user-a' })
  assert.equal(sameIdentity(a, { corpId: 'ding-a', userId: 'user-a' }), true)
  assert.equal(sameIdentity(a, { corpId: 'ding-b', userId: 'user-a' }), false)
  assert.equal(sameIdentity(a, { corpId: 'ding-a', userId: 'user-b' }), false)
  assert.equal(messageIdentity({ senderCorpId: 'ding-a', senderId: 'user-a', senderNick: 'user-a' }), undefined)
})

test('incomplete events never inherit the browser account or an unverified robot enterprise', () => {
  for (const value of [
    undefined,
    null,
    {},
    { senderStaffId: 'u', chatbotCorpId: 'ding-a' },
    { senderCorpId: ['ding-a'], senderStaffId: 'u' },
    { senderCorpId: 'ding-a', senderStaffId: '' },
  ]) {
    assert.equal(messageIdentity(value), undefined)
  }
  assert.equal(sameIdentity(undefined, undefined), false)
})
