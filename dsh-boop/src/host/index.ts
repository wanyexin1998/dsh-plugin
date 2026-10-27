/**
 * BOOP host runtime (plugin main half).
 *
 * Frozen architecture (03§01, 03§05):
 *  - modular monolith inside the DSH Host; no second harness, no external process;
 *  - lifecycle order: version/data-domain check -> DB -> scope lease ->
 *    RECOVERY GATE FIRST (before any managed agent resolves) -> tools/api/ui ->
 *    outbox reconciliation -> main chat on demand -> channels only when enabled;
 *  - a failed optional activation must warn, never break the host boot.
 *
 * Implemented so far: rc.2 surface probe (E00-01), the startup recovery gate and
 * proxy-message provenance (E00-02). Storage lands with E01-01 (E00-03 verified
 * the driver). Write dispatch stays disabled until the required gates pass.
 */

import { probeHostSurface, type ProbeResult } from './probe.ts'
import {
  FROZEN_GATES,
  gateMap,
  writeModeStatus,
  type GateState,
  type WriteModeStatus,
} from './gates.ts'
import { BoopStorage, type StorageFacts } from './persistence/storage.ts'
import { LedgerCursorStore, SourceObserver, type SourceReader } from './observe/observer.ts'
import { HostSourceReader } from './observe/host-reader.ts'
import { RecoveryGate } from './gate/recovery-gate.ts'
import {
  buildProxyMessage,
  newActionId,
  payloadHash,
  PROXY_SOURCE_KIND,
} from './transport/command-envelope.ts'
import { apply as applyClosedChannels } from './channels-api.ts'
import { readHostIdentity } from './host-identity.ts'

export const name = 'dsh-boop'

/** Nothing is required at M0: a missing optional surface is recorded, not fatal. */
export const inject: string[] = []

export interface BoopRuntimeState {
  schemaVersion: 1
  product: 'BOOP'
  dshProfileVersion: string
  dshCommit: string
  /** Derived from the frozen gate ledger — never set by hand. */
  writeModeEnabled: boolean
  /** Why write mode is on/off right now (blocked gates + note). */
  writeMode: WriteModeStatus
  /** The recovery gate is armed before any managed agent could resolve. */
  recoveryGateArmed: boolean
  gates: Record<string, GateState>
  probe: ProbeResult | null
  /** Storage facts once the ledger is open (E01-01). */
  storage: StorageFacts | null
}

export function apply(ctx: any): void {
  // Activation must never throw: a throwing host half would be reported and
  // skipped, but the rest of the tree keeps running. Everything below is
  // guarded and recorded instead.
  try {
    const gates = gateMap()
    const writeMode = writeModeStatus()
    const hostIdentity = readHostIdentity()
    const state: BoopRuntimeState = {
      schemaVersion: 1,
      product: 'BOOP',
      // engines.dsh admits the rc.2 web payload and the rc.3 desktop build.
      // This string is the process that actually loaded the plugin.
      dshProfileVersion: hostIdentity.version,
      dshCommit: hostIdentity.commit,
      // Derived from the frozen gate ledger (src/host/gates.ts): today G01/G02
      // are PASS, the rest are NOT_RUN/BLOCKED, so every production write stays
      // fail-closed. Changing this requires evidence, not a switch.
      writeModeEnabled: writeMode.enabled,
      writeMode,
      recoveryGateArmed: true,
      gates,
      probe: null,
      storage: null,
    }

    /**
     * Host services register by availability, not by row order: at BOOP's
     * activation the rest of the tree is often still mounting. The surface is
     * probed on first read (after boot) and then memoized for the process, so
     * the capability matrix describes the settled composition rather than
     * BOOP's own activation moment.
     */
    let probe: ProbeResult | null = null
    const surfaced = (): ProbeResult => (probe ??= probeHostSurface(ctx))

    // ── Startup recovery gate, armed first (03§05 step 4, G04) ──────────────
    const gate = new RecoveryGate((event, detail) => {
      try {
        ctx.logger?.info?.(`[boop] ${event}`, detail)
      } catch {
        /* logging must never break the gate */
      }
    })
    gate.arm()

    // ── Ledger + single-writer lease (03§05: DB → scope lease → gate) ───
    // Opening the ledger is best-effort: a storage failure must degrade BOOP to
    // read-only diagnostics, never break the native Host boot.
    let storage: BoopStorage | null = null
    try {
      // `dshHomePath()` resolves $DSH_HOME; the ledger lives in `$DSH_HOME/boop`,
      // never under the working directory, so every project shares one ledger.
      const dshHome = ctx.dshHomePath?.()
      storage = new BoopStorage({ dshHome, directoryName: 'boop' })
      state.storage = storage.start()
      // Write mode follows the frozen gate ledger AND the single-writer lease.
      // Either one missing keeps every production write fail-closed.
      const leaseHeld = state.storage?.ok === true && state.storage.lease.held === true
      state.writeModeEnabled = writeMode.enabled && leaseHeld
    } catch (error) {
      // Storage failure is recorded, not swallowed: diagnostics must be able to
      // say WHY BOOP is read-only.
      state.storage = {
        ok: false,
        path: '',
        schemaVersion: null,
        sqliteVersion: '',
        wal: false,
        migration: null,
        lease: { held: false, holder: '', fencingToken: 0, released: false },
        scope: { scopeId: '', ownerId: '', dshHomeFingerprint: '' },
        error: error instanceof Error ? error.message : String(error),
      }
      try {
        ctx.logger?.warn?.('[boop] ledger unavailable; BOOP stays read-only', error)
      } catch {
        /* never break activation from storage */
      }
    }

    // ── Proxy provenance registry: message ids this process minted ─────────
    const proxyMessages = new Set<string>()

    ctx.provide('boop', {
      state(): BoopRuntimeState {
        state.probe = surfaced()
        return state
      },
      capabilities(): Record<string, boolean> {
        const out: Record<string, boolean> = {}
        for (const entry of surfaced().matrix) out[entry.name] = entry.present
        return out
      },
      isWriteModeEnabled(): boolean {
        return state.writeModeEnabled
      },
      writeMode(): WriteModeStatus {
        return state.writeMode
      },
      gates(): Record<string, GateState> {
        return state.gates
      },
      gate(): RecoveryGate {
        return gate
      },
      storage(): BoopStorage | null {
        return storage
      },
      observer(): SourceObserver | null {
        return observer
      },
      sourceReader(): HostSourceReader | null {
        return observedReader
      },
      proxyMessageIds(): string[] {
        return [...proxyMessages]
      },
      proxySourceKind: PROXY_SOURCE_KIND,
      /**
       * Build one proxy command envelope with host-minted identity.
       *
       * Provenance never comes from message text: the source envelope and the
       * message-id registry both come from the host adapter, so a model cannot
       * forge an action id (03§08).
       */
      prepareProxyCommand(input: {
        scopeId: string
        taskId: string
        taskVersion: number
        targetSessionId: string
        instruction: string
        mode: 'queue' | 'steer'
        initiatorRef: string
        policyEpoch: number
      }): { message: unknown; actionId: string; messageId: string; payloadHash: string } {
        const actionId = newActionId()
        const messageId = `msg_${actionId}`
        const hash = payloadHash(input)
        const envelope = {
          scopeId: input.scopeId,
          taskId: input.taskId,
          taskVersion: input.taskVersion,
          actionId,
          messageId,
          policyEpoch: input.policyEpoch,
          payloadHash: hash,
          initiatorRef: input.initiatorRef,
          instruction: input.instruction,
          mode: input.mode,
        }
        const { message } = buildProxyMessage({ envelope, targetSessionId: input.targetSessionId })
        proxyMessages.add(messageId)
        gate.track({
          sessionId: input.targetSessionId,
          actionId,
          messageId,
          reason: 'command created in this process',
        })
        return { message, actionId, messageId, payloadHash: hash }
      },
    })

    // ── Whole-domain light observation (E03-01) ───────────────────────────
    // Read-only: discovery and incremental reads go through ctx.sessionQuery,
    // which never creates or wakes an Agent. BOOP writes only its own cursors.
    let observer: SourceObserver | null = null
    let observedReader: HostSourceReader | null = null
    if (storage) {
      observedReader = new HostSourceReader(ctx)
      observer = new SourceObserver(
        storage.identity.scopeId,
        observedReader as unknown as SourceReader,
        new LedgerCursorStore(storage.repo),
      )
    }

    ctx.effect(() => () => storage?.close(), 'boop: storage disposal')

    // Channels stay on this same package row. A separate ./lib/*.js loader
    // entry is also resolved as package dsh-boop and rc.2.1 client-modules
    // then refuses to boot (two client sources for one package).
    applyClosedChannels(ctx)

    ctx.logger?.info?.(
      `[boop] runtime armed: recovery gate on, write mode off, ledger=${
        state.storage ? `${state.storage.path} (lease ${state.storage.lease.held ? 'held' : 'not held'})` : 'unavailable'
      }`,
    )
  } catch (error) {
    try {
      ctx.logger?.warn?.('[boop] runtime arm failed; host continues in native mode', error)
    } catch {
      /* logging itself must never break activation */
    }
  }
}
