import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const executablePath = process.env.DSH_TEST_BROWSER || ['/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);

test('robot UI uses independent mocked RPCs with shared presentation and guarded async updates', { skip: !executablePath && 'Set DSH_TEST_BROWSER to run the React browser regression' }, async t => {
  const source = `import React from 'react';import{createRoot}from'react-dom/client';import{RelaySection}from'./src/client/relay.ts';import{connectionCss}from'./src/client/styles.ts';
const h=window.harness={state:{mode:'enterprise',displayName:'测试机器人',configured:true,status:'disconnected'},calls:[],pending:[],readMode:'normal',actionMode:'normal',actionError:'auth_required',popups:[],language:'zh'};
window.open=()=>{const popup={closed:false,opener:null,document:{open(){},write(){},close(){}},location:{replace(url){popup.url=url;}},close(){this.closed=true;}};h.popups.push(popup);return popup;};
const store={get(){throw Error('Robot UI must not infer state from DWS authorization');},relay(method,payload={}){h.calls.push({method,payload});
if(method==='status'){if(h.readMode==='hold')return new Promise((resolve,reject)=>h.pending.push({resolve,reject}));if(h.readMode==='fail')return Promise.reject(Error('offline'));return Promise.resolve({...h.state});}
const complete=()=>{if(h.actionMode==='fail')throw Object.assign(Error('denied'),{reasonCode:h.actionError});
if(method==='configure')h.state={...h.state,configured:true,hosting:true,status:'disconnected',callbackUrl:'http://127.0.0.1:19878/relay/callback'};
if(method==='connect')h.state={...h.state,status:'authorizing',authorizeUrl:location.origin+'/mock-authorization'};
if(method==='disconnect')h.state={...h.state,status:'disconnected',authorizeUrl:undefined};
if(method==='stop')h.state={...h.state,status:'disconnected',hosting:false,authorizeUrl:undefined};
return method==='disconnect'?{status:'disconnected'}:{...h.state};};
if(h.actionMode==='hold')return new Promise((resolve,reject)=>{h.finishAction=()=>{try{resolve(complete());}catch(error){reject(error);}};});return Promise.resolve().then(complete);}};
const root=createRoot(document.getElementById('app'));h.render=()=>root.render(React.createElement('main',{className:'dsh-dt'},React.createElement('style',null,connectionCss),React.createElement(RelaySection,{store,language:h.language})));h.hide=()=>root.render(null);h.render();`;
  const result = await build({ stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'relay-test.ts' }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  const server = createServer((req, res) => { if (req.url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(result.outputFiles[0].text); } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta name="viewport" content="width=device-width"><style>html{color-scheme:light dark}body{margin:16px;background:Canvas;color:CanvasText;font:14px system-ui}</style><div id="app"></div><script src="/app.js"></script>'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = () => page.locator('.dsh-dt-strip [role="status"]');
  const refresh = () => page.getByRole('button', { name: '刷新机器人状态', exact: true }).click();
  const waitStatus = expected => status().filter({ hasText: expected }).waitFor();
  const load = async state => { await page.goto(url); await waitStatus('未连接'); if (state) { await page.evaluate(state => { window.harness.state = state; }, state); await refresh(); } };

  await t.test('enterprise states are independent, status failures retain history and success clears the notice', async () => {
    await load();
    assert.equal(await page.locator('input').count(), 0);
    for (const [state, label] of [['connected', '已连接'], ['offline', '离线 · 正在重连'], ['failed', '连接未完成'], ['auth_required', '请重新授权'], ['authorizing', '等待登录确认'], ['disconnected', '未连接']]) {
      await page.evaluate(state => { window.harness.state.status = state; }, state); await refresh(); await waitStatus(label);
    }
    await page.evaluate(() => { window.harness.state.status = 'connected'; }); await refresh(); await waitStatus('已连接');
    const button = page.getByRole('button', { name: '刷新机器人状态', exact: true });
    const stable = await page.locator('.dsh-dt-robot').boundingBox();
    await page.evaluate(() => { window.harness.readMode = 'hold'; });
    await page.waitForFunction(() => window.harness.pending.length > 0);
    assert.equal(await button.getAttribute('aria-busy'), 'false');
    assert.deepEqual(await page.locator('.dsh-dt-robot').boundingBox(), stable);
    await refresh();
    assert.equal(await button.getAttribute('aria-busy'), 'true');
    assert.deepEqual(await page.locator('.dsh-dt-robot').boundingBox(), stable);
    assert.match(await status().innerText(), /已连接/);
    await page.evaluate(() => { window.harness.readMode = 'fail'; window.harness.pending.shift().reject(Error('offline')); });
    await page.getByRole('alert').filter({ hasText: '机器人状态读取失败' }).waitFor();
    assert.match(await status().innerText(), /上次确认：已连接/);
    assert.equal(await page.locator('.dsh-dt-strip').getAttribute('data-tone'), 'warning');
    await page.evaluate(() => { window.harness.readMode = 'normal'; window.harness.state.status = 'disconnected'; }); await refresh(); await waitStatus('未连接');
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.locator('.dsh-dt-strip').getAttribute('data-tone'), null);
  });

  await t.test('initial delayed status never enables connection; first failure offers retry', async () => {
    await load(); await page.evaluate(() => window.harness.hide()); await page.locator('section').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.harness.readMode = 'hold'; window.harness.render(); }); await waitStatus('检查中');
    assert.equal(await page.getByRole('button', { name: '连接', exact: true }).count(), 0);
    await page.evaluate(() => { window.harness.readMode = 'fail'; window.harness.pending.shift().reject(Error('offline')); }); await waitStatus('状态未知');
    await page.getByRole('alert').filter({ hasText: '暂时无法读取机器人状态' }).waitFor();
    await page.evaluate(() => { window.harness.readMode = 'normal'; }); await refresh(); await waitStatus('未连接');
  });

  await t.test('older reads cannot undo disconnect, duplicate actions are ignored, and cancel retains enterprise mode', async () => {
    await load({ mode: 'enterprise', displayName: '测试机器人', configured: true, status: 'connected' }); await waitStatus('已连接');
    await page.evaluate(() => { window.harness.readMode = 'hold'; }); await refresh();
    await page.getByRole('button', { name: '断开机器人', exact: true }).click(); await waitStatus('未连接');
    await page.evaluate(() => { const h = window.harness; h.readMode = 'normal'; h.pending.shift().resolve({ mode: 'enterprise', status: 'connected' }); });
    await page.waitForTimeout(30); assert.match(await status().innerText(), /未连接/);
    await page.evaluate(() => { window.harness.actionMode = 'hold'; document.querySelector('button[aria-label="连接"]').click(); document.querySelector('button[aria-label="连接"]').click(); });
    assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.method === 'connect').length), 1);
    assert.equal(await page.getByRole('button', { name: '连接', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.harness.actionMode = 'normal'; window.harness.finishAction(); }); await waitStatus('等待登录确认');
    assert.equal(await page.getByRole('link', { name: '继续登录', exact: true }).getAttribute('rel'), 'noopener noreferrer');
    await page.getByRole('button', { name: '取消登录', exact: true }).click(); await waitStatus('未连接');
    assert.equal(await page.locator('input').count(), 0); assert.equal(await page.getByRole('link', { name: '继续登录', exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.harness.calls.find(call => call.method === 'connect').payload), {});
    assert.equal(await page.evaluate(() => window.harness.popups.every(popup => popup.closed)), true);
  });

  await t.test('hung reads and actions time out without replaying mutations or accepting late results', async () => {
    await load(); await page.clock.install();
    await page.evaluate(() => { window.harness.readMode = 'hold'; }); await refresh();
    await page.clock.fastForward(16000);
    await page.getByRole('alert').filter({ hasText: '机器人状态读取失败' }).waitFor();
    assert.equal(await page.evaluate(() => window.harness.pending.length), 1, 'periodic polls share the outstanding read');
    await page.evaluate(() => { window.harness.readMode = 'normal'; }); await refresh(); await waitStatus('未连接');
    await page.evaluate(() => { window.harness.pending.shift().resolve({ mode: 'enterprise', status: 'connected' }); });
    assert.match(await status().innerText(), /未连接/);
    await page.evaluate(() => { window.harness.actionMode = 'hold'; window.harness.readMode = 'fail'; });
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.clock.fastForward(31000);
    await page.getByRole('alert').filter({ hasText: '机器人操作结果尚未确认' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '连接', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '刷新机器人状态', exact: true }).isDisabled(), false);
    assert.equal(await page.evaluate(() => window.harness.calls.filter(call => call.method === 'connect').length), 1);
    await page.evaluate(() => { window.harness.actionMode = 'normal'; window.harness.finishAction(); });
    assert.match(await status().innerText(), /未连接/, 'late mutation response cannot directly update the UI');
    await page.evaluate(() => { window.harness.readMode = 'normal'; }); await refresh(); await waitStatus('等待登录确认');
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('button', { name: '取消登录', exact: true }).isDisabled(), false);
    await page.clock.resume();
  });

  await t.test('personal configuration, secret clearing, authorization errors and stop hosting remain available', async () => {
    await load({ mode: 'personal', displayName: '测试个人机器人', configured: false, status: 'unconfigured' }); await waitStatus('未配置');
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByLabel('Client ID', { exact: true }).fill('  synthetic-app  '); await page.getByLabel('Client Secret', { exact: true }).fill('synthetic-secret');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await page.getByText('http://127.0.0.1:19878/relay/callback', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Client Secret', { exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.harness.calls.find(call => call.method === 'configure').payload), { clientId: 'synthetic-app', clientSecret: 'synthetic-secret' });
    await page.evaluate(() => { window.harness.actionMode = 'fail'; }); await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '请重新连接机器人，按提示完成应用登录与设备配对。' }).waitFor(); assert.match(await status().innerText(), /未连接/);
    await page.evaluate(() => { window.harness.actionMode = 'normal'; }); await page.getByRole('button', { name: '停止托管', exact: true }).click();
    await page.getByRole('button', { name: '配置', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '停止托管', exact: true }).count(), 0);
    await page.getByRole('button', { name: '配置', exact: true }).click(); assert.equal(await page.getByLabel('Client Secret', { exact: true }).inputValue(), '');
    await page.getByLabel('Client Secret', { exact: true }).fill('discarded-secret'); await page.getByRole('button', { name: '取消配置', exact: true }).click();
    await page.getByRole('button', { name: '配置', exact: true }).click(); assert.equal(await page.getByLabel('Client Secret', { exact: true }).inputValue(), '');
  });

  await t.test('configured personal status explains robot pairing independently from DWS data authorization', async () => {
    const help = '机器人通过应用登录与此设备配对。钉钉数据授权在上方单独管理。';
    for (const [state, label] of [['disconnected', '未连接'], ['offline', '离线 · 正在重连'], ['auth_required', '请重新登录机器人']]) {
      await load({ mode: 'personal', displayName: '测试个人机器人', configured: true, hosting: true, status: state }); await waitStatus(label);
      await page.getByText(help, { exact: true }).waitFor();
      assert.doesNotMatch(await page.locator('.dsh-dt-robot').innerText(), /请先完成上方|先在上方完成 DWS|首次配置需/);
      assert.equal(await page.getByRole('button', { name: '连接', exact: true }).isDisabled(), false);
    }
    await page.getByRole('button', { name: '连接', exact: true }).click(); await waitStatus('等待登录确认');
    await page.locator('.dsh-dt-notice').filter({ hasText: '请在机器人应用登录页确认账号与此设备的配对。' }).waitFor();
    assert.equal(await page.getByRole('link', { name: '继续登录', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.harness.calls.find(call => call.method === 'connect').payload), {});
  });

  await t.test('only missing first-configuration enterprise context requests DWS discovery; personal pairing errors do not', async () => {
    const firstSetup = '首次配置需确认企业信息；尚无企业信息时，请先在上方完成 DWS 授权。配置后连接机器人并按提示完成设备配对。';
    const reconnect = '请重新连接机器人，按提示完成应用登录与设备配对。';
    for (const configured of [false, true]) {
      await load({ mode: 'personal', displayName: '测试个人机器人', configured, hosting: false, status: configured ? 'disconnected' : 'unconfigured' });
      await waitStatus(configured ? '未连接' : '未配置');
      assert.equal(await page.getByText(firstSetup, { exact: true }).count(), configured ? 0 : 1);
      await page.getByRole('button', { name: '配置', exact: true }).click();
      await page.getByLabel('Client ID', { exact: true }).fill('synthetic-app'); await page.getByLabel('Client Secret', { exact: true }).fill('synthetic-secret');
      await page.evaluate(() => { window.harness.actionMode = 'fail'; });
      await page.getByRole('button', { name: '下一步', exact: true }).click();
      const alert = page.getByRole('alert'); await alert.waitFor();
      assert.equal(await alert.innerText(), configured ? reconnect : firstSetup);
      if (configured) assert.doesNotMatch(await page.locator('.dsh-dt-robot').innerText(), /先在上方完成 DWS|首次配置需/);
    }
    await load({ mode: 'personal', configured: true, hosting: true, status: 'disconnected' }); await waitStatus('未连接');
    await page.evaluate(() => { window.harness.actionMode = 'fail'; window.harness.actionError = 'identity_mismatch'; });
    await page.getByRole('button', { name: '连接', exact: true }).click();
    const mismatch = page.getByRole('alert'); await mismatch.waitFor();
    assert.equal(await mismatch.innerText(), '请使用此机器人所属企业的账号完成配对。');
    assert.doesNotMatch(await mismatch.innerText(), /DWS|上方/);
  });

  await t.test('enterprise and legacy authentication and identity guidance keep their existing DWS boundary', async () => {
    for (const state of [{ mode: 'enterprise', configured: true, status: 'auth_required' }, { status: 'auth_required', url: 'ws://gateway.example/relay' }]) {
      await load(state); await waitStatus('请重新授权');
      for (const [code, message] of [['auth_required', '请先完成上方钉钉账号授权。'], ['identity_mismatch', '请使用与当前 DWS 相同的企业账号。']]) {
        await page.evaluate(code => { window.harness.actionMode = 'fail'; window.harness.actionError = code; }, code);
        await page.getByRole('button', { name: '连接', exact: true }).click();
        const alert = page.getByRole('alert'); await alert.filter({ hasText: message }).waitFor();
        assert.equal(await alert.innerText(), message);
      }
      assert.equal(await page.getByText('机器人通过应用登录与此设备配对。钉钉数据授权在上方单独管理。', { exact: true }).count(), 0);
    }
  });

  await t.test('personal setup, pairing status and action guidance are localized in English', async () => {
    for (const configured of [false, true]) {
      await load({ mode: 'personal', displayName: 'Synthetic robot', configured, hosting: false, status: configured ? 'auth_required' : 'unconfigured' });
      await waitStatus(configured ? '请重新登录机器人' : '未配置');
      await page.evaluate(() => { window.harness.language = 'en'; window.harness.render(); });
      await page.getByRole('button', { name: 'Configure', exact: true }).waitFor();
      const section = page.locator('.dsh-dt-robot');
      const content = await section.innerText();
      assert.doesNotMatch(content, /[\u3400-\u9fff]/);
      assert.match(content, /pair/i);
      if (!configured) { assert.match(content, /DWS/); assert.match(content, /enterprise|organization/i); }
      else { assert.match(await status().innerText(), /robot/i); assert.doesNotMatch(content, /complete.*DWS.*first/i); }
      await page.getByRole('button', { name: 'Configure', exact: true }).click();
      await page.getByLabel('Client ID', { exact: true }).fill('synthetic-app'); await page.getByLabel('Client Secret', { exact: true }).fill('synthetic-secret');
      await page.evaluate(() => { window.harness.actionMode = 'fail'; }); await page.getByRole('button', { name: 'Next', exact: true }).click();
      const alert = page.getByRole('alert'); await alert.waitFor();
      assert.doesNotMatch(await alert.innerText(), /[\u3400-\u9fff]/); assert.match(await alert.innerText(), /pair/i);
      if (!configured) assert.match(await alert.innerText(), /DWS/); else assert.doesNotMatch(await alert.innerText(), /DWS/);
    }
    await page.getByRole('button', { name: 'Cancel configuration', exact: true }).click();
    await page.evaluate(() => { window.harness.actionError = 'identity_mismatch'; }); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /enterprise|organization/i }).waitFor();
    assert.doesNotMatch(await page.getByRole('alert').innerText(), /[\u3400-\u9fff]|DWS/);
    await page.evaluate(() => { window.harness.actionMode = 'normal'; }); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('link', { name: 'Continue sign-in', exact: true }).waitFor();
    assert.match(await page.locator('.dsh-dt-robot .dsh-dt-notice').last().innerText(), /pair/i);
    assert.doesNotMatch(await page.locator('.dsh-dt-robot').innerText(), /[\u3400-\u9fff]/);
  });

  await t.test('legacy gateway input, unmount cleanup and narrow themed keyboard controls work', async () => {
    await load({ status: 'disconnected', url: 'ws://gateway.example/relay' }); await waitStatus('未连接');
    assert.equal(await page.getByLabel('网关地址', { exact: true }).inputValue(), 'ws://gateway.example/relay');
    await page.getByRole('button', { name: '连接', exact: true }).click(); await waitStatus('等待登录确认');
    assert.deepEqual(await page.evaluate(() => window.harness.calls.find(call => call.method === 'connect').payload), { url: 'ws://gateway.example/relay' });
    await page.getByRole('button', { name: '取消登录', exact: true }).click(); await waitStatus('未连接');
    await page.setViewportSize({ width: 360, height: 700 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '连接', exact: true }).focus(); assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '连接');
    }
    await page.evaluate(() => { window.harness.readMode = 'hold'; }); await refresh();
    const callsBeforeUnmount = await page.evaluate(() => { window.harness.hide(); return window.harness.calls.length; }); await page.locator('section').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.harness.pending.shift().resolve({ status: 'connected' }); }); await page.waitForTimeout(1600);
    assert.equal(await page.evaluate(() => window.harness.calls.length), callsBeforeUnmount);
    await page.evaluate(() => { window.harness.readMode = 'normal'; window.harness.render(); }); await waitStatus('未连接');
  });
  assert.deepEqual(errors, []);
});
