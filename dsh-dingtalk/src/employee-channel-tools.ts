import { resolve } from 'node:path'
import type { EmployeeWorkspace } from './employee-workspace.js'
import type { HostAgent, HostToolDefinition, TextBlock } from './host.js'
import type { InboundMessage } from './stream.js'

export interface ToolCall {
  readonly name: string
  readonly agent?: HostAgent
  readonly callId?: string
  readonly arguments?: unknown
  readonly signal: AbortSignal
}

interface ToolResult {
  readonly value?: unknown
  readonly isError: boolean
  readonly content: readonly unknown[]
}

type PostDecision = {
  readonly kind: 'accept' | 'block'
  readonly value?: unknown
  readonly content?: readonly unknown[]
}

export interface EmployeeToolHost {
  on(
    name: 'tools/post-execute',
    listener: (exec: ToolCall, result: ToolResult, next: () => Promise<PostDecision>) => Promise<PostDecision>,
  ): () => void
  on(name: 'tools/result', listener: (exec: ToolCall, result: ToolResult) => undefined): () => void
}

interface Turn {
  readonly message: InboundMessage
  readonly charts: Set<string>
  directory?: string
}

/** Use configured Web origin. The fragment is opened only by the logged-in Web client. */
export function visualizationOrigin(host = process.env.CELLGENT_PUBLIC_HOST): string | undefined {
  if (!host || !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host)) return undefined
  try {
    return new URL('https://' + host).origin
  } catch {
    return undefined
  }
}

function visualizationLink(origin: string, exec: ToolCall, value: unknown): string | undefined {
  if (!exec.agent || !exec.callId || value === null || typeof value !== 'object') return undefined
  const session = exec.agent.id
  const revision = JSON.stringify([session, exec.callId])
  if (
    !('type' in value) ||
    value.type !== 'cellgent.visualize/1' ||
    !('sessionId' in value) ||
    value.sessionId !== session ||
    !('callId' in value) ||
    value.callId !== exec.callId ||
    !('revision' in value) ||
    value.revision !== revision
  )
    return undefined
  const url = new URL(origin)
  url.hash = 'visualize=' + encodeURIComponent(JSON.stringify([session, revision]))
  return url.href
}

export function requestedPlan(text: string): string | undefined {
  const command = /^\/plan(?:\s+([\s\S]+))?$/.exec(text.trim())
  return command ? (command[1] ?? '') : undefined
}

const presentHint: TextBlock = {
  type: 'text',
  text: '已登记文件。用户需要在钉钉下载时，使用 send_file 将当前工作区的文件发回原私聊。',
}

/** Adapts only the tools whose results or state changes require a channel action. */
export class EmployeeChannelTools {
  private readonly turns = new WeakMap<HostAgent, Turn>()

  constructor(
    readonly workspace: EmployeeWorkspace,
    readonly origin: string | undefined,
    private readonly canReply: (agent: HostAgent, message: InboundMessage) => boolean,
    private readonly validateSelection: (directory: string) => string = (directory) => workspace.directory(directory),
  ) {}

  bind(agent: HostAgent, message: InboundMessage): void {
    this.turns.set(agent, { message, charts: new Set() })
  }

  privateRoute(agent: HostAgent): boolean {
    const turn = this.turns.get(agent)
    return !!turn && this.canReply(agent, turn.message)
  }

  async enterPlan(agent: HostAgent, signal: AbortSignal): Promise<void> {
    this.workspace.current(agent)
    if (!this.privateRoute(agent)) throw new Error('im_private_reply_required')
    const host = agent.ctx as HostAgent['ctx'] & { get?(name: string): unknown }
    const commands = host.get?.('commands') as
      | {
          execute(
            agent: HostAgent,
            line: string,
            attachments: [],
            signal: AbortSignal,
          ): Promise<{ result: { kind: string } } | undefined>
        }
      | undefined
    signal.throwIfAborted()
    // Execute the preset's own plan command, even when its service is isolated to that preset.
    const action = await commands?.execute(agent, '/plan', [], signal)
    if (action?.result.kind !== 'success') throw new Error('im_plan_mode_unavailable')
    signal.throwIfAborted()
  }

  workingDirectory(agent: HostAgent): HostToolDefinition {
    return {
      name: 'working_directory',
      description:
        '查看当前工作目录。传 cd 可切换到本人工作区内已存在的目录。切换在本轮结束后生效，下一条消息开始新会话。',
      parameters: {
        cd: { type: 'string', description: '要切换到的目录。相对路径基于当前会话工作目录。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['cwd'],
          properties: { cwd: { type: 'string' }, pending: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const turn = this.turns.get(agent)
        if (!turn || exec.agent !== agent) throw new Error('im_agent_mismatch')
        exec.signal.throwIfAborted()
        const cwd = this.workspace.current(agent)
        if (!args || typeof args !== 'object' || !('cd' in args) || args.cd === undefined) return { cwd }
        if (typeof args.cd !== 'string' || !args.cd.trim()) throw new Error('im_workspace_invalid_directory')
        if (!this.privateRoute(agent)) throw new Error('im_private_reply_required')
        const target = this.validateSelection(resolve(cwd, args.cd))
        if (target === cwd) return { cwd }
        return { cwd, pending: target }
      },
    }
  }

  install(host: EmployeeToolHost, agent: HostAgent): () => void {
    const stopHint = host.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      if (
        exec.name !== 'present' ||
        exec.agent !== agent ||
        result.isError ||
        decision.kind !== 'accept' ||
        Object.hasOwn(decision, 'value') ||
        !this.privateRoute(agent)
      )
        return decision
      return { ...decision, content: [...(decision.content ?? result.content), presentHint] }
    })
    const stopResult = host.on('tools/result', (exec, result) => {
      if (exec.agent !== agent || result.isError || !this.privateRoute(agent)) return
      const turn = this.turns.get(agent)
      if (!turn) return
      const value = result.value
      if (
        exec.name === 'working_directory' &&
        value &&
        typeof value === 'object' &&
        'pending' in value &&
        typeof value.pending === 'string'
      ) {
        turn.directory = this.validateSelection(value.pending)
      }
      if (exec.name === 'visualize' && this.origin) {
        const link = visualizationLink(this.origin, exec, value)
        if (link) turn.charts.add(link)
      }
    })
    return () => {
      stopResult()
      stopHint()
    }
  }

  settle(agent: HostAgent, message: InboundMessage, completed: boolean): Turn | undefined {
    const turn = this.turns.get(agent)
    if (!turn || turn.message !== message) return undefined
    this.turns.delete(agent)
    return completed && this.canReply(agent, message) ? turn : undefined
  }
}
