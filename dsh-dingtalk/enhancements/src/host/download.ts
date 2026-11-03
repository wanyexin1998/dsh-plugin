import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConnectionServiceError } from '../shared/models.js';

interface Asset { url: string; size: number; sha256: string }
/** Host-only timing seam; not configurable through RPC or model arguments. */
export interface DownloadTiming { idleMs?: number; totalMs?: number }
export const DOWNLOAD_IDLE_MS = 90_000;
export const DOWNLOAD_TOTAL_MS = 30 * 60_000;

/** One sequential transfer. The locked digest identifies the partial file across retries. */
export async function downloadLockedAsset(asset: Asset, file: string, signal: AbortSignal,
  progress: (received: number, total: number) => void = () => {}, timing: DownloadTiming = {}): Promise<Buffer> {
  if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let received = 0;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > asset.size) throw new ConnectionServiceError('cli_integrity_failed');
    received = stat.size;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const verified = async () => {
    const bytes = await readFile(file);
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      await unlink(file);
      throw new ConnectionServiceError('cli_integrity_failed');
    }
    return bytes;
  };
  progress(received, asset.size);
  if (received === asset.size) return verified();
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  const total = setTimeout(() => timeout.abort(), timing.totalMs ?? DOWNLOAD_TOTAL_MS);
  let idle: ReturnType<typeof setTimeout>;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => timeout.abort(), timing.idleMs ?? DOWNLOAD_IDLE_MS); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    touch();
    const response = await fetch(asset.url, { signal: combined, credentials: 'omit', headers: {
      Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', ...(received ? { Range: `bytes=${received}-` } : {}),
    } });
    if (!response.body) throw new ConnectionServiceError('cli_download_failed');
    reader = response.body.getReader();
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== received || Number(range[2]) !== asset.size - 1 || Number(range[3]) !== asset.size)
        throw new ConnectionServiceError('cli_download_failed');
    } else if (response.status === 200) received = 0; // Server ignored Range: replace, never append a full response.
    else throw new ConnectionServiceError('cli_download_failed');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== asset.size - received)) throw new ConnectionServiceError('cli_download_failed');
    output = await open(file, received ? 'a' : 'w', 0o600);
    progress(received, asset.size);
    for (;;) {
      touch();
      const chunk = await reader.read();
      combined.throwIfAborted();
      if (chunk.done) break;
      if (received + chunk.value.length > asset.size) throw new ConnectionServiceError('cli_integrity_failed');
      await output.writeFile(chunk.value);
      received += chunk.value.length;
      progress(received, asset.size);
    }
    await output.close(); output = undefined;
    if (received !== asset.size) throw new ConnectionServiceError('cli_download_failed');
    return await verified();
  } catch (error) {
    if (signal.aborted) throw new ConnectionServiceError('execution_cancelled');
    if (timeout.signal.aborted) throw new ConnectionServiceError('cli_download_timeout');
    if (error instanceof ConnectionServiceError) throw error;
    throw new ConnectionServiceError('cli_download_failed');
  } finally {
    clearTimeout(total); clearTimeout(idle!);
    await reader?.cancel().catch(() => {});
    await output?.close();
  }
}
