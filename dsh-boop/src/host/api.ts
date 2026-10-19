/**
 * BOOP logical API plane (host row).
 *
 * This module is an unambiguous Cordis function-plugin — `name`, `inject`,
 * `apply` — because a module that exports BOTH a Service class and a
 * function-plugin leaves the rc.2 loader's choice ambiguous (observed during
 * E00-02: the row mounted the class, `apply` never ran, and the Remote
 * endpoints were never claimed). The service object lives in `api-service.ts`.
 *
 * Transport facts verified in tests/host/e00-01-plugin-load.test.mjs:
 *  - the service registers as a TypertRemoteService under namespace `boop`;
 *  - unauthenticated callers never reach the handler (Connection owns the
 *    trust fence and token exchange — E00-01/G01);
 *  - the client half calls through `ctx.connection.rpc.call('/api', …)`.
 */

import { BoopApi, configureApi, type BoopApiConfig } from './api-service.ts'

export const name = 'boop-api'

/** `boop` is BOOP's own runtime service; the gateway is the Remote transport. */
export const inject = ['boop', 'typertGateway']

export function apply(ctx: any, config?: BoopApiConfig): void {
  try {
    const effective = configureApi(config)
    new BoopApi(ctx)
    ctx.logger?.info?.(
      `[boop] api plane armed: boop/bootstrap (read-only)${effective.pocEnabled ? ' + PoC endpoints' : ''}`,
    )
  } catch (error) {
    ctx.logger?.warn?.('[boop] api plane failed to arm; host continues', error)
  }
}
