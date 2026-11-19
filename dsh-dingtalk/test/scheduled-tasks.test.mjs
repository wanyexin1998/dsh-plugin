import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmployeeSchedules } from '../lib/scheduled-tasks.js'
import { EmployeeWorkspace } from '../lib/employee-workspace.js'
import { DeliveryOutcomeUnknown } from '../lib/errors.js'
import { reportInput } from '../lib/scheduled-report.js'

test('the same privately approved schedule survives restart and routes once to its pinned employee', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'schedule-employee-')))
  t.after(() => rm(dir, { force: true, recursive: true }))
  const signal = new AbortController().signal
  let current = { signal, identity: { corpId: 'corp', userId: 'wan' }, bindingId: 'fixture-device' }
  let trigger
  const directory = await stat(dir, { bigint: true })
  const first = '2099-12-31T04:00:00.000Z'
  const task = {
    sessionId: 'one-session',
    record: { id: 'schedule-70eb44c4-dea5-4774-a52a-877d6cb37a90', scheduledAt: first },
    managed: {
      provider: 'dingtalk-private',
      payload: JSON.stringify({
        identity: current.identity,
        device: current.bindingId,
        directory: dir,
        directoryIdentity: [directory.dev, directory.ino].join(':'),
        action: { kind: 'reminder', text: '核对测试' },
      }),
    },
    status: 'active',
  }
  const schedule = {
    registerManagedDelivery: (name, run) => {
      assert.equal(name, 'dingtalk-private')
      trigger = run
      return () => {
        trigger = undefined
      }
    },
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
  await trigger(task, first)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], [current.identity, '定时提醒\n核对测试'])
  const receipt = join(dir, 'scheduled', task.record.id + '.json')
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { scheduledAt: first, phase: 'unknown' })
  close()
  manager().install()
  await trigger(task, first)
  assert.equal(delivered.length, 1)
  current = { ...current, bindingId: 'replacement' }
  const next = '2100-01-01T04:00:00.000Z'
  await trigger(task, next)
  assert.equal(delivered.length, 1)
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { scheduledAt: next, phase: 'blocked' })
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
