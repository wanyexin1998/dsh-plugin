import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { fixture } from './p0-fixture.mjs';
import { createUIRpc } from '../lib/host/ui-rpc.js';

const f = await fixture({ automatic: true });
const routes = new Map();
const peer = { id: 'browser', principal: { kind: 'owner' } };
const cleanup = createUIRpc({ browserPeer: peer, admit: () => ({ peer }), fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } }, f.managed, f.service);
const browserErrors = [], checks = [];
const source = `import React from 'react';import{createRoot}from'react-dom/client';import{ConnectionSection,ToolView}from'./lib/client/index.js';import{ConnectionStore}from'./lib/client/store.js';
const store=new ConnectionStore({rpc:{async call(channel,endpoint,payload,signal){return fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal}).then(r=>r.json())}}});
window.harness={store,dispose:()=>{root.unmount();store.dispose()}};const root=createRoot(document.getElementById('app'));root.render(React.createElement('main',null,React.createElement('label',null,'原会话草稿',React.createElement('textarea',{'aria-label':'原会话草稿',defaultValue:'请查询明天的日程'})),React.createElement(ConnectionSection,{store}),...[1,2].map(n=>React.createElement(ToolView,{key:n,store,phase:'result',callId:'call-'+n,sessionId:'session-example',block:{content:[{type:'text',text:JSON.stringify(n===1?{status:'failed',reasonCode:'authorization_expired'}:{status:'auth_required',reasonCode:'not_connected'})}]}}))));`;
const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'browser-harness.ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const server = createServer(async (req, res) => {
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(compiled.outputFiles[0].text); return; }
  if (req.url === '/rpc' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const { endpoint, payload } = JSON.parse(raw);
    const reply = await routes.get(`/api/${endpoint}`).fetch(new Request(`http://127.0.0.1/api/${endpoint}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'browser-test', method: endpoint, payload }) }));
    const { result } = await reply.json();
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width"><title>钉钉本地验收 Harness</title><style>body{font:16px system-ui;margin:24px;color:#202838;background:#fafbfc}main{max-width:750px;margin:auto;display:grid;gap:20px}textarea{display:block;width:90%;padding:12px}html.dark{color-scheme:dark}html.dark body{color:#e5e7eb;background:#171a21}</style><div id="app"></div><script src="/app.js"></script></html>');
});
let browser;
try {
  await mkdir('artifacts/browser', { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage(); page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`${base}/session/example#draft`);
  await page.getByRole('status').first().filter({ hasText: '尚未连接钉钉' }).waitFor();
  await page.evaluate(() => { window.originalCards = [...document.querySelectorAll('.dsh-dt-card')]; });
  await page.getByRole('textbox', { name: '原会话草稿' }).fill('请查询明天日程，保留这份草稿');
  // Spoofed messages cannot set a UI status; Host readback is required.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.invalid', data: { type: 'dsh-dingtalk:auth', result: 'connected', transactionId: 'fake' } })));
  assert.equal(await page.getByText('钉钉已连接', { exact: true }).count(), 0);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: '连接钉钉', exact: true }).first().click();
  const popup = await popupPromise;
  await page.getByText('钉钉已连接', { exact: true }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('status').filter({ hasText: /^(钉钉)?已连接$/ }).count(), 3);
  const cardSize = await page.locator('.dsh-dt-card').first().boundingBox();
  assert.ok(cardSize.width <= 420 && cardSize.height <= 130, 'Conversation card must remain compact');
  assert.ok(await page.evaluate(() => { const current = [...document.querySelectorAll('.dsh-dt-card')]; return current.length === window.originalCards.length && current.every((node, i) => node === window.originalCards[i]); }));
  for (const status of [{ state: 'reauth_required', reasonCode: 'authorization_expired' }, { state: 'unknown', reasonCode: 'service_unavailable' }]) {
    // Test-only synthetic projection verifies React node identity for failure/expiry feedback.
    await page.evaluate(value => window.harness.store.set({ status: value }), status);
    await page.waitForTimeout(50);
    assert.ok(await page.evaluate(() => { const current = [...document.querySelectorAll('.dsh-dt-card')]; return current.length === window.originalCards.length && current.every((node, i) => node === window.originalCards[i]); }));
  }
  await page.evaluate(() => window.harness.store.refresh());
  await page.getByText('钉钉已连接', { exact: true }).first().waitFor();
  checks.push('connected, expired and failed feedback updates the original card DOM nodes; no new status card inserted');
  assert.equal(await page.getByRole('textbox').inputValue(), '请查询明天日程，保留这份草稿');
  assert.match(page.url(), /session\/example#draft$/);
  await popup.waitForEvent('close', { timeout: 3000 }).catch(() => {});
  checks.push('click opens new tab; callback readback updates settings + 2 cards; original URL/draft preserved; spoof ignored');
  await page.screenshot({ path: 'artifacts/browser/connected-light.png', fullPage: true });
  await page.getByRole('button', { name: '解除连接', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '保留连接');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '解除连接');
  assert.equal((await f.service.status()).state, 'connected');
  checks.push('unlink requires second confirmation; Escape preserves connection and restores focus');
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: 'artifacts/browser/connected-dark-mobile.png', fullPage: true });
  checks.push('light/dark inheritance, keyboard focus and 390px layout without horizontal overflow');
  await page.getByRole('button', { name: '解除连接', exact: true }).click();
  await page.getByRole('button', { name: '确认解除连接', exact: true }).click();
  await page.getByText('尚未连接钉钉', { exact: true }).first().waitFor({ timeout: 30000 });
  assert.equal(await page.getByRole('status').filter({ hasText: '尚未连接钉钉' }).count(), 3);
  checks.push('confirmed precise logout synchronizes all subscribed views');
  // Browser popup blocking: user receives an explicit link; polling is sufficient.
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: '连接钉钉', exact: true }).first().click();
  const fallback = page.getByRole('link', { name: /浏览器拦截/ }).first();
  await fallback.waitFor(); const target = await fallback.getAttribute('href');
  const detached = await ctx.newPage(); await detached.goto(target);
  await page.getByText('钉钉已连接', { exact: true }).first().waitFor({ timeout: 30000 });
  await detached.close();
  checks.push('blocked popup fallback + no opener completion recovered by bounded 2-second polling');
  f.state.cancel = true;
  await page.getByRole('button', { name: '重新授权', exact: true }).first().click();
  const cancelledLink = page.getByRole('link', { name: /浏览器拦截/ }).first(); await cancelledLink.waitFor();
  const cancelledPage = await ctx.newPage(); await cancelledPage.goto(await cancelledLink.getAttribute('href'));
  await page.getByText('已取消本次授权', { exact: true }).first().waitFor({ timeout: 30000 });
  assert.equal((await f.service.status()).state, 'connected'); await cancelledPage.close();
  checks.push('cancelled reauthorization keeps working Host binding and reports cancellation');
  await page.reload();
  await page.getByText('钉钉已连接', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.evaluate(() => window.harness.dispose());
  assert.equal(await page.locator('.dsh-dt').count(), 0);
  assert.deepEqual(browserErrors, []); assert.deepEqual(f.failures, []);
  checks.push('page reload refreshes Host truth; unload removes React views/subscriptions without browser errors');
  const report = { success: true, classification: 'REACT_AND_REAL_HOST_RPC_HARNESS', browser: await browser.version(), checks, limitations: ['Not the assembled DSH Web/Desktop shell', 'Synthetic OAuth/MCP only; no real LLM or enterprise authorization'], screenshots: ['browser/connected-light.png', 'browser/connected-dark-mobile.png'] };
  await writeFile('artifacts/p0-browser-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await cleanup(); server.closeAllConnections(); await new Promise(r => server.close(r)); await f.dispose(); }
