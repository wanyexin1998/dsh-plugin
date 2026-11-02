import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { option, pluginRoot, run, sandbox, verifiedBinary } from './runtime.mjs';

const binary = await verifiedBinary(option('--binary', resolve(pluginRoot, '../.cache/dingtalk-g0/bin-amd64/dws.exe')));
const output = resolve(option('--out', resolve(pluginRoot, '../.cache/dingtalk-g0/exchange-report.json')));
const isolated = await sandbox();
const state = { user: 'test-user-a', mode: 'ok', requests: 0 };
// Synthetic materials only; none is a real code/token. Never include them in evidence.
const secrets = ['g0-fake-code', 'g0-fake-access', 'g0-fake-refresh'];
const observedPaths = new Set();
const server = createServer(async (request, response) => {
  state.requests++;
  observedPaths.add(request.url);
  let body = '';
  for await (const chunk of request) body += chunk;
  let payload = {};
  if (body) payload = JSON.parse(body);
  let value;
  if (request.url === '/cli/clientId') value = { success: true, result: 'test-app' };
  else if (request.url === '/oauth2/getToken') {
    if (state.mode === 'denied') {
      response.statusCode = 403;
      value = { success: false, errorCode: 'ENTERPRISE_NOT_AUTHORIZED', errorMsg: 'Synthetic denied fixture' };
    } else value = { accessToken: secrets[1], refreshToken: secrets[2], expiresIn: 7200, corpId: 'test-corp' };
  } else if (payload.method === 'initialize') value = { jsonrpc: '2.0', id: payload.id,
    result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'g0-test', version: '1' } } };
  else if (payload.method === 'tools/call') {
    assert.equal(request.headers['x-user-access-token'], secrets[1]);
    assert.equal(payload.params.name, 'get_current_user_profile');
    value = { jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: JSON.stringify({ result: [{ orgEmployeeModel: { corpId: 'test-corp', userId: state.user } }] }) }], isError: false } };
  } else { response.statusCode = 400; value = { error: 'Unrecognized fixture request' }; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
});
const checks = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(isolated.config, 'mcp_url'), base);
  Object.assign(isolated.env, { DWS_ALLOW_HTTP_ENDPOINTS: '1', DWS_TRUSTED_DOMAINS: '127.0.0.1', DINGTALK_CONTACT_MCP_URL: base + '/contact' });
  async function invoke(args, { input = '', success = true } = {}) {
    const result = await run(binary, [...args, '--format', 'json'], { env: isolated.env, cwd: isolated.root, input });
    assert.equal(result.code === 0, success, 'Unexpected CLI success/failure');
    for (const secret of secrets) assert.ok(!(result.stdout + result.stderr).includes(secret), 'Synthetic credential leaked to stdout/stderr');
    if (!success) return { exitCode: result.code, stdout: result.stdout ? JSON.parse(result.stdout) : null,
      stderr: result.stderr.trim().startsWith('{') ? JSON.parse(result.stderr) : result.stderr };
    return JSON.parse(result.stdout);
  }
  const exchange = extra => invoke(['auth', 'exchange', '--client-id', 'default', '--code-stdin', ...extra], { input: secrets[0] });
  const first = await exchange(['--expected-corp-id', 'test-corp', '--expected-user-id', state.user]);
  assert.equal(first.data.dwsProfile, 'test-corp:test-user-a');
  checks.push('online expected corp/user assertions accepted before saving exact profile A');
  state.user = 'test-user-b';
  const second = await exchange(['--expected-user-id', state.user]);
  assert.equal(second.data.currentProfile, 'test-corp:test-user-a');
  assert.equal(second.data.isCurrentProfile, false);
  checks.push('adding profile B preserves current profile A');
  const saved = await readFile(join(isolated.config, 'profiles.json'), 'utf8');
  await invoke(['auth', 'exchange', '--client-id', 'default', '--code-stdin', '--expected-user-id', 'wrong-user'], { input: secrets[0], success: false });
  assert.equal(await readFile(join(isolated.config, 'profiles.json'), 'utf8'), saved);
  checks.push('identity mismatch rejected; existing profiles unchanged');
  const before = state.requests;
  await invoke(['auth', 'exchange', '--client-id', 'default', '--code-stdin', '--dry-run']);
  assert.equal(state.requests, before);
  checks.push('dry-run does not read stdin, contact the fixture, or consume a code');
  state.mode = 'denied';
  const denied = await invoke(['auth', 'exchange', '--client-id', 'default', '--code-stdin'], { input: secrets[0], success: false });
  assert.equal(await readFile(join(isolated.config, 'profiles.json'), 'utf8'), saved);
  checks.push('HTTP 403 exchange failure preserves existing profiles; no credential output');
  assert.equal(denied.stderr.error.category, 'auth');
  assert.equal(denied.stderr.error.message, 'managed token exchange failed');
  const broken = '{invalid-test-json';
  await writeFile(join(isolated.config, 'profiles.json'), broken);
  const unknown = await invoke(['auth', 'status', '--readonly']);
  assert.equal(unknown.reason, 'local_state_unreadable');
  assert.equal(await readFile(join(isolated.config, 'profiles.json'), 'utf8'), broken);
  checks.push('corrupt local snapshot reports inconclusive reason; readonly check does not repair/delete it');
  const report = { classification: 'LOCAL_FIXTURE_ONLY', success: true, checks,
    observations: {
      enterpriseDenyError: denied,
      inconclusiveStatus: unknown,
      cliPermissionEndpointCalled: [...observedPaths].some(path => path.includes('cliAuthEnabled')),
      realOrganizationPermissionEvidence: false,
    } };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ success: true, checks: checks.length, classification: report.classification, output }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await isolated.dispose();
}
