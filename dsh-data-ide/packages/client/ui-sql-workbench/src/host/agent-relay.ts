/**
 * Host half of the agent delivery relay (docs/10 §13.1).
 *
 * MCP runs in its own stdio process and writes envelopes into a spool directory
 * (`mcp/agent-outbox.ts`). This module tails that directory, keeps a short
 * in-memory history for the polling fallback, and fans each envelope out to SSE
 * subscribers. A timer scan is used instead of `fs.watch` on purpose: watch is
 * unreliable on network home directories, and scanning a handful of files once a
 * second is cheap.
 *
 * Delivery is **at-least-once**: an envelope is removed only after it has been
 * fanned out, so a crash replays it rather than losing it, and two host
 * instances tailing the same spool may each deliver the same envelope. Applying
 * a delivery twice is idempotent (same label + same SQL updates one tab), which
 * makes duplication the cheap failure and loss the impossible one (review §15
 * A2/A4).
 */

import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { type AgentDelivery, parseDelivery } from '../execute/agent-delivery.ts'

export interface AgentDeliveryEvent {
  readonly seq: number
  readonly delivery: AgentDelivery
}

export type AgentDeliveryListener = (event: AgentDeliveryEvent) => void

export interface AgentRelay {
  subscribe(listener: AgentDeliveryListener): () => void
  /** Events newer than `seq`, for `GET /agent-results?since=`. */
  since(seq: number): readonly AgentDeliveryEvent[]
  /** Highest sequence handed out; the polling cursor. */
  readonly cursor: number
  dispose(): Promise<void>
}

export interface AgentRelayOptions {
  readonly dir: string
  /** Scan period; the spec says 1s, tests use a few ms. */
  readonly pollMs?: number
  /** How many events the polling fallback can replay. */
  readonly history?: number
  /** Envelopes older than this are dropped on startup (a host that never ran). */
  readonly staleAfterMs?: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Remove envelopes a crashed or never-started host left behind. */
async function sweepStale(dir: string, staleAfterMs: number): Promise<void> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.json'))
  } catch {
    return
  }
  const cutoff = Date.now() - staleAfterMs
  for (const name of names) {
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) await unlink(path)
    } catch {
      // Raced with another instance; nothing to do.
    }
  }
}

/**
 * Start tailing `dir`, creating nothing: the first labelled run creates the
 * spool (the MCP process owns it).
 */
export async function startAgentRelay(options: AgentRelayOptions): Promise<AgentRelay> {
  const { dir } = options
  const pollMs = options.pollMs ?? 1000
  const limit = options.history ?? 200
  const listeners = new Set<AgentDeliveryListener>()
  const ring: AgentDeliveryEvent[] = []
  let seq = 0
  let scanning = false
  let disposed = false

  // Finish the startup sweep before the first scan. Running both concurrently
  // can fan out an expired envelope just before the sweep removes it.
  await sweepStale(dir, options.staleAfterMs ?? DAY_MS)

  async function scan(): Promise<void> {
    if (scanning || disposed) return
    scanning = true
    try {
      const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
      for (const name of names) {
        const path = join(dir, name)
        let delivery: AgentDelivery | null = null
        try {
          delivery = parseDelivery(JSON.parse(await readFile(path, 'utf8')))
        } catch {
          delivery = null
        }
        if (delivery === null) {
          // Corrupt or half-written: drop it rather than block the queue.
          // `allSettled` preserves best-effort deletion without adding a branch
          // whose failure requires a filesystem race to reproduce reliably.
          await Promise.allSettled([unlink(path)])
          continue
        }
        seq += 1
        const event: AgentDeliveryEvent = { seq, delivery }
        ring.push(event)
        if (ring.length > limit) ring.shift()
        for (const listener of listeners) {
          try {
            listener(event)
          } catch {
            // A broken subscriber must not stall the relay.
          }
        }
        // Only now: a crash above replays this envelope instead of losing it.
        await unlink(path).catch(() => undefined)
      }
    } catch {
      // Spool not created yet — the first labelled run creates it.
    } finally {
      scanning = false
    }
  }

  const timer = setInterval(() => void scan(), pollMs)
  timer.unref()
  void scan()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    since(cursor) {
      return ring.filter(event => event.seq > cursor)
    },
    get cursor() {
      return seq
    },
    async dispose() {
      disposed = true
      clearInterval(timer)
      listeners.clear()
    },
  }
}
