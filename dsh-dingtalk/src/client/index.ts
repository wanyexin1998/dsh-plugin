import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, ButtonHTMLAttributes } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { parseConfig } from '../shared/config.js';
import type { AuthorizationContext } from '../shared/models.js';
import { IT_REQUEST, messageFor } from '../shared/messages.js';
import { ConnectionStore } from './store.js';
import type { ClientConnection } from './store.js';
import { localize, translate } from './i18n.js';
import type { LocaleFace } from './i18n.js';

interface SettingsSlots { register(options: object, component: (props: any) => ReactNode): () => void; inject?(name: string, action: () => void): unknown }
export const name = 'dsh-dingtalk';
export const inject = ['slots', 'connection', 'locale'];
const css = `.dsh-dt{font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;padding:16px;max-width:48rem;overflow-wrap:anywhere;background:transparent}.dsh-dt h2{font-size:1.1em;margin:0 0 12px}.dsh-dt p{line-height:1.65;margin:8px 0}.dsh-dt button,.dsh-dt a{font:inherit;display:inline-block;padding:8px 12px;border:1px solid currentColor;border-radius:8px;color:inherit;background:transparent;cursor:pointer;text-decoration:none}.dsh-dt button:disabled{opacity:.5;cursor:wait}.dsh-dt-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.dsh-dt :focus-visible{outline:3px solid #5797ff;outline-offset:3px}.dsh-dt small{opacity:.8}.dsh-dt dialog{color:inherit;background:Canvas;border:1px solid;border-radius:12px;max-width:min(30rem,80vw)}.dsh-dt pre{white-space:pre-wrap;max-height:16rem;overflow:auto;font-size:.85em}.dsh-dt dialog::backdrop{background:#0007}@media(max-width:480px){.dsh-dt{padding:12px}.dsh-dt-actions>*{flex:1;text-align:center}}`;
const cardCss = `.dsh-dt-card{font:inherit;font-size:13px;color:inherit;box-sizing:border-box;width:100%;max-width:420px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px;padding:10px 12px;overflow-wrap:anywhere}.dsh-dt-card header{display:flex;align-items:center;gap:8px;min-height:24px}.dsh-dt-card strong{font-size:13px;font-weight:500}.dsh-dt-card p{font-size:12px;line-height:1.5;opacity:.72;margin:4px 0 8px}.dsh-dt-card button,.dsh-dt-card a{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;padding:4px 9px;cursor:pointer;text-decoration:none}.dsh-dt-card .dsh-dt-dismiss{border:0;opacity:.6;margin-left:4px}.dsh-dt-card :focus-visible{outline:2px solid #5797ff;outline-offset:2px}.dsh-dt-card button:disabled{opacity:.5}.dsh-dt-card details pre{white-space:pre-wrap;max-height:200px;overflow:auto;font:12px/1.5 monospace}.dsh-dt-row{font:inherit;font-size:13px;opacity:.72;padding:4px 0}`;
const actionCss = `.dsh-dt .dsh-dt-icon,.dsh-dt-card .dsh-dt-icon{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:32px;height:30px;flex:none;padding:0;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:6px;background:transparent;color:inherit;vertical-align:middle}.dsh-dt-card .dsh-dt-icon{width:28px;height:26px;margin-right:6px}.dsh-dt .dsh-dt-icon:hover,.dsh-dt-card .dsh-dt-icon:hover{background:color-mix(in srgb,currentColor 5%,transparent)}.dsh-dt .dsh-dt-icon:active:not(:disabled),.dsh-dt-card .dsh-dt-icon:active:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}.dsh-dt .dsh-dt-caption,.dsh-dt-card .dsh-dt-caption{width:auto;min-width:32px;padding:0 8px;gap:5px;font-size:12px}.dsh-dt-icon svg{width:15px;height:15px;pointer-events:none}.dsh-dt .dsh-dt-confirm{padding:7px 12px;background:transparent}`;
type IconName = 'connect' | 'refresh' | 'disconnect' | 'close' | 'hide' | 'copy' | 'external';
const paths: Record<IconName, string> = {
  connect: 'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M18 17a7 7 0 0 1-12 2l-2-3',
  disconnect: 'M8 3 5 6a5 5 0 0 0 0 7M16 21l3-3a5 5 0 0 0 0-7M3 3l18 18M14 3h7v7M3 14v7h7',
  close: 'M6 6l12 12M18 6 6 18', hide: 'm6 14 6-6 6 6',
  copy: 'M9 8h11v13H9zM15 8V3H4v13h5', external: 'M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6',
};
function icon(name: IconName) { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] })); }
function IconButton({ label, symbol, caption, ...props }: { label: string; symbol: IconName; caption?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return h('button', { type: 'button', title: label, 'aria-label': label, ...props, className: 'dsh-dt-icon' + (caption ? ' dsh-dt-caption' : '') }, icon(symbol), caption ? h('span', null, caption) : null);
}
function DisconnectDialog({ store, confirmation, close, language = 'zh' }: { store: ConnectionStore; confirmation: string; close(): void; language?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  return localize(h('dialog', { ref: dialog, 'aria-labelledby': 'dsh-dt-unlink-title', onCancel: (event: Event) => { event.preventDefault(); close(); } },
    h('h3', { id: 'dsh-dt-unlink-title' }, '解除钉钉连接？'), h('p', null, '解除后需重新授权。'),
    h('div', { className: 'dsh-dt-actions' }, h('button', { type: 'button', className: 'dsh-dt-confirm', 'aria-label': '保留连接', autoFocus: true, onClick: close }, '保留'), h('button', { type: 'button', className: 'dsh-dt-confirm', 'aria-label': '确认解除连接', onClick: () => { close(); void store.disconnect(confirmation); } }, '解除'))), language);
}
export function ConnectionSection({ store, context = {}, compact = false, language = 'zh', dismiss, errorReason }: { store: ConnectionStore; context?: AuthorizationContext; compact?: boolean; language?: string; dismiss?: () => void; errorReason?: import('../shared/models.js').ReasonCode | undefined }): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [confirmation, setConfirmation] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState({ reason: errorReason, revision: snap.actionRevision || 0 });
  useEffect(() => { setSource({ reason: errorReason, revision: store.get().actionRevision || 0 }); }, [errorReason, store]);
  const activeError = source.reason === errorReason && source.revision === (snap.actionRevision || 0) ? errorReason : undefined;
  const reconnect = !activeError || ['not_connected', 'authorization_expired', 'auth_timeout', 'user_cancelled', 'verification_failed_after_save'].includes(activeError);
  const connected = snap.status.state === 'connected' && !activeError && !snap.preparing;
  const text = messageFor(snap.preparing ? 'connection_preparing' : activeError || snap.error || snap.status.reasonCode);
  if (compact) return localize(h('section', { className: 'dsh-dt-card', 'aria-label': '钉钉工具连接' }, h('style', null, cardCss + actionCss),
    h('header', null, h('strong', null, '钉钉'), h('span', { role: 'status', 'aria-live': 'polite' }, connected && !snap.error ? '已连接' : text.title)),
    h('p', null, connected && !snap.error ? '可继续查询。' : text.detail),
    snap.fallback ? h('a', { className: 'dsh-dt-icon', title: '打开授权页', 'aria-label': '打开授权页', href: snap.fallback, target: '_blank', rel: 'noopener noreferrer' }, icon('external')) : null,
    snap.transaction || snap.preparing ? h(IconButton, { label: '取消', caption: '取消', symbol: 'close', onClick: () => { void store.cancel(); } }) : !reconnect ? h(IconButton, { label: '刷新状态', symbol: 'refresh', onClick: () => { void store.refresh(true); } }) : connected && !snap.error ? null : h(IconButton, { label: '连接钉钉', caption: '连接', symbol: 'connect', disabled: snap.pending, onClick: () => { void store.begin(context); } }),
    dismiss ? h(IconButton, { label: connected ? '收起' : '暂不连接', symbol: connected ? 'hide' : 'close', onClick: dismiss }) : null), language);
  return localize(h('section', { className: 'dsh-dt', 'aria-label': compact ? '钉钉工具连接' : '钉钉连接' }, h('style', null, css + actionCss),
    h('h2', null, compact ? '钉钉只读查询' : '钉钉连接'),
    h('p', { role: 'status', 'aria-live': 'polite' }, connected && !snap.error ? '钉钉已连接' : text.title),
    connected && !snap.error ? null : h('p', null, text.detail),
    snap.fallback ? h('p', null, h('a', { className: 'dsh-dt-icon', title: '打开授权页', 'aria-label': '浏览器拦截了弹窗，点击打开授权页', href: snap.fallback, target: '_blank', rel: 'noopener noreferrer' }, icon('external'))) : null,
    h('div', { className: 'dsh-dt-actions' },
      snap.transaction || snap.preparing ? h(IconButton, { label: '取消本次授权', caption: '取消', symbol: 'close', onClick: () => { void store.cancel(); } }) : h(IconButton, { label: connected ? '重新授权' : '连接钉钉', caption: connected ? '重连' : '连接', symbol: 'connect', disabled: snap.pending, onClick: () => { void store.begin(context); } }),
      h(IconButton, { label: '刷新状态', symbol: 'refresh', disabled: snap.pending, onClick: () => { void store.refresh(true); } }),
      !compact ? h(IconButton, { label: '解除连接', caption: '断开', symbol: 'disconnect', disabled: snap.pending, onClick: () => { void store.previewDisconnect().then(setConfirmation); } }) : null,
      text.admin ? h(IconButton, { label: copied ? '已复制申请文案' : '复制给 IT 的申请文案', symbol: 'copy', onClick: () => { void navigator.clipboard.writeText(translate(IT_REQUEST, language)).then(() => setCopied(true), () => setCopied(false)); } }) : null),
    confirmation ? h(DisconnectDialog, { store, confirmation, close: () => setConfirmation(undefined), language }) : null), language);
}
interface ToolProps { phase: string; sessionId?: string; callId: string; block?: { content?: readonly { type: string; text?: string }[] } }
function AuthorizationFeedback({ store, language, sessionId = 'current', callId, reason }: { store: ConnectionStore; language: string; sessionId?: string | undefined; callId: string; reason: import('../shared/models.js').ReasonCode }) {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  useSyncExternalStore(store.prompts.subscribe, store.prompts.snapshot, store.prompts.snapshot);
  const [shown, setShown] = useState(false), [dismissed, setDismissed] = useState(false);
  useEffect(() => store.prompts.register(sessionId, callId, reason), [store, sessionId, callId, reason]);
  const prompt = store.prompts.get(sessionId);
  const owner = prompt.owner === callId;
  const needs = ['unlinked', 'reauth_required'].includes(snap.status.state) || snap.status.reasonCode === 'verification_failed_after_save' || !!snap.transaction || !!snap.preparing || prompt.reason === 'scope_authorization_required';
  useEffect(() => { if (owner && needs) setShown(true); }, [owner, needs]);
  if (!owner || dismissed || (!needs && !shown)) return null;
  return h(ConnectionSection, { store, compact: true, language, dismiss: () => setDismissed(true),
    errorReason: prompt.reason === 'scope_authorization_required' ? prompt.reason : undefined,
    context: { sessionRef: sessionId, callRef: callId } });
}
export function ToolView({ store, language = 'zh', ...props }: ToolProps & { store: ConnectionStore; language?: string }): ReactNode {
  const text = props.block?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
  let result: { status?: string; reasonCode?: import('../shared/models.js').ReasonCode } = {};
  try { result = JSON.parse(text); } catch {}
  if (props.phase !== 'result') return localize(h('div', { className: 'dsh-dt-row', role: 'status' }, h('style', null, cardCss), '钉钉 · 正在读取…'), language);
  if (result.status === 'ok') return localize(h('div', { className: 'dsh-dt-row', role: 'status' }, h('style', null, cardCss), '钉钉 · 查询完成'), language);
  if (result.status === 'auth_required' || result.reasonCode === 'authorization_expired') return h(AuthorizationFeedback, { store, language, sessionId: props.sessionId, callId: props.callId, reason: result.reasonCode || 'not_connected' });
  const detail = result.reasonCode === 'invalid_cli_output' ? '查询结果暂时无法读取。' : ['queue_timeout', 'queue_full'].includes(result.reasonCode || '') ? '查询繁忙，请稍后重试。' : result.status === 'denied' ? messageFor(result.reasonCode).title : '查询暂未完成，请稍后重试。';
  return localize(h('div', { className: 'dsh-dt-row', role: 'status' }, h('style', null, cardCss), '钉钉 · ', detail), language);
}
function LocalizedView({ locale, render }: { locale: LocaleFace; render(language: string): ReactNode }) {
  const language = useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot(), () => locale.getSnapshot()).active;
  return render(language);
}
export function apply(ctx: Context & { slots: SettingsSlots; connection: ClientConnection; locale: LocaleFace }, config: unknown): void {
  parseConfig(config);
  const store = new ConnectionStore(ctx.connection);
  ctx.effect(() => () => store.dispose());
  const settings = () => { ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'dsh-dingtalk', order: 60, label: () => translate('钉钉连接', ctx.locale.getSnapshot().active) }, () => h(LocalizedView, { locale: ctx.locale, render: language => h(ConnectionSection, { store, language }) }))); };
  const tool = () => { ctx.effect(() => ctx.slots.register({ name: 'tool.call.toolview', key: 'dingtalk_call' }, (props: ToolProps) => h(LocalizedView, { locale: ctx.locale, render: language => h(ToolView, { ...props, store, language }) }))); };
  if (ctx.slots.inject) { ctx.slots.inject('settings.section', settings); ctx.slots.inject('tool.call.toolview', tool); }
  else { settings(); tool(); }
}
