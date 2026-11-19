import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HostAgent, HostSessionEvent } from './host.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import { readState, saveState } from './relay/state.js'
import type { WorkspaceAuthority } from './workspace-tool-policy.js'

const provider = 'dingtalk-native'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

/** Route data comes only from the authenticated conversation and the selected workspace. */
export interface ScheduledOrigin {
  identity: DingTalkIdentity
  binding: string
  profile: string
  conversation: string
  directory: string
  directoryIdentity: string
}

interface ScheduledInput {
  id: string
  source?: { kind: string; managedProvider?: string }
}

interface ScheduledTask {
  sessionId: string
  record: { id: string }
  managed?: { provider: string; payload: string }
}

interface Delivery {
  task: string
  session: string
  at: string
  origin: ScheduledOrigin
}

interface InteractiveInput {
  id: string
  origin: ScheduledOrigin
  once: boolean
}

interface Turn {
  agent: HostAgent
  number: number
  count: number
  interactive?: InteractiveInput
  scheduled?: { input: string; delivery?: Delivery }
  final: string[]
}

type Phase = 'started' | 'blocked' | 'failed' | 'sending' | 'accepted' | 'unknown'
type Authority = (name: string) => WorkspaceAuthority | undefined
export type ScheduleCreationTiming = 'once' | 'either'

/** Read timing instructions outside quoted reminders and report content. */
function requestsOneTimeSchedule(text: string): boolean {
  const instruction = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\n]*"|`[^`]*`/gu, ' ')
  const repeats =
    /每(?:隔|日|天|个?工作日|周|星期|月|年|\s*[0-9一二两三四五六七八九十半]*\s*(?:秒|分钟|小时|天|日|周|星期|月|年))|定期|周期性|\b(?:every|daily|weekly|monthly)\b/iu
  if (repeats.test(instruction)) return false
  return (
    /(?:触发|执行|运行|提醒(?:我)?|跑)\s*(?:一次|一遍)|(?:只|仅)\s*(?:一次|一遍)|一次性(?:的)?(?:定时任务|提醒)|不(?:要)?(?:重复|循环)|\b(?:only once|just once|run once|one[- ]time)\b/iu.test(
      instruction,
    ) ||
    /[0-9一二两三四五六七八九十半]+\s*(?:秒钟?|分钟|小时|天)后\s*(?:再)?(?:提醒我|触发|执行|运行)/u.test(instruction)
  )
}

function directoryIdentity(path: string): string {
  const info = statSync(path, { bigint: true })
  return [info.dev, info.ino].join(':')
}

function originOf(value: string): ScheduledOrigin {
  const parsed = JSON.parse(value) as Partial<ScheduledOrigin> | null
  const identity = messageIdentity({ senderCorpId: parsed?.identity?.corpId, senderStaffId: parsed?.identity?.userId })
  if (
    !parsed ||
    !identity ||
    typeof parsed.conversation !== 'string' ||
    !parsed.conversation ||
    typeof parsed.binding !== 'string' ||
    typeof parsed.profile !== 'string' ||
    typeof parsed.directory !== 'string' ||
    typeof parsed.directoryIdentity !== 'string'
  )
    throw new Error('scheduled_origin_invalid')
  return { ...parsed, identity } as ScheduledOrigin
}

/** Keep one DingTalk message within the gateway's UTF-8 byte limit. */
function resultText(text: string): string {
  const prefix = '定时任务结果\n'
  const suffix = '\n完整结果可在 Cellgent 的任务会话查看。'
  if (Buffer.byteLength(prefix + text) <= 2048) return prefix + text
  const budget = 2048 - Buffer.byteLength(prefix + suffix)
  let bytes = 0
  let content = ''
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > budget) break
    content += char
  }
  return prefix + content + suffix
}

/** Structural Host schedule API. The Host owns timers, storage rules, and model inbox admission. */
export interface NativeScheduleHost {
  createForAgent(agent: HostAgent, request: unknown, signal?: AbortSignal): Promise<unknown>
  registerManagedDelivery(
    name: string,
    handler: {
      select(agent: HostAgent): string | undefined
      resolve(task: ScheduledTask): Promise<HostAgent>
      track(agent: HostAgent, task: ScheduledTask, at: string, input: ScheduledInput): void
      accepts(agent: HostAgent, input: ScheduledInput): boolean
    },
  ): () => void
}

/** Connect one employee's native scheduled turns to that employee's original direct conversation. */
export class NativeSchedules {
  private readonly inbound = new WeakMap<HostAgent, InteractiveInput>()
  private readonly turns = new Map<string, Turn>()
  private readonly sending = new Set<Promise<void>>()

  constructor(
    private readonly deps: {
      state: string
      authority(): WorkspaceAuthority | undefined
      ownsSession(id: string, origin: ScheduledOrigin, binding: WorkspaceAuthority): boolean
      allowsAgent(agent: HostAgent): boolean
      restore(id: string, origin: ScheduledOrigin, binding: WorkspaceAuthority): Promise<HostAgent>
      query(name: string, binding: WorkspaceAuthority): WorkspaceAuthority | undefined
      configure(agent: HostAgent, grant?: Authority): void
      send(binding: WorkspaceAuthority, text: string): Promise<unknown>
      log(message: string): void
    },
  ) {}

  install(host: NativeScheduleHost): () => void {
    return host.registerManagedDelivery(provider, {
      select: (agent) => this.select(agent),
      resolve: async (task) => {
        const origin = this.origin(task)
        return this.deps.restore(task.sessionId, origin, this.check(task.sessionId, origin))
      },
      track: (agent, task, at, input) => {
        const origin = this.origin(task)
        this.check(agent.id, origin)
        if (agent.id !== task.sessionId || !this.deps.allowsAgent(agent)) throw new Error('scheduled_agent_changed')
        saveState(this.inputPath(input.id), { task: task.record.id, session: agent.id, at, origin } satisfies Delivery)
      },
      accepts: (agent, input) => {
        const turn = this.turns.get(agent.id)
        const scheduled = turn?.scheduled
        return (
          !!scheduled?.delivery &&
          turn?.agent === agent &&
          turn.count === 1 &&
          scheduled.input === input.id &&
          !!this.live(agent, scheduled.delivery.origin)
        )
      },
    })
  }

  inboundMessage(
    agent: HostAgent,
    id: string,
    conversation: string,
    directory: string,
    live: WorkspaceAuthority,
    text: string,
  ): void {
    this.inbound.set(agent, {
      id,
      once: requestsOneTimeSchedule(text),
      origin: {
        identity: live.identity,
        binding: live.bindingId,
        profile: live.profile,
        conversation,
        directory,
        directoryIdentity: directoryIdentity(directory),
      },
    })
  }

  /** Return the timing allowed by the verified private input claimed for this turn. */
  creationTiming(agent: HostAgent): ScheduleCreationTiming | undefined {
    const turn = this.turns.get(agent.id)
    const input = turn?.interactive
    if (!input || turn?.agent !== agent || turn.count !== 1 || !this.live(agent, input.origin)) return undefined
    return input.once ? 'once' : 'either'
  }

  /** Observe actual inbox claims so scheduled output cannot attach to a different turn. */
  claim(agent: HostAgent, input: ScheduledInput, number: number): void {
    let turn = this.turns.get(agent.id)
    if (turn?.agent !== agent || turn.number !== number) {
      turn = { agent, number, count: 0, final: [] }
      this.turns.set(agent.id, turn)
    }
    turn.count++
    if (input.source?.kind === 'schedule' && input.source.managedProvider === provider) {
      turn.scheduled ??= { input: input.id }
      try {
        const delivery = readState<Delivery | undefined>(this.inputPath(input.id), undefined)
        if (delivery?.session === agent.id && this.live(agent, delivery.origin) && !this.previous(delivery)) {
          this.record(delivery, 'started')
          if (turn.scheduled.input === input.id) turn.scheduled.delivery = delivery
          else this.record(delivery, 'blocked')
        }
      } catch {
        this.deps.log('scheduled input state unavailable')
      }
    } else if (input.source?.kind === 'user') {
      const arrived = this.inbound.get(agent)
      if (arrived?.id === input.id) {
        turn.interactive = arrived
        this.inbound.delete(agent)
      }
    }
    const scheduled = turn.scheduled
    this.deps.configure(
      agent,
      scheduled
        ? (name) => {
            const delivery = scheduled.delivery
            if (turn.count !== 1 || !delivery) return undefined
            const binding = this.live(agent, delivery.origin)
            return binding && this.deps.query(name, binding)
          }
        : undefined,
    )
  }

  /** Return true for the scheduled turn so the interactive renderer leaves it to the proactive sender. */
  event(id: string, event: HostSessionEvent): boolean {
    const turn = this.turns.get(id)
    if (!turn) return false
    const scheduled = turn.scheduled
    if (event.type === 'turn/end' && event.data?.turn === turn.number) {
      this.turns.delete(id)
      this.deps.configure(turn.agent)
      if (scheduled) {
        const work = this.finish(turn, scheduled, event.data?.reason?.kind === 'completed')
        this.sending.add(work)
        void work
          .catch(() => this.deps.log('scheduled result could not be recorded'))
          .finally(() => this.sending.delete(work))
      }
    } else if (scheduled && event.type === 'assistant/message' && event.data?.turn === turn.number) {
      const blocks: unknown = event.data?.message?.content
      if (Array.isArray(blocks)) {
        if (blocks.some((block) => block?.type === 'tool-call')) turn.final = []
        else
          turn.final.push(
            blocks
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join(''),
          )
      }
    }
    return scheduled !== undefined
  }

  rendersSeparately(id: string): boolean {
    return this.turns.get(id)?.scheduled !== undefined
  }

  dispose(agent: HostAgent): void {
    if (this.turns.get(agent.id)?.agent === agent) this.turns.delete(agent.id)
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.sending)
  }

  private select(agent: HostAgent): string | undefined {
    const input = this.turns.get(agent.id)?.interactive
    return input && this.creationTiming(agent) ? JSON.stringify(input.origin) : undefined
  }

  private origin(task: ScheduledTask): ScheduledOrigin {
    if (task.managed?.provider !== provider) throw new Error('invalid_schedule_provider')
    return originOf(task.managed.payload)
  }

  private check(session: string, origin: ScheduledOrigin): WorkspaceAuthority {
    const binding = this.deps.authority()
    if (
      !binding ||
      binding.signal.aborted ||
      binding.bindingId !== origin.binding ||
      binding.profile !== origin.profile ||
      !sameIdentity(binding.identity, origin.identity) ||
      !this.deps.ownsSession(session, origin, binding) ||
      directoryIdentity(origin.directory) !== origin.directoryIdentity
    )
      throw new Error('scheduled_origin_changed')
    return binding
  }

  private live(agent: HostAgent, origin: ScheduledOrigin): WorkspaceAuthority | undefined {
    try {
      return this.deps.allowsAgent(agent) ? this.check(agent.id, origin) : undefined
    } catch {
      return undefined
    }
  }

  private inputPath(input: string): string {
    if (!uuid.test(input)) throw new Error('scheduled_input_invalid')
    return join(this.deps.state, 'native-schedules', 'inputs', input + '.json')
  }

  private runPath(delivery: Delivery): string {
    if (!delivery.task.startsWith('schedule-') || !uuid.test(delivery.task.slice(9)))
      throw new Error('scheduled_task_invalid')
    return join(this.deps.state, 'native-schedules', 'runs', delivery.task + '.json')
  }

  private previous(delivery: Delivery): boolean {
    const run = readState<{ at: string } | null>(this.runPath(delivery), null)
    return run !== null && run.at >= delivery.at
  }

  private record(delivery: Delivery, phase: Phase): void {
    const file = this.runPath(delivery)
    const latest = readState<{ at: string } | null>(file, null)
    if (latest && latest.at > delivery.at) return
    saveState(file, { at: delivery.at, phase })
  }

  private async finish(turn: Turn, scheduled: NonNullable<Turn['scheduled']>, completed: boolean): Promise<void> {
    const { delivery } = scheduled
    if (!delivery) {
      if (uuid.test(scheduled.input)) rmSync(this.inputPath(scheduled.input), { force: true })
      return
    }
    const binding = turn.count === 1 && this.live(turn.agent, delivery.origin)
    if (!binding) this.record(delivery, 'blocked')
    else {
      const text = turn.final.join('\n\n').trim()
      const result = completed && text ? resultText(text) : '定时任务未生成结果，请查看 Cellgent 的任务会话。'
      this.record(delivery, 'sending')
      try {
        await this.deps.send(binding, result)
        this.record(delivery, completed && text ? 'accepted' : 'failed')
      } catch {
        this.record(delivery, 'unknown')
        this.deps.log('scheduled result delivery unconfirmed')
      }
    }
    rmSync(this.inputPath(scheduled.input), { force: true })
  }
}
