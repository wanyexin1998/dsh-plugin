import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionStore } from './store.js';
import { icon, IconButton } from './components.js';
import { localize } from './i18n.js';
import { showAuthorizationLoading } from './loading.js';
interface State { status: string; url?: string; authorizeUrl?: string | undefined; expires?: number | undefined; mode?: 'personal' | 'enterprise'; configured?: boolean; hosting?: boolean; callbackUrl?: string; displayName?: string }
const labels: Record<string, string> = { device_in_use: '此配置已在另一 DSH 实例运行', loading: '检查中', unavailable: '当前通道未提供连接管理', unconfigured: '未配置', enterprise_configuration_invalid: '企业配置有误', mode_conflict: '请先停用个人托管', local_configuration_invalid: '本机配置有误', gateway_in_use: '端口被占用或另一 DSH 正在托管', gateway_unavailable: '本机服务暂不可用', stream_failed: '机器人消息连接失败', disconnected: '未连接', connecting: '连接中', authorizing: '等待登录确认', connected: '已连接', offline: '离线 · 正在重连', auth_required: '请重新授权', replaced: '已在其他设备连接', cancelled: '已取消', expired: '登录已超时', failed: '连接未完成' };
const firstConfigurationHelp = '首次配置需确认企业信息；尚无企业信息时，请先在上方完成 DWS 授权。配置后连接机器人并按提示完成设备配对。';
const personalConnectionHelp = '机器人通过应用登录与此设备配对。钉钉数据授权在上方单独管理。';
const uncertainMessage = '机器人操作结果尚未确认，请刷新状态。';
const actionErrors: Record<string, string> = { auth_required: '请先完成上方钉钉账号授权。', invalid_credentials: '应用凭据无效或验证暂不可用，请检查后重试。', identity_mismatch: '请使用与当前 DWS 相同的企业账号。', gateway_in_use: '本机端口被占用，或另一 DSH 正在托管此机器人。', device_in_use: '此配置已在另一 DSH 实例运行。', stop_before_configure: '请先停止托管，再修改应用凭据。' };
export function RelaySection({ store, language = 'zh' }: { store: ConnectionStore; language?: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false), [statusError, setStatusError] = useState(false), [uncertain, setUncertain] = useState(false);
  const [editing, setEditing] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState('');
  const popup = useRef<Window | null>(null);
  const active = useRef(false), generation = useRef(0), mutating = useRef(false), recoveryRequired = useRef(false);
  const statusRequest = useRef<object | null>(null);
  const readTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const closePopup = () => { popup.current?.close(); popup.current = null; };
  const refresh = useCallback(async (manual = false) => {
    if (!active.current || mutating.current) return;
    if (manual) setRefreshing(true);
    if (statusRequest.current) return;
    const revision = generation.current, request = {};
    statusRequest.current = request;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('status_timeout')), 15000); readTimers.current.add(timer); });
      const value = await Promise.race([store.relay('status'), timeout]) as State;
      if (active.current && generation.current === revision && statusRequest.current === request) { setState(value); setStatusError(false); recoveryRequired.current = false; setUncertain(false); setError(old => old === uncertainMessage ? '' : old); setUrl(old => old || value.url || ''); }
    } catch {
      if (active.current && generation.current === revision && statusRequest.current === request) setStatusError(true);
    } finally {
      if (timer !== undefined) { clearTimeout(timer); readTimers.current.delete(timer); }
      if (statusRequest.current === request) { statusRequest.current = null; if (active.current) setRefreshing(false); }
    }
  }, [store]);
  useEffect(() => {
    active.current = true; generation.current++; mutating.current = false; recoveryRequired.current = false; statusRequest.current = null;
    setState({ status: 'loading' }); setRefreshing(false); setStatusError(false); setUncertain(false); setError(''); setBusy(false); setUrl(''); setEditing(false); setClientId(''); setSecret('');
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { active.current = false; generation.current++; statusRequest.current = null; clearInterval(timer); for (const timeout of readTimers.current) clearTimeout(timeout); readTimers.current.clear(); closePopup(); };
  }, [refresh]);
  useEffect(() => { if (state.status === 'connected') closePopup(); }, [state.status]);
  const personal = state.mode === 'personal';
  const legacy = !state.mode && !['loading', 'unavailable'].includes(state.status);
  const action = async (method: 'connect' | 'disconnect' | 'configure' | 'stop') => {
    if (!active.current || mutating.current || recoveryRequired.current) return;
    mutating.current = true; const revision = ++generation.current;
    statusRequest.current = null; setRefreshing(false); setBusy(true); setError('');
    closePopup();
    if (method === 'connect') {
      popup.current = window.open('', '_blank');
      if (popup.current) { popup.current.opener = null; try { showAuthorizationLoading(popup.current); } catch {} }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let recover = false;
    const deadline = new Error('action_timeout');
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(deadline), 30000); readTimers.current.add(timer); });
      const value = await Promise.race([store.relay(method, method === 'configure' ? { clientId: clientId.trim(), clientSecret: secret } : method === 'connect' && legacy ? { url: url.trim() } : {}), timeout]) as State;
      if (!active.current || generation.current !== revision) return;
      if (method === 'configure') { setSecret(''); setEditing(false); }
      setState(old => method === 'disconnect' ? { ...old, status: 'disconnected', authorizeUrl: undefined, expires: undefined } : value); setStatusError(false);
      if (value.authorizeUrl && popup.current && !popup.current.closed) popup.current.location.replace(value.authorizeUrl);
      else if (!value.authorizeUrl) closePopup();
    } catch (failure) {
      if (!active.current || generation.current !== revision) return;
      closePopup(); const code = (failure as { reasonCode?: string }).reasonCode || '';
      recover = failure === deadline;
      if (recover) { recoveryRequired.current = true; setUncertain(true); }
      const message = personal && code === 'auth_required'
        ? method === 'configure' && !state.configured ? firstConfigurationHelp : '请重新连接机器人，按提示完成应用登录与设备配对。'
        : personal && code === 'identity_mismatch' ? '请使用此机器人所属企业的账号完成配对。' : actionErrors[code];
      setError(recover ? uncertainMessage : message || '连接未完成，请检查应用设置后重试。');
    } finally {
      if (timer !== undefined) { clearTimeout(timer); readTimers.current.delete(timer); }
      if (active.current && generation.current === revision) { mutating.current = false; setBusy(false); if (recover) void refresh(); }
    }
  };
  const blocked = busy || uncertain;
  const canDisconnect = ['connected', 'authorizing', 'offline', 'auth_required'].includes(state.status);
  const unavailable = ['enterprise_configuration_invalid', 'mode_conflict', 'local_configuration_invalid', 'device_in_use', 'authorizing', 'connected', 'connecting'].includes(state.status);
  const status = state.status === 'loading' && statusError ? '状态未知' : personal && state.status === 'auth_required' ? '请重新登录机器人' : labels[state.status] || '状态未知';
  const tone = statusError ? 'warning' : state.status === 'connected' ? 'success' : ['failed', 'offline', 'auth_required', 'expired', 'stream_failed', 'enterprise_configuration_invalid', 'local_configuration_invalid', 'gateway_unavailable', 'gateway_in_use', 'mode_conflict', 'device_in_use'].includes(state.status) ? 'warning' : undefined;
  return localize(h('section', { className: 'dsh-dt-robot dsh-dt-section', 'aria-label': '钉钉机器人', 'aria-busy': busy },
    h('div', { className: 'dsh-dt-strip', 'data-tone': tone },
      h('span', { className: 'dsh-dt-symbol' }, icon(tone === 'success' ? 'check' : tone === 'warning' ? 'warning' : ['loading', 'connecting', 'authorizing'].includes(state.status) ? 'clock' : 'connect')),
      h('div', { className: 'dsh-dt-copy' }, h('strong', null, state.displayName || '钉钉机器人'), h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-dt-status' }, statusError && state.status !== 'loading' ? '上次确认：' : null, status)),
      h('div', { className: 'dsh-dt-actions dsh-dt-relay-actions' },
        h(IconButton, { label: '刷新机器人状态', symbol: 'refresh', 'aria-busy': refreshing, disabled: busy || refreshing, onClick: () => void refresh(true) }),
        personal && (!state.configured || !state.hosting) && !editing ? h(IconButton, { label: '配置', caption: '配置', symbol: 'more', className: 'dsh-dt-primary', disabled: blocked, onClick: () => setEditing(true) }) : null,
        !editing && (legacy || personal && state.configured || state.mode === 'enterprise') ? h(IconButton, { label: '连接', caption: '连接', symbol: 'connect', className: 'dsh-dt-primary', disabled: blocked || (legacy && !url.trim()) || unavailable, onClick: () => void action('connect') }) : null,
        !editing && canDisconnect ? h(IconButton, { label: state.status === 'authorizing' ? '取消登录' : '断开机器人', symbol: state.status === 'authorizing' ? 'close' : 'disconnect', className: 'dsh-dt-danger', disabled: blocked, onClick: () => void action('disconnect') }) : null)),
    statusError ? h('p', { role: 'alert', className: 'dsh-dt-notice', 'data-tone': 'warning' }, state.status === 'loading' ? '暂时无法读取机器人状态，请重试。' : '机器人状态读取失败；显示上次确认状态。') : null,
    personal && editing ? h('form', { className: 'dsh-dt-form', onSubmit: (event: any) => { event.preventDefault(); if (clientId.trim() && secret) void action('configure'); } },
      h('label', null, 'Client ID', h('input', { value: clientId, autoComplete: 'off', maxLength: 200, required: true, disabled: blocked, onChange: (e: any) => setClientId(e.target.value) })),
      h('label', null, 'Client Secret', h('input', { type: 'password', value: secret, autoComplete: 'new-password', maxLength: 4096, required: true, disabled: blocked, onChange: (e: any) => setSecret(e.target.value) })),
      h('div', { className: 'dsh-dt-form-actions' }, h(IconButton, { type: 'submit', label: busy ? '验证中' : '下一步', caption: busy ? '验证中' : '下一步', symbol: 'check', className: 'dsh-dt-primary', disabled: blocked || !clientId.trim() || !secret }), h(IconButton, { label: '取消配置', caption: '取消', symbol: 'close', disabled: blocked, onClick: () => { setSecret(''); setEditing(false); } }))) : null,
    personal && state.configured && state.status !== 'connected' && !editing ? h('div', { className: 'dsh-dt-callback' }, h('p', null, '在钉钉应用的安全设置中登记重定向 URL：'), h('code', null, state.callbackUrl), h(IconButton, { label: '复制回调地址', caption: '复制', symbol: 'copy', disabled: blocked || !state.callbackUrl, onClick: () => { void (async () => { try { await navigator.clipboard.writeText(state.callbackUrl || ''); } catch { if (active.current) setError('请手动复制回调地址。'); } })(); } })) : null,
    legacy && !editing ? h('div', { className: 'dsh-dt-form' }, h('label', null, '网关地址', h('input', { placeholder: 'wss://gateway.example/relay', value: url, disabled: blocked || state.status === 'authorizing', onChange: (e: any) => setUrl(e.target.value) }))) : null,
    personal && state.hosting && !editing ? h('div', { className: 'dsh-dt-form-actions' }, h(IconButton, { label: '停止托管', caption: '停止托管', symbol: 'disconnect', className: 'dsh-dt-danger', disabled: blocked, onClick: () => void action('stop') })) : null,
    state.status === 'authorizing' && state.authorizeUrl ? h('p', { className: 'dsh-dt-notice' }, '请在机器人应用登录页确认账号与此设备的配对。', ' ', h('a', { className: 'dsh-dt-link', href: state.authorizeUrl, target: '_blank', rel: 'noopener noreferrer' }, '继续登录')) : null,
    state.status !== 'connected' && state.status !== 'authorizing' ? h('p', { className: 'dsh-dt-notice' }, personal ? state.configured ? personalConnectionHelp : firstConfigurationHelp : '连接后，机器人消息将交给这台 DSH。') : null,
    error ? h('p', { role: 'alert', className: 'dsh-dt-notice', 'data-tone': 'warning' }, error) : null), language);
}
