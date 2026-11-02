import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConnectionServiceError } from '../shared/models.js';

export interface BindingRecord { version: 1; profile?: string; revoked: boolean; verificationPending?: boolean; revocationPending?: boolean }
export class BindingStore {
  constructor(private readonly root: string) {}
  async read(): Promise<BindingRecord> {
    try {
      const path = join(this.root, 'binding.json');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error();
      const data = JSON.parse(await readFile(path, 'utf8')) as BindingRecord;
      if (!data || data.version !== 1 || typeof data.revoked !== 'boolean' || Object.keys(data).some(key => !['version', 'profile', 'revoked', 'verificationPending', 'revocationPending'].includes(key)) || [data.verificationPending, data.revocationPending].some(value => value !== undefined && typeof value !== 'boolean') || (data.profile !== undefined && (typeof data.profile !== 'string' || !/^[A-Za-z0-9._-]{1,128}:[A-Za-z0-9._-]{1,128}$/.test(data.profile)))) throw new Error();
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revoked: true };
      throw new ConnectionServiceError('local_configuration_invalid');
    }
  }
  async write(value: BindingRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.binding-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.root, 'binding.json'));
    } catch { await unlink(temporary).catch(() => {}); throw new ConnectionServiceError('service_unavailable'); }
  }
}
