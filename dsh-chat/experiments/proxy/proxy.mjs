#!/usr/bin/env node
/**
 * proxy.mjs — loopback reverse proxy that makes https://chat.deepseek.com embeddable in an iframe.
 *
 * Design constraints (deliberate):
 *   - Node.js >= 22, ESM, ZERO external dependencies (node:http / node:https / node:zlib only).
 *   - Listens on 127.0.0.1 ONLY. Port is configurable (default 3377) and falls back to an
 *     OS-assigned ephemeral port when the requested port is busy. The actual URL is printed.
 *   - Streams every response body through untouched (SSE/`text/event-stream` arrives chunk-by-chunk).
 *     The ONLY exception is `text/html` documents, which are buffered just long enough for the
 *     optional seed-injection rewrite (see `rewriteHtmlDocument`). A document is never a stream.
 *   - Upstream TLS connections are pooled/reused through a single keep-alive Agent.
 *
 * Start:
 *   node proxy.mjs                 # 127.0.0.1:3377, or an ephemeral port if 3377 is taken
 *   node proxy.mjs --port 4000
 *   BRIDGE_PORT=4000 node proxy.mjs
 *
 * As a module:
 *   import { startBridge } from './proxy.mjs';
 *   const bridge = await startBridge({ port: 3377 });   // -> { url, port, server, close() }
 *   // `upstreamOrigin` defaults to https://chat.deepseek.com; overriding it is only used by
 *   // streaming.test.mjs, which points the bridge at a controlled local "fake upstream".
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------------------------------- */

/** The upstream origin this bridge mirrors by default. Everything else is refused (not an open proxy). */
export const DEFAULT_UPSTREAM_ORIGIN = 'https://chat.deepseek.com';
export const UPSTREAM_ORIGIN = DEFAULT_UPSTREAM_ORIGIN;
export const UPSTREAM_HOST = 'chat.deepseek.com';

export const LOCAL_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3377;

/** Internal, never-forwarded control endpoint. */
export const HEALTH_PATH = '/__bridge/health';

/** Query parameter that carries a base64url-encoded JSON blob of localStorage bootstrap values. */
export const SEED_PARAM = '__bridge_seed';

/**
 * Response headers that break iframing and are therefore deleted on the way back to the browser.
 * (CSP `frame-ancestors`, `X-Frame-Options`, the COOP/COEP/CORP trio, and HSTS — HSTS is meaningless
 * on a loopback http origin and only risks pinning the browser to https for 127.0.0.1.)
 */
export const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
]);

/** Hop-by-hop request headers that must not be forwarded (recomputed per hop by Node). */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Observability counters surfaced by /__bridge/health. */
export const stats = {
  requests: 0,
  upgrades: 0,
  htmlRewrites: 0,
  cookiesRewritten: 0,
  redirectsRewritten: 0,
  upstreamErrors: 0,
  startedAt: null,
};

const log = (...args) => console.error('[bridge]', ...args);

/**
 * Build the upstream transport descriptor (protocol/host/port + pooled keep-alive agent).
 *
 * @param {string} upstreamOrigin
 */
export function createUpstream(upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN) {
  const url = new URL(upstreamOrigin);
  const isTls = url.protocol === 'https:';
  const defaultPort = isTls ? 443 : 80;
  const port = Number(url.port || defaultPort);
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 128,
    maxFreeSockets: 32,
    scheduling: 'lifo',
  };
  const agent = isTls
    ? new https.Agent({ ...agentOptions, minVersion: 'TLSv1.2', servername: url.hostname })
    : new http.Agent(agentOptions);

  // Count how many REAL upstream connections are opened. `agent.totalSocketCount` only shows the
  // sockets currently held; this counter proves pooling across the whole run (N requests -> 1 socket).
  let socketsCreated = 0;
  const originalCreateConnection = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => {
    socketsCreated++;
    return originalCreateConnection(...args);
  };

  return {
    origin: `${url.protocol}//${url.host}`,
    protocol: url.protocol,
    host: url.hostname,
    port,
    // The Host header we present upstream: no port for the default port, otherwise host:port.
    hostHeader: port === defaultPort ? url.hostname : `${url.hostname}:${port}`,
    isTls,
    agent,
    get socketsCreated() {
      return socketsCreated;
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Request header translation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the header set sent upstream.
 *  - drops hop-by-hop headers and the original `host` (we always present the upstream host);
 *  - keeps `content-type` and any other end-to-end header byte-for-byte;
 *  - for navigation/document requests (`Accept: text/html`) asks for `identity` encoding so the HTML
 *    rewrite can run on plain text instead of having to inflate a compressed document.
 *
 * @param {http.IncomingHttpHeaders} incoming
 * @param {{ forDocument?: boolean, keepUpgrade?: boolean, upstreamHost?: string }} [opts]
 * @returns {Record<string, string|string[]>}
 */
export function buildUpstreamHeaders(incoming, opts = {}) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
    out[name] = value;
  }
  if (opts.keepUpgrade) {
    if (incoming.upgrade) out.upgrade = incoming.upgrade;
    if (incoming.connection) out.connection = incoming.connection;
  }
  if (opts.forDocument) out['accept-encoding'] = 'identity';
  out.host = opts.upstreamHost ?? UPSTREAM_HOST; // never leak `127.0.0.1:<port>` upstream
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Response header translation
 * ---------------------------------------------------------------------------------------------- */

/**
 * Rewrite `Set-Cookie` for an http-over-loopback origin:
 *   - drop `Domain=...` (the upstream domain is not ours);
 *   - drop `Secure` (the connection is plain http);
 *   - drop `Partitioned` (CHIPS requires a secure context);
 *   - keep `HttpOnly`, `SameSite`, `Path`, `Max-Age`, `Expires` and the cookie value untouched.
 *
 * @param {string} cookie
 * @returns {string}
 */
export function rewriteSetCookie(cookie) {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => !/^domain=/i.test(part))
    .filter((part) => !/^secure$/i.test(part))
    .filter((part) => !/^partitioned$/i.test(part))
    .join('; ');
}

/**
 * Rewrite an upstream `Location` (and `Content-Location`) that points back at the upstream origin so
 * the browser stays on the loopback origin instead of escaping the iframe/bridge.
 *
 * @param {string} value
 * @param {string} localOrigin e.g. `http://127.0.0.1:3377`
 * @param {string} [upstreamOrigin]
 * @returns {string}
 */
export function rewriteLocation(value, localOrigin, upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN) {
  if (typeof value !== 'string') return value;
  const upstream = new URL(upstreamOrigin);
  const escaped = upstreamOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = value.replace(new RegExp(`^${escaped}`, 'i'), localOrigin);
  // protocol-relative form: //chat.deepseek.com/...
  out = out.replace(
    new RegExp(`^//${upstream.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/?#]|$)`, 'i'),
    localOrigin.replace(/^https?:/i, ''),
  );
  return out;
}

/**
 * Convert an upstream response header block into the headers we send to the browser.
 *
 * @param {http.IncomingHttpHeaders} upstreamHeaders
 * @param {string} localOrigin
 * @param {string} [upstreamOrigin]
 * @returns {{ headers: Record<string, string|string[]>, removed: string[] }}
 */
export function translateResponseHeaders(upstreamHeaders, localOrigin, upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN) {
  /** @type {Record<string, string|string[]>} */
  const headers = {};
  const removed = [];
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) {
      removed.push(lower);
      continue;
    }
    // Node's client already de-chunked the body; framing headers are recomputed by our server.
    if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') continue;
    if (lower === 'set-cookie') {
      const list = Array.isArray(value) ? value : [value];
      headers['set-cookie'] = list.map((cookie) => {
        stats.cookiesRewritten++;
        return rewriteSetCookie(cookie);
      });
      continue;
    }
    if (lower === 'location' || lower === 'content-location') {
      const rewritten = Array.isArray(value)
        ? value.map((v) => rewriteLocation(v, localOrigin, upstreamOrigin))
        : rewriteLocation(value, localOrigin, upstreamOrigin);
      if (JSON.stringify(rewritten) !== JSON.stringify(value)) stats.redirectsRewritten++;
      headers[lower] = rewritten;
      continue;
    }
    headers[lower] = value;
  }
  return { headers, removed };
}

/* ------------------------------------------------------------------------------------------------
 * HTML rewrite (single, isolated, opt-out-able function)
 * ---------------------------------------------------------------------------------------------- */

/**
 * The one and only body rewrite in this proxy. Applied to `text/html` documents only.
 *
 * 1. SEED INJECTION (the point of this function): if the document URL carries
 *    `?__bridge_seed=<base64url-json>`, inject a tiny inline script at the very START of `<head>`
 *    that writes each key of the JSON object into `localStorage`. It never navigates anywhere; the
 *    page then boots normally with the seeded values.
 * 2. SAFETY REPAIRS for the loopback origin, all conservative and idempotent:
 *    - strip `integrity=` / `crossorigin` from `<script>`/`<link>` tags: under a loopback origin the
 *      CDN document becomes cross-origin, and SRI/CORS checks on those tags are exactly what the
 *      reference project found breaking the page;
 *    - retarget a `<base href="https://chat.deepseek.com...">` at the local origin (a `<base>` tag
 *      would otherwise send every relative URL back to the upstream origin, i.e. out of the iframe);
 *    - optionally (BRIDGE_REWRITE_ABSOLUTE_ORIGIN=1) rewrite bare absolute upstream self-references
 *      in the HTML text.
 *
 * Everything is regex-based and best-effort: on any error the ORIGINAL html is returned unchanged.
 *
 * @param {string} html
 * @param {{ url: string, localOrigin: string, upstreamOrigin?: string, rewriteAbsoluteOrigin?: boolean,
 *           stripSri?: boolean }} opts
 * @returns {string}
 */
export function rewriteHtmlDocument(html, opts) {
  try {
    const {
      url,
      localOrigin,
      upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
      rewriteAbsoluteOrigin = false,
      stripSri = true,
    } = opts;
    const upstreamHost = new URL(upstreamOrigin).host;
    let out = html;

    // (2a) integrity / crossorigin attributes on script+link tags. Default ON because the reference
    // project found the CDN refuses/handles them differently once the document origin changes;
    // set `stripSri: false` to keep SRI hashes intact if a host integration prefers that.
    if (stripSri) {
      out = out.replace(/<(script|link)\b[^>]*>/gi, (tag) =>
        tag
          .replace(/\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
          .replace(/\s+crossorigin(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, ''),
      );
    }

    // (2b) <base href> pointing at the upstream origin -> local origin.
    out = out.replace(/<base\b[^>]*>/gi, (tag) =>
      tag.replace(/(href\s*=\s*["'])https?:\/\/chat\.deepseek\.com/gi, `$1${localOrigin}`),
    );

    // (2c) optional blanket absolute-origin rewrite (off by default: can break signed URLs).
    if (rewriteAbsoluteOrigin) out = out.split(upstreamOrigin).join(localOrigin);

    // (1) seed injection, at the very start of <head>.
    const seedScript =
      '<script>(function(){try{' +
      `var m=/[?&]${SEED_PARAM}=([^&]*)/.exec(location.search);if(!m)return;` +
      "var b=m[1].replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';" +
      'var bin=atob(b);var bytes=new Uint8Array(bin.length);' +
      'for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);' +
      'var json=(typeof TextDecoder==="function")?new TextDecoder().decode(bytes):decodeURIComponent(escape(bin));' +
      'var o=JSON.parse(json);' +
      'for(var k in o){if(!Object.prototype.hasOwnProperty.call(o,k))continue;' +
      "localStorage.setItem(k,typeof o[k]==='string'?o[k]:JSON.stringify(o[k]));}" +
      "}catch(e){console.warn('[bridge] seed failed',e);}})();</script>";
    const headOpen = out.match(/<head\b[^>]*>/i);
    if (headOpen) {
      const at = headOpen.index + headOpen[0].length;
      out = out.slice(0, at) + seedScript + out.slice(at);
    } else {
      out = seedScript + out;
    }
    return out;
  } catch (err) {
    log('html rewrite failed, serving original document:', err?.message ?? err);
    return html;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Body handling
 * ---------------------------------------------------------------------------------------------- */

/**
 * Decode a possibly-compressed HTML body to a UTF-8 string. `buildUpstreamHeaders` normally asks for
 * `identity` on documents, but upstream may compress anyway, so we handle it.
 *
 * @param {Buffer} buf
 * @param {string|undefined} encoding
 * @returns {string}
 */
export function decodeBody(buf, encoding) {
  const enc = (encoding || 'identity').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf).toString('utf8');
  if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf8');
  if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8');
  return buf.toString('utf8');
}

/**
 * Re-encode a rewritten HTML string with the original content-encoding (or none).
 *
 * @param {string} text
 * @param {string|undefined} encoding
 * @returns {Buffer}
 */
export function encodeBody(text, encoding) {
  const enc = (encoding || 'identity').toLowerCase();
  const buf = Buffer.from(text, 'utf8');
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gzipSync(buf);
  if (enc === 'deflate') return zlib.deflateSync(buf);
  if (enc === 'br') return zlib.brotliCompressSync(buf);
  return buf;
}

/* ------------------------------------------------------------------------------------------------
 * The bridge
 * --------------------------------------------------------------------------------------------- */

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{ localOrigin: string, upstream: ReturnType<typeof createUpstream>, rewriteAbsoluteOrigin: boolean }} ctx
 */
function handleRequest(req, res, ctx) {
  const { localOrigin, upstream } = ctx;
  const transports = { 'http:': http, 'https:': https };

  // ---- internal control endpoint: never forwarded upstream -------------------------------
  let parsed;
  try {
    parsed = new URL(req.url ?? '/', localOrigin);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'bad request url' }));
    return;
  }

  if (parsed.pathname === HEALTH_PATH) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        ok: true,
        upstream: upstream.origin,
        port: Number(new URL(localOrigin).port),
        localOrigin,
        node: process.version,
        sockets: upstream.agent.totalSocketCount,
        socketsCreated: upstream.socketsCreated,
        stats: { ...stats },
      }),
    );
    return;
  }

  stats.requests++;
  const isDocument = String(req.headers.accept ?? '').includes('text/html');
  const upstreamPath = `${parsed.pathname}${parsed.search}`;

  const upReq = transports[upstream.protocol].request({
    host: upstream.host,
    port: upstream.port,
    method: req.method,
    path: upstreamPath,
    headers: buildUpstreamHeaders(req.headers, { forDocument: isDocument, upstreamHost: upstream.hostHeader }),
    agent: upstream.agent,
  });
  // Never let Nagle coalesce SSE frames: forward bytes the moment they arrive.
  upReq.on('socket', (socket) => socket.setNoDelay?.(true));
  req.socket?.setNoDelay?.(true);
  res.socket?.setNoDelay?.(true);

  upReq.on('response', (upRes) => {
    const { headers, removed } = translateResponseHeaders(upRes.headers, localOrigin, upstream.origin);
    const contentType = String(headers['content-type'] ?? '');
    const isHtml = /^text\/html\b/i.test(contentType);

    if (!isHtml) {
      // ---- the common path: pure streaming, zero buffering ------------------------------
      res.writeHead(upRes.statusCode ?? 502, headers);
      res.flushHeaders(); // SSE: get headers (and any early bytes) out immediately
      upRes.pipe(res);
      return;
    }

    // ---- HTML documents: buffer, rewrite once, send -------------------------------------
    /** @type {Buffer[]} */
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      let text;
      try {
        text = decodeBody(raw, upRes.headers['content-encoding']);
      } catch (err) {
        log('inflate failed for', upstreamPath, err?.message ?? err);
        res.writeHead(upRes.statusCode ?? 502, { ...headers, 'content-length': String(raw.length) });
        res.end(raw);
        return;
      }
      const rewritten = rewriteHtmlDocument(text, {
        url: upstreamPath,
        localOrigin,
        upstreamOrigin: upstream.origin,
        rewriteAbsoluteOrigin: ctx.rewriteAbsoluteOrigin,
        stripSri: ctx.stripSri,
      });
      stats.htmlRewrites++;
      const body = encodeBody(rewritten, upRes.headers['content-encoding']);
      headers['content-length'] = String(body.length);
      headers['cache-control'] = 'no-store'; // never cache a rewritten document
      if (removed.length) headers['x-bridge-stripped'] = removed.join(',');
      // Precise check: only flag leftover SRI/CORS ATTRIBUTES on script/link tags. A bare
      // "crossorigin" substring elsewhere in the document (e.g. inside an inline bundle) is not
      // a tag attribute and does not affect loading.
      const leftoverTags = [...rewritten.matchAll(/<(script|link)\b[^>]*>/gi)].filter((m) =>
        /integrity\s*=|crossorigin/i.test(m[0]),
      );
      if (leftoverTags.length) {
        headers['x-bridge-warning'] = `integrity-or-crossorigin-still-on-${leftoverTags.length}-script-or-link-tag(s)`;
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      res.end(body);
    });
    upRes.on('error', (err) => {
      stats.upstreamErrors++;
      log('upstream body error', upstreamPath, err?.message ?? err);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end();
    });
  });

  upReq.on('error', (err) => {
    stats.upstreamErrors++;
    log('upstream error', req.method, upstreamPath, err?.message ?? err);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ ok: false, error: 'upstream_error', detail: err?.message ?? String(err) }));
  });

  // Forward the request body unmodified (POST et al.), streaming in both directions.
  req.pipe(upReq);
  req.on('error', (err) => {
    log('client request error', err?.message ?? err);
    upReq.destroy();
  });
  res.on('close', () => {
    if (res.writableFinished) return;
    upReq.destroy(); // client went away (aborted SSE, closed iframe)
  });
}

/**
 * Transparent `Upgrade:` passthrough (WebSocket / h2c style). The reference notes say
 * chat.deepseek.com serves no websockets, but this keeps the bridge correct if that changes.
 *
 * @param {http.IncomingMessage} req
 * @param {import('node:net').Socket} clientSocket
 * @param {Buffer} head
 */
function makeUpgradeHandler(ctx) {
  return function handleUpgrade(req, clientSocket, head) {
    const { upstream } = ctx;
    const transports = { 'http:': http, 'https:': https };
    stats.upgrades++;
    const path = req.url || '/';
    log(`upgrade #${stats.upgrades}: ${req.method} ${path} (upgrade=${req.headers.upgrade ?? '?'})`);

    const upReq = transports[upstream.protocol].request({
      host: upstream.host,
      port: upstream.port,
      method: req.method || 'GET',
      path,
      headers: buildUpstreamHeaders(req.headers, { keepUpgrade: true, upstreamHost: upstream.hostHeader }),
      agent: false, // an upgraded connection must not return to the pool
    });
    upReq.on('socket', (socket) => socket.setNoDelay?.(true));
    clientSocket.setNoDelay?.(true);

    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`];
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else if (v !== undefined) lines.push(`${k}: ${v}`);
      }
      clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead?.length) clientSocket.write(upHead);
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
      const done = () => {
        upSocket.destroy();
        clientSocket.destroy();
      };
      upSocket.on('error', done);
      clientSocket.on('error', done);
      upSocket.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => upSocket.destroy());
    });

    upReq.on('response', (upRes) => {
      // Upstream declined the upgrade: relay the plain response and close.
      clientSocket.write(
        `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Error'}\r\nConnection: close\r\n\r\n`,
      );
      upRes.resume();
      upRes.on('end', () => clientSocket.destroy());
    });

    upReq.on('error', (err) => {
      stats.upstreamErrors++;
      log('upgrade failed', path, err?.message ?? err);
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      } catch {
        /* socket already gone */
      }
      clientSocket.destroy();
    });

    if (head?.length) upReq.write(head);
    upReq.end();
  };
}

/**
 * Start the bridge. Resolves once it is actually listening, with the REAL port.
 *
 * @param {{ port?: number, host?: string, upstreamOrigin?: string, rewriteAbsoluteOrigin?: boolean,
 *           quiet?: boolean, onReady?: (info: { port: number, origin: string }) => void }} [options]
 * @returns {Promise<{ url: string, port: number, origin: string, server: http.Server, upstream: ReturnType<typeof createUpstream>, close: () => Promise<void> }>}
 */
export async function createBridgeProxy(options = {}) {
  const requestedPort = Number(options.port ?? process.env.BRIDGE_PORT ?? DEFAULT_PORT);
  const host = options.host ?? LOCAL_HOST;
  const upstream = createUpstream(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  const rewriteAbsoluteOrigin =
    options.rewriteAbsoluteOrigin ?? process.env.BRIDGE_REWRITE_ABSOLUTE_ORIGIN === '1';
  const stripSri = options.stripSri !== false;

  const ctx = { localOrigin: `http://${host}:${requestedPort}`, upstream, rewriteAbsoluteOrigin, stripSri };

  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res, ctx);
    } catch (err) {
      log('fatal handler error', err?.stack ?? err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bridge_internal_error' }));
    }
  });

  server.on('upgrade', makeUpgradeHandler(ctx));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  // SSE connections are long-lived; do not let the server time them out.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.timeout = 0;

  /** @param {number} port */
  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

  let address;
  try {
    address = await listen(requestedPort);
  } catch (err) {
    if (err?.code === 'EADDRINUSE' && requestedPort !== 0) {
      log(`port ${requestedPort} is busy -> falling back to an OS-assigned port`);
      address = await listen(0);
    } else {
      throw err;
    }
  }

  const port = /** @type {import('node:net').AddressInfo} */ (address).port;
  ctx.localOrigin = `http://${host}:${port}`;
  stats.startedAt = new Date().toISOString();
  options.onReady?.({ port, origin: ctx.localOrigin });

  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        upstream.agent.destroy();
        resolve();
      });
    });

  if (!options.quiet) {
    log(`listening on ${ctx.localOrigin}  ->  ${upstream.origin}`);
    log(`health: ${ctx.localOrigin}${HEALTH_PATH}`);
    console.log(`BRIDGE_URL=${ctx.localOrigin}`);
    console.log(`BRIDGE_PORT=${port}`);
  }

  return {
    /** Full local origin, e.g. `http://127.0.0.1:3377` — put THIS in the iframe `src`. */
    url: ctx.localOrigin,
    origin: ctx.localOrigin,
    /** The REAL port actually bound (requested port, or the OS-assigned fallback). */
    port,
    /** Path of the internal JSON health endpoint. */
    healthPath: HEALTH_PATH,
    /** Convenience: `await bridge.health()` -> the parsed health JSON (node:http, no undici). */
    health: () =>
      new Promise((resolve, reject) => {
        const r = http.get(`${ctx.localOrigin}${HEALTH_PATH}`, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
              reject(err);
            }
          });
        });
        r.on('error', reject);
      }),
    upstream,
    server,
    close,
  };
}

/** Alias kept for readability at call sites that prefer "start". */
export const startBridge = createBridgeProxy;

/**
 * Process-wide singleton accessor: returns the already-running bridge when there is one, otherwise
 * creates it. Handy for host integrations (e.g. `lib/index.js`) that may be loaded more than once.
 *
 * @param {Parameters<typeof createBridgeProxy>[0]} [options]
 */
let sharedBridge = null;
export async function acquireBridgeProxy(options = {}) {
  if (sharedBridge) return sharedBridge;
  sharedBridge = await createBridgeProxy(options);
  const originalClose = sharedBridge.close;
  sharedBridge.close = async () => {
    sharedBridge = null;
    await originalClose();
  };
  return sharedBridge;
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  let port = Number(process.env.BRIDGE_PORT ?? DEFAULT_PORT);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' || argv[i] === '-p') port = Number(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node proxy.mjs [--port <n>]   (env: BRIDGE_PORT, BRIDGE_PORT_FILE)');
      process.exit(0);
    }
  }
  const bridge = await createBridgeProxy({ port });
  // Optional: let a probe script discover the real (possibly ephemeral) port.
  if (process.env.BRIDGE_PORT_FILE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.BRIDGE_PORT_FILE, String(bridge.port), 'utf8');
  }
  const shutdown = async (signal) => {
    log(`received ${signal}, shutting down`);
    await bridge.close();
    // Let the event loop drain naturally. NOTE: calling `process.exit()` here can trip a Node
    // 24.18/Windows libuv assertion ("async.c line 94") if any undici/fetch keep-alive socket to
    // this bridge was closed just before; see node-exit-abort.repro.mjs. The unref'd timer only
    // fires if something else still holds the loop open, and is harmless otherwise.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
