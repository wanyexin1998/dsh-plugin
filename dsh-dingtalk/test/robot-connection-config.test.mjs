import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
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
    { ...config, queryTools: 'mcp__doris__exec_query' },
    { ...config, queryTools: ['mcp__doris__*'] },
    { ...config, queryTools: ['mcp__openmetadata__patch_entity'] },
    { ...config, queryTools: ['mcp__openmetadata__get_asset_context'] },
    ...[
      null,
      true,
      {},
      { userId: 'a', root: 'relative' },
      { userId: ' ', root: resolve('workspace') },
      { userId: 'a', root: resolve('workspace'), extra: true },
      { userId: 'a', root: 'bad\0root' },
    ].map((workspaceTools) => ({ ...config, workspaceTools })),
    { ...config, gatewayUrl: 'ws://127.0.0.1/relay' },
    { ...config, gatewayUrl: 'wss://user:pass@example.com/relay' },
  ])
    assert.throws(() => enterpriseConnection(value), /enterprise_configuration_invalid/)
})

test('enterprise workspace tools require an explicit employee and absolute root', () => {
  const workspaceTools = { userId: 'employee-a', root: resolve('workspace-a') }
  assert.deepEqual(enterpriseConnection({ ...config, workspaceTools }).workspaceTools, workspaceTools)
  assert.equal(enterpriseConnection(config).workspaceTools, undefined)
})
test('device state belongs to a stable profile rather than the Windows user', () => {
  assert.equal(profileRobotDirectory('root', 'a'), profileRobotDirectory('root', './a'))
  assert.notEqual(profileRobotDirectory('root', 'a'), profileRobotDirectory('root', 'b'))
})
