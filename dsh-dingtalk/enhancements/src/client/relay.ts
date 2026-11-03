import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ConnectionStore } from './store.js';
import { showAuthorizationLoading } from './loading.js';
interface State { status: string; url?: string; authorizeUrl?: string; expires?: number; mode?: 'personal' | 'enterprise'; configured?: boolean; hosting?: boolean; callbackUrl?: string; displayName?: string }
export function RelaySection({ store }: { store: ConnectionStore }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState('');
  const popup = useRef<Window | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const value = await store.relay('status') as State; if (active) { setState(value); setUrl(old => old || value.url || ''); } } catch { if (active) setError('暂时无法读取连接状态'); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [store]);
  useEffect(() => { if (state.status === 'connected') { popup.current?.close(); popup.current = null; } }, [state.status]);
  const personal = state.mode === 'personal';
  const legacy = !state.mode && !['loading', 'unavailable'].includes(state.status);
  const action = async (method: 'connect' | 'disconnect' | 'configure' | 'stop') => {
    setBusy(true); setError('');
    if (method === 'connect') {
      popup.current = window.open('', '_blank');
      if (popup.current) { popup.current.opener = null; showAuthorizationLoading(popup.current); }
    } else { popup.current?.close(); popup.current = null; }
    try {
      const value = await store.relay(method, method === 'configure' ? { clientId: clientId.trim(), clientSecret: secret } : method === 'connect' && legacy ? { url: url.trim() } : {}) as State;
      if (method === 'configure') { setSecret(''); setEditing(false); }
      setState(method === 'disconnect' ? { ...state, status: 'disconnected' } : value);
      if (value.authorizeUrl && popup.current && !popup.current.closed) popup.current.location.replace(value.authorizeUrl);
      else if (!value.authorizeUrl) { popup.current?.close(); popup.current = null; }
    } catch (failure) { popup.current?.close(); popup.current = null; const code = (failure as { reasonCode?: string }).reasonCode || ''; const text: Record<string,string> = { auth_required: '请先完成上方钉钉账号授权。', invalid_credentials: '应用凭据无效或验证暂不可用，请检查后重试。', identity_mismatch: '请使用与当前 DWS 相同的企业账号。', gateway_in_use: '本机端口被占用，或另一 DSH 正在托管此机器人。', device_in_use: '此配置已在另一 DSH 实例运行。', stop_before_configure: '请先停止托管，再修改应用凭据。' }; setError(text[code] || '连接未完成，请检查应用设置后重试。'); }
    finally { setBusy(false); }
  };
  const labels: Record<string, string> = { device_in_use: '此配置已在另一 DSH 实例运行', loading: '读取中', unavailable: '当前通道未提供连接管理', unconfigured: '未配置', enterprise_configuration_invalid: '企业配置有误', mode_conflict: '请先停用个人托管', local_configuration_invalid: '本机配置有误', gateway_in_use: '端口被占用或另一 DSH 正在托管', gateway_unavailable: '本机服务暂不可用', stream_failed: '机器人消息连接失败', disconnected: '未连接', connecting: '连接中', authorizing: '等待登录确认', connected: '已连接', offline: '离线 · 正在重连', auth_required: '请重新授权', replaced: '已在其他设备连接', cancelled: '已取消', expired: '登录已超时', failed: '连接未完成' };
  const connectButton = h('button', { type: 'button', className: 'dsh-dt-icon dsh-dt-caption', disabled: busy || (legacy && !url.trim()) || ['enterprise_configuration_invalid', 'mode_conflict', 'local_configuration_invalid', 'device_in_use'].includes(state.status) || state.status === 'authorizing' || state.status === 'connected', onClick: () => void action('connect') }, '连接');
  return h('section', { className: 'dsh-dt-robot', 'aria-label': '共享机器人', style: { borderTop: '1px solid var(--dt-line)', marginTop: 20, paddingTop: 20 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } }, h('strong', null, state.displayName || '钉钉机器人'), h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, h('span', { role: 'status', style: { color: 'var(--dt-muted)', fontSize: 12 } }, labels[state.status] || state.status), state.mode === 'enterprise' ? connectButton : null, state.mode === 'enterprise' && ['connected', 'authorizing', 'offline', 'auth_required'].includes(state.status) ? h('button', { type: 'button', className: 'dsh-dt-icon', 'aria-label': '断开机器人', disabled: busy, onClick: () => void action('disconnect') }, '×') : null)),
    personal && (!state.configured || !state.hosting) && !editing ? h('button', { type: 'button', className: 'dsh-dt-action', style: { marginTop: 12 }, onClick: () => setEditing(true) }, '配置') : null,
    personal && editing ? h('form', { onSubmit: (event: any) => { event.preventDefault(); void action('configure'); }, style: { display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginTop: 16, maxWidth: 420 } },
      h('label', { style: { display: 'grid', gap: 6 } }, 'Client ID', h('input', { value: clientId, autoComplete: 'off', disabled: busy, onChange: (e: any) => setClientId(e.target.value), style: { boxSizing: 'border-box', width: '100%', padding: '9px 12px', border: '1px solid var(--dt-line)', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit' } })),
      h('label', { style: { display: 'grid', gap: 6 } }, 'Client Secret', h('input', { type: 'password', value: secret, autoComplete: 'new-password', disabled: busy, onChange: (e: any) => setSecret(e.target.value), style: { boxSizing: 'border-box', width: '100%', padding: '9px 12px', border: '1px solid var(--dt-line)', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit' } })),
      h('div', { style: { display: 'flex', gap: 8 } }, h('button', { type: 'submit', className: 'dsh-dt-action', disabled: busy || !clientId.trim() || !secret }, busy ? '验证中' : '下一步'), h('button', { type: 'button', className: 'dsh-dt-icon', 'aria-label': '取消配置', disabled: busy, onClick: () => { setSecret(''); setEditing(false); } }, '×'))) : null,
    personal && state.configured && state.status !== 'connected' && !editing ? h('div', { style: { marginTop: 12, fontSize: 13, overflowWrap: 'anywhere' } }, h('p', null, '在钉钉应用的安全设置中登记重定向 URL：'), h('code', null, state.callbackUrl), h('button', { type: 'button', className: 'dsh-dt-icon', 'aria-label': '复制回调地址', onClick: () => { void navigator.clipboard.writeText(state.callbackUrl || '').catch(() => setError('请手动复制回调地址。')); } }, '复制')) : null,
    !editing && (legacy || personal && state.configured) ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
      legacy ? h('input', { 'aria-label': '网关地址', placeholder: 'wss://网关地址/relay', value: url, disabled: busy || state.status === 'authorizing', onChange: (e: any) => setUrl(e.target.value), style: { flex: 1, minWidth: 0, padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit' } }) : null,
      connectButton,
      ['connected', 'authorizing', 'offline', 'auth_required'].includes(state.status) ? h('button', { type: 'button', className: 'dsh-dt-icon', 'aria-label': state.status === 'authorizing' ? '取消登录' : '断开机器人', title: state.status === 'authorizing' ? '取消登录' : '断开机器人', disabled: busy, onClick: () => void action('disconnect') }, '×') : null, personal && state.hosting ? h('button', { type: 'button', className: 'dsh-dt-icon dsh-dt-caption', disabled: busy, onClick: () => void action('stop') }, '停止托管') : null) : null,
    state.status === 'authorizing' && state.authorizeUrl ? h('p', { style: { fontSize: 13 } }, '请在打开的页面确认。', h('a', { href: state.authorizeUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginLeft: 8 } }, '继续登录')) : null,
    state.status !== 'connected' && state.status !== 'authorizing' ? h('p', { style: { fontSize: 12, color: '#777', margin: '10px 0 0' } }, personal ? '随此 DSH 运行。请先完成上方个人钉钉授权。' : '连接后，机器人消息将交给这台 DSH。') : null,
    error ? h('p', { role: 'alert', style: { fontSize: 13 } }, error) : null);
}
