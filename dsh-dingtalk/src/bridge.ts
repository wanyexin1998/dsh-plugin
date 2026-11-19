/**
 * The chat ↔ agent bridge: routes each DingTalk conversation to its DSH
 * session (persisted binding, resume on restart), injects inbound text as a
 * user message, and completes when the driven turn settles (the queue
 * serializes on that completion). Rendering lives in renderer.ts.
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentHandle,
  HostAgent,
  HostAgentContext,
  AgentSetup,
  AgentSetupCommit,
  HostAgentRegistry,
  ImageBlock,
  TextBlock,
} from './host.js'
import { sessionId } from './host.js'
import type { InboundContentPart, InboundMessage } from './stream.js'
import type { JsonStore } from './jsonstore.js'
import type { ModelOverride } from './commands.js'

/** conversationId → sessionId, persisted so a restarted host resumes the same session. */
export type Bindings = JsonStore<string>

export interface TurnRenderer {
  onInbound(sessionId: string, msg: InboundMessage): Promise<void | boolean>
}

/** Trusted channel-owned admission, captured before enqueue and rechecked at use. */
export interface BridgeAuthorization {
  readonly cwd: string
  check(): void
  checkAgent(agent: HostAgent): void
  canReuse(agent: HostAgent): boolean
  canResume(id: string): boolean
  setup(ctx: HostAgentContext, agent: HostAgent, restoring: boolean): AgentSetupCommit
}

export interface BridgeOptions {
  /** 数字员工不借用 Web UI 或其他 Channel 持有的运行实例。 */
  exclusiveOwnership?: boolean
  /** Keep the foreign Agent untouched and bind a fresh channel session instead. */
  recoverForeignSession?: boolean
  cwd: string
  authorize?(msg: InboundMessage, scopeKey: string, cwd: string): BridgeAuthorization
  log(line: string): void
  /** Per-conversation model override store (set via /model use). */
  modelOverrides: JsonStore<ModelOverride>
  /** Per-conversation workspace override store (set via /cd). */
  workspaceOverrides: JsonStore<string>
  /** Deployment default model route; undefined lets the host decide. */
  modelSelection(): { provider?: string; model?: string } | undefined
  /** Default agent-preset composition (tools); empty when the deployment has no roster. */
  compose(): Promise<{ agentPreset?: string; setup?: AgentSetup }>
  /** Refresh transport context for tools that wait on channel input. */
  onAgentMessage(agent: HostAgent, msg: InboundMessage, cwd: string): void | Promise<void>
  onFollowup?(agent: HostAgent, msg: InboundMessage, id: string, cwd: string): void
  extraContext?(msg: InboundMessage): TextBlock | undefined
  /** Apply trusted channel commands to the Agent before the user prompt starts. */
  prepareTurn?(agent: HostAgent, msg: InboundMessage): Promise<string | undefined>
  onTurnSettled?(agent: HostAgent, msg: InboundMessage, scopeKey: string, completed: boolean): Promise<void>
  /** Resolve one inbound picture into a stored attachment block; null = degrade to text note. */
  resolveImage?(downloadCode: string, scopeKey: string): Promise<ImageBlock | null>
  /** 文件落盘到当前会话 cwd 后，以明确的文本引用交给宿主。 */
  resolveFile?(file: Extract<InboundContentPart, { type: 'file' }>, scopeKey: string, cwd: string): Promise<TextBlock>
}

export class Bridge {
  private closed = false
  private readonly owned = new Map<string, AgentHandle>()
  private readonly opening = new Map<string, Promise<HostAgent>>()

  async close(): Promise<string[]> {
    this.closed = true
    const handles = [...this.owned.values()]
    await Promise.all(
      handles.map(async (handle) => {
        // 宿主可能已经开始销毁 inbox；只等待所属 handle 的幂等销毁，
        // 由宿主完成取消、排空和注销，不能再操作失效的 Agent 投影。
        await handle.dispose()
        this.owned.delete(handle.agent.id)
      }),
    )
    return handles.map((handle) => handle.agent.id)
  }

  constructor(
    private readonly agents: HostAgentRegistry,
    private readonly renderer: TurnRenderer,
    private readonly bindings: Bindings,
    private readonly opts: BridgeOptions,
  ) {}

  /** Reserve a session for a trusted channel command without starting a model turn. */
  async forCommand(scopeKey: string, authorization: BridgeAuthorization): Promise<HostAgent> {
    if (this.closed) throw new Error('employee_stopping')
    authorization.check()
    const agent = await this.agentFor(scopeKey, authorization.cwd, authorization)
    authorization.checkAgent(agent)
    return agent
  }

  /** Restore exactly the saved conversation Session for native schedule delivery. */
  async forSchedule(id: string, scopeKey: string, authorization: BridgeAuthorization): Promise<HostAgent> {
    if (this.closed) throw new Error('employee_stopping')
    authorization.check()
    if (!authorization.canResume(id)) throw new Error('scheduled_session_changed')
    const agent = await this.agentFor(scopeKey, authorization.cwd, authorization, id)
    authorization.checkAgent(agent)
    return agent
  }

  /** Drive one message through its agent; resolves when the turn settles. */
  async process(msg: InboundMessage, scopeKey: string, admission?: BridgeAuthorization): Promise<string> {
    if (this.closed) throw new Error('employee_stopping')
    const selected = this.opts.workspaceOverrides.get(scopeKey) ?? this.opts.cwd
    const authorization = admission ?? this.opts.authorize?.(msg, scopeKey, selected)
    authorization?.check()
    const cwd = authorization?.cwd ?? selected
    const agent = await this.agentFor(scopeKey, cwd, authorization)
    await this.opts.onAgentMessage(agent, msg, cwd)
    authorization?.checkAgent(agent)
    if (this.closed) throw new Error('employee_stopping')
    const promptOverride = await this.opts.prepareTurn?.(agent, msg)
    authorization?.checkAgent(agent)
    const settled = this.renderer.onInbound(agent.id, msg)
    const content: Array<TextBlock | ImageBlock> =
      promptOverride === undefined ? [] : [{ type: 'text', text: promptOverride }]
    const parts = msg.contentParts?.length
      ? msg.contentParts
      : [
          ...(msg.imageDownloadCodes ?? []).map((downloadCode) => ({ type: 'image' as const, downloadCode })),
          ...(msg.text ? [{ type: 'text' as const, text: msg.text }] : []),
        ]
    for (const part of parts) {
      if (part.type === 'text') {
        if (promptOverride === undefined) content.push({ type: 'text', text: part.text })
      } else if (part.type === 'file') {
        content.push(
          this.opts.resolveFile
            ? await this.opts.resolveFile(part, scopeKey, cwd)
            : { type: 'text', text: '（文件接收不可用，文件尚未保存）' },
        )
      } else if (this.opts.resolveImage) {
        const image = await this.opts.resolveImage(part.downloadCode, scopeKey)
        if (image) content.push(image)
        else content.push({ type: 'text', text: '（用户发来一张图片，但图片接收失败）' })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '（用户发来一张图片）' })
    authorization?.checkAgent(agent)
    const context = this.opts.extraContext?.(msg)
    if (context) content.push(context)
    const id = randomUUID()
    this.opts.onFollowup?.(agent, msg, id, cwd)
    agent.followup({
      id,
      role: 'user',
      content,
      source: { kind: 'user' },
    })
    const completed = (await settled) === true
    await this.opts.onTurnSettled?.(agent, msg, scopeKey, completed)
    return agent.id
  }

  private agentFor(
    conversationId: string,
    cwd: string,
    authorization?: BridgeAuthorization,
    expected?: string,
  ): Promise<HostAgent> {
    const previous = this.opening.get(conversationId)
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.openAgent(conversationId, cwd, authorization, expected),
    )
    this.opening.set(conversationId, next)
    void next
      .finally(() => {
        if (this.opening.get(conversationId) === next) this.opening.delete(conversationId)
      })
      .catch(() => undefined)
    return next
  }

  private async openAgent(
    conversationId: string,
    cwd: string,
    authorization?: BridgeAuthorization,
    expected?: string,
  ): Promise<HostAgent> {
    if (this.closed) throw new Error('employee_stopping')
    // Entry-point-created agents carry no session-local model selection, so the
    // route must be supplied here or prompt assembly fails ({{model}} unset).
    // Likewise the preset must be composed via setup, or the agent has no tools.
    const agentOptions = this.opts.modelOverrides.get(conversationId) ?? this.opts.modelSelection()
    const composition = await this.opts.compose()
    const setup = (restoring: boolean): AgentSetup | undefined =>
      !authorization
        ? composition.setup
        : async (ctx, agent) => {
            authorization.check()
            const composed = await composition.setup?.(ctx, agent)
            const admission = authorization.setup(ctx, agent, restoring)
            return {
              commit() {
                composed?.commit()
                admission.commit()
              },
            }
          }
    const bound = expected ?? this.bindings.get(conversationId)
    if (bound) {
      const running = this.agents.get(sessionId(bound))
      let disposedOwned = false
      if (running) {
        if (
          (!this.opts.exclusiveOwnership || this.owned.get(running.id)?.agent === running) &&
          (!authorization || authorization.canReuse(running))
        )
          return running
        const owned = this.owned.get(running.id)
        if (owned?.agent === running && authorization) {
          // A new lease (e.g. the same device reconnecting) makes the live Agent
          // unresumable for dispatch but the saved session may still be owned by
          // this channel; prefer resuming it over silently starting a new session.
          await owned.dispose()
          this.owned.delete(running.id)
          disposedOwned = true
        }
        if (!this.opts.recoverForeignSession) throw new Error('session_owned_by_another_runtime')
        if (expected !== undefined && !disposedOwned) throw new Error('scheduled_session_in_use')
        this.opts.log('bound session active in another runtime; replacing it with a fresh channel session')
      }
      if ((!running || disposedOwned) && (!authorization || authorization.canResume(bound)))
        try {
          const handle = await this.agents.resume({
            resumeSessionId: sessionId(bound),
            agentOptions,
            setup: setup(true),
          })
          this.opts.log(`resumed session ${bound} for conversation ${conversationId}`)
          return this.own(handle)
        } catch (err) {
          if (expected !== undefined) throw err
          this.opts.log(`resume ${bound} failed (${err instanceof Error ? err.message : err}); creating fresh`)
        }
    }
    if (expected !== undefined) throw new Error('scheduled_session_changed')
    const id = sessionId(randomUUID())
    const handle = await this.agents.create({
      sessionId: id,
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      agentOptions,
      setup: setup(false),
    })
    this.bindings.set(conversationId, id)
    this.opts.log(
      `created session ${id} for conversation ${conversationId} (preset=${composition.agentPreset ?? 'none'})`,
    )
    return this.own(handle)
  }

  private async own(handle: AgentHandle): Promise<HostAgent> {
    if (this.closed) {
      await handle.dispose()
      throw new Error('employee_stopping')
    }
    this.owned.set(handle.agent.id, handle)
    return handle.agent
  }
}
