/**
 * Self-hosted Qwen adapter (E05-00, Gate G02).
 *
 * Frozen rules (02§06, 03§03):
 *  - the service name stays exactly as the user configured it; BOOP never
 *    rewrites "qwen3.8-27b" into a model-card name and never downloads weights;
 *  - base URL, providerId, credential reference and the REAL context integer
 *    come from the user's configuration, never from a guess;
 *  - 196k is a DECLARED label. `contextWindowTokens` must be filled from an
 *    actual probe; requests are clamped to the verified limit;
 *  - no external fallback: when the configured route is unavailable the answer
 *    is "unavailable", never another provider;
 *  - capability probe order: basic response → tool call → multi-step → strict
 *    JSON → cancel → context ladder → token accounting. A failure narrows what
 *    BOOP may do, it never silently widens it.
 *
 * This module holds the policy and its contract tests. `qwen-client.ts` is the
 * real HTTP transport and `qwen-probe.ts` runs the live gold probe; the user's
 * service (IN-01/IN-02/IN-03) may declare `credentialRef: 'none'` explicitly
 * when it requires no credential — that is a stated fact, not a guess. (The
 * real gold run and its evidence live in docs/development/evidence/e05-00/.)
 */

export type CapabilityId =
  | 'basic-response'
  | 'tool-call'
  | 'unicode-arguments'
  | 'multi-step'
  | 'strict-json'
  | 'cancel'
  | 'context-ladder'
  | 'token-accounting'

export type CapabilityState = 'PASS' | 'FAIL' | 'NOT_RUN'

export interface QwenModelConfig {
  /** Exact provider id as configured by the user (IN-01). */
  providerId: string | null
  /** Exact server model id (IN-01). Never inferred. */
  modelId: string | null
  /** Reference to a credential in the host credential store (IN-02). */
  credentialRef: string | null
  baseUrl: string | null
  /** Verified integer limit (IN-03). `null` until a probe fills it. */
  contextWindowTokens: number | null
  /** The user's declared label, e.g. "196k". A label, never a budget. */
  declaredContext: string | null
  quantization: string | null
  /** Frozen rule: there is no external fallback. */
  externalFallbackAllowed: false
}

export interface CapabilityReport {
  id: CapabilityId
  state: CapabilityState
  detail?: string
}

export interface ProbeOutcome {
  /** The limit every request is clamped to. */
  effectiveContextLimit: number
  /** What BOOP may do once this report is applied. */
  allowed: {
    readOnlyChat: boolean
    memoryJobs: boolean
    autonomousDispatch: boolean
    historyBatchLearning: boolean
  }
  capabilities: CapabilityReport[]
}

export const DEFAULT_MODEL_CONFIG: QwenModelConfig = {
  providerId: null,
  modelId: null,
  credentialRef: null,
  baseUrl: null,
  contextWindowTokens: null,
  declaredContext: null,
  quantization: null,
  externalFallbackAllowed: false,
}

export class ModelConfigurationError extends Error {
  readonly code: 'MODEL_UNAVAILABLE' | 'CAPABILITY_UNAVAILABLE'
  constructor(message: string, code: 'MODEL_UNAVAILABLE' | 'CAPABILITY_UNAVAILABLE' = 'MODEL_UNAVAILABLE') {
    super(message)
    this.name = 'ModelConfigurationError'
    this.code = code
  }
}

/**
 * Conservative clamp (02§07): `input + outputReserve + safetyMargin <= limit`.
 * Nothing is filled from an advertised capacity.
 */
export function clampRequest(inputTokens: number, outputReserve: number, config: QwenModelConfig): number {
  const limit = config.contextWindowTokens
  if (limit === null) {
    throw new ModelConfigurationError(
      'contextWindowTokens is unknown; run the context probe before sending requests',
    )
  }
  const safetyMargin = Math.max(1024, Math.floor(limit * 0.05))
  const budget = limit - outputReserve - safetyMargin
  if (budget <= 0) {
    throw new ModelConfigurationError('output reserve and safety margin exceed the verified context limit')
  }
  return Math.max(0, Math.min(inputTokens, budget))
}

export function assertConfigured(config: QwenModelConfig): void {
  const missing = (['baseUrl', 'providerId', 'modelId', 'credentialRef'] as const).filter((key) => !config[key])
  if (missing.length > 0) {
    throw new ModelConfigurationError(
      `model route is not configured (missing: ${missing.join(', ')}); BOOP never guesses these values`,
    )
  }
  if (config.externalFallbackAllowed !== false) {
    throw new ModelConfigurationError('external model fallback must stay disabled')
  }
}

/**
 * Derive what BOOP may do from probe results.
 *
 * The mapping is fixed by the frozen gate policy, not by a score:
 *  - no basic response → nothing works; the answer is "unavailable";
 *  - no tool call → read-only chat only (no autonomous dispatch);
 *  - no strict JSON → no memory extraction jobs;
 *  - no context ladder → no history batch learning (cannot size a batch).
 */
export function evaluateCapabilities(reports: CapabilityReport[], contextLimit: number | null): ProbeOutcome {
  const byId = new Map(reports.map((report) => [report.id, report.state]))
  const has = (id: CapabilityId) => byId.get(id) === 'PASS'
  const basic = has('basic-response')
  return {
    effectiveContextLimit: contextLimit ?? 0,
    allowed: {
      readOnlyChat: basic,
      memoryJobs: basic && has('strict-json'),
      autonomousDispatch: basic && has('tool-call') && has('multi-step'),
      historyBatchLearning:
        basic && has('strict-json') && has('context-ladder') && contextLimit !== null && contextLimit > 0,
    },
    capabilities: reports,
  }
}

/** The probe ladder itself (02§06): order matters, failures narrow capability. */
export const PROBE_LADDER: Array<{ id: CapabilityId; description: string }> = [
  { id: 'basic-response', description: '短中文问答、服务错误与鉴权失败可分辨' },
  { id: 'tool-call', description: '无副作用 echo 工具、参数约束' },
  { id: 'unicode-arguments', description: '中文与 Unicode 参数往返无损' },
  { id: 'multi-step', description: '列目录 → 读记忆 → 提出动作，不执行危险动作' },
  { id: 'strict-json', description: '约束式提取；截断/空输出/思考混入不被提交' },
  { id: 'cancel', description: '取消后连接与资源释放被验证' },
  { id: 'context-ladder', description: '8k/32k/64k/接近上限的实际请求' },
  { id: 'token-accounting', description: '服务 usage 与 tokenizer 一致性' },
]
