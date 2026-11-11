import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteConnection, createRemoteConnectionFor, parseRemoteSettings } from '../lib/adapters/remote/index.js';
import { createUIRpc } from '../lib/host/ui-rpc.js';
import { parseConfig, DEFAULT_LIMITS } from '../lib/shared/config.js';
import { createConnectionService } from '../lib/shared/service.js';

const tokenValue = 'a'.repeat(64);
async function fakeConnector(overrides = {}) {
  const requests = [];
  const state = {
    status: { status: { state: 'connected', account: { organizationName: '已验证企业', displayName: '已授权账号' } }, identity: { corpId: 'test-corp', userId: 'test-user' } },
    prepare: { state: 'ready', callbackOrigin: 'https://connector.test', protocol: 1 },
    begin: { transactionId: 'x'.repeat(32), authorizeUrl: 'https://connector.test/dsh-dingtalk/start?t=ticket', expiresAt: new Date(Date.now() + 120000).toISOString() },
    invoke: { result: { status: 'ok', data: { synthetic: true } } },
    disconnected: { disconnected: true },
    protocol: 1,
    healthAvailable: true,
    healthCalls: 0,
    cancel: { status: { state: 'user_cancelled', reasonCode: 'user_cancelled' } },
    cancelError: undefined,
    cancelGate: undefined,
    prepareGate: undefined,
    ...overrides,
  };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/health') {
      state.healthCalls++;
      if (!state.healthAvailable) return reply({ ok: false, error: { code: 'service_unavailable' } }, 503);
      return reply({ ok: true, value: { ok: true, protocol: state.protocol, version: '0.1.0', callbackOrigin: 'https://connector.test' } });
    }
    if (req.headers.authorization !== `Bearer ${tokenValue}`) return reply({ ok: false, error: { code: 'invalid_request' } }, 403);
    if (req.url === '/v1/status') return reply({ ok: true, value: state.status });
    if (req.url === '/v1/prepare') { if (state.prepareGate) await (typeof state.prepareGate === 'function' ? state.prepareGate() : state.prepareGate); return reply({ ok: true, value: state.prepare }); }
    if (req.url === '/v1/authorization/begin') return reply({ ok: true, value: state.begin });
    if (req.url === '/v1/authorization/cancel') {
      if (state.cancelGate) await (typeof state.cancelGate === 'function' ? state.cancelGate() : state.cancelGate);
      if (state.cancelError) return reply({ ok: false, error: state.cancelError }, 400);
      return reply({ ok: true, value: state.cancel });
    }
    if (req.url === '/v1/disconnect') return reply({ ok: true, value: state.disconnected });
    if (req.url === '/v1/invoke') return reply({ ok: true, value: state.invoke });
    return reply({ ok: false, error: { code: 'invalid_request' } }, 404);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    state, requests, server,
    port: server.address().port,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
  };
}
async function isolatedToken() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-'));
  const file = join(root, 'token');
  await writeFile(file, tokenValue);
  return { root, file };
}
const settingsFor = fake => ({ endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: 'PLACEHOLDER' }, trustedOrigins: ['https://dsh.test'], testTransport: true });
test('mode selection accepts connector and still rejects cellgent; remote settings fail closed', () => {
  assert.equal(parseConfig({ mode: 'connector' }).mode, 'connector');
  assert.throws(() => parseConfig({ mode: 'cellgent' }), /cellgent mode is deferred/);
  assert.throws(() => parseConfig({ mode: 'ssh' }), /mode must be/);
  assert.throws(() => parseRemoteSettings({}), { reasonCode: 'backend_not_ready' });
  assert.throws(() => parseRemoteSettings({ DSH_DINGTALK_CONNECTOR_SOCKET: 'relative.sock', DSH_DINGTALK_TRUSTED_ORIGINS: 'https://dsh.test' }), { reasonCode: 'local_configuration_invalid' });
  assert.throws(() => parseRemoteSettings({ DSH_DINGTALK_CONNECTOR_URL: 'http://127.0.0.1:8791', DSH_DINGTALK_TRUSTED_ORIGINS: 'https://dsh.test' }), { reasonCode: 'local_configuration_invalid' });
  assert.throws(() => parseRemoteSettings({ DSH_DINGTALK_CONNECTOR_SOCKET: '/run/caller.sock' }), { reasonCode: 'local_configuration_invalid' });
  assert.throws(() => parseRemoteSettings({ DSH_DINGTALK_CONNECTOR_SOCKET: '/run/caller.sock', DSH_DINGTALK_TRUSTED_ORIGINS: 'http://dsh.test' }), /invalid trusted origin/);
  assert.deepEqual(
    parseRemoteSettings({ DSH_DINGTALK_CONNECTOR_SOCKET: '/run/caller.sock', DSH_DINGTALK_TRUSTED_ORIGINS: 'https://dsh.test' }).trustedOrigins,
    ['https://dsh.test'],
  );
});
test('seat pairs before data consent and IM calls require the currently authorized sender', async () => {
  const fake = await fakeConnector();
  const token = await isolatedToken();
  const principal = { corpId: 'test-corp', userId: 'test-user' };
  const settings = { ...settingsFor(fake), seatIdentity: principal, endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } };
  const connection = await createRemoteConnection(settings, DEFAULT_LIMITS);
  const input = { operationId: 'identity.getSelf', args: {} };
  try {
    assert.deepEqual(connection.identity(), principal);
    assert.equal((await connection.invokeFor({ ...principal, userId: 'other' }, input)).reasonCode, 'identity_mismatch');
    assert.equal((await connection.invokeFor(principal, input)).status, 'ok');
    assert.equal(fake.requests.at(-1).body.expectedProfile, 'test-corp:test-user');
    fake.state.status = { status: { state: 'unlinked', reasonCode: 'not_connected' }, identity: null };
    assert.equal((await connection.invokeFor(principal, input)).status, 'auth_required');
    assert.deepEqual(connection.identity(), principal);
    assert.equal(fake.requests.filter(r => r.path === '/v1/invoke').length, 1);
  } finally {
    await connection.backend.dispose();
    await fake.close();
    await rm(token.root, { recursive: true, force: true });
  }
});
test('offline connector degrades to backend_not_ready without throwing during plugin load', async () => {
  const connection = await createRemoteConnectionFor({}, { ...DEFAULT_LIMITS, timeoutMs: 1000 });
  assert.equal((await connection.backend.status()).reasonCode, 'backend_not_ready');
  assert.equal((await connection.backend.invoke({ operationId: 'identity.getSelf', args: {} })).status, 'failed');
  assert.equal(connection.identity(), undefined);
  assert.equal(connection.prepareStatus().state, 'failed');
  await connection.backend.dispose();
});
test('remote backend maps status/prepare/invoke, keeps catalog local, and forwards DWS execution', async () => {
  const fake = await fakeConnector();
  const token = await isolatedToken();
  try {
    const settings = { ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } };
    const connection = await createRemoteConnection(settings, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    const owner = createConnectionService(connection.backend);
    assert.equal((await owner.service.status()).state, 'connected');
    assert.deepEqual(connection.identity(), { corpId: 'test-corp', userId: 'test-user' });
    const prepared = await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/chat' }, () => connection.prepareStart());
    assert.equal(prepared.state, 'running');
    for (let attempt = 0; attempt < 100 && connection.prepareStatus().state === 'running'; attempt++) await new Promise(done => setTimeout(done, 10));
    assert.equal(connection.prepareStatus().state, 'ready');
    assert.equal(await connection.callbackOriginReady(), 'https://connector.test');
    const begin = await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/chat/../chat?panel=1' }, () => owner.service.beginAuthorization({}));
    assert.match(begin.authorizeUrl, /^https:\/\/connector\.test\/dsh-dingtalk\/start\?t=/);
    await assert.rejects(connection.ui('browser', { origin: 'https://evil.test', returnPath: '/' }, () => owner.service.beginAuthorization({})), { reasonCode: 'invalid_request' });
    assert.equal((await owner.service.invoke({ operationId: 'identity.getSelf', args: {} })).status, 'ok');
    const catalogCalls = fake.requests.filter(request => request.path === '/v1/invoke').length;
    const catalog = await owner.service.invoke({ operationId: 'dws.catalog', args: { product: 'contact', limit: 1 } });
    assert.equal(catalog.status, 'ok');
    assert.equal(fake.requests.filter(request => request.path === '/v1/invoke').length, catalogCalls, 'catalog is answered locally');
    const described = await owner.service.invoke({ operationId: 'dws.describe', args: { command: 'doc search' } });
    assert.equal(described.status, 'ok');
    assert.equal(fake.requests.filter(request => request.path === '/v1/invoke').length, catalogCalls, 'describe is answered locally');
    const read = await owner.service.invoke({ operationId: 'dws.execute', args: { command: 'doc search', parameters: {} } });
    assert.equal(read.status, 'ok');
    const readRequest = fake.requests.filter(request => request.path === '/v1/invoke').at(-1);
    assert.equal(readRequest.body.operationId, 'dws.execute');
    assert.equal(readRequest.body.confirmed, undefined);
    const afterRead = fake.requests.filter(request => request.path === '/v1/invoke').length;
    const writeInput = { operationId: 'dws.execute', args: { command: 'calendar event create', parameters: { title: '合成', start: '2026-11-11T01:00:00Z', end: '2026-11-11T02:00:00Z' } } };
    const blocked = await owner.service.invoke(writeInput);
    assert.equal(blocked.status, 'denied');
    assert.equal(blocked.reasonCode, 'confirmation_required');
    assert.equal(fake.requests.filter(request => request.path === '/v1/invoke').length, afterRead, 'unconfirmed writes are not sent');
    const write = await owner.service.invoke(writeInput, { approve: async () => true, sessionId: 'session-1' });
    assert.equal(write.status, 'ok');
    const writeRequest = fake.requests.filter(request => request.path === '/v1/invoke').at(-1);
    assert.equal(writeRequest.body.operationId, 'dws.execute');
    assert.equal(writeRequest.body.confirmed, true);
    assert.equal(writeRequest.body.sessionId, 'session-1');
    assert.equal(Object.keys(writeRequest.body).some(key => ['userId', 'corpId', 'profile', 'token'].includes(key)), false);
    const jobs = await owner.service.invoke({ operationId: 'dws.jobs', args: { action: 'list' } }, { sessionId: 'session-1' });
    assert.equal(jobs.status, 'ok');
    assert.equal(fake.requests.filter(request => request.path === '/v1/invoke').at(-1).body.operationId, 'dws.jobs');
    const forged = await owner.service.invoke({ operationId: 'identity.getSelf', args: { profile: 'other:user' } });
    assert.equal(forged.status, 'failed');
    assert.equal(forged.reasonCode, 'invalid_request');
    const sent = fake.requests.filter(request => request.path === '/v1/invoke').length;
    const forgedUser = await owner.service.invoke({ operationId: 'dws.execute', args: { command: 'doc search', parameters: {}, userId: 'other' } });
    assert.equal(forgedUser.status, 'failed');
    assert.equal(forgedUser.reasonCode, 'invalid_request');
    assert.equal(fake.requests.filter(request => request.path === '/v1/invoke').length, sent, 'forged identity is not sent');
    await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/' }, () => owner.service.disconnect());
    assert.equal((await owner.service.status()).state, 'connected', 'fake connector keeps reporting connected');
    await owner.dispose();
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
test('protocol mismatch and capability-token errors surface as backend_not_ready/service_unavailable', async () => {
  const mismatched = await fakeConnector({ protocol: 99 });
  const healthy = await fakeConnector();
  const token = await isolatedToken();
  try {
    const mismatchConnection = await createRemoteConnection(
      { ...settingsFor(mismatched), endpoint: { host: '127.0.0.1', port: mismatched.port, tokenFile: token.file } },
      { ...DEFAULT_LIMITS, timeoutMs: 2000 },
    );
    assert.equal((await mismatchConnection.backend.status()).reasonCode, 'backend_not_ready');
    await mismatchConnection.backend.dispose();
    await writeFile(token.file, 'not-a-token');
    const wrong = await createRemoteConnection(
      { ...settingsFor(healthy), endpoint: { host: '127.0.0.1', port: healthy.port, tokenFile: token.file } },
      { ...DEFAULT_LIMITS, timeoutMs: 2000 },
    );
    assert.equal((await wrong.backend.status()).reasonCode, 'service_unavailable');
    await wrong.backend.dispose();
  } finally {
    await mismatched.close();
    await healthy.close();
    await rm(token.root, { recursive: true, force: true });
  }
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function uiHarness(connection, serviceOverrides = {}) {
  const owner = { id: 'browser', principal: { kind: 'owner' } };
  const routes = new Map();
  const host = { browserPeer: owner, admit: () => ({ peer: owner }), fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } };
  const service = { status: async () => ({ state: 'unlinked' }), beginAuthorization: async () => ({ transactionId: 'tx' }), getAuthorizationStatus: async () => ({ state: 'authorizing' }), disconnect: async () => ({ disconnected: true }), ...serviceOverrides };
  const cleanup = createUIRpc(host, connection, service);
  const call = async (method, payload) => {
    const route = routes.get('/api/dsh-dingtalk/' + method);
    const response = await route.fetch(new Request('http://127.0.0.1/api/dsh-dingtalk/' + method, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: 'dsh-dingtalk/' + method, payload }) }));
    return (await response.json()).result;
  };
  return { call, cleanup };
}
test('connector bootstrap accepts only exact trusted HTTPS origins and safe return paths', async () => {
  const fake = await fakeConnector();
  const token = await isolatedToken();
  try {
    const connection = await createRemoteConnection({ ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } }, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    const { call, cleanup } = uiHarness(connection);
    try {
      const accepted = await call('bootstrap', { context: { origin: 'https://dsh.test', returnPath: '/chat?panel=1' } });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      assert.equal(accepted.value.callbackOrigin, 'https://connector.test');
      const rejected = [
        { origin: 'https://evil.test', returnPath: '/chat' },
        { origin: 'dsh-app://app', returnPath: '/chat' },
        { origin: 'https://dsh.test', returnPath: '//evil.test' },
        { origin: 'https://dsh.test', returnPath: '/?token=private' },
        { origin: 'https://dsh.test', returnPath: '/\\evil.test' },
        { origin: 'https://dsh.test', returnPath: '/chat', extra: true },
        { origin: 'not-a-url', returnPath: '/chat' },
      ];
      for (const context of rejected) assert.equal((await call('bootstrap', { context })).ok, false, JSON.stringify(context));
    } finally { await cleanup(); await connection.backend.dispose(); }
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
test('remote readiness re-probes after recovery, merges concurrent probes and fails closed on protocol mismatch or disposal', async () => {
  const fake = await fakeConnector({ healthAvailable: false });
  const token = await isolatedToken();
  try {
    const connection = await createRemoteConnection({ ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } }, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    assert.equal((await connection.backend.status()).reasonCode, 'service_unavailable');
    assert.equal(fake.state.healthCalls, 1);
    fake.state.healthAvailable = true;
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => connection.backend.status()));
    assert.deepEqual(concurrent.map(item => item.state), Array(8).fill('connected'));
    assert.equal(fake.state.healthCalls, 2, 'concurrent success probes are merged into one health call');
    await Promise.all(Array.from({ length: 3 }, () => connection.backend.status()));
    assert.equal(fake.state.healthCalls, 2, 'a verified probe is reused');
    await connection.backend.dispose();
    assert.equal((await connection.backend.status()).reasonCode, 'service_disposed');
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
  const mismatched = await fakeConnector({ protocol: 99 });
  const token2 = await isolatedToken();
  try {
    const connection = await createRemoteConnection({ ...settingsFor(mismatched), endpoint: { host: '127.0.0.1', port: mismatched.port, tokenFile: token2.file } }, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    assert.equal((await connection.backend.status()).reasonCode, 'backend_not_ready');
    await connection.backend.dispose();
  } finally { await mismatched.close(); await rm(token2.root, { recursive: true, force: true }); }
});
test('remote cancel awaits the server result and surfaces errors without retrying', async () => {
  const fake = await fakeConnector();
  const token = await isolatedToken();
  try {
    const connection = await createRemoteConnection({ ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } }, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    const { call, cleanup } = uiHarness(connection);
    try {
      const browser = (await call('bootstrap', { context: { origin: 'https://dsh.test', returnPath: '/chat' } })).value.browserId;
      const gate = deferred();
      fake.state.cancelGate = gate.promise;
      let settled = false;
      const pending = call('cancel', { browserId: browser, transactionId: 'x'.repeat(32) }).then(result => { settled = true; return result; });
      await new Promise(done => setTimeout(done, 50));
      assert.equal(settled, false, 'UI cancel must not complete before the Connector answers');
      gate.resolve();
      const cancelled = await pending;
      assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
      assert.deepEqual(cancelled.value, { state: 'user_cancelled', reasonCode: 'user_cancelled' });
      assert.equal(fake.requests.filter(item => item.path === '/v1/authorization/cancel').length, 1);
      fake.state.cancelGate = undefined;
      fake.state.cancelError = { code: 'invalid_auth_state' };
      const failed = await call('cancel', { browserId: browser, transactionId: 'y'.repeat(32) });
      assert.equal(failed.ok, false);
      assert.equal(failed.error.code, 'invalid_auth_state');
      assert.equal(fake.requests.filter(item => item.path === '/v1/authorization/cancel').length, 2, 'failed cancel is not retried automatically');
    } finally { await cleanup(); await connection.backend.dispose(); }
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
test('prepare cancellation wins over a late response and a new prepare is not overwritten by the old task', async () => {
  const fake = await fakeConnector();
  const token = await isolatedToken();
  try {
    const connection = await createRemoteConnection({ ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } }, { ...DEFAULT_LIMITS, timeoutMs: 5000 });
    const first = deferred();
    const second = deferred();
    const gates = [first.promise, second.promise];
    fake.state.prepareGate = () => gates.shift() ?? Promise.resolve();
    const started = await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/chat' }, async () => connection.prepareStart());
    assert.equal(started.state, 'running');
    const cancelled = await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/chat' }, async () => connection.prepareCancel());
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(connection.prepareStatus().state, 'cancelled');
    first.resolve();
    await new Promise(done => setTimeout(done, 50));
    assert.equal(connection.prepareStatus().state, 'cancelled', 'late response must not overwrite cancelled');
    const restarted = await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/chat' }, async () => connection.prepareStart());
    assert.equal(restarted.state, 'running');
    second.resolve();
    for (let attempt = 0; attempt < 100 && connection.prepareStatus().state === 'running'; attempt++) await new Promise(done => setTimeout(done, 10));
    assert.equal(connection.prepareStatus().state, 'ready');
    await connection.backend.dispose();
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
