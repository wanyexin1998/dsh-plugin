import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
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
function DisconnectDialog({ store, confirmation, close, language = 'zh' }: { store: ConnectionStore; confirmation: string; close(): void; language?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  return localize(h('dialog', { ref: dialog, 'aria-labelledby': 'dsh-dt-unlink-title', onCancel: (event: Event) => { event.preventDefault(); close(); } },
    h('h3', { id: 'dsh-dt-unlink-title' }, '解除钉钉连接？'), h('p', null, '停止后续读取，并撤销此插件绑定账号的本地 DWS 凭据。再次使用需要重新授权。'),
    h('div', { className: 'dsh-dt-actions' }, h('button', { type: 'button', autoFocus: true, onClick: close }, '保留连接'), h('button', { type: 'button', onClick: () => { close(); void store.disconnect(confirmation); } }, '确认解除连接'))), language);
}
export function ConnectionSection({ store, context = {}, compact = false, language = 'zh', dismiss, errorReason }: { store: ConnectionStore; context?: AuthorizationContext; compact?: boolean; language?: string; dismiss?: () => void; errorReason?: import('../shared/models.js').ReasonCode | undefined }): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [confirmation, setConfirmation] = useState<string>();
  const [copied, setCopied] = useState(false);
  const connected = snap.status.state === 'connected' && !errorReason;
  const text = messageFor(errorReason || snap.error || snap.status.reasonCode);
  if (compact) return localize(h('section', { className: 'dsh-dt-card', 'aria-label': '钉钉工具连接' }, h('style', null, cardCss),
    h('header', null, h('strong', null, '钉钉'), h('span', { role: 'status', 'aria-live': 'polite' }, connected && !snap.error ? '已连接' : text.title)),
    h('p', null, connected && !snap.error ? '可继续刚才的查询。' : snap.transaction ? '请在新标签页完成授权。' : text.detail),
    snap.fallback ? h('a', { href: snap.fallback, target: '_blank', rel: 'noopener noreferrer' }, '打开授权页') : null,
    snap.transaction ? h('button', { type: 'button', onClick: () => { void store.cancel(); } }, '取消') : errorReason ? h('button', { type: 'button', onClick: () => { void store.refresh(); } }, '刷新状态') : connected && !snap.error ? null : h('button', { type: 'button', disabled: snap.pending, onClick: () => { void store.begin(context); } }, snap.pending ? '正在打开…' : '连接钉钉'),
    dismiss ? h('button', { type: 'button', className: 'dsh-dt-dismiss', onClick: dismiss }, connected ? '收起' : '暂不连接') : null), language);
  return localize(h('section', { className: 'dsh-dt', 'aria-label': compact ? '钉钉工具连接' : '钉钉连接' }, h('style', null, css),
    h('h2', null, compact ? '钉钉只读查询' : '钉钉连接'),
    h('p', { role: 'status', 'aria-live': 'polite' }, connected && !snap.error ? '钉钉已连接' : text.title),
    h('p', null, connected && !snap.error ? '可继续刚才的查询。连接不会自动发送消息或执行查询。' : text.detail),
    connected && snap.status.account ? h('p', null, `${snap.status.account.organizationName} · ${snap.status.account.displayName}`) : null,
    snap.status.capabilitySummary?.length ? h('p', null, `可用能力：${snap.status.capabilitySummary.join('、')}`) : null,
    snap.status.checkedAt ? h('small', null, `最近验证：${new Date(snap.status.checkedAt).toLocaleString()}`) : null,
    snap.fallback ? h('p', null, h('a', { href: snap.fallback, target: '_blank', rel: 'noopener noreferrer' }, '浏览器拦截了弹窗，点击打开授权页')) : null,
    h('div', { className: 'dsh-dt-actions' },
      snap.transaction ? h('button', { type: 'button', onClick: () => { void store.cancel(); } }, '取消本次授权') : h('button', { type: 'button', disabled: snap.pending, onClick: () => { void store.begin(context); } }, connected ? '重新授权' : '连接钉钉'),
      h('button', { type: 'button', disabled: snap.pending, onClick: () => { void store.refresh(); } }, '刷新状态'),
      !compact ? h('button', { type: 'button', disabled: snap.pending, onClick: () => { void store.previewDisconnect().then(setConfirmation); } }, '解除连接') : null,
      text.admin ? h('button', { type: 'button', onClick: () => { void navigator.clipboard.writeText(translate(IT_REQUEST, language)).then(() => setCopied(true), () => setCopied(false)); } }, copied ? '已复制申请文案' : '复制给 IT 的申请文案') : null),
    text.admin ? h('p', null, IT_REQUEST) : null,
    confirmation ? h(DisconnectDialog, { store, confirmation, close: () => setConfirmation(undefined), language }) : null), language);
}
interface ToolProps { phase: string; sessionId?: string; callId: string; block?: { content?: readonly { type: string; text?: string }[] } }
export function ToolView({ store, language = 'zh', ...props }: ToolProps & { store: ConnectionStore; language?: string }): ReactNode {
  const [hidden, setHidden] = useState(false);
  const text = props.block?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
  let result: { status?: string; reasonCode?: import('../shared/models.js').ReasonCode } = {};
  try { result = JSON.parse(text); } catch {}
  if (hidden) return localize(h('button', { type: 'button', className: 'dsh-dt-row', onClick: () => setHidden(false) }, '钉钉 · 显示连接'), language);
  if (props.phase !== 'result') return localize(h('div', { className: 'dsh-dt-row', role: 'status' }, h('style', null, cardCss), '钉钉 · 正在读取…'), language);
  if (result.status === 'ok') return localize(h('details', { className: 'dsh-dt-card' }, h('style', null, cardCss), h('summary', null, '钉钉 · 查询完成'), h('pre', null, text)), language);
  return h(ConnectionSection, { store, compact: true, language, dismiss: () => setHidden(true), errorReason: ['failed', 'denied'].includes(result.status || '') ? result.reasonCode || 'connection_unknown' : undefined,
    context: { callRef: props.callId, ...(props.sessionId ? { sessionRef: props.sessionId } : {}) } });
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
