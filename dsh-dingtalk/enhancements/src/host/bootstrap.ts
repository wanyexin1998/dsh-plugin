import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { verifyExecutable } from '../adapters/local/executable.js';
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
/** Host-only test seams. Neither settings JSON nor RPC can supply download URLs/bytes. */
export interface BootstrapRuntime { archive?: (signal: AbortSignal) => Promise<Buffer>; discoverClient?: (signal: AbortSignal) => Promise<string> }
export async function ensureDws(binary: string, signal: AbortSignal, runtime: BootstrapRuntime = {}, progress: (value: ComponentProgress) => void = () => {}): Promise<void> {
  if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new ConnectionServiceError('cli_platform_unsupported');
  try { await lstat(binary); await verifyExecutable(binary, signal); return; }
  catch (error) { if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = JSON.parse(await readFile(new URL('../../dws.lock.json', import.meta.url), 'utf8')) as Lock;
  const asset = lock.dws.assets.find(asset => asset.platform === 'windows-amd64');
  if (!asset || !asset.url.startsWith('https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/')) throw new ConnectionServiceError('cli_integrity_failed');
  const combined = signal;
  const partial = join(dirname(binary), `.dws-${asset.sha256}.download`);
  progress({ phase: 'download', received: 0, total: asset.size });
  const archive = await (runtime.archive?.(combined) ?? downloadLockedAsset(asset, partial, combined, (received, total) => progress({ phase: 'download', received, total })));
  if (combined.aborted) throw new ConnectionServiceError('execution_cancelled');
  progress({ phase: 'verify', received: asset.size, total: asset.size });
  if (archive.length !== asset.size || sha(archive) !== asset.sha256) throw new ConnectionServiceError('cli_integrity_failed');
  const bytes = extractWindowsBinary(archive);
  if (sha(bytes) !== lock.dws.binaryChecksums['win32-x64']) throw new ConnectionServiceError('cli_integrity_failed');
  const directory = dirname(binary); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.dws-${randomUUID()}.tmp`);
  try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 }); if (combined.aborted) throw new ConnectionServiceError('execution_cancelled'); await rename(temporary, binary); await verifyExecutable(binary, combined); await unlink(partial).catch(() => {}); }
  finally { await unlink(temporary).catch(() => {}); }
}
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
