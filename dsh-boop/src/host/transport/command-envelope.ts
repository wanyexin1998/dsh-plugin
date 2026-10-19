/**
 * BOOP proxy-command provenance (G03).
 *
 * rc.2 reality (verified against the installed payload, see
 * docs/development/evidence/e00-02/):
 *  - `SessionPromptRequest` carries requestId/sessionId/mode/content only; the
 *    relevance type is `user-rpc` and carries no proxy source (frozen 02§09);
 *  - `MessageSourceMap` has no BOOP entry, so a custom source object is passed
 *    through the host path unvalidated at the inbox boundary;
 *  - BOOP therefore identifies its OWN messages by messageId as well as by the
 *    source envelope, so provenance survives even if a future host rejects an
 *    unknown source kind.
 *
 * Identity is always decided by the host adapter, never by message text: the
 * envelope carries the scope/task/action ids the HOST minted, and no model can
 * write them.
 */

import { createHash, randomUUID } from 'node:crypto'

export const PROXY_SOURCE_KIND = 'boop-command'

export interface ProxyProvenance {
  kind: typeof PROXY_SOURCE_KIND
  /** BOOP data domain (minted by the host). */
  scopeId: string
  taskId: string
  actionId: string
  /** Verified actor the command came from (host-resolved, never model text). */
  initiatorRef: string
  policyEpoch: number
}

export interface CommandEnvelope {
  scopeId: string
  taskId: string
  taskVersion: number
  actionId: string
  messageId: string
  policyEpoch: number
  payloadHash: string
  initiatorRef: string
  instruction: string
  mode: 'queue' | 'steer'
}

/** Stable hash of the dispatch-relevant payload; approval binds to this value. */
export function payloadHash(parts: {
  taskId: string
  taskVersion: number
  targetSessionId: string
  instruction: string
  mode: 'queue' | 'steer'
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        parts.taskId,
        parts.taskVersion,
        parts.targetSessionId,
        parts.instruction,
        parts.mode,
      ]),
    )
    .digest('hex')
}

export function newActionId(): string {
  return `act_${randomUUID()}`
}

/**
 * Build the proxy message envelope and its source provenance.
 *
 * `source.kind` is deliberately NOT `user`: a proxy command must never be
 * indistinguishable from a human message (frozen 02§09, 03§08).
 */
export function buildProxyMessage(input: {
  envelope: CommandEnvelope
  targetSessionId: string
}): { message: any; provenance: ProxyProvenance } {
  const { envelope } = input
  const provenance: ProxyProvenance = {
    kind: PROXY_SOURCE_KIND,
    scopeId: envelope.scopeId,
    taskId: envelope.taskId,
    actionId: envelope.actionId,
    initiatorRef: envelope.initiatorRef,
    policyEpoch: envelope.policyEpoch,
  }
  const message = {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: envelope.instruction },
      {
        type: 'text' as const,
        text: JSON.stringify({
          boop: {
            scopeId: envelope.scopeId,
            taskId: envelope.taskId,
            taskVersion: envelope.taskVersion,
            actionId: envelope.actionId,
            policyEpoch: envelope.policyEpoch,
          },
        }),
      },
    ],
    source: provenance,
  }
  return { message, provenance }
}

/**
 * Recognise a BOOP-owned message.
 *
 * Two independent signals are accepted: the source envelope (self-describing)
 * and the host-side registry of message ids BOOP itself minted (authoritative).
 * A message that only LOOKS like BOOP text is not recognised — the text block
 * is never a provenance signal.
 */
export function isBoopMessage(message: unknown, knownMessageIds: ReadonlySet<string>): boolean {
  if (!message || typeof message !== 'object') return false
  const record = message as { id?: unknown; source?: { kind?: unknown } }
  if (typeof record.id === 'string' && knownMessageIds.has(record.id)) return true
  return record.source?.kind === PROXY_SOURCE_KIND
}
