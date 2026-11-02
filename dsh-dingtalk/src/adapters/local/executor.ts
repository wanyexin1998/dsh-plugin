import { ConnectionServiceError } from '../../shared/models.js';
import type { ExecutionLimits } from '../../shared/config.js';
import type { LocalSettings } from './settings.js';
import { verifyExecutable } from './executable.js';
import { processEnvironment, runProcess, spawnDws } from './process.js';
import type { SpawnFactory } from './process.js';

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
  async execute(args: string[], signal: AbortSignal): Promise<unknown> {
    const { binary, env } = await this.ready(signal);
    const result = await runProcess(binary, args, env, this.limits, signal, this.runtime.spawn ?? spawnDws);
    if (result.code !== 0) {
      // Never return raw stdout/stderr, hints, stack traces or private config paths.
      for (const channel of [result.stderr, result.stdout]) {
        try {
          const value = JSON.parse(channel) as { error?: { category?: unknown; code?: unknown } };
          // Reviewed DWS category/exit pair; not evidence of IT denial or terminal expiry.
          if (result.code === 2 && value?.error?.category === 'auth' && value.error.code === 2) throw new ConnectionServiceError('connection_unknown');
        } catch (error) { if (error instanceof ConnectionServiceError) throw error; }
      }
      throw new ConnectionServiceError('cli_failed');
    }
    try { return JSON.parse(result.stdout); } catch { throw new ConnectionServiceError('invalid_cli_output'); }
  }
}
