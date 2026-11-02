import { mkdir, lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConnectionServiceError } from '../shared/models.js';

/** Only a new plugin-owned directory may be provisioned. Never alter an existing user's log directory. */
export async function provisionPrivateRuntime(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const config = join(root, 'dws');
  const marker = join(config, '.dsh-dingtalk-owned');
  try {
    await mkdir(config, { mode: 0o700 });
    const file = await open(marker, 'wx', 0o600); await file.writeFile('dsh-dingtalk-owned-v1\n'); await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConnectionServiceError('privacy_guard_required');
  }
  await verifyPrivacyGuard(config, true);
  return config;
}
export async function verifyPrivacyGuard(config: string, create = false): Promise<void> {
  try {
    if ((await lstat(config)).isSymbolicLink()) throw new Error();
    const marker = join(config, '.dsh-dingtalk-owned');
    if ((await lstat(marker)).isSymbolicLink() || await readFile(marker, 'utf8') !== 'dsh-dingtalk-owned-v1\n') throw new Error();
    const logs = join(config, 'logs');
    if (create) { try { const file = await open(logs, 'wx', 0o600); await file.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const info = await lstat(logs);
    // Upstream Setup calls MkdirAll(logs); EEXIST selects its documented no-op FileLogger.
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) throw new Error();
  } catch { throw new ConnectionServiceError('privacy_guard_required'); }
}
