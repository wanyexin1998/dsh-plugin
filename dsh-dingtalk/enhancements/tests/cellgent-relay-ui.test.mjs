import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, cellgentPageContext, name } from '../lib/host/relay-ui.js';
import * as relayUi from '../lib/host/relay-ui.js';

const host = 'cellgent-test.example';
const env = { CELLGENT_PUBLIC_HOST: host };

test('cellgent page context accepts the public https host and loopback only', () => {
  const page = cellgentPageContext({ origin: `https://${host}`, returnPath: '/settings' }, env);
  assert.deepEqual(page, { origin: `https://${host}`, returnPath: '/settings' });
  const local = cellgentPageContext({ origin: 'http://127.0.0.1:3080', returnPath: '/settings?tab=dingtalk' }, env);
  assert.equal(local.origin, 'http://127.0.0.1:3080');
  assert.equal(local.returnPath, '/settings?tab=dingtalk');
  for (const origin of [`http://${host}`, 'https://evil.example', `https://${host}.evil.example`, `https://prefix-${host}`]) {
    assert.throws(() => cellgentPageContext({ origin, returnPath: '/settings' }, env), /invalid_request/);
  }
  assert.throws(() => cellgentPageContext({ origin: `https://${host}`, returnPath: '/settings?code=1' }, env), /invalid_request/);
  assert.throws(() => cellgentPageContext({ origin: `https://${host}`, returnPath: 'settings' }, env), /invalid_request/);
});

test('relay UI registers status and connect without providing an identity', async () => {
  assert.equal(name, 'dsh-dingtalk-relay-ui');
  assert.equal('provide' in relayUi, false);
  const previous = process.env.CELLGENT_PUBLIC_HOST;
  process.env.CELLGENT_PUBLIC_HOST = host;
  const routes = new Map();
  const owner = { id: 'browser', principal: { kind: 'owner' } };
  const connection = {
    browserPeer: owner,
    admit: () => ({ peer: owner }),
    fetch: { register(route) { routes.set(route.path, route); return async () => {}; } },
  };
  const relay = {
    status: () => ({ status: 'authorizing', authorizeUrl: `https://${host}/relay/login?t=synthetic`, mode: 'enterprise' }),
    async connect() { return this.status(); },
    async disconnect() {},
  };
  const injected = [];
  const ctx = {
    effect(action) { action(); },
    inject(deps, action) { injected.push({ deps, action }); },
  };
  try {
    await assert.rejects(() => apply(ctx, { mode: 'cellgent' }), /cellgent mode is deferred/);
    await assert.rejects(() => apply(ctx, { mode: 'local', robotConnection: {} }), /expected config/);
    await apply(ctx, { mode: 'local' });
    assert.deepEqual(injected.map(item => item.deps), [['connection', 'webServer']]);
    const scope = {
      get(service) { return service === 'connection' ? connection : service === 'dingtalkRelay' ? relay : undefined; },
      effect(action) { return action(); },
    };
    injected[0].action(scope);
    const call = async (method, payload) => {
      const response = await routes.get(`/api/dsh-dingtalk/${method}`).fetch(new Request(`http://127.0.0.1/api/dsh-dingtalk/${method}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: `dsh-dingtalk/${method}`, payload }),
      }));
      return (await response.json()).result;
    };
    assert.equal((await call('bootstrap', { context: { origin: 'https://evil.example', returnPath: '/settings' } })).ok, false);
    const started = await call('bootstrap', { context: { origin: `https://${host}`, returnPath: '/settings' } });
    assert.equal(started.ok, true);
    const browserId = started.value.browserId;
    const status = await call('relay-status', { browserId });
    assert.equal(status.ok, true);
    assert.equal(status.value.status, 'authorizing');
    assert.equal(typeof status.value.authorizeUrl, 'string');
    assert.equal(status.value.authorizeUrl.startsWith(`https://${host}/relay/login?`), true);
    const connected = await call('relay-connect', { browserId });
    assert.equal(connected.ok, true);
    assert.equal(connected.value.status, 'authorizing');
    const upper = await call('status', { browserId });
    assert.equal(upper.ok, true);
    assert.equal(upper.value.state, 'unlinked');
    delete process.env.DSH_DINGTALK_CONNECTOR_SOCKET;
    delete process.env.DSH_DINGTALK_CONNECTOR_URL;
    delete process.env.DSH_DINGTALK_TRUSTED_ORIGINS;
    injected.length = 0;
    routes.clear();
    await apply(ctx, { mode: 'connector' });
    const connectorScope = {
      get(service) { return service === 'connection' ? connection : service === 'dingtalkRelay' ? relay : undefined; },
      effect(action) { return action(); },
    };
    injected[0].action(connectorScope);
    const localStart = await call('bootstrap', { context: { origin: 'http://127.0.0.1:3080', returnPath: '/settings' } });
    assert.equal(localStart.ok, true);
    const offline = await call('status', { browserId: localStart.value.browserId });
    assert.equal(offline.ok, true);
    assert.equal(offline.value.state, 'unknown');
    const robot = await call('relay-status', { browserId: localStart.value.browserId });
    assert.equal(robot.ok, true);
    assert.equal(robot.value.status, 'authorizing');
  } finally {
    if (previous === undefined) delete process.env.CELLGENT_PUBLIC_HOST;
    else process.env.CELLGENT_PUBLIC_HOST = previous;
  }
});
