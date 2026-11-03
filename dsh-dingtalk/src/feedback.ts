import { saveState } from './relay/state.js'

export const feedbackEvents = [
  'renderer.agent-stream',
  'renderer.chunk',
  'renderer.text-delta',
  'renderer.turn-end',
  'renderer.fallback',
  'renderer.delivered',
  'card.create',
  'card.deliver',
  'card.update',
  'card.stream',
  'card.finish',
  'emotion.add',
  'emotion.recall',
  'emotion.done',
] as const
export type FeedbackEvent = (typeof feedbackEvents)[number]
export type FeedbackCode = 'ok' | 'permission' | 'rate_limit' | 'timeout' | 'transport' | 'rejected'
export type ObserveFeedback = (event: FeedbackEvent, success: boolean, code?: FeedbackCode) => void
export interface FeedbackEntry {
  success: number
  failure: number
  at: number
  code: FeedbackCode
}
/** Fixed categories only: never accepts message bodies, identifiers, URLs or upstream error text. */
export class FeedbackDiagnostics {
  private events: Partial<Record<FeedbackEvent, FeedbackEntry>> = {}
  private timer?: NodeJS.Timeout
  constructor(private file: string) {}
  observe: ObserveFeedback = (event, success, code = success ? 'ok' : 'transport') => {
    if (
      !feedbackEvents.includes(event) ||
      !['ok', 'permission', 'rate_limit', 'timeout', 'transport', 'rejected'].includes(code)
    )
      return
    const entry = this.events[event] ?? { success: 0, failure: 0, at: 0, code }
    entry[success ? 'success' : 'failure']++
    entry.at = Date.now()
    entry.code = code
    this.events[event] = entry
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, 500).unref()
  }
  snapshot() {
    return { pid: process.pid, events: structuredClone(this.events) }
  }
  private flush() {
    try {
      saveState(this.file, this.snapshot())
    } catch {
      /* Observability must not interrupt delivery. */
    }
  }
  close() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.flush()
  }
}
export function feedbackCode(status: number): FeedbackCode {
  return status === 401 || status === 403 ? 'permission' : status === 429 ? 'rate_limit' : 'rejected'
}
