import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { HostAgent } from './host.js'
import type { EmployeeWorkspace } from './employee-workspace.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import type { ChannelBinding } from './relay/client.js'
import { readState, saveState } from './relay/state.js'
import { DeliveryOutcomeUnknown } from './errors.js'
import { createScheduledReport, reportInput } from './scheduled-report.js'

const provider = 'dingtalk-private'
export const scheduledTaskCommand = /^\/dt-task(?=$|\s)/u
const taskId = /^schedule-[a-f0-9-]{36}$/u
const timeZone = 'Asia/Shanghai'
const usage = [
  '/dt-task remind once <带时区的 ISO 时间> <提醒内容>',
  '/dt-task remind daily <HH:mm> <提醒内容>',
  '/dt-task report daily <HH:mm> <工作区内 CSV 路径>',
  '/dt-task list',
  '/dt-task pause|resume|delete <任务 ID>',
  '/dt-task move <任务 ID> once|daily <时间>',
].join('\n')

type Timing = { at: string } | { daily: { time: string; time_zone: string } }
type Change = { kind: 'at'; at: string } | { kind: 'daily'; time: string; time_zone: string }
type Record = { id: string; title: string; prompt: string; scheduledAt: string }
interface Task {
  sessionId: string
  record: Record
  status: 'active' | 'inactive'
  managed?: { provider: string; payload: string; paused?: true }
}
export interface HostSchedule {
  registerManagedDelivery(name: string, deliver: (task: Task, scheduledAt: string) => Promise<void>): () => void
  managedTasks(name: string): Promise<Task[]>
  createManaged(
    sessionId: string,
    request: { title: string; prompt: string } & Timing,
    managed: { provider: string; payload: string },
    signal: AbortSignal,
  ): Promise<Record>
  setManagedPaused(
    request: { sessionId: string; id: string },
    name: string,
    paused: boolean,
    signal: AbortSignal,
  ): Promise<boolean>
  update(
    request: { sessionId: string; id: string; expected: Record; change: Change },
    signal: AbortSignal,
  ): Promise<{ updated: boolean; record?: Record }>
  delete(request: { sessionId: string; id: string }, signal: AbortSignal): Promise<{ deleted: boolean }>
}

export interface HostScheduleCommands {
  register(definition: {
    name: string
    description: string
    input: { hint: string }
    recordInput: false
    handler(invocation: {
      agent: HostAgent
      rawInput: string
      signal: AbortSignal
    }): Promise<{ kind: 'success' | 'error'; text: string }>
  }): () => void
}

interface TaskPayload {
  identity: DingTalkIdentity
  device: string
  directory: string
  directoryIdentity: string
  action: { kind: 'reminder'; text: string } | { kind: 'report'; input: string }
}

type Run = {
  scheduledAt: string
  phase: 'started' | 'blocked' | 'failed' | 'accepted' | 'unknown'
  file?: string
}
const runLabels: { [phase in Run['phase']]: string } = {
  started: '上次执行中断，发送结果待核对',
  blocked: '员工授权或机器人连接不可用',
  failed: '执行或通知失败',
  accepted: '钉钉已受理',
  unknown: '通知结果待核对',
}

function time(rule: string, value: string): Timing {
  if (rule === 'daily' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))
    return { daily: { time: value + ':00', time_zone: timeZone } }
  if (rule === 'once' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
    return { at: value }
  throw new Error('scheduled_time_invalid')
}

function targetIdentity(directory: string): string {
  const info = statSync(directory, { bigint: true })
  return [info.dev, info.ino].join(':')
}

function displayTime(value: string): string {
  return (
    new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      dateStyle: 'short',
      timeStyle: 'short',
      hourCycle: 'h23',
    }).format(new Date(value)) + '（北京时间）'
  )
}

function payloadOf(task: Task): TaskPayload {
  const payload: unknown = JSON.parse(task.managed?.payload ?? 'null')
  if (typeof payload !== 'object' || payload === null) throw new Error('scheduled_task_invalid')
  const value = payload as Partial<TaskPayload>
  const identity = messageIdentity({ senderCorpId: value.identity?.corpId, senderStaffId: value.identity?.userId })
  const action = value.action
  if (
    !identity ||
    typeof value.device !== 'string' ||
    typeof value.directory !== 'string' ||
    typeof value.directoryIdentity !== 'string' ||
    !action ||
    (action?.kind === 'reminder'
      ? typeof action.text !== 'string'
      : action?.kind !== 'report' || typeof action.input !== 'string')
  )
    throw new Error('scheduled_task_invalid')
  return {
    identity,
    device: value.device,
    directory: value.directory,
    directoryIdentity: value.directoryIdentity,
    action,
  }
}

/** Shared employee commands and trigger-time delivery for the existing Cellgent scheduler. */
export class EmployeeSchedules {
  constructor(
    private readonly schedule: HostSchedule,
    private readonly workspace: EmployeeWorkspace,
    private readonly state: string,
    private readonly authority: () => ChannelBinding | undefined,
    private readonly send: (binding: ChannelBinding, text: string) => Promise<unknown>,
    private readonly python: string | undefined,
  ) {}

  install(): () => void {
    return this.schedule.registerManagedDelivery(provider, (task, planned) => this.deliver(task, planned))
  }

  private latest(id: string): string {
    if (!taskId.test(id)) throw new Error('scheduled_task_invalid')
    return path.join(this.state, 'scheduled', id + '.json')
  }

  private async deliver(task: Task, scheduledAt: string): Promise<void> {
    const file = this.latest(task.record.id)
    if (readState<Run | null>(file, null)?.scheduledAt === scheduledAt) return
    const data = payloadOf(task)
    const binding = this.authority()
    const authorize = () => {
      const live = this.authority()
      if (
        !binding ||
        !live ||
        binding.signal !== live.signal ||
        binding.signal.aborted ||
        live.bindingId !== data.device ||
        !sameIdentity(live.identity, data.identity) ||
        this.workspace.directory(data.directory) !== data.directory ||
        targetIdentity(data.directory) !== data.directoryIdentity
      )
        throw new Error('scheduled_authorization_changed')
    }
    try {
      authorize()
    } catch {
      saveState(file, { scheduledAt, phase: 'blocked' } satisfies Run)
      return
    }
    if (!binding) throw new Error('scheduled_authorization_changed')
    const run: Run = { scheduledAt, phase: 'started' }
    saveState(file, run)
    try {
      let text: string
      if (data.action.kind === 'report') {
        if (!this.python) throw new Error('scheduled_report_python_unavailable')
        const hash = createHash('sha256')
          .update(task.record.id + scheduledAt)
          .digest('hex')
          .slice(0, 16)
        const workbook = 'scheduled-' + hash + '.xlsx'
        await createScheduledReport(this.python, data.directory, data.action.input, workbook, binding.signal, authorize)
        run.file = workbook
        saveState(file, run)
        text = '定时报表已生成。请登录 Cellgent，在创建任务的工作区查看 ' + workbook
      } else {
        text = '定时提醒\n' + data.action.text
      }
      authorize()
      await this.send(binding, text)
      run.phase = 'accepted'
    } catch (error) {
      run.phase = error instanceof DeliveryOutcomeUnknown ? 'unknown' : 'failed'
    }
    saveState(file, run)
  }

  async command(
    input: string,
    getAgent: () => Promise<HostAgent>,
    signal: AbortSignal,
  ): Promise<{ kind: 'success' | 'error'; text: string }> {
    try {
      const binding = this.authority()
      if (!binding) return { kind: 'error', text: '请先启用并连接本人企业机器人。' }
      const check = () => {
        signal.throwIfAborted()
        if (this.authority()?.signal !== binding.signal || binding.signal.aborted)
          throw new Error('scheduled_binding_changed')
      }
      const action = /^(remind|report)\s+(once|daily)\s+(\S+)\s+([\s\S]+)$/u.exec(input.trim())
      if (action) {
        const [, kind, rule, value, content] = action
        const when = time(rule, value)
        const text = content.trim()
        if (!text || Buffer.byteLength(text) > 1800) throw new Error('scheduled_content_invalid')
        const job =
          kind === 'report' ? ({ kind, input: reportInput(text) } as const) : ({ kind: 'reminder', text } as const)
        if (job.kind === 'report' && !this.python) throw new Error('scheduled_report_python_unavailable')
        const agent = await getAgent()
        const directory = this.workspace.current(agent)
        check()
        const record = await this.schedule.createManaged(
          agent.id,
          { ...when, title: job.kind === 'report' ? '钉钉定时报表' : '钉钉私聊提醒', prompt: text },
          {
            provider,
            payload: JSON.stringify({
              identity: binding.identity,
              device: binding.bindingId,
              directory,
              directoryIdentity: targetIdentity(directory),
              action: job,
            } satisfies TaskPayload),
          },
          AbortSignal.any([signal, binding.signal]),
        )
        return {
          kind: 'success',
          text: '已创建 ' + record.id + '\n下次 ' + displayTime(record.scheduledAt) + '\n接收方是本人钉钉私聊。',
        }
      }
      if (!input.trim() || input.trim() === 'help') return { kind: 'success', text: usage }
      const rows = (await this.schedule.managedTasks(provider)).filter((task) =>
        sameIdentity(payloadOf(task).identity, binding.identity),
      )
      check()
      if (input.trim() === 'list') {
        const text = rows.map((task) => {
          const run = readState<Run | null>(this.latest(task.record.id), null)
          const state =
            task.status === 'inactive'
              ? '已结束'
              : task.managed?.paused
                ? '已暂停'
                : '下次 ' + displayTime(task.record.scheduledAt)
          return [task.record.id, task.record.title, state, run ? runLabels[run.phase] : '', run?.file ?? '']
            .filter(Boolean)
            .join(' · ')
        })
        return { kind: 'success', text: text.slice(0, 30).join('\n') || '当前没有钉钉定时任务。' }
      }
      const manage = /^(pause|resume|delete|move)\s+(\S+)(?:\s+(once|daily)\s+(\S+))?$/u.exec(input.trim())
      if (!manage) return { kind: 'error', text: usage }
      const [, operation, id, rule, value] = manage
      if ((operation === 'move') !== !!rule) return { kind: 'error', text: usage }
      const row = rows.find((task) => task.record.id === id)
      if (!row) return { kind: 'error', text: '未找到属于本人的任务。' }
      const target = { sessionId: row.sessionId, id }
      const mutation = AbortSignal.any([signal, binding.signal])
      check()
      const ok = await (async () => {
        if (operation === 'delete') return (await this.schedule.delete(target, mutation)).deleted
        if (operation === 'move') {
          const when = time(rule, value)
          const change: Change = 'at' in when ? { kind: 'at', at: when.at } : { kind: 'daily', ...when.daily }
          return (await this.schedule.update({ ...target, change, expected: row.record }, mutation)).updated
        }
        if (operation === 'resume' && payloadOf(row).device !== binding.bindingId) return false
        return this.schedule.setManagedPaused(target, provider, operation === 'pause', mutation)
      })()
      return ok
        ? { kind: 'success', text: '任务已更新。' }
        : { kind: 'error', text: '任务当前无法更新，请查看任务状态后重试。' }
    } catch {
      return { kind: 'error', text: '定时任务未保存或操作未完成。请核对时间、工作区和机器人连接。' }
    }
  }
}
