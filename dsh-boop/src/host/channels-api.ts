/**
 * IM channel row (E06-01).
 *
 * The shipped profile always mounts the closed runtime: no credentials are
 * read, no socket is opened, and admit() cannot create a task. G07 stays
 * BLOCKED until a real DingTalk or Feishu binding is configured and tested.
 * This module is called from the main `dsh-boop` row. It must not be its own
 * cordis entry: a relative `./lib/*.js` plugin with no external import is
 * resolved as a second web client of package dsh-boop, and rc.2.1
 * client-modules refuses to boot.
 */

import { closedChannelRuntime } from './channels/admission.ts'

export const name = 'boop-channels'

export const inject: string[] = []

export function apply(ctx: any): void {
  const runtime = closedChannelRuntime()
  ctx.provide('boopChannels', {
    status() {
      const availability = runtime.status()
      return {
        dingtalk: availability.dingtalk,
        feishu: availability.feishu,
        networkAttempts: runtime.networkAttempts,
        reason: 'credentials-not-configured',
      }
    },
    admit() {
      return { rejected: true, reason: 'CREDENTIALS_ABSENT' as const, networkAttempts: runtime.networkAttempts }
    },
  })
  try {
    ctx.logger?.info?.('[boop] channels closed: DingTalk and Feishu stay off without credentials')
  } catch {
    /* logging must not break activation */
  }
}
