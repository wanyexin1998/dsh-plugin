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

const disposals = new WeakMap();
function browser(t) {
  disposals.set(t, []);
  const saved = Object.fromEntries(['window', 'sessionStorage', 'BroadcastChannel'].map(key => [key, globalThis[key]]));
  const cache = new Map(), events = new Map(); let popup, opens = 0;
  globalThis.window = { addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type, fn) { if (events.get(type) === fn) events.delete(type); }, location: { origin: 'dsh-app://app', pathname: '/', search: '', hash: '' }, open() { opens++; popup = { closed: false, close() { this.closed = true; }, location: {} }; return popup; } };
  globalThis.sessionStorage = { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) }; globalThis.BroadcastChannel = undefined;
  t.after(() => { for (const dispose of disposals.get(t)) dispose(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { cache, events, emit(type, event = {}) { events.get(type)?.(event); }, get opens() { return opens; }, get popup() { return popup; } };
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

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
const ok = value => ({ ok: true, value });
const failed = code => ({ ok: false, error: { code } });
const account = { organizationName: 'Example organization', displayName: 'Example account' };
const transaction = (origin = 'http://127.0.0.1:3333') => ({ transactionId: 'synthetic-transaction', authorizeUrl: origin + '/dsh-dingtalk/start', expiresAt: new Date(Date.now() + 120000).toISOString() });
function connection(handler, callbackOrigin = null) {
  return { rpc: { call(_channel, endpoint, payload, signal) {
    const method = endpoint.split('/').at(-1);
    if (method === 'bootstrap') return Promise.resolve(ok({ browserId: 'synthetic-browser', callbackOrigin }));
    return Promise.resolve(handler(method, payload, signal));
  } } };
}
function managed(t, handler, callbackOrigin) {
  const store = new ConnectionStore(connection(handler, callbackOrigin)); disposals.get(t).push(() => store.dispose()); return store;
}

test('initial checking is separate from actions; first read failure stays unknown and retries without OAuth', async t => {
  const b = browser(t), waiting = deferred(); let calls = 0;
  const store = managed(t, method => {
    assert.equal(method, 'status'); calls++;
    return calls === 1 ? waiting.promise : ok({ state: 'unlinked', reasonCode: 'not_connected' });
  });
  assert.deepEqual(store.get(), { status: { state: 'unknown' }, checked: false, refreshing: false, pending: false });
  const request = store.refresh();
  assert.equal(store.get().checked, false); assert.equal(store.get().refreshing, true); assert.equal(store.get().pending, false);
  await turn(); waiting.resolve(failed('service_unavailable')); await request;
  assert.equal(store.get().status.state, 'unknown'); assert.equal(store.get().checked, true);
  assert.equal(store.get().checkedAt, undefined); assert.equal(store.get().refreshError, 'service_unavailable'); assert.equal(store.get().error, undefined);
  await store.refresh(true);
  assert.equal(store.get().status.state, 'unlinked'); assert.equal(store.get().refreshError, undefined); assert.ok(store.get().checkedAt);
  assert.equal(b.opens, 0); assert.equal(calls, 2);
});

test('connected account and last confirmation survive background refresh failures and recover on fresh Host responses', async t => {
  const b = browser(t), waiting = deferred(); let calls = 0;
  const first = { state: 'connected', account, checkedAt: '2026-11-01T10:00:00.000Z' };
  const replacement = { state: 'connected', account: { ...account, displayName: 'New example account' }, checkedAt: '2026-11-01T10:01:00.000Z' };
  const store = managed(t, () => { calls++; return calls === 1 ? ok(first) : calls === 2 ? waiting.promise : ok(replacement); });
  const unsubscribe = store.subscribe(() => {}); await store.refresh();
  b.emit('focus'); const refresh = store.refresh(true);
  assert.equal(store.get().status, first); assert.equal(store.get().checkedAt, first.checkedAt); assert.equal(store.get().refreshing, true); assert.equal(store.get().pending, false);
  waiting.resolve(failed('service_unavailable')); await refresh;
  assert.equal(store.get().status, first); assert.equal(store.get().checkedAt, first.checkedAt); assert.equal(store.get().refreshError, 'service_unavailable'); assert.equal(store.get().refreshing, false);
  await store.refresh(); assert.equal(store.get().status, replacement); assert.equal(store.get().checkedAt, replacement.checkedAt); assert.equal(store.get().refreshError, undefined); unsubscribe();
});

test('15 second refresh and focus share the status request; unmount clears polling and reentry rechecks', async t => {
  const b = browser(t); let calls = 0;
  const store = managed(t, () => { calls++; return ok({ state: 'connected', account }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unsubscribe = store.subscribe(() => {}); await store.refresh(); assert.equal(calls, 1);
  t.mock.timers.tick(14999); await turn(); assert.equal(calls, 1);
  t.mock.timers.tick(1); b.emit('focus'); await store.refresh(); assert.equal(calls, 2);
  unsubscribe(); t.mock.timers.tick(30000); b.emit('focus'); await turn(); assert.equal(calls, 2);
  const again = store.subscribe(() => {}); await store.refresh(); assert.equal(calls, 3); again();
});

test('status timeouts settle even if transport ignores abort and never advance confirmation time', async t => {
  browser(t); const deadlines = []; let calls = 0;
  t.mock.method(AbortSignal, 'timeout', () => { const controller = new AbortController(); deadlines.push(controller); return controller.signal; });
  const store = managed(t, () => { calls++; return calls === 2 ? new Promise(() => {}) : ok({ state: 'connected', account, checkedAt: '2026-11-01T10:00:00.000Z' }); });
  await store.refresh(); const previous = store.get(); const refresh = store.refresh(); await turn();
  deadlines.at(-1).abort(new DOMException('synthetic timeout', 'TimeoutError')); await refresh;
  assert.equal(store.get().refreshError, 'execution_timeout'); assert.equal(store.get().status, previous.status); assert.equal(store.get().checkedAt, previous.checkedAt); assert.equal(store.get().pending, false);
  await store.refresh(); assert.equal(store.get().refreshError, undefined); assert.equal(calls, 3);
});

test('bootstrap timeout reports an initial read error and a retry obtains a fresh browser binding', async t => {
  browser(t); const deadlines = []; let bootstraps = 0;
  t.mock.method(AbortSignal, 'timeout', () => { const controller = new AbortController(); deadlines.push(controller); return controller.signal; });
  const store = new ConnectionStore({ rpc: { call(_channel, endpoint) {
    if (endpoint.endsWith('/bootstrap')) { bootstraps++; return bootstraps === 1 ? new Promise(() => {}) : Promise.resolve(ok({ browserId: 'replacement' })); }
    return Promise.resolve(ok({ state: 'unlinked' }));
  } } }); disposals.get(t).push(() => store.dispose());
  const request = store.refresh(); await turn(); deadlines.forEach(deadline => deadline.abort(new DOMException('synthetic timeout', 'TimeoutError'))); await request;
  assert.equal(store.get().checked, true); assert.equal(store.get().refreshError, 'execution_timeout'); assert.equal(store.get().checkedAt, undefined);
  await store.refresh(); assert.equal(bootstraps, 2); assert.equal(store.get().status.state, 'unlinked');
});

test('every confirmed disconnect, identity and policy response replaces historical connected state', async t => {
  browser(t); let value = { state: 'connected', account };
  const store = managed(t, () => ok(value));
  for (const [state, reasonCode] of [['unlinked', 'not_connected'], ['reauth_required', 'authorization_expired'], ['identity_mismatch', 'identity_mismatch'], ['org_cli_disabled', 'org_cli_disabled'], ['app_permission_denied', 'app_permission_denied'], ['unknown', 'revocation_failed']]) {
    value = { state: 'connected', account }; await store.refresh();
    value = { state, reasonCode }; await store.refresh();
    assert.equal(store.get().status, value); assert.equal(store.get().status.account, undefined); assert.equal(store.get().refreshError, undefined);
  }
});

for (const late of [ok({ state: 'connected', account }), failed('service_unavailable')]) {
  test(`late status ${late.ok ? 'success' : 'error'} cannot overwrite a newer begin or clear its pending preparation`, async t => {
    const b = browser(t), waiting = deferred(); let starts = 0;
    const store = managed(t, method => {
      if (method === 'status') return waiting.promise;
      if (method === 'prepare-start') { starts++; return ok({ state: 'running' }); }
      assert.fail('unexpected RPC ' + method);
    });
    const refresh = store.refresh(); await turn(); await Promise.all([store.begin(), store.begin()]);
    waiting.resolve(late); await refresh;
    assert.equal(store.get().preparing, true); assert.equal(store.get().pending, true); assert.equal(store.get().error, undefined); assert.equal(store.get().refreshError, undefined);
    assert.equal(store.get().status.state, 'unknown'); assert.equal(b.opens, 1); assert.equal(starts, 1);
  });

  test(`late status ${late.ok ? 'success' : 'error'} cannot revive connection after confirmed disconnect, including failed follow-up`, async t => {
    browser(t); const waiting = deferred(), mutation = deferred(); let reads = 0, disconnects = 0;
    const store = managed(t, (method, payload) => {
      if (method === 'status') { reads++; return reads === 1 ? ok({ state: 'connected', account }) : reads === 2 ? waiting.promise : failed('service_unavailable'); }
      if (method === 'disconnect-preview') return ok({ confirmation: 'synthetic-confirmation' });
      if (method === 'disconnect-confirm') { disconnects++; assert.equal(payload.confirmation, 'synthetic-confirmation'); return mutation.promise; }
      assert.fail('unexpected RPC ' + method);
    });
    await store.refresh(); const confirmation = await store.previewDisconnect(); const refresh = store.refresh(); await turn();
    const disconnect = store.disconnect(confirmation); await turn(); assert.equal(store.get().pending, true);
    await store.disconnect(confirmation); await store.begin(); await store.refresh(); assert.equal(disconnects, 1);
    mutation.resolve(ok({ disconnected: true })); await disconnect;
    waiting.resolve(late); await refresh;
    assert.equal(store.get().status.state, 'unlinked'); assert.equal(store.get().status.account, undefined); assert.equal(store.get().pending, false);
    assert.equal(store.get().refreshError, 'service_unavailable'); assert.equal(store.get().error, undefined); assert.equal(disconnects, 1);
  });

  test(`old mount's status ${late.ok ? 'success' : 'error'} cannot overwrite reentry or finish the newer refresh`, async t => {
    browser(t); const old = deferred(), fresh = deferred(); let calls = 0;
    const store = managed(t, () => { calls++; return calls === 1 ? old.promise : fresh.promise; });
    const leave = store.subscribe(() => {}); const oldRefresh = store.refresh(); await turn(); leave();
    const leaveAgain = store.subscribe(() => {}); const newRefresh = store.refresh(); await turn(); old.resolve(late); await oldRefresh;
    assert.equal(store.get().refreshing, true); assert.equal(store.get().checked, false); assert.equal(store.get().refreshError, undefined);
    fresh.resolve(ok({ state: 'identity_mismatch', reasonCode: 'identity_mismatch' })); await newRefresh;
    assert.equal(store.get().status.state, 'identity_mismatch'); assert.equal(store.get().refreshing, false); leaveAgain();
  });

  test(`transaction ${late.ok ? 'success' : 'error'} arriving after cancel cannot restore authorization or connected account`, async t => {
    browser(t); const waiting = deferred(), cancelling = deferred(); let cancels = 0;
    const store = managed(t, method => {
      if (method === 'prepare-start') return ok({ state: 'ready' });
      if (method === 'begin') return ok(transaction());
      if (method === 'callback-origin') return ok({ callbackOrigin: 'http://127.0.0.1:3333' });
      if (method === 'transaction') return waiting.promise;
      if (method === 'cancel') { cancels++; return cancelling.promise; }
      if (method === 'status') return ok({ state: 'unlinked', reasonCode: 'not_connected' });
      assert.fail('unexpected RPC ' + method);
    });
    await store.begin(); const poll = store.poll(); await turn();
    const cancel = store.cancel(); await turn(); await store.cancel(); assert.equal(cancels, 1);
    waiting.resolve(late); await poll; assert.equal(store.get().pending, true);
    cancelling.resolve(ok({ state: 'user_cancelled' })); await cancel;
    assert.equal(store.get().transaction, undefined); assert.equal(store.get().status.state, 'unlinked'); assert.equal(store.get().error, 'user_cancelled'); assert.equal(store.get().refreshError, undefined); assert.equal(store.get().pending, false);
  });
}

test('failed revocation removes historical connected account because Host blocks business calls', async t => {
  browser(t);
  const store = managed(t, method => method === 'status' ? ok({ state: 'connected', account }) : failed('revocation_failed'));
  await store.refresh(); await store.disconnect('synthetic-confirmation');
  assert.equal(store.get().status.state, 'unknown'); assert.equal(store.get().status.reasonCode, 'revocation_failed'); assert.equal(store.get().status.account, undefined);
  assert.equal(store.get().error, 'revocation_failed'); assert.equal(store.get().pending, false);
});

test('preview is deduplicated and late confirmation cannot target a newer authorization', async t => {
  browser(t); const waiting = deferred(); let previews = 0;
  const store = managed(t, method => {
    if (method === 'disconnect-preview') { previews++; return waiting.promise; }
    if (method === 'prepare-start') return ok({ state: 'running' });
    assert.fail('unexpected RPC ' + method);
  });
  const preview = store.previewDisconnect(), duplicate = store.previewDisconnect(); await turn(); assert.equal(previews, 1);
  await store.begin(); waiting.resolve(ok({ confirmation: 'outdated-confirmation' }));
  assert.equal(await preview, undefined); assert.equal(await duplicate, undefined); assert.equal(store.get().pending, true);
});

for (const origin of ['http://127.0.0.1:3333', 'https://connector.example.test']) {
  test(`${origin.startsWith('https:') ? 'Connector' : 'local'} callback requires exact Host origin, popup source and transaction, then rechecks Host`, async t => {
    const b = browser(t), waiting = deferred(); let polls = 0;
    const store = managed(t, method => {
      if (method === 'prepare-start') return ok({ state: 'ready' });
      if (method === 'begin') return ok(transaction(origin));
      if (method === 'callback-origin') return ok({ callbackOrigin: origin });
      if (method === 'transaction') { polls++; return waiting.promise; }
      assert.fail('unexpected RPC ' + method);
    }, origin);
    await store.begin(); assert.equal(b.popup.location.href, transaction(origin).authorizeUrl);
    const event = { origin, source: b.popup, data: { type: 'dsh-dingtalk:auth', transactionId: 'synthetic-transaction', state: 'connected' } };
    b.emit('message', { ...event, origin: origin + '.untrusted.test' });
    b.emit('message', { ...event, source: {} });
    b.emit('message', { ...event, data: { ...event.data, transactionId: 'other-transaction' } }); await turn(); assert.equal(polls, 0);
    b.emit('message', event); b.emit('message', event); const poll = store.poll(); await turn(); assert.equal(polls, 1);
    waiting.resolve(ok({ state: 'identity_mismatch', reasonCode: 'identity_mismatch' })); await poll;
    assert.equal(store.get().status.state, 'identity_mismatch'); assert.equal(store.get().transaction, undefined);
  });
}

test('authorization URL with a different origin is rejected and its known Host transaction is cancelled', async t => {
  const b = browser(t); let cancels = 0;
  const store = managed(t, (method, payload) => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction('https://untrusted.example.test'));
    if (method === 'callback-origin') return ok({ callbackOrigin: 'https://connector.example.test' });
    if (method === 'cancel') { cancels++; assert.equal(payload.transactionId, 'synthetic-transaction'); return ok({ state: 'user_cancelled' }); }
    assert.fail('unexpected RPC ' + method);
  }, 'https://connector.example.test');
  await store.begin(); assert.equal(store.get().transaction, undefined); assert.equal(store.get().error, 'service_unavailable'); assert.equal(b.popup.closed, true); assert.equal(b.popup.location.href, undefined); assert.equal(cancels, 1);
});

for (const origin of ['http://127.0.0.1:3333', 'https://connector.example.test']) {
  test(`${origin.startsWith('https:') ? 'Connector' : 'local'} cancel during callback-origin cancels preparation AND the known OAuth transaction`, async t => {
    const b = browser(t), waiting = deferred(), entered = deferred(), cancelling = deferred(); const calls = [];
    const store = managed(t, (method, payload) => {
      calls.push(method);
      if (method === 'prepare-start') return ok({ state: 'ready' });
      if (method === 'begin') return ok(transaction(origin));
      if (method === 'callback-origin') { entered.resolve(); return waiting.promise; }
      if (method === 'prepare-cancel') return ok({ state: 'cancelled' });
      if (method === 'cancel') { assert.equal(payload.transactionId, 'synthetic-transaction'); return cancelling.promise; }
      assert.fail('unexpected RPC ' + method);
    }, origin);
    const begin = store.begin(); await entered.promise; const cancel = store.cancel(); await turn(); await store.cancel();
    assert.equal(calls.filter(method => method === 'prepare-cancel').length, 1);
    assert.equal(calls.filter(method => method === 'cancel').length, 1);
    cancelling.resolve(ok({ state: 'user_cancelled' })); await cancel;
    waiting.resolve(ok({ callbackOrigin: origin })); await begin;
    assert.equal(store.get().transaction, undefined); assert.equal(store.get().error, 'user_cancelled'); assert.equal(store.get().pending, false); assert.equal(b.popup.closed, true); assert.equal(b.popup.location.href, undefined);
  });
}

test('callback-origin exceeding the overall authorization deadline settles pending preparation', async t => {
  browser(t); const entered = deferred(), deadlines = []; let cancels = 0;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { const controller = new AbortController(); deadlines.push({ milliseconds, controller }); return controller.signal; });
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction());
    if (method === 'callback-origin') { entered.resolve(); return new Promise(() => {}); }
    if (method === 'cancel') { cancels++; return ok({ state: 'user_cancelled' }); }
    assert.fail('unexpected RPC ' + method);
  });
  const begin = store.begin(); await entered.promise;
  deadlines.find(deadline => deadline.milliseconds === 30000).controller.abort(new DOMException('synthetic timeout', 'TimeoutError')); await begin;
  assert.equal(store.get().pending, false); assert.equal(store.get().preparing, false); assert.equal(store.get().error, 'execution_timeout'); assert.equal(store.get().transaction, undefined); assert.equal(cancels, 1);
});

test('terminal transaction follow-up and manual refresh share one Host status read', async t => {
  browser(t); const waiting = deferred(), entered = deferred(); let reads = 0;
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction());
    if (method === 'callback-origin') return ok({ callbackOrigin: 'http://127.0.0.1:3333' });
    if (method === 'transaction') return ok({ state: 'connected', account });
    if (method === 'status') { reads++; entered.resolve(); return waiting.promise; }
    assert.fail('unexpected RPC ' + method);
  });
  await store.begin(); const poll = store.poll(); await entered.promise;
  const refresh = store.refresh(true); assert.equal(store.get().transaction, undefined); assert.equal(reads, 1);
  waiting.resolve(ok({ state: 'unlinked', reasonCode: 'not_connected' })); await Promise.all([poll, refresh]);
  assert.equal(reads, 1); assert.equal(store.get().status.state, 'unlinked');
});

test('authorizing response crossing transaction expiry becomes auth_timeout without an orphan waiting state', async t => {
  browser(t); const waiting = deferred(); const tx = transaction();
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(tx);
    if (method === 'callback-origin') return ok({ callbackOrigin: 'http://127.0.0.1:3333' });
    if (method === 'transaction') return waiting.promise;
    assert.fail('unexpected RPC ' + method);
  });
  await store.begin(); const poll = store.poll(); await turn(); t.mock.method(Date, 'now', () => Date.parse(tx.expiresAt) + 1);
  waiting.resolve(ok({ state: 'authorizing', reasonCode: 'authorization_pending' })); await poll;
  assert.equal(store.get().status.state, 'auth_timeout'); assert.equal(store.get().transaction, undefined); assert.equal(store.get().refreshing, false);
});

test('restored transaction polls Host without opening another popup or trusting cached connected state', async t => {
  const b = browser(t); b.cache.set('dsh-dingtalk-ui-v1', JSON.stringify({ browserId: 'synthetic-browser', transaction: transaction() })); let polls = 0;
  const store = managed(t, method => {
    assert.equal(method, 'transaction'); polls++; return ok({ state: 'reauth_required', reasonCode: 'authorization_expired' });
  });
  assert.equal(store.get().status.state, 'authorizing'); await store.refresh();
  assert.equal(store.get().status.state, 'reauth_required'); assert.equal(store.get().transaction, undefined); assert.equal(polls, 1); assert.equal(b.opens, 0);
});

test('cross-tab invalidation discards in-flight reads and dispose removes listeners, timers and channel', async t => {
  const b = browser(t), waiting = deferred(); let channel, reads = 0;
  globalThis.BroadcastChannel = class { constructor() { channel = this; } close() { this.closed = true; } postMessage() {} };
  const store = managed(t, () => { reads++; return reads === 1 ? waiting.promise : ok({ state: 'unlinked', reasonCode: 'not_connected' }); });
  const unsubscribe = store.subscribe(() => {}); const old = store.refresh(); await turn(); channel.onmessage(); await store.refresh();
  assert.equal(store.get().status.state, 'unlinked'); waiting.resolve(ok({ state: 'connected', account })); await old; assert.equal(store.get().status.state, 'unlinked');
  unsubscribe(); const before = store.get(), cache = [...b.cache.entries()]; store.dispose(); b.emit('focus'); b.emit('message');
  assert.equal(b.events.size, 0); assert.equal(channel.closed, true); await store.refresh(); await store.begin();
  assert.equal(store.get(), before); assert.deepEqual([...b.cache.entries()], cache);
});

test('dispose aborts an active request and ignores its late success without persisting state', async t => {
  const b = browser(t), waiting = deferred(); let signal;
  const store = managed(t, (_method, _payload, callSignal) => { signal = callSignal; return waiting.promise; });
  const request = store.refresh(); await turn(); const before = store.get(), cache = [...b.cache.entries()]; store.dispose();
  assert.equal(signal.aborted, true); waiting.resolve(ok({ state: 'connected', account })); await request;
  assert.equal(store.get(), before); assert.deepEqual([...b.cache.entries()], cache); assert.equal(b.events.size, 0);
});

test('new authoritative identity and revocation states replace an earlier download failure', async t => {
  browser(t); let value;
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'failed', reasonCode: 'cli_download_failed' });
    if (method === 'status') return ok(value);
    assert.fail('unexpected RPC ' + method);
  });
  for (const status of [{ state: 'identity_mismatch', reasonCode: 'identity_mismatch' }, { state: 'unknown', reasonCode: 'revocation_failed' }, { state: 'org_cli_disabled', reasonCode: 'org_cli_disabled' }]) {
    await store.begin(); assert.equal(store.get().error, 'cli_download_failed');
    value = status; await store.refresh(); assert.equal(store.get().status, status); assert.equal(store.get().error, undefined);
  }
});

test('expired browser binding reboots status with the same bounded request signal', async t => {
  browser(t); let bootstraps = 0, reads = 0, firstSignal;
  const store = new ConnectionStore({ rpc: { async call(_channel, endpoint, payload, signal) {
    if (endpoint.endsWith('/bootstrap')) { bootstraps++; return ok({ browserId: 'synthetic-' + bootstraps }); }
    assert.ok(signal); reads++;
    if (reads === 1) { firstSignal = signal; assert.equal(payload.browserId, 'synthetic-1'); return failed('invalid_auth_state'); }
    assert.equal(signal, firstSignal); assert.equal(payload.browserId, 'synthetic-2'); return ok({ state: 'identity_mismatch', reasonCode: 'identity_mismatch' });
  } } }); disposals.get(t).push(() => store.dispose());
  await store.refresh(); assert.equal(bootstraps, 2); assert.equal(reads, 2); assert.equal(store.get().status.state, 'identity_mismatch'); assert.equal(store.get().refreshError, undefined);
});

test('local and Connector successful RPC envelopes containing read failures preserve confirmed account and time', async t => {
  browser(t); let status = { state: 'unknown', reasonCode: 'backend_not_ready' };
  const store = managed(t, () => ok(status));
  await store.refresh(); assert.equal(store.get().checked, true); assert.equal(store.get().checkedAt, undefined); assert.equal(store.get().refreshError, 'backend_not_ready');
  const connected = { state: 'connected', account, checkedAt: '2026-11-01T10:00:00.000Z' };
  for (const state of ['unknown', 'service_unavailable']) {
    for (const reasonCode of ['service_unavailable', 'backend_not_ready', 'execution_timeout', 'queue_timeout', 'connection_unknown']) {
      status = connected; await store.refresh();
      status = { state, reasonCode, checkedAt: '2026-11-01T10:30:00.000Z' }; await store.refresh();
      assert.equal(store.get().status, connected); assert.equal(store.get().checkedAt, connected.checkedAt); assert.equal(store.get().refreshError, state === 'service_unavailable' ? state : reasonCode);
    }
  }
  status = { state: 'identity_mismatch', reasonCode: 'identity_mismatch' }; await store.refresh();
  assert.equal(store.get().status, status); assert.equal(store.get().refreshError, undefined); assert.equal(store.get().status.account, undefined);
});

test('a Connector transaction read failure in a successful envelope preserves transaction for polling and cancel', async t => {
  browser(t); let value = { state: 'unknown', reasonCode: 'service_unavailable' };
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction('https://connector.example.test'));
    if (method === 'callback-origin') return ok({ callbackOrigin: 'https://connector.example.test' });
    if (method === 'transaction') return ok(value);
    assert.fail('unexpected RPC ' + method);
  }, 'https://connector.example.test');
  await store.begin(); const tx = store.get().transaction; await store.poll();
  assert.equal(store.get().transaction, tx); assert.equal(store.get().status.state, 'authorizing'); assert.equal(store.get().refreshError, 'service_unavailable'); assert.equal(store.get().checkedAt, undefined);
  value = { state: 'identity_mismatch', reasonCode: 'identity_mismatch' }; await store.poll();
  assert.equal(store.get().transaction, undefined); assert.equal(store.get().status, value); assert.equal(store.get().refreshError, undefined);
});

test('late callback for cancelled provisional authorization cannot affect a later begin', async t => {
  const b = browser(t), waiting = deferred(), entered = deferred(); let begins = 0;
  const store = managed(t, (method, payload) => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') { begins++; return ok({ ...transaction('https://connector.example.test'), transactionId: 'synthetic-' + begins }); }
    if (method === 'callback-origin') { if (begins === 1) { entered.resolve(); return waiting.promise; } return ok({ callbackOrigin: 'https://connector.example.test' }); }
    if (method === 'prepare-cancel') return ok({ state: 'cancelled' });
    if (method === 'cancel') { assert.equal(payload.transactionId, 'synthetic-1'); return ok({ state: 'user_cancelled' }); }
    assert.fail('unexpected RPC ' + method);
  }, 'https://connector.example.test');
  const first = store.begin(); await entered.promise; const firstPopup = b.popup; await store.cancel(); await store.begin();
  waiting.resolve(ok({ callbackOrigin: 'https://old-connector.example.test' })); await first;
  assert.equal(store.get().transaction.transactionId, 'synthetic-2'); assert.equal(b.popup.closed, false); assert.equal(firstPopup.closed, true); assert.equal(firstPopup.location.href, undefined);
  assert.equal(b.popup.location.href, 'https://connector.example.test/dsh-dingtalk/start'); assert.equal(store.get().error, undefined);
});

test('failed provisional cancellation remains retryable without exposing the unvalidated authorization URL', async t => {
  const b = browser(t), waiting = deferred(), entered = deferred(); let cancels = 0;
  const store = managed(t, method => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction('https://connector.example.test'));
    if (method === 'callback-origin') { entered.resolve(); return waiting.promise; }
    if (method === 'prepare-cancel') return ok({ state: 'cancelled' });
    if (method === 'cancel') { cancels++; return cancels === 1 ? failed('service_unavailable') : ok({ state: 'user_cancelled' }); }
    if (method === 'status') return ok({ state: 'unlinked' });
    assert.fail('unexpected RPC ' + method);
  }, 'https://connector.example.test');
  const begin = store.begin(); await entered.promise; await store.cancel(); await begin;
  assert.equal(store.get().transaction.transactionId, 'synthetic-transaction'); assert.equal(store.get().fallback, undefined); assert.equal(b.popup.location.href, undefined); assert.equal(store.get().error, 'service_unavailable');
  await store.cancel(); assert.equal(cancels, 2); assert.equal(store.get().transaction, undefined); assert.equal(store.get().status.state, 'unlinked');
});

test('stale rejected-URL cleanup cannot discard a transaction needed by a newer failed cancel', async t => {
  const b = browser(t), entered = deferred(), cancelling = deferred(); let cancels = 0;
  const store = managed(t, (method, payload) => {
    if (method === 'prepare-start') return ok({ state: 'ready' });
    if (method === 'begin') return ok(transaction('https://untrusted.example.test'));
    if (method === 'callback-origin') return ok({ callbackOrigin: 'https://connector.example.test' });
    if (method === 'prepare-cancel') return ok({ state: 'cancelled' });
    if (method === 'cancel') { cancels++; assert.equal(payload.transactionId, 'synthetic-transaction'); entered.resolve(); return cancelling.promise; }
    assert.fail('unexpected RPC ' + method);
  }, 'https://connector.example.test');
  const begin = store.begin(); await entered.promise; const cancel = store.cancel(); await turn();
  assert.equal(cancels, 1, 'automatic cleanup and user cancel share one mutation');
  cancelling.resolve(failed('service_unavailable')); await Promise.all([begin, cancel]);
  assert.equal(store.get().transaction.transactionId, 'synthetic-transaction'); assert.equal(store.get().fallback, undefined);
  assert.equal(store.get().error, 'service_unavailable'); assert.equal(store.get().pending, false); assert.equal(b.popup.closed, true); assert.equal(b.popup.location.href, undefined);
});
