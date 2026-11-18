import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmployeeSchedules } from '../lib/scheduled-tasks.js'
import { EmployeeWorkspace } from '../lib/employee-workspace.js'
import { DeliveryOutcomeUnknown } from '../lib/errors.js'
import { reportInput } from '../lib/scheduled-report.js'

test('the same privately approved schedule survives restart and routes once to its pinned employee', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'schedule-employee-')))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const session = { id: 'one-session' }
  const agent = { id: session.id, session, ctx: { get: () => ({ get: () => dir }) } }
  const signal = new AbortController().signal
  let current = { signal, identity: { corpId: 'corp', userId: 'wan' }, bindingId: 'fixture-device' }
  let trigger
  let task
  const schedule = {
    registerManagedDelivery: (_name, run) => {
      trigger = run
      return () => {
        trigger = undefined
      }
    },
    createManaged: async (sessionId, record, managed) => {
      task = {
        sessionId,
        record: { ...record, id: 'schedule-70eb44c4-dea5-4774-a52a-877d6cb37a90', scheduledAt: record.at },
        managed,
        status: 'active',
      }
      return task.record
    },
    managedTasks: async () => [task],
  }
  const delivered = []
  const send = async (who, text) => {
    delivered.push([who.identity, text])
    throw new DeliveryOutcomeUnknown('response lost')
  }
  const manager = () =>
    new EmployeeSchedules(schedule, new EmployeeWorkspace([dir]), dir, () => current, send, undefined)
  const one = manager()
  const close = one.install()
  assert.equal(
    (await one.command('remind once 2099-12-31T12:00:00+08:00 核对测试', async () => agent, signal)).kind,
    'success',
  )
  const first = '2099-12-31T04:00:00.000Z'
  await trigger(task, first)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], [current.identity, '定时提醒\n核对测试'])
  assert.match(
    (await one.command('list', async () => assert.fail('list activates a session'), signal)).text,
    /通知结果待核对/,
  )
  close()
  manager().install()
  await trigger(task, first)
  assert.equal(delivered.length, 1)
  current = { ...current, bindingId: 'replacement' }
  await trigger(task, '2100-01-01T04:00:00.000Z')
  assert.equal(delivered.length, 1)
  current = { ...current, identity: { corpId: 'corp', userId: 'different' } }
  assert.match((await manager().command('list', async () => assert.fail(), signal)).text, /没有/)
})

test('report paths reject hidden files, parent components, and invalid extensions', () => {
  assert.equal(reportInput('输入/订单.csv'), '输入/订单.csv')
  for (const value of [
    '../other.csv',
    '.state/report.csv',
    'x/../other.csv',
    '/report.csv',
    'x.xlsx',
    'C:\\report.csv',
  ])
    assert.throws(() => reportInput(value), /scheduled_report_path_invalid/)
})
