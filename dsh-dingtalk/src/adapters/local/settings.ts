import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError } from '../../shared/models.js';

export interface LocalSettings { binaryPath?: string; configDirectory?: string; keychainDirectory?: string; profile?: string }
export function parseLocalSettings(value: unknown): LocalSettings {
  const fail = (): never => { throw new ConnectionServiceError('local_configuration_invalid'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['binaryPath', 'configDirectory', 'keychainDirectory', 'profile'].includes(key))) return fail();
  const output: LocalSettings = {};
  for (const key of ['binaryPath', 'configDirectory', 'keychainDirectory'] as const) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== 'string' || !isAbsolute(data[key]) || /^(\\\\|\/\/)/.test(data[key]) || /[\u0000-\u001f]/.test(data[key])) return fail();
      output[key] = data[key];
    }
  }
  if (data.profile !== undefined) {
    if (typeof data.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.profile)) return fail();
    output.profile = data.profile;
  }
  return Object.freeze(output);
}
/** Host-only file. DSH mirrors plugin config to Client; private paths/IDs must not go there. */
export async function loadLocalSettings(): Promise<LocalSettings> {
  const file = process.env.DSH_DINGTALK_CONFIG_FILE;
  if (!file) return {};
  if (!isAbsolute(file) || /^(\\\\|\/\/)/.test(file)) throw new ConnectionServiceError('local_configuration_invalid');
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 16384) throw new Error();
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 16384) throw new Error();
    const input = JSON.parse(text) as Record<string, unknown>;
    const { oauth: _oauth, ...local } = input;
    return parseLocalSettings(local);
  } catch { throw new ConnectionServiceError('local_configuration_invalid'); }
}
