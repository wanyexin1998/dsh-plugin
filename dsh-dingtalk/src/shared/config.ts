import type { BackendMode } from './models.js';

export interface PluginConfig { mode: BackendMode }
export function parseConfig(value: unknown = {}): PluginConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'mode')) throw new Error('dsh-dingtalk: expected config { mode: local | cellgent }');
  const configuredMode = (value as Record<string, unknown>).mode;
  const mode = configuredMode === undefined ? 'local' : configuredMode;
  if (mode !== 'local' && mode !== 'cellgent') throw new Error('dsh-dingtalk: mode must be local or cellgent');
  if (mode === 'cellgent') throw new Error('dsh-dingtalk: cellgent mode is deferred; no remote adapter is available in this P0 build');
  return { mode };
}
