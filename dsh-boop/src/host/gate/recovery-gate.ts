/**
 * Startup recovery gate (G04, AT-26/AT-27, RK-03).
 *
 * Frozen requirement (03§05 step 4, 03§09): the gate must be armed BEFORE any
 * managed agent could resume, and a BOOP command left pending in a native
 * inbox across a Host restart must never execute on its own.
 *
 * rc.2 mechanism used here (verified on the installed payload):
 *  - the agent inbox is a DURABLE projection rebuilt from `agent/inbox/spliced`
 *    events, so a pending proxy command really does survive a restart;
 *  - a turn is only opened by a wake, and `agent/pre-step` is a waterfall that
 *    can reject the step BEFORE any model request, tool, or side effect
 *    (the shipped archived-session gate uses the same seam);
 *  - `agent/inbox/claimed` reports each claimed message with its turn.
 *
 * The gate is therefore fail-closed: unknown = blocked, and release requires an
 * explicit, audited human action.
 */

export interface GateEntry {
  sessionId: string
  actionId: string
  messageId: string
  state: 'blocked' | 'released'
  reason: string
}

export interface GateDecision {
  allow: boolean
  reason?: string
}

export class RecoveryGate {
  private armed = false
  private entries = new Map<string, GateEntry>()
  private readonly onAudit: (event: string, detail: Record<string, unknown>) => void

  /** Arm the gate; called during BOOP activation, before dispatch services. */
  constructor(onAudit: (event: string, detail: Record<string, unknown>) => void) {
    this.onAudit = onAudit
  }

  isArmed(): boolean {
    return this.armed
  }

  /** Arming records the current process run; nothing is auto-released. */
  arm(): void {
    this.armed = true
    this.onAudit('gate/armed', {})
  }

  /** Record a command BOOP has placed into a native inbox. */
  track(input: { sessionId: string; actionId: string; messageId: string; reason: string }): GateEntry {
    const entry: GateEntry = { ...input, state: 'blocked' }
    this.entries.set(input.messageId, entry)
    this.onAudit('gate/tracked', { sessionId: input.sessionId, actionId: input.actionId })
    return entry
  }

  list(): GateEntry[] {
    return [...this.entries.values()]
  }

  /**
   * Release specific commands for explicit execution. Everything else stays
   * blocked — the gate never bulk-releases.
   */
  release(messageIds: string[]): GateEntry[] {
    const released: GateEntry[] = []
    for (const id of messageIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      entry.state = 'released'
      released.push(entry)
      this.onAudit('gate/released', { actionId: entry.actionId, sessionId: entry.sessionId })
    }
    return released
  }

  /** Reset the process run: everything returns to blocked. */
  disarmForRestart(): void {
    for (const entry of this.entries.values()) entry.state = 'blocked'
    this.armed = false
  }

  /**
   * The `agent/pre-step` decision for one claimed turn.
   *
   * `claimed` are the messages the loop just claimed for this turn. Any
   * BOOP-owned message that is not explicitly released blocks the step.
   */
  decide(claimed: ReadonlyArray<unknown>): GateDecision {
    if (!this.armed) {
      // Fail closed: an unarmed gate must not silently allow business.
      return { allow: false, reason: 'boop recovery gate is not armed' }
    }
    const byId = new Map(this.entries)
    for (const message of claimed) {
      const id = (message as { id?: unknown })?.id
      const source = (message as { source?: { kind?: unknown } })?.source
      const owned =
        (typeof id === 'string' && byId.has(id)) ||
        (source?.kind === 'boop-command' && typeof id === 'string')
      if (!owned) continue
      const entry = typeof id === 'string' ? byId.get(id) : undefined
      const entryId = entry?.messageId ?? id
      const released = this.entries.get(entryId)?.state === 'released'
      if (!released) {
        return {
          allow: false,
          reason: 'a BOOP command from a previous run is pending; explicit recovery is required',
        }
      }
    }
    return { allow: true }
  }
}
