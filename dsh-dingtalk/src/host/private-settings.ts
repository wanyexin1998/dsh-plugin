import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ConnectionServiceError } from '../shared/models.js';

export interface OAuthSettings {
  clientId: string; redirectUri: string; scopes: string; expectedCorpId: string; expectedUserId: string;
}
export interface PrivateSettings { oauth?: OAuthSettings; stateDirectory?: string }
export async function loadPrivateSettings(): Promise<PrivateSettings> {
  const path = process.env.DSH_DINGTALK_CONFIG_FILE;
  if (!path) return {};
  const fail = (): never => { throw new ConnectionServiceError('local_configuration_invalid'); };
  if (!isAbsolute(path) || /^(\\\\|\/\/)/.test(path)) return fail();
  try {
    if ((await stat(path)).size > 16384) return fail();
    const root = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!root.oauth) return { stateDirectory: join(dirname(path), 'dsh-dingtalk-state') };
    const data = root.oauth as Record<string, unknown>;
    if (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['clientId', 'redirectUri', 'scopes', 'expectedCorpId', 'expectedUserId'].includes(key))) return fail();
    for (const key of ['clientId', 'redirectUri', 'scopes', 'expectedCorpId', 'expectedUserId']) if (typeof data[key] !== 'string' || !data[key].trim() || (data[key] as string).length > 1024) return fail();
    const url = new URL(data.redirectUri as string);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/dsh-dingtalk/callback') return fail();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(data.expectedCorpId as string) || !/^[A-Za-z0-9._-]{1,128}$/.test(data.expectedUserId as string)) return fail();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(data.clientId as string) || !/^[A-Za-z0-9._: -]{1,512}$/.test(data.scopes as string)) return fail();
    return { oauth: data as unknown as OAuthSettings, stateDirectory: join(dirname(path), 'dsh-dingtalk-state') };
  } catch { return fail(); }
}
