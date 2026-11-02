import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { ExecutionLimits } from '../../shared/config.js';
import { ConnectionServiceError } from '../../shared/models.js';
import type { ReasonCode } from '../../shared/models.js';
import type { LocalSettings } from './settings.js';

export type SpawnFactory = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export const spawnDws: SpawnFactory = (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' });
export function processEnvironment(settings: LocalSettings): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'home',
    'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'programdata', 'os']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  env.DWS_NO_UPDATE_CHECK = '1'; env.DWS_LANG = 'zh';
  // Official audit records command parameters, including search terms. This plugin
  // never persists business arguments; an inherited forwarding URL is also stripped.
  env.DWS_AUDIT = '0';
  if (settings.configDirectory) env.DWS_CONFIG_DIR = settings.configDirectory;
  if (settings.keychainDirectory) env.DWS_KEYCHAIN_DIR = settings.keychainDirectory;
  return env;
}
async function killTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    return;
  }
  await new Promise<void>(resolve => {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { killer.kill(); child.kill(); resolve(); }, 2000);
    killer.on('error', () => { clearTimeout(timer); child.kill(); resolve(); });
    killer.on('close', code => { clearTimeout(timer); if (code) child.kill(); resolve(); });
  });
}
export async function runProcess(binary: string, args: string[], env: NodeJS.ProcessEnv, limits: ExecutionLimits,
  signal: AbortSignal, launch: SpawnFactory = spawnDws, input = '', options: { cwd?: string; onValue?: (value: unknown) => void } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal.aborted) throw new ConnectionServiceError(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled');
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(binary, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd: options.cwd || dirname(binary), env }); }
    catch { reject(new ConnectionServiceError('cli_missing')); return; }
    let failure: ReasonCode | undefined, size = 0, killing: Promise<void> | undefined;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    const drain = (final = false) => {
      while (pending.includes('\n')) { const at = pending.indexOf('\n'); const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1); if (line) options.onValue!(JSON.parse(line)); }
      if (final && pending.trim()) { options.onValue!(JSON.parse(pending)); pending = ''; }
    };
    const stop = (reason: ReasonCode): void => { failure ??= reason; killing ??= killTree(child); };
    const abort = (): void => stop(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled');
    const timer = setTimeout(() => stop('execution_timeout'), limits.timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
      if (failure) return;
      if (options.onValue && stream === child.stdout) {
        try { pending += decoder.decode(chunk, { stream: true }); if (Buffer.byteLength(pending) > limits.maxOutputBytes) { stop('output_limit_exceeded'); return; } drain(); } catch { stop('invalid_cli_output'); }
        return;
      }
      size += chunk.length;
      if (size > limits.maxOutputBytes) stop('output_limit_exceeded');
      else if (!failure) output.push(chunk);
    });
    child.on('error', () => { failure ??= 'cli_missing'; });
    child.on('close', async code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      await killing;
      if (options.onValue && !failure) { try { pending += decoder.decode(); drain(true); } catch { failure = 'invalid_cli_output'; } }
      if (failure) { reject(new ConnectionServiceError(failure)); return; }
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        resolve({ code, stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) });
      } catch { reject(new ConnectionServiceError('invalid_cli_output')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
