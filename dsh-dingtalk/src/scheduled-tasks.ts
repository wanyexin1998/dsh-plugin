import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { EmployeeWorkspace } from './employee-workspace.js'
import { messageIdentity, sameIdentity, type DingTalkIdentity } from './identity.js'
import type { ChannelBinding } from './relay/client.js'
import { readState, saveState } from './relay/state.js'
import { DeliveryOutcomeUnknown } from './errors.js'
import { createScheduledReport } from './scheduled-report.js'

const provider = 'dingtalk-private'
const taskId = /^schedule-[a-f0-9-]{36}$/u

interface Task {
  record: { id: string }
  managed?: { payload: string }
}

export interface HostSchedule {
  registerManagedDelivery(name: string, deliver: (task: Task, scheduledAt: string) => Promise<void>): () => void
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
function targetIdentity(directory: string): string {
  const info = statSync(directory, { bigint: true })
  return [info.dev, info.ino].join(':')
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

/** Trigger-time delivery for previously saved DingTalk reminders and reports. */
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
}
