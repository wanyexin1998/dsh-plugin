import type { AuthorizationContext, AuthStart, ConnectionStatus, ReasonCode, ComponentProgress, PreparationStatus } from '../shared/models.js';
import { showAuthorizationLoading } from './loading.js';
import { PromptRegistry } from './prompts.js';
export interface ClientConnection { rpc: { call(channel: '/api', endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> } }
export interface Snapshot { status: ConnectionStatus; pending: boolean; preparing?: boolean; progress?: ComponentProgress | undefined; actionRevision?: number; transaction?: AuthStart | undefined; fallback?: string | undefined; error?: ReasonCode | undefined }
const key = 'dsh-dingtalk-ui-v1';
export class ConnectionStore {
  relay(method: 'status' | 'connect' | 'disconnect' | 'configure' | 'stop', payload: object = {}) { return this.call(`relay-${method}`, payload); }
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { status: { state: 'unknown' }, pending: false };
  readonly prompts = new PromptRegistry(() => this.snapshot.actionRevision || 0);
  private browserId = '';
  private callbackOrigin = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private beginController: AbortController | undefined;
  private preparationContext: AuthorizationContext | undefined;
  private preparationStart: Promise<unknown> | undefined;
  private completing = false;
  private popup: Window | null = null;
  private closed = false;
  private generation = 0;
  private bootstrapPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private pollPromise: Promise<void> | undefined;
  private channel: BroadcastChannel | undefined;
  private focus = () => { if (this.listeners.size) void this.refresh(); };
  private message = (event: MessageEvent) => {
    if (event.origin === this.callbackOrigin && event.source === this.popup && event.data?.type === 'dsh-dingtalk:auth' && event.data?.transactionId === this.snapshot.transaction?.transactionId) void this.poll();
  };
  constructor(private connection: ClientConnection) {
    try { const cached = JSON.parse(sessionStorage.getItem(key) || '{}'); this.browserId = typeof cached.browserId === 'string' ? cached.browserId : ''; if (cached.transaction?.expiresAt && Date.parse(cached.transaction.expiresAt) > Date.now()) this.snapshot = { ...this.snapshot, transaction: cached.transaction }; } catch {}
    try { const cached = JSON.parse(sessionStorage.getItem(key) || '{}'); if (cached.preparing && !this.snapshot.transaction) { this.preparationContext = cached.context || {}; this.snapshot = { ...this.snapshot, preparing: true, pending: true }; } } catch {}
    window.addEventListener('message', this.message);
    window.addEventListener('focus', this.focus);
    if (typeof BroadcastChannel !== 'undefined') { this.channel = new BroadcastChannel('dsh-dingtalk-invalidation'); this.channel.onmessage = () => this.focus(); }
  }
  get = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearTimeout(this.timer); this.timer = undefined; } };
  };
  private set(update: Partial<Snapshot>) { if (this.closed) return; this.snapshot = { ...this.snapshot, ...update }; for (const fn of this.listeners) fn(); }
  private persist() { try { sessionStorage.setItem(key, JSON.stringify({ browserId: this.browserId, transaction: this.snapshot.transaction, preparing: this.preparationContext !== undefined, context: this.preparationContext })); } catch {} }
  private async raw(method: string, payload: object, signal = this.controller.signal): Promise<unknown> {
    const result = await this.connection.rpc.call('/api', `dsh-dingtalk/${method}`, payload, signal);
    if (!result.ok) throw Object.assign(new Error('连接请求未完成'), { reasonCode: result.error?.code || 'service_unavailable' });
    return result.value;
  }
  private async bootstrap() {
    if (!this.bootstrapPromise) this.bootstrapPromise = (async () => {
      const result = await this.raw('bootstrap', { browserId: this.browserId, context: { origin: window.location.origin, returnPath: window.location.pathname + window.location.search + window.location.hash } }) as { browserId: string; callbackOrigin: string | null };
      this.browserId = result.browserId; this.callbackOrigin = result.callbackOrigin || ''; this.persist();
    })().catch(error => { this.bootstrapPromise = undefined; throw error; });
    await this.bootstrapPromise;
  }
  private async call(method: string, payload: object = {}, signal?: AbortSignal): Promise<unknown> {
    await this.bootstrap();
    try { return await this.raw(method, { ...payload, browserId: this.browserId }, signal); }
    catch (error) {
      if ((error as { reasonCode?: string }).reasonCode === 'invalid_auth_state') {
        this.browserId = ''; this.bootstrapPromise = undefined;
        if (method === 'status') { await this.bootstrap(); return this.raw('status', { browserId: this.browserId }); }
      }
      throw error;
    }
  }
  private failure(error: unknown) { this.set({ error: (error as { reasonCode?: ReasonCode })?.reasonCode || 'service_unavailable', pending: false }); }
  private async readStatus() {
    const generation = this.generation;
    if (this.preparationStart) return; // A focus event must not observe idle before prepare-start arrives.
    if (this.preparationContext !== undefined) {
      const value = await this.call('prepare-status', {}, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)])) as PreparationStatus;
      if (generation === this.generation) await this.applyPreparation(value, generation);
      return;
    }
    const status = await this.call('status') as ConnectionStatus;
    if (generation === this.generation && !this.snapshot.transaction) {
      const keepDownloadError = status.state !== 'connected' && ['cli_download_failed', 'cli_download_timeout'].includes(this.snapshot.error || '');
      this.set({ status, ...(keepDownloadError ? {} : { error: undefined }) });
    }
  }
  private scheduleStatus() {
    if (!this.snapshot.transaction && this.listeners.size && !this.closed) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(); }, this.preparationContext !== undefined ? 1000 : 15000); }
  }
  refresh(manual = false): Promise<void> {
    if (manual) this.set({ actionRevision: (this.snapshot.actionRevision || 0) + 1 });
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try { await this.bootstrap(); if (this.snapshot.transaction) await this.poll(); else await this.readStatus(); }
      catch (error) { this.failure(error); }
    })().finally(() => { this.refreshPromise = undefined; this.scheduleStatus(); });
    return this.refreshPromise;
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.snapshot.transaction && Date.parse(this.snapshot.transaction.expiresAt) <= Date.now()) { this.set({ transaction: undefined, fallback: undefined, status: { state: 'auth_timeout', reasonCode: 'auth_timeout' } }); this.persist(); return; }
    if (!this.closed && this.listeners.size && this.snapshot.transaction && Date.parse(this.snapshot.transaction.expiresAt) > Date.now()) this.timer = setTimeout(() => { void this.poll(); }, 2000);
  }
  poll(): Promise<void> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.pollOnce().finally(() => { this.pollPromise = undefined; this.scheduleStatus(); });
    return this.pollPromise;
  }
  private async pollOnce() {
    const tx = this.snapshot.transaction;
    if (!tx || this.closed) return;
    try {
      const result = await this.call('transaction', { transactionId: tx.transactionId }) as ConnectionStatus;
      if (this.snapshot.transaction !== tx) return;
      if (result.state === 'authorizing' && Date.parse(tx.expiresAt) > Date.now()) this.set({ status: result });
      else { this.set({ transaction: undefined, fallback: undefined, status: result }); this.persist(); this.channel?.postMessage('changed'); if (result.state === 'connected' || result.state === 'user_cancelled') { await this.readStatus(); if (result.state === 'user_cancelled') this.set({ error: 'user_cancelled' }); } }
    } catch (error) { this.failure(error); if ((error as { reasonCode?: string }).reasonCode === 'invalid_auth_state') { this.set({ transaction: undefined, fallback: undefined }); this.persist(); } }
    this.schedule();
  }
  async begin(context: AuthorizationContext = {}) {
    if (this.snapshot.pending || this.snapshot.transaction) return;
    this.popup = window.open('about:blank', '_blank');
    const popup = this.popup, generation = ++this.generation;
    if (popup) { try { showAuthorizationLoading(popup); } catch {} }
    this.beginController = new AbortController();
    this.preparationContext = context;
    this.set({ pending: true, preparing: true, progress: undefined, actionRevision: (this.snapshot.actionRevision || 0) + 1, error: undefined }); this.persist();
    try {
      this.preparationStart = this.call('prepare-start', {}, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
      const value = await this.preparationStart as PreparationStatus;
      if (generation === this.generation) await this.applyPreparation(value, generation);
    } catch (error) { if (generation === this.generation) { popup?.close(); this.set({ preparing: false }); this.failure(error); } }
    finally { this.preparationStart = undefined; this.scheduleStatus(); }
  }
  private async applyPreparation(value: PreparationStatus, generation: number) {
    if (value.state === 'running') { this.set({ pending: true, preparing: true, progress: value.progress, error: undefined }); return; }
    if (value.state !== 'ready') {
      this.preparationContext = undefined; this.popup?.close();
      this.set({ pending: false, preparing: false, progress: undefined, error: value.reasonCode === 'execution_cancelled' || value.state === 'cancelled' ? 'user_cancelled' : value.reasonCode || 'cli_download_failed' }); this.persist(); return;
    }
    if (this.completing) return;
    this.completing = true;
    const popup = this.popup;
    try {
      const tx = await this.call('begin', { context: this.preparationContext || {} }, AbortSignal.any([this.beginController?.signal || this.controller.signal, this.controller.signal, AbortSignal.timeout(30000)])) as AuthStart;
      if (this.closed || generation !== this.generation) { popup?.close(); return; }
      // Re-read the trusted callback origin after preparation: the local loopback port is only
      // known once the Host has bound its listener, and the remote Connector reports its HTTPS origin.
      try {
        const origin = await this.call('callback-origin', {}) as { callbackOrigin?: string | null };
        if (typeof origin?.callbackOrigin === 'string' && origin.callbackOrigin) this.callbackOrigin = origin.callbackOrigin;
      } catch { /* older Host: fall back to the bootstrap value */ }
      const target = new URL(tx.authorizeUrl);
      // The Host is the only source of the trusted callback origin: loopback for the local
      // backend, a configured HTTPS origin for the remote Connector backend.
      const loopbackCompatible = !this.callbackOrigin && target.protocol === 'http:' && target.hostname === '127.0.0.1';
      if (target.username || target.password || target.pathname !== '/dsh-dingtalk/start' || !['http:', 'https:'].includes(target.protocol)
        || (this.callbackOrigin ? target.origin !== this.callbackOrigin : !loopbackCompatible)) throw new Error();
      this.callbackOrigin = target.origin;
      this.preparationContext = undefined;
      this.set({ pending: false, preparing: false, progress: undefined, status: { state: 'authorizing', reasonCode: 'authorization_pending' }, transaction: tx, fallback: popup && !popup.closed ? undefined : tx.authorizeUrl }); this.persist();
      if (popup && !popup.closed) popup.location.href = tx.authorizeUrl;
      this.schedule();
    } catch (error) { popup?.close(); if (generation === this.generation) { this.preparationContext = undefined; this.set({ preparing: false, progress: undefined }); this.failure(error); this.persist(); } }
    finally { this.completing = false; }
  }
  async cancel() {
    if (this.snapshot.preparing || this.preparationContext !== undefined) {
      this.beginController?.abort(); this.generation++; this.popup?.close(); this.preparationContext = undefined; this.persist();
      this.set({ pending: true, preparing: false, progress: undefined });
      try {
        await this.preparationStart?.catch(() => {});
        await this.call('prepare-cancel', {}, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]));
        this.set({ pending: false, error: 'user_cancelled', status: { state: 'unlinked', reasonCode: 'user_cancelled' } });
      } catch (error) { this.failure(error); }
      return;
    }
    const tx = this.snapshot.transaction;
    if (!tx) return;
    try {
      await this.call('cancel', { transactionId: tx.transactionId });
      this.generation++; this.popup?.close(); clearTimeout(this.timer);
      this.set({ transaction: undefined, fallback: undefined, status: { state: 'user_cancelled', reasonCode: 'user_cancelled' }, pending: false }); this.persist();
      await this.refresh();
    } catch (error) { this.failure(error); }
  }
  async previewDisconnect(): Promise<string | undefined> {
    try { return (await this.call('disconnect-preview') as { confirmation: string }).confirmation; } catch (error) { this.failure(error); return undefined; }
  }
  async disconnect(confirmation: string) {
    this.set({ pending: true, error: undefined });
    try { await this.call('disconnect-confirm', { confirmation }); this.generation++; this.set({ transaction: undefined, fallback: undefined }); this.persist(); this.channel?.postMessage('changed'); await this.refresh(); }
    catch (error) { this.failure(error); }
    finally { this.set({ pending: false }); }
  }
  dispose() { this.closed = true; this.generation++; this.controller.abort(); clearTimeout(this.timer); window.removeEventListener('message', this.message); window.removeEventListener('focus', this.focus); this.channel?.close(); this.prompts.dispose(); this.listeners.clear(); this.popup = null; }
}
