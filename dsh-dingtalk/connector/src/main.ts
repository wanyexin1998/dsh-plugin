#!/usr/bin/env node
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseConnectorConfig } from './config.js'
import type { ConnectorConfig } from './config.js'
import { ConnectorServer, CONNECTOR_VERSION } from './server.js'
import { CONNECTOR_PROTOCOL, CONNECTOR_ROUTES } from '../../enhancements/src/shared/connector.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'serve'
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
function fail(message: string, code = 2): never {
  console.error(JSON.stringify({ ok: false, error: message }))
  process.exit(code)
}
function configOrExit(): ConnectorConfig {
  try {
    return parseConnectorConfig()
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid configuration')
  }
}
async function adminToken(config: ConnectorConfig): Promise<string> {
  const provided = process.env.DSH_CONNECTOR_ADMIN_TOKEN
  if (provided) {
    if (!/^[a-f0-9]{64}$/.test(provided)) fail('invalid DSH_CONNECTOR_ADMIN_TOKEN')
    return provided
  }
  try {
    const token = (await readFile(join(config.stateDirectory, 'admin.token'), 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(token)) fail('invalid admin token file')
    return token
  } catch {
    fail('admin token unavailable; start the Connector once or mount the private volume')
  }
}
async function admin(
  config: ConnectorConfig,
  path: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  const token = await adminToken(config)
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
    'x-dsh-connector-admin-token': token,
  }
  return new Promise((resolve, reject) => {
    const options =
      config.transport === 'unix'
        ? { socketPath: join(config.stateDirectory, 'admin', 'admin.sock'), path, method: 'POST', headers }
        : { host: '127.0.0.1', port: config.loopbackPort + 1, path, method: 'POST', headers }
    const req = request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          reject(new Error('invalid Connector response'))
        }
      })
    })
    req.setTimeout(10000, () => req.destroy(new Error('Connector admin timeout')))
    req.on('error', reject)
    req.end(body)
  })
}
async function main(): Promise<void> {
  if (command === 'version') {
    console.log(`dsh-dingtalk-connector ${CONNECTOR_VERSION} (protocol ${CONNECTOR_PROTOCOL})`)
    return
  }
  const config = configOrExit()
  if (command === 'serve') {
    const server = new ConnectorServer(config)
    await server.start()
    console.log(
      JSON.stringify({
        event: 'connector.started',
        version: CONNECTOR_VERSION,
        protocol: CONNECTOR_PROTOCOL,
        transport: server.transport,
        oauth: server.oauthStarted,
        callers: server.callerCount,
      }),
    )
    let stopping = false
    const stop = (signal: string): void => {
      if (stopping) return
      stopping = true
      console.log(JSON.stringify({ event: 'connector.stopping', signal }))
      const timer = setTimeout(() => {
        console.error(JSON.stringify({ event: 'connector.forced_exit' }))
        process.exit(1)
      }, config.shutdownGraceMs)
      timer.unref()
      void server.close().then(
        () => {
          console.log(JSON.stringify({ event: 'connector.stopped' }))
          process.exit(0)
        },
        (error) => {
          console.error(
            JSON.stringify({
              event: 'connector.stop_failed',
              error: error instanceof Error ? error.message : 'unknown',
            }),
          )
          process.exit(1)
        },
      )
    }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
    await new Promise<void>(() => {})
    return
  }
  if (command === 'health') {
    const result = await admin(config, CONNECTOR_ROUTES.adminHealth)
    const value = result.body as { ok?: boolean; value?: unknown; error?: unknown }
    console.log(JSON.stringify(value))
    process.exit(result.status === 200 && value.ok === true ? 0 : 1)
  }
  if (command === 'admin') {
    const sub = args[1]
    let path: string
    let payload: Record<string, unknown>
    if (sub === 'bind') {
      const callerId = option('caller')
      const corpId = option('corp')
      const userId = option('user')
      if (!callerId || !corpId || !userId) fail('usage: admin bind --caller <id> --corp <corpId> --user <userId>')
      path = CONNECTOR_ROUTES.adminBindIdentity
      payload = { callerId, corpId, userId }
    } else if (sub === 'test-bind') {
      const callerId = option('caller')
      const corpId = option('corp')
      const userId = option('user')
      if (!callerId || !corpId || !userId)
        fail('usage: admin test-bind --caller <id> --corp <test-corp-…> --user <test-user-…>')
      path = CONNECTOR_ROUTES.adminBindTestIdentity
      payload = { callerId, corpId, userId }
    } else if (sub === 'unbind') {
      const callerId = option('caller')
      if (!callerId) fail('usage: admin unbind --caller <id>')
      path = CONNECTOR_ROUTES.adminRemoveBinding
      payload = { callerId }
    } else if (sub === 'revoke') {
      const callerId = option('caller')
      if (!callerId) fail('usage: admin revoke --caller <id>')
      path = CONNECTOR_ROUTES.adminRevoke
      payload = { callerId }
    } else if (sub === 'callers') {
      path = CONNECTOR_ROUTES.adminCallers
      payload = {}
    } else fail('usage: admin <bind|test-bind|unbind|revoke|callers>')
    const result = await admin(config, path, payload)
    console.log(JSON.stringify(result.body))
    process.exit(result.status === 200 ? 0 : 1)
  }
  fail(`unknown command: ${command}`)
}
void main().catch((error) => fail(error instanceof Error ? error.message : 'connector failed', 1))
