/**
 * BOOP management tools (model-facing surface).
 *
 * Frozen tool directory (02§08): boop_catalog, boop_context, boop_history,
 * boop_task_propose, boop_task_update, boop_dispatch, boop_task_control,
 * boop_workspace_change, boop_memory_correct, boop_verify, boop_automation.
 *
 * The model NEVER receives approval_decide, credential inspection, arbitrary
 * SQL or arbitrary local file write. BOOP tools are BOOP's own interfaces,
 * not existing DSH tool names.
 *
 * Implemented so far:
 *  - boop_catalog (E00-01): read-only scope identity + host capability facts;
 *  - boop_verify (E05-02): READ-ONLY evidence verification of one authorized
 *    task. It never runs a test command, never reads an arbitrary file, and
 *    never treats an Agent claim or a finished turn as a pass (AT-16/AT-17).
 * The remaining frozen tools arrive with their owning work items and stay
 * absent until then — an absent tool cannot be prompted into existing.
 *
 * Schema DSL note (verified against the installed `@deepseek-ai/dsh-tools`):
 * parameters accept `required: true` on a property and treat an ABSENT
 * `required` as optional (an explicit `required: false` is refused), while the
 * output value-schema DSL accepts `properties` / boolean `additionalProperties`
 * / array `items` but has NO `required` keyword at all. Both definitions below
 * are compiled by `defineTool` and covered by the E05-02 host test (registration
 * is asserted through `boopVerify/status`), because a definition that throws is
 * silently never registered.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runVerifyTool } from './verify/verify-api.ts'
import { validateDispatchArgs, validateStopArgs } from '../shared/mvp-contract.ts'
import type { TrustedCall } from './delegation/service.ts'

function trustedCall(exec: any, ctx: any): TrustedCall | null {
  const delegation = ctx.boop?.delegation?.()
  const home = ctx.boop?.home?.()
  void home
  const agent = exec?.agent
  const sessionId = agent?.session?.id ?? agent?.id
  const origin = exec?.originUserMessageId ?? exec?.userMessageId ?? exec?.callId
  if (typeof sessionId !== 'string' || typeof origin !== 'string') return null
  const storage = ctx.boop?.storage?.()
  return {
    originRef: origin,
    originKind: 'user',
    mainSessionId: sessionId,
    bindingVersion: 1,
    policyEpoch: storage?.repo?.getScope?.(storage.identity.scopeId)?.policyEpoch ?? 1,
    holder: storage?.identity?.ownerId ?? 'owner',
    fence: storage?.facts?.(true)?.lease?.fencingToken ?? 0,
    toolCallId: typeof exec?.callId === 'string' ? exec.callId : undefined,
  }
}
export const name = 'boop-tools'

export const inject = ['tools', 'boop']

export function apply(ctx: any): void {
  try {
    ctx.tools.register(
      defineTool({
        name: 'boop_catalog',
        description:
          'BOOP read-only catalog: current scope identity, data-domain status, and which host capabilities are available. ' +
          'Use it before proposing actions to confirm what BOOP can currently see and do. ' +
          'It never creates tasks and never dispatches anything.',
        parameters: {
          scope: { type: 'string', description: 'Optional scope filter; default is the current data domain.' },
          mode: { type: 'string', enum: ['work', 'tasks', 'capabilities'] },
          query: { type: 'string' },
          workspaceId: { type: 'string' },
          taskId: { type: 'string' },
          limit: { type: 'integer' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              scope: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  product: { type: 'string' },
                  dshProfileVersion: { type: 'string' },
                },
              },
              capabilities: { type: 'object', additionalProperties: true },
              writeModeEnabled: { type: 'boolean' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2
                ? JSON.stringify(value)
                : `BOOP scope: ${(value as { scope?: { product?: string; dshProfileVersion?: string } }).scope?.product ?? 'BOOP'} on DSH ${(value as { scope?: { dshProfileVersion?: string } }).scope?.dshProfileVersion ?? ''}; write mode ${(value as { writeModeEnabled?: boolean }).writeModeEnabled ? 'ENABLED' : 'disabled (gates pending)'}.`,
            },
          ],
        },
        execute: async (args, exec) => {
          const delegation = ctx.boop?.delegation?.()
          const mode = args?.mode === 'work' || args?.mode === 'tasks' || args?.mode === 'capabilities' ? args.mode : 'capabilities'
          if (delegation && mode !== 'capabilities') {
            const trusted = trustedCall(exec, ctx)
            if (!trusted) {
              return { schemaVersion: 2, kind: 'boop.catalog', ok: false, error: { code: 'SCOPE_DENIED', message: '这次读取没有对上当前的波波会话。', retryable: false } }
            }
            return delegation.catalog({
              mode,
              query: typeof args?.query === 'string' ? args.query : undefined,
              limit: typeof args?.limit === 'number' ? args.limit : undefined,
              originUserMessageId: trusted.originRef,
              sourceSeq: null,
              capabilities: delegation.capabilities(true),
            })
          }
          const boop = ctx.boop
          if (!boop) throw new Error('boop runtime service is not available')
          const state = boop.state()
          if (delegation && mode === 'capabilities') {
            return delegation.catalog({ mode: 'capabilities', originUserMessageId: null, sourceSeq: null, capabilities: delegation.capabilities(true) })
          }
          return {
            scope: { product: 'BOOP', dshProfileVersion: state.dshProfileVersion },
            capabilities: boop.capabilities(),
            writeModeEnabled: boop.isWriteModeEnabled(),
          }
        },
      }),
    )

    /**
     * E05-02 `boop_verify` — evidence-based verification of one authorized task.
     *
     * READ-ONLY by construction: it reads durable ledger evidence, evaluates
     * acceptance criteria against check RESULTS the caller already obtained (BOOP
     * never runs test commands or opens arbitrary files), and reports
     * passed / failed / partial / unknown / stale with per-criterion gaps.
     * An Agent claim ("done", "tests pass") is never evidence (AT-16) and
     * evidence from another task/artifact version never passes (AT-17).
     */
    ctx.tools.register(
      defineTool({
        name: 'boop_verify',
        description:
          'Verify one authorized BOOP task against durable evidence and check results that ALREADY ran. ' +
          'Read-only: it never executes a test command and never reads an arbitrary file. ' +
          'Never treat an Agent claim or a finished turn as acceptance evidence; evidence produced for a ' +
          'different task/artifact version never passes (report stale), and when the facts cannot decide the ' +
          'conclusion is unknown. Returns per-criterion conclusions, uncovered items, the stable failure ' +
          'fingerprint and the auto-repair attempt count.',
        parameters: {
          taskId: {
            type: 'string',
            required: true,
            description: 'Exact BOOP task id in this data scope.',
          },
          evidenceRefs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Durable evidence addresses: "session:<sessionId>#seq:<n>" or "fact:<factId>@<version>". ' +
              'Addresses that do not resolve in this task ledger evidence are reported as unresolved, not trusted.',
          },
          checks: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Results of checks that ALREADY ran, one per acceptance criterion: ' +
              '"<criterionIndex>:<passed|failed|unknown>[:detail]". BOOP never runs them itself.',
          },
          claim: {
            type: 'string',
            description:
              'Optional Agent claim text (e.g. "done"); it is recorded as a NON-evidence claim and can never make verification pass.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              taskId: { type: 'string' },
              conclusion: { type: 'string' },
              available: { type: 'boolean' },
              reason: { type: 'string' },
              recommendedVerification: { type: 'string' },
              attempt: { type: 'number' },
              limitReached: { type: 'boolean' },
            },
          },
          render: (_args, value) => {
            const conclusion = String((value as { conclusion?: unknown })?.conclusion ?? 'unknown')
            const reason = (value as { reason?: unknown })?.reason
            const attempt = (value as { attempt?: unknown })?.attempt
            const limit = (value as { limitReached?: unknown })?.limitReached === true
            const criteria = (value as { coverage?: { passed?: unknown; total?: unknown } })?.coverage
            return [
              {
                type: 'text',
                text:
                  `boop_verify: ${conclusion}${reason === undefined || reason === null ? '' : ` (${String(reason)})`}; ` +
                  `criteria ${String(criteria?.passed ?? '?')}/${String(criteria?.total ?? '?')}` +
                  `${limit ? '; auto-repair fingerprint limit reached — stop further dispatch' : ''}` +
                  `${typeof attempt === 'number' && attempt > 0 ? `; attempt ${attempt}` : ''}.`,
              },
            ]
          },
        },
        execute: async (args) => runVerifyTool(ctx, args) as unknown as Record<string, unknown>,
      }),
    )

    ctx.logger?.info?.('[boop] management tools registered (read-only: boop_catalog, boop_verify)')
  } catch (error) {
    try {
      ctx.logger?.warn?.('[boop] tool registration failed; host continues', error)
    } catch {
      /* never break activation from a tool row */
    }
  }

  try {
    ctx.tools.register(
      defineTool({
        name: 'boop_context',
        description:
          'Read-only lookup in the BOOP memory ledger for one question. ' +
          'Tombstoned and superseded facts are omitted. It never dispatches work and never reads an arbitrary file.',
        parameters: {
          question: {
            type: 'string',
            description: 'Question to match against remembered facts, or the reason for reading a session.',
          },
          targetSessionId: { type: 'string' },
          taskId: { type: 'string' },
          beforeSeq: { type: 'integer' },
          limit: { type: 'integer' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              available: { type: 'boolean' },
              degraded: { type: 'boolean' },
              hitCount: { type: 'number' },
              body: { type: 'string' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2
                ? JSON.stringify(value)
                : String((value as { body?: unknown }).body ?? ''),
            },
          ],
        },
        execute: async (args, exec) => {
          const delegation = ctx.boop?.delegation?.()
          if (delegation && (typeof args.targetSessionId === 'string' || typeof args.taskId === 'string')) {
            const trusted = trustedCall(exec, ctx)
            if (!trusted) {
              return { schemaVersion: 2, kind: 'boop.context', ok: false, error: { code: 'SCOPE_DENIED', message: '这次读取没有对上当前的波波会话。', retryable: false } }
            }
            return delegation.readContext({
              targetSessionId: typeof args.targetSessionId === 'string' ? args.targetSessionId : undefined,
              taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
              question: typeof args.question === 'string' ? args.question : undefined,
              beforeSeq: typeof args.beforeSeq === 'number' ? args.beforeSeq : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
              call: trusted,
            })
          }
          const storage = ctx.boop?.storage?.()
          const question = typeof args.question === 'string' ? args.question.trim() : ''
          if (!storage?.repo || question === '') {
            return {
              available: false,
              degraded: true,
              hitCount: 0,
              body: '记忆账本不可用，或问题为空。没有检索，也没有写入。',
            }
          }
          const hits = storage.repo.searchFacts(storage.identity.scopeId, question, 12)
          const fts = storage.db?.fts === true
          return {
            available: true,
            degraded: !fts,
            hitCount: hits.length,
            body:
              hits.length === 0
                ? '没有命中仍有效的记忆。被遗忘或已取代的事实不会出现在这里。'
                : hits.map((hit) => `- ${hit.text}`).join('\n'),
          }
        },
      }),
    )
    ctx.logger?.info?.('[boop] boop_context registered (read-only ledger lookup)')
  } catch (error) {
    try {
      ctx.logger?.warn?.('[boop] boop_context registration failed; other tools stay registered', error)
    } catch {
      /* never break activation */
    }
  }

  try {
    ctx.tools.register(defineTool({
      name: 'boop_dispatch',
      description: 'After the user explicitly asks BOOP to continue one existing session, prepare one task and one action. Does not wait for the target to finish. Never use this for ordinary discussion.',
      parameters: {
        requestId: { type: 'string', required: true },
        targetSessionId: { type: 'string', required: true },
        contextToken: { type: 'string', required: true },
        goal: { type: 'string', required: true },
        instruction: { type: 'string', required: true },
        criteria: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        const parsed = validateDispatchArgs(args)
        if (!parsed.ok) return { schemaVersion: 2, kind: 'boop.dispatch', ok: false, error: { code: 'INVALID_ARGUMENT', message: parsed.message, retryable: false } }
        const delegation = ctx.boop?.delegation?.()
        const trusted = trustedCall(exec, ctx)
        if (!delegation || !trusted) return { schemaVersion: 2, kind: 'boop.dispatch', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能委托，没有新建工作。', retryable: true } }
        return delegation.prepare(parsed.value, trusted)
      },
    }))
    ctx.tools.register(defineTool({
      name: 'boop_task_control',
      description: 'Stop, resume, or revise one exact BOOP task. Stop does not need a model. Resume and revise need a fresh context token and the user\'s new instruction. This tool cannot accept work or approve native permissions.',
      parameters: {
        requestId: { type: 'string', required: true },
        taskId: { type: 'string', required: true },
        expectedTaskVersion: { type: 'integer', required: true },
        operation: { type: 'string', required: true, enum: ['stop', 'resume', 'revise'] },
        contextToken: { type: 'string' },
        instruction: { type: 'string' },
        goal: { type: 'string' },
        criteria: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        const delegation = ctx.boop?.delegation?.()
        const trusted = trustedCall(exec, ctx)
        if (!delegation || !trusted) return { schemaVersion: 2, kind: 'boop.control', ok: false, error: { code: 'NATIVE_UNAVAILABLE', message: '现在不能控制这件工作。', retryable: true } }
        if (args.operation === 'stop') {
          const parsed = validateStopArgs(args)
          if (!parsed.ok) return { schemaVersion: 2, kind: 'boop.control', ok: false, error: { code: 'INVALID_ARGUMENT', message: parsed.message, retryable: false } }
          return delegation.stop(parsed.value, { ...trusted, originKind: 'user' })
        }
        if ((args.operation === 'resume' || args.operation === 'revise') && typeof args.contextToken === 'string' && typeof args.instruction === 'string') {
          return delegation.revise({
            requestId: String(args.requestId),
            taskId: String(args.taskId),
            expectedTaskVersion: Number(args.expectedTaskVersion),
            contextToken: args.contextToken,
            instruction: args.instruction,
            goal: typeof args.goal === 'string' ? args.goal : undefined,
            criteria: Array.isArray(args.criteria) ? args.criteria : undefined,
            exclusions: Array.isArray(args.exclusions) ? args.exclusions : undefined,
          }, trusted)
        }
        return { schemaVersion: 2, kind: 'boop.control', ok: false, error: { code: 'INVALID_ARGUMENT', message: '继续处理需要新的上下文和新的要求。', retryable: false } }
      },
    }))
  } catch (error) {
    try { ctx.logger?.warn?.('[boop] delegation tools failed to register', error) } catch { /* keep the host up */ }
  }
}
