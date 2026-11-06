import type { AuthorizationContext, AuthStart, ConnectionStatus, ReasonCode, ComponentProgress, PreparationStatus } from '../shared/models.js';
import { showAuthorizationLoading } from './loading.js';
import { PromptRegistry } from './prompts.js';
export interface ClientConnection { rpc: { call(channel: '/api', endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> } }
export interface Snapshot {
  status: ConnectionStatus;
  /** A status attempt has finished, including an unsuccessful first attempt. */
  checked: boolean;
  refreshing: boolean;
  /** Last successful Host status response; never advanced by a failed read. */
  checkedAt?: string | undefined;
  refreshError?: ReasonCode | undefined;
  /** Authorization, preparation and destructive actions, not background reads. */
  pending: boolean;
  preparing?: boolean; progress?: ComponentProgress | undefined; actionRevision?: number;
  transaction?: AuthStart | undefined; fallback?: string | undefined; error?: ReasonCode | undefined;
}
const key = 'dsh-dingtalk-ui-v1';
interface ProvisionalAuthorization { generation: number; transaction: AuthStart; cancellation?: Promise<unknown> | undefined }
const readFailureReasons: readonly ReasonCode[] = ['service_unavailable', 'connection_unknown', 'backend_not_ready', 'execution_timeout', 'execution_cancelled', 'queue_full', 'queue_timeout', 'output_limit_exceeded', 'invalid_cli_output', 'cli_failed', 'token_refresh_pending', 'rate_limited'];
function reason(error: unknown): ReasonCode {
  return (error as { reasonCode?: ReasonCode })?.reasonCode || ((error as Error)?.name === 'TimeoutError' ? 'execution_timeout' : 'service_unavailable');
}
/** Bound the UI even when an RPC transport does not settle after its signal aborts. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export class ConnectionStore {
  relay(method: 'status' | 'connect' | 'disconnect' | 'configure' | 'stop', payload: object = {}) { return this.call(`relay-${method}`, payload); }
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { status: { state: 'unknown' }, checked: false, refreshing: false, pending: false };
  readonly prompts = new PromptRegistry(() => this.snapshot.actionRevision || 0);
  private browserId = '';
  private callbackOrigin = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private beginController: AbortController | undefined;
  private readController: AbortController | undefined;
  private pollController: AbortController | undefined;
  private preparationContext: AuthorizationContext | undefined;
  private preparationStart: Promise<unknown> | undefined;
  private completing: number | undefined;
  private provisionalAuthorization: ProvisionalAuthorization | undefined;
  private mutating = false;
  private popup: Window | null = null;
  private closed = false;
  private generation = 0;
  private bootstrapPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private pollPromise: Promise<void> | undefined;
  private previewPromise: Promise<string | undefined> | undefined;
  private channel: BroadcastChannel | undefined;
  private focus = () => { if (this.listeners.size) void this.refresh(); };
  private message = (event: MessageEvent) => {
    if (this.snapshot.transaction && event.origin === this.callbackOrigin && event.source === this.popup && event.data?.type === 'dsh-dingtalk:auth' && event.data?.transactionId === this.snapshot.transaction.transactionId) void this.poll();
  };
  constructor(private connection: ClientConnection) {
    try { const cached = JSON.parse(sessionStorage.getItem(key) || '{}'); this.browserId = typeof cached.browserId === 'string' ? cached.browserId : ''; if (cached.transaction?.expiresAt && Date.parse(cached.transaction.expiresAt) > Date.now()) this.snapshot = { ...this.snapshot, transaction: cached.transaction, status: { state: 'authorizing', reasonCode: 'authorization_pending' } }; } catch {}
    try { const cached = JSON.parse(sessionStorage.getItem(key) || '{}'); if (cached.preparing && !this.snapshot.transaction) { this.preparationContext = cached.context || {}; this.snapshot = { ...this.snapshot, preparing: true, pending: true }; } } catch {}
    window.addEventListener('message', this.message);
    window.addEventListener('focus', this.focus);
    if (typeof BroadcastChannel !== 'undefined') { this.channel = new BroadcastChannel('dsh-dingtalk-invalidation'); this.channel.onmessage = () => { this.invalidateReads(); this.focus(); }; }
  }
  get = () => this.snapshot;
  subscribe = (listener: () => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.refresh();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.invalidateReads(); };
  };
  private current(generation: number) { return !this.closed && generation === this.generation; }
  private set(update: Partial<Snapshot>) { if (this.closed) return; this.snapshot = { ...this.snapshot, ...update }; for (const fn of this.listeners) fn(); }
  private persist() { if (this.closed) return; try { sessionStorage.setItem(key, JSON.stringify({ browserId: this.browserId, transaction: this.snapshot.transaction, preparing: this.preparationContext !== undefined, context: this.preparationContext })); } catch {} }
  private bounded(signal = this.controller.signal, milliseconds = 15000) { return AbortSignal.any([this.controller.signal, signal, AbortSignal.timeout(milliseconds)]); }
  private invalidateReads() {
    clearTimeout(this.timer); this.timer = undefined;
    this.readController?.abort(); this.pollController?.abort();
    this.readController = undefined; this.pollController = undefined;
    this.refreshPromise = undefined; this.pollPromise = undefined;
    this.set({ refreshing: false });
  }
  private async raw(method: string, payload: object, signal = this.controller.signal): Promise<unknown> {
    signal.throwIfAborted();
    const result = await withSignal(this.connection.rpc.call('/api', `dsh-dingtalk/${method}`, payload, signal), signal);
    signal.throwIfAborted();
    if (!result.ok) throw Object.assign(new Error('连接请求未完成'), { reasonCode: result.error?.code || 'service_unavailable' });
    return result.value;
  }
  private async bootstrap() {
    if (!this.bootstrapPromise) this.bootstrapPromise = (async () => {
      const result = await this.raw('bootstrap', { browserId: this.browserId, context: { origin: window.location.origin, returnPath: window.location.pathname + window.location.search + window.location.hash } }, this.bounded()) as { browserId: string; callbackOrigin: string | null };
      this.browserId = result.browserId; this.callbackOrigin = result.callbackOrigin || ''; this.persist();
    })().catch(error => { this.bootstrapPromise = undefined; throw error; });
    await this.bootstrapPromise;
  }
  private async call(method: string, payload: object = {}, signal = this.controller.signal): Promise<unknown> {
    signal.throwIfAborted();
    await withSignal(this.bootstrap(), signal);
    const browserId = this.browserId, bootstrap = this.bootstrapPromise;
    try { return await this.raw(method, { ...payload, browserId }, signal); }
    catch (error) {
      if (!signal.aborted && (error as { reasonCode?: string }).reasonCode === 'invalid_auth_state') {
        if (browserId === this.browserId && bootstrap === this.bootstrapPromise) { this.browserId = ''; this.bootstrapPromise = undefined; }
        if (method === 'status') { await withSignal(this.bootstrap(), signal); return this.raw('status', { browserId: this.browserId }, signal); }
      }
      throw error;
    }
  }
  private failure(error: unknown) { this.set({ error: reason(error), pending: false }); }
  private confirmed(status: ConnectionStatus) {
    const keepDownloadError = ['unlinked', 'unknown'].includes(status.state)
      && (!status.reasonCode || ['not_connected', 'connection_unknown'].includes(status.reasonCode))
      && ['cli_download_failed', 'cli_download_timeout'].includes(this.snapshot.error || '');
    this.set({ status, checked: true, checkedAt: status.checkedAt || new Date().toISOString(), refreshError: undefined, ...(keepDownloadError ? {} : { error: undefined }) });
  }
  private acceptStatus(status: ConnectionStatus): boolean {
    // Both backends can encode a failed read inside a successful RPC envelope.
    const readFailure = status.reasonCode || 'connection_unknown';
    if (status.state === 'service_unavailable' || (status.state === 'unknown' && readFailureReasons.includes(readFailure))) {
      this.set({ checked: true, refreshError: status.state === 'service_unavailable' ? 'service_unavailable' : readFailure });
      return false;
    }
    this.confirmed(status); return true;
  }
  private async readStatus(generation: number, signal: AbortSignal) {
    if (this.preparationStart || this.mutating) return; // Focus must not observe idle before prepare-start arrives.
    if (this.preparationContext !== undefined) {
      const value = await this.call('prepare-status', {}, this.bounded(signal)) as PreparationStatus;
      if (this.current(generation) && !signal.aborted) await this.applyPreparation(value, generation);
      return;
    }
    const status = await this.call('status', {}, this.bounded(signal)) as ConnectionStatus;
    if (this.current(generation) && !signal.aborted && !this.snapshot.transaction) this.acceptStatus(status);
  }
  private scheduleStatus() {
    if (!this.snapshot.transaction && this.listeners.size && !this.closed && !this.mutating) { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh(); }, this.preparationContext !== undefined ? 1000 : 15000); }
  }
  refresh(manual = false): Promise<void> {
    if (this.closed || this.mutating) return Promise.resolve();
    if (manual) this.set({ actionRevision: (this.snapshot.actionRevision || 0) + 1 });
    if (this.snapshot.transaction) return this.poll();
    // A terminal transaction's Host recheck shares the same refresh lane.
    if (this.pollPromise) return this.pollPromise;
    if (this.refreshPromise) return this.refreshPromise;
    if (this.preparationStart) return Promise.resolve();
    const generation = this.generation, controller = new AbortController(), preparing = this.preparationContext !== undefined;
    this.readController = controller;
    if (!preparing) this.set({ refreshing: true });
    const promise = (async () => {
      try { await this.readStatus(generation, controller.signal); }
      catch (error) {
        if (this.current(generation) && !controller.signal.aborted) {
          if (preparing) this.failure(error);
          else this.set({ checked: true, refreshError: reason(error) });
        }
      }
    })().finally(() => {
      if (this.refreshPromise === promise) { this.refreshPromise = undefined; this.readController = undefined; this.set({ refreshing: false }); this.scheduleStatus(); }
    });
    this.refreshPromise = promise;
    return promise;
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.snapshot.transaction && Date.parse(this.snapshot.transaction.expiresAt) <= Date.now()) { this.set({ transaction: undefined, fallback: undefined, status: { state: 'auth_timeout', reasonCode: 'auth_timeout' } }); this.persist(); this.scheduleStatus(); return; }
    if (!this.closed && this.listeners.size && this.snapshot.transaction && !this.mutating) this.timer = setTimeout(() => { void this.poll(); }, 2000);
  }
  poll(): Promise<void> {
    if (this.closed || this.mutating || !this.snapshot.transaction) return Promise.resolve();
    if (this.pollPromise) return this.pollPromise;
    const controller = new AbortController(); this.pollController = controller;
    this.set({ refreshing: true });
    const promise = this.pollOnce(this.generation, controller.signal).finally(() => {
      if (this.pollPromise === promise) { this.pollPromise = undefined; this.pollController = undefined; this.set({ refreshing: false }); this.schedule(); this.scheduleStatus(); }
    });
    this.pollPromise = promise;
    return promise;
  }
  private async pollOnce(generation: number, signal: AbortSignal) {
    const tx = this.snapshot.transaction;
    if (!tx) return;
    try {
      let result = await this.call('transaction', { transactionId: tx.transactionId }, this.bounded(signal)) as ConnectionStatus;
      if (!this.current(generation) || signal.aborted || this.snapshot.transaction !== tx) return;
      if (result.state === 'authorizing' && Date.parse(tx.expiresAt) <= Date.now()) result = { state: 'auth_timeout', reasonCode: 'auth_timeout' };
      if (!this.acceptStatus(result)) return;
      if (result.state !== 'authorizing') {
        this.set({ transaction: undefined, fallback: undefined }); this.persist(); this.channel?.postMessage('changed');
        if (result.state === 'connected' || result.state === 'user_cancelled') {
          await this.readStatus(generation, signal);
          if (this.current(generation) && !signal.aborted && result.state === 'user_cancelled') this.set({ error: 'user_cancelled' });
        }
      }
    } catch (error) {
      if (!this.current(generation) || signal.aborted) return;
      this.set({ checked: true, refreshError: reason(error) });
      if (reason(error) === 'invalid_auth_state') { this.set({ transaction: undefined, fallback: undefined, status: { state: 'unknown', reasonCode: 'invalid_auth_state' } }); this.persist(); }
    }
  }
  async begin(context: AuthorizationContext = {}) {
    if (this.closed || this.snapshot.pending || this.snapshot.transaction) return;
    const generation = ++this.generation; this.invalidateReads();
    this.popup = window.open('about:blank', '_blank');
    const popup = this.popup;
    if (popup) { try { showAuthorizationLoading(popup); } catch {} }
    this.beginController = new AbortController();
    this.preparationContext = context;
    this.set({ pending: true, preparing: true, progress: undefined, actionRevision: (this.snapshot.actionRevision || 0) + 1, error: undefined, refreshError: undefined }); this.persist();
    const start = this.call('prepare-start', {}, this.bounded()); this.preparationStart = start;
    try {
      const value = await start as PreparationStatus;
      if (this.current(generation)) await this.applyPreparation(value, generation);
    } catch (error) { if (this.current(generation)) { popup?.close(); this.set({ preparing: false }); this.failure(error); } }
    finally { if (this.preparationStart === start) this.preparationStart = undefined; this.scheduleStatus(); }
  }
  private cancelProvisional(provisional: ProvisionalAuthorization): Promise<unknown> {
    if (!provisional.cancellation) {
      const cancellation = this.call('cancel', { transactionId: provisional.transaction.transactionId }, this.bounded()).catch(error => {
        if (provisional.cancellation === cancellation) provisional.cancellation = undefined;
        throw error;
      });
      provisional.cancellation = cancellation;
    }
    return provisional.cancellation;
  }
  private async applyPreparation(value: PreparationStatus, generation: number) {
    if (!this.current(generation)) return;
    if (value.state === 'running') { this.set({ pending: true, preparing: true, progress: value.progress, error: undefined }); return; }
    if (value.state !== 'ready') {
      this.preparationContext = undefined; this.popup?.close();
      this.set({ pending: false, preparing: false, progress: undefined, error: value.reasonCode === 'execution_cancelled' || value.state === 'cancelled' ? 'user_cancelled' : value.reasonCode || 'cli_download_failed' }); this.persist(); return;
    }
    if (this.completing === generation) return;
    this.completing = generation;
    const popup = this.popup, signal = this.bounded(this.beginController?.signal, 30000);
    let provisional: ProvisionalAuthorization | undefined;
    try {
      const tx = await this.call('begin', { context: this.preparationContext || {} }, signal) as AuthStart;
      if (!this.current(generation)) { popup?.close(); return; }
      // A Host transaction exists before the callback origin has been validated.
      // Keep it cancellable even while the UI still displays preparation.
      this.provisionalAuthorization = provisional = { generation, transaction: tx };
      // Host supplies the exact callback origin: local loopback or Connector HTTPS.
      let callbackOrigin = this.callbackOrigin;
      try {
        const origin = await this.call('callback-origin', {}, this.bounded(signal)) as { callbackOrigin?: string | null };
        if (typeof origin?.callbackOrigin === 'string' && origin.callbackOrigin) callbackOrigin = origin.callbackOrigin;
      } catch { /* older Host: fall back to the bootstrap value */ }
      if (!this.current(generation)) { popup?.close(); return; }
      signal.throwIfAborted();
      const target = new URL(tx.authorizeUrl);
      const loopbackCompatible = !callbackOrigin && target.protocol === 'http:' && target.hostname === '127.0.0.1';
      if (target.username || target.password || target.pathname !== '/dsh-dingtalk/start' || !['http:', 'https:'].includes(target.protocol)
        || (callbackOrigin ? target.origin !== callbackOrigin : !loopbackCompatible)) throw new Error();
      this.callbackOrigin = target.origin;
      if (this.provisionalAuthorization === provisional) this.provisionalAuthorization = undefined;
      this.preparationContext = undefined;
      this.set({ pending: false, preparing: false, progress: undefined, status: { state: 'authorizing', reasonCode: 'authorization_pending' }, transaction: tx, fallback: popup && !popup.closed ? undefined : tx.authorizeUrl }); this.persist();
      if (popup && !popup.closed) popup.location.href = tx.authorizeUrl;
      this.schedule();
    } catch (error) {
      popup?.close();
      if (this.current(generation)) {
        let cleanupError: unknown;
        if (provisional) {
          try { await this.cancelProvisional(provisional); } catch (failure) { cleanupError = failure; }
          if (this.current(generation) && this.provisionalAuthorization === provisional) this.provisionalAuthorization = undefined;
        }
        if (this.current(generation)) {
          this.preparationContext = undefined;
          // If cleanup cannot be confirmed, retain the transaction for Host polling/cancel,
          // but never expose or navigate to the rejected authorization URL.
          this.set({ preparing: false, progress: undefined, ...(cleanupError && provisional ? { transaction: provisional.transaction, fallback: undefined, refreshError: reason(cleanupError) } : {}) });
          this.failure(error); this.persist();
          if (cleanupError) this.schedule();
        }
      }
    }
    finally { if (this.completing === generation) this.completing = undefined; }
  }
  async cancel() {
    if (this.closed || this.mutating) return;
    const provisional = this.provisionalAuthorization?.generation === this.generation ? this.provisionalAuthorization : undefined;
    const preparing = this.snapshot.preparing || this.preparationContext !== undefined, tx = this.snapshot.transaction || provisional?.transaction;
    if (!preparing && !tx) return;
    this.mutating = true; const generation = ++this.generation; this.invalidateReads();
    let cancelled = false;
    this.beginController?.abort(); this.popup?.close();
    this.set({ pending: true, preparing: false, progress: undefined, error: undefined, actionRevision: (this.snapshot.actionRevision || 0) + 1 });
    try {
      let preparationError: unknown;
      if (preparing) {
        this.preparationContext = undefined; this.persist();
        await this.preparationStart?.catch(() => {});
        try { await this.call('prepare-cancel', {}, this.bounded()); } catch (error) { preparationError = error; }
      }
      // Remote prepare-cancel stops preparation only; cancel its known OAuth transaction too.
      if (tx) {
        if (provisional) await this.cancelProvisional(provisional);
        else await this.call('cancel', { transactionId: tx.transactionId }, this.bounded());
      }
      if (this.provisionalAuthorization === provisional) this.provisionalAuthorization = undefined;
      if (preparationError) throw preparationError;
      if (!this.current(generation)) return;
      this.set({ transaction: undefined, fallback: undefined, status: { state: 'user_cancelled', reasonCode: 'user_cancelled' }, checked: true, error: 'user_cancelled', refreshError: undefined }); this.persist(); cancelled = true;
    } catch (error) {
      if (this.current(generation)) {
        if (provisional && this.provisionalAuthorization === provisional) { this.provisionalAuthorization = undefined; this.set({ transaction: provisional.transaction, fallback: undefined }); this.persist(); }
        this.failure(error);
      }
    }
    finally {
      this.mutating = false;
      if (this.current(generation)) { this.set({ pending: false }); this.schedule(); this.scheduleStatus(); }
    }
    if (cancelled && !preparing && this.current(generation)) { await this.refresh(); if (this.current(generation)) this.set({ error: 'user_cancelled' }); }
  }
  previewDisconnect(): Promise<string | undefined> {
    if (this.closed || this.snapshot.pending) return Promise.resolve(undefined);
    if (this.previewPromise) return this.previewPromise;
    const generation = this.generation;
    const promise = (async () => {
      try { const result = await this.call('disconnect-preview', {}, this.bounded()) as { confirmation: string }; return this.current(generation) ? result.confirmation : undefined; }
      catch (error) { if (this.current(generation)) this.failure(error); return undefined; }
    })().finally(() => { if (this.previewPromise === promise) this.previewPromise = undefined; });
    this.previewPromise = promise; return promise;
  }
  async disconnect(confirmation: string) {
    if (this.closed || this.snapshot.pending || this.mutating) return;
    let disconnected = false;
    this.mutating = true; const generation = ++this.generation; this.invalidateReads();
    this.set({ pending: true, error: undefined, actionRevision: (this.snapshot.actionRevision || 0) + 1 });
    try {
      const result = await this.call('disconnect-confirm', { confirmation }, this.bounded()) as { disconnected: boolean };
      if (!this.current(generation)) return;
      if (result?.disconnected !== true) throw Object.assign(new Error('解除未完成'), { reasonCode: 'revocation_failed' });
      // The successful mutation is authoritative even when the follow-up read fails.
      this.set({ transaction: undefined, fallback: undefined }); this.confirmed({ state: 'unlinked', reasonCode: 'not_connected' }); this.persist(); this.channel?.postMessage('changed'); disconnected = true;
    } catch (error) {
      if (this.current(generation)) {
        // Host blocks business calls after a partial revocation; old connected is no longer valid.
        if (reason(error) === 'revocation_failed') this.confirmed({ state: 'unknown', reasonCode: 'revocation_failed' });
        this.failure(error);
      }
    }
    finally {
      this.mutating = false;
      if (this.current(generation)) { this.set({ pending: false }); this.scheduleStatus(); }
    }
    if (disconnected && this.current(generation)) await this.refresh();
  }
  dispose() { if (this.closed) return; this.closed = true; this.generation++; this.controller.abort(); this.beginController?.abort(); this.invalidateReads(); window.removeEventListener('message', this.message); window.removeEventListener('focus', this.focus); this.channel?.close(); this.prompts.dispose(); this.listeners.clear(); this.popup = null; this.provisionalAuthorization = undefined; }
}
