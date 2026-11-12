import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
let starts = 0,
  stops = 0
mock.module('../lib/stream.js', {
  namedExports: {
    startStream: async (options) => {
      starts++
      options.onStatus?.('connected')
      return () => {
        stops++
      }
    },
  },
})
const { startRobotGateway } = await import('../lib/relay/robot.js')
test('occupied real port rejects startup without an uncaught WebSocket error or leaking listeners', () => {
  const moduleUrl = new URL('../lib/relay/robot.js', import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {mkdtemp,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {startRobotGateway} from ${JSON.stringify(moduleUrl)};
    const dir=await mkdtemp(join(tmpdir(),'gateway-port-conflict-'));
    const blocker=createServer((_req,res)=>res.end('original service'));
    await new Promise(r=>blocker.listen(0,'127.0.0.1',r));
    const port=blocker.address().port;
    try{
      for(let i=0;i<2;i++)await assert.rejects(startRobotGateway({clientId:'fixture',clientSecret:'fixture',corpId:'fixture',stateDirectory:dir,host:'127.0.0.1',port,publicOrigin:'http://127.0.0.1:'+port},true),{code:'EADDRINUSE'});
      const response=await fetch('http://127.0.0.1:'+port);assert.equal(await response.text(),'original service');
    }finally{blocker.closeAllConnections();await new Promise(r=>blocker.close(r));await rm(dir,{recursive:true,force:true});}
    console.log('conflict_handled');
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /conflict_handled/)
})
test('gateway rejects malformed group mention audience before startup', async () => {
  const config = {
    clientId: 'test',
    clientSecret: 'test',
    corpId: 'corp',
    stateDirectory: '.',
    publicOrigin: 'https://example.org',
  }
  for (const allowedGroups of ['group-abcd', [''], ['   '], [3], null]) {
    await assert.rejects(startRobotGateway({ ...config, allowedGroups }, true), /invalid_allowed_groups/)
  }
  for (const groupMentionSenders of ['pilot', [''], ['*'], [3], null]) {
    await assert.rejects(startRobotGateway({ ...config, groupMentionSenders }, true), /invalid_group_mention_senders/)
  }
})
test('personal callback preparation does not subscribe Stream; activation is single-flight and closes once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-deferred-'))
  let gateway
  try {
    gateway = await startRobotGateway(
      {
        clientId: 'test-app',
        clientSecret: 'fixture-only',
        corpId: 'corp',
        stateDirectory: dir,
        host: '127.0.0.1',
        port: 0,
        publicOrigin: 'http://127.0.0.1:19878',
      },
      true,
    )
    assert.equal(starts, 0)
    await Promise.all([gateway.enable(), gateway.enable()])
    assert.equal(starts, 1)
    assert.equal(gateway.status().stream, 'connected')
  } finally {
    await gateway?.close()
    await rm(dir, { recursive: true, force: true })
  }
  assert.equal(stops, 1)
})
