/**
 * BOOP runtime pre-step gate row `boop-gate` (G04 closure).
 *
 * An unambiguous Cordis function plugin (`name` / `inject` / `apply`) mounted
 * from `cordis.patch.yml` as `boop-gate`, so the runtime interception can be
 * composed, disabled or tested independently of the other BOOP rows.
 *
 * It installs ONE listener on the official rc.2.1 waterfall
 *
 *   'agent/pre-step' (payload: { agent, messages, turn, step, signal }, next)
 *
 * and delegates the decision to the framework-free `PreStepRuntimeGate`
 * (`pre-step.ts`). The hook runs after turn admission / inbox claim but BEFORE
 * `step/start`, `agent/request`, `prepareCall()` and any model call, so a veto
 * here means NO model request for that step.
 *
 * It also provides:
 *  - `boopGateRuntime` (in-process facade): `{ composed, hook, status(),
 *    enforcement() }`. The control plane reads `enforcement()` to report the
 *    REAL `recovery.runtimeEnforcement.composed` instead of a hard-coded false;
 *  - the `boopGate` Typert Remote namespace with a READ-ONLY `status()` method
 *    (single-layer facts, `{args:{request}}` wire) for evidence/UI.
 *
 * Config (isolated profiles / diagnostics only; shipped defaults are safe):
 *  - `waitTimeoutMs`: how long a tracked-but-unreleased BOOP command may hold
 *    admission before it is fail-closed rejected (default 120000);
 *  - `pollMs`: release polling interval (default 250);
 *  - `simulateGateUnavailable`: TEST ONLY — makes the live gate look unavailable
 *    so the fail-closed path can be proven end-to-end. Never set in a shipped
 *    profile.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { remote } from '../remote.ts'
import {
  PRE_STEP_HOOK,
  PRE_STEP_REMOTE_NAMESPACE,
  PRE_STEP_ROW_ID,
  PreStepRuntimeGate,
  runtimeGatePortOf,
  type PreStepStatusFacts,
} from './pre-step.ts'

export const name = PRE_STEP_ROW_ID

/** `boop` owns the gate ledger/registry; the gateway routes the Remote method. */
export const inject = ['boop', 'typertGateway']

export interface BoopGateConfig {
  waitTimeoutMs?: number
  pollMs?: number
  simulateGateUnavailable?: boolean
}

export interface BoopGateRuntimeService {
  composed: boolean
  hook: string
  status(): PreStepStatusFacts
  enforcement(): { composed: boolean; detail: string }
}

/** Read-only Remote plane for the runtime gate (evidence + UI diagnostics). */
class BoopGateApi extends TypertRemoteService {
  private readonly runtime: PreStepRuntimeGate

  constructor(ctx: any, runtime: PreStepRuntimeGate) {
    super(ctx, PRE_STEP_REMOTE_NAMESPACE, { namespace: PRE_STEP_REMOTE_NAMESPACE })
    this.runtime = runtime
  }

  /** Registered state, gate ledger, consumed ids and counters. Reads nothing external. */
  status(request?: unknown): PreStepStatusFacts {
    return this.runtime.status()
  }
}

remote('status')(BoopGateApi.prototype)

export function apply(ctx: any, config: BoopGateConfig = {}): void {
  try {
    const port = runtimeGatePortOf(ctx, { simulateUnavailable: config.simulateGateUnavailable === true })
    const runtime = new PreStepRuntimeGate(port, {
      waitTimeoutMs: config.waitTimeoutMs,
      pollMs: config.pollMs,
    })

    // The official waterfall: `(payload, next) => Promise<PreStepDecision>`.
    // Registering through the row's own context ties disposal to this row.
    ctx.on(PRE_STEP_HOOK, async (payload: unknown, next: () => Promise<unknown>) => {
      return await runtime.handle(payload as any, next as any)
    })
    runtime.markRegistered()

    // In-process facade consumed by `boop-control` (and future IM adapters).
    const facade: BoopGateRuntimeService = {
      composed: true,
      hook: PRE_STEP_HOOK,
      status: () => runtime.status(),
      enforcement: () => runtime.enforcement(),
    }
    ctx.provide('boopGateRuntime', facade)

    new BoopGateApi(ctx, runtime)
    ctx.logger?.info?.(
      `[boop] pre-step gate armed: ${PRE_STEP_HOOK} listener registered; ` +
        `waitTimeout=${runtime.waitTimeoutMs}ms; unreleased/untracked BOOP commands fail closed`,
    )
  } catch (error) {
    // A throwing optional row must warn, never break the host boot.
    try {
      ctx.logger?.warn?.('[boop] pre-step gate failed to arm; BOOP commands stay fail-closed elsewhere', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
