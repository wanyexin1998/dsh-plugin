// Test-only official-binary harness. No production endpoint overrides are exposed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createManagedConnection } from '../lib/host/managed-connection.js';
import { createConnectionService } from '../lib/shared/service.js';
import { DEFAULT_LIMITS } from '../lib/shared/config.js';
import { sandbox, verifiedBinary, run } from './g0/runtime.mjs';
export async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
export async function fixture({ automatic = false, install = automatic } = {}) {
  const isolated = await sandbox();
  const binary = await verifiedBinary(resolve('../.cache/dingtalk-g0/bin-amd64/dws.exe'));
  const events = [], failures = [];
  const state = { user: 'test-user', exchangeFailure: false, businessFailure: false, cancel: false, identityCalls: 0, failIdentityAt: -1 };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('state', url.searchParams.get('state'));
        back.searchParams.set(state.cancel ? 'error' : 'authCode', state.cancel ? 'access_denied' : 'synthetic-code');
        if (!state.cancel) back.searchParams.set('code', 'synthetic-code');
        res.writeHead(302, { Location: back.href }); res.end(); return;
      }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      let value;
      if (url.pathname === '/cli/clientId') value = { success: true, result: 'synthetic-app' };
      else if (url.pathname === '/oauth2/revokeToken') value = { success: true };
      else if (url.pathname === '/oauth2/getToken' || url.pathname === '/oauth2/refreshToken') {
        events.push({ type: 'exchange' });
        if (state.exchangeFailure) { res.statusCode = 500; value = {}; }
        else value = { accessToken: `synthetic-${state.user}-access`, refreshToken: `synthetic-${state.user}-refresh`, expiresIn: 7200, corpId: 'test-corp' };
      } else if (body.method === 'initialize') value = { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test-only', version: '1' } } };
      else if (body.method === 'tools/call') {
        const user = req.headers['x-user-access-token']?.replace(/^synthetic-/, '').replace(/-access$/, '');
        const name = body.params.name;
        if (name === 'get_current_user_profile') state.identityCalls++;
        assert.ok(['get_current_user_profile', 'list_calendar_events', 'search_documents', 'create_personal_todo'].includes(name));
        events.push({ type: name === 'create_personal_todo' ? 'write' : 'read', user, name, ...(name === 'search_documents' ? { arguments: body.params.arguments } : {}) });
        const result = name === 'get_current_user_profile' ? [{ orgEmployeeModel: { corpId: 'test-corp', userId: user } }] : { items: [{ title: '合成查询结果' }] };
        if ((state.businessFailure && name !== 'get_current_user_profile') || state.identityCalls === state.failIdentityAt) { res.statusCode = 403; value = { synthetic: 'private-response-body' }; }
        else value = { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ result }) }], isError: false } };
      } else throw new Error('Unexpected fixture request');
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    } catch { failures.push(`fixture_protocol_error:${new URL(req.url, 'http://127.0.0.1').pathname}`); res.statusCode = 500; res.end('{}'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const callbackPort = await freePort();
  const settings = { stateDirectory: join(isolated.root, 'state'), ...(!automatic ? { oauth: { clientId: 'synthetic-app', scopes: 'openid', redirectUri: `http://127.0.0.1:${callbackPort}/dsh-dingtalk/callback`, expectedCorpId: 'test-corp', expectedUserId: 'test-user' } } : {}) };
  const config = join(settings.stateDirectory, 'dws');
  const env = { ...isolated.env, DWS_AUDIT: '0', DWS_CONFIG_DIR: config, DWS_ALLOW_HTTP_ENDPOINTS: '1', DWS_TRUSTED_DOMAINS: '127.0.0.1', DINGTALK_CONTACT_MCP_URL: `${base}/contact`, DINGTALK_CALENDAR_MCP_URL: `${base}/calendar`, DINGTALK_DOC_MCP_URL: `${base}/doc`, DINGTALK_TODO_MCP_URL: `${base}/todo` };
  const runtime = { environment: env,
    archive: async () => { events.push({ type: 'install' }); return readFile(resolve('../.cache/dingtalk-g0/downloads/dws-windows-amd64.zip')); },
    discoverClient: async () => { events.push({ type: 'discover' }); return (await (await fetch(`${base}/cli/clientId`)).json()).result; },
    spawn(file, args, options) {
    assert.equal(options.shell, false); assert.ok(!args.some(value => value.includes('synthetic-code')));
    if (args[0] === 'auth' && args[1] === 'exchange') assert.ok(args.includes('--code-stdin'));
    return spawn(file, args, { ...options, stdio: 'pipe' });
  } };
  const local = install ? {} : { binaryPath: binary };
  let managed = await createManagedConnection(local, settings, { ...DEFAULT_LIMITS, timeoutMs: 20000 }, runtime, `${base}/authorize`);
  await writeFile(join(config, 'mcp_url'), base);
  let owner = createConnectionService(managed.backend);
  const context = { origin: 'http://127.0.0.1:3000', returnPath: '/session/example#draft' };
  async function authorize(browser = 'test-browser') {
    const tx = await managed.ui(browser, context, () => owner.service.beginAuthorization({ sessionRef: 'example', callRef: 'call-1' }));
    const start = await fetch(tx.authorizeUrl, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const provider = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const callback = await fetch(provider.headers.get('location'), { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200);
    return managed.ui(browser, context, () => owner.service.getAuthorizationStatus(tx.transactionId));
  }
  async function defaultAccount() {
    state.user = 'other-user';
    try { assert.equal((await run(binary, ['auth', 'exchange', '--code-stdin', '--client-id=synthetic-app', '--format=json'], { env, cwd: isolated.root, input: 'synthetic-other-code' })).code, 0); }
    finally { state.user = 'test-user'; }
    return JSON.parse(await readFile(join(config, 'profiles.json'), 'utf8'));
  }
  async function allPlaintext() {
    const values = [];
    async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) await walk(file); else values.push((await readFile(file)).toString('utf8')); } }
    await walk(isolated.root); return values.join('\n');
  }
  return { get managed() { return managed; }, get service() { return owner.service; }, context, base, settings, config, env, binary, state, events, failures, isolated, authorize, defaultAccount, allPlaintext,
    async restart() { await owner.dispose(); managed = await createManagedConnection(local, settings, { ...DEFAULT_LIMITS, timeoutMs: 20000 }, runtime, `${base}/authorize`); owner = createConnectionService(managed.backend); },
    async dispose() { await owner.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); await isolated.dispose(); } };
}
