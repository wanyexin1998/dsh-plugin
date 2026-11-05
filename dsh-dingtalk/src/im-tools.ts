import type { HostAgent, HostAgentContext, HostToolDefinition } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'

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
  // PTC nested dispatches still pass the same scoped host and channel guards.
  'run_code',
])

/** Structural bridge between the independently built channel and Web extension. */
export interface ImToolFactory {
  identity?(): DingTalkIdentity | undefined
  createTool(identity: () => DingTalkIdentity | undefined, host: () => object): HostToolDefinition
}

export class ImTools {
  private readonly scopes = new WeakMap<HostAgentContext, { agent: HostAgent; identity?: DingTalkIdentity }>()

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
    const scope: { agent: HostAgent; identity?: DingTalkIdentity } = { agent }
    // Shadow the inherited Web tool in this Agent, before permitting its name.
    const tool = factory.createTool(
      () => scope.identity,
      () => {
        const host = ctx as HostAgentContext & { get?(name: string): unknown }
        return { approval: host.get?.('approval'), workingDirectory: host.get?.('workingDirectory') }
      },
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
    try {
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
        // DSH 0.2.1-rc.5 supplies cwd/preset composition, not a trusted
        // principal -> workspace entitlement contract. Keep this fail closed.
        return 'im_tool_unavailable: im_workspace_policy_unavailable: 宿主未提供可信用户与工作区权限绑定，无法安全继承此工具。'
      })
    } catch (error) {
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
    scope.identity = identity
  }
}
