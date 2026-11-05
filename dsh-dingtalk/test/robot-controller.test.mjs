import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failNextStart = false
let gatewayAuthorized = true
const gatewayConfigs = []
let started = 0,
  enabled = 0,
  stopped = 0
mock.module('../lib/relay/robot.js', {
  namedExports: {
    startRobotGateway: async (config, deferred) => {
      assert.equal(deferred, true)
      gatewayConfigs.push(config)
      started++
      if (failNextStart) {
        failNextStart = false
        throw new Error('EADDRINUSE')
      }
      return {
        enable: async () => {
          enabled++
        },
        status: () => ({ stream: 'connected' }),
        authorizes: () => gatewayAuthorized,
        close: async () => {
          stopped++
        },
      }
    },
  },
})
mock.module('../lib/outbound.js', {
  namedExports: {
    Outbound: class {
      async token() {
        return 'test-only'
      }
    },
  },
})
const { RobotConnection } = await import('../lib/relay/controller.js')
const enterprise = {
  mode: 'enterprise',
  corpId: 'corp',
  clientId: 'robot',
  displayName: '企业助手',
  gatewayUrl: 'wss://gateway.example.com/relay',
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'robot-onboarding-'))
  const options = {
    root,
    home: join(root, 'home'),
    profile: join(root, 'profile'),
    identity: () => ({ corpId: 'corp', userId: 'user' }),
    ...overrides,
  }
  const instances = []
  const create = (extra = {}) => {
    const instance = new RobotConnection({ ...options, ...extra })
    instances.push(instance)
    return instance
  }
  t.after(async () => {
    for (const c of instances.reverse()) await c.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, create }
}
test('fresh personal install exposes configuration without starting a gateway', async (t) => {
  const f = await fixture(t),
    before = started,
    c = f.create()
  await c.start({ onMessage: async () => {} })
  assert.equal(c.status().status, 'unconfigured')
  assert.equal(c.status().mode, 'personal')
  assert.equal(started, before)
})
test('fresh personal bootstrap without a known enterprise fails closed before credential or gateway writes', async (t) => {
  const f = await fixture(t, { identity: () => undefined }),
    c = f.create(),
    before = started
  await c.start({ onMessage: async () => {} })
  await assert.rejects(c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' }), /auth_required/)
  assert.equal(started, before)
  assert.equal(c.authority(), undefined)
  assert.equal(c.status().configured, false)
})

test('configured personal corp is stable across DWS logout/change and reconnect needs no DWS identity', async (t) => {
  const { RelayClient } = await import('../lib/relay/client.js')
  let identity = { corpId: 'corp', userId: 'user' }
  const f = await fixture(t, { identity: () => identity }),
    c = f.create()
  await c.start({ onMessage: async () => {} })
  await c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  assert.equal(gatewayConfigs.at(-1).allowUnclaimedPersonalLogin, true)
  await c.stopHosting()
  identity = { corpId: 'foreign', userId: 'other' }
  await c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  assert.equal(gatewayConfigs.at(-1).corpId, 'corp')
  await c.stopHosting()
  identity = undefined
  await c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  assert.equal(gatewayConfigs.at(-1).corpId, 'corp')
  const connect = t.mock.method(RelayClient.prototype, 'connect', async () => ({ status: 'authorizing' }))
  await c.connect()
  assert.equal(connect.mock.calls.length, 1)
  assert.equal(connect.mock.calls[0].arguments[0], 'ws://127.0.0.1:19878/relay')
  const saved = JSON.parse(await readFile(join(c.directory, 'personal.json'), 'utf8'))
  assert.equal(saved.corpId, 'corp')
  assert.equal(c.authority(), undefined, 'configuration without confirmed enabled channel grants nothing')
})

test('personal authority requires the live local gateway, exact enterprise and enabled profile pairing', async (t) => {
  const { RelayClient } = await import('../lib/relay/client.js')
  const f = await fixture(t),
    first = f.create()
  await first.start({ onMessage: async () => {} })
  await first.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  const file = join(first.directory, 'personal.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...saved, enabled: true }))
  await first.close()
  const lease = new AbortController()
  const binding = {
    identity: Object.freeze({ corpId: 'corp', userId: 'paired-owner' }),
    bindingId: 'fixture-device',
    signal: lease.signal,
  }
  let current = binding
  t.mock.method(RelayClient.prototype, 'channelBinding', () => current)
  const restored = f.create({ identity: () => undefined })
  await restored.start({ onMessage: async () => {} })
  const authority = restored.authority()
  assert.ok(Object.isFrozen(authority))
  assert.equal(authority.profile, join(f.root, 'profile'))
  assert.equal(authority.identity.userId, 'paired-owner')
  assert.equal(authority.bindingId, binding.bindingId)
  assert.equal(authority.signal, lease.signal)
  gatewayAuthorized = false
  try {
    assert.equal(restored.authority(), undefined, 'gateway revocation is checked on every authority read')
  } finally {
    gatewayAuthorized = true
  }
  current = { ...binding, identity: { corpId: 'foreign', userId: 'paired-owner' } }
  assert.equal(restored.authority(), undefined)
  current = undefined
  assert.equal(restored.authority(), undefined)
  current = binding
  const managed = f.create({ enterprise, profile: join(f.root, 'enterprise-profile') })
  assert.equal(managed.authority(), undefined, 'enterprise never inherits personal authority')
  await restored.close()
  assert.equal(restored.authority(), undefined)
})
test('enterprise configuration never exposes URL or starts local hosting and rejects credential writes', async (t) => {
  const f = await fixture(t),
    before = started,
    c = f.create({ enterprise })
  await c.start({ onMessage: async () => {} })
  assert.equal(c.status().displayName, '企业助手')
  assert.equal(c.status().url, '')
  assert.equal(started, before)
  await assert.rejects(c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' }), /enterprise_managed/)
})
test('invalid enterprise configuration and mismatched identity cannot fall back to personal', async (t) => {
  const f = await fixture(t),
    c = f.create({ enterprise: {} })
  assert.equal(c.status().mode, 'enterprise')
  await assert.rejects(c.connect(), /enterprise_configuration_invalid/)
  const other = f.create({ enterprise, identity: () => ({ corpId: 'other', userId: 'user' }) })
  await assert.rejects(other.connect(), /identity_mismatch/)
})
test('configuration stores credential references and prepares callback without consuming Stream', async (t) => {
  const f = await fixture(t),
    c = f.create(),
    before = enabled
  await c.start({ onMessage: async () => {} })
  await c.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  assert.equal(c.status().hosting, true)
  assert.equal(enabled, before)
  const saved = await readFile(join(c.directory, 'personal.json'), 'utf8')
  assert.doesNotMatch(saved, /fixture-secret/)
  assert.equal(c.status().callbackUrl, 'http://127.0.0.1:19878/relay/callback')
  const beforeStop = stopped
  await c.stopHosting()
  assert.equal(stopped, beforeStop + 1)
  assert.equal(c.status().hosting, false)
})
test('same profile cannot run two receiving runtimes', async (t) => {
  const f = await fixture(t),
    a = f.create(),
    b = f.create()
  await a.start({ onMessage: async () => {} })
  await b.start({ onMessage: async () => {} })
  assert.equal(b.status().status, 'device_in_use')
  await assert.rejects(b.connect(), /device_in_use/)
})
test('different profiles cannot start duplicate gateways for the same robot', async (t) => {
  const f = await fixture(t),
    a = f.create(),
    b = f.create({ profile: join(f.root, 'other-profile') })
  await a.start({ onMessage: async () => {} })
  await b.start({ onMessage: async () => {} })
  await a.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  await assert.rejects(b.configure({ clientId: 'robot', clientSecret: 'fixture-secret' }), /gateway_in_use/)
  assert.equal(a.status().hosting, true)
})

test('restart restores hosting and keeps receiver handlers after a recoverable port conflict', async (t) => {
  const { RelayClient } = await import('../lib/relay/client.js')
  const f = await fixture(t),
    first = f.create()
  await first.start({ onMessage: async () => {} })
  await first.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  const file = join(first.directory, 'personal.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...saved, enabled: true }))
  await first.close()
  const receiver = t.mock.method(RelayClient.prototype, 'start')
  const restored = f.create(),
    before = enabled
  await restored.start({ onMessage: async () => {} })
  assert.equal(restored.status().hosting, true)
  assert.equal(enabled, before + 1)
  await restored.close()
  failNextStart = true
  const retry = f.create(),
    onMessage = async () => {}
  await retry.start({ onMessage })
  assert.equal(retry.status().status, 'gateway_in_use')
  assert.equal(receiver.mock.calls.at(-1).arguments[0].onMessage, onMessage)
  await retry.configure({ clientId: 'robot', clientSecret: 'fixture-secret' })
  assert.equal(retry.status().hosting, true)
  assert.notEqual(retry.status().status, 'gateway_in_use')
})
