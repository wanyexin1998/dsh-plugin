import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {openChromium} from './chromium-probe.mjs';
import {sha256} from './read-asar.mjs';
import {verifyPackageFiles} from './native-package.mjs';
import {checkNativeSessions} from './native-session-check.mjs';

const root = path.resolve(import.meta.dirname, '..');
const executable = 'E:/deepseek-harness/DeepSeek Harness.exe';
const runtime = 'E:/deepseek-harness/resources/app.asar/dsh';

export async function checkBoot(releaseFile, mode = 'enabled', reuseHome) {
  const manifest = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
  const workspace = path.join(root, '.boot-check');
  fs.mkdirSync(workspace, {recursive: true});
  const home = reuseHome ? path.resolve(reuseHome) : fs.mkdtempSync(path.join(workspace, `${mode}-`));
  if(!home.startsWith(workspace+path.sep))throw new Error('Test profile leaves .boot-check');
  const withSplit = ['enabled','restart'].includes(mode);
  const profile = path.join(home, 'profiles', 'desktop');
  fs.mkdirSync(profile, {recursive: true});
  const dependencies = {};
  for (const item of manifest.replacements) {
    if (mode === 'baseline') continue;
    if (mode === 'without-patches' && item.name !== 'dsh-split') continue;
    if (item.files) verifyPackageFiles(item);
    const link = path.join(profile, 'node_modules', item.name);
    fs.mkdirSync(path.dirname(link), {recursive: true});
    if(!fs.existsSync(link))fs.symlinkSync(item.target, link, 'junction');
    else if(path.resolve(fs.readlinkSync(link))!==path.resolve(item.target))throw new Error('Test profile resolves another release');
    dependencies[item.name] = `link:${item.target.replaceAll('\\', '/')}`;
  }
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  if (mode !== 'disabled' && mode !== 'baseline') bundles.push('dsh-split');
  if (withSplit) {
    // This observer exists only in a throwaway profile. It creates empty native
    // sessions and exposes real services to the browser test; no model is called.
    const probe = path.join(profile, 'node_modules', 'dsh-boot-observer');
    fs.mkdirSync(probe, {recursive:true});
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({name:'dsh-boot-observer', type:'module', exports:{'.':'./index.js','./client':'./client.js'}, dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web'}}}));
    fs.writeFileSync(path.join(probe, 'index.js'), 'export function apply() {}\n');
    fs.writeFileSync(path.join(probe, 'cordis.patch.yml'), '- insert:\n    - id: boot-observer\n      name: dsh-boot-observer\n');
    fs.writeFileSync(path.join(probe, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-boot-observer',factory:()=>({inject:['sessions','workspaces','uiWorkspace','uiConversation','layout','slots','theme'],apply(ctx){globalThis.__splitProbe=ctx;ctx.effect(()=>()=>{delete globalThis.__splitProbe;});}})});`);
    dependencies['dsh-boot-observer'] = 'file:node_modules/dsh-boot-observer';
    bundles.push('dsh-boot-observer');
  }
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({name: 'dsh-boot-check', private: true, dependencies, dsh: {profile: {bundles}}}, null, 2));
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  const portPath=path.join(home,'server-port.json');
  let port;
  if(reuseHome)port=JSON.parse(fs.readFileSync(portPath,'utf8'));
  else {
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    fs.writeFileSync(portPath,JSON.stringify(port));
  }
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), `- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${port}\n`);
  const child = spawn(executable, ['--expose-internals', `${runtime}/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`, runtime, profile, 'E:/deepseek-harness/resources/runtime/primary-runtime'], {
    cwd: profile, windowsHide: true, env: {...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const log = fs.createWriteStream(path.join(home, 'host.log'));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => log.write(String(data).replace(/([?&]token=)[^\s]+/g, '$1[redacted]')));
  let browser;
  const result = {mode, home, releaseSha256: sha256(fs.readFileSync(releaseFile)), passed: false};
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native desktop host boot timeout')), 45_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timeout); resolve(message); }
        else if (message.type === 'fatal') { clearTimeout(timeout); reject(new Error(message.diagnostic ?? message.message)); }
      });
      child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Native desktop host exited: ${code}`)); });
    });
    const boot = ready.injections.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__').value;
    result.hostEntries = boot.entries.map(entry => entry.id);
    // ui-schedule is opt-in and has no row in the shipped web-app bundle.
    result.missingEntries = manifest.replacements.filter(item => item.name !== '@deepseek-ai/dsh-client-ui-schedule' && (item.name !== 'dsh-split' || !['disabled','baseline'].includes(mode))).map(item => item.name).filter(name => !result.hostEntries.includes(name));
    browser = await openChromium(path.join(home, 'chrome'));
    const navigation=await browser.send('Page.navigate', {url: ready.url},45_000);
    if(navigation.errorText)throw new Error(`Isolated browser navigation failed: ${navigation.errorText}`);
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      result.ui = await browser.evaluate(`({boot:!!document.querySelector('[data-dsh-boot]'),workbench:!!document.querySelector('[data-v5-workbench]'),buttons:document.querySelectorAll('button').length,text:document.body?.innerText.slice(-1800),url:location.origin})`);
      if (result.ui.text?.includes('did not activate') || result.ui.text?.includes('Failed to load plugins')) break;
      if (!result.ui.boot && result.ui.buttons > 3) break;
      await delay(200);
    }
    await delay(700);
    // A throwaway profile has no model credentials, so the product opens its own
    // onboarding panel ("添加一个 API Key 开始使用"). It is modal and not a native
    // <dialog>, so the blind [role=dialog] click below never matched it: the panel
    // stayed open, swallowed the pane keystrokes and reported them as a bad key.
    // Close it by its own label before driving any pane.
    const dismissOnboarding = async () => {
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const open = await browser.evaluate(`['稍后配置','保存并继续'].some(text=>document.body.innerText.includes(text))`);
        if (!open) return;
        await browser.evaluate(`(()=>{const target=Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()==='稍后配置');if(target)target.click();return !!target;})()`);
        await delay(200);
      }
      throw new Error('Isolated onboarding panel did not close');
    };
    if (mode === 'enabled' && !result.ui.boot && result.ui.workbench) {
      console.log('Native UI booted; waiting for session catalog before creating isolated sessions.');
      await dismissOnboarding();
      const catalogUntil=Date.now()+45_000;
      while(await browser.evaluate(`__splitProbe.sessions.list.getSnapshot().phase==='pending'`)){
        if(Date.now()>catalogUntil)throw new Error('Native session catalog did not become ready');
        await delay(200);
      }
      fs.mkdirSync(path.join(home,'workspace'),{recursive:true});
      result.sessions = await browser.evaluate(`(async()=>{
        document.querySelector('[role=dialog] button')?.click();
        const workspace=await __splitProbe.workspaces.create({path:${JSON.stringify(path.join(home,'workspace'))}});
        const ids=[];for(const name of ['A','B','C']){
          const id=await __splitProbe.sessions.create({workspaceId:workspace.workspaceId,sessionId:'session-boot-check-'+name});
          await __splitProbe.sessions.using(id,{source:'boot-check'},r=>r.binding.session.rename('Boot check '+name));ids.push(id);
        }
        __splitProbe.uiWorkspace.openSession(ids[0]);return ids;
      })()`,45_000);
      console.log('Isolated native sessions created; checking interactions.');
      const until = Date.now()+15_000;
      while(Date.now()<until) {
        result.sessionUi=await browser.evaluate(`({panels:document.querySelectorAll('[data-session-panel]').length,editors:document.querySelectorAll('[contenteditable=true]').length,text:document.body.innerText.slice(-1200)})`);
        if(result.sessionUi.editors===1 || result.sessionUi.text.includes('组件加载失败'))break;
        await delay(200);
      }
      await dismissOnboarding();
      fs.writeFileSync(path.join(home,'interactive-dom.html'),await browser.evaluate('document.body.innerHTML'));
      result.catalog=await browser.evaluate('({sessions:__splitProbe.sessions.list.getSnapshot(),workspaces:__splitProbe.workspaces.list.getSnapshot()})');
      if(result.sessionUi.editors===1)result.interactions=await checkNativeSessions(browser,result.sessions,home);
      result.layoutStorage=await browser.evaluate(`Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.includes('dsh-split')))`);
    }
    if(mode==='restart'){
      result.layoutStorage=await browser.evaluate(`Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.includes('dsh-split')))`);
      const until=Date.now()+20_000;
      while(Date.now()<until){
        result.sessionUi=await browser.evaluate(`({editors:document.querySelectorAll('[data-session-panel] [contenteditable=true]').length,ids:Array.from(document.querySelectorAll('[data-session-panel]')).map(e=>e.dataset.sessionId)})`);
        if(result.sessionUi.editors===3)break;
        await delay(100);
      }
      if(result.sessionUi.editors!==3)throw new Error('Cold native host restart did not restore three sessions');
    }
    await delay(500);
    result.errors = browser.events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error');
    fs.writeFileSync(path.join(home, 'screen.png'), Buffer.from((await browser.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
    result.passed = result.missingEntries.length === 0 && !result.ui.boot && result.ui.buttons > 3 && result.errors.length === 0 && result.ui.workbench === withSplit && (mode!=='enabled'||result.sessionUi?.editors===1&&result.interactions?.reload);
  } catch (error) {
    result.failure = error.stack;
    if(browser)try{result.geometry=await browser.evaluate(`Array.from(document.querySelectorAll('[data-session-panel]')).map(e=>({id:e.dataset.sessionId,rect:e.getBoundingClientRect().toJSON(),sidebar:e.querySelector('.v5-session-layout')?.outerHTML.slice(0,300)}))`);}catch{}
    if(browser){result.errors=browser.events;try{result.ui=await browser.evaluate('({text:document.body.innerText.slice(-1600)})');fs.writeFileSync(path.join(home,'screen.png'),Buffer.from((await browser.send('Page.captureScreenshot',{format:'png'})).data,'base64'));}catch{}}
  }
  finally {
    if (browser)try{await browser.close();}catch(error){result.passed=false;result.failure=[result.failure,error.stack].filter(Boolean).join('\n');}
    if (child.connected) child.send({type:'shutdown'});
    const until = Date.now() + 8_000;
    while (child.exitCode === null && Date.now() < until) await delay(100);
    if (child.exitCode === null) child.kill();
    log.end();
    fs.writeFileSync(path.join(home, mode==='restart'?'restart-result.json':'result.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({mode, passed: result.passed, home, entries: result.hostEntries?.length, missingEntries: result.missingEntries, ui: result.ui, sessionUi:result.sessionUi, errors: result.errors?.length, failure: result.failure}));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkBoot(path.resolve(process.argv[2]), process.argv[3] ?? 'enabled');
  if (!result.passed) process.exitCode = 1;
}
