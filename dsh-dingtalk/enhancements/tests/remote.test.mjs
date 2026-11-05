import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteConnection, createRemoteConnectionFor, parseRemoteSettings } from '../lib/adapters/remote/index.js';
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
    ...overrides,
  };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    const reply = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/health') return reply({ ok: true, value: { ok: true, protocol: state.protocol, version: '0.1.0', callbackOrigin: 'https://connector.test' } });
    if (req.headers.authorization !== `Bearer ${tokenValue}`) return reply({ ok: false, error: { code: 'invalid_request' } }, 403);
    if (req.url === '/v1/status') return reply({ ok: true, value: state.status });
    if (req.url === '/v1/prepare') return reply({ ok: true, value: state.prepare });
    if (req.url === '/v1/authorization/begin') return reply({ ok: true, value: state.begin });
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
test('offline connector degrades to backend_not_ready without throwing during plugin load', async () => {
  const connection = await createRemoteConnectionFor({}, { ...DEFAULT_LIMITS, timeoutMs: 1000 });
  assert.equal((await connection.backend.status()).reasonCode, 'backend_not_ready');
  assert.equal((await connection.backend.invoke({ operationId: 'identity.getSelf', args: {} })).status, 'failed');
  assert.equal(connection.identity(), undefined);
  assert.equal(connection.prepareStatus().state, 'failed');
  await connection.backend.dispose();
});
test('remote backend maps status/prepare/invoke and keeps catalog and unsupported operations local', async () => {
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
    const denied = await owner.service.invoke({ operationId: 'dws.execute', args: { command: 'calendar event create', parameters: {} } });
    assert.equal(denied.status, 'denied');
    assert.equal(denied.reasonCode, 'command_unavailable');
    const forged = await owner.service.invoke({ operationId: 'identity.getSelf', args: { profile: 'other:user' } });
    assert.equal(forged.status, 'failed');
    await connection.ui('browser', { origin: 'https://dsh.test', returnPath: '/' }, () => owner.service.disconnect());
    assert.equal((await owner.service.status()).state, 'connected', 'fake connector keeps reporting connected');
    await owner.dispose();
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
test('protocol mismatch and capability-token errors surface as backend_not_ready/service_unavailable', async () => {
  const fake = await fakeConnector({ protocol: 99 });
  const token = await isolatedToken();
  try {
    const settings = { ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } };
    const connection = await createRemoteConnection(settings, { ...DEFAULT_LIMITS, timeoutMs: 2000 });
    assert.equal((await connection.backend.status()).reasonCode, 'backend_not_ready');
    await connection.backend.dispose();
    await writeFile(token.file, 'not-a-token');
    const wrong = await createRemoteConnection({ ...settingsFor(fake), endpoint: { host: '127.0.0.1', port: fake.port, tokenFile: token.file } }, { ...DEFAULT_LIMITS, timeoutMs: 2000 });
    assert.equal((await wrong.backend.status()).reasonCode, 'service_unavailable');
    await wrong.backend.dispose();
  } finally { await fake.close(); await rm(token.root, { recursive: true, force: true }); }
});
