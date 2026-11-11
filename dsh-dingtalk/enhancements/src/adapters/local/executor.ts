import { ConnectionServiceError } from '../../shared/models.js';
import type { ExecutionLimits } from '../../shared/config.js';
import type { LocalSettings } from './settings.js';
import { verifyExecutable } from './executable.js';
import { processEnvironment, runProcess, spawnDws } from './process.js';
import type { SpawnFactory } from './process.js';
import { normalizeDwsError } from './errors.js';

/** Internal test seam, not a plugin config field or an Agent/Client API. */
export interface LocalRuntime {
  verify?: () => Promise<string>;
  spawn?: SpawnFactory;
  environment?: NodeJS.ProcessEnv;
}
export class DwsExecutor {
  private versionChecked = false;
  constructor(private readonly settings: LocalSettings, private readonly limits: ExecutionLimits, private readonly runtime: LocalRuntime = {}) {}
  private async ready(signal: AbortSignal): Promise<{ binary: string; env: NodeJS.ProcessEnv }> {
    const checkCancelled = (): void => { if (signal.aborted) throw new ConnectionServiceError(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled'); };
    checkCancelled();
    // Rehash on each process invocation; a swapped binary must not reuse validation.
    const binary = await (this.runtime.verify?.() ?? verifyExecutable(this.settings.binaryPath, signal));
    checkCancelled();
    const env = this.runtime.environment ?? processEnvironment(this.settings);
    if (!this.versionChecked) {
      const version = await runProcess(binary, ['--version'], env, this.limits, signal, this.runtime.spawn ?? spawnDws);
      if (version.code !== 0 || !version.stdout.startsWith('dws version v1.0.66 (f215043e676d6889e1ddce3464828d8b1ec40c31,')) throw new ConnectionServiceError('cli_version_unsupported');
      this.versionChecked = true;
    }
    return { binary, env };
  }
  async check(signal: AbortSignal): Promise<void> { await this.ready(signal); }
  async execute(args: string[], signal: AbortSignal, input = '', json = true, options: { cwd?: string; timeoutMs?: number; onValue?: (value: unknown) => void; onStderr?: (chunk: string) => void } = {}): Promise<unknown> {
    const { binary, env } = await this.ready(signal);
    const result = await runProcess(binary, args, env, { ...this.limits, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs, maxOutputBytes: 2097152 } : {}) }, signal, this.runtime.spawn ?? spawnDws, input, options);
    if (result.code !== 0) {
      // Never return raw stdout/stderr, hints, stack traces or private config paths.
      throw new ConnectionServiceError(normalizeDwsError(result.code, result.stderr, result.stdout));
    }
    if (!json) return null;
    try { return JSON.parse(result.stdout); } catch { throw new ConnectionServiceError('invalid_cli_output'); }
  }
}
