import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ConnectionStore } from './store.js';
import { showAuthorizationLoading } from './loading.js';
interface State { status: string; url?: string; authorizeUrl?: string; expires?: number }
export function RelaySection({ store }: { store: ConnectionStore }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const popup = useRef<Window | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const value = await store.relay('status') as State; if (active) { setState(value); setUrl(old => old || value.url || ''); } } catch { if (active) setError('暂时无法读取连接状态'); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [store]);
  useEffect(() => { if (state.status === 'connected') { popup.current?.close(); popup.current = null; } }, [state.status]);
  if (state.status === 'unavailable' || state.status === 'loading') return null;
  const action = async (method: 'connect' | 'disconnect') => {
    setBusy(true); setError('');
    if (method === 'connect') {
      popup.current = window.open('', '_blank');
      if (popup.current) { popup.current.opener = null; showAuthorizationLoading(popup.current); }
    } else { popup.current?.close(); popup.current = null; }
    try {
      const value = await store.relay(method, method === 'connect' ? { url: url.trim() } : {}) as State;
      setState(value);
      if (value.authorizeUrl && popup.current && !popup.current.closed) popup.current.location.replace(value.authorizeUrl);
      else if (!value.authorizeUrl) { popup.current?.close(); popup.current = null; }
    } catch { popup.current?.close(); popup.current = null; setError('连接未完成，请检查网关地址与钉钉授权。'); }
    finally { setBusy(false); }
  };
  const labels: Record<string, string> = { disconnected: '未连接', connecting: '连接中', authorizing: '等待登录确认', connected: '已连接', offline: '离线 · 正在重连', auth_required: '请重新授权', replaced: '已在其他设备连接', cancelled: '已取消', expired: '登录已超时', failed: '连接未完成' };
  return h('section', { 'aria-label': '共享机器人', style: { borderTop: '1px solid var(--dsh-dt-border, #eceef0)', marginTop: 20, paddingTop: 20 } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } }, h('strong', null, '共享机器人'), h('span', { role: 'status', style: { color: '#777', fontSize: 13 } }, labels[state.status] || state.status)),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
      h('input', { 'aria-label': '网关地址', placeholder: 'wss://网关地址/relay', value: url, disabled: busy || state.status === 'authorizing', onChange: (e: any) => setUrl(e.target.value), style: { flex: 1, minWidth: 0, padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: 'transparent', color: 'inherit', font: 'inherit' } }),
      h('button', { type: 'button', className: 'dsh-dt-icon dsh-dt-caption', disabled: busy || !url.trim() || state.status === 'authorizing' || state.status === 'connected', onClick: () => void action('connect') }, '连接'),
      ['connected', 'authorizing', 'offline', 'auth_required'].includes(state.status) ? h('button', { type: 'button', className: 'dsh-dt-icon', 'aria-label': state.status === 'authorizing' ? '取消登录' : '断开机器人', title: state.status === 'authorizing' ? '取消登录' : '断开机器人', disabled: busy, onClick: () => void action('disconnect') }, '×') : null),
    state.status === 'authorizing' && state.authorizeUrl ? h('p', { style: { fontSize: 13 } }, '请在打开的页面确认。', h('a', { href: state.authorizeUrl, target: '_blank', rel: 'noopener noreferrer', style: { marginLeft: 8 } }, '继续登录')) : null,
    state.status !== 'connected' && state.status !== 'authorizing' ? h('p', { style: { fontSize: 12, color: '#777', margin: '10px 0 0' } }, '连接成功后，机器人消息将交给这台 DSH。') : null,
    error ? h('p', { role: 'alert', style: { fontSize: 13 } }, error) : null);
}
