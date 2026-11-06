import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionServiceError } from './models.js';

export interface DwsLockAsset { platform: string; filename?: string; url: string; size: number; sha256: string }
export interface DwsLock {
  dws: {
    version: string; tag?: string; commit?: string; repository?: string;
    binaryChecksums: Record<string, string>;
    assets: DwsLockAsset[];
    operations?: { operationId: string; cliPath: string[] }[];
  };
}
const CANDIDATES = 3;
/**
 * Host-only lock resolution. The plugin build resolves the bundled `dws.lock.json`; the
 * standalone Connector sets DSH_DINGTALK_DWS_LOCK to its installed copy because bundling
 * rewrites import.meta.url. An operator-controlled override cannot select an unsigned lock:
 * the file is still cross-checked by the caller against its pinned expectations.
 */
export async function readDwsLock(defaults: URL[]): Promise<DwsLock> {
  const override = process.env.DSH_DINGTALK_DWS_LOCK;
  let candidates: URL[] = defaults.slice(0, CANDIDATES);
  if (override !== undefined) {
    if (!override || !isAbsolute(override) || /^(\\\\|\/\/)/.test(override) || /[\u0000-\u001f]/.test(override)) throw new ConnectionServiceError('local_configuration_invalid');
    candidates = [new URL(`file://${override.replaceAll('\\', '/').replace(/^\/?/, '/')}`), ...candidates];
  }
  for (const url of candidates) {
    try {
      if ((await stat(fileURLToPath(url))).size > 65536) continue;
      const value = JSON.parse(await readFile(url, 'utf8')) as DwsLock;
      if (!value?.dws || typeof value.dws.version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(value.dws.version)
        || typeof value.dws.binaryChecksums !== 'object' || value.dws.binaryChecksums === null || !Array.isArray(value.dws.assets)) throw new Error();
      return value;
    } catch { /* try the next bundled location */ }
  }
  throw new ConnectionServiceError('cli_integrity_failed');
}
