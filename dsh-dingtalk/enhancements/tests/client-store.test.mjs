import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromptRegistry } from '../lib/client/prompts.js';
import { ConnectionStore } from '../lib/client/store.js';

test('one authorization prompt owner per conversation survives retries and transfers only on unmount', () => {
  let revision = 0;
  const prompts = new PromptRegistry(() => revision);
  const first = prompts.register('session-a', 'call-1', 'not_connected');
  const second = prompts.register('session-a', 'call-2', 'authorization_expired');
  const other = prompts.register('session-b', 'call-3', 'not_connected');
  assert.deepEqual(prompts.get('session-a'), { owner: 'call-1', reason: 'authorization_expired' });
  assert.equal(prompts.get('session-b').owner, 'call-3');
  revision++;
  assert.equal(prompts.get('session-a').reason, undefined, 'old Tool reasons are cleared by a new user action');
  first(); assert.equal(prompts.get('session-a').owner, 'call-2');
  second(); other(); assert.equal(prompts.get('session-a').owner, undefined); prompts.dispose();
});

test('simultaneous status refreshes share one RPC instead of filling the DWS queue', async () => {
  const saved = Object.fromEntries(['window', 'sessionStorage', 'BroadcastChannel'].map(key => [key, globalThis[key]]));
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { origin: 'http://127.0.0.1:3000', pathname: '/', search: '', hash: '' } };
  globalThis.sessionStorage = { getItem() { return null; }, setItem() {} }; globalThis.BroadcastChannel = undefined;
  let calls = 0, entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const store = new ConnectionStore({ rpc: { async call(_channel, endpoint) {
    if (endpoint.endsWith('/bootstrap')) return { ok: true, value: { browserId: 'synthetic-browser', callbackOrigin: null } };
    calls++; entered(); await waiting; return { ok: true, value: { state: 'connected' } };
  } } });
  try {
    const refreshes = Array.from({ length: 10 }, () => store.refresh());
    await ready; assert.equal(calls, 1); release(); await Promise.all(refreshes);
    assert.equal(calls, 1); assert.equal(store.get().status.state, 'connected');
  } finally { release(); store.dispose(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

function browser(t) {
  const saved = Object.fromEntries(['window', 'sessionStorage', 'BroadcastChannel'].map(key => [key, globalThis[key]]));
  const cache = new Map(); let popup;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { origin: 'dsh-app://app', pathname: '/', search: '', hash: '' }, open() { popup = { closed: false, close() { this.closed = true; }, location: {} }; return popup; } };
  globalThis.sessionStorage = { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) }; globalThis.BroadcastChannel = undefined;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { cache, get popup() { return popup; } };
}

test('preparation uses short RPCs, recovers after reload and authorizes only after ready with fallback link', async t => {
  const b = browser(t); const calls = [];
  let state = { state: 'running', progress: { phase: 'download', received: 1024, total: 4096 } };
  const connection = { rpc: { async call(_channel, endpoint) {
    const method = endpoint.split('/').at(-1); calls.push(method);
    if (method === 'bootstrap') return { ok: true, value: { browserId: 'test-browser' } };
    if (method.startsWith('prepare-')) return { ok: true, value: state };
    assert.equal(method, 'begin'); assert.equal(state.state, 'ready');
    return { ok: true, value: { transactionId: 'x'.repeat(32), authorizeUrl: 'http://127.0.0.1:3333/dsh-dingtalk/start', expiresAt: new Date(Date.now() + 120000).toISOString() } };
  } } };
  const first = new ConnectionStore(connection);
  await first.begin(); assert.equal(first.get().progress.received, 1024); assert.ok(!calls.includes('begin'));
  // Simulate more than both former 60s/100s limits without leaving one pending begin RPC.
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 150000);
  await first.refresh(); assert.equal(first.get().preparing, true);
  first.dispose();
  const reloaded = new ConnectionStore(connection);
  try {
    await reloaded.refresh(); assert.equal(reloaded.get().progress.received, 1024);
    state = { state: 'ready' }; await reloaded.refresh();
    assert.equal(calls.filter(x => x === 'begin').length, 1);
    assert.equal(reloaded.get().preparing, false); assert.ok(reloaded.get().fallback);
    assert.equal(JSON.parse([...b.cache.values()][0]).preparing, false);
  } finally { reloaded.dispose(); }
});

test('cancelling while prepare-start is in flight cancels the Host task after start, never opens OAuth', async t => {
  browser(t); let release; const started = new Promise(r => { release = r; }); const calls = [];
  const store = new ConnectionStore({ rpc: { async call(_channel, endpoint) {
    const method = endpoint.split('/').at(-1); calls.push(method);
    if (method === 'bootstrap') return { ok: true, value: { browserId: 'test-browser' } };
    if (method === 'prepare-start') { await started; return { ok: true, value: { state: 'running' } }; }
    if (method === 'prepare-cancel') return { ok: true, value: { state: 'cancelled' } };
    assert.fail('unexpected RPC ' + method);
  } } });
  try {
    const begin = store.begin();
    await new Promise(r => setTimeout(r, 0));
    await store.refresh(); // Opening the popup can trigger focus while the start RPC is still in flight.
    const cancel = store.cancel(); release(); await Promise.all([begin, cancel]);
    assert.equal(store.get().preparing, false); assert.equal(store.get().error, 'user_cancelled');
    assert.deepEqual(calls, ['bootstrap', 'prepare-start', 'prepare-cancel']);
  } finally { release(); store.dispose(); }
});

test('download failure surfaces its reason and explicit retry starts preparation again', async t => {
  browser(t); let starts = 0;
  const store = new ConnectionStore({ rpc: { async call(_channel, endpoint) {
    const method = endpoint.split('/').at(-1);
    if (method === 'bootstrap') return { ok: true, value: { browserId: 'test-browser' } };
    if (method === 'prepare-start') { starts++; return { ok: true, value: { state: 'running' } }; }
    if (method === 'prepare-status') return { ok: true, value: { state: 'failed', reasonCode: 'cli_download_timeout' } };
    if (method === 'status') return { ok: true, value: { state: 'unlinked' } };
    assert.fail('OAuth must not start after a failed download');
  } } });
  try {
    await store.begin(); await store.refresh();
    assert.equal(store.get().error, 'cli_download_timeout'); assert.equal(store.get().pending, false);
    await store.refresh(); assert.equal(store.get().error, 'cli_download_timeout', 'automatic refresh must not hide a failed download');
    await store.begin(); assert.equal(starts, 2); assert.equal(store.get().error, undefined);
  } finally { store.dispose(); }
});
