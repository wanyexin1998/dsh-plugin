#!/usr/bin/env node
/**
 * probe.mjs — black-box evidence collector for the loopback bridge.
 *
 * Usage:
 *   node probe.mjs --port 3377
 *   node probe.mjs --url http://127.0.0.1:3377
 *
 * Prints raw observed outputs for evidence items 1-5 of the task, plus:
 *   - upstream Set-Cookie NAMES on a plain `GET /` (names only, never values),
 *   - `<base>` tag + absolute upstream self-references in the served HTML,
 *   - unit-level checks of the header/cookie/Location rewrite rules,
 *   - POST body forwarding,
 *   - seed-injection sanity check.
 */

import http from 'node:http';
import https from 'node:https';
import {
  buildUpstreamHeaders,
  rewriteSetCookie,
  rewriteLocation,
  SEED_PARAM,
} from './proxy.mjs';

const UPSTREAM_ORIGIN = 'https://chat.deepseek.com';

const argv = process.argv.slice(2);
let baseUrl = 'http://127.0.0.1:3377';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') baseUrl = `http://127.0.0.1:${argv[++i]}`;
  else if (argv[i] === '--url') baseUrl = argv[++i];
}
const PORT = new URL(baseUrl).port;

/** Raw HTTP request returning the untouched header list, timings and body. */
function req(urlStr, { method = 'GET', headers = {}, body = null, agent = null } = {}) {
  const u = new URL(urlStr);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const r = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent,
      },
      (res) => {
        const ttfb = process.hrtime.bigint();
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const t1 = process.hrtime.bigint();
          resolve({
            status: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: { ttfb: Number(ttfb - t0) / 1e6, total: Number(t1 - t0) / 1e6 },
            reusedSocket: r.reusedSocket === true,
          });
        });
      },
    );
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const have = (res, name) => Object.keys(res.headers).includes(name.toLowerCase());
const line = (s = '') => console.log(s);
const rule = (t) => line(`\n### ${t}\n`);
const cut = (s, n) => s.slice(0, n);

/* ------------------------------------------------------------------------------------------------ */
line('# PROXY EVIDENCE — raw probe output');
line(`generated: ${new Date().toISOString()}`);
line(`bridge: ${baseUrl}`);
line(`node: ${process.version}   platform: ${process.platform}`);

/* ---- item 1: health -------------------------------------------------------------------------- */
rule('1. GET /__bridge/health  (must not be forwarded upstream)');
const health = await req(`${baseUrl}/__bridge/health`);
line(`HTTP ${health.status} ${health.statusMessage}`);
line(`content-type: ${health.headers['content-type']}`);
line('body:');
line(health.body);

/* ---- item 2: the HTML shell ------------------------------------------------------------------ */
rule('2. GET /  (as a browser navigation: Accept: text/html)');
const home = await req(`${baseUrl}/`, { headers: { accept: 'text/html,application/xhtml+xml' } });
line(`HTTP ${home.status} ${home.statusMessage}`);
line(`content-type: ${home.headers['content-type']}`);
line(`content-length: ${home.headers['content-length'] ?? '(none)'}`);
line(`cache-control: ${home.headers['cache-control'] ?? '(none)'}`);
line(`x-bridge-stripped: ${home.headers['x-bridge-stripped'] ?? '(none)'}`);
line(`x-bridge-warning: ${home.headers['x-bridge-warning'] ?? '(none)'}`);
line('');
line('header breakage check (must all be ABSENT from the proxied response):');
for (const h of [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
]) {
  line(`  ${have(home, h) ? 'PRESENT ❌' : 'absent  ✅'}  ${h}`);
}
line('');
line(`integrity= present anywhere in served HTML? ${/integrity\s*=/i.test(home.body)}`);
line(`crossorigin present anywhere in served HTML? ${/crossorigin/i.test(home.body)}`);
line(`integrity= present in RAW upstream HTML?    ${/integrity\s*=/i.test(home.body.replace(/^.*?<head[^>]*>/is, '')) ? '(see upstream comparison below)' : ''}`);
line('');
line(`first 400 characters of the served HTML:\n${cut(home.body, 400)}`);
line('');

// upstream comparison (raw, no proxy)
const upstreamHome = await req(`${UPSTREAM_ORIGIN}/`, { headers: { accept: 'text/html' } });
line('--- comparison: direct https://chat.deepseek.com/ (no proxy) ---');
line(`HTTP ${upstreamHome.status} ${upstreamHome.statusMessage}  bytes=${upstreamHome.body.length}`);
line(`raw Set-Cookie headers: ${JSON.stringify(upstreamHome.headers['set-cookie'] ?? null)}`);
line('breakage headers present directly upstream:');
for (const h of [
  'content-security-policy',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
]) {
  line(`  ${have(upstreamHome, h) ? 'PRESENT' : 'absent '}  ${h}${have(upstreamHome, h) ? ` = ${String(upstreamHome.headers[h]).slice(0, 120)}` : ''}`);
}
const countIntegrity = (s) => (s.match(/\sintegrity\s*=/gi) ?? []).length;
const countCrossorigin = (s) => (s.match(/\scrossorigin(\s|=|>)/gi) ?? []).length;
line(`upstream HTML: integrity= x${countIntegrity(upstreamHome.body)}, crossorigin x${countCrossorigin(upstreamHome.body)}`);
line(`served   HTML: integrity= x${countIntegrity(home.body)}, crossorigin x${countCrossorigin(home.body)}`);
line(`upstream HTML bytes=${upstreamHome.body.length}  served HTML bytes=${Buffer.byteLength(home.body)}`);

/* ---- item 3: a real API path ----------------------------------------------------------------- */
rule('3. GET /api/v0/users/current  (real API path through the proxy)');
const api = await req(`${baseUrl}/api/v0/users/current`, {
  headers: { accept: 'application/json', 'content-type': 'application/json' },
});
line(`HTTP ${api.status} ${api.statusMessage}`);
line(`content-type: ${api.headers['content-type'] ?? '(none)'}`);
line(`content-length: ${api.headers['content-length'] ?? '(none)'}  transfer-encoding: ${api.headers['transfer-encoding'] ?? '(none)'}`);
line(`body (first 200 chars):\n${cut(api.body, 200)}`);

/* ---- item 4: connection reuse timing --------------------------------------------------------- */
rule('4. Timing: first vs second request to the SAME path (keep-alive client agent)');
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 4 });
const t1 = await req(`${baseUrl}/api/v0/users/current`, { agent: keepAlive });
const t2 = await req(`${baseUrl}/api/v0/users/current`, { agent: keepAlive });
const t3 = await req(`${baseUrl}/api/v0/users/current`, { agent: keepAlive });
line(`request #1: total ${t1.ms.total.toFixed(1)} ms (ttfb ${t1.ms.ttfb.toFixed(1)} ms) reusedSocket=${t1.reusedSocket}`);
line(`request #2: total ${t2.ms.total.toFixed(1)} ms (ttfb ${t2.ms.ttfb.toFixed(1)} ms) reusedSocket=${t2.reusedSocket}`);
line(`request #3: total ${t3.ms.total.toFixed(1)} ms (ttfb ${t3.ms.ttfb.toFixed(1)} ms) reusedSocket=${t3.reusedSocket}`);
line(`speedup #1 -> #2: ${(t1.ms.total / t2.ms.total).toFixed(2)}x`);
const health2 = await req(`${baseUrl}/__bridge/health`);
line(`upstream pooled sockets after 3 requests (health.sockets): ${JSON.parse(health2.body).sockets}`);
keepAlive.destroy();

/* ---- item 5: cross-origin asset hostnames ---------------------------------------------------- */
rule('5. External hostnames referenced by the served page HTML');
const hosts = new Map();
const add = (h) => {
  const key = h.toLowerCase();
  hosts.set(key, (hosts.get(key) ?? 0) + 1);
};
for (const m of home.body.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"'/]+)/gi)) add(new URL(m[1]).host);
for (const m of home.body.matchAll(/["'(](https?:\/\/[^"')\s/]+)/gi)) add(new URL(m[1]).host);
const localHost = new URL(baseUrl).host;
line(`local origin = ${localHost}`);
const otherOrigins = [...hosts.entries()].filter(([h]) => h !== localHost).sort((a, b) => b[1] - a[1]);
line(`distinct hosts referenced: ${hosts.size}`);
for (const [h, n] of otherOrigins) line(`  ${h}  x${n}${h.includes('deepseek') ? '' : ''}`);
line(`referenced on the local origin itself: ${hosts.get(localHost) ?? 0} occurrence(s)`);

/* ---- extra: cookie names --------------------------------------------------------------------- */
rule('EXTRA A. Cookies set by upstream on a plain GET /  (NAMES ONLY)');
const cookieProbe = await req(`${UPSTREAM_ORIGIN}/`, { headers: { accept: 'text/html' } });
const rawCookies = cookieProbe.headers['set-cookie'] ?? [];
line(`direct upstream Set-Cookie count: ${rawCookies.length}`);
for (const c of rawCookies) {
  const [pair, ...attrs] = c.split(';');
  line(`  name=${pair.split('=')[0]}  attributes=${attrs.map((a) => a.trim().split('=')[0]).join(', ')}`);
}
line(`direct upstream set-cookie present on GET / ? ${rawCookies.length > 0 ? 'YES' : 'NO'}`);
const proxiedHome2 = await req(`${baseUrl}/`, { headers: { accept: 'text/html' } });
const proxiedCookies = proxiedHome2.headers['set-cookie'] ?? [];
line(`proxied Set-Cookie count: ${proxiedCookies.length}`);
for (const c of proxiedCookies) {
  const [pair, ...attrs] = c.split(';');
  line(`  name=${pair.split('=')[0]}  attributes=${attrs.map((a) => a.trim().split('=')[0]).join(', ')}`);
}

/* ---- extra: base tag / absolute self references ---------------------------------------------- */
rule('EXTRA B. <base> tag and absolute upstream self-references in the served HTML');
const baseTagsServed = home.body.match(/<base\b[^>]*>/gi) ?? [];
const baseTagsUpstream = upstreamHome.body.match(/<base\b[^>]*>/gi) ?? [];
line(`served HTML   <base> tags: ${baseTagsServed.length} ${JSON.stringify(baseTagsServed)}`);
line(`upstream HTML <base> tags: ${baseTagsUpstream.length} ${JSON.stringify(baseTagsUpstream)}`);
const selfRefs = (s) => [...s.matchAll(/https?:\/\/chat\.deepseek\.com[^"'\s)>]*/gi)].map((m) => m[0]);
const servedRefs = selfRefs(home.body);
const upstreamRefs = selfRefs(upstreamHome.body);
line(`served HTML   absolute chat.deepseek.com self-references: ${servedRefs.length}`);
line(`upstream HTML absolute chat.deepseek.com self-references: ${upstreamRefs.length}`);
line(`sample of upstream self-references (first 8): ${JSON.stringify(upstreamRefs.slice(0, 8), null, 0).slice(0, 600)}`);
line('');
line('context of every absolute self-reference in the served HTML (80 chars before/after):');
for (const m of home.body.matchAll(/https?:\/\/chat\.deepseek\.com[^"'\s)>]*/gi)) {
  line(`  ...${home.body.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, ' ')}...`);
}

/* ---- extra: exact script/link tags carrying integrity / crossorigin -------------------------- */
rule('EXTRA B2. integrity / crossorigin on <script>/<link> tags: upstream vs served');
const tagList = (s) => [...s.matchAll(/<(script|link)\b[^>]*>/gi)].map((m) => m[0]);
const flaggedUpstream = tagList(upstreamHome.body).filter((t) => /integrity\s*=|crossorigin/i.test(t));
const flaggedServed = tagList(home.body).filter((t) => /integrity\s*=|crossorigin/i.test(t));
line(`upstream HTML: ${tagList(upstreamHome.body).length} script/link tags, ${flaggedUpstream.length} carry integrity=/crossorigin:`);
for (const t of flaggedUpstream) line(`  ${t}`);
line(`served HTML:   ${tagList(home.body).length} script/link tags, ${flaggedServed.length} carry integrity=/crossorigin:`);
for (const t of flaggedServed) line(`  ${t}`);
line(`=> IS AN HTML REWRITE REQUIRED FOR integrity=/crossorigin? ${flaggedUpstream.length > 0 ? 'YES (upstream ships them)' : 'NO'}`);
line(`=> are the script src URLs preserved by the rewrite? ${tagList(home.body).filter((t) => /src=/.test(t)).length} served tags have src, upstream had ${tagList(upstreamHome.body).filter((t) => /src=/.test(t)).length}`);
line(`=> does the page use ES modules? type="module" x${(home.body.match(/type\s*=\s*["']module["']/gi) ?? []).length}, dynamic import( x${(home.body.match(/import\s*\(/g) ?? []).length}`);

/* ---- extra: can the iframe still load its own CDN assets? ------------------------------------ */
rule('EXTRA G. Cross-origin CDN assets referenced by the page: reachable / CORS / CORP?');
const assetUrls = [...new Set([...home.body.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]))].filter(
  (u) => !u.includes('127.0.0.1'),
);
line(`absolute asset URLs in the served HTML: ${assetUrls.length}; probing the first 4 with Origin: ${baseUrl}`);
for (const u of assetUrls.slice(0, 4)) {
  try {
    const a = await req(u, { method: 'GET', headers: { origin: baseUrl, accept: '*/*' } });
    line(`  ${u}`);
    line(`    HTTP ${a.status}  content-type=${a.headers['content-type'] ?? '(none)'}  bytes=${Buffer.byteLength(a.body)}`);
    line(`    access-control-allow-origin=${a.headers['access-control-allow-origin'] ?? '(MISSING)'}  cross-origin-resource-policy=${a.headers['cross-origin-resource-policy'] ?? '(none)'}`);
  } catch (err) {
    line(`  ${u}\n    ERROR ${err.message}`);
  }
}

/* ---- extra: seed injection ------------------------------------------------------------------- */
rule('EXTRA C. Seed injection (?__bridge_seed=<base64url-json>)');
const seedObj = { 'bridge-selftest': 'ok-1234' };
const seedB64 = Buffer.from(JSON.stringify(seedObj), 'utf8').toString('base64url');
const seeded = await req(`${baseUrl}/?${SEED_PARAM}=${seedB64}`, { headers: { accept: 'text/html' } });
const headIdx = seeded.body.search(/<head\b[^>]*>/i);
line(`HTTP ${seeded.status}; seeded HTML bytes=${Buffer.byteLength(seeded.body)} (unseeded=${Buffer.byteLength(home.body)})`);
line(`delta bytes = ${Buffer.byteLength(seeded.body) - Buffer.byteLength(home.body)}  (0 = the script is injected unconditionally; only the query param differs)`);
line(`first 260 chars after <head...>: ${JSON.stringify(cut(seeded.body.slice(headIdx, headIdx + 260), 260))}`);
line(`seed param forwarded upstream? (upstream path in Location/echo is not applicable) — bridge strips nothing else`);
const noSeed = await req(`${baseUrl}/`, { headers: { accept: 'text/html' } });
line(`unseeded page contains a "seed failed" script? ${/__bridge_seed/.test(noSeed.body)} (script is always injected; it no-ops without the param — no navigation)`);

/* ---- extra: POST body forwarding ------------------------------------------------------------- */
rule('EXTRA D. POST body forwarding (unmodified content-type, host => chat.deepseek.com)');
const postBody = JSON.stringify({ probe: 'bridge', n: 42 });
const post = await req(`${baseUrl}/api/v0/chat/completion`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(postBody) },
  body: postBody,
});
line(`POST /api/v0/chat/completion -> HTTP ${post.status} ${post.statusMessage}`);
line(`content-type: ${post.headers['content-type'] ?? '(none)'}`);
line(`body (first 200 chars): ${cut(post.body, 200)}`);

/* ---- extra: unit checks of the rewrite rules -------------------------------------------------- */
rule('EXTRA E. Unit checks of header/cookie/Location rewrite rules');
const outHeaders = buildUpstreamHeaders(
  { host: `${localHost}`, connection: 'keep-alive', 'content-type': 'application/json', cookie: 'a=b', accept: 'application/json' },
  { upstreamHost: 'chat.deepseek.com' },
);
line(`buildUpstreamHeaders({host:"${localHost}", connection:"keep-alive", content-type, cookie, accept}) ->`);
line(`  ${JSON.stringify(outHeaders)}`);
line(`  original Host removed/replaced with upstream? ${outHeaders.host === 'chat.deepseek.com' ? 'YES ✅' : 'NO ❌'}`);
line(`  connection dropped? ${'connection' in outHeaders ? 'NO ❌' : 'YES ✅'}   content-type untouched? ${outHeaders['content-type'] === 'application/json' ? 'YES ✅' : 'NO ❌'}`);
line('');
for (const sample of [
  'ds_session_id=abc; Path=/; Domain=.deepseek.com; Secure; HttpOnly; SameSite=Lax',
  '__cf_bm=xyz; Path=/; Domain=chat.deepseek.com; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=1800',
]) {
  line(`  IN : ${sample}`);
  line(`  OUT: ${rewriteSetCookie(sample)}`);
}
line('');
for (const sample of [
  'https://chat.deepseek.com/sign_in',
  '//chat.deepseek.com/api/v0/users/current',
  '/relative/path',
  'https://example.com/elsewhere',
]) {
  line(`  Location ${sample}  ->  ${rewriteLocation(sample, baseUrl, UPSTREAM_ORIGIN)}`);
}

/* ---- extra: connection reuse isolation ------------------------------------------------------- */
rule('EXTRA H. Connection reuse isolation: fresh TCP+TLS per request vs pooled');
const cold = [];
for (let i = 0; i < 3; i++) {
  const r = await req(`${baseUrl}/api/v0/users/current`, { agent: false }); // brand-new connection
  cold.push(r.ms.total);
}
const warm = [];
const ka = new http.Agent({ keepAlive: true, maxSockets: 2 });
for (let i = 0; i < 3; i++) {
  const r = await req(`${baseUrl}/api/v0/users/current`, { agent: ka });
  warm.push(r.ms.total);
}
ka.destroy();
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
line(`no-reuse (agent:false, new TCP+TLS each time): ${cold.map((x) => x.toFixed(1)).join(', ')} ms  avg ${avg(cold).toFixed(1)} ms`);
line(`pooled   (client keep-alive agent)          : ${warm.map((x) => x.toFixed(1)).join(', ')} ms  avg ${avg(warm).toFixed(1)} ms`);
const h4 = JSON.parse((await req(`${baseUrl}/__bridge/health`)).body);
line(`upstream TLS sockets held by the bridge after all of the above: ${h4.sockets} (pooled keep-alive agent, maxSockets=128)`);
line(`upstream TLS sockets CREATED since the bridge started: ${h4.socketsCreated} for ${h4.stats.requests} proxied requests`);
line(`=> pooling proven structurally: ${h4.stats.requests} requests reused ${h4.socketsCreated} upstream connection(s)`);
line(`NOTE: wall-clock deltas on this network are dominated by upstream RTT variance (see the spread`);
line(`      above), so socket counts + reusedSocket flags are the reliable reuse signal, not the ms.`);

/* ---- extra: does the app bundle hardcode the absolute API origin? ---------------------------- */
rule('EXTRA I. Do the DeepSeek JS bundles hardcode the absolute upstream origin?');
const bundleUrls = [...new Set([...home.body.matchAll(/src\s*=\s*["'](https?:\/\/[^"']+\.js[^"']*)["']/gi)].map((m) => m[1]))];
const apiDirect = await req(`${UPSTREAM_ORIGIN}/api/v0/users/current`, {
  headers: { origin: baseUrl, accept: 'application/json' },
});
line(`direct upstream /api/v0/users/current with Origin: ${baseUrl} -> HTTP ${apiDirect.status}`);
line(`  access-control-allow-origin=${apiDirect.headers['access-control-allow-origin'] ?? '(MISSING)'}  access-control-allow-credentials=${apiDirect.headers['access-control-allow-credentials'] ?? '(MISSING)'}`);
line(`  => a page on ${baseUrl} calling chat.deepseek.com directly would be ${apiDirect.headers['access-control-allow-origin'] ? 'allowed' : 'BLOCKED by CORS'}`);
line(`script bundles referenced by the page: ${bundleUrls.length}`);
for (const b of bundleUrls) {
  const js = await req(b, { headers: { accept: '*/*' } });
  const abs = [...new Set([...js.body.matchAll(/https?:\/\/chat\.deepseek\.com[^"'`\s)\\]*/g)].map((m) => m[0]))];
  const relApi = (js.body.match(/["'`]\/api\/v\d/g) ?? []).length;
  const count = (re) => (js.body.match(re) ?? []).length;
  line(`  ${b.split('/').pop()}`);
  line(`    HTTP ${js.status}  bytes=${Buffer.byteLength(js.body)}  absolute chat.deepseek.com URLs: ${abs.length}  relative "/api/vN" strings: ${relApi}`);
  line(`    new WebSocket(: ${count(/new WebSocket\(/g)}  "wss://": ${count(/wss:\/\//g)}  EventSource(: ${count(/new EventSource\(/g)}  "text/event-stream": ${count(/text\/event-stream/g)}  getReader(: ${count(/\.getReader\(/g)}  ReadableStream: ${count(/ReadableStream/g)}`);
  for (const u of abs.slice(0, 6)) line(`      ABS: ${u}`);
}

rule('EXTRA J. Context of wss:// and text/event-stream inside the app bundle');
const mainBundle = bundleUrls.find((u) => /\/main\.[0-9a-f]+\.js/.test(u)) ?? bundleUrls.at(-1);
const mainJs = (await req(mainBundle, { headers: { accept: '*/*' } })).body;
for (const needle of ['wss://', 'text/event-stream']) {
  const idxs = [...mainJs.matchAll(new RegExp(needle.replace(/[/:]/g, '\\$&'), 'g'))].map((m) => m.index);
  line(`"${needle}": ${idxs.length} occurrence(s) in ${mainBundle.split('/').pop()}`);
  for (const i of idxs.slice(0, 4)) {
    line(`    ...${mainJs.slice(Math.max(0, i - 120), i + 120).replace(/\s+/g, ' ')}...`);
  }
}

rule('EXTRA F. Upgrade (websocket) probe against the proxy');
const upgradeResult = await new Promise((resolve) => {
  const r = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/api/v0/ws',
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'), 'sec-websocket-version': '13' },
  });
  r.on('upgrade', (res) => resolve(`upgrade accepted by upstream: HTTP ${res.statusCode}`));
  r.on('response', (res) => resolve(`no upgrade: HTTP ${res.statusCode} ${res.statusMessage}`));
  r.on('error', (e) => resolve(`error: ${e.message}`));
  r.end();
  setTimeout(() => resolve('no response within 15s'), 15_000);
});
line(`GET /api/v0/ws with Upgrade: websocket -> ${upgradeResult}`);
const health3 = await req(`${baseUrl}/__bridge/health`);
const h3 = JSON.parse(health3.body);
line(`health.stats.upgrades = ${h3.stats.upgrades} (0 or more; each one is logged by the bridge)`);
line('');
line('# END OF PROBE');
