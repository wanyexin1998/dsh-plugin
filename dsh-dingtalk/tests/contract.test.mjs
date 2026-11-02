import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ConnectionServiceError, createConnectionService, REASON_CODES } from '../lib/shared/index.js';
import { parseConfig } from '../lib/shared/config.js';

function mockBackend(mode) {
  let state = 'unlinked';
  const backend = {
    mode, calls: 0, disposed: 0,
    status: async () => ({ state, accessToken: 'test-private-material', account: { organizationName: '测试企业', displayName: '测试用户', userId: 'private-id' } }),
    beginAuthorization: async () => {
      state = 'authorizing';
      return { transactionId: 'test-transaction-1234567890123456', authorizeUrl: 'https://example.invalid/oauth?response_type=code', expiresAt: '2030-01-01T00:00:00Z', authCode: 'private' };
    },
    getAuthorizationStatus: async () => ({ state }),
    complete() { state = 'connected'; },
    disconnect: async () => { state = 'unlinked'; return { disconnected: true, profileRef: 'private' }; },
    invoke: async () => { backend.calls++; return state === 'connected' ? { status: 'ok', data: { items: [] }, accessToken: 'private' } : { status: 'auth_required', reasonCode: 'not_connected' }; },
    dispose() { backend.disposed++; },
  };
  return backend;
}

for (const mode of ['local', 'cellgent']) {
  test(`${mode} mock adapter: shared authorization/read/disconnect contract and public projections`, async () => {
    const backend = mockBackend(mode);
    const owner = createConnectionService(backend);
    assert.deepEqual(await owner.service.status(), { state: 'unlinked', account: { organizationName: '测试企业', displayName: '测试用户' } });
    assert.deepEqual(await owner.service.invoke({ operationId: 'identity.getSelf', args: {} }), { status: 'auth_required', reasonCode: 'not_connected' });
    const start = await owner.service.beginAuthorization({ sessionRef: 'same-session', callRef: 'same-call' });
    assert.deepEqual(Object.keys(start).sort(), ['authorizeUrl', 'expiresAt', 'transactionId']);
    assert.equal((await owner.service.getAuthorizationStatus(start.transactionId)).state, 'authorizing');
    backend.complete();
    assert.equal((await owner.service.getAuthorizationStatus(start.transactionId)).state, 'connected');
    assert.deepEqual(await owner.service.invoke({ operationId: 'calendar.listEvents', args: { limit: 10 } }), { status: 'ok', data: { items: [] } });
    assert.deepEqual(await owner.service.disconnect(), { disconnected: true });
    await owner.dispose(); await owner.dispose();
    assert.equal(backend.disposed, 1);
    await assert.rejects(owner.service.status(), { reasonCode: 'service_disposed' });
    assert.equal((await owner.service.invoke({ operationId: 'identity.getSelf', args: {} })).reasonCode, 'service_disposed');
  });
}

test('reject dangerous/unknown targets before invoking an adapter', async () => {
  const backend = mockBackend('local');
  const owner = createConnectionService(backend);
  for (const input of [
    { operationId: 'message.send', args: {} },
    { operationId: 'identity.getSelf', args: { profile: 'other-user' } },
    { operationId: 'identity.getSelf', args: {}, userId: 'other-user' },
    { operationId: 'docs.search', args: { command: 'auth logout' } },
    { operationId: 'docs.search', args: { path: '/private' } },
    { operationId: 'docs.search', args: { query: 'ok', limit: 31 } },
    { operationId: 'calendar.listEvents', args: { limit: 101 } },
    { operationId: 'calendar.listEvents', args: { start: '2026-11-02T00:00:00' } },
    { operationId: 'calendar.listEvents', args: { start: '2026-02-30T00:00:00Z' } },
    { operationId: 'calendar.listEvents', args: { start: '2026-11-03T00:00:00Z', end: '2026-11-02T00:00:00Z' } },
  ]) assert.deepEqual(await owner.service.invoke(input), { status: 'failed', reasonCode: 'invalid_request', retryable: false });
  assert.equal(backend.calls, 0);
  await assert.rejects(owner.service.beginAuthorization({ userId: 'other' }), { reasonCode: 'invalid_request' });
  await assert.rejects(owner.service.getAuthorizationStatus('../../profile'), { reasonCode: 'invalid_request' });
  await owner.dispose();
});

test('adapter errors and credential-shaped business fields never escape the service', async () => {
  const backend = mockBackend('local');
  backend.invoke = async () => ({ status: 'ok', data: { nested: { refresh_token: 'private-value' } } });
  backend.status = async () => { throw new Error('private-path / secret-value'); };
  backend.beginAuthorization = async () => ({ transactionId: 'x'.repeat(32), authorizeUrl: 'https://example.invalid/?authCode=private', expiresAt: '2030-01-01T00:00:00Z' });
  const owner = createConnectionService(backend);
  assert.deepEqual(await owner.service.invoke({ operationId: 'identity.getSelf', args: {} }), { status: 'failed', reasonCode: 'service_unavailable', retryable: true });
  await assert.rejects(owner.service.status(), error => error instanceof ConnectionServiceError && error.reasonCode === 'service_unavailable' && !error.message.includes('private'));
  await assert.rejects(owner.service.beginAuthorization({}), { reasonCode: 'service_unavailable' });
  await owner.dispose();
});

test('adapter input is detached from mutable caller arguments', async () => {
  const backend = mockBackend('local');
  let finish, received;
  backend.invoke = args => { received = args; return new Promise(resolve => { finish = resolve; }); };
  const owner = createConnectionService(backend);
  const args = {};
  const pending = owner.service.invoke({ operationId: 'identity.getSelf', args });
  args.profile = 'injected-after-validation';
  assert.deepEqual(received, { operationId: 'identity.getSelf', args: {} });
  finish({ status: 'auth_required', reasonCode: 'not_connected' });
  await pending;
  await owner.dispose();
});

test('unload prevents a late in-flight result from returning', async () => {
  let complete;
  const backend = mockBackend('local');
  backend.status = () => new Promise(resolve => { complete = resolve; });
  const owner = createConnectionService(backend);
  const pending = owner.service.status();
  await owner.dispose();
  complete({ state: 'connected' });
  await assert.rejects(pending, { reasonCode: 'service_disposed' });
});

test('stable reason-code snapshot and explicit P0 mode validation', async () => {
  assert.deepEqual(REASON_CODES, JSON.parse(await readFile(new URL('./fixtures/reason-codes.json', import.meta.url), 'utf8')));
  assert.equal(parseConfig({}).mode, 'local');
  assert.throws(() => parseConfig({ mode: 'cellgent' }), /deferred/);
  for (const config of [{ mode: null }, { mode: 'remote' }, { profile: 'other' }, []]) assert.throws(() => parseConfig(config));
});
