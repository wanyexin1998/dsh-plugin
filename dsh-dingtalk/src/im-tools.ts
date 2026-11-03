import type { HostAgentContext, HostToolDefinition } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'

/** Structural bridge between the independently built channel and Web extension. */
export interface ImToolFactory {
  identity?(): DingTalkIdentity | undefined
  createTool(identity: () => DingTalkIdentity | undefined, host: () => object): HostToolDefinition
}

export class ImTools {
  private readonly scopes = new WeakMap<HostAgentContext, { identity?: DingTalkIdentity }>()

  constructor(private readonly factory: () => ImToolFactory | undefined) {}

  install(ctx: HostAgentContext): void {
    if (this.scopes.has(ctx)) return
    const tools = ctx.tools as HostAgentContext['tools'] & {
      guard?: (fn: (execution: { name: string }) => string | undefined) => () => void
    }
    if (!tools.guard) throw new Error('im_tool_boundary_unavailable')
    const factory = this.factory()
    if (!factory) throw new Error('im_connection_service_unavailable')
    const scope: { identity?: DingTalkIdentity } = {}
    // Shadow the inherited Web tool in this Agent, before permitting its name.
    tools.register(
      factory.createTool(
        () => scope.identity,
        () => {
          const host = ctx as HostAgentContext & { get?(name: string): unknown }
          return { approval: host.get?.('approval'), workingDirectory: host.get?.('workingDirectory') }
        },
      ),
    )
    tools.guard((exec) =>
      ['dingtalk_call', 'skill', 'ask_user_question'].includes(exec.name)
        ? undefined
        : 'im_tool_unavailable: 此入口支持钉钉工具；本地执行请使用 DSH Web。',
    )
    this.scopes.set(ctx, scope)
  }

  bind(ctx: HostAgentContext, message: unknown): void {
    this.install(ctx)
    const scope = this.scopes.get(ctx)!
    const identity = messageIdentity(message)
    // Pin identity for the Agent lifetime. A delayed/overlapping turn must never
    // pick up another sender's credentials after a mutable session rebind.
    if (scope.identity && !sameIdentity(scope.identity, identity)) throw new Error('im_identity_changed')
    scope.identity = identity
  }
}
