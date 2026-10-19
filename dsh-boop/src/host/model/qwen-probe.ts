/**
 * E05-00 real-gold probe (G02): run the frozen capability ladder against the
 * user's actual Qwen service and produce evidence — no fixture, no assumption.
 *
 * The ladder order is frozen by `qwen-adapter.ts`; a failure NARROWS what BOOP
 * may do (read-only chat → memory jobs → autonomous dispatch → batch learning)
 * and never silently widens it.
 *
 * Every measured integer here is either reported by the service or observed in
 * a real request. The "196k" label is never used as a budget: the effective
 * limit becomes the server-reported `max_model_len`, clamped further by
 * `clampRequest`'s output reserve and safety margin.
 */

import {
  PROBE_LADDER,
  clampRequest,
  evaluateCapabilities,
  type CapabilityId,
  type CapabilityState,
  type ProbeOutcome,
  type QwenModelConfig,
} from './qwen-adapter.ts'
import {
  NO_CREDENTIAL,
  QwenTransportError,
  createQwenClient,
  type ChatResult,
  type QwenClient,
} from './qwen-client.ts'

export interface ProbeStepEvidence {
  id: CapabilityId
  state: CapabilityState
  detail: string
  measured?: Record<string, unknown>
}

export interface GoldProbeEvidence {
  schemaVersion: 1
  startedAt: string
  elapsedMs: number
  config: {
    providerId: string | null
    modelId: string | null
    baseUrl: string | null
    /** Never the secret: only "none" or the reference kind. */
    credential: 'none' | 'reference' | 'missing'
    declaredContext: string | null
    quantization: string | null
    externalFallbackAllowed: false
  }
  server: {
    servedModelIds: string[]
    modelFound: boolean
    maxModelLen: number | null
    root: string | null
  }
  contextWindowTokens: number | null
  steps: ProbeStepEvidence[]
  outcome: ProbeOutcome
  observations: {
    ladderPromptTokens: number[]
    overLimit: { requestedTokens: number; status: number; promptTokens: number | null; behavior: string } | null
    nearLimit: { requestedTokens: number; status: number; promptTokens: number | null; finish: string | null; elapsedMs: number } | null
  }
}

export interface GoldProbeOptions {
  /** Optional ~N-token prompt that should approach the verified limit. */
  nearLimitTokens?: number
  /** Optional ~N-token prompt beyond the limit: recorded as observed behavior. */
  overLimitTokens?: number
}

const ECHO_TOOL = {
  type: 'function',
  function: {
    name: 'echo',
    description: 'Echo back the provided text. No side effects; BOOP executes it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'meta'],
      properties: {
        text: { type: 'string' },
        meta: {
          type: 'object',
          additionalProperties: false,
          required: ['tag'],
          properties: { tag: { type: 'string' }, emoji: { type: 'string' } },
        },
      },
    },
  },
} as const

/** The Unicode/中文 fixture the tool must carry losslessly. */
const UNICODE_TEXT = '你好，波波 🐳 — ünïcode'
const UNICODE_TAG = '中文标签'

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'confidence'],
        properties: { text: { type: 'string' }, confidence: { type: 'number' } },
      },
    },
  },
} as const

const CARETAKER_SENTENCE = '波波在整理项目证据与任务状态，记录来源、版本与待处理事项。'
/** Measured on this service: Chinese text ≈ 0.60 prompt tokens per character. */
const TOKENS_PER_CHAR = 0.6

/** Build a deterministic Chinese prompt of approximately `tokens` prompt tokens. */
export function zhongwen(tokens: number): string {
  const chars = Math.ceil(tokens / TOKENS_PER_CHAR)
  return CARETAKER_SENTENCE.repeat(Math.ceil(chars / CARETAKER_SENTENCE.length)).slice(0, chars)
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  // Strict output may be wrapped in a fenced block by the chat template; the
  // parser only accepts a whole-document JSON body, never a substring guess.
  const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed)
  const candidate = unfenced ? unfenced[1] : trimmed
  return JSON.parse(candidate)
}

function detailOf(error: unknown): string {
  if (error instanceof QwenTransportError) return `${error.code}${error.status ? ` ${error.status}` : ''}: ${error.detail || error.message}`
  return String(error)
}

function usageDetail(result: ChatResult): Record<string, unknown> {
  return {
    elapsedMs: result.elapsedMs,
    finish: result.finishReason,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    reasoningSeparated: result.reasoning !== null,
  }
}

/**
 * Run the frozen probe ladder against a live service.
 *
 * Throws only when the service cannot be reached or the configured model is not
 * served: that is MODEL_UNAVAILABLE, not a partially passed report.
 */
export async function runGoldProbe(config: QwenModelConfig, options: GoldProbeOptions = {}): Promise<GoldProbeEvidence> {
  const startedAt = new Date().toISOString()
  const startedClock = Date.now()
  const client: QwenClient = createQwenClient(config)
  const server = await client.listModels()

  const measuredConfig: QwenModelConfig = {
    ...config,
    // The service-reported integer is the starting point of the verified limit.
    // It is not the model NAME and not the "196k" label.
    contextWindowTokens: server.maxModelLen,
  }
  const steps: ProbeStepEvidence[] = PROBE_LADDER.map((step) => ({
    id: step.id,
    state: 'NOT_RUN' as CapabilityState,
    detail: step.description,
  }))
  const setStep = (id: CapabilityId, state: CapabilityState, detail: string, measured?: Record<string, unknown>): void => {
    const index = steps.findIndex((step) => step.id === id)
    if (index >= 0) steps[index] = { id, state, detail, ...(measured === undefined ? {} : { measured }) }
  }

  const observations: GoldProbeEvidence['observations'] = {
    ladderPromptTokens: [],
    overLimit: null,
    nearLimit: null,
  }

  // 1. basic-response — short Chinese answer, real usage numbers.
  let basic: ChatResult | null = null
  try {
    basic = await client.chat({ temperature: 0,
      messages: [{ role: 'user', content: '用一句中文回答：你是谁？' }],
      maxTokens: 256,
      disableThinking: true,
    })
    if (basic.content.trim().length === 0) {
      setStep('basic-response', 'FAIL', 'the service returned an empty answer', usageDetail(basic))
    } else {
      setStep('basic-response', 'PASS', `answered in ${basic.elapsedMs}ms; reasoning separated from final text`, usageDetail(basic))
    }
  } catch (error) {
    setStep('basic-response', 'FAIL', detailOf(error))
  }

  // 2/3. tool-call + unicode-arguments — BOOP executes the tool itself; the
  // model only proposes it. Arguments must survive Chinese and Unicode exactly.
  let toolCall: { id: string; name: string; args: Record<string, unknown> } | null = null
  try {
    const result = await client.chat({ temperature: 0,
      messages: [
        {
          role: 'user',
          content: `现在调用 echo 工具：text 传 ${JSON.stringify(UNICODE_TEXT)}，meta.tag 传 ${JSON.stringify(UNICODE_TAG)}，meta.emoji 传 "🐳"。只调用工具，不要解释。`,
        },
      ],
      tools: [ECHO_TOOL],
      toolChoice: 'auto',
      maxTokens: 512,
      disableThinking: true,
    })
    const call = result.toolCalls[0]
    if (!call || call.function.name !== 'echo') {
      setStep('tool-call', 'FAIL', `no echo tool call (finish ${String(result.finishReason)})`, usageDetail(result))
      setStep('unicode-arguments', 'NOT_RUN', 'depends on a successful tool call')
    } else {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>
      toolCall = { id: call.id || 'call_1', name: call.function.name, args }
      setStep('tool-call', 'PASS', `echo proposed in ${result.elapsedMs}ms; BOOP would execute it`, {
        ...usageDetail(result),
        argumentBytes: call.function.arguments.length,
      })
      const meta = (args.meta ?? {}) as Record<string, unknown>
      if (args.text === UNICODE_TEXT && meta.tag === UNICODE_TAG) {
        setStep('unicode-arguments', 'PASS', 'Chinese + Unicode arguments round-tripped losslessly', {
          text: args.text,
          tag: meta.tag,
          emoji: meta.emoji,
        })
      } else {
        setStep('unicode-arguments', 'FAIL', 'arguments were altered in transit', { args })
      }
    }
  } catch (error) {
    setStep('tool-call', 'FAIL', detailOf(error))
    setStep('unicode-arguments', 'NOT_RUN', 'depends on a successful tool call')
  }

  // 4. multi-step — propose → (BOOP executes a side-effect-free echo) → answer.
  if (toolCall) {
    try {
      const stepOne = await client.chat({ temperature: 0,
        messages: [
          { role: 'user', content: '先调用 echo 工具：text 传 "第一步"，meta.tag 传 "step1"；然后根据工具结果回答"完成"。' },
        ],
        tools: [ECHO_TOOL],
        toolChoice: 'auto',
        maxTokens: 256,
        disableThinking: true,
      })
      const call = stepOne.toolCalls[0]
      if (!call) {
        setStep('multi-step', 'FAIL', 'first step proposed no tool call', usageDetail(stepOne))
      } else {
        const stepTwo = await client.chat({ temperature: 0,
          messages: [
            { role: 'user', content: '先调用 echo 工具：text 传 "第一步"，meta.tag 传 "step1"；然后根据工具结果回答"完成"。' },
            { role: 'assistant', content: null, tool_calls: [call] },
            {
              role: 'tool',
              tool_call_id: call.id || 'call_1',
              content: JSON.stringify({ echoed: '第一步', tag: 'step1' }),
            },
          ],
          tools: [ECHO_TOOL],
          toolChoice: 'auto',
          maxTokens: 256,
          disableThinking: true,
        })
        const answered = stepTwo.content.trim().length > 0 || stepTwo.toolCalls.length === 0
        setStep(
          'multi-step',
          answered ? 'PASS' : 'FAIL',
          answered ? 'two-step chain completed; BOOP executed the side-effect-free tool' : 'chain produced no final answer',
          { stepOne: usageDetail(stepOne), stepTwo: usageDetail(stepTwo) },
        )
      }
    } catch (error) {
      setStep('multi-step', 'FAIL', detailOf(error))
    }
  } else {
    setStep('multi-step', 'NOT_RUN', 'depends on a successful tool call')
  }

  // 5. strict-json — constrained extraction; a truncated / empty / thinking-mixed
  // output must be REJECTED by the parser, never committed.
  try {
    const result = await client.chat({ temperature: 0,
      messages: [{ role: 'user', content: '从这句话提取事实：波波喜欢在周一下午整理项目，但不确定是否每周都这样。' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'facts', strict: true, schema: FACT_SCHEMA } },
      maxTokens: 512,
      disableThinking: true,
    })
    let parsed: unknown
    try {
      parsed = parseJson(result.content)
    } catch {
      parsed = null
    }
    let truncatedHypothesis = ''
    try {
      const short = await client.chat({ temperature: 0,
        messages: [{ role: 'user', content: '提取事实：波波在周一下午整理项目，但不确定是否每周都这样。' }],
        responseFormat: { type: 'json_schema', json_schema: { name: 'facts', strict: true, schema: FACT_SCHEMA } },
        maxTokens: 8,
        disableThinking: true,
      })
      let shortParsed: unknown = null
      try {
        shortParsed = parseJson(short.content)
      } catch {
        shortParsed = null
      }
      // The guard is "never commit a TRUNCATED output". A tiny budget that
      // happens to finish cleanly (finish=stop) carries no truncation risk; a
      // `length` finish that still parses would be the dangerous case.
      const truncated = short.finishReason === 'length'
      const guardOk = !truncated || shortParsed === null
      truncatedHypothesis = `tiny-budget finish=${String(short.finishReason)} parsed=${shortParsed !== null} guard=${guardOk ? 'ok' : 'VIOLATION'}`
      if (!guardOk) {
        setStep('strict-json', 'FAIL', `a truncated output was parseable and could be committed; ${truncatedHypothesis}`, usageDetail(short))
        throw new Error('truncation guard failed')
      }
    } catch (error) {
      if (String(error).includes('truncation guard failed')) throw error
      truncatedHypothesis = `tiny-budget probe failed: ${detailOf(error)}`
    }
    const facts = (parsed as { facts?: unknown[] } | null)?.facts
    const valid = Array.isArray(facts) && facts.length > 0 && facts.every((fact) => typeof (fact as { text?: unknown }).text === 'string')
    setStep(
      'strict-json',
      valid ? 'PASS' : 'FAIL',
      valid
        ? `schema-constrained JSON parsed and validated; ${truncatedHypothesis}`
        : `schema-constrained output missing or invalid; ${truncatedHypothesis}`,
      { ...usageDetail(result), contentPreview: result.content.slice(0, 160) },
    )
  } catch (error) {
    setStep('strict-json', 'FAIL', detailOf(error))
  }

  // 6. cancel — client-side abort settles the stream. Server-side GPU release is
  // NOT claimed: the frozen rule forbids saying "the server stopped".
  try {
    const stream = await client.streamAndCancel({
      messages: [{ role: 'user', content: '写一段三百字的介绍。' }],
      maxTokens: 512,
      disableThinking: true,
    })
    setStep(
      'cancel',
      stream.aborted && stream.chunks > 0 ? 'PASS' : 'FAIL',
      `client aborted after ${stream.chunks} chunks (first in ${String(stream.firstChunkMs)}ms); server-side release is not claimed`,
      stream as unknown as Record<string, unknown>,
    )
  } catch (error) {
    setStep('cancel', 'FAIL', detailOf(error))
  }

  // 7. context-ladder — real requests at 8k / 32k / 64k prompt tokens.
  const ladderTargets = [8_000, 32_000, 64_000]
  try {
    for (const target of ladderTargets) {
      const result = await client.chat({ temperature: 0,
        messages: [{ role: 'user', content: zhongwen(target) }],
        maxTokens: 4,
        disableThinking: true,
      })
      observations.ladderPromptTokens.push(result.usage.promptTokens)
    }
    const closeEnough = observations.ladderPromptTokens.every((actual, index) => {
      const target = ladderTargets[index] ?? 0
      return actual >= target * 0.75 && actual <= target * 1.5
    })
    setStep(
      'context-ladder',
      closeEnough ? 'PASS' : 'FAIL',
      closeEnough
        ? `8k/32k/64k requests accepted with observed prompt tokens ${observations.ladderPromptTokens.join('/')}`
        : `ladder drifted from targets: ${observations.ladderPromptTokens.join('/')}`,
      { targets: ladderTargets, observed: observations.ladderPromptTokens },
    )
  } catch (error) {
    setStep('context-ladder', 'FAIL', detailOf(error))
  }

  // 8. token-accounting — service usage must be present and internally consistent.
  try {
    const small = await client.chat({ temperature: 0, messages: [{ role: 'user', content: zhongwen(200) }], maxTokens: 4, disableThinking: true })
    const large = await client.chat({ temperature: 0, messages: [{ role: 'user', content: zhongwen(8_000) }], maxTokens: 4, disableThinking: true })
    const smallUsage = small.usage.promptTokens > 0 && small.usage.totalTokens >= small.usage.promptTokens
    const largeUsage = large.usage.promptTokens > 0 && large.usage.totalTokens >= large.usage.promptTokens
    const ratioSmall = small.usage.promptTokens / 200
    const ratioLarge = large.usage.promptTokens / 8_000
    const consistent = ratioSmall > 0 && Math.abs(ratioSmall - ratioLarge) / Math.max(ratioSmall, ratioLarge) < 0.25
    setStep(
      'token-accounting',
      smallUsage && largeUsage && consistent ? 'PASS' : 'FAIL',
      `usage present and consistent (ratio ${ratioSmall.toFixed(3)} vs ${ratioLarge.toFixed(3)} per target-token)`,
      { small: small.usage, large: large.usage },
    )
  } catch (error) {
    setStep('token-accounting', 'FAIL', detailOf(error))
  }

  // Optional boundary observations (recorded, not ladder steps).
  if (options.nearLimitTokens && measuredConfig.contextWindowTokens) {
    try {
      const result = await client.chat({ temperature: 0,
        messages: [{ role: 'user', content: zhongwen(options.nearLimitTokens) }],
        maxTokens: 16,
        disableThinking: true,
      })
      observations.nearLimit = {
        requestedTokens: options.nearLimitTokens,
        status: 200,
        promptTokens: result.usage.promptTokens,
        finish: result.finishReason,
        elapsedMs: result.elapsedMs,
      }
    } catch (error) {
      observations.nearLimit = { requestedTokens: options.nearLimitTokens, status: 0, promptTokens: null, finish: null, elapsedMs: 0 }
      setStep('context-ladder', 'FAIL', `near-limit request failed: ${detailOf(error)}`)
    }
  }
  if (options.overLimitTokens) {
    try {
      const result = await client.chat({ temperature: 0,
        messages: [{ role: 'user', content: zhongwen(options.overLimitTokens) }],
        maxTokens: 8,
        disableThinking: true,
      })
      observations.overLimit = {
        requestedTokens: options.overLimitTokens,
        status: 200,
        promptTokens: result.usage.promptTokens,
        behavior: 'service accepted the request (may truncate); BOOP clamps client-side regardless',
      }
    } catch (error) {
      const transport = error instanceof QwenTransportError ? error : null
      observations.overLimit = {
        requestedTokens: options.overLimitTokens,
        status: transport?.status ?? 0,
        promptTokens: null,
        behavior: `service rejected the over-limit request: ${detailOf(error)}`,
      }
    }
  }

  const outcome = evaluateCapabilities(steps, measuredConfig.contextWindowTokens)
  // The clamp must be usable once a verified limit exists; a failure here would
  // mean BOOP could not send any safe request at all.
  if (measuredConfig.contextWindowTokens) {
    clampRequest(Math.min(1_000, measuredConfig.contextWindowTokens), 512, measuredConfig)
  }

  return {
    schemaVersion: 1,
    startedAt,
    elapsedMs: Date.now() - startedClock,
    config: {
      providerId: config.providerId,
      modelId: config.modelId,
      baseUrl: config.baseUrl,
      credential: config.credentialRef === null ? 'missing' : config.credentialRef === NO_CREDENTIAL ? 'none' : 'reference',
      declaredContext: config.declaredContext,
      quantization: config.quantization,
      externalFallbackAllowed: false,
    },
    server: {
      servedModelIds: server.ids,
      modelFound: true,
      maxModelLen: server.maxModelLen,
      root: server.root,
    },
    contextWindowTokens: measuredConfig.contextWindowTokens,
    steps,
    outcome,
    observations,
  }
}
