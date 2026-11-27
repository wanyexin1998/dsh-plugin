import { Gateway } from '../../src/relay/gateway.ts'
import { RobotConnection } from '../../src/relay/controller.ts'
import { withReceiverLock, withRecoverableFileLock } from '../../src/file-lock.ts'
import { connect } from 'node:net'
import { createServer } from 'node:tls'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

async function main() {
  const origin = 'https://127.0.0.1:17444'
  const identity = { corpId: 'fixture', userId: 'seat' }
  if (process.argv[2] === 'legacy') {
    await withRecoverableFileLock('/state/legacy.lock', async () => {
      console.log('LEGACY_READY', process.pid)
      await new Promise(() => setInterval(() => {}, 60000))
    })
    return
  }
  if (process.argv[2] === 'legacy-contender') {
    await assert.rejects(
      withReceiverLock('/state/legacy.lock', async () => {}),
      /执行锁超时/,
    )
    console.log('legacy receiver protected')
    return
  }
  if (process.argv[2] === 'gateway') {
    const gateway = new Gateway({
      port: 17443,
      stateFile: '/tmp/bindings.json',
      allowedCorpId: identity.corpId,
      allowedGroups: [],
      login: { publicOrigin: origin, clientId: 'fixture-app', exchange: async () => identity },
      notice: async () => {},
      operation: async () => true,
      diagnostics: () => ({ roundTrip: true }),
    })
    await gateway.start()
    createServer({ key: readFileSync('/fixture/key.pem'), cert: readFileSync('/fixture/cert.pem') }, (downstream) => {
      const upstream = connect(17443, '127.0.0.1')
      downstream.pipe(upstream).pipe(downstream)
      downstream.on('error', () => upstream.destroy())
      upstream.on('error', () => downstream.destroy())
      downstream.on('close', () => upstream.destroy())
    }).listen(17444, '127.0.0.1', () => console.log('GATEWAY_READY'))
    return
  }
  const robot = new RobotConnection({
    root: '/state',
    home: '/state',
    profile: '/employee',
    identity: () => identity,
    enterprise: {
      mode: 'enterprise',
      corpId: identity.corpId,
      clientId: 'fixture-app',
      displayName: 'Fixture',
      gatewayUrl: origin.replace('https:', 'wss:') + '/relay',
    },
  })
  await robot.start({ onMessage: async () => {} })
  console.log('START', process.pid, robot.status().status)
  if (process.argv[2] === 'contender') {
    assert.equal(robot.status().status, 'device_in_use')
    await robot.close()
    return
  }
  async function pair() {
    const pending = await robot.connect()
    const login = await fetch(pending.authorizeUrl, { redirect: 'manual' })
    assert.equal(login.status, 302)
    const state = new URL(login.headers.get('location')).searchParams.get('state')
    const result = await fetch(
      origin + '/relay/callback?state=' + encodeURIComponent(state) + '&code=test&authCode=test',
      {
        headers: { cookie: login.headers.get('set-cookie').split(';')[0] },
      },
    )
    assert.equal(result.status, 200)
    console.log('PAIRED')
  }
  if (process.argv[2] === 'pair') await pair()
  process.on('SIGUSR2', () =>
    pair().catch((error) => {
      console.error(error)
      process.exit(1)
    }),
  )
  setInterval(() => {}, 60000)
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
