import { Renderer } from '../lib/renderer.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Emotion } from '../lib/emotion.js'
import { FeedbackDiagnostics } from '../lib/feedback.js'

test('Thinking is ordered before recall and Done; API failures produce only safe diagnostics', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dt-feedback-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const diagnostics = new FeedbackDiagnostics(join(dir, 'feedback.json'))
  t.after(() => diagnostics.close())
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    await new Promise((r) => setTimeout(r, 5))
    return new Response('{}', { status: 200 })
  })
  const emotion = new Emotion(
    async () => 'private-token',
    'private-robot',
    () => {},
    diagnostics.observe,
  )
  emotion.add('private-message', 'private-conversation')
  await emotion.recall('private-message', 'private-conversation')
  await emotion.done('private-message', 'private-conversation')
  assert.deepEqual(
    calls.map((c) => [c.url.split('/').at(-1), c.body.emotionName]),
    [
      ['reply', '🤔思考中'],
      ['recall', '🤔思考中'],
      ['reply', '🥳 Done'],
    ],
  )
  t.mock.method(globalThis, 'fetch', async () => new Response('secret body private-user', { status: 403 }))
  await emotion.done('private-message', 'private-conversation')
  diagnostics.close()
  const text = await readFile(join(dir, 'feedback.json'), 'utf8')
  assert.doesNotMatch(text, /private-|secret body/)
  assert.equal(JSON.parse(text).events['emotion.done'].failure, 1)
})

test('Done is emitted only after successful delivery, never for error, cancellation or failed fallback', async () => {
  for (const [kind, delivered, expected] of [
    ['completed', true, 1],
    ['error', true, 0],
    ['aborted', true, 0],
    ['completed', false, 0],
  ]) {
    const actions = []
    const renderer = new Renderer({
      config: {
        replyMode: { direct: 'markdown', group: 'markdown' },
        streaming: { enabled: true, throttleMs: 1, maxCardChars: 15000 },
        asyncMode: false,
        emotionFirstResponse: true,
      },
      outbound: {
        sendText: async () => delivered,
        sendMarkdown: async () => {
          actions.push('reply')
          return delivered
        },
      },
      emotion: { recall: async () => actions.push('recall'), done: async () => actions.push('done') },
      createCard: async () => null,
      log() {},
    })
    const settled = renderer.onInbound('s', { msgId: 'm', conversationId: 'c', conversationType: 'direct' })
    renderer.onSessionEvent(
      { id: 's' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'result' }] } } },
    )
    renderer.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind } } })
    await settled
    assert.equal(actions.filter((x) => x === 'done').length, expected)
    if (expected) assert.deepEqual(actions, ['recall', 'reply', 'done'])
  }
})

test('final card waits for in-flight stream before finishing; no late delta overwrites Done', async () => {
  const actions = []
  let release
  const pending = new Promise((r) => (release = r))
  const renderer = new Renderer({
    config: {
      replyMode: { direct: 'aicard', group: 'aicard' },
      streaming: { enabled: true, throttleMs: 1, maxCardChars: 15000 },
      asyncMode: false,
      emotionFirstResponse: true,
    },
    outbound: { sendText: async () => false, sendMarkdown: async () => false },
    emotion: { recall: async () => {}, done: async () => actions.push('done') },
    createCard: async () => ({
      stream: async () => {
        actions.push('stream-start')
        await pending
        actions.push('stream-end')
      },
      finish: async () => actions.push('finish'),
    }),
    log() {},
  })
  const settled = renderer.onInbound('s', { msgId: 'm', conversationId: 'c', conversationType: 'direct' })
  renderer.onAssistantStream({ id: 's' }, { type: 'chunk', revision: 1, chunk: { type: 'text-delta', text: 'hello' } })
  for (let i = 0; i < 100 && !actions.length; i++) await new Promise((r) => setTimeout(r, 2))
  renderer.onAssistantStream({ id: 's' }, { type: 'chunk', revision: 2, chunk: { type: 'text-delta', text: ' world' } })
  renderer.onSessionEvent({ id: 's' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(actions, ['stream-start'])
  release()
  await settled
  assert.deepEqual(actions, ['stream-start', 'stream-end', 'finish', 'done'])
})
