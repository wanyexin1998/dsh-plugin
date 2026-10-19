#!/usr/bin/env node
/**
 * serve-test-page.mjs — throwaway static server (node:http, no deps) that serves
 * iframe-embed-test.html from a DIFFERENT origin than the bridge, so the A/B iframe test is a real
 * cross-origin embed. The DSH Web GUI (127.0.0.1:19387) plays exactly this role in production.
 *
 * Usage: node serve-test-page.mjs [port]      # default 8099
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 8099);
const here = dirname(fileURLToPath(import.meta.url));

const server = http.createServer(async (req, res) => {
  try {
    const body = await readFile(join(here, 'iframe-embed-test.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`test page: http://127.0.0.1:${port}/iframe-embed-test.html`);
});
