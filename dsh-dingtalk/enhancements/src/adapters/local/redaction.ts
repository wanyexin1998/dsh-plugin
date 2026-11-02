import type { JsonValue } from '../../shared/models.js';
import { ConnectionServiceError } from '../../shared/models.js';

const sensitive = /^(accessToken|refreshToken|idToken|token|authCode|clientSecret|appSecret|password|cookie|authorization|credentialPath|profileRef)$/i;
function cleanString(value: string): string {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|auth[_-]?code|client[_-]?secret|app[_-]?secret)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
}
export function redactData(value: unknown): JsonValue {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): JsonValue => {
    if (++nodes > 10000 || depth > 32) throw new ConnectionServiceError('invalid_cli_output');
    if (entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'string') return cleanString(entry);
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(item => visit(item, depth + 1));
    if (!entry || typeof entry !== 'object') throw new ConnectionServiceError('invalid_cli_output');
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !sensitive.test(key.replaceAll('_', '').replaceAll('-', '')))
      .map(([key, data]) => [key, visit(data, depth + 1)]));
  };
  return visit(value, 0);
}
