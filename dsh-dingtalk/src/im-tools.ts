import type { HostAgent, HostAgentContext, HostToolDefinition } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import { reviewedQueryTool } from './relay/connection-config.js'
import type { ChannelBinding } from './relay/client.js'

// Reviewed ordinary tools in the pinned DSH 0.2.1-rc.5 profile. Unknown tools
// may start Agents outside this scope (workflow/ralph/custom delegation names),
// so registration alone cannot prove that they retain the channel boundary.
const workspaceTools = new Set([
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
  'str_replace_editor',
  'bash',
  'pwsh',
  'job_output',
  'job_list',
  'job_kill',
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
])

/** Structural bridge between the independently built channel and Web extension. */
export interface ImToolFactory {
  identity?(): DingTalkIdentity | undefined
  createTool(identity: () => DingTalkIdentity | undefined, host: () => object): HostToolDefinition
}

type Audience = { kind: 'direct' | 'group'; id: string }
type Grant = (name: string) => ChannelBinding | undefined
type QueryRelay = { enterpriseQueries?(message: unknown): Grant | undefined }
type Scope = {
  agent: HostAgent
  relay?: QueryRelay
  grant?: Grant
  identity?: DingTalkIdentity
  audience?: Audience | null
}
type QueryHost = {
  get?(name: string): unknown
  on(
    name: 'tools/execute',
    listener: (
      exec: { name: string; agent?: HostAgent; signal: AbortSignal },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
    options: { prepend: boolean },
  ): () => void
}

function audienceOf(message: unknown): Audience | null {
  if (!message || typeof message !== 'object') return null
  const { conversationType, conversationId } = message as Record<string, unknown>
  return (conversationType === 'direct' || conversationType === 'group') &&
    typeof conversationId === 'string' &&
    conversationId.length > 0
    ? { kind: conversationType, id: conversationId }
    : null
}

const queryDenied = 'im_enterprise_query_unavailable: 请检查本人的机器人连接，或联系管理员核对该席位启用的查询工具。'

export class ImTools {
  private readonly scopes = new WeakMap<HostAgentContext, Scope>()

  constructor(
    private readonly factory: () => ImToolFactory | undefined,
    private readonly workspace?: { allowed(agent: HostAgent): boolean },
  ) {}

  install(ctx: HostAgentContext, agent: HostAgent): void {
    const installed = this.scopes.get(ctx)
    if (installed) {
      if (installed.agent !== agent) throw new Error('im_agent_changed')
      return
    }
    const tools = ctx.tools as HostAgentContext['tools'] & {
      guard?: (fn: (execution: { name: string; agent?: HostAgent }) => string | undefined) => () => void
    }
    if (!tools.guard) throw new Error('im_tool_boundary_unavailable')
    const factory = this.factory()
    if (!factory) throw new Error('im_connection_service_unavailable')
    const host = ctx as HostAgentContext & QueryHost
    const relay = host.get?.('dingtalkRelay') as QueryRelay | undefined
    const canQuery = !this.workspace && typeof relay?.enterpriseQueries === 'function'
    const scope: Scope = { agent, relay: canQuery ? relay : undefined }
    const prepared = new WeakMap<object, AbortSignal>()
    const bindingFor = (name: string) => {
      if (!canQuery || !scope.audience || !scope.identity) return undefined
      const binding = scope.grant?.(name)
      return binding && !binding.signal.aborted && sameIdentity(scope.identity, binding.identity) ? binding : undefined
    }
    // Shadow the inherited Web tool in this Agent, before permitting its name.
    const tool = factory.createTool(
      () => scope.identity,
      () => ({ approval: host.get?.('approval'), workingDirectory: host.get?.('workingDirectory') }),
    )
    const unregister = tools.register({
      ...tool,
      execute: (args, exec) => {
        // A shadow inherited by another scope must never borrow this Agent's
        // identity, even if that scope does not execute our guard.
        if (exec.agent !== agent) return Promise.reject(new Error('im_agent_mismatch'))
        if (this.workspace && !this.workspace.allowed(agent))
          return Promise.reject(new Error('im_channel_authorization_changed'))
        return tool.execute(args, exec)
      },
    })
    let unregisterQuery: (() => void) | undefined
    try {
      if (canQuery) {
        // Host approval/scheduling can separate tool selection from execution.
        unregisterQuery = host.on(
          'tools/execute',
          async (exec, next) => {
            if (!reviewedQueryTool(exec.name)) return next()
            const binding = exec.agent === agent && bindingFor(exec.name)
            if (!binding || prepared.get(exec) !== binding.signal) throw new Error(queryDenied)
            prepared.delete(exec)
            const original = exec.signal
            exec.signal = AbortSignal.any([original, binding.signal])
            try {
              return await next()
            } finally {
              exec.signal = original
              if (bindingFor(exec.name)?.signal !== binding.signal) throw new Error(queryDenied)
            }
          },
          { prepend: true },
        )
      }
      tools.guard((exec) => {
        if (exec.agent !== agent) return 'im_agent_mismatch'
        if (this.workspace && !this.workspace.allowed(agent)) return 'im_channel_authorization_changed'
        // Sending files has its own policy; a future workspace entitlement must
        // not implicitly open this channel's outbound file/image tools.
        if (exec.name === 'send_file' || exec.name === 'send_image')
          return 'im_tool_unavailable: im_file_transfer_unavailable'
        if (exec.name === 'subagent' || exec.name === 'spawn_agent')
          return 'im_tool_unavailable: im_subagent_inheritance_unavailable'
        if (this.workspace && workspaceTools.has(exec.name)) return undefined
        if (['dingtalk_call', 'skill', 'ask_user_question'].includes(exec.name)) return undefined
        if (this.workspace) return 'im_tool_unavailable: im_tool_inheritance_unreviewed'
        if (canQuery && reviewedQueryTool(exec.name)) {
          const binding = bindingFor(exec.name)
          if (!binding) return queryDenied
          prepared.set(exec, binding.signal)
          return undefined
        }
        // DSH 0.2.1-rc.5 supplies cwd/preset composition, not a trusted
        // principal -> workspace entitlement contract. Keep this fail closed.
        return 'im_tool_unavailable: im_workspace_policy_unavailable: 宿主未提供可信用户与工作区权限绑定，无法安全继承此工具。'
      })
    } catch (error) {
      unregisterQuery?.()
      unregister()
      throw error
    }
    this.scopes.set(ctx, scope)
  }

  bind(ctx: HostAgentContext, message: unknown, agent: HostAgent): void {
    this.install(ctx, agent)
    const scope = this.scopes.get(ctx)!
    const identity = messageIdentity(message)
    // Pin identity for the Agent lifetime. A delayed/overlapping turn must never
    // pick up another sender's credentials after a mutable session rebind.
    if (scope.identity && !sameIdentity(scope.identity, identity)) throw new Error('im_identity_changed')
    if (scope.relay) {
      const audience = audienceOf(message)
      if (scope.audience && (scope.audience.kind !== audience?.kind || scope.audience.id !== audience.id))
        throw new Error('im_conversation_changed')
      if (scope.audience === undefined) scope.audience = audience
      scope.grant = scope.relay.enterpriseQueries!(message)
    }
    scope.identity = identity
  }
}
