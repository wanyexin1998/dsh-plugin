import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUIRpc } from '../lib/host/ui-rpc.js';
import { normalizeDwsError } from '../lib/adapters/local/errors.js';
for (const origin of ['http://127.0.0.1:3000', 'dsh-app://app']) test(`UI carrier/owner/capability and single-use revoke confirmation: ${origin}`, async () => {
  let epoch = 0, disconnected = 0, disposed = 0;
  const owner = { id: 'browser', principal: { kind: 'owner' } };
  const routes = new Map(); let admitted = owner;
  const connection = { browserPeer: owner, admit: () => ({ peer: admitted }), fetch: { register(route) { assert.equal(route.requestBody, 'buffered'); routes.set(route.path, route); return async () => { disposed++; }; } } };
  const service = { status: async () => ({ state: 'unlinked' }), beginAuthorization: async () => ({ transactionId: 'tx' }), getAuthorizationStatus: async () => ({ state: 'authorizing' }), disconnect: async () => { disconnected++; return { disconnected: true }; } };
  const cleanup = createUIRpc(connection, { ui: async (_id, _context, action) => action(), prepareStart: () => ({ state: 'running', progress: { phase: 'download', received: 20, total: 100 } }), prepareStatus: () => ({ state: 'ready' }), prepareCancel: async () => ({ state: 'cancelled' }), cancel: () => ({ state: 'user_cancelled' }), revision: () => epoch, callbackOrigin: 'http://127.0.0.1:5000' }, service);
  const call = async (method, payload, peer = owner) => { admitted = peer; const response = await routes.get(`/api/dsh-dingtalk/${method}`).fetch(new Request(`http://127.0.0.1/api/dsh-dingtalk/${method}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: `dsh-dingtalk/${method}`, payload }) })); return (await response.json()).result; };
  const context = { origin, returnPath: '/session/test' };
  try {
    assert.equal((await call('bootstrap', { context }, { id: 'api-owner', principal: { kind: 'owner' } })).ok, false);
    assert.equal((await call('bootstrap', { context }, { id: 'browser', principal: { kind: 'api' } })).ok, false);
    const { browserId } = (await call('bootstrap', { context })).value;
    // Local mode keeps its loopback/desktop-only rule; a remote HTTPS origin is not widened here.
    assert.equal((await call('bootstrap', { context: { origin: 'https://dsh.test', returnPath: '/chat' } })).ok, false);
    assert.equal((await call('status', { browserId: 'spoof' })).ok, false);
    assert.equal((await call('status', { browserId, userId: 'spoof' })).ok, false);
    assert.equal((await call('status', { browserId })).ok, true);
    for (const method of ['prepare-start', 'prepare-status', 'prepare-cancel']) {
      assert.equal((await call(method, { browserId }, { id: 'api-owner', principal: { kind: 'owner' } })).ok, false);
      assert.equal((await call(method, { browserId, url: 'https://untrusted.invalid/component' })).ok, false);
      assert.equal((await call(method, { browserId })).ok, true);
    }
    const statusRoute = routes.get('/api/dsh-dingtalk/status');
    const invalidEnvelope = await statusRoute.fetch(new Request('http://127.0.0.1/api/dsh-dingtalk/status', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'different', payload: { browserId } }) }));
    assert.equal(invalidEnvelope.status, 400);
    const oversized = await statusRoute.fetch(new Request('http://127.0.0.1/api/dsh-dingtalk/status', { method: 'POST', body: 'x'.repeat(17000) }));
    assert.equal(oversized.status, 413);
    const admit = connection.admit; connection.admit = () => ({ rejection: 401 });
    assert.equal((await statusRoute.fetch(new Request('http://127.0.0.1/api/dsh-dingtalk/status', { method: 'POST' }))).status, 401);
    connection.admit = admit;
    const stale = (await call('disconnect-preview', { browserId })).value.confirmation;
    epoch++;
    assert.equal((await call('disconnect-confirm', { browserId, confirmation: stale })).ok, false);
    const confirmation = (await call('disconnect-preview', { browserId })).value.confirmation;
    assert.equal((await call('disconnect-confirm', { browserId, confirmation: 'spoof' })).ok, false);
    assert.equal((await call('disconnect-confirm', { browserId, confirmation })).ok, false);
    const fresh = (await call('disconnect-preview', { browserId })).value.confirmation;
    assert.equal((await call('disconnect-confirm', { browserId, confirmation: fresh })).ok, true);
    assert.equal((await call('disconnect-confirm', { browserId, confirmation: fresh })).ok, false);
    assert.equal(disconnected, 1);
  } finally { await cleanup(); }
  assert.equal(disposed, routes.size);
});
test('error normalization uses reviewed envelope fields; 403/prose/unknown codes never imply IT denial', () => {
  const envelope = error => JSON.stringify({ error });
  for (const error of [{ category: 'api', code: 1, reason: 'http_403' }, { category: 'api', code: 1, message: 'cli_not_enabled permission denied org_cli_disabled' }, { category: 'auth', code: 2, reason: 'unknown' }, { category: 'api', code: 1, server_error_code: 'invented' }]) assert.ok(!['org_cli_disabled', 'app_permission_denied', 'authorization_expired'].includes(normalizeDwsError(error.code, envelope(error), '')));
  assert.equal(normalizeDwsError(1, envelope({ category: 'api', code: 1, reason: 'rate_limited', server_error_code: 'RATE_LIMIT_ERROR' }), ''), 'rate_limited');
  assert.equal(normalizeDwsError(1, envelope({ category: 'api', code: 1, reason: 'backend_dependency_unavailable' }), ''), 'service_unavailable');
  assert.equal(normalizeDwsError(1, '<raw private error>', ''), 'cli_failed');
  assert.equal(normalizeDwsError(4, JSON.stringify({ success: false, code: 'PAT_ORG_POLICY_DENIED' }), ''), 'org_policy_denied');
  assert.equal(normalizeDwsError(4, JSON.stringify({ success: false, code: 'PAT_SCOPE_AUTH_REQUIRED' }), ''), 'scope_authorization_required');
  assert.equal(normalizeDwsError(4, JSON.stringify({ success: false, code: 'PAT_NO_PERMISSION' }), ''), 'permission_denied');
  assert.equal(normalizeDwsError(1, JSON.stringify({ success: false, code: 'PAT_ORG_POLICY_DENIED' }), ''), 'cli_failed');
});
