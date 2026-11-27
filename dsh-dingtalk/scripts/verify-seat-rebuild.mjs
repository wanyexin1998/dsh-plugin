import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const [mode, directory, baseline] = process.argv.slice(2)
if (!directory || !['before', 'after'].includes(mode))
  throw new Error('usage: verify-seat-rebuild.mjs before|after PROFILE_STATE_DIR [baseline]')
async function read(name) {
  try {
    return JSON.parse(await readFile(join(directory, name), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}
async function binding() {
  const device = await read('relay-device.json')
  if (device.replaced) return 'replaced'
  if (!device.token && !device.device && !device.identity) return 'unpaired'
  if (!device.confirmed || !device.token || !device.device || !device.identity?.corpId || !device.identity?.userId)
    throw new Error('incomplete device binding')
  return createHash('sha256')
    .update(JSON.stringify([device.identity.corpId, device.identity.userId, device.device]))
    .digest('hex')
}
if (mode === 'before') {
  if (!(await read('relay-runtime.json')).observedAt) throw new Error('missing prior heartbeat; check profile path')
  console.log(await binding())
} else {
  if (!baseline || !/^(unpaired|replaced|[0-9a-f]{64})$/.test(baseline)) throw new Error('missing or invalid baseline')
  const expected = baseline === 'unpaired' ? 'disconnected' : baseline === 'replaced' ? 'replaced' : 'connected'
  const start = Date.now()
  let previous
  for (;;) {
    if ((await binding()) !== baseline) throw new Error('seat binding changed')
    const rt = await read('relay-runtime.json')
    const now = Date.now()
    if (
      rt.status === expected &&
      rt.observedAt >= start &&
      rt.observedAt <= now &&
      now - rt.observedAt < 10000 &&
      (expected !== 'connected' || !!rt.gateway)
    ) {
      if (previous && rt.observedAt > previous.observedAt && rt.pid === previous.pid) break
      previous = rt
    } else previous = undefined
    if (now - start >= 45000) throw new Error('no two fresh matching heartbeats')
    await delay(500)
  }
  console.log('PASS', expected)
}
