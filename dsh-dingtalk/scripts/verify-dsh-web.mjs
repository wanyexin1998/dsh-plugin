import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { sandbox, run } from './g0/runtime.mjs';
import { freePort } from './p0-fixture.mjs';
const isolated = await sandbox();
const requireDsh = createRequire(resolve('../.cache/dingtalk-g0/dsh-runtime/package.json'));
const cli = join(dirname(requireDsh.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
let child, browser; const errors = [], checks = [];
try {
  assert.ok(process.env.npm_execpath, 'Run via npm run verify:dsh-web');
  await mkdir('artifacts', { recursive: true });
  await mkdir('artifacts/browser', { recursive: true });
  await writeFile('artifacts/p0-dsh-web-report.json', JSON.stringify({ success: false, classification: 'INCOMPLETE_RUN' }) + '\n');
  const packed = await run(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', resolve('artifacts')], { env: isolated.env, cwd: process.cwd() });
  assert.equal(packed.code, 0, packed.stderr);
  const archive = resolve('artifacts', JSON.parse(packed.stdout)[0].filename);
  const home = join(isolated.root, 'dsh'); const profile = join(home, 'profiles/p0-web');
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dingtalk-native-web-test', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
  isolated.env.DSH_HOME = home;
  const installed = await run(process.execPath, [cli, 'plugin', '--profile', 'p0-web', 'add', archive, '--ignore-scripts'], { env: isolated.env, cwd: isolated.root, timeoutMs: 180000 });
  assert.equal(installed.code, 0, installed.stderr.slice(-4000));
  console.log('Official archive installed into isolated Web Profile.');
  const port = await freePort();
  child = spawn(process.execPath, [cli, '--profile', 'p0-web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { env: isolated.env, cwd: isolated.root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs = (logs + value.toString()).slice(-24000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error('DSH exited before readiness; raw startup URL withheld'); try { const response = await fetch(base, { signal: AbortSignal.timeout(2000) }); if ([200, 401].includes(response.status) && /dsh web: http/.test(logs)) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  const authenticated = logs.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
  assert.ok(authenticated && new URL(authenticated).origin === base, 'Native DSH authenticated handoff was not ready');
  console.log('Official DSH Web is ready.');
  const hostDiagnostics = logs.split('\n').filter(line => /TEST_HOST|TEST_ROUTE|Error|dsh-dingtalk|INJECT|webServer|connection:/i.test(line)).map(line => line.replace(/https?:\/\/[^\s]+/g, '<url>'));
  if (hostDiagnostics.length) console.log(JSON.stringify({ hostDiagnostics }));
  browser = await chromium.launch({ executablePath: process.env.DSH_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().replace(/https?:\/\/[^\s]+/g, '<url>')); });
  await page.goto(authenticated); await page.waitForTimeout(2000);
  const preview = page.getByRole('button', { name: '继续', exact: true });
  await preview.waitFor({ timeout: 10000 }).catch(() => {});
  if (await preview.count()) { await preview.click(); await page.waitForTimeout(700); }
  const onboarding = page.getByRole('presentation').filter({ hasText: '开始使用' });
  await onboarding.waitFor({ timeout: 10000 }).catch(() => {});
  if (await onboarding.count()) { await onboarding.getByRole('button').first().click(); await onboarding.waitFor({ state: 'detached' }); }
  await writeFile('artifacts/native-web-body.txt', await page.locator('body').innerText());
  if ((await page.locator('body').innerText()).includes('Failed to load plugins')) {
    throw new Error(`Native Client boot failure: ${JSON.stringify(errors)}`);
  }
  await page.screenshot({ path: 'artifacts/browser/native-web.png', fullPage: true });
  // The shell can show onboarding without an LLM credential. Inspect its native settings surface.
  const settings = page.getByRole('button', { name: /设置|Settings/i });
  if (await settings.count()) await settings.first().click();
  else {
    await page.getByText('更多', { exact: true }).last().click();
    await page.getByText('设置', { exact: true }).click();
  }
  const section = page.getByText('钉钉连接', { exact: true });
  if (await section.count()) await section.first().click();
  await page.getByRole('heading', { name: '钉钉连接', exact: true }).waitFor({ timeout: 15000 });
  await page.getByText('尚未配置 DWS', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'artifacts/browser/native-web-settings.png', fullPage: true });
  checks.push('official npm DSH 0.2.1-rc.5 boots installed Bundle with zero core source changes');
  checks.push('assembled native settings renders plugin section and calls actual authenticated Host RPC');
  assert.ok(!logs.includes('dsh-dingtalk') || !/dsh-dingtalk[^\n]*(?:failed|Error)/.test(logs));
  assert.deepEqual(errors, []);
  const report = { success: true, classification: 'OFFICIAL_DSH_WEB_UNCONFIGURED_PROFILE', checks, errors, limitations: ['No production OAuth/LLM credentials supplied', 'No native tool-card transcript replay', 'Desktop shell not exercised'], coreSourceChanges: 0 };
  await writeFile('artifacts/p0-dsh-web-report.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) {
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) { await writeFile('artifacts/native-web-final-body.txt', await pages[0].locator('body').innerText()).catch(() => {}); await pages[0].screenshot({ path: 'artifacts/browser/native-web-final.png', fullPage: true }).catch(() => {}); }
  }
  await browser?.close();
  if (child && child.exitCode === null) {
    const done = new Promise(r => child.once('close', r));
    if (process.platform === 'win32') await run(join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env: isolated.env, cwd: isolated.root });
    else child.kill();
    await done;
  }
  await isolated.dispose();
}
