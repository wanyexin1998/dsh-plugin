import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthStart, ConnectionStatus } from '../shared/models.js';
import { ConnectionServiceError } from '../shared/models.js';
import type { OAuthSettings } from './private-settings.js';

const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();
interface Transaction {
  id: string; owner: string; state: string; ticket: string; proof: string; nonce: string;
  expires: number; started: boolean; consumed: boolean; result: ConnectionStatus;
  origin: string; returnUrl: string; revision: number; controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
export interface AuthOperations {
  revision(): number;
  exchange(code: string, revision: number, signal: AbortSignal): Promise<ConnectionStatus>;
}
export interface BrowserContext { origin: string; returnPath: string }
export function browserContext(input: unknown): BrowserContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionServiceError('invalid_request');
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !['origin', 'returnPath'].includes(key)) || typeof data.origin !== 'string' || typeof data.returnPath !== 'string' || data.returnPath.length > 2048) throw new ConnectionServiceError('invalid_request');
  if (data.origin === 'null') return { origin: 'null', returnPath: '' };
  const url = new URL(data.origin);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.origin !== data.origin) throw new ConnectionServiceError('invalid_request');
  if (!data.returnPath.startsWith('/') || data.returnPath.startsWith('//') || /[\\\u0000-\u001f]/.test(data.returnPath)) throw new ConnectionServiceError('invalid_request');
  const back = new URL(data.returnPath, url);
  if (back.origin !== url.origin || [...back.searchParams.keys()].some(key => /token|code|secret/i.test(key)) || /[?&](?:token|code|authCode|secret)=/i.test(back.hash)) throw new ConnectionServiceError('invalid_request');
  return { origin: url.origin, returnPath: back.pathname + back.search + back.hash };
}
const escapeHtml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export class OAuthController {
  get origin() { return this.callback.origin; }
  private transactions = new Map<string, Transaction>();
  private server: Server | undefined;
  private listening: Promise<void> | undefined;
  private closed = false;
  private readonly callback: URL;
  private readonly provider: URL;
  constructor(private readonly config: OAuthSettings, private readonly operations: AuthOperations,
    private readonly clock = Date.now, provider = 'https://login.dingtalk.com/oauth2/auth') {
    this.callback = new URL(config.redirectUri);
    this.provider = new URL(provider); // Test seam only; production settings cannot set a provider/URL.
  }
  private async listen(): Promise<void> {
    if (this.closed) throw new ConnectionServiceError('service_disposed');
    if (this.server) { await this.listening; return; }
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(400); res.end('授权请求未完成，请返回原会话重试。'); }); });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    this.server = server;
    try {
      this.listening = new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(this.callback.port), '127.0.0.1', resolve); });
      await this.listening;
      const address = server.address();
      if (address && typeof address !== 'string') this.callback.port = String(address.port);
    } catch { this.server = undefined; server.close(); throw new ConnectionServiceError('service_unavailable'); }
  }
  async begin(owner: string, context: BrowserContext): Promise<AuthStart> {
    await this.listen();
    if (this.closed) throw new ConnectionServiceError('service_disposed');
    for (const [id, item] of this.transactions) if (item.expires + 120000 < this.clock()) { clearTimeout(item.timer); item.controller.abort(); this.transactions.delete(id); }
    if (this.transactions.size >= 32) throw new ConnectionServiceError('queue_full');
    const tx: Transaction = {
      id: random(), owner, state: random(), ticket: random(), proof: random(), nonce: random(),
      expires: this.clock() + 120000, started: false, consumed: false,
      result: { state: 'authorizing', reasonCode: 'authorization_pending' },
      origin: context.origin, returnUrl: context.origin === 'null' ? '' : new URL(context.returnPath, context.origin).href,
      revision: this.operations.revision(), controller: new AbortController(),
    };
    this.transactions.set(tx.id, tx);
    tx.timer = setTimeout(() => { if (tx.result.state === 'authorizing') { tx.controller.abort(); tx.consumed = true; tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' }; } }, 120000);
    tx.timer.unref();
    return { transactionId: tx.id, authorizeUrl: `${this.callback.origin}/dsh-dingtalk/start?t=${tx.ticket}`, expiresAt: new Date(tx.expires).toISOString() };
  }
  private owned(id: string, owner: string): Transaction {
    const tx = this.transactions.get(id);
    if (!tx || tx.owner !== owner) throw new ConnectionServiceError('invalid_auth_state');
    if (tx.expires <= this.clock() && tx.result.state === 'authorizing') {
      clearTimeout(tx.timer); tx.controller.abort(); tx.consumed = true; tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' };
    }
    return tx;
  }
  status(id: string, owner: string): ConnectionStatus { return this.owned(id, owner).result; }
  cancel(id: string, owner: string): ConnectionStatus {
    const tx = this.owned(id, owner);
    if (tx.result.state === 'authorizing') { clearTimeout(tx.timer); tx.consumed = true; tx.controller.abort(); tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' }; }
    return tx.result;
  }
  invalidate(): void {
    for (const tx of this.transactions.values()) if (tx.result.state === 'authorizing') this.cancel(tx.id, tx.owner);
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || req.headers.host !== this.callback.host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') || (req.url?.length ?? 0) > 16384) { res.writeHead(403); res.end(); return; }
    const url = new URL(req.url ?? '/', this.callback.origin);
    if (url.pathname === '/dsh-dingtalk/start') {
      if ([...url.searchParams.keys()].some(key => key !== 't') || url.searchParams.getAll('t').length !== 1) { res.writeHead(400); res.end(); return; }
      const tx = [...this.transactions.values()].find(item => item.ticket === url.searchParams.get('t'));
      if (!tx || tx.started || tx.consumed || tx.expires <= this.clock()) { res.writeHead(400); res.end('授权链接已失效。'); return; }
      tx.started = true;
      res.setHeader('Set-Cookie', `dsh_dt_${tx.id.slice(0, 16)}=${tx.proof}; HttpOnly; SameSite=Lax; Path=${this.callback.pathname}; Max-Age=120`);
      const target = new URL(this.provider);
      for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.callback.href, response_type: 'code', scope: this.config.scopes, state: tx.state, nonce: tx.nonce, prompt: 'consent' })) target.searchParams.set(key, value);
      res.writeHead(302, { Location: target.href }); res.end(); return;
    }
    if (url.pathname !== this.callback.pathname) { res.writeHead(404); res.end(); return; }
    if (req.headers.origin && ![this.callback.origin, this.provider.origin].includes(req.headers.origin)) { res.writeHead(403); res.end(); return; }
    if ([...url.searchParams.keys()].some(key => !['state', 'authCode', 'code', 'error', 'error_description'].includes(key)) || url.searchParams.getAll('state').length !== 1) { res.writeHead(400); res.end(); return; }
    const tx = [...this.transactions.values()].find(item => item.state === url.searchParams.get('state'));
    const proof = (req.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`dsh_dt_${tx?.id.slice(0, 16)}=`))?.split('=')[1] ?? '';
    if (!tx || !tx.started || tx.consumed || tx.expires <= this.clock() || !timingSafeEqual(digest(proof), digest(tx.proof))) { res.writeHead(400); res.end('授权校验失败，请返回原会话重试。'); return; }
    const authCodes = url.searchParams.getAll('authCode'), legacyCodes = url.searchParams.getAll('code');
    const codes = [...authCodes, ...legacyCodes];
    // DingTalk can return both aliases for the same code. Reject repeated keys
    // and conflicting values, while exchanging one identical value only once.
    if (url.searchParams.getAll('error').length > 1 || authCodes.length > 1 || legacyCodes.length > 1 || (url.searchParams.has('error') ? codes.length !== 0 : !codes[0] || codes[0].length > 8192 || /[\u0000-\u001f\u007f]/.test(codes[0]) || codes.some(code => code !== codes[0]))) { res.writeHead(400); res.end(); return; }
    tx.consumed = true; // Atomic replay fence before any asynchronous exchange.
    res.setHeader('Set-Cookie', `dsh_dt_${tx.id.slice(0, 16)}=; HttpOnly; SameSite=Lax; Path=${this.callback.pathname}; Max-Age=0`);
    if (url.searchParams.has('error')) tx.result = url.searchParams.get('error') === 'access_denied' ? { state: 'user_cancelled', reasonCode: 'user_cancelled' } : { state: 'unknown', reasonCode: 'connection_unknown' };
    else {
      try {
        const outcome = await this.operations.exchange(codes[0]!, tx.revision, tx.controller.signal);
        if (!tx.controller.signal.aborted && tx.expires > this.clock()) tx.result = outcome;
        else if (tx.result.state === 'authorizing') tx.result = { state: 'auth_timeout', reasonCode: 'auth_timeout' };
      } catch (error) {
        if (!tx.controller.signal.aborted) tx.result = { state: 'unknown', reasonCode: error instanceof ConnectionServiceError ? error.reasonCode : 'service_unavailable' };
        else if (tx.result.state === 'authorizing') tx.result = { state: 'user_cancelled', reasonCode: 'user_cancelled' };
      }
    }
    clearTimeout(tx.timer);
    this.completePage(res, tx);
  }
  private completePage(res: ServerResponse, tx: Transaction): void {
    const nonce = random();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
    const data = JSON.stringify({ type: 'dsh-dingtalk:auth', transactionId: tx.id, result: tx.result.state }).replaceAll('<', '\\u003c');
    const origin = JSON.stringify(tx.origin === 'null' ? '*' : tx.origin);
    const connected = tx.result.state === 'connected';
    res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>钉钉连接</title><style nonce="${nonce}">body{font:16px system-ui;max-width:32rem;margin:15vh auto;padding:24px;color:#263044}a,button{display:inline-block;padding:12px 20px;border-radius:8px;background:#2463eb;color:white;border:0;font:inherit}p{line-height:1.7}</style><h1>${connected ? '钉钉已连接' : '授权尚未完成'}</h1><p>请返回原会话查看连接结果。原会话和草稿不会因此丢失。</p>${tx.returnUrl ? `<a href="${escapeHtml(tx.returnUrl)}" target="_self">返回原会话</a>` : '<button id="return">返回原会话</button>'}<script nonce="${nonce}">history.replaceState(null,'','/dsh-dingtalk/complete');try{if(window.opener){window.opener.postMessage(${data},${origin});window.opener.focus();${connected ? 'window.close();' : ''}}}catch{}document.getElementById('return')?.addEventListener('click',()=>{try{window.opener?.focus();window.close()}catch{}});</script></html>`);
  }
  async dispose(): Promise<void> {
    this.closed = true;
    for (const tx of this.transactions.values()) { clearTimeout(tx.timer); tx.controller.abort(); }
    const server = this.server;
    if (server) { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; }
    this.transactions.clear();
  }
}
