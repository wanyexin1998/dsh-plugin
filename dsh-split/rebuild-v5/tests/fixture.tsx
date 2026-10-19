import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { Workbench } from '../src/workbench';
import { storageKey } from '../src/geometry';
import { FIXTURE_SCOPE, FIXTURE_CURRENT_KEY, FIXTURE_SESSIONS, fixtureHost, FixtureSessionProvider, renderFixtureSlot, readFixtureMetrics } from './fixture-host';
import type { SplitSide } from '../src/host';
import './fixture.css';

const errors: string[] = [];
window.addEventListener('error', event => { errors.push(event.message); });
window.addEventListener('unhandledrejection', event => { errors.push(String(event.reason instanceof Error ? event.reason.message : event.reason)); });

const identities = new WeakMap<Node, string>();
let identitySequence = 0;
function identity(node: Node | null): string | null {
  if (!node) return null;
  let id = identities.get(node);
  if (!id) { id = `observed-node-${++identitySequence}`; identities.set(node, id); }
  return id;
}
function bounds(element: Element | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

// Property getters only: browser acceptance can observe DOM identity and sizes,
// but cannot invoke a hidden layout, action, mutation or evaluation interface.
Object.defineProperty(window, '__v5Evidence', { enumerable: true, configurable: false, writable: false, value: Object.freeze({
  get source() { return 'synthetic fixture for fresh rebuild-v5; not native DSH validation'; },
  get activeSessionId() { return fixtureHost.bridge.currentStore.getSnapshot(); },
  get theme() { return document.documentElement.dataset.theme ?? 'light'; },
  get workspaceSize() { return bounds(document.querySelector('[data-v5-workbench]')); },
  get metrics() { return readFixtureMetrics(); },
  get errors() { return Object.freeze([...errors]); },
  get panels() {
    return Object.freeze(Array.from(document.querySelectorAll<HTMLElement>('.v5-session[data-session-id]')).map(panel => {
      const id = panel.dataset.sessionId!;
      const conversation = panel.querySelector('[data-native-conversation]');
      const sidebar = panel.querySelector('[data-native-sidebar]');
      const draft = panel.querySelector<HTMLTextAreaElement>('[data-fixture-draft]');
      const frame = panel.querySelector<HTMLIFrameElement>('[data-fixture-iframe]');
      const terminal = panel.querySelector<HTMLElement>('[data-fixture-terminal]');
      let iframeInput: string | null = null;
      let iframeCounter: string | null = null;
      try {
        iframeInput = frame?.contentDocument?.querySelector('input')?.value ?? null;
        iframeCounter = frame?.contentDocument?.querySelector<HTMLElement>('#counter')?.dataset.count ?? null;
      } catch { /* Read-only evidence stays available if a browser isolates frames. */ }
      return Object.freeze({
        sessionId: id, panelId: panel.dataset.sessionPanel, active: panel.dataset.active === 'true',
        rect: bounds(panel), sidebarRect: bounds(panel.querySelector('.v5-sidebar')),
        panelNode: identity(panel), conversationNode: identity(conversation), sidebarNode: identity(sidebar),
        draftNode: identity(draft), iframeNode: identity(frame), terminalNode: identity(terminal),
        draft: draft?.value ?? null, iframeInput, iframeCounter,
        conversationInstance: (conversation as HTMLElement | null)?.dataset.instance ?? null,
        sidebarInstance: (sidebar as HTMLElement | null)?.dataset.instance ?? null,
        iframeInstance: frame?.dataset.instance ?? null, terminalInstance: terminal?.dataset.instance ?? null,
        nativeTabsVisible: Boolean(sidebar?.querySelector('.fixture-native-tabs')?.getClientRects().length),
      });
    }));
  },
  get savedGeometry() {
    try { const raw = localStorage.getItem(storageKey(FIXTURE_SCOPE)); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  },
}) });

interface MenuState { target: string; capturedAnchor: string; anchor: HTMLButtonElement }

function FixtureApp() {
  const bridge = fixtureHost.bridge;
  const current = React.useSyncExternalStore(bridge.currentStore.subscribe, bridge.currentStore.getSnapshot);
  React.useSyncExternalStore(bridge.layoutVersion.subscribe, bridge.layoutVersion.getSnapshot);
  const [theme, setTheme] = React.useState<'light' | 'dark'>('light');
  const [narrow, setNarrow] = React.useState(false);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  React.useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <div className="fixture-shell">
    <header className="fixture-toolbar">
      <div><strong>DSH Split v5</strong><span>新实现验收夹具 · 合成宿主</span></div>
      <div className="fixture-tools">
        <button aria-label="切换主题" aria-pressed={theme === 'dark'} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '深色主题' : '浅色主题'}</button>
        <button aria-label="切换容器宽度" aria-pressed={narrow} onClick={() => setNarrow(value => !value)}>{narrow ? '恢复宽容器' : '窄容器 600px'}</button>
        <button onClick={() => location.reload()}>刷新验证恢复</button>
        <button onClick={() => {
          localStorage.removeItem(storageKey(FIXTURE_SCOPE));
          localStorage.removeItem(FIXTURE_CURRENT_KEY);
          location.reload();
        }}>重置夹具布局</button>
      </div>
    </header>
    <nav className="fixture-nav" aria-label="测试会话目录">
      <div className="fixture-nav-label">合成会话</div>
      {FIXTURE_SESSIONS.map(session => <div key={session.id} className="fixture-session-row" data-active={current === session.id}>
        <button className="fixture-session-open" data-fixture-open={session.id} onClick={() => { setMenu(null); fixtureHost.open(session.id); }}>
          <span>{session.id}</span><strong>{session.title}</strong>
        </button>
        <button className="fixture-session-options" data-fixture-menu={session.id} aria-label={`会话 ${session.id} 菜单`}
          aria-haspopup="menu" aria-expanded={menu?.target === session.id} onClick={event => {
            const anchor = bridge.currentStore.getSnapshot();
            const anchorElement = event.currentTarget;
            if (anchor) setMenu(previous => previous?.target === session.id ? null : { target: session.id, capturedAnchor: anchor, anchor: anchorElement });
          }}>⋯</button>
      </div>)}
      <div className="fixture-nav-note">使用各会话的 ⋯ 菜单向右或向下分屏。<br />测试内容只存在于本页；没有连接真实 DSH。</div>
    </nav>
    <main className="fixture-stage">
      <div className="fixture-workbench-frame" data-width-mode={narrow ? 'narrow' : 'wide'} style={{ width: narrow ? 600 : '100%' }}>
        <Workbench bridge={bridge} SessionProvider={FixtureSessionProvider} renderSlot={renderFixtureSlot} />
      </div>
    </main>
    {menu && createPortal(<div data-v5-overlay data-theme={theme}><FixtureSessionMenu state={menu} close={() => setMenu(null)} /></div>, document.body)}
  </div>;
}

function FixtureSessionMenu({ state, close }: { state: MenuState; close(): void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const callback = React.useRef(close); callback.current = close;
  React.useSyncExternalStore(fixtureHost.bridge.layoutVersion.subscribe, fixtureHost.bridge.layoutVersion.getSnapshot);
  const shown = fixtureHost.isShown(state.target);
  React.useLayoutEffect(() => {
    const menu = ref.current!;
    const anchor = state.anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`;
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!event.composedPath().includes(menu) && !event.composedPath().includes(state.anchor)) callback.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); state.anchor.focus(); callback.current(); }
      else if (event.key === 'Tab') { state.anchor.focus(); callback.current(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', keyboard, true); };
  }, [state]);
  return <div ref={ref} className="v5-menu" data-kind="session" role="menu" aria-label={`会话 ${state.target} 选项`} data-captured-anchor={state.capturedAnchor}>
    <div className="v5-menu-title">{fixtureHost.bridge.getSummary(state.target)?.title}</div>
    <button role="menuitem" onClick={() => { close(); fixtureHost.open(state.target); }}>{shown ? '定位此会话' : '在当前窗口打开'}</button><hr />
    {(['right', 'below'] as const).map((side: SplitSide) => {
      const reason = fixtureHost.splitUnavailable(state.capturedAnchor, state.target, side);
      return <button key={side} role="menuitem" disabled={Boolean(reason)} title={reason} data-fixture-split={side}
        onClick={() => {
          const freshReason = fixtureHost.splitUnavailable(state.capturedAnchor, state.target, side);
          close();
          if (!freshReason) fixtureHost.split(state.capturedAnchor, state.target, side);
        }}>{side === 'right' ? '向右分屏' : '向下分屏'}</button>;
    })}
    {shown&&<><button role="menuitem" onClick={()=>{close();fixtureHost.move(state.target);}}>移动分屏</button><button role="menuitem" onClick={()=>{close();fixtureHost.close(state.target);}}>关闭此分屏</button></>}
    <div className="v5-menu-note">相对于会话 {state.capturedAnchor}；打开菜单不会切换会话。</div>
  </div>;
}

const root = document.getElementById('fixture-root');
if (!root) throw new Error('The fixture root element is missing');
createRoot(root).render(<FixtureApp />);
