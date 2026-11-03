import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { OAuthController, browserContext } from '../lib/host/oauth.js';

export async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
export const context = { origin: 'http://127.0.0.1:3000', returnPath: '/session/example?panel=chat#draft' };
export async function start(oauth, owner = 'browser-a') {
  const tx = await oauth.begin(owner, context);
  const response = await fetch(tx.authorizeUrl, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return { tx, target: new URL(response.headers.get('location')), cookie: response.headers.get('set-cookie').split(';')[0] };
}
function get(url, headers) { return new Promise((resolve, reject) => { const req = request(url, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); }); }
test('OAuth binds owner/browser cookie/state/redirect/client, and consumes code only once', async () => {
  const port = await freePort(); let calls = 0;
  const oauth = new OAuthController({ clientId: 'synthetic-app', scopes: 'openid', redirectUri: `http://127.0.0.1:${port}/dsh-dingtalk/callback`, expectedCorpId: 'corp', expectedUserId: 'user' }, {
    revision: () => 1, exchange: async (code, revision) => { calls++; assert.equal(code, 'synthetic-code'); assert.equal(revision, 1); return { state: 'connected', checkedAt: new Date().toISOString() }; },
  });
  try {
    const { tx, target, cookie } = await start(oauth);
    assert.equal(target.origin, 'https://login.dingtalk.com');
    assert.equal(target.searchParams.get('client_id'), 'synthetic-app');
    assert.equal(target.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/dsh-dingtalk/callback`);
    assert.ok(target.searchParams.get('nonce').length >= 40);
    assert.throws(() => oauth.status(tx.transactionId, 'browser-b'), { reasonCode: 'invalid_auth_state' });
    const callback = `${target.searchParams.get('redirect_uri')}?state=${target.searchParams.get('state')}&authCode=synthetic-code`;
    assert.equal((await fetch(tx.authorizeUrl, { redirect: 'manual' })).status, 400);
    assert.equal(await get(callback, {}), 400);
    assert.equal(await get(callback, { Cookie: cookie, Origin: 'https://evil.invalid' }), 403);
    assert.equal(await get(callback, { Cookie: cookie, Host: 'evil.invalid' }), 403);
    assert.equal(await get(callback + '&code=duplicate', { Cookie: cookie }), 400);
    const response = await fetch(callback, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.ok(!html.includes('synthetic-code')); assert.match(html, /history.replaceState/);
    assert.equal(await get(callback, { Cookie: cookie }), 400);
    assert.equal(calls, 1); assert.equal(oauth.status(tx.transactionId, 'browser-a').state, 'connected');
  } finally { await oauth.dispose(); }
  await assert.rejects(oauth.begin('browser-a', context), { reasonCode: 'service_disposed' });
});
test('OAuth timeout/cancel/error/replay do not exchange; concurrent tabs are independent', async () => {
  let now = Date.now(), calls = 0;
  const port = await freePort();
  const oauth = new OAuthController({ clientId: 'app', scopes: 'openid', redirectUri: `http://127.0.0.1:${port}/dsh-dingtalk/callback`, expectedCorpId: 'corp', expectedUserId: 'user' }, { revision: () => 0, exchange: async () => { calls++; return { state: 'connected' }; } }, () => now);
  try {
    const [a, b] = await Promise.all([start(oauth), start(oauth, 'browser-b')]);
    const cb = item => `${item.target.searchParams.get('redirect_uri')}?state=${item.target.searchParams.get('state')}&code=synthetic-code`;
    assert.equal(await get(cb(a), { Cookie: b.cookie }), 400);
    oauth.cancel(a.tx.transactionId, 'browser-a');
    assert.equal(await get(cb(a), { Cookie: a.cookie }), 400);
    now += 121000;
    assert.equal(oauth.status(b.tx.transactionId, 'browser-b').state, 'auth_timeout');
    assert.equal(await get(cb(b), { Cookie: b.cookie }), 400);
    const c = await start(oauth);
    assert.equal(await get(cb(c).replace('&code=synthetic-code', '&error=temporarily_unavailable'), { Cookie: c.cookie }), 200);
    assert.equal(oauth.status(c.tx.transactionId, 'browser-a').state, 'unknown');
    assert.equal(calls, 0);
  } finally { await oauth.dispose(); }
});
test('return targets reject cross-origin/control/credential injection', () => {
  assert.deepEqual(browserContext(context), context);
  for (const value of [{ ...context, origin: 'https://evil.invalid' }, { ...context, returnPath: '//evil.invalid' }, { ...context, returnPath: '/?token=private' }, { ...context, returnPath: '/\\evil.invalid' }, { ...context, extra: true }]) assert.throws(() => browserContext(value));
  assert.deepEqual(browserContext({ origin: 'null', returnPath: '/desktop' }), { origin: 'null', returnPath: '' });
});

test('DingTalk identical code aliases exchange once; duplicate keys and conflicting aliases are rejected', async () => {
  let calls = 0;
  const oauth = new OAuthController({ clientId: 'app', scopes: 'openid corpid', redirectUri: 'http://127.0.0.1:0/callback', expectedCorpId: '', expectedUserId: '' }, {
    revision: () => 0, exchange: async code => { assert.equal(code, 'synthetic-code'); calls++; return { state: 'connected' }; },
  });
  try {
    const a = await start(oauth);
    const back = `${a.target.searchParams.get('redirect_uri')}?state=${a.target.searchParams.get('state')}`;
    for (const query of ['&code=synthetic-code&authCode=different', '&code=synthetic-code&code=synthetic-code', '&authCode=synthetic-code&authCode=synthetic-code', '&code=&authCode=synthetic-code', '&code=synthetic-code&authCode=', '&error=access_denied&code=synthetic-code&authCode=synthetic-code']) {
      assert.equal(await get(back + query, { Cookie: a.cookie }), 400);
      assert.equal(calls, 0);
    }
    const callback = back + '&code=synthetic-code&authCode=synthetic-code';
    const response = await fetch(callback, { headers: { Cookie: a.cookie } });
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('synthetic-code'));
    assert.equal(oauth.status(a.tx.transactionId, 'browser-a').state, 'connected');
    assert.equal(await get(callback, { Cookie: a.cookie }), 400); assert.equal(calls, 1);
  } finally { await oauth.dispose(); }
});
test('cancellation wins over a late exchange result even when a test operation ignores Abort', async () => {
  const port = await freePort(); let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const oauth = new OAuthController({ clientId: 'app', scopes: 'openid', redirectUri: `http://127.0.0.1:${port}/dsh-dingtalk/callback`, expectedCorpId: 'corp', expectedUserId: 'user' }, { revision: () => 0, exchange: async () => { entered(); await delayed; return { state: 'connected' }; } });
  try {
    const a = await start(oauth);
    const callback = fetch(`${a.target.searchParams.get('redirect_uri')}?state=${a.target.searchParams.get('state')}&code=synthetic-code`, { headers: { Cookie: a.cookie } });
    await waiting; oauth.cancel(a.tx.transactionId, 'browser-a'); release();
    assert.equal((await callback).status, 200);
    assert.equal(oauth.status(a.tx.transactionId, 'browser-a').state, 'user_cancelled');
  } finally { release(); await oauth.dispose(); }
});


test('desktop origin accepts only the exact DSH shell and safe local return paths', () => {
  const context = { origin: 'dsh-app://app', returnPath: '/session/test#settings' };
  assert.deepEqual(browserContext(context), context);
  for (const origin of ['dsh-app://evil','dsh-app://app:123','dsh-app://user@app','dsh-app://app/','file://app','https://app']) assert.throws(() => browserContext({...context, origin}));
  for (const returnPath of ['//evil','/?token=secret','/#code=secret','/\\evil']) assert.throws(() => browserContext({...context,returnPath}));
});
