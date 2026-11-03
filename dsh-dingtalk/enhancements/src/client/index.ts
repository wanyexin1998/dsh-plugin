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
import { toolLabel } from './tool-label.js';
import type { ToolArgumentView } from './tool-label.js';
import { connectionCss } from './styles.js';
import { RelaySection } from './relay.js';
import { authorizationTail } from './tail.js';
import type { ChatSnapshot } from './tail.js';

interface SettingsSlots { register(options: object, component: (props: any) => ReactNode): () => void; inject?(name: string, action: () => void): unknown }
export const name = 'dsh-dingtalk';
export const inject = ['slots', 'connection', 'locale'];
type IconName = 'connect' | 'refresh' | 'disconnect' | 'close' | 'hide' | 'copy' | 'external' | 'check' | 'clock' | 'warning' | 'more' | 'user' | 'calendar' | 'file' | 'shield';
const paths: Record<IconName, string> = {
  connect: 'M9 17H7A5 5 0 0 1 7 7h2m6 0h2a5 5 0 0 1 0 10h-2M8 12h8',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M18 17a7 7 0 0 1-12 2l-2-3',
  disconnect: 'M9 5H4v14h5M13 8l4 4-4 4M8 12h13',
  close: 'M6 6l12 12M18 6 6 18', hide: 'm6 14 6-6 6 6',
  copy: 'M9 8h11v13H9zM15 8V3H4v13h5', external: 'M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6',
  check: 'm5 12 4 4L19 6', clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  warning: 'm12 3 10 18H2L12 3Zm0 5v6m0 3v.5', more: 'M5 12h.01M12 12h.01M19 12h.01',
  user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  calendar: 'M3 5h18v16H3zM7 2v6M17 2v6M3 10h18',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',
};
function icon(name: IconName) { return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 3 : 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[name] })); }
function IconButton({ label, symbol, caption, className = '', ...props }: { label: string; symbol: IconName; caption?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return h('button', { type: 'button', title: label, 'aria-label': label, ...props, className: 'dsh-dt-icon' + (caption ? ' dsh-dt-caption' : '') + ' ' + className }, icon(symbol), caption ? h('span', null, caption) : null);
}
function DisconnectDialog({ store, confirmation, close, language = 'zh' }: { store: ConnectionStore; confirmation: string; close(): void; language?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); dialog.current?.querySelector<HTMLButtonElement>('.dsh-dt-dialog-actions button')?.focus(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  return localize(h('dialog', { ref: dialog, className: 'dsh-dt-dialog', 'aria-labelledby': 'dsh-dt-unlink-title', onCancel: (event: Event) => { event.preventDefault(); close(); } },
    h('div', { className: 'dsh-dt-dialog-top' }, h('span', null, '钉钉连接'), h(IconButton, { label: '关闭弹窗', symbol: 'close', onClick: close })),
    h('h3', { id: 'dsh-dt-unlink-title' }, '解除钉钉连接？'), h('p', null, '解除后将停止调用与后台任务。再次使用需重新连接。'),
    h('div', { className: 'dsh-dt-dialog-actions' }, h(IconButton, { label: '保留连接', caption: '保留连接', symbol: 'close', autoFocus: true, onClick: close }), h(IconButton, { label: '确认解除连接', caption: '解除', symbol: 'disconnect', className: 'dsh-dt-primary', onClick: () => { close(); void store.disconnect(confirmation); } }))), language);
}
function permissions() {
  return h('div', { className: 'dsh-dt-scopes' }, ...([['calendar', '日程与待办', '查询与管理'], ['file', '文档与表格', '读取与编辑'], ['user', '消息与更多', '按账号权限']] as const).map(([symbol, label, detail]) => h('div', { className: 'dsh-dt-scope', key: symbol }, icon(symbol), h('span', null, label), h('small', null, detail))));
}
export function ConnectionSection({ store, context = {}, compact = false, language = 'zh', dismiss, errorReason }: { store: ConnectionStore; context?: AuthorizationContext; compact?: boolean; language?: string; dismiss?: () => void; errorReason?: import('../shared/models.js').ReasonCode | undefined }): ReactNode {
  const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [confirmation, setConfirmation] = useState<string>();
  const [copied, setCopied] = useState(false), [copyFailed, setCopyFailed] = useState(false), [menu, setMenu] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState({ reason: errorReason, revision: snap.actionRevision || 0 });
  useEffect(() => { setSource({ reason: errorReason, revision: store.get().actionRevision || 0 }); }, [errorReason, store]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(false); menuButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const activeError = source.reason === errorReason && source.revision === (snap.actionRevision || 0) ? errorReason : undefined;
  const reason = snap.preparing ? 'connection_preparing' : activeError || snap.error || snap.status.reasonCode;
  const connected = snap.status.state === 'connected' && !activeError && !snap.preparing && !snap.error && !snap.transaction;
  const working = !!snap.transaction || !!snap.preparing;
  const text = messageFor(reason);
  const reconnect = !reason || ['not_connected', 'authorization_expired', 'auth_timeout', 'user_cancelled', 'verification_failed_after_save', 'identity_mismatch', 'scope_authorization_required', 'invalid_auth_state', 'cli_missing'].includes(reason);
  const admin = text.admin || ['app_permission_denied', 'permission_denied', 'scope_authorization_required', 'cli_integrity_failed', 'oauth_not_configured', 'privacy_guard_required'].includes(reason || '');
  const copy = () => { void (async () => { try { await navigator.clipboard.writeText(translate(IT_REQUEST, language)); setCopied(true); setCopyFailed(false); } catch { setCopyFailed(true); } })(); };
  const unlink = () => { setMenu(false); menuButton.current?.focus(); void store.previewDisconnect().then(setConfirmation); };
  const symbol: IconName = connected ? 'check' : working ? 'clock' : admin || reason === 'identity_mismatch' ? 'warning' : 'connect';
  const primary = snap.fallback
    ? h('a', { className: 'dsh-dt-primary dsh-dt-action', title: '打开授权页', 'aria-label': '浏览器拦截了弹窗，点击打开授权页', href: snap.fallback, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', null, '打开'))
    : working ? h('button', { className: 'dsh-dt-action', type: 'button', disabled: true }, snap.preparing ? '准备中' : '等待中')
    : connected ? h('span', { className: 'dsh-dt-action dsh-dt-ready', 'aria-hidden': true })
    : reason === 'revocation_failed' ? h(IconButton, { label: '重试解除连接', caption: '重试', symbol: 'disconnect', onClick: unlink, disabled: snap.pending })
    : !reconnect && admin ? h(IconButton, { label: copied ? '已复制申请文案' : '复制给 IT 的申请文案', caption: copied ? '已复制' : '复制', symbol: 'copy', onClick: copy })
    : !reconnect ? h(IconButton, { label: '刷新状态', caption: '重试', symbol: 'refresh', onClick: () => { void store.refresh(true); }, disabled: snap.pending })
    : h('button', { className: 'dsh-dt-action dsh-dt-primary', type: 'button', 'aria-label': '连接钉钉', disabled: snap.pending, onClick: () => { void store.begin(context); } }, reason === 'not_connected' ? '连接' : '重连');
  const strip = (asCard: boolean) => h('section', { className: (asCard ? 'dsh-dt-card ' : '') + 'dsh-dt-strip', 'aria-label': '钉钉工具连接', 'data-tone': connected ? 'success' : admin ? 'warning' : 'neutral' },
    h('span', { className: 'dsh-dt-symbol' }, icon(symbol)),
    h('div', { className: 'dsh-dt-copy' }, h('strong', { role: 'status', 'aria-live': 'polite' }, connected ? '钉钉已连接' : text.title), h('p', null, connected ? '可继续刚才的查询。' : text.detail)),
    h('div', { className: 'dsh-dt-actions' }, primary, working ? h(IconButton, { label: '取消本次授权', symbol: 'close', onClick: () => { void store.cancel(); } }) : dismiss ? h(IconButton, { label: connected ? '收起' : '暂不连接', symbol: 'close', onClick: dismiss }) : h('span', { className: 'dsh-dt-action-spacer', 'aria-hidden': true })));
  const extras = copyFailed ? h('div', { className: 'dsh-dt-copy-fallback' }, h('p', null, '复制未成功，请手动复制：'), h('textarea', { readOnly: true, 'aria-label': '申请文案', value: translate(IT_REQUEST, language), onFocus: (event: { currentTarget: HTMLTextAreaElement }) => event.currentTarget.select() })) : null;
  const modal = confirmation ? h(DisconnectDialog, { store, confirmation, close: () => setConfirmation(undefined), language }) : null;
  if (compact) return localize(h('div', { className: 'dsh-dt-shell' }, h('style', null, connectionCss), strip(true), extras, modal), language);
  const account = snap.status.account;
  return localize(h('section', { className: 'dsh-dt', 'aria-label': '钉钉连接' }, h('style', null, connectionCss),
    h('div', { className: 'dsh-dt-heading' }, h('div', null, h('h2', null, '钉钉'), h('p', null, '在对话中使用你的工作信息。')),
      h('div', { className: 'dsh-dt-menu-anchor', ref: menuRoot }, h('button', { className: 'dsh-dt-icon', ref: menuButton, type: 'button', 'aria-label': '连接管理', title: '连接管理', 'aria-expanded': menu, onClick: () => setMenu(!menu) }, icon('more')),
        h('div', { className: 'dsh-dt-menu', hidden: !menu }, h(IconButton, { label: '重新授权', caption: '重新授权', symbol: 'refresh', disabled: snap.pending || working, onClick: () => { setMenu(false); void store.begin(context); } }), h(IconButton, { label: '解除连接', caption: '解除连接', symbol: 'disconnect', disabled: snap.pending || working, onClick: unlink })))),
    connected ? h('div', { className: 'dsh-dt-account' }, h('span', { className: 'dsh-dt-avatar' }, icon('user')), h('div', { className: 'dsh-dt-account-copy' }, h('strong', null, account?.displayName || '已授权账号'), h('p', null, account?.organizationName || '已验证企业')), h('span', { className: 'dsh-dt-connected', role: 'status', 'aria-live': 'polite' }, icon('check'), '钉钉已连接')) : strip(false),
    h(RelaySection, { store }),
    h('div', { className: 'dsh-dt-list-label' }, '连接后可用'), permissions(),
    h('p', { className: 'dsh-dt-privacy' }, icon('shield'), h('span', null, '按你的指令操作，写入前确认。')),
    admin && reconnect ? h(IconButton, { label: copied ? '已复制申请文案' : '复制给 IT 的申请文案', caption: copied ? '已复制' : '复制给管理员', symbol: 'copy', onClick: copy }) : null,
    h('div', { className: 'dsh-dt-bottom' }, h('span', null, snap.status.checkedAt && Number.isFinite(Date.parse(snap.status.checkedAt)) ? new Intl.DateTimeFormat(language.startsWith('zh') ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' }).format(new Date(snap.status.checkedAt)) : '连接状态'), h(IconButton, { label: '刷新状态', caption: '刷新状态', symbol: 'refresh', disabled: snap.pending, onClick: () => { void store.refresh(true); } })), extras, modal), language);
}
interface ToolProps { phase: string; sessionId?: string; callId: string; block?: { args?: ToolArgumentView; content?: readonly { type: string; text?: string }[] } }
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
  const name = toolLabel(props.block?.args, language);
  const row = (status: string) => h('div', { className: 'dsh-dt-row', role: 'status' }, h('style', null, connectionCss),
    h('span', { className: 'dsh-dt-row-fixed' }, language.startsWith('zh') ? '钉钉 · ' : 'DingTalk · '),
    name ? h('span', { className: 'dsh-dt-tool-name', title: name.title }, name.label) : null,
    name ? h('span', { className: 'dsh-dt-row-fixed' }, ' · ') : null,
    h('span', { className: 'dsh-dt-tool-state' }, status));
  if (props.phase !== 'result') return row(language.startsWith('zh') ? '处理中…' : 'Working…');
  if (result.status === 'ok') return row(language.startsWith('zh') ? '已完成' : 'Done');
  if (result.status === 'auth_required' || result.reasonCode === 'authorization_expired') return row(language.startsWith('zh') ? '等待连接' : 'Waiting for connection');
  const detail = result.reasonCode && ['outcome_unknown','confirmation_required','confirmation_rejected','file_access_denied','command_unavailable','host_managed_operation','unknown_command','job_not_found','job_limit'].includes(result.reasonCode) ? messageFor(result.reasonCode).title : result.reasonCode === 'invalid_cli_output' ? '查询结果暂时无法读取。' : ['queue_timeout', 'queue_full'].includes(result.reasonCode || '') ? '查询繁忙，请稍后重试。' : result.status === 'denied' ? messageFor(result.reasonCode).title : '查询暂未完成，请稍后重试。';
  return row(translate(detail, language));
}
function LocalizedView({ locale, render }: { locale: LocaleFace; render(language: string): ReactNode }) {
  const language = useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot(), () => locale.getSnapshot()).active;
  return render(language);
}
export interface AuthorizationTailProps {
  sessionId: string;
  turn: { turn: number };
  useChat: (selector: (snapshot: ChatSnapshot) => string) => string;
}
export function AuthorizationTail({ store, language = 'zh', ...props }: AuthorizationTailProps & { store: ConnectionStore; language?: string }): ReactNode {
  const serialized = props.useChat(authorizationTail);
  if (!serialized) return null;
  const prompt = JSON.parse(serialized) as { turn: number; callId: string; reason: import('../shared/models.js').ReasonCode };
  if (prompt.turn !== props.turn.turn) return null;
  return h('div', { 'data-dingtalk-authorization-tail': true, style: { display: 'contents' } },
    h(AuthorizationFeedback, { key: prompt.callId, store, language, sessionId: props.sessionId, callId: prompt.callId, reason: prompt.reason }));
}
export function apply(ctx: Context & { slots: SettingsSlots; connection: ClientConnection; locale: LocaleFace }, config: unknown): void {
  parseConfig(config);
  const store = new ConnectionStore(ctx.connection);
  ctx.effect(() => () => store.dispose());
  const settings = () => { ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'dsh-dingtalk', order: 60, label: () => translate('钉钉连接', ctx.locale.getSnapshot().active) }, () => h(LocalizedView, { locale: ctx.locale, render: language => h(ConnectionSection, { store, language }) }))); };
  const tool = () => { ctx.effect(() => ctx.slots.register({ name: 'tool.call.toolview', key: 'dingtalk_call' }, (props: ToolProps) => h(LocalizedView, { locale: ctx.locale, render: language => h(ToolView, { ...props, store, language }) }))); };
  const tail = () => { ctx.effect(() => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'dsh-dingtalk-authorization', order: 90 }, (props: AuthorizationTailProps) => h(LocalizedView, { locale: ctx.locale, render: language => h(AuthorizationTail, { ...props, store, language }) }))); };
  if (ctx.slots.inject) { ctx.slots.inject('settings.section', settings); ctx.slots.inject('tool.call.toolview', tool); ctx.slots.inject('conversation.chat.turnTail', tail); }
  else { settings(); tool(); tail(); }
}
