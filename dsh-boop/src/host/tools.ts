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
              text:
                `BOOP scope: ${value.scope.product} on DSH ${value.scope.dshProfileVersion}; ` +
                `write mode ${value.writeModeEnabled ? 'ENABLED' : 'disabled (gates pending)'}.`,
            },
          ],
        },
        execute: async () => {
          const boop = ctx.boop
          if (!boop) throw new Error('boop runtime service is not available')
          const state = boop.state()
          return {
            scope: {
              product: 'BOOP',
              dshProfileVersion: state.dshProfileVersion,
            },
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
}
