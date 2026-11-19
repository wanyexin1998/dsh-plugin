import type { HostAgent, HostAgentContext, HostToolDefinition } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import { reviewedQueryTool } from './relay/connection-config.js'
import type { ChannelBinding } from './relay/client.js'
import { employeeWorkspaceTool } from './employee-workspace.js'
import type { EmployeeChannelTools, EmployeeToolHost, ToolCall } from './employee-channel-tools.js'
import type { ScheduleCreationTiming } from './native-schedules.js'

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
type QueryRelay = {
  status?(): { mode?: string }
  enterpriseQueries?(message: unknown): Grant | undefined
}
type Scope = {
  agent: HostAgent
  relay?: QueryRelay
  grant?: Grant
  identity?: DingTalkIdentity
  audience?: Audience | null
  scheduled?: Grant
  refresh(): boolean
}
type QueryHost = {
  get?(name: string): unknown
  on(
    name: 'tools/execute',
    listener: (exec: ToolCall & { signal: AbortSignal }, next: () => Promise<unknown>) => Promise<unknown>,
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
const mediaTools = new Set(['send_file', 'send_image'])

export class ImTools {
  private readonly scopes = new WeakMap<HostAgentContext, Scope>()

  constructor(
    private readonly factory: () => ImToolFactory | undefined,
    private readonly workspace?: { allowed(agent: HostAgent): boolean },
    private readonly canSendAttachment?: (agent: HostAgent) => boolean,
    private readonly employeeTools?: EmployeeChannelTools,
    private readonly scheduleCreationTiming?: (agent: HostAgent) => ScheduleCreationTiming | undefined,
  ) {}

  install(ctx: HostAgentContext, agent: HostAgent): void {
    const installed = this.scopes.get(ctx)
    if (installed) {
      if (installed.agent !== agent) throw new Error('im_agent_changed')
      return
    }
    const tools = ctx.tools as HostAgentContext['tools'] & {
      guard?: (fn: (execution: ToolCall) => string | undefined) => () => void
      schemas?: (agent: HostAgent) => readonly { name: string }[]
      restrict?: (filter: { allow: readonly string[] }) => () => void
      presentAs?: (mode: 'native') => () => void
    }
    if (!tools.guard || !tools.schemas || !tools.restrict || !tools.presentAs)
      throw new Error('im_tool_boundary_unavailable')
    const restrict = tools.restrict.bind(tools)
    const schemas = tools.schemas.bind(tools)
    const factory = this.factory()
    if (!factory) throw new Error('im_connection_service_unavailable')
    const host = ctx as HostAgentContext & QueryHost
    const relay = host.get?.('dingtalkRelay') as QueryRelay | undefined
    const enterprise = relay?.status?.().mode === 'enterprise'
    const canQuery = (!this.workspace || enterprise) && typeof relay?.enterpriseQueries === 'function'
    let liftRestriction: (() => void) | undefined
    let unregisterDirectory: (() => void) | undefined
    const employeeTools = this.employeeTools
    const scope: Scope = {
      agent,
      relay: canQuery ? relay : undefined,
      refresh() {
        liftRestriction?.()
        // Channel-owned tools are registered separately in the Agent's layer.
        unregisterDirectory?.()
        unregisterDirectory = undefined
        const inherited = schemas(agent).map(({ name }) => name)
        const allow = inherited
          .filter((name) => name !== 'dingtalk_call' && name !== 'ask_user_question' && !mediaTools.has(name))
          .filter((name) => denial(name) === undefined)
        liftRestriction = restrict({ allow })
        if (employeeTools && allow.includes('working_directory'))
          unregisterDirectory = tools.register(employeeTools.workingDirectory(agent))
        return denial('send_file') === undefined
      },
    }
    const prepared = new WeakMap<object, AbortSignal>()
    const bindingFor = (name: string) => {
      if (scope.scheduled) return scope.scheduled(name)
      if (!canQuery || !scope.audience || !scope.identity) return undefined
      const binding = scope.grant?.(name)
      return binding && !binding.signal.aborted && sameIdentity(scope.identity, binding.identity) ? binding : undefined
    }
    const denial = (name: string, args?: unknown): string | undefined => {
      if (this.workspace && !this.workspace.allowed(agent)) return 'im_channel_authorization_changed'
      if (name === 'schedule_create') {
        const timing = !scope.scheduled && this.scheduleCreationTiming?.(agent)
        if (!timing) return 'im_schedule_private_required'
        if (
          timing === 'once' &&
          args &&
          typeof args === 'object' &&
          ['every_seconds', 'daily', 'weekly', 'cron'].some((key) => key in args)
        )
          return 'im_schedule_once_required: 用户只要求执行一次。本次未创建任务，请改用 after_seconds 或 at 重试。'
        return undefined
      }
      if (
        scope.scheduled &&
        (mediaTools.has(name) ||
          [
            'dingtalk_call',
            'ask_user_question',
            'working_directory',
            'exit_plan_mode',
            'present',
            'visualize',
          ].includes(name))
      )
        return 'im_scheduled_live_reply_unavailable'
      if (employeeTools && employeeWorkspaceTool(name)) {
        const reason = employeeTools.workspace.reason({ name, agent, arguments: args })
        if (reason) return reason
        const changingDirectory = name === 'working_directory' && args && typeof args === 'object' && 'cd' in args
        if (
          (changingDirectory || name === 'exit_plan_mode' || name === 'present' || name === 'visualize') &&
          !employeeTools.privateRoute(agent)
        )
          return 'im_private_reply_required'
        if (name === 'visualize' && !employeeTools.origin) return 'im_visualization_link_unavailable'
        return undefined
      }
      if (mediaTools.has(name))
        return this.workspace && this.canSendAttachment?.(agent)
          ? undefined
          : 'im_tool_unavailable: im_file_transfer_unavailable'
      if (name === 'subagent' || name === 'spawn_agent')
        return 'im_tool_unavailable: im_subagent_inheritance_unavailable'
      if (
        this.workspace &&
        (workspaceTools.has(name) || (this.canSendAttachment && name === 'load_workspace_dependencies'))
      )
        return undefined
      if (['dingtalk_call', 'skill', 'ask_user_question'].includes(name)) return undefined
      if (canQuery && reviewedQueryTool(name)) {
        return bindingFor(name) ? undefined : queryDenied
      }
      if (this.workspace) return 'im_tool_unavailable: im_tool_inheritance_unreviewed'
      // DSH 0.2.1-rc.5 supplies cwd/preset composition, not a trusted
      // principal -> workspace entitlement contract. Keep this fail closed.
      return 'im_tool_unavailable: im_workspace_policy_unavailable: 宿主未提供可信用户与工作区权限绑定，无法安全继承此工具。'
    }
    // Shadow the inherited Web tool in this Agent, before permitting its name.
    const tool = factory.createTool(
      () => scope.identity,
      () => ({ approval: host.get?.('approval'), workingDirectory: host.get?.('workingDirectory') }),
    )
    const unregister = tools.register({
      ...tool,
      ...(this.canSendAttachment
        ? {
            description: `${tool.description} 当前工作区生成的文件或图片请在企业机器人私聊使用 send_file 或 send_image 回传；DWS Connector 不能读取该路径。`,
          }
        : {}),
      execute: (args, exec) => {
        // A shadow inherited by another scope must never borrow this Agent's
        // identity, even if that scope does not execute our guard.
        if (exec.agent !== agent) return Promise.reject(new Error('im_agent_mismatch'))
        if (scope.scheduled) return Promise.reject(new Error('im_scheduled_live_reply_unavailable'))
        if (this.workspace && !this.workspace.allowed(agent))
          return Promise.reject(new Error('im_channel_authorization_changed'))
        return tool.execute(args, exec)
      },
    })
    let unregisterQuery: (() => void) | undefined
    let unregisterProjection: (() => void) | undefined
    let unregisterGuard: (() => void) | undefined
    let restorePresentation: (() => void) | undefined
    try {
      if (employeeTools) unregisterProjection = employeeTools.install(ctx as HostAgentContext & EmployeeToolHost, agent)
      if (canQuery || employeeTools) {
        // Host approval/scheduling can separate tool selection from execution.
        unregisterQuery = host.on(
          'tools/execute',
          async (exec, next) => {
            if (
              (employeeTools && employeeWorkspaceTool(exec.name)) ||
              exec.name === 'schedule_create' ||
              !!scope.scheduled
            ) {
              const reason = exec.agent === agent ? denial(exec.name, exec.arguments) : 'im_agent_mismatch'
              if (reason) throw new Error(reason)
            }
            if (!reviewedQueryTool(exec.name) || !canQuery) return next()
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
      unregisterGuard = tools.guard((exec) => {
        if (exec.agent !== agent) return 'im_agent_mismatch'
        const reason = denial(exec.name, exec.arguments)
        if (reason !== undefined) return reason
        if (reviewedQueryTool(exec.name)) {
          const binding = bindingFor(exec.name)
          if (!binding) return queryDenied
          prepared.set(exec, binding.signal)
        }
        return undefined
      })
      // PTC transport is outside the inherited registry mask and is unavailable in this channel.
      restorePresentation = tools.presentAs('native')
      liftRestriction = restrict({ allow: [] })
    } catch (error) {
      restorePresentation?.()
      unregisterGuard?.()
      unregisterQuery?.()
      unregisterProjection?.()
      unregister()
      throw error
    }
    this.scopes.set(ctx, scope)
  }

  bind(ctx: HostAgentContext, message: unknown, agent: HostAgent, bindAttachment?: () => void): boolean {
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
    bindAttachment?.()
    return scope.refresh()
  }

  /** Refresh the model tool list for the exact Agent turn that claimed a native input. */
  turn(agent: HostAgent, scheduled?: Grant): void {
    const scope = this.scopes.get(agent.ctx)
    if (!scope || scope.agent !== agent) return
    scope.scheduled = scheduled
    scope.refresh()
  }
}
