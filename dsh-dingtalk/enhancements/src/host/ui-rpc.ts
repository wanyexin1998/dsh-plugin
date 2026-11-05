import { randomBytes } from 'node:crypto';
import type { DingtalkConnectionService } from '../shared/models.js';
import { ConnectionServiceError } from '../shared/models.js';
import { browserContext } from './oauth.js';
import type { BrowserContext } from './oauth.js';
import type { ManagedConnection } from './managed-connection.js';

interface BrowserSession { peer: string; context: BrowserContext; expires: number; confirmation?: { token: string; revision: number; expires: number } }
interface Peer { id: string; principal: { kind: string } }
interface RpcResult { ok: boolean; value?: unknown; error?: { code: string; message: string; details: object } }
export interface HostConnection {
  browserPeer: Peer;
  admit(request: Request): { peer: Peer } | { rejection: number };
  fetch: { register(route: { path: string; methods: readonly ['POST']; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => Promise<void> };
}
const token = () => randomBytes(32).toString('base64url');
function request(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new ConnectionServiceError('invalid_request');
  return value as Record<string, unknown>;
}
export interface RelayControl { status(): unknown; connect(url?: string): Promise<unknown>; configure?(data: { clientId: string; clientSecret: string }): Promise<unknown>; stopHosting?(): Promise<unknown>; disconnect(): Promise<void> }
export function createUIRpc(connection: HostConnection, managed: ManagedConnection, service: DingtalkConnectionService, relay: () => RelayControl | undefined = () => undefined) {
  const sessions = new Map<string, BrowserSession>();
  const handle = async (endpoint: string, input: unknown, signal: AbortSignal, peer: Peer): Promise<RpcResult> => {
    try {
      // Even an API owner Peer is not the browser carrier. No identity in JSON can widen this.
      if (peer.id !== connection.browserPeer.id || peer.principal.kind !== 'owner' || signal.aborted) throw new ConnectionServiceError('invalid_request');
      const method = endpoint;
      if (method === 'bootstrap') {
        const data = request(input, ['browserId', 'context']);
        const context = browserContext(data.context);
        for (const [id, session] of sessions) if (session.expires < Date.now()) sessions.delete(id);
        let id = typeof data.browserId === 'string' ? data.browserId : '';
        const current = sessions.get(id);
        if (!current || current.peer !== peer.id || current.context.origin !== context.origin) {
          if (sessions.size >= 64) throw new ConnectionServiceError('queue_full');
          id = token();
        }
        sessions.set(id, { peer: peer.id, context, expires: Date.now() + 8 * 3600000 });
        const callbackOrigin = managed.callbackOriginReady ? await managed.callbackOriginReady() : managed.callbackOrigin;
        return { ok: true, value: { browserId: id, callbackOrigin: callbackOrigin ?? null } };
      }
      const keys = method === 'relay-configure' ? ['browserId', 'clientId', 'clientSecret'] : method === 'relay-connect' ? ['browserId', 'url'] : method === 'begin' ? ['browserId', 'context'] : method === 'transaction' || method === 'cancel' ? ['browserId', 'transactionId'] : method === 'disconnect-confirm' ? ['browserId', 'confirmation'] : ['browserId'];
      const data = request(input, keys);
      const id = typeof data.browserId === 'string' ? data.browserId : '';
      const browser = sessions.get(id);
      if (!browser || browser.peer !== peer.id || browser.expires < Date.now()) throw new ConnectionServiceError('invalid_auth_state');
      return await managed.ui(id, browser.context, async () => {
        let value: unknown;
        switch (method) {
          case 'callback-origin': {
            const origin = managed.callbackOriginReady ? await managed.callbackOriginReady() : undefined;
            value = { callbackOrigin: origin ?? managed.callbackOrigin ?? null }; break;
          }
          case 'relay-status': value = relay()?.status() ?? { status: 'unavailable' }; break;
          case 'relay-connect': {
            if (data.url !== undefined && (typeof data.url !== 'string' || data.url.length > 2048)) throw new ConnectionServiceError('invalid_request');
            const control = relay(); if (!control) throw new ConnectionServiceError('service_unavailable');
            value = await control.connect(data.url as string | undefined); break;
          }
          case 'relay-configure': {
            if (typeof data.clientId !== 'string' || typeof data.clientSecret !== 'string' || !relay()?.configure) throw new ConnectionServiceError('invalid_request');
            value = await relay()!.configure!({ clientId: data.clientId, clientSecret: data.clientSecret }); break;
          }
          case 'relay-stop': { if (!relay()?.stopHosting) throw new ConnectionServiceError('invalid_request'); value = await relay()!.stopHosting!(); break; }
          case 'relay-disconnect': await relay()?.disconnect(); value = { status: 'disconnected' }; break;
          case 'status': value = await service.status({ signal }); break;
          case 'prepare-start': value = managed.prepareStart(); break;
          case 'prepare-status': value = managed.prepareStatus(); break;
          case 'prepare-cancel': value = await managed.prepareCancel(); break;
          case 'begin': value = await service.beginAuthorization(data.context === undefined ? {} : data.context as {}, { signal }); break;
          case 'transaction':
            if (typeof data.transactionId !== 'string') throw new ConnectionServiceError('invalid_request');
            value = await service.getAuthorizationStatus(data.transactionId); break;
          case 'cancel':
            if (typeof data.transactionId !== 'string') throw new ConnectionServiceError('invalid_request');
            value = await managed.cancel(data.transactionId, id); break;
          case 'disconnect-preview':
            browser.confirmation = { token: token(), revision: managed.revision(), expires: Date.now() + 30000 };
            value = { confirmation: browser.confirmation.token }; break;
          case 'disconnect-confirm': {
            const confirmation = browser.confirmation;
            delete browser.confirmation;
            if (!confirmation || confirmation.token !== data.confirmation || confirmation.expires < Date.now() || confirmation.revision !== managed.revision()) throw new ConnectionServiceError('invalid_auth_state');
            value = await service.disconnect(); break;
          }
          default: throw new ConnectionServiceError('invalid_request');
        }
        return { ok: true, value };
      });
    } catch (error) {
      const known = ['auth_required', 'identity_mismatch', 'invalid_credentials', 'robot_busy', 'robot_not_configured', 'enterprise_configuration_invalid', 'enterprise_managed', 'stop_before_configure', 'gateway_in_use', 'device_in_use', 'mode_conflict'];
      const code = error instanceof ConnectionServiceError ? error.reasonCode : error instanceof Error && known.includes(error.message) ? error.message : 'service_unavailable';
      return { ok: false, error: { code, message: code, details: {} } };
    }
  };
  // Public exact routes coexist with the native Gateway's single /api interceptor.
  // DSH applies authenticated admission/body limits first; re-read the actual Peer
  // because an owner API credential is deliberately not a human browser carrier.
  const methods = ['bootstrap', 'callback-origin', 'status', 'prepare-start', 'prepare-status', 'prepare-cancel', 'begin', 'transaction', 'cancel', 'disconnect-preview', 'disconnect-confirm', 'relay-status', 'relay-connect', 'relay-disconnect', 'relay-configure', 'relay-stop'];
  const registrations = methods.map(method => connection.fetch.register({
    path: `/api/dsh-dingtalk/${method}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const admission = connection.admit(request);
      if ('rejection' in admission) return new Response(null, { status: admission.rejection });
      let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
      try { const body = await request.text(); if (Buffer.byteLength(body, 'utf8') > 16384) return new Response(null, { status: 413 }); envelope = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
      if (!envelope || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(envelope.rpcId) || envelope.method !== `dsh-dingtalk/${method}` || Object.keys(envelope).some(key => !['type', 'rpcId', 'method', 'payload'].includes(key))) return new Response(null, { status: 400 });
      const result = await handle(method, envelope.payload, request.signal, admission.peer);
      return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
    },
  }));
  return async () => { sessions.clear(); await Promise.all(registrations.map(dispose => dispose())); };
}
