import assert from 'node:assert/strict'
import test from 'node:test'

import { Outbound } from '../lib/outbound.js'

async function captureMarkdown(text, title = 'DSH', receipt = { errcode: 0 }) {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return { ok: true, json: async () => ({ accessToken: 'redacted', expireIn: 7200 }) }
    }
    requests.push({ url, body: JSON.parse(init.body) })
    return Response.json(receipt)
  }

  try {
    const outbound = new Outbound({ clientId: 'client-id', clientSecret: 'client-secret' }, () => {})
    const sent = await outbound.sendMarkdown('https://example.test/session', title, text)
    return { sent, body: requests[0]?.body }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('Markdown 使用真实正文作为会话列表摘要', async () => {
  const text = '✅ 已重开会话——上下文已清空，直接说新任务吧。'

  assert.deepEqual(await captureMarkdown(text), {
    sent: true,
    body: {
      msgtype: 'markdown',
      markdown: { title: text, text },
    },
  })
})

test('Markdown 会话摘要移除首行的展示语法', async () => {
  const text = '**状态**\n- 会话：空闲\n- 模型：provider/model'

  assert.equal((await captureMarkdown(text)).body.markdown.title, '状态')
})

test('Markdown 会话摘要保留正文中的字面符号', async () => {
  const text = '路径 `~/.dsh/foo_bar` 保持不变'

  assert.equal((await captureMarkdown(text)).body.markdown.title, text)
})

test('业务拒收和不完整回执不会报告送达', async () => {
  for (const receipt of [{ errcode: 310000 }, {}])
    assert.equal((await captureMarkdown('hi', 'DSH', receipt)).sent, false)
})
