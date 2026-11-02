import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError } from '../../shared/models.js';

export async function verifyExecutable(binaryPath?: string, signal?: AbortSignal): Promise<string> {
  if (!binaryPath) throw new ConnectionServiceError('cli_missing');
  if (!isAbsolute(binaryPath)) throw new ConnectionServiceError('local_configuration_invalid');
  let path: string, bytes: Buffer;
  try {
    path = await realpath(binaryPath);
    const info = await stat(path);
    if (!info.isFile() || info.size > 134217728) throw new Error();
    await access(path, constants.X_OK);
    if (/^(\\\\|\/\/)/.test(path)) throw new ConnectionServiceError('local_configuration_invalid');
    bytes = await readFile(path, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw new ConnectionServiceError(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled');
    if (error instanceof ConnectionServiceError) throw error;
    throw new ConnectionServiceError('cli_missing');
  }
  const lock = JSON.parse(await readFile(new URL('../../../dws.lock.json', import.meta.url), 'utf8')) as {
    dws: { version: string; binaryChecksums: Record<string, string> };
  };
  const expected = lock.dws.binaryChecksums[`${process.platform}-${process.arch}`];
  if (!expected) throw new ConnectionServiceError('cli_platform_unsupported');
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new ConnectionServiceError('cli_integrity_failed');
  if (process.platform === 'win32') {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(pe + 4) !== (process.arch === 'x64' ? 0x8664 : 0xaa64)) throw new ConnectionServiceError('cli_platform_unsupported');
  }
  return path;
}
