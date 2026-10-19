#!/usr/bin/env node
/**
 * streaming.test.mjs — proves the parts of proxy.mjs that a live upstream probe cannot isolate:
 *
 *   1. SSE (`text/event-stream`) really arrives chunk-by-chunk, not buffered until the end.
 *   2. Port-busy fallback: a second bridge on the same port gets an OS-assigned port.
 *   3. The listener binds 127.0.0.1 only.
 *   4. `Set-Cookie` / `Location` rewriting, on a live response.
 *   5. gzip-encoded HTML is inflated, rewritten and re-encoded correctly.
 *   6. The seed script lands at the very start of <head>.
 *
 * Run: node streaming.test.mjs
 */

import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { createBridgeProxy, HEALTH_PATH, SEED_PARAM } from './proxy.mjs';

let failures = 0;
const ok = (name, extra = '') => console.log(`PASS  ${name}${extra ? `  ${extra}` : ''}`);
const bad = (name, err) => {
  failures++;
  console.log(`FAIL  ${name}: ${err?.message ?? err}`);
};
async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, typeof extra === 'string' ? extra : '');
  } catch (err) {
    bad(name, err);
  }
}

/**
 * Tiny node:http client. Deliberately NOT `fetch`: on this machine (Node 24.18, Windows) closing a
 * server that an undici keep-alive socket points at and then calling process.exit() aborts inside
 * libuv (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c line 94`) — reproduced
 * with a 12-line script that contains no bridge code at all: see node-exit-abort.repro.mjs.
 */
function request(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            getSetCookie: () => {
              const v = res.headers['set-cookie'];
              return v === undefined ? [] : Array.isArray(v) ? v : [v];
            },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

/* ---------------------------------------------------------------- fake upstream (plain http) */
const fakeUpstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fake');
  if (url.pathname === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.socket?.setNoDelay(true);
    let i = 0;
    /** @type {NodeJS.Timeout} */
    let timer;
    const send = () => {
      i++;
      res.write(`data: chunk-${i}\n\n`);
      if (i === 5) {
        clearInterval(timer);
        res.end();
      }
    };
    // First frame immediately, then one frame every 250ms -> the arrival timeline is the proof.
    send();
    timer = setInterval(send, 250);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (url.pathname === '/html') {
    const html = `<html><head><title>t</title><script src="https://cdn.example/x.js" integrity="sha384-abc" crossorigin="anonymous"></script></head><body>hi</body></html>`;
    if (req.headers['accept-encoding'] !== 'identity') {
      const gz = zlib.gzipSync(Buffer.from(html));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      res.end(gz);
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }
    return;
  }
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: `http://${req.headers.host}/after`, 'set-cookie': ['a=1; Path=/; Domain=fake; Secure; HttpOnly; SameSite=Lax', 'b=2; Path=/; Secure; Partitioned; Max-Age=60'] });
    res.end();
    return;
  }
  if (url.pathname === '/echo') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, contentType: req.headers['content-type'], host: req.headers.host, body: Buffer.concat(chunks).toString() }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});

await new Promise((r) => fakeUpstream.listen(0, '127.0.0.1', r));
const fakeOrigin = `http://127.0.0.1:${fakeUpstream.address().port}`;
console.log(`fake upstream: ${fakeOrigin}`);

const bridge = await createBridgeProxy({ port: 0, upstreamOrigin: fakeOrigin, quiet: true });
console.log(`bridge:        ${bridge.url}`);
console.log('');

/* ------------------------------------------------------------------ 1. binds 127.0.0.1 only */
await check('listener binds 127.0.0.1 only', () => {
  const addr = bridge.server.address();
  assert.equal(addr.address, '127.0.0.1');
  return `address=${addr.address} port=${addr.port}`;
});

/* ------------------------------------------------------------------ 2. SSE chunk-by-chunk */
await check('SSE streams chunk-by-chunk (no buffering)', async () => {
  const t0 = Date.now();
  const arrivals = await new Promise((resolve, reject) => {
    const seen = [];
    const r = http.request({ host: '127.0.0.1', port: bridge.port, path: '/sse', headers: { accept: 'text/event-stream' } }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.on('data', (c) => seen.push({ at: Date.now() - t0, text: c.toString() }));
      res.on('end', () => resolve(seen));
    });
    r.on('error', reject);
    r.end();
  });
  const first = arrivals[0]?.at ?? -1;
  const last = arrivals.at(-1)?.at ?? -1;
  assert.equal(arrivals.length, 5, `expected 5 chunks, saw ${arrivals.length}`);
  assert.ok(first < 150, `first chunk arrived after ${first}ms -> buffered`);
  assert.ok(last - first > 800, `last-first=${last - first}ms, expected ~1000ms of real streaming`);
  return `first chunk @${first}ms, last @${last}ms, ${arrivals.length} chunks, spread ${last - first}ms`;
});

/* ------------------------------------------------------------------ 3. cookie + redirect rewrite */
await check('Set-Cookie rewritten (Domain/Secure/Partitioned removed)', async () => {
  const res = await request(`${bridge.url}/redirect`);
  const cookies = res.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const c of cookies) {
    assert.ok(!/domain=/i.test(c), `Domain survived: ${c}`);
    assert.ok(!/;\s*secure/i.test(c), `Secure survived: ${c}`);
    assert.ok(!/partitioned/i.test(c), `Partitioned survived: ${c}`);
  }
  assert.equal(cookies[0], 'a=1; Path=/; HttpOnly; SameSite=Lax');
  assert.equal(cookies[1], 'b=2; Path=/; Max-Age=60');
  return cookies.join(' | ');
});

await check('Location rewritten to the local origin', async () => {
  const res = await request(`${bridge.url}/redirect`);
  const loc = res.headers.location;
  assert.equal(loc, `${bridge.url}/after`);
  return loc;
});

/* ------------------------------------------------------------------ 4. gzip HTML rewrite + seed */
await check('gzip HTML inflated, integrity/crossorigin stripped, re-encoded', async () => {
  const res = await request(`${bridge.url}/html`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!/integrity\s*=/i.test(body), `integrity survived: ${body}`);
  assert.ok(!/crossorigin/i.test(body), `crossorigin survived: ${body}`);
  assert.ok(body.includes('cdn.example/x.js'), 'script src was mangled');
  return `${body.length} bytes, script tag => ${body.match(/<script[^>]*>/)?.[0]}`;
});

await check('seed script injected at the very start of <head>', async () => {
  const seed = Buffer.from(JSON.stringify({ k: 'v' }), 'utf8').toString('base64url');
  const body = await (
    await request(`${bridge.url}/html?${SEED_PARAM}=${seed}`, { headers: { accept: 'text/html' } })
  ).text();
  const headEnd = body.indexOf('<head>') + '<head>'.length;
  assert.ok(body.startsWith('<html><head><script>', 0), `head start: ${body.slice(0, 60)}`);
  assert.ok(body.slice(headEnd).startsWith('<script>'), 'seed script is not the first child of <head>');
  assert.ok(body.includes(SEED_PARAM), 'seed script does not read the seed param');
  assert.ok(!/location\.(href|assign|replace)/.test(body.slice(0, 600)), 'injected script navigates!');
  return body.slice(headEnd, headEnd + 60) + '...';
});

/* ------------------------------------------------------------------ 5. POST body + host header */
await check('POST body and content-type forwarded, Host = upstream host', async () => {
  const payload = JSON.stringify({ a: 1, b: 'x' });
  const res = await request(`${bridge.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  const json = await res.json();
  assert.equal(json.method, 'POST');
  assert.equal(json.contentType, 'application/json');
  assert.equal(json.body, payload);
  assert.equal(json.host, `127.0.0.1:${fakeUpstream.address().port}`, `Host leaked as ${json.host}`);
  return JSON.stringify(json);
});

/* ------------------------------------------------------------------ 6. health endpoint */
await check('/__bridge/health is not forwarded upstream', async () => {
  const json = await (await request(`${bridge.url}${HEALTH_PATH}`)).json();
  assert.equal(json.ok, true);
  assert.equal(json.upstream, fakeOrigin);
  assert.equal(json.port, bridge.port);
  return JSON.stringify({ ok: json.ok, upstream: json.upstream, port: json.port });
});

/* ------------------------------------------------------------------ 7. port-busy fallback */
await check('port-busy fallback assigns an ephemeral port', async () => {
  const second = await createBridgeProxy({ port: bridge.port, upstreamOrigin: fakeOrigin, quiet: true });
  const addr = second.server.address();
  assert.notEqual(second.port, bridge.port, 'second bridge reused a busy port');
  assert.ok(addr.port > 0);
  const health = await second.health();
  assert.equal(health.port, second.port);
  await second.close();
  return `busy ${bridge.port} -> fallback ${second.port}`;
});

await bridge.close();
await new Promise((r) => fakeUpstream.close(r));

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
