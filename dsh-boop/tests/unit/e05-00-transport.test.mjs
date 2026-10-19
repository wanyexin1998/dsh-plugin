#!/usr/bin/env node
/**
 * E05-00 · real transport contract, offline (no external service needed).
 *
 * A local stub speaks the OpenAI-compatible wire so the client's parsing,
 * error-taxonomy, credential-reference and cancellation behavior are exercised
 * without the user's GPU service. The LIVE gold probe is
 * tests/host/e05-00-real-gold.test.mjs (opt-in, real service).
 *
 * Run: node --test tests/unit/e05-00-transport.test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { DEFAULT_MODEL_CONFIG } from '../../src/host/model/qwen-adapter.ts'
import { NO_CREDENTIAL, QwenTransportError, createQwenClient } from '../../src/host/model/qwen-client.ts'

/** One stub server; each test starts it on an ephemeral loopback port. */
async function withStub(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function config(port, overrides = {}) {
  return {
    ...DEFAULT_MODEL_CONFIG,
    providerId: 'stub-local',
    modelId: 'test-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    credentialRef: NO_CREDENTIAL,
    declaredContext: '196k',
    quantization: '4bit',
    ...overrides,
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => resolve(body))
  })
}

test('E05-00 the served model id and context integer are read from the service, never guessed', async () => {
  await withStub(
    (request, response) => {
      assert.equal(request.url, '/v1/models')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'test-model', max_model_len: 196608, root: './Test-AWQ-INT4' }] }))
    },
    async (port) => {
      const client = createQwenClient(config(port))
      const listing = await client.listModels()
      assert.deepEqual(listing.ids, ['test-model'])
      assert.equal(listing.maxModelLen, 196608)
      assert.equal(listing.root, './Test-AWQ-INT4')
    },
  )
})

test('E05-00 a model id the service does not serve is unavailable, never renamed to a model-card name', async () => {
  await withStub(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'Qwen3.8-27B', max_model_len: 196608 }] }))
    },
    async (port) => {
      const client = createQwenClient(config(port))
      await assert.rejects(() => client.listModels(), (error) => {
        assert.ok(error instanceof QwenTransportError)
        assert.equal(error.code, 'MODEL_UNAVAILABLE')
        assert.match(error.message, /not served/u)
        return true
      })
    },
  )
})

test('E05-00 reasoning is separated from final text and usage is parsed', async () => {
  let seenAuth = 'none'
  await withStub(
    async (request, response) => {
      seenAuth = request.headers.authorization ?? 'none'
      const body = JSON.parse(await readBody(request))
      assert.equal(body.model, 'test-model')
      assert.equal(body.max_tokens, 128)
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '最终答案', reasoning: '内部思考' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
      )
    },
    async (port) => {
      const client = createQwenClient(config(port))
      const result = await client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 128,
        disableThinking: true,
      })
      assert.equal(result.content, '最终答案')
      assert.equal(result.reasoning, '内部思考')
      assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 5, totalTokens: 17 })
      assert.equal(result.finishReason, 'stop')
      assert.equal(seenAuth, 'none', 'credential: none must send no Authorization header')
    },
  )
})

test('E05-00 tool calls are parsed as proposals; BOOP never executes them from transport code', async () => {
  await withStub(
    async (request, response) => {
      const body = JSON.parse(await readBody(request))
      assert.ok(Array.isArray(body.tools), 'tools must be forwarded')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"你好 🐳"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
      )
    },
    async (port) => {
      const client = createQwenClient(config(port))
      const result = await client.chat({
        messages: [{ role: 'user', content: 'call echo' }],
        tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }],
        toolChoice: 'auto',
        maxTokens: 128,
      })
      assert.equal(result.toolCalls.length, 1)
      assert.equal(result.toolCalls[0].function.name, 'echo')
      assert.equal(JSON.parse(result.toolCalls[0].function.arguments).text, '你好 🐳')
      assert.equal(result.content, '')
    },
  )
})

test('E05-00 service errors keep a useful taxonomy and never trigger a fallback', async () => {
  await withStub(
    async (request, response) => {
      const body = JSON.parse(await readBody(request))
      if (body.model === 'missing-model') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'The model does not exist.', type: 'NotFoundError' } }))
        return
      }
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'maximum context length is 4096 tokens', type: 'BadRequestError' } }))
    },
    async (port) => {
      const missing = createQwenClient(config(port, { modelId: 'missing-model' }))
      await assert.rejects(() => missing.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 }), (error) => {
        assert.ok(error instanceof QwenTransportError)
        assert.equal(error.code, 'MODEL_UNAVAILABLE')
        assert.equal(error.status, 404)
        return true
      })
      const bad = createQwenClient(config(port))
      await assert.rejects(() => bad.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 }), (error) => {
        assert.ok(error instanceof QwenTransportError)
        assert.equal(error.code, 'MODEL_BAD_REQUEST')
        assert.equal(error.status, 400)
        assert.match(error.message, /maximum context length/u)
        return true
      })
    },
  )
})

test('E05-00 a raw secret in the config is refused; only "none" or env: references are accepted', async () => {
  const client = createQwenClient(config(1, { credentialRef: 'sk-plain-text-secret' }))
  await assert.rejects(() => client.listModels(), (error) => {
    assert.ok(error instanceof QwenTransportError)
    assert.equal(error.code, 'MODEL_UNAVAILABLE')
    assert.match(error.message, /unsupported credential reference/u)
    return true
  })
})

test('E05-00 cancellation settles on the client after the first content chunks', async () => {
  await withStub(
    async (request, response) => {
      const body = JSON.parse(await readBody(request))
      assert.equal(body.stream, true)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"第二"}}]}\n\n')
      response.write('data: {"choices":[{"delta":{"content":"第三"}}]}\n\n')
      // Keep the connection open; the client is expected to abort.
    },
    async (port) => {
      const client = createQwenClient(config(port))
      const evidence = await client.streamAndCancel({
        messages: [{ role: 'user', content: 'write' }],
        maxTokens: 64,
        disableThinking: true,
      })
      assert.equal(evidence.aborted, true)
      assert.ok(evidence.chunks >= 1)
      assert.ok(evidence.contentPreview.includes('第一'))
    },
  )
})
