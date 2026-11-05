import { realpathSync } from 'node:fs'
import type { BridgeAuthorization } from './bridge.js'
import type { HostAgent, HostAgentContext } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import type { JsonStore } from './jsonstore.js'

/** Issued only by the local personal channel's committed device pairing. */
export interface PersonalAuthority {
  readonly identity: DingTalkIdentity
  readonly bindingId: string
  readonly profile: string
  readonly signal: AbortSignal
}

export interface WorkspaceSessionOwner {
  readonly version: 1
  readonly identity: DingTalkIdentity
  readonly bindingId: string
  readonly profile: string
  readonly scopeKey: string
  readonly cwd: string
}

interface Grant {
  readonly agent: HostAgent
  readonly ctx: HostAgentContext
  readonly admission: BridgeAuthorization
  readonly authority: PersonalAuthority
  readonly selection: AbortController
  readonly owner: WorkspaceSessionOwner
  readonly controller: AbortController
  ready: boolean
}

interface ToolDispatch {
  readonly agent?: HostAgent
  signal: AbortSignal
}
interface DispatchContext {
  on(
    name: 'tools/execute',
    listener: (exec: ToolDispatch, next: () => Promise<unknown>) => Promise<unknown>,
    options?: { prepend: boolean },
  ): () => void
}

/** Local profile owner delegation, not a second workspace ACL or DWS grant. */
export class WorkspaceToolPolicy {
  private readonly grants = new WeakMap<HostAgent, Grant>()
  private readonly selections = new Map<string, AbortController>()
  private readonly active = new Map<string, Grant>()
  private closed = false

  constructor(
    private readonly options: {
      authority(): PersonalAuthority | undefined
      selectedWorkspace(scopeKey: string): string
      bindings: Pick<JsonStore<string>, 'get'>
      owners: Pick<JsonStore<WorkspaceSessionOwner>, 'get' | 'set'>
    },
  ) {}

  /** Snapshot before any inbound await, including commands with an invalid cwd. */
  receipt(scopeKey: string): AbortSignal {
    if (this.closed) throw new Error('im_channel_authorization_changed')
    let selection = this.selections.get(scopeKey)
    if (!selection) this.selections.set(scopeKey, (selection = new AbortController()))
    return selection.signal
  }

  /** Human session/workspace changes withdraw old work and queued admissions. */
  invalidate(scopeKey: string): void {
    this.selections.get(scopeKey)?.abort()
    this.selections.set(scopeKey, new AbortController())
  }

  close(): void {
    this.closed = true
    for (const grant of this.active.values()) grant.controller.abort()
    for (const selection of this.selections.values()) selection.abort()
    this.active.clear()
  }

  capture(message: unknown, scopeKey: string, selected: string, captured?: PersonalAuthority): BridgeAuthorization {
    this.receipt(scopeKey)
    const authority = captured ?? this.options.authority()
    if (!authority || authority.signal.aborted || !sameIdentity(messageIdentity(message), authority.identity))
      throw new Error('im_channel_authorization_unavailable')
    const cwd = realpathSync(selected)
    let selection = this.selections.get(scopeKey)
    if (!selection) this.selections.set(scopeKey, (selection = new AbortController()))
    const lease = selection
    const owner: WorkspaceSessionOwner = Object.freeze({
      version: 1,
      identity: Object.freeze({ ...authority.identity }),
      bindingId: authority.bindingId,
      profile: authority.profile,
      scopeKey,
      cwd,
    })
    const matches = (value: WorkspaceSessionOwner | undefined) =>
      !!value &&
      value.version === 1 &&
      value.bindingId === owner.bindingId &&
      value.profile === owner.profile &&
      value.scopeKey === scopeKey &&
      value.cwd === cwd &&
      sameIdentity(value.identity, owner.identity)
    const check = () => {
      const current = this.options.authority()
      if (
        this.closed ||
        !current ||
        authority.signal.aborted ||
        current.signal !== authority.signal ||
        lease.signal.aborted ||
        current.bindingId !== authority.bindingId ||
        current.profile !== authority.profile ||
        !sameIdentity(current.identity, authority.identity)
      )
        throw new Error('im_channel_authorization_changed')
      if (realpathSync(selected) !== cwd || realpathSync(this.options.selectedWorkspace(scopeKey)) !== cwd)
        throw new Error('im_workspace_changed')
    }
    const checkContext = (ctx: HostAgentContext, agent: HostAgent) => {
      check()
      const session = agent.session
      const host = ctx as HostAgentContext & { get?(name: string): unknown }
      const directory = host.get?.('workingDirectory') as { get(session: object): string } | undefined
      if (
        !session ||
        session.id !== agent.id ||
        !session.header.cwd ||
        !directory?.get ||
        realpathSync(session.header.cwd) !== cwd ||
        realpathSync(directory.get(session)) !== cwd
      )
        throw new Error('im_workspace_context_unavailable')
    }
    const admission: BridgeAuthorization = {
      cwd,
      check,
      canReuse: (agent) => {
        const grant = this.grants.get(agent)
        return (
          !!grant && grant.authority.signal === authority.signal && grant.selection === lease && this.allowed(agent)
        )
      },
      canResume: (id) => {
        check()
        return matches(this.options.owners.get(id))
      },
      checkAgent: (agent) => {
        check()
        if (!admission.canReuse(agent)) throw new Error('im_session_owner_mismatch')
      },
      setup: (ctx, agent, restoring) => {
        checkContext(ctx, agent)
        if (restoring && !matches(this.options.owners.get(agent.id))) throw new Error('im_session_owner_mismatch')
        const grant: Grant = {
          agent,
          ctx,
          admission,
          authority,
          selection: lease,
          owner,
          controller: new AbortController(),
          ready: false,
        }
        this.grants.set(agent, grant)
        // The host may schedule dispatch after its guard/approval phase. Check
        // again here, and keep channel/session cancellation attached to the body.
        ;(ctx as unknown as DispatchContext).on(
          'tools/execute',
          async (exec, next) => {
            if (exec.agent !== agent || !this.allowed(agent)) throw new Error('im_channel_authorization_changed')
            const previous = exec.signal
            exec.signal = AbortSignal.any([previous, authority.signal, lease.signal, grant.controller.signal])
            try {
              return await next()
            } finally {
              exec.signal = previous
            }
          },
          { prepend: true },
        )
        return {
          commit: () => {
            checkContext(ctx, agent)
            if (restoring && !matches(this.options.owners.get(agent.id))) throw new Error('im_session_owner_mismatch')
            this.options.owners.set(agent.id, owner)
            this.active.get(agent.id)?.controller.abort()
            this.active.set(agent.id, grant)
            grant.ready = true
          },
        }
      },
    }
    check()
    return admission
  }

  /** Synchronous final guard: no cached DWS identity or async permission window. */
  allowed(agent: HostAgent): boolean {
    const grant = this.grants.get(agent)
    if (
      !grant?.ready ||
      grant.ctx !== agent.ctx ||
      grant.controller.signal.aborted ||
      this.active.get(agent.id) !== grant
    )
      return false
    try {
      grant.admission.check()
      const session = agent.session
      const directory = (grant.ctx as HostAgentContext & { get?(name: string): unknown }).get?.('workingDirectory') as
        { get(session: object): string } | undefined
      const owner = this.options.owners.get(agent.id)
      return (
        this.options.bindings.get(owner?.scopeKey ?? '') === agent.id &&
        !!owner &&
        owner.version === 1 &&
        owner.scopeKey === grant.owner.scopeKey &&
        owner.bindingId === grant.authority.bindingId &&
        owner.profile === grant.authority.profile &&
        sameIdentity(owner.identity, grant.authority.identity) &&
        owner.cwd === grant.admission.cwd &&
        !!session &&
        session.id === agent.id &&
        !!session.header.cwd &&
        !!directory?.get &&
        realpathSync(session.header.cwd) === owner.cwd &&
        realpathSync(directory.get(session)) === owner.cwd
      )
    } catch {
      return false
    }
  }
}
