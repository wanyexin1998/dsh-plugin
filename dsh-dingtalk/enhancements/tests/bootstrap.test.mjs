import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDws, extractWindowsBinary, officialClient } from '../lib/host/bootstrap.js';
import { sandbox } from '../scripts/g0/runtime.mjs';
import { fixture } from '../scripts/p0-fixture.mjs';
import { existsSync } from 'node:fs';
import { createManagedConnection } from '../lib/host/managed-connection.js';
import { createConnectionService } from '../lib/shared/service.js';
import { ConnectionServiceError } from '../lib/shared/models.js';
import { DEFAULT_LIMITS } from '../lib/shared/config.js';
const skip = process.platform !== 'win32' || process.arch !== 'x64' || !existsSync(resolve('../.cache/dingtalk-g0/downloads/dws-windows-amd64.zip')) || !existsSync(resolve('../.cache/dingtalk-g0/bin-amd64/dws.exe'));

test('public discovery requests the fixed JSON resource without redirects and rejects invalid responses', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://mcp.dingtalk.com/cli/clientId');
      assert.equal(init.headers.Accept, 'application/json'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      return Response.json({ success: true, result: 'public-app' });
    };
    assert.equal(await officialClient(new AbortController().signal), 'public-app');
    for (const value of [{ success: false, result: 'app' }, { success: true, result: '' }, { success: true, result: 'https://evil.invalid' }]) {
      globalThis.fetch = async () => Response.json(value);
      await assert.rejects(officialClient(new AbortController().signal), { reasonCode: 'service_unavailable' });
    }
    globalThis.fetch = async () => new Response('x'.repeat(8193));
    await assert.rejects(officialClient(new AbortController().signal), { reasonCode: 'service_unavailable' });
  } finally { globalThis.fetch = original; }
});

test('automatic installer verifies archive and executable, reuses verified bytes, rejects tampering and abort', { skip }, async () => {
  const isolated = await sandbox(), binary = join(isolated.root, 'bin/dws.exe');
  try {
    const zip = await readFile(resolve('../.cache/dingtalk-g0/downloads/dws-windows-amd64.zip'));
    let downloads = 0;
    const runtime = { archive: async () => { downloads++; return zip; } };
    await ensureDws(binary, new AbortController().signal, runtime);
    assert.ok((await lstat(binary)).size > 1000000);
    await ensureDws(binary, new AbortController().signal, runtime);
    assert.equal(downloads, 1);
    await writeFile(binary, 'tampered');
    await assert.rejects(ensureDws(binary, new AbortController().signal, runtime), { reasonCode: 'cli_integrity_failed' });
    assert.equal(downloads, 1);
    await assert.rejects(ensureDws(join(isolated.root, 'bad.exe'), new AbortController().signal, { archive: async () => zip.subarray(1) }), { reasonCode: 'cli_integrity_failed' });
    await assert.rejects(ensureDws(join(isolated.root, 'cancel.exe'), AbortSignal.abort(), runtime), { reasonCode: 'execution_cancelled' });
    for (const bytes of [Buffer.alloc(0), Buffer.from('invalid zip'), zip.subarray(0, zip.length - 5)]) assert.throws(() => extractWindowsBinary(bytes), { reasonCode: 'cli_integrity_failed' });
    await assert.rejects(officialClient(new AbortController().signal, { discoverClient: async () => 'https://evil.invalid' }), { reasonCode: 'service_unavailable' });
    await assert.rejects(officialClient(AbortSignal.abort(), { discoverClient: async () => 'app' }), { reasonCode: 'execution_cancelled' });
  } finally { await isolated.dispose(); }
});

test('no-config first connection binds online identity; restart checks it; disconnect permits explicit account change', { skip }, async () => {
  const f = await fixture({ automatic: true });
  try {
    assert.deepEqual(await f.service.status(), { state: 'unlinked', reasonCode: 'not_connected' });
    assert.equal(f.events.length, 0, 'status must not download or discover an app');
    assert.equal((await f.service.invoke({ operationId: 'identity.getSelf', args: {} })).status, 'auth_required');
    await assert.rejects(f.service.beginAuthorization({}), { reasonCode: 'invalid_request' });
    assert.equal(f.events.length, 0, 'model/service callers cannot initiate setup');
    assert.equal((await f.authorize()).state, 'connected');
    let record = JSON.parse(await readFile(join(f.settings.stateDirectory, 'binding.json'), 'utf8'));
    assert.equal(record.profile, 'test-corp:test-user');
    await f.restart();
    assert.equal((await f.service.status()).state, 'connected');
    f.state.user = 'wrong-user';
    assert.notEqual((await f.authorize()).state, 'connected');
    assert.equal((await f.service.status()).state, 'connected');
    await f.managed.ui('test-browser', f.context, () => f.service.disconnect());
    assert.equal((await f.authorize()).state, 'connected');
    record = JSON.parse(await readFile(join(f.settings.stateDirectory, 'binding.json'), 'utf8'));
    assert.equal(record.profile, 'test-corp:wrong-user');
    assert.equal(f.events.filter(e => e.type === 'install').length, 1);
    assert.deepEqual(f.failures, []);
  } finally { await f.dispose(); }
});

test('first-install cancellation and failure keep the service unlinked and allow a fresh retry', { skip }, async () => {
  const isolated = await sandbox();
  let entered, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const managed = await createManagedConnection({}, { stateDirectory: join(isolated.root, 'state') }, DEFAULT_LIMITS, {
    archive: signal => { calls++; if (calls > 1) return Promise.resolve(Buffer.from('damaged')); entered(); return new Promise((_, reject) => { const abort = () => reject(new ConnectionServiceError('execution_cancelled')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }); },
  });
  const owner = createConnectionService(managed.backend), abort = new AbortController();
  const context = { origin: 'http://127.0.0.1:3000', returnPath: '/chat' };
  try {
    const pending = managed.ui('browser', context, () => owner.service.beginAuthorization({}, { signal: abort.signal }));
    const rejected = assert.rejects(pending, { reasonCode: 'execution_cancelled' });
    await ready; assert.equal((await owner.service.status()).reasonCode, 'connection_preparing');
    abort.abort(); await rejected;
    assert.equal((await owner.service.status()).state, 'unlinked');
    await assert.rejects(managed.ui('browser', context, () => owner.service.beginAuthorization({})), { reasonCode: 'cli_integrity_failed' });
    assert.equal(calls, 2); assert.equal((await owner.service.status()).state, 'unlinked');
  } finally { await owner.dispose(); await isolated.dispose(); }
});
