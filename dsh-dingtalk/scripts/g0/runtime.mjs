import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const lock = JSON.parse(await readFile(join(pluginRoot, 'dws.lock.json'), 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function verifiedBinary(binary) {
  const path = resolve(binary);
  const expected = lock.dws.binaryChecksums?.[`${process.platform}-${process.arch}`];
  if (!expected) throw new Error('No verified binary checksum for this OS/architecture. Bootstrap and verify the release archive first.');
  if (sha256(await readFile(path)) !== expected) throw new Error('DWS binary checksum mismatch; refusing execution.');
  return path;
}

// Test-only process boundary. Never use a real user's DWS configuration/keychain.
export async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-g0-'));
  const config = join(root, 'config');
  await mkdir(config);
  const systemVariables = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp',
    'userprofile', 'home', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'programdata',
    'processor_architecture', 'number_of_processors', 'os', 'lang', 'lc_all']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemVariables.has(key.toLowerCase())));
  Object.assign(env, {
    DWS_CONFIG_DIR: config, DWS_KEYCHAIN_DIR: join(root, 'keys'),
    DWS_DISABLE_KEYCHAIN: '1', DWS_NO_UPDATE_CHECK: '1', DWS_LANG: 'zh',
    DWS_KEYCHAIN_TEST_NAMESPACE: root,
  });
  return { root, config, env, dispose: async () => {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-dingtalk-g0-')) {
      throw new Error('Refusing cleanup outside the generated G0 temporary directory');
    }
    if (process.platform === 'win32') {
      const cleanup = await run('pwsh.exe', ['-NoProfile', '-File', join(pluginRoot, 'scripts/g0/cleanup-test-keychain.ps1'), '-Namespace', root], { env, cwd: root });
      if (cleanup.code !== 0) throw new Error('Test registry cleanup failed');
    }
    await rm(root, { recursive: true, force: true });
  } };
}

export function run(binary, args, { env, cwd, input = '', timeoutMs = 30000 } = {}) {
  return new Promise((fulfil, reject) => {
    const child = spawn(binary, args, { env, cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const fail = message => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => fail('CLI timed out'), timeoutMs);
    for (const [stream, append] of [[child.stdout, chunk => stdout += chunk], [child.stderr, chunk => stderr += chunk]]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 2 * 1024 * 1024) fail('CLI output exceeded 2 MiB');
        else append(chunk);
      });
    }
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else fulfil({ code, stdout: stdout.replace(/\r\n/g, '\n'), stderr: stderr.replace(/\r\n/g, '\n') });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail('CLI stdin failed'); });
    child.stdin.end(input);
  });
}

export function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}
