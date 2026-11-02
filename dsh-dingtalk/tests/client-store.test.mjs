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
