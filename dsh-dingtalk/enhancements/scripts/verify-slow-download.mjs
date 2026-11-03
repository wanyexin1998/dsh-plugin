// Isolated acceptance: actual locked archive + production downloader/RPC/store, synthetic OAuth only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture } from './p0-fixture.mjs';
import { createUIRpc } from '../lib/host/ui-rpc.js';
import { ConnectionStore } from '../lib/client/store.js';

const archive = await readFile(resolve('../.cache/dingtalk-g0/downloads/dws-windows-amd64.zip'));
const lock = JSON.parse(await readFile(new URL('../dws.lock.json', import.meta.url), 'utf8'));
const url = lock.dws.assets.find(x => x.platform === 'windows-amd64').url;
const fetchOriginal = globalThis.fetch;
const requests = [];
const server = createServer((req, res) => {
  let offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
  requests.push(offset);
  res.writeHead(offset ? 206 : 200, { 'content-length': archive.length - offset, ...(offset ? { 'content-range': `bytes ${offset}-${archive.length - 1}/${archive.length}` } : {}) });
  const send = () => { const end = Math.min(archive.length, offset + 1048576); res.write(archive.subarray(offset, end)); offset = end; if (offset === archive.length) res.end(); };
  send();
  const timer = setInterval(send, 6000);
  res.on('close', () => clearInterval(timer));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
globalThis.fetch = (input, init) => fetchOriginal(input === url ? `http://127.0.0.1:${server.address().port}/component` : input, init);
const f = await fixture({ automatic: true, nativeDownload: true });
const peer = { id: 'synthetic-browser', principal: { kind: 'owner' } }, routes = new Map();
const cleanup = createUIRpc({ browserPeer: peer, admit: () => ({ peer }), fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, f.managed, f.service);
const cache = new Map();
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { origin: 'dsh-app://app', pathname: '/', search: '', hash: '' }, open() { return { location: {}, closed: false, close() { this.closed = true; } }; } };
globalThis.sessionStorage = { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value) };
globalThis.BroadcastChannel = undefined;
const connection = { rpc: { async call(_channel, endpoint, payload, signal) {
  const response = await routes.get(`/api/${endpoint}`).fetch(new Request(`http://127.0.0.1/api/${endpoint}`, { method: 'POST', signal, body: JSON.stringify({ type: 'client-request', rpcId: 'slow-download', method: endpoint, payload }) }));
  return (await response.json()).result;
} } };
let store = new ConnectionStore(connection);
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  await store.begin();
  for (let i = 0; i < 50 && !store.get().progress?.received; i++) { await sleep(100); await store.refresh(); }
  assert.ok(store.get().progress.received > 0);
  await store.cancel(); assert.equal(store.get().error, 'user_cancelled');
  const start = Date.now();
  await store.begin();
  // Reload the original page: Host download continues and the new store resumes polling.
  store.dispose(); store = new ConnectionStore(connection);
  let samples = 0, maximum = 0, checked100 = false;
  while (!store.get().transaction && Date.now() - start < 180000) {
    await sleep(1000); await store.refresh();
    assert.equal(store.get().error, undefined);
    maximum = Math.max(maximum, store.get().progress?.received || 0); samples++;
    if (Date.now() - start > 100000 && !checked100) { assert.equal(store.get().preparing, true); assert.equal(f.events.filter(x => x.type === 'exchange').length, 0); checked100 = true; console.log('PASS: still downloading beyond 100 seconds; OAuth has not started'); }
  }
  assert.ok(checked100); assert.ok(store.get().transaction); assert.ok(requests[1] > 0); assert.equal(requests.length, 2);
  const elapsedMs = Date.now() - start;
  const tx = store.get().transaction;
  const startAuth = await fetch(tx.authorizeUrl, { redirect: 'manual' });
  const cookie = startAuth.headers.get('set-cookie').split(';')[0];
  const provider = await fetch(startAuth.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(provider.headers.get('location'), { headers: { Cookie: cookie } });
  assert.equal(callback.status, 200);
  await store.poll(); assert.equal(store.get().status.state, 'connected');
  const before = requests.length;
  await store.begin();
  for (let i = 0; i < 10 && !store.get().transaction; i++) { await sleep(100); await store.refresh(); }
  assert.ok(store.get().transaction); assert.equal(requests.length, before);
  await store.cancel();
  await mkdir('artifacts', { recursive: true });
  const report = { result: 'pass', elapsedMs, samples, maximumReceived: maximum, total: archive.length, resumedOffset: requests[1], downloadRequests: requests.length, beyond100Seconds: checked100, reloadRecovered: true, syntheticAuthorization: 'connected', secondConnectionDownloaded: false };
  await writeFile('artifacts/slow-download-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  store.dispose(); await cleanup(); await f.dispose();
  globalThis.fetch = fetchOriginal; server.closeAllConnections(); await new Promise(r => server.close(r));
}
