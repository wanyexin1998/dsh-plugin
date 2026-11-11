#!/usr/bin/env node
// Contract-faithful fake DWS CLI for Connector tests. Enabled only via the explicit test seam
// DSH_CONNECTOR_TEST_DWS_BINARY; never shipped in the runtime image.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const configDir = process.env.DWS_CONFIG_DIR || process.cwd()
mkdirSync(configDir, { recursive: true })
// Test-only invocation trace (no stdin, so no auth code is recorded).
appendFileSync(join(configDir, 'trace.log'), `${args.join(' ')}\n`)
const stateFile = join(configDir, 'profiles.json')
const readState = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return { profiles: {} }
  }
}
const writeState = (value) => writeFileSync(stateFile, JSON.stringify(value))
const fail = (message, code = 2) => {
  process.stderr.write(JSON.stringify({ error: { category: 'auth', code, message } }))
  process.exit(code)
}
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const delay = (() => {
  try {
    return Number(readFileSync(join(configDir, 'delay_ms'), 'utf8'))
  } catch {
    return Number(process.env.FAKE_DWS_DELAY_MS || 0)
  }
})()
const wrongIdentity = () => existsSync(join(configDir, 'wrong_identity'))
// Test-only pause seam: a hold_<phase> control file blocks that phase until removed, and a
// held_<phase> marker lets the suite prove the phase was reached before cancelling.
const hold = async (phase) => {
  const control = join(configDir, `hold_${phase}`)
  if (!existsSync(control)) return
  writeFileSync(join(configDir, `held_${phase}`), String(Date.now()))
  const deadline = Date.now() + 60000
  while (existsSync(control) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25))
}
const profile = flag('profile')
const part = profile ? profile.split(':') : []

if (args.includes('--version')) {
  process.stdout.write('dws version v1.0.66 (f215043e676d6889e1ddce3464828d8b1ec40c31, 2026-10-28T07:36:14Z)\n')
  process.exit(0)
}
if (process.env.FAKE_DWS_FAIL === '1') fail('synthetic failure')
if (args[0] === 'auth' && args[1] === 'status') {
  await hold('status')
  const state = readState()
  const record = state.profiles[profile]
  if (!record) process.stdout.write(JSON.stringify({ success: true, authenticated: false }))
  else {
    const identity = wrongIdentity()
      ? { corpId: record.corpId, userId: `${record.userId}-wrong` }
      : { corpId: record.corpId, userId: record.userId }
    process.stdout.write(
      JSON.stringify({
        success: true,
        authenticated: true,
        token_valid: true,
        refresh_token_valid: true,
        corp_id: identity.corpId,
        user_id: identity.userId,
      }),
    )
  }
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device')) {
  if (args.some((arg) => arg.startsWith('--client-id') || arg.startsWith('--client-secret')))
    fail('device login must use the official CLI client')
  const loginAs = existsSync(join(configDir, 'login_as'))
    ? readFileSync(join(configDir, 'login_as'), 'utf8').trim().split(':')
    : undefined
  let identity = loginAs
  if (!identity) {
    try {
      const callerId = basename(dirname(configDir))
      const bindings = JSON.parse(readFileSync(join(configDir, '..', '..', '..', 'bindings.json'), 'utf8'))
      const entry = bindings.bindings?.[callerId]
      if (entry?.corpId && entry?.userId) identity = [entry.corpId, entry.userId]
    } catch {
      identity = undefined
    }
  }
  const corpId = identity?.[0] || 'test-corp'
  const userId = identity?.[1] || 'test-user-a'
  const deviceUrl = process.env.FAKE_DEVICE_URL || 'https://login.dingtalk.com/oauth2/device?user_code=ABCD-EFGH'
  process.stderr.write(' 授权码: ABCD-EFGH\n')
  process.stderr.write(' 授权链接（已填入授权码）：\n')
  process.stderr.write(`${deviceUrl}\n`)
  await hold('exchange')
  const state = readState()
  state.profiles[`${corpId}:${userId}`] = { corpId, userId, clientId: 'official-cli' }
  writeState(state)
  await hold('exchange_reply')
  process.stdout.write(JSON.stringify({ success: true, message: '登录成功', corp_id: corpId, user_id: userId }))
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'exchange') {
  let code = ''
  for await (const chunk of process.stdin) code += chunk
  if (code.trim() !== 'synthetic-code') fail('invalid code')
  await hold('exchange')
  const corpId = flag('expected-corp-id') || 'test-corp'
  const userId = flag('expected-user-id') || 'test-user-a'
  const identity = process.env.FAKE_DWS_EXCHANGE_AS ? process.env.FAKE_DWS_EXCHANGE_AS.split(':') : [corpId, userId]
  const state = readState()
  state.profiles[`${identity[0]}:${identity[1]}`] = {
    corpId: identity[0],
    userId: identity[1],
    code,
    clientId: flag('client-id') || 'default',
  }
  writeState(state)
  // Credentials are on disk but the CLI has not answered yet: cancellation here must still
  // leave the connector fail-closed.
  await hold('exchange_reply')
  process.stdout.write(
    JSON.stringify({
      success: true,
      data: {
        dwsProfile: `${identity[0]}:${identity[1]}`,
        corpId: identity[0],
        userId: identity[1],
        clientId: flag('client-id') || 'default',
      },
    }),
  )
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'logout') {
  if (existsSync(join(configDir, 'fail_logout'))) fail('synthetic logout failure')
  const state = readState()
  delete state.profiles[profile]
  writeState(state)
  process.stdout.write(JSON.stringify({ success: true }))
  process.exit(0)
}
if (args[0] === 'contact' && args[1] === 'user' && args[2] === 'get-self') {
  await hold('identity')
  if (!part.length) fail('unauthorized')
  const state = readState()
  const record = state.profiles[profile]
  if (!record) fail('unauthorized')
  const userId = process.env.FAKE_DWS_WRONG_FOR === record.userId ? `${record.userId}-wrong` : record.userId
  process.stdout.write(
    JSON.stringify({ success: true, result: [{ orgEmployeeModel: { corpId: record.corpId, userId } }] }),
  )
  process.exit(0)
}
if (args[0] === 'calendar') {
  if (!profile || !readState().profiles[profile]) fail('unauthorized')
  if (delay) await new Promise((done) => setTimeout(done, delay))
  process.stdout.write(JSON.stringify({ success: true, result: { items: [{ title: '合成日程' }] } }))
  process.exit(0)
}
if (args[0] === 'doc' && args[1] === 'search') {
  if (!profile || !readState().profiles[profile]) fail('unauthorized')
  if (delay) setTimeout(() => {}, delay)
  process.stdout.write(
    JSON.stringify({
      success: true,
      documents: [{ name: '合成文档', nodeId: 'synthetic-node' }],
      hasMore: false,
      nextPageToken: '',
    }),
  )
  process.exit(0)
}
fail(`unsupported command: ${args.join(' ')}`, 1)
