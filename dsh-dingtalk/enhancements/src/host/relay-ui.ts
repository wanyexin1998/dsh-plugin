import type { Context } from '@deepseek-ai/cordis';
import { createConnectionService } from '../shared/service.js';
import { parseConfig } from '../shared/config.js';
import { ConnectionServiceError } from '../shared/models.js';
import type { AuthorizationContext, CallOptions, DingtalkBackend, InvokeInput, InvokeResult } from '../shared/models.js';
import type { ManagedConnection } from './managed-connection.js';
import { createUIRpc } from './ui-rpc.js';
import type { HostConnection, RelayControl } from './ui-rpc.js';
import type { BrowserContext } from './oauth.js';
import { createRemoteConnectionFor } from '../adapters/remote/index.js';

/**
 * Settings-page relay routes only. This entry does not provide `dingtalkImTools`
 * and does not start the DWS managed runtime. Cellgent keeps the seat identity
 * file on the existing provider; `createManagedConnection` is not called.
 */
export const name = 'dsh-dingtalk-relay-ui';

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Browser origin for the settings page. Loopback stays allowed. A public page
 * must be HTTPS on `CELLGENT_PUBLIC_HOST` exactly; other origins are rejected.
 * @param input - bootstrap `origin` and `returnPath` from the page.
 * @param env - process environment. Tests pass a fixture; production uses `process.env`.
 * @returns the checked origin and return path.
 */
export function cellgentPageContext(input: unknown, env: NodeJS.ProcessEnv = process.env): BrowserContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionServiceError('invalid_request');
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'origin' && key !== 'returnPath') || typeof data.origin !== 'string' || typeof data.returnPath !== 'string' || data.returnPath.length > 2048) throw new ConnectionServiceError('invalid_request');
  if (!data.returnPath.startsWith('/') || data.returnPath.startsWith('//') || /[\\\u0000-\u001f]/.test(data.returnPath)) throw new ConnectionServiceError('invalid_request');
  let url: URL;
  try { url = new URL(data.origin); } catch { throw new ConnectionServiceError('invalid_request'); }
  if (url.origin !== data.origin || url.username || url.password) throw new ConnectionServiceError('invalid_request');
  const host = (env.CELLGENT_PUBLIC_HOST ?? '').trim();
  const local = (url.protocol === 'http:' || url.protocol === 'https:') && loopback.has(url.hostname);
  const published = url.protocol === 'https:' && host.length > 0 && host.length <= 253 && url.host.toLowerCase() === host.toLowerCase();
  if (!local && !published) throw new ConnectionServiceError('invalid_request');
  const back = new URL(data.returnPath, url);
  if (back.protocol !== url.protocol || back.host !== url.host || back.username || back.password || back.origin !== url.origin) throw new ConnectionServiceError('invalid_request');
  if ([...back.searchParams.keys()].some(key => /token|code|secret/i.test(key)) || /[#?&](?:token|code|authCode|secret)=/i.test(back.hash)) throw new ConnectionServiceError('invalid_request');
  return { origin: url.origin, returnPath: back.pathname + back.search + back.hash };
}

function relaySurface(env: NodeJS.ProcessEnv): ManagedConnection {
  const backend: DingtalkBackend = {
    mode: 'local',
    async status() { return { state: 'unlinked', reasonCode: 'not_connected' }; },
    async beginAuthorization(_context: AuthorizationContext, _options?: CallOptions): Promise<never> { throw new ConnectionServiceError('oauth_not_configured'); },
    async getAuthorizationStatus(_id: string): Promise<never> { throw new ConnectionServiceError('not_connected'); },
    async disconnect() { return { disconnected: false }; },
    async invoke(_input: InvokeInput, _options?: CallOptions): Promise<InvokeResult> { return { status: 'auth_required', reasonCode: 'not_connected' }; },
    dispose() {},
  };
  return {
    backend,
    async invokeFor() { return { status: 'auth_required', reasonCode: 'not_connected' }; },
    ui: async (_browser, _context, action) => action(),
    cancel() { throw new ConnectionServiceError('not_connected'); },
    prepareStart() { throw new ConnectionServiceError('oauth_not_configured'); },
    prepareStatus: () => ({ state: 'idle' }),
    async prepareCancel() { return { state: 'cancelled', reasonCode: 'user_cancelled' }; },
    revision: () => 0,
    identity: () => undefined,
    context: input => cellgentPageContext(input, env),
  };
}

/**
 * Register settings-page routes for the robot and for data authorization.
 * Config is `{ mode }` only. `mode: cellgent` still throws. `local` answers
 * data authorization as not connected and does not start DWS. `connector`
 * uses the private Connector socket from the process environment. This entry
 * never reads `robotConnection` and never provides `dingtalkImTools`.
 * @param ctx - host context.
 * @param config - plugin config, `{ mode?: 'local' | 'connector' }`.
 */
export async function apply(ctx: Context, config: unknown): Promise<void> {
  const parsed = parseConfig(config == null ? {} : config);
  const managed = parsed.mode === 'connector'
    ? await createRemoteConnectionFor(process.env, parsed.execution)
    : relaySurface(process.env);
  const owner = createConnectionService(managed.backend);
  ctx.effect(() => () => { void owner.dispose(); });
  ctx.inject(['connection', 'webServer'], (scope: Context) => {
    const connection = scope.get('connection') as HostConnection;
    scope.effect(() => createUIRpc(connection, managed, owner.service, () => scope.get('dingtalkRelay') as RelayControl | undefined));
  });
}
