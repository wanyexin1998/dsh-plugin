import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

export async function openChromium(directory) {
  fs.mkdirSync(directory, {recursive: true});
  const portFile = path.join(directory, 'DevToolsActivePort');
  if(fs.existsSync(portFile))fs.unlinkSync(portFile);
  const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], {windowsHide: true, stdio: 'ignore'});
  try {
  const until = Date.now() + 30_000;
  let target,lastError;
  while(!target){
    try {
      // Windows creates this file before releasing its write lock. Existence
      // alone is not readiness; wait for a complete file and a live page target.
      const lines=fs.readFileSync(portFile,'utf8').trim().split(/\r?\n/);
      if(/^\d+$/.test(lines[0])&&lines[1]?.startsWith('/devtools/browser/')){
        const targets=await(await fetch(`http://127.0.0.1:${lines[0]}/json/list`,{signal:AbortSignal.timeout(1500)})).json();
        target=targets.find(item=>item.type==='page');
      }
    }catch(error){lastError=error;}
    if(!target){if(Date.now()>until)throw new Error('Chromium did not become ready: '+(lastError?.message??'no page target'));await delay(100);}
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
  let next = 0;
  const pending = new Map(), events = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    } else if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded'].includes(message.method)) events.push(message);
  });
  const send = (method, params = {}, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false});
  const evaluate = async (expression, timeoutMs) => {
    const value = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, timeoutMs);
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text);
    return value.result.value;
  };
  return {send, evaluate, events, child, async close() {
    try { await send('Browser.close'); } catch {} finally {
      socket.close();
      // The protocol acknowledgement precedes Chromium's profile flush. Killing
      // immediately here can lose localStorage and invalidate a cold-restore test.
      // The window is an environment allowance, not an assertion: the check still
      // requires Chromium to exit on its own, it just refuses to kill it early on a
      // loaded machine (10s was flaky and failed unrelated baseline scenarios).
      const window = Number(process.env.DSH_SPLIT_SHUTDOWN_MS ?? 30_000);
      const until=Date.now()+window;
      while(child.exitCode===null&&Date.now()<until)await delay(100);
      if(child.exitCode===null){child.kill();throw new Error('Chromium did not finish graceful profile shutdown');}
    }
  }};
  }catch(error){if(child.exitCode===null)child.kill();throw error;}
}
