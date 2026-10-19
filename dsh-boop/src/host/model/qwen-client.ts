/**
 * Real transport for the user's self-hosted Qwen service (E05-00 step 3 / G02).
 *
 * This file is TRANSPORT ONLY: OpenAI-compatible `/v1/chat/completions`,
 * streaming, reasoning separation, tool calls and usage accounting. Capability
 * POLICY lives in `qwen-adapter.ts` (`evaluateCapabilities`), and the probe
 * ladder lives in `qwen-probe.ts`.
 *
 * Frozen rules this transport keeps:
 *  - exact configured values only: base URL, model id and credential reference
 *    come from the user (or an explicit `none` marker when the service needs no
 *    credential); nothing is guessed;
 *  - 196k is a label: the caller must pass the server-reported
 *    `contextWindowTokens`, never a model-name-derived number;
 *  - no external fallback: any failure surfaces as MODEL_UNAVAILABLE and the
 *    caller stays read-only; BOOP never retries another provider;
 *  - reasoning content is separated from final text, so BOOP never treats a
 *    thinking trace as an answer or as a command.
 */

import {
  ModelConfigurationError,
  assertConfigured,
  type QwenModelConfig,
} from './qwen-adapter.ts'

/** Explicit marker for a service that requires no credential (IN-02 = 无凭证). */
export const NO_CREDENTIAL = 'none'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: unknown[]
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  /** OpenAI-compatible structured output (e.g. json_schema). */
  responseFormat?: unknown
  maxTokens: number
  temperature?: number
  /** Qwen/VLLM chat-template switch: separates reasoning from final text. */
  disableThinking?: boolean
  signal?: AbortSignal
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatResult {
  content: string
  reasoning: string | null
  toolCalls: ToolCall[]
  finishReason: string | null
  usage: TokenUsage
  elapsedMs: number
}

export interface ModelListing {
  ids: string[]
  /** Server-reported integer, only for the configured model id. */
  maxModelLen: number | null
  root: string | null
}

export interface StreamEvidence {
  /** True when the caller's abort took effect on the client side. */
  aborted: boolean
  chunks: number
  firstChunkMs: number | null
  contentPreview: string
}

export type QwenTransportErrorCode =
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_BAD_REQUEST'
  | 'CAPABILITY_UNAVAILABLE'

export class QwenTransportError extends Error {
  readonly code: QwenTransportErrorCode
  readonly status: number
  readonly detail: string

  constructor(code: QwenTransportErrorCode, message: string, status = 0, detail = '') {
    super(message)
    this.name = 'QwenTransportError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export interface QwenClient {
  readonly config: QwenModelConfig
  listModels(signal?: AbortSignal): Promise<ModelListing>
  chat(request: ChatRequest): Promise<ChatResult>
  /** Streams one short answer and aborts after the first content chunks. */
  streamAndCancel(request: ChatRequest): Promise<StreamEvidence>
}

function authHeaders(config: QwenModelConfig): Record<string, string> {
  const ref = config.credentialRef
  if (ref === null || ref === NO_CREDENTIAL) return {}
  // A credential REFERENCE, not the secret itself: `env:NAME` is resolved from
  // the host process environment; a raw value is refused so secrets never live
  // in the plugin config.
  if (ref.startsWith('env:')) {
    const value = process.env[ref.slice(4)]
    if (!value) throw new QwenTransportError('MODEL_UNAVAILABLE', `credential ${ref} is not available in the environment`)
    return { authorization: `Bearer ${value}` }
  }
  throw new QwenTransportError('MODEL_UNAVAILABLE', `unsupported credential reference ${JSON.stringify(ref)}; use "none" or "env:NAME"`)
}

function endpoint(config: QwenModelConfig): string {
  if (!config.baseUrl) throw new QwenTransportError('MODEL_UNAVAILABLE', 'model base URL is not configured')
  return config.baseUrl.replace(/\/+$/u, '')
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const absorb = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', absorb, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', absorb)
    },
  }
}

async function errorOf(response: Response): Promise<QwenTransportError> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    /* keep empty */
  }
  let detail = text
  let type = ''
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } | string }
    const error = parsed.error
    if (typeof error === 'string') detail = error
    else if (error) {
      detail = error.message ?? text
      type = error.type ?? ''
    }
  } catch {
    /* non-JSON error body */
  }
  const kind = type === 'NotFoundError' || response.status === 404
    ? 'MODEL_UNAVAILABLE'
    : response.status >= 400 && response.status < 500
      ? 'MODEL_BAD_REQUEST'
      : 'MODEL_UNAVAILABLE'
  return new QwenTransportError(kind, `qwen service answered ${response.status}: ${detail}`, response.status, detail)
}

function contentOf(message: Record<string, unknown> | undefined): string {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? String((part as { text: string }).text) : ''))
      .join('')
  }
  return ''
}

export function createQwenClient(config: QwenModelConfig): QwenClient {
  // A service explicitly declared as credential-free is allowed; everything
  // else must be configured, never inferred.
  assertConfigured(config)
  const base = endpoint(config)

  return {
    config,

    async listModels(signal?: AbortSignal): Promise<ModelListing> {
      const guard = withTimeout(signal, 30_000)
      try {
        const response = await fetch(`${base}/models`, { headers: authHeaders(config), signal: guard.signal })
        if (!response.ok) throw await errorOf(response)
        const body = (await response.json()) as { data?: Array<{ id?: string; max_model_len?: number; root?: string }> }
        const data = Array.isArray(body.data) ? body.data : []
        const ids = data.map((entry) => String(entry.id ?? '')).filter((id) => id !== '')
        const own = data.find((entry) => String(entry.id ?? '') === config.modelId)
        if (!own) {
          throw new QwenTransportError(
            'MODEL_UNAVAILABLE',
            `configured model id ${JSON.stringify(config.modelId)} is not served (served: ${ids.join(', ') || 'none'})`,
          )
        }
        return {
          ids,
          maxModelLen: typeof own.max_model_len === 'number' ? own.max_model_len : null,
          root: typeof own.root === 'string' ? own.root : null,
        }
      } finally {
        guard.dispose()
      }
    },

    async chat(request: ChatRequest): Promise<ChatResult> {
      if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
        throw new ModelConfigurationError('maxTokens must be a positive integer', 'CAPABILITY_UNAVAILABLE')
      }
      const body: Record<string, unknown> = {
        model: config.modelId,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: false,
      }
      if (request.tools) body.tools = request.tools
      if (request.toolChoice) body.tool_choice = request.toolChoice
      if (request.responseFormat) body.response_format = request.responseFormat
      if (request.temperature !== undefined) body.temperature = request.temperature
      if (request.disableThinking) body.chat_template_kwargs = { enable_thinking: false }

      const guard = withTimeout(request.signal, 180_000)
      const startedAt = Date.now()
      try {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(config) },
          body: JSON.stringify(body),
          signal: guard.signal,
        })
        if (!response.ok) throw await errorOf(response)
        const json = (await response.json()) as {
          choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
        }
        const choice = json.choices?.[0]
        const message = choice?.message ?? {}
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        const toolCalls: ToolCall[] = rawCalls.map((call) => {
          const record = call as { id?: string; function?: { name?: string; arguments?: string } }
          return {
            id: String(record.id ?? ''),
            type: 'function',
            function: {
              name: String(record.function?.name ?? ''),
              arguments: String(record.function?.arguments ?? ''),
            },
          }
        })
        const reasoning = typeof message.reasoning === 'string' && message.reasoning.length > 0 ? message.reasoning : null
        return {
          content: contentOf(message),
          reasoning,
          toolCalls,
          finishReason: choice?.finish_reason ?? null,
          usage: {
            promptTokens: Number(json.usage?.prompt_tokens ?? 0),
            completionTokens: Number(json.usage?.completion_tokens ?? 0),
            totalTokens: Number(json.usage?.total_tokens ?? 0),
          },
          elapsedMs: Date.now() - startedAt,
        }
      } catch (error) {
        if (error instanceof QwenTransportError || error instanceof ModelConfigurationError) throw error
        if ((error as { name?: string }).name === 'AbortError') {
          throw new QwenTransportError('MODEL_UNAVAILABLE', `qwen request was aborted after ${Date.now() - startedAt}ms`, 0, 'timeout-or-cancel')
        }
        throw new QwenTransportError('MODEL_UNAVAILABLE', `qwen request failed: ${String(error)}`)
      } finally {
        guard.dispose()
      }
    },

    async streamAndCancel(request: ChatRequest): Promise<StreamEvidence> {
      const controller = new AbortController()
      const guard = withTimeout(controller.signal, 60_000)
      const startedAt = Date.now()
      let chunks = 0
      let firstChunkMs: number | null = null
      let contentPreview = ''
      try {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(config) },
          body: JSON.stringify({
            model: config.modelId,
            messages: request.messages,
            max_tokens: request.maxTokens,
            stream: true,
            ...(request.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          }),
          signal: guard.signal,
        })
        if (!response.ok) throw await errorOf(response)
        const body = response.body
        if (!body) throw new QwenTransportError('MODEL_UNAVAILABLE', 'qwen stream had no body')
        const reader = body.getReader()
        const decoder = new TextDecoder()
        // Read a bounded number of chunks; a stalled stream must not block the
        // caller forever (the whole point of the cancel probe).
        const readWithDeadline = async (ms: number): Promise<{ done: boolean; value?: Uint8Array }> => {
          let timer: ReturnType<typeof setTimeout> | null = null
          try {
            return (await Promise.race([
              reader.read(),
              new Promise<{ done: boolean; value?: undefined }>((resolve) => {
                timer = setTimeout(() => resolve({ done: true }), ms)
              }),
            ])) as { done: boolean; value?: Uint8Array }
          } finally {
            if (timer !== null) clearTimeout(timer)
          }
        }
        while (chunks < 3) {
          const { done, value } = await readWithDeadline(2_000)
          if (done || value === undefined) break
          chunks += 1
          if (firstChunkMs === null) firstChunkMs = Date.now() - startedAt
          const text = decoder.decode(value, { stream: true })
          const match = /"content":"((?:[^"\\]|\\.)*)"/u.exec(text)
          if (match) contentPreview += JSON.parse(`"${match[1]}"`) as string
        }
        controller.abort()
        try {
          await reader.read()
        } catch {
          /* expected: the abort settles the reader */
        }
        return { aborted: true, chunks, firstChunkMs, contentPreview: contentPreview.slice(0, 80) }
      } finally {
        guard.dispose()
      }
    },
  }
}
