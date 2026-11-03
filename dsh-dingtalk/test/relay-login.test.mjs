import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { GatewayLogin, dingTalkLoginExchange } from '../lib/relay/login.js'

async function fixture(t) {
  let now = Date.now(),
    calls = 0
  const bound = [],
    failed = []
  const login = new GatewayLogin(
    {
      publicOrigin: 'http://127.0.0.1:19878',
      clientId: 'fixture-app',
      exchange: async () => {
        calls++
        return { corpId: 'corp', userId: 'owner' }
      },
    },
    () => now,
  )
  const server = createServer((req, res) => {
    void login.handle(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    login.close()
    await new Promise((r) => server.close(r))
  })
  const begin = async () => {
    const a = login.begin(
      async (id) => {
        bound.push(id)
      },
      (reason) => failed.push(reason),
    )
    const start = await fetch(base + new URL(a.authorizeUrl).pathname + new URL(a.authorizeUrl).search, {
      redirect: 'manual',
    })
    const target = new URL(start.headers.get('location'))
    assert.equal(target.origin, 'https://login.dingtalk.com')
    assert.equal(target.searchParams.get('scope'), 'openid corpid')
    assert.equal(target.searchParams.get('redirect_uri'), 'http://127.0.0.1:19878/relay/callback')
    return { a, state: target.searchParams.get('state'), cookie: start.headers.get('set-cookie').split(';')[0] }
  }
  const callback = (a, query, cookie = a.cookie) =>
    fetch(`${base}/relay/callback?state=${a.state}&${query}`, { headers: { cookie } })
  return {
    login,
    begin,
    callback,
    bound,
    failed,
    calls: () => calls,
    expire: () => {
      now += 300001
      login.expire()
    },
  }
}

test('browser proof and exact query required; identical code aliases exchange once and callback replay is rejected', async (t) => {
  const f = await fixture(t),
    a = await f.begin()
  assert.equal((await f.callback(a, 'code=fixture', '')).status, 400)
  assert.equal((await f.callback(a, 'code=one&authCode=two')).status, 400)
  assert.equal((await f.callback(a, 'code=one&code=one')).status, 400)
  assert.equal(f.calls(), 0)
  const good = await f.callback(a, 'code=fixture&authCode=fixture')
  assert.equal(good.status, 200)
  assert.match(good.headers.get('cache-control'), /no-store/)
  assert.ok(!(await good.text()).includes('code=fixture'))
  assert.equal((await f.callback(a, 'code=fixture')).status, 400)
  assert.equal(f.calls(), 1)
  assert.equal(f.bound.length, 1)
})

test('cancel, disconnected initiator and expired login never complete a binding', async (t) => {
  const f = await fixture(t),
    a = await f.begin()
  assert.equal((await f.callback(a, 'error=access_denied')).status, 400)
  assert.deepEqual(f.failed, ['cancelled'])
  const rejected = await f.begin()
  assert.equal((await f.callback(rejected, 'error=invalid_scope')).status, 400)
  assert.equal(f.failed.at(-1), 'failed')
  const b = await f.begin()
  b.a.cancel()
  assert.equal((await f.callback(b, 'code=fixture')).status, 400)
  const c = await f.begin()
  f.expire()
  assert.equal((await f.callback(c, 'code=fixture')).status, 400)
  assert.equal(f.calls(), 0)
  assert.equal(f.bound.length, 0)
  assert.ok(f.failed.includes('expired'))
})

test('official identity exchange obtains corp from OAuth and staff id from same-app union mapping; never uses client claimed identity', async () => {
  const requests = []
  const request = async (url, init) => {
    requests.push({ url, init })
    assert.equal(init.redirect, 'error')
    if (url.endsWith('/userAccessToken'))
      return Response.json({
        accessToken: 'fixture-user-token',
        refreshToken: 'fixture-unused-refresh',
        corpId: 'corp',
      })
    if (url.endsWith('/users/me')) {
      assert.equal(init.headers['x-acs-dingtalk-access-token'], 'fixture-user-token')
      return Response.json({ unionId: 'fixture-union', userId: 'not-a-staff-id' })
    }
    assert.match(url, /topapi\/user\/getbyunionid/)
    assert.deepEqual(JSON.parse(init.body), { unionid: 'fixture-union' })
    return Response.json({ errcode: 0, result: { userid: 'owner' } })
  }
  const exchange = dingTalkLoginExchange(
    { clientId: 'fixture-app', clientSecret: 'fixture-secret', corpId: 'corp' },
    async () => 'fixture-app-token',
    request,
  )
  assert.deepEqual(await exchange('fixture-code', new AbortController().signal), { corpId: 'corp', userId: 'owner' })
  assert.equal(requests.length, 3)
  assert.equal(JSON.parse(requests[0].init.body).grantType, 'authorization_code')
  assert.ok(!JSON.stringify(requests).includes('fixture-unused-refresh'))
})

test('enterprise mismatch and API failures cannot authenticate', async () => {
  const config = { clientId: 'fixture-app', clientSecret: 'fixture-secret', corpId: 'corp' }
  let calls = 0
  const exchange = dingTalkLoginExchange(
    config,
    async () => 'fixture-app-token',
    async () => {
      calls++
      return Response.json({ accessToken: 'fixture', corpId: 'other-corp' })
    },
  )
  await assert.rejects(exchange('fixture-code', new AbortController().signal), /corp_mismatch/)
  assert.equal(calls, 1)
  const failed = dingTalkLoginExchange(
    config,
    async () => 'fixture-app-token',
    async () => new Response('private upstream message', { status: 403 }),
  )
  await assert.rejects(
    failed('fixture-code', new AbortController().signal),
    (error) => !error.message.includes('private upstream'),
  )
})
