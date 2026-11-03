import test from 'node:test'
import assert from 'node:assert/strict'
import { enterpriseConnection, profileRobotDirectory } from '../lib/relay/connection-config.js'

const config = {
  mode: 'enterprise',
  corpId: 'corp',
  clientId: 'robot',
  displayName: '工作助手',
  gatewayUrl: 'wss://gateway.example.com/relay',
}
test('enterprise configuration is explicit and never falls back for malformed configuration', () => {
  assert.equal(enterpriseConnection(undefined), undefined)
  assert.deepEqual(enterpriseConnection(config), config)
  for (const value of [
    null,
    {},
    { ...config, clientId: '' },
    { ...config, secret: 'not-allowed' },
    { ...config, gatewayUrl: 'ws://127.0.0.1/relay' },
    { ...config, gatewayUrl: 'wss://user:pass@example.com/relay' },
  ])
    assert.throws(() => enterpriseConnection(value), /enterprise_configuration_invalid/)
})
test('device state belongs to a stable profile rather than the Windows user', () => {
  assert.equal(profileRobotDirectory('root', 'a'), profileRobotDirectory('root', './a'))
  assert.notEqual(profileRobotDirectory('root', 'a'), profileRobotDirectory('root', 'b'))
})
