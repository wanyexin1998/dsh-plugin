import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ConnectionServiceError, REASON_CODES } from '../../shared/models.js';
import type { ReasonCode } from '../../shared/models.js';

const MAX_RESPONSE = 1048576;
export interface RemoteEndpoint {
  socketPath?: string;
  host?: string;
  port?: number;
  tokenFile?: string;
}
/** Bounded JSON client for the Connector private channel. No retries: unknown outcomes stay unknown. */
export class ConnectorClient {
  constructor(private readonly endpoint: RemoteEndpoint, private readonly timeoutMs = 20000) {}
  private async token(): Promise<string | undefined> {
    if (!this.endpoint.tokenFile) return undefined;
    if (!isAbsolute(this.endpoint.tokenFile) || /^(\\\\|\/\/)/.test(this.endpoint.tokenFile)) throw new ConnectionServiceError('local_configuration_invalid');
    try {
      const value = (await readFile(this.endpoint.tokenFile, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid capability token');
      return value;
    } catch { throw new ConnectionServiceError('service_unavailable'); }
  }
  private options(path: string, method: 'GET' | 'POST', body: string, token: string | undefined): import('node:http').RequestOptions {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method === 'POST') { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)); }
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.endpoint.socketPath) return { socketPath: this.endpoint.socketPath, path, method, headers };
    return { host: this.endpoint.host ?? '127.0.0.1', port: this.endpoint.port ?? 0, path, method, headers };
  }
  call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    if (Buffer.byteLength(payload) > 65536) return Promise.reject(new ConnectionServiceError('invalid_request'));
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise<T>((resolve, reject) => {
      if (combined.aborted) { reject(new ConnectionServiceError(signal?.aborted ? 'execution_cancelled' : 'service_unavailable')); return; }
      void this.token().then(token => {
        if (combined.aborted) { reject(new ConnectionServiceError(signal?.aborted ? 'execution_cancelled' : 'service_unavailable')); return; }
        const req = request(this.options(path, body === undefined ? 'GET' : 'POST', payload, token), response => {
          const chunks: Buffer[] = []; let size = 0, overflow = false;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE) { overflow = true; req.destroy(); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            if (overflow) { reject(new ConnectionServiceError('output_limit_exceeded')); return; }
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new ConnectionServiceError('invalid_cli_output')); return; }
            const envelope = value as { ok?: unknown; value?: unknown; error?: { code?: unknown } };
            if (envelope?.ok === true) { resolve(envelope.value as T); return; }
            const code = envelope?.error?.code;
            reject(new ConnectionServiceError((REASON_CODES as readonly string[]).includes(code as string) ? code as ReasonCode : 'service_unavailable'));
          });
          response.on('error', () => reject(new ConnectionServiceError('service_unavailable')));
        });
        const abort = () => req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        combined.addEventListener('abort', abort, { once: true });
        req.setTimeout(this.timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
        req.on('error', error => {
          combined.removeEventListener('abort', abort);
          if (signal?.aborted) reject(new ConnectionServiceError(signal.reason === 'execution_timeout' ? 'execution_timeout' : 'execution_cancelled'));
          else reject(new ConnectionServiceError('service_unavailable'));
        });
        req.on('close', () => combined.removeEventListener('abort', abort));
        req.end(payload);
      }, () => reject(new ConnectionServiceError('service_unavailable')));
    });
  }
}
