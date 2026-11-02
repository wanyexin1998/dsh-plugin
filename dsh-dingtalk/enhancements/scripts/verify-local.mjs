import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalBackend } from '../lib/adapters/local/index.js';
import { DEFAULT_LIMITS } from '../lib/shared/config.js';
import { run, sandbox, verifiedBinary } from './g0/runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = await verifiedBinary(resolve(root, '../.cache/dingtalk-g0/bin-amd64/dws.exe'));
const isolated = await sandbox();
const events = [];
const fixtureErrors = [];
const state = { user: 'test-user-a', refreshes: 0 };
const secretFor = user => ({ access: `synthetic-${user}-access`, refresh: `synthetic-${user}-refresh`, code: 'synthetic-one-use-code' });
const server = createServer(async (request, response) => {
  try {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = data ? JSON.parse(data) : {};
    let value;
    if (request.url === '/cli/clientId') value = { success: true, result: 'synthetic-app' };
    else if (request.url === '/oauth2/getToken' || request.url === '/oauth2/refreshToken') {
      const refresh = request.url.endsWith('refreshToken');
      const user = refresh ? ['test-user-a', 'test-user-b'].find(user => secretFor(user).refresh === body.refreshToken) : state.user;
      assert.ok(user);
      if (refresh) state.refreshes++;
      const secrets = secretFor(user);
      value = { accessToken: secrets.access, refreshToken: secrets.refresh, expiresIn: refresh || user === 'test-user-a' ? 7200 : 1, corpId: 'test-corp' };
    } else if (body.method === 'initialize') value = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'dsh-dingtalk-test-only', version: '1' } } };
    else if (body.method === 'tools/call') {
      const user = ['test-user-a', 'test-user-b'].find(user => secretFor(user).access === request.headers['x-user-access-token']);
      assert.ok(user);
      const name = body.params.name;
      events.push({ name, user });
      const result = name === 'get_current_user_profile' ? [{ orgEmployeeModel: { corpId: 'test-corp', userId: user } }] :
        { items: [{ title: '合成测试结果', userId: user }], events: [], documents: [], nextCursor: '' };
      assert.ok(['get_current_user_profile', 'list_calendar_events', 'search_documents'].includes(name));
      value = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ result }) }], isError: false } };
    } else throw new Error('Unexpected fixture request');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));
  } catch {
    fixtureErrors.push('fixture_protocol_error'); response.statusCode = 500; response.end('{}');
  }
});
let backend;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(isolated.config, 'mcp_url'), base);
  Object.assign(isolated.env, { DWS_ALLOW_HTTP_ENDPOINTS: '1', DWS_TRUSTED_DOMAINS: '127.0.0.1', DINGTALK_CONTACT_MCP_URL: `${base}/contact`, DINGTALK_CALENDAR_MCP_URL: `${base}/calendar`, DINGTALK_DOC_MCP_URL: `${base}/doc` });
  for (const user of ['test-user-a', 'test-user-b']) {
    state.user = user;
    const saved = await run(binary, ['auth', 'exchange', '--client-id', 'default', '--code-stdin', '--format', 'json'], { env: isolated.env, cwd: isolated.root, input: secretFor(user).code });
    assert.equal(saved.code, 0, 'Synthetic exchange failed');
    for (const name of ['test-user-a', 'test-user-b']) for (const secret of Object.values(secretFor(name))) assert.ok(!(saved.stdout + saved.stderr).includes(secret));
  }
  const before = JSON.parse(await readFile(join(isolated.config, 'profiles.json'), 'utf8'));
  assert.equal(before.currentProfile, 'test-corp:test-user-a');
  events.length = 0;
  const unbound = createLocalBackend({ binaryPath: binary, configDirectory: isolated.config }, { ...DEFAULT_LIMITS }, { environment: isolated.env });
  try {
    assert.equal((await unbound.status()).state, 'unlinked');
    assert.deepEqual(await unbound.invoke({ operationId: 'identity.getSelf', args: {} }), { status: 'auth_required', reasonCode: 'not_connected' });
    assert.equal(events.length, 0);
  } finally { await unbound.dispose(); }
  backend = createLocalBackend({ binaryPath: binary, configDirectory: isolated.config, profile: 'test-corp:test-user-b' }, { ...DEFAULT_LIMITS, timeoutMs: 15000 }, { environment: isolated.env });
  const initial = await backend.status();
  assert.ok(initial.state !== 'connected');
  const checks = ['unbound backend does not read the existing default Profile or call MCP'];
  for (const request of [{ operationId: 'identity.getSelf', args: {} },
    { operationId: 'calendar.listEvents', args: { start: '2026-11-02T00:00:00+08:00', end: '2026-11-03T00:00:00+08:00', limit: 2 } },
    { operationId: 'docs.search', args: { query: '合成测试', limit: 2 } }]) {
    const result = await backend.invoke(request);
    assert.equal(result.status, 'ok', `${request.operationId}: ${result.reasonCode}`);
    for (const user of ['test-user-a', 'test-user-b']) for (const secret of Object.values(secretFor(user))) assert.ok(!JSON.stringify(result).includes(secret));
    checks.push(`${request.operationId}: verified official binary + isolated synthetic MCP JSON`);
  }
  assert.ok(events.length >= 3 && events.every(event => event.user === 'test-user-b'));
  assert.ok(events.some(event => event.name === 'list_calendar_events') && events.some(event => event.name === 'search_documents'));
  assert.ok(state.refreshes > 0);
  const after = JSON.parse(await readFile(join(isolated.config, 'profiles.json'), 'utf8'));
  assert.equal(after.currentProfile, before.currentProfile);
  assert.deepEqual(after.profiles.find(profile => profile.userId === 'test-user-a'), before.profiles.find(profile => profile.userId === 'test-user-a'));
  checks.push('bound profile B used for every MCP request; current profile A and its metadata unchanged');
  checks.push('short-lived synthetic token refreshed by official DWS');
  assert.equal((await backend.status()).state, 'connected');
  assert.deepEqual(fixtureErrors, []);
  const diagnostics = await readFile(join(isolated.config, 'logs/dws.log'), 'utf8');
  const report = { success: true, classification: 'OFFICIAL_BINARY_LOCAL_FIXTURES_ONLY', dwsVersion: '1.0.66', platform: `${process.platform}-${process.arch}`, checks,
    observedReadOnlyTools: [...new Set(events.map(event => event.name))], realAuthorization: false, realBusinessData: false,
    upstreamLogObservation: { syntheticSearchQueryPresent: diagnostics.includes('合成测试'), productionLogPrivacyAccepted: false },
    limitations: ['No enterprise OAuth or IT permission acceptance', 'No Agent Tool or browser UI', 'Upstream DWS owns credential and diagnostic-log persistence; production log privacy remains a release review item'] };
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/issue-6-local-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: true, checks: checks.length, classification: report.classification }, null, 2));
} finally {
  await backend?.dispose();
  await new Promise(resolve => server.close(resolve));
  await isolated.dispose();
}
