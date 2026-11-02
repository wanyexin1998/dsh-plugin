import type { BackendMode } from './models.js';

export interface ExecutionLimits { timeoutMs: number; maxOutputBytes: number; queueLimit: number; queueTimeoutMs: number }
export const DEFAULT_LIMITS: Readonly<ExecutionLimits> = Object.freeze({ timeoutMs: 15000, maxOutputBytes: 262144, queueLimit: 8, queueTimeoutMs: 5000 });
export function parseLimits(value: unknown = {}): ExecutionLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dsh-dingtalk: invalid execution limits');
  const ranges = { timeoutMs: [100, 120000], maxOutputBytes: [1024, 2097152], queueLimit: [0, 32], queueTimeoutMs: [50, 60000] } as const;
  const result = { ...DEFAULT_LIMITS };
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(ranges, key) || typeof entry !== 'number' || !Number.isInteger(entry)) throw new Error('dsh-dingtalk: invalid execution limits');
    const name = key as keyof ExecutionLimits;
    const [min, max] = ranges[name];
    if (entry < min || entry > max) throw new Error('dsh-dingtalk: execution limit out of range');
    result[name] = entry;
  }
  return result;
}
export interface PluginConfig { mode: BackendMode; execution: ExecutionLimits }
export function parseConfig(value: unknown = {}): PluginConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'mode' && key !== 'execution')) throw new Error('dsh-dingtalk: expected config { mode, execution? }');
  const configuredMode = (value as Record<string, unknown>).mode;
  const mode = configuredMode === undefined ? 'local' : configuredMode;
  if (mode !== 'local' && mode !== 'cellgent') throw new Error('dsh-dingtalk: mode must be local or cellgent');
  if (mode === 'cellgent') throw new Error('dsh-dingtalk: cellgent mode is deferred; no remote adapter is available in this P0 build');
  return { mode, execution: parseLimits((value as Record<string, unknown>).execution) };
}
