import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Actual production React components and ConnectionStore, synthetic RPC only.
// The harness never reads local credentials or calls a DingTalk/Connector service.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(root, 'docs/evidence/connection-status-ui');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionSection, ToolView } from './src/client/index.ts';
import { ConnectionStore } from './src/client/store.ts';
const clone = value => JSON.parse(JSON.stringify(value));
const connected = {state:'connected',account:{displayName:'演示用户',organizationName:'示例企业'},checkedAt:'2026-11-05T10:00:00.000Z'};
let dws = clone(connected), transaction = false;
let robot = {mode:'personal',displayName:'演示机器人',configured:false,hosting:false,status:'unconfigured'};
let robotConnectPending = false, robotFailure = false;
let gate;
const hold = () => {let release; const promise = new Promise(resolve => {release=resolve}); gate={promise,release};};
hold();
const calls = [];
const rpc = {async call(_channel, endpoint, payload, signal) {
  const method = endpoint.split('/').at(-1);
  // Payload values are intentionally excluded from evidence and diagnostics.
  calls.push({method,keys:Object.keys(payload || {}).filter(key => key !== 'browserId')});
  let value;
  if (method === 'bootstrap') value={browserId:'synthetic-browser',callbackOrigin:location.origin};
  else if (method === 'status') {
    const captured = clone(dws), waiting = gate;
    if (waiting) {
      const outcome = await waiting.promise;
      if (outcome.error) return {ok:false,error:{code:outcome.error}};
      value=outcome.status || captured;
    } else value=captured;
  }
  else if (method === 'prepare-start' || method === 'prepare-status') value={state:'ready'};
  else if (method === 'prepare-cancel') value={state:'cancelled'};
  else if (method === 'callback-origin') value={callbackOrigin:location.origin};
  else if (method === 'begin') { transaction=true; value={transactionId:'synthetic-transaction-000000000001',authorizeUrl:location.origin+'/dsh-dingtalk/start',expiresAt:new Date(Date.now()+120000).toISOString()}; }
  else if (method === 'transaction') value=transaction?{state:'authorizing',reasonCode:'authorization_pending'}:clone(dws);
  else if (method === 'cancel') {transaction=false; value={cancelled:true};}
  else if (method === 'disconnect-preview') value={confirmation:'synthetic-confirmation'};
  else if (method === 'disconnect-confirm') {dws={state:'unlinked',reasonCode:'not_connected'}; transaction=false; value={disconnected:true};}
  else if (method === 'relay-status') {if(robotFailure)return {ok:false,error:{code:'service_unavailable'}};value=clone(robot);}
  else if (method === 'relay-configure') {robot={...robot,configured:true,hosting:true,status:'disconnected',callbackUrl:'http://127.0.0.1:19878/relay/callback'};value=clone(robot);}
  else if (method === 'relay-connect') {robot={...robot,status:robotConnectPending?'authorizing':'connected',...(robotConnectPending?{authorizeUrl:location.origin+'/synthetic-robot-auth'}:{})};value=clone(robot);}
  else if (method === 'relay-disconnect') {robot={...robot,status:'disconnected'};delete robot.authorizeUrl;value=clone(robot);}
  else if (method === 'relay-stop') {robot={...robot,status:'disconnected',hosting:false};delete robot.authorizeUrl;value=clone(robot);}
  else throw new Error('Unexpected synthetic RPC '+method);
  return {ok:true,value};
}};
const store = new ConnectionStore({rpc});
const reactRoot = createRoot(document.getElementById('app'));
const render = () => reactRoot.render(React.createElement('main',null,
  React.createElement('p',{className:'evidence-caption'},'本地模拟验收 · 所有账号与机器人均为示例'),
  React.createElement(ConnectionSection,{store}),
  React.createElement('div',{id:'compact'},React.createElement(ConnectionSection,{store,compact:true})),
  React.createElement('div',{id:'tools'},React.createElement(ToolView,{store,phase:'result',callId:'synthetic-call',block:{content:[{type:'text',text:JSON.stringify({status:'ok',data:{internal:'must-not-render'}})}]}}))));
window.harness={store,calls,hold,connected,
 release(outcome={}){const waiting=gate;gate=undefined;waiting?.release(outcome);},
 setDws(value){dws=clone(value);},
 setRobot(value){robot=clone(value);},
 robotConnectPending(value){robotConnectPending=value;},
 robotFailure(value){robotFailure=value;},
 dispose(){reactRoot.unmount();store.dispose();},
};
render();
`;
const compiled = await build({
  stdin: { contents: source, resolveDir: root, sourcefile: 'connection-status-browser.ts' },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(compiled.outputFiles[0].text);
  } else if (req.url === '/dsh-dingtalk/start' || req.url === '/synthetic-robot-auth') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><p>本地模拟授权页；未连接外部服务。</p>');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width"><title>连接状态本地模拟验收</title><style>html{color-scheme:light dark}body{font:14px system-ui;margin:16px;background:Canvas;color:CanvasText}main{max-width:640px;margin:auto}.evidence-caption{font-size:11px;opacity:.65;margin:0 20px}#compact,#tools{max-width:534px;margin:auto}#tools{margin-top:12px}</style><div id="app"></div><script src="/app.js"></script></html>');
  }
});
let browser;
const checks = [], screenshots = [], browserErrors = [], unexpectedRequests = [];
const shot = async (page, name) => {
  await page.screenshot({ path: resolve(evidence, name), fullPage: true });
  screenshots.push(name);
};
const count = (page, method) => page.evaluate(name => window.harness.calls.filter(call => call.method === name).length, method);
const waitCount = (page, method, minimum) => page.waitForFunction(({ method, minimum }) => window.harness.calls.filter(call => call.method === method).length >= minimum, { method, minimum });
const flushRobot = async page => { await page.clock.runFor(1600); };
const assertFits = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal page overflow');
try {
  await mkdir(evidence, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER || '/usr/bin/chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, colorScheme: 'light' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) { unexpectedRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.clock.install({ time: new Date('2026-11-05T10:01:00.000Z') });
  await page.goto(base);
  await waitCount(page, 'status', 1);
  await page.getByText('检查中', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '连接钉钉', exact: true }).count(), 0);
  assert.equal(await count(page, 'begin'), 0);
  assert.equal(await count(page, 'prepare-start'), 0);
  assert.ok((await page.locator('[aria-busy="true"]').count()) >= 1);
  await shot(page, 'initial-check-light.png');
  checks.push('Slow first status read shows checking in settings and compact card, aria-busy, no reconnect/OAuth action.');

  // Host status RPCs can succeed at the transport layer while failing to establish
  // connection truth. This is the actual local/Connector status envelope contract.
  await page.evaluate(() => window.harness.release({ status: { state: 'unknown', reasonCode: 'backend_not_ready' } }));
  await page.waitForFunction(() => window.harness.store.get().refreshError === 'backend_not_ready');
  assert.equal(await page.getByRole('button', { name: '连接钉钉', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.harness.store.get().checkedAt), undefined);
  await page.getByText('连接状态读取失败', { exact: true }).first().waitFor();
  await page.evaluate(() => window.harness.hold());
  await page.getByRole('button', { name: '刷新状态', exact: true }).first().click();
  await page.waitForFunction(() => window.harness.store.get().refreshing);
  await page.evaluate(() => window.harness.release({ error: 'service_unavailable' }));
  await page.waitForFunction(() => window.harness.store.get().refreshError === 'service_unavailable');
  assert.equal(await page.getByRole('button', { name: '连接钉钉', exact: true }).count(), 0);
  await page.getByRole('button', { name: '刷新状态', exact: true }).first().click();
  await page.locator('.dsh-dt-account').waitFor();
  await page.getByText('演示用户', { exact: true }).waitFor();
  assert.equal(await page.locator('#tools button').count(), 0);
  assert.equal(await page.getByText('must-not-render').count(), 0);
  checks.push('First ok:true unknown/backend_not_ready status and failed RPC both offer retry without reconnect or a confirmation time; recovery restores account and ToolView keeps quiet feedback.');

  await page.evaluate(() => { window.accountNode = document.querySelector('.dsh-dt-account'); window.harness.hold(); });
  let before = await count(page, 'status');
  await page.getByRole('button', { name: '刷新状态', exact: true }).first().click();
  await waitCount(page, 'status', before + 1);
  await page.waitForFunction(() => window.harness.store.get().refreshing);
  assert.equal(await page.evaluate(() => document.querySelector('.dsh-dt-account') === window.accountNode), true);
  await page.evaluate(() => window.harness.release({ error: 'execution_timeout' }));
  await page.waitForFunction(() => window.harness.store.get().refreshError === 'execution_timeout');
  assert.equal(await page.evaluate(() => document.querySelector('.dsh-dt-account') === window.accountNode), true);
  assert.equal(await page.getByText('演示用户', { exact: true }).count(), 1);
  assert.match(await page.locator('.dsh-dt').innerText(), /上次|待更新|读取失败/);
  await shot(page, 'stale-connected-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 360, height: 900 });
  await assertFits(page);
  await shot(page, 'stale-connected-dark-mobile.png');
  const lastConfirmed = await page.evaluate(() => window.harness.store.get().checkedAt);
  for (const reasonCode of ['service_unavailable', 'backend_not_ready']) {
    await page.evaluate(async reasonCode => {
      // A newer checkedAt from an inconclusive response must not renew the old
      // account's confirmation time or present stale connected as newly verified.
      window.harness.setDws({ state: 'unknown', reasonCode, checkedAt: '2026-11-05T10:01:30.000Z' });
      await window.harness.store.refresh();
    }, reasonCode);
    await page.waitForFunction(reasonCode => window.harness.store.get().refreshError === reasonCode, reasonCode);
    assert.equal(await page.evaluate(() => document.querySelector('.dsh-dt-account') === window.accountNode), true);
    assert.equal(await page.evaluate(() => window.harness.store.get().status.state), 'connected');
    assert.equal(await page.evaluate(() => window.harness.store.get().checkedAt), lastConfirmed);
    assert.equal(await page.getByText('演示用户', { exact: true }).count(), 1);
    await page.getByText('读取失败 · 状态待更新，请重试。', { exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '连接钉钉', exact: true }).count(), 0);
  }
  await shot(page, 'unknown-envelope-dark-mobile.png');
  checks.push('Actual Host contract envelope shape (mocked RPC) ok:true with unknown/service_unavailable or unknown/backend_not_ready preserves the prior account DOM, connected state and confirmed time while exposing refreshError; no reconnect is offered.');
  await page.evaluate(() => window.harness.setDws({ ...window.harness.connected, checkedAt: '2026-11-05T10:02:00.000Z' }));
  await page.getByRole('button', { name: '刷新状态', exact: true }).first().click();
  await page.waitForFunction(() => !window.harness.store.get().refreshError && !window.harness.store.get().refreshing);
  assert.equal(await page.evaluate(() => window.harness.store.get().checkedAt), '2026-11-05T10:02:00.000Z');
  checks.push('Manual refresh and a simulated timeout result retain the same account DOM; stale/error notice is visible, recovery clears it and updates last-confirmed time; dark 360px layout fits.');

  await page.evaluate(() => window.harness.hold());
  before = await count(page, 'status');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitCount(page, 'status', before + 1);
  assert.equal(await page.locator('.dsh-dt-account').count(), 1);
  await page.evaluate(() => window.harness.release());
  await page.waitForFunction(() => !window.harness.store.get().refreshing);
  before = await count(page, 'status');
  await page.evaluate(() => window.harness.hold());
  await page.clock.runFor(15100);
  await waitCount(page, 'status', before + 1);
  assert.equal(await page.locator('.dsh-dt-account').count(), 1);
  await page.evaluate(() => window.harness.release());
  await page.waitForFunction(() => !window.harness.store.get().refreshing);
  checks.push('Window focus and the 15-second scheduled refresh retain the connected account while reads are pending.');

  for (const [status, expected] of [
    [{ state: 'reauth_required', reasonCode: 'authorization_expired' }, '授权已失效'],
    [{ state: 'identity_mismatch', reasonCode: 'identity_mismatch' }, '授权账号不一致'],
    [{ state: 'org_cli_disabled', reasonCode: 'org_cli_disabled' }, '企业尚未开通 CLI 权限'],
    [{ state: 'app_permission_denied', reasonCode: 'app_permission_denied' }, '应用权限不足'],
    [{ state: 'unknown', reasonCode: 'revocation_failed' }, '连接已阻断，撤销尚未完成'],
    [{ state: 'unknown', reasonCode: 'org_policy_denied' }, '组织数据权限策略限制'],
    [{ state: 'unlinked', reasonCode: 'not_connected' }, '尚未连接钉钉'],
  ]) {
    await page.evaluate(async () => { window.harness.setDws(window.harness.connected); await window.harness.store.refresh(); });
    await page.locator('.dsh-dt-account').waitFor();
    await page.evaluate(async value => { window.harness.setDws(value); await window.harness.store.refresh(); }, status);
    await page.getByText(expected, { exact: true }).first().waitFor();
    assert.equal(await page.locator('.dsh-dt-account').count(), 0);
    assert.equal(await page.getByText('演示用户', { exact: true }).count(), 0);
  }
  checks.push('Definitive Host results replace a previously connected account immediately for expiry, identity mismatch, enterprise/application permission, unknown/revocation_failed, unknown/org_policy_denied and unlink.');

  const robot = page.locator('.dsh-dt-robot');
  await page.evaluate(() => window.harness.setRobot({ mode: 'enterprise', displayName: '演示企业机器人', configured: true, status: 'connected' }));
  await flushRobot(page);
  await robot.getByText('已连接', { exact: true }).waitFor();
  await page.getByText('尚未连接钉钉', { exact: true }).first().waitFor();
  await page.evaluate(async () => {
    window.harness.setDws(window.harness.connected);
    window.harness.setRobot({ mode: 'enterprise', displayName: '演示企业机器人', configured: true, status: 'offline' });
    await window.harness.store.refresh();
  });
  await flushRobot(page);
  await robot.getByText('离线 · 正在重连', { exact: true }).waitFor();
  await page.locator('.dsh-dt-account').waitFor();
  assert.equal(await count(page, 'begin'), 0);
  checks.push('DWS unlinked / robot connected and DWS connected / robot offline are rendered independently, with no implicit authorization.');

  await page.evaluate(() => window.harness.setRobot({ mode: 'personal', displayName: '演示个人机器人', configured: false, hosting: false, status: 'unconfigured' }));
  await flushRobot(page);
  await robot.getByRole('button', { name: '配置', exact: true }).click();
  const clientId = robot.getByLabel('Client ID', { exact: true });
  const secret = robot.getByLabel('Client Secret', { exact: true });
  await clientId.fill('synthetic-app');
  await secret.fill('synthetic-value');
  const idBox = await clientId.boundingBox(), secretBox = await secret.boundingBox();
  assert.equal(idBox.x, secretBox.x);
  assert.equal(idBox.width, secretBox.width);
  await assertFits(page);
  // Capture no credential value, including synthetic credentials.
  await secret.fill('');
  await shot(page, 'personal-config-dark-mobile.png');
  await secret.fill('synthetic-value');
  await robot.getByRole('button', { name: '下一步', exact: true }).click();
  await robot.getByText('http://127.0.0.1:19878/relay/callback', { exact: true }).waitFor();
  assert.equal(await secret.count(), 0);
  await page.evaluate(() => window.harness.robotConnectPending(true));
  await robot.getByRole('button', { name: '连接', exact: true }).click();
  await robot.getByRole('link', { name: '继续登录', exact: true }).waitFor();
  await robot.getByRole('button', { name: '取消登录', exact: true }).click();
  await robot.getByText('未连接', { exact: true }).waitFor();
  await robot.getByRole('button', { name: '停止托管', exact: true }).click();
  await robot.getByRole('button', { name: '配置', exact: true }).waitFor();
  await robot.getByRole('button', { name: '配置', exact: true }).click();
  assert.equal(await secret.inputValue(), '');
  await robot.getByRole('button', { name: '取消配置', exact: true }).click();
  checks.push('Personal configuration fields align and fit mobile, successful configure clears secret, pending login retains continue/cancel, stop hosting and reconfigure remain available.');

  await page.evaluate(() => {
    window.harness.robotConnectPending(false);
    window.harness.setRobot({ mode: 'enterprise', displayName: '演示企业机器人', configured: true, status: 'disconnected' });
  });
  await flushRobot(page);
  assert.equal(await robot.locator('input').count(), 0);
  await robot.getByRole('button', { name: '连接', exact: true }).click();
  await robot.getByText('已连接', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.harness.calls.filter(call => call.method === 'relay-connect').at(-1).keys), []);
  await page.evaluate(() => window.harness.robotFailure(true));
  await flushRobot(page);
  await robot.getByRole('alert').waitFor();
  await robot.getByRole('status').filter({ hasText: '上次确认：已连接' }).waitFor();
  assert.equal(await page.locator('.dsh-dt-account').count(), 1);
  await page.evaluate(() => window.harness.robotFailure(false));
  await flushRobot(page);
  await robot.getByRole('alert').waitFor({ state: 'detached' });
  checks.push('Enterprise connection sends no configuration fields; robot read error preserves its own last state and recovery clears the error without affecting DWS.');

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.getByRole('button', { name: '连接管理', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '解除连接', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '保留连接');
  assert.equal(await count(page, 'disconnect-confirm'), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '连接管理');
  assert.equal(await page.locator('.dsh-dt-account').count(), 1);
  await shot(page, 'independent-connected-light.png');
  await page.getByRole('button', { name: '连接管理', exact: true }).click();
  await page.getByRole('button', { name: '解除连接', exact: true }).click();
  await page.getByRole('button', { name: '确认解除连接', exact: true }).click();
  await page.getByText('尚未连接钉钉', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.dsh-dt-account').count(), 0);
  await robot.getByText('已连接', { exact: true }).waitFor();
  checks.push('Keyboard activation opens unlink confirmation with safe initial focus; Escape preserves binding and restores focus; confirmed DWS disconnect leaves robot state independent.');

  await page.getByRole('button', { name: '连接钉钉', exact: true }).first().click();
  await page.getByText('等待钉钉授权', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '取消本次授权', exact: true }).first().click();
  await page.waitForFunction(() => !window.harness.store.get().transaction && !window.harness.store.get().pending);
  assert.equal(await page.locator('.dsh-dt-account').count(), 0);
  checks.push('User-started DWS authorization and cancel use the same Store while remaining independent from robot authentication.');

  await page.evaluate(() => window.harness.dispose());
  assert.equal(await page.locator('.dsh-dt').count(), 0);
  const callsAtDispose = await page.evaluate(() => window.harness.calls.length);
  await page.clock.runFor(31000);
  assert.equal(await page.evaluate(() => window.harness.calls.length), callsAtDispose);
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(unexpectedRequests, []);
  checks.push('Unmount/dispose stops status and robot polling; zero browser errors and zero external requests.');
  const report = {
    success: true,
    classification: 'PRODUCTION_REACT_AND_STORE_WITH_SYNTHETIC_RPC',
    browser: await browser.version(),
    command: 'DSH_TEST_BROWSER=/usr/bin/chromium node enhancements/scripts/verify-connection-status-browser.mjs',
    checks,
    screenshots,
    limitations: [
      'Standalone React harness, not the assembled DSH Web/Desktop shell.',
      'RPC, account data, robot configuration and OAuth pages are synthetic; no real DingTalk, Connector, robot or server was contacted.',
      'Unit/Host tests cover callback-origin trust, transaction/source guards and request races separately.',
    ],
  };
  await writeFile(resolve(evidence, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) console.error(JSON.stringify({ status: await page.getByRole('status').evaluateAll(nodes => nodes.map(node => node.innerText)), browserErrors, unexpectedRequests }));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
