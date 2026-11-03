import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadLockedAsset, DOWNLOAD_IDLE_MS, DOWNLOAD_TOTAL_MS } from '../lib/host/download.js';

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'dt-download-'));
  const bytes = Buffer.alloc(4096, 42);
  const server = createServer((req, res) => handler(req, res, bytes));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { bytes, file: join(dir, 'component.download'), asset: { url: `http://127.0.0.1:${server.address().port}/locked`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
const signal = () => new AbortController().signal;

test('cancel retains partial bytes; retry validates Range and resumes; verified cache avoids the network', async t => {
  let requests = 0, range;
  const f = await fixture(t, (req, res, bytes) => {
    requests++; range = req.headers.range;
    if (!range) { res.writeHead(200, { 'content-length': bytes.length }); res.write(bytes.subarray(0, 1024)); }
    else { res.writeHead(206, { 'content-range': `bytes 1024-4095/4096`, 'content-length': 3072 }); res.end(bytes.subarray(1024)); }
  });
  const abort = new AbortController();
  await assert.rejects(downloadLockedAsset(f.asset, f.file, abort.signal, n => { if (n === 1024) abort.abort(); }), { reasonCode: 'execution_cancelled' });
  assert.equal((await readFile(f.file)).length, 1024);
  const updates = [];
  assert.deepEqual(await downloadLockedAsset(f.asset, f.file, signal(), (n, total) => updates.push([n, total])), f.bytes);
  assert.equal(range, 'bytes=1024-'); assert.deepEqual(updates.at(-1), [4096, 4096]);
  assert.deepEqual(await downloadLockedAsset(f.asset, f.file, signal()), f.bytes);
  assert.equal(requests, 2);
});

test('server ignoring Range replaces partial data instead of appending it', async t => {
  const f = await fixture(t, (req, res, bytes) => { assert.equal(req.headers.range, 'bytes=1024-'); res.end(bytes); });
  await writeFile(f.file, f.bytes.subarray(0, 1024));
  assert.deepEqual(await downloadLockedAsset(f.asset, f.file, signal()), f.bytes);
  assert.equal((await readFile(f.file)).length, 4096);
});

test('invalid Content-Range cannot corrupt the saved prefix; digest mismatch discards poisoned cache', async t => {
  let corrupt = false;
  const f = await fixture(t, (_req, res, bytes) => {
    if (corrupt) res.end(Buffer.alloc(bytes.length, 7));
    else { res.writeHead(206, { 'content-range': 'bytes 0-4095/4096' }); res.end(bytes); }
  });
  await writeFile(f.file, f.bytes.subarray(0, 1024));
  await assert.rejects(downloadLockedAsset(f.asset, f.file, signal()), { reasonCode: 'cli_download_failed' });
  assert.equal((await readFile(f.file)).length, 1024);
  corrupt = true;
  await assert.rejects(downloadLockedAsset(f.asset, f.file, signal()), { reasonCode: 'cli_integrity_failed' });
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
});

test('active transfer outlives the idle window; stalled and total deadlines have explicit errors', async t => {
  assert.equal(DOWNLOAD_IDLE_MS, 90000); assert.equal(DOWNLOAD_TOTAL_MS, 1800000);
  let mode = 'active';
  const f = await fixture(t, (_req, res, bytes) => {
    res.writeHead(200, { 'content-length': bytes.length }); res.flushHeaders();
    if (mode === 'stall') return;
    let n = 0;
    const timer = setInterval(() => { res.write(bytes.subarray(n, n += 512)); if (n === bytes.length) { clearInterval(timer); res.end(); } }, 25);
    res.on('close', () => clearInterval(timer));
  });
  await downloadLockedAsset(f.asset, f.file, signal(), undefined, { idleMs: 150, totalMs: 1500 });
  mode = 'stall';
  await assert.rejects(downloadLockedAsset(f.asset, f.file + '-stall', signal(), undefined, { idleMs: 40, totalMs: 1000 }), { reasonCode: 'cli_download_timeout' });
  mode = 'active';
  await assert.rejects(downloadLockedAsset(f.asset, f.file + '-total', signal(), undefined, { idleMs: 150, totalMs: 80 }), { reasonCode: 'cli_download_timeout' });
});

test('truncated response and HTTP failure remain resumable without being classified as authorization errors', async t => {
  let mode = 'truncated';
  const f = await fixture(t, (_req, res, bytes) => { if (mode === 'http') { res.writeHead(503); res.end(); } else { res.writeHead(200, { 'content-length': bytes.length }); res.write(bytes.subarray(0, 512)); setTimeout(() => res.destroy(), 50); } });
  await assert.rejects(downloadLockedAsset(f.asset, f.file, signal()), { reasonCode: 'cli_download_failed' });
  assert.equal((await readFile(f.file)).length, 512);
  mode = 'http';
  await assert.rejects(downloadLockedAsset(f.asset, f.file, signal()), { reasonCode: 'cli_download_failed' });
  assert.equal((await readFile(f.file)).length, 512);
  await assert.rejects(downloadLockedAsset(f.asset, f.file, AbortSignal.abort()), { reasonCode: 'execution_cancelled' });
});
