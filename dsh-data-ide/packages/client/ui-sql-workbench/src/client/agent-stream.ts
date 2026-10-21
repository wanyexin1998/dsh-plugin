/**
 * Subscribes the panel to agent deliveries (docs/10 §13.1).
 *
 * The primary path is the SSE route; when it fails (a buffering proxy, a dropped
 * connection) the same feed is polled. Both carry identical envelopes, so the
 * caller only ever sees a delivery.
 */

import { type AgentDelivery, parseDelivery } from '../execute/agent-delivery.ts'
import type { ConsoleEntry } from '../execute/console-registry.ts'

/** Wire paths; must match `src/host/agent-routes.ts`. */
export const AGENT_STREAM_ROUTES = {
  events: '/dsh-data-ide/agent-events',
  results: '/dsh-data-ide/agent-results',
  consoles: '/dsh-data-ide/agent-consoles',
} as const

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Structural slice of `EventSource`, so this module needs no DOM lib. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  close(): void
}

export type EventSourceCtor = new (url: string) => EventSourceLike

export interface AgentStreamOptions {
  readonly pollMs?: number
  readonly fetchImpl?: FetchLike
  /** Inject an EventSource in tests; `null` forces the polling path. */
  readonly eventSourceImpl?: EventSourceCtor | null
}

/** `fetch` is absent in some harnesses; fail the poll instead of throwing. */
const defaultFetch: FetchLike = (input, init) =>
  typeof fetch === 'function' ? fetch(input, init) : Promise.reject(new Error('fetch 不可用'))

/**
 * Publish which consoles belong to the user (docs/10 §13.3).
 *
 * Best effort on purpose: a failed publish leaves the registry stale, which the
 * MCP side treats as "unknown" and therefore as a new console — never as a
 * refusal, so nothing breaks.
 */
export async function publishConsoles(
  consoles: readonly ConsoleEntry[],
  options: { readonly fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? defaultFetch
  try {
    await fetchImpl(AGENT_STREAM_ROUTES.consoles, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consoles }),
    })
  } catch {
    // Advisory only; see the doc comment.
  }
}

/**
 * Follow the agent feed until the returned disposer runs.
 *
 * @param onDelivery - called once per envelope, in order.
 * @param options - polling period and injectable transports.
 * @returns disposer closing the stream and clearing the timer.
 */
export function subscribeAgentDeliveries(
  onDelivery: (delivery: AgentDelivery) => void,
  options: AgentStreamOptions = {},
): () => void {
  const pollMs = options.pollMs ?? 1000
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const EventSourceCtor =
    options.eventSourceImpl === undefined
      ? (globalThis as { EventSource?: EventSourceCtor }).EventSource
      : options.eventSourceImpl ?? undefined

  let disposed = false
  let cursor = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let source: EventSourceLike | undefined

  const emit = (raw: unknown): void => {
    const delivery = parseDelivery(raw)
    if (delivery !== null && !disposed) onDelivery(delivery)
  }

  const pollOnce = async (): Promise<void> => {
    try {
      const response = await fetchImpl(`${AGENT_STREAM_ROUTES.results}?since=${cursor}`)
      if (!response.ok) return
      const payload = (await response.json()) as unknown
      if (disposed || typeof payload !== 'object' || payload === null) return
      const record = payload as { cursor?: unknown; events?: unknown }
      if (Array.isArray(record.events)) {
        for (const event of record.events) {
          if (typeof event === 'object' && event !== null) emit((event as { delivery?: unknown }).delivery)
        }
      }
      if (typeof record.cursor === 'number') cursor = record.cursor
    } catch {
      // Transient: the next tick retries.
    }
  }

  const startPolling = (): void => {
    if (timer !== undefined || disposed) return
    timer = setInterval(() => void pollOnce(), pollMs)
  }

  if (EventSourceCtor !== undefined) {
    try {
      source = new EventSourceCtor(AGENT_STREAM_ROUTES.events)
      source.addEventListener('agent-result', event => {
        try {
          emit(JSON.parse(String(event.data)))
        } catch {
          // A frame we cannot read is skipped; the poll fallback catches up.
        }
      })
      source.addEventListener('error', () => {
        source?.close()
        source = undefined
        startPolling()
      })
    } catch {
      startPolling()
    }
  } else {
    startPolling()
  }

  return () => {
    disposed = true
    source?.close()
    source = undefined
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
