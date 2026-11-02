import type { AuthorizationContext, AuthStart, ConnectionStatus, ReasonCode } from '../shared/models.js';
export interface ClientConnection { rpc: { call(channel: '/api', endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> } }
export interface Snapshot { status: ConnectionStatus; pending: boolean; transaction?: AuthStart | undefined; fallback?: string | undefined; error?: ReasonCode | undefined }
const key = 'dsh-dingtalk-ui-v1';
export class ConnectionStore {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { status: { state: 'unknown' }, pending: false };
  private browserId = '';
  private callbackOrigin = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private popup: Window | null = null;
  private closed = false;
  private generation = 0;
  private bootstrapPromise: Promise<void> | undefined;
  private channel: BroadcastChannel | undefined;
  private focus = () => { if (this.listeners.size) void this.refresh(); };
  private message = (event: MessageEvent) => {
    if (event.origin === this.callbackOrigin && event.source === this.popup && event.data?.type === 'dsh-dingtalk:auth' && event.data?.transactionId === this.snapshot.transaction?.transactionId) void this.poll();
  };
  constructor(private connection: ClientConnection) {
    try { const cached = JSON.parse(sessionStorage.getItem(key) || '{}'); this.browserId = typeof cached.browserId === 'string' ? cached.browserId : ''; if (cached.transaction?.expiresAt && Date.parse(cached.transaction.expiresAt) > Date.now()) this.snapshot = { ...this.snapshot, transaction: cached.transaction }; } catch {}
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
  private persist() { try { sessionStorage.setItem(key, JSON.stringify({ browserId: this.browserId, transaction: this.snapshot.transaction })); } catch {} }
  private async raw(method: string, payload: object): Promise<unknown> {
    const result = await this.connection.rpc.call('/api', `dsh-dingtalk/${method}`, payload, this.controller.signal);
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
  private async call(method: string, payload: object = {}): Promise<unknown> {
    await this.bootstrap();
    try { return await this.raw(method, { ...payload, browserId: this.browserId }); }
    catch (error) {
      if ((error as { reasonCode?: string }).reasonCode === 'invalid_auth_state') {
        this.browserId = ''; this.bootstrapPromise = undefined;
        if (method === 'status') { await this.bootstrap(); return this.raw('status', { browserId: this.browserId }); }
      }
      throw error;
    }
  }
  private failure(error: unknown) { this.set({ error: (error as { reasonCode?: ReasonCode })?.reasonCode || 'service_unavailable', pending: false }); }
  async refresh() {
    try { await this.bootstrap(); if (this.snapshot.transaction) await this.poll(); else { const generation = this.generation; const status = await this.call('status') as ConnectionStatus; if (generation === this.generation && !this.snapshot.transaction) this.set({ status, error: undefined }); } }
    catch (error) { this.failure(error); }
    if (!this.snapshot.transaction && this.listeners.size && !this.closed) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(); }, 15000); }
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.snapshot.transaction && Date.parse(this.snapshot.transaction.expiresAt) <= Date.now()) { this.set({ transaction: undefined, fallback: undefined, status: { state: 'auth_timeout', reasonCode: 'auth_timeout' } }); this.persist(); return; }
    if (!this.closed && this.listeners.size && this.snapshot.transaction && Date.parse(this.snapshot.transaction.expiresAt) > Date.now()) this.timer = setTimeout(() => { void this.poll(); }, 2000);
  }
  async poll() {
    const tx = this.snapshot.transaction;
    if (!tx || this.closed) return;
    try {
      const result = await this.call('transaction', { transactionId: tx.transactionId }) as ConnectionStatus;
      if (this.snapshot.transaction !== tx) return;
      if (result.state === 'authorizing' && Date.parse(tx.expiresAt) > Date.now()) this.set({ status: result });
      else { this.set({ transaction: undefined, fallback: undefined, status: result }); this.persist(); this.channel?.postMessage('changed'); if (result.state === 'connected' || result.state === 'user_cancelled') { await this.refresh(); if (result.state === 'user_cancelled') this.set({ error: 'user_cancelled' }); } }
    } catch (error) { this.failure(error); if ((error as { reasonCode?: string }).reasonCode === 'invalid_auth_state') { this.set({ transaction: undefined, fallback: undefined }); this.persist(); } }
    this.schedule();
  }
  async begin(context: AuthorizationContext = {}) {
    if (this.snapshot.pending || this.snapshot.transaction) return;
    this.popup = window.open('about:blank', '_blank');
    const popup = this.popup, generation = ++this.generation;
    this.set({ pending: true, error: undefined });
    try {
      const tx = await this.call('begin', { context }) as AuthStart;
      if (this.closed || generation !== this.generation) { popup?.close(); return; }
      const target = new URL(tx.authorizeUrl);
      if (target.origin !== this.callbackOrigin || target.pathname !== '/dsh-dingtalk/start') throw new Error();
      this.set({ pending: false, status: { state: 'authorizing', reasonCode: 'authorization_pending' }, transaction: tx, fallback: popup ? undefined : tx.authorizeUrl }); this.persist();
      if (popup) popup.location.href = tx.authorizeUrl;
      this.schedule();
    } catch (error) { popup?.close(); this.failure(error); }
  }
  async cancel() {
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
  dispose() { this.closed = true; this.generation++; this.controller.abort(); clearTimeout(this.timer); window.removeEventListener('message', this.message); window.removeEventListener('focus', this.focus); this.channel?.close(); this.listeners.clear(); this.popup = null; }
}
