import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError } from '../../shared/models.js';
import { readDwsLock } from '../../shared/lock.js';

/** Host-internal platform seam. Never configurable through settings, RPC or model arguments. */
export interface PlatformTarget {
  /** Lock-file key used for the pinned binary checksum. */
  readonly key: string;
  /** Platform descriptor in the release asset list. */
  readonly asset: string;
  /** Expected executable file name in the plugin state directory. */
  readonly binary: string;
  /** Release archive format. */
  readonly archive: 'zip' | 'tar.gz';
  /** Expected container format. */
  readonly image: 'pe' | 'elf';
  readonly machine: number;
}

const MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 };
export function platformTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformTarget | undefined {
  if (platform === 'win32' && arch === 'x64') return { key: 'win32-x64', asset: 'windows-amd64', binary: 'dws.exe', archive: 'zip', image: 'pe', machine: MACHINE.x64! };
  if (platform === 'linux' && arch === 'x64') return { key: 'linux-x64', asset: 'linux-amd64', binary: 'dws', archive: 'tar.gz', image: 'elf', machine: MACHINE.x64! };
  return undefined;
}
/** Only the pinned platforms are accepted; Linux arm64/macOS assets stay metadata-only for now. */
export function assertElfImage(bytes: Buffer, arch: string = process.arch): void {
  const fail = (): never => { throw new ConnectionServiceError('cli_platform_unsupported'); };
  if (bytes.length < 64) fail();
  if (bytes.readUInt32BE(0) !== 0x7f454c46) fail(); // 0x7f ELF
  const bits = bytes[4], encoding = bytes[5], version = bytes[6];
  if (bits !== 2 || encoding !== 1 || version !== 1) fail(); // 64-bit little-endian ELF v1 only
  const type = bytes.readUInt16LE(16);
  if (type !== 2 && type !== 3) fail(); // ET_EXEC or ET_DYN
  const machine = MACHINE[arch];
  if (!machine || bytes.readUInt16LE(18) !== machine) fail();
  const shebangLike = bytes.subarray(0, 2).toString('ascii') === '#!';
  if (shebangLike) fail();
}
function assertPeImage(bytes: Buffer, arch: string): void {
  const fail = (): never => { throw new ConnectionServiceError('cli_platform_unsupported'); };
  if (bytes.length < 0x40) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.length < pe + 6 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') fail();
  const machine = arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : -1;
  if (machine < 0 || bytes.readUInt16LE(pe + 4) !== machine) fail();
}
/** Resolve, hash and format-check the pinned DWS binary. Never runs it. */
export async function verifyExecutable(binaryPath?: string, signal?: AbortSignal, target?: PlatformTarget | undefined): Promise<string> {
  if (!binaryPath) throw new ConnectionServiceError('cli_missing');
  if (!isAbsolute(binaryPath)) throw new ConnectionServiceError('local_configuration_invalid');
  const resolved = target ?? platformTarget();
  let path: string, bytes: Buffer, info: Awaited<ReturnType<typeof stat>>;
  try {
    path = await realpath(binaryPath);
    info = await stat(path);
    if (!info.isFile() || info.size > 134217728) throw new Error();
    if (/^(\\\\|\/\/)/.test(path)) throw new ConnectionServiceError('local_configuration_invalid');
    bytes = await readFile(path, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw new ConnectionServiceError(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled');
    if (error instanceof ConnectionServiceError) throw error;
    throw new ConnectionServiceError('cli_missing');
  }
  const lock = await readDwsLock([new URL('../../../dws.lock.json', import.meta.url)]);
  if (!resolved) throw new ConnectionServiceError('cli_platform_unsupported');
  const expected = lock.dws.binaryChecksums[resolved.key];
  if (!expected) throw new ConnectionServiceError('cli_platform_unsupported');
  if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) throw new ConnectionServiceError('cli_integrity_failed');
  // A preinstalled artifact must be a plain executable file; POSIX mode bits are a host property.
  if (process.platform !== 'win32') {
    try { await access(path, constants.X_OK); } catch { throw new ConnectionServiceError('cli_missing'); }
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new ConnectionServiceError('cli_missing');
    // Tightened deployment: setuid/setgid binaries are never accepted, even when the hash matches.
    if ((info.mode & 0o6000) !== 0) throw new ConnectionServiceError('cli_integrity_failed');
  }
  if (resolved.image === 'pe') assertPeImage(bytes, resolved.key.split('-')[1]!);
  else assertElfImage(bytes, resolved.key.split('-')[1]!);
  return path;
}
