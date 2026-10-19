import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const release = path.resolve(process.argv[2]);
const label = process.argv[3] ?? 'probe';
const home = path.join(root, '.boot-check', `${label}-${Date.now()}`);
const profile = path.join(home, 'profiles', 'desktop');
fs.mkdirSync(profile, {recursive: true});
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
const dependencies = {};
for (const item of manifest.replacements) {
  const link = path.join(profile, 'node_modules', item.name);
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.symlinkSync(item.target, link, 'junction');
  dependencies[item.name] = `link:${item.target.replaceAll('\\', '/')}`;
}
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({name: 'dsh-boot-check', private: true, dependencies,
  dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}}}, null, 2));
fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), `- id: desktop-product-telemetry\n  disabled: true\n- id: product-analytics\n  disabled: true\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${port}\n`);
const runtime = 'E:/deepseek-harness/resources/app.asar/dsh';
const child = spawn('E:/deepseek-harness/DeepSeek Harness.exe', ['--expose-internals', `${runtime}/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`, runtime, profile, 'E:/deepseek-harness/resources/runtime/primary-runtime'], {
  cwd: profile, windowsHide: true, env: {...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
const log = fs.createWriteStream(path.join(home, 'host.log'));
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => log.write(data));
const timer = setTimeout(() => { child.send?.({type: 'shutdown'}); }, 180_000);
child.on('message', message => {
  if (message.type === 'ready') {
    fs.writeFileSync(path.join(home, 'ready.json'), JSON.stringify(message, null, 2));
    const boot = message.injections?.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')?.value;
    console.log(JSON.stringify({ready: true, home, pid: child.pid, bootShape: Object.keys(boot ?? {}), entries: boot?.plugins?.filter(entry => /conversation|split/.test(entry.id))}));
  } else if (message.type === 'fatal') console.log(JSON.stringify(message));
});
child.on('exit', (code, signal) => { clearTimeout(timer); log.end(); console.log(JSON.stringify({exited: true, code, signal, home})); });
process.on('SIGINT', () => { child.send?.({type: 'shutdown'}); });
console.log(JSON.stringify({started: true, home, pid: child.pid}));
