import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { platformTarget, verifyExecutable } from '../adapters/local/executable.js';
import { readDwsLock } from '../shared/lock.js';
import type { PlatformTarget } from '../adapters/local/executable.js';
import { ConnectionServiceError } from '../shared/models.js';
import { downloadLockedAsset } from './download.js';
import type { ComponentProgress } from '../shared/models.js';

interface Lock { dws: { assets: { platform: string; url: string; size: number; sha256: string }[]; binaryChecksums: Record<string, string> } }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function bytesFrom(url: string, limit: number, signal: AbortSignal, redirect: RequestRedirect = 'follow'): Promise<Buffer> {
  const response = await fetch(url, { signal, credentials: 'omit', redirect, headers: { Accept: redirect === 'error' ? 'application/json' : 'application/octet-stream' } });
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > limit) throw new ConnectionServiceError('service_unavailable');
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > limit) throw new ConnectionServiceError('output_limit_exceeded'); chunks.push(Buffer.from(next.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
/** Extract exactly one binary into memory. Never materialize archive-supplied paths. */
export function extractWindowsBinary(zip: Buffer): Buffer {
  try {
    let end = zip.length - 22;
    for (; end >= Math.max(0, zip.length - 65557); end--) if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
    if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error();
    const count = zip.readUInt16LE(end + 10); let position = zip.readUInt32LE(end + 16); const found: Buffer[] = [];
    if (count > 500) throw new Error();
    for (let i = 0; i < count; i++) {
      if (zip.readUInt32LE(position) !== 0x02014b50) throw new Error();
      const flags = zip.readUInt16LE(position + 8), method = zip.readUInt16LE(position + 10), compressed = zip.readUInt32LE(position + 20), size = zip.readUInt32LE(position + 24);
      const nameLength = zip.readUInt16LE(position + 28), extra = zip.readUInt16LE(position + 30), comment = zip.readUInt16LE(position + 32), offset = zip.readUInt32LE(position + 42);
      const name = zip.toString('utf8', position + 46, position + 46 + nameLength);
      if (name === 'dws.exe' || /^[A-Za-z0-9._-]+\/dws\.exe$/.test(name)) {
        if (flags & 1 || size > 134217728 || zip.readUInt32LE(offset) !== 0x04034b50) throw new Error();
        const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
        if (start + compressed > position) throw new Error();
        const input = zip.subarray(start, start + compressed);
        const output = method === 0 ? Buffer.from(input) : method === 8 ? inflateRawSync(input, { maxOutputLength: 134217728 }) : undefined;
        if (!output || output.length !== size) throw new Error(); found.push(output);
      }
      position += 46 + nameLength + extra + comment;
    }
    if (found.length !== 1) throw new Error();
    return found[0]!;
  } catch { throw new ConnectionServiceError('cli_integrity_failed'); }
}
const MAX_BINARY = 134217728;
function octal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  const text = field.toString('latin1').replace(/\0[\s\S]*$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]{1,11}$/.test(text)) throw new Error();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}
function tarChecksum(header: Buffer): void {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  if (sum !== expected) throw new Error();
}
function tarText(bytes: Buffer): string { return bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8'); }
function archivePath(name: string): string | undefined {
  const normalized = name.trim().replace(/^\.\//, '');
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\\]/.test(normalized) || normalized.startsWith('/')) return undefined;
  // Reject empty, "." and ".." segments before matching the expected release layout.
  if (normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined;
  // Only a plain "dws" leaf is eligible; the tar header name is never used as a filesystem path.
  if (normalized === 'dws' || /^[A-Za-z0-9._-]+\/dws$/.test(normalized)) return 'dws';
  return undefined;
}
function paxPath(data: Buffer): string | undefined {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (match && match[1] === 'path') return match[2];
  }
  return undefined;
}
/** Extract exactly one plain `dws` regular file from the official tar.gz into memory. */
export function extractLinuxBinary(tarGz: Buffer): Buffer {
  try {
    const tar = gunzipSync(tarGz, { maxOutputLength: MAX_BINARY });
    const found: Buffer[] = [];
    let offset = 0, entries = 0, pendingName: string | undefined;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      if (++entries > 1000) throw new Error();
      tarChecksum(header);
      const type = String.fromCharCode(header[156] || 0x30);
      const size = octal(header, 124, 12);
      if (size > MAX_BINARY || offset + 512 + size > tar.length) throw new Error();
      const data = tar.subarray(offset + 512, offset + 512 + size);
      const next = offset + 512 + Math.ceil(size / 512) * 512;
      if (type === 'x' || type === 'L') {
        // Extended header for the following entry only. The raw header name is never trusted.
        pendingName = type === 'x' ? paxPath(data) : tarText(data);
      } else if (type === '0' || type === '\0') {
        const name = pendingName ?? tarText(header.subarray(0, 100));
        const prefix = tarText(header.subarray(345, 345 + 155));
        const declared = pendingName ?? (prefix ? `${prefix}/${name}` : name);
        pendingName = undefined;
        const leaf = archivePath(declared);
        if (leaf) {
          if (header[156] !== undefined && !['0', '\0'].includes(String.fromCharCode(header[156]))) throw new Error();
          found.push(Buffer.from(data));
        }
      } else if (type === 'g') {
        // Global pax metadata cannot select the binary; ignore it rather than inherit paths.
      } else {
        pendingName = undefined;
        if (type === '1' || type === '2') {
          // A symlink/hardlink named dws is an archive-level integrity failure.
          const name = tarText(header.subarray(0, 100));
          const prefix = tarText(header.subarray(345, 345 + 155));
          if (archivePath(prefix ? `${prefix}/${name}` : name)) throw new Error();
        }
      }
      offset = next;
    }
    if (found.length !== 1) throw new Error();
    return found[0]!;
  } catch { throw new ConnectionServiceError('cli_integrity_failed'); }
}
/** Host-only test seams. Neither settings JSON nor RPC can supply download URLs/bytes. */
export interface BootstrapRuntime {
  archive?: (signal: AbortSignal) => Promise<Buffer>;
  discoverClient?: (signal: AbortSignal) => Promise<string>;
  /** Test seam only: simulate a target platform without changing process.platform. */
  platform?: { platform: NodeJS.Platform; arch: string };
}
export async function ensureDws(binary: string, signal: AbortSignal, runtime: BootstrapRuntime = {}, progress: (value: ComponentProgress) => void = () => {}): Promise<void> {
  if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
  const runtimePlatform = runtime.platform ?? { platform: process.platform, arch: process.arch };
  const target = platformTarget(runtimePlatform.platform, runtimePlatform.arch);
  try { await lstat(binary); await verifyExecutable(binary, signal, target); return; }
  catch (error) { if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!target) throw new ConnectionServiceError('cli_platform_unsupported');
  const lock = await readDwsLock([new URL('../../dws.lock.json', import.meta.url)]) as Lock;
  const asset = lock.dws.assets.find(asset => asset.platform === target.asset);
  if (!asset || !asset.url.startsWith('https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/')) throw new ConnectionServiceError('cli_integrity_failed');
  const partial = join(dirname(binary), `.dws-${asset.sha256}.download`);
  progress({ phase: 'download', received: 0, total: asset.size });
  const archive = await (runtime.archive?.(signal) ?? downloadLockedAsset(asset, partial, signal, (received, total) => progress({ phase: 'download', received, total })));
  if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
  progress({ phase: 'verify', received: asset.size, total: asset.size });
  if (archive.length !== asset.size || sha(archive) !== asset.sha256) throw new ConnectionServiceError('cli_integrity_failed');
  const bytes = target.archive === 'zip' ? extractWindowsBinary(archive) : extractLinuxBinary(archive);
  if (sha(bytes) !== lock.dws.binaryChecksums[target.key]) throw new ConnectionServiceError('cli_integrity_failed');
  const directory = dirname(binary); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.dws-${randomUUID()}.tmp`);
  const mode = target.key.startsWith('win32') ? 0o700 : 0o755;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
    await rename(temporary, binary);
    await verifyExecutable(binary, signal, target);
    await unlink(partial).catch(() => {});
  }
  finally { await unlink(temporary).catch(() => {}); }
}
export { platformTarget };
export type { PlatformTarget };
export async function officialClient(signal: AbortSignal, runtime: BootstrapRuntime = {}): Promise<string> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  let id: unknown;
  try {
    if (runtime.discoverClient) id = await runtime.discoverClient(combined);
    else {
      const bytes = await bytesFrom('https://mcp.dingtalk.com/cli/clientId', 8192, combined, 'error');
      const value = JSON.parse(bytes.toString('utf8'));
      if (value.success !== true) throw new Error(); id = value.result;
    }
    if (combined.aborted || typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(id) || id === 'default') throw new Error();
    return id;
  } catch { throw new ConnectionServiceError(signal.aborted ? 'execution_cancelled' : 'service_unavailable'); }
}
