import * as React from 'react';
import { SessionPane } from '../src/workbench';
import { NATIVE_CONTRACT, SESSION_SLOT, type NativeBridge, type NativeCallbacks, type SessionReference, type SessionSummary, type SidebarPresentation, type SplitSide } from '../src/host';

/** Synthetic acceptance host. It never connects to DSH, a model, files or PTY. */
export const FIXTURE_SCOPE = 'fresh-v5-ui-fixture';
export const FIXTURE_CURRENT_KEY = 'dsh.split.v5.fixture.current';
export const FIXTURE_SESSIONS: readonly SessionSummary[] = Object.freeze([
  { id: 'A', title: 'A · 分析任务' },
  { id: 'B', title: 'B · 接口核对' },
  { id: 'C', title: 'C · 发布检查' },
]);

export interface FixtureMetrics {
  retainCalls: number;
  releaseCalls: number;
  liveReferences: number;
  conversationMounts: number;
  conversationUnmounts: number;
  sidebarMounts: number;
  sidebarUnmounts: number;
  iframeLoads: number;
  terminalStarts: number;
  terminalStops: number;
  terminalTicks: number;
}
const metrics = new Map<string, FixtureMetrics>();
function metric(id: string): FixtureMetrics {
  let value = metrics.get(id);
  if (!value) {
    value = { retainCalls: 0, releaseCalls: 0, liveReferences: 0, conversationMounts: 0, conversationUnmounts: 0,
      sidebarMounts: 0, sidebarUnmounts: 0, iframeLoads: 0, terminalStarts: 0, terminalStops: 0, terminalTicks: 0 };
    metrics.set(id, value);
  }
  return value;
}
export function readFixtureMetrics() {
  return Object.freeze(Object.fromEntries([...metrics].map(([id, value]) => [id, Object.freeze({ ...value })])));
}

function readCurrent() {
  try {
    const stored = localStorage.getItem(FIXTURE_CURRENT_KEY);
    if (FIXTURE_SESSIONS.some(session => session.id === stored)) return stored!;
  } catch { /* The fixture also works with storage blocked. */ }
  return 'A';
}
function createFixtureHost() {
  let current = readCurrent();
  let revision = 0;
  let callbacks: NativeCallbacks = {};
  const currentListeners = new Set<() => void>();
  const layoutListeners = new Set<() => void>();
  const expanded = new Map<string, boolean>();
  const fullscreen = new Map<string, boolean>();
  const catalog = Object.freeze({ byId: Object.freeze(Object.fromEntries(FIXTURE_SESSIONS.map(session => [session.id, session]))) });
  const nativeBindings = new Map(FIXTURE_SESSIONS.map(session => [session.id, Object.freeze({ sessionId: session.id, synthetic: true })]));
  const focus = (id: string) => {
    if (!nativeBindings.has(id) || id === current) return;
    current = id;
    try { localStorage.setItem(FIXTURE_CURRENT_KEY, id); } catch { /* Optional fixture persistence. */ }
    for (const listener of [...currentListeners]) listener();
  };
  const notify = () => { revision += 1; for (const listener of [...layoutListeners]) listener(); };
  const reportSidebar = (id: string, value: SidebarPresentation) => {
    expanded.set(id, value.expanded);
    fullscreen.set(id, value.fullscreen);
    callbacks.sidebarPresentation?.(id, value);
  };
  const setExpanded = (id: string, value: boolean) => {
    reportSidebar(id, { expanded: value, fullscreen: value && (fullscreen.get(id) ?? false) });
  };
  const bridge: NativeBridge & { storageScope: string } = {
    contract: NATIVE_CONTRACT,
    storageScope: FIXTURE_SCOPE,
    catalogStore: { getSnapshot: () => catalog, subscribe: () => () => {} },
    currentStore: {
      getSnapshot: () => current,
      subscribe: listener => { currentListeners.add(listener); return () => { currentListeners.delete(listener); }; },
    },
    layoutVersion: {
      getSnapshot: () => revision,
      subscribe: listener => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener); }; },
    },
    retain(id) {
      const binding = nativeBindings.get(id);
      if (!binding) throw new Error(`Unknown synthetic session ${id}`);
      const value = metric(id);
      value.retainCalls += 1;
      value.liveReferences += 1;
      let released = false;
      return { sessionId: id, binding, ready: Promise.resolve(binding), release() {
        if (released) return;
        released = true;
        value.releaseCalls += 1;
        value.liveReferences -= 1;
      } };
    },
    getSummary: id => FIXTURE_SESSIONS.find(session => session.id === id),
    focusSession: focus,
    setCallbacks(next) { callbacks = next; notify(); return () => { if (callbacks === next) callbacks = {}; }; },
    notifyLayout: notify,
    toggleSidebar: id => setExpanded(id, !(expanded.get(id) ?? true)),
    setSidebarExpanded: setExpanded,
    setSidebarFullscreen: (id, value) => reportSidebar(id, { expanded: value || (expanded.get(id) ?? true), fullscreen: value }),
    reportSidebar,
    dispose() { callbacks = {}; currentListeners.clear(); layoutListeners.clear(); },
  };
  return {
    bridge,
    isFullscreen: (id: string) => fullscreen.get(id) ?? false,
    move: (id: string) => callbacks.moveSession?.(id),
    close: (id: string) => callbacks.closeSession?.(id),
    open(id: string) { focus(id); callbacks.openSession?.(id); },
    isShown(id: string) { return callbacks.isShown?.(id) ?? false; },
    splitUnavailable(anchor: string, target: string, side: SplitSide) {
      return callbacks.splitUnavailable?.(anchor, target, side);
    },
    split(anchor: string, target: string, side: SplitSide) { callbacks.splitSession?.(anchor, target, side); },
  };
}
export const fixtureHost = createFixtureHost();

const SessionContext = React.createContext<SessionReference | null>(null);
export function FixtureSessionProvider({ session, children }: { session: SessionReference; children: React.ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function renderFixtureSlot(name: string, owner: Record<string, unknown>) {
  return name === SESSION_SLOT ? <FixtureSessionSlot owner={owner} /> : null;
}
function FixtureSessionSlot({ owner }: { owner: Record<string, unknown> }) {
  const session = React.useContext(SessionContext);
  if (!session) throw new Error('The synthetic session scope is missing');
  const nativeOwner = owner as Pick<React.ComponentProps<typeof SessionPane>, 'pane' | 'workspace' | 'gestures' | 'theme'>;
  return <SessionPane {...nativeOwner} bridge={fixtureHost.bridge} sessionId={session.sessionId}
    renderFactorySlot={(name, nativeProps) => name === 'conversation.surface'
      ? <FixtureConversation sessionId={session.sessionId} />
      : name === 'sidebar.right.surface' ? <FixtureSidebar sessionId={session.sessionId} nativeProps={nativeProps} /> : null} />;
}

let identitySequence = 0;
function useIdentity(prefix: string) { return React.useState(() => `${prefix}-${++identitySequence}`)[0]; }

function FixtureConversation({ sessionId }: { sessionId: string }) {
  const identity = useIdentity(`conversation-${sessionId}`);
  const [draft, setDraft] = React.useState('');
  const [sent, setSent] = React.useState<string[]>([]);
  React.useEffect(() => {
    metric(sessionId).conversationMounts += 1;
    return () => { metric(sessionId).conversationUnmounts += 1; };
  }, [sessionId]);
  return <div className="fixture-native fixture-conversation" data-native-conversation data-session-id={sessionId} data-instance={identity}>
    <div className="fixture-native-heading"><span>原生 Conversation 测试替身</span><strong>会话 {sessionId}</strong><button onClick={()=>fixtureHost.bridge.toggleSidebar(sessionId)}>切换测试 Sidebar</button></div>
    <div className="fixture-conversation-copy"><p>此内容仅用于验证新 Workbench。输入草稿后移动会话或 Sidebar，文本与节点身份应保持。</p>
      <p>这是合成内容，不连接真实会话、文件、模型或服务器。</p>
      {sent.map((text, index) => <p className="fixture-sent" key={index}>{text}</p>)}
    </div>
    <label className="fixture-draft-label" htmlFor={`draft-${sessionId}`}>会话 {sessionId} 的测试草稿</label>
    <textarea id={`draft-${sessionId}`} data-fixture-draft={sessionId} aria-label={`会话 ${sessionId} 测试输入`}
      placeholder={`在会话 ${sessionId} 输入，验证草稿保留…`} value={draft} onChange={event => setDraft(event.target.value)} />
    <div className="fixture-composer-actions"><small>已输入 {draft.length} 字</small><button disabled={!draft.trim()} onClick={() => { setSent(previous => [...previous, draft]); setDraft(''); }}>记录到夹具</button></div>
  </div>;
}

function FixtureSidebar({ sessionId, nativeProps }: { sessionId: string; nativeProps: Record<string, unknown> }) {
  React.useSyncExternalStore(fixtureHost.bridge.layoutVersion.subscribe,fixtureHost.bridge.layoutVersion.getSnapshot);
  const fullscreen=fixtureHost.isFullscreen(sessionId);
  const identity = useIdentity(`sidebar-${sessionId}`);
  const [tab, setTab] = React.useState<'preview' | 'terminal'>('preview');
  const [terminalExists, setTerminalExists] = React.useState(true);
  React.useEffect(() => {
    metric(sessionId).sidebarMounts += 1;
    return () => { metric(sessionId).sidebarUnmounts += 1; };
  }, [sessionId]);
  return <div className="fixture-native fixture-sidebar dv-dockview" data-native-sidebar data-session-id={sessionId} data-instance={identity}
    data-host-visible={String(Boolean(nativeProps.active))}>
    <div className="dv-groupview fixture-native-group">
      <div className="dv-tabs-and-actions-container fixture-native-tabs" role="tablist" aria-label={`会话 ${sessionId} 原生测试标签`}>
        <button role="tab" aria-selected={tab === 'preview'} aria-controls={`preview-${sessionId}`} onClick={() => setTab('preview')}>预览</button>
        <button role="tab" aria-selected={tab === 'terminal'} aria-controls={`terminal-${sessionId}`} onClick={() => setTab('terminal')}>终端</button>
        <button aria-label={fullscreen?'还原测试 Sidebar':'全屏测试 Sidebar'} onClick={()=>fixtureHost.bridge.setSidebarFullscreen(sessionId,!fullscreen)}>{fullscreen?'还原':'全屏'}</button>
        <button aria-label="收起测试 Sidebar" onClick={()=>fixtureHost.bridge.setSidebarExpanded(sessionId,false)}>收起</button>
      </div>
      <div className="fixture-native-pages">
        <div id={`preview-${sessionId}`} role="tabpanel" hidden={tab !== 'preview'} className="fixture-native-page"><FixturePreview sessionId={sessionId} /></div>
        <div id={`terminal-${sessionId}`} role="tabpanel" hidden={tab !== 'terminal'} className="fixture-native-page">
          {terminalExists ? <FixtureTerminal sessionId={sessionId} onClose={() => setTerminalExists(false)} />
            : <div className="fixture-terminal-empty"><p>测试终端已显式关闭。</p><button onClick={() => setTerminalExists(true)}>新建测试终端</button></div>}
        </div>
      </div>
    </div>
  </div>;
}

function FixturePreview({ sessionId }: { sessionId: string }) {
  const identity = useIdentity(`iframe-${sessionId}`);
  const [loads, setLoads] = React.useState(0);
  const source = React.useMemo(() => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    html{color-scheme:light}body{margin:0;padding:16px;font:13px/1.8 system-ui,sans-serif;color:#333;background:#fcfcfa}
    h2{font-size:16px;font-weight:500}small{color:#777}input,button{font:inherit;border:1px solid #d7d7cf;border-radius:6px;padding:7px;background:#fff;color:#333}
    input{display:block;width:calc(100% - 16px);margin:12px 0}button{cursor:pointer}section{margin-top:20px;border-top:1px solid #ddd;padding-top:12px}
    </style><small>本地 iframe 测试替身 · ${sessionId}</small><h2>保持此页面的输入与计数</h2>
    <input aria-label="iframe ${sessionId} 测试输入" placeholder="在 iframe 中输入…"><button id="counter" data-count="0" onclick="this.dataset.count=Number(this.dataset.count)+1;this.textContent='页面计数 '+this.dataset.count">页面计数 0</button>
    <section>移动会话、四边停靠或折叠 Sidebar 时，此页面不应重新加载。</section></html>`, [sessionId]);
  return <><div className="fixture-frame-caption">iframe 加载 <output data-iframe-loads={sessionId}>{loads}</output> 次</div>
    <iframe title={`会话 ${sessionId} 测试预览`} data-fixture-iframe={sessionId} data-instance={identity} srcDoc={source}
      onLoad={() => { metric(sessionId).iframeLoads += 1; setLoads(previous => previous + 1); }} /></>;
}

function FixtureTerminal({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const identity = useIdentity(`terminal-${sessionId}`);
  const [ticks, setTicks] = React.useState(0);
  const [command, setCommand] = React.useState('');
  React.useEffect(() => {
    metric(sessionId).terminalStarts += 1;
    const timer = setInterval(() => { metric(sessionId).terminalTicks += 1; setTicks(previous => previous + 1); }, 500);
    return () => { clearInterval(timer); metric(sessionId).terminalStops += 1; };
  }, [sessionId]);
  return <div className="fixture-terminal" data-fixture-terminal={sessionId} data-instance={identity}>
    <div className="fixture-terminal-heading"><span>页面计数器 · 测试替身</span><button aria-label={`关闭会话 ${sessionId} 测试终端`} onClick={onClose}>关闭终端</button></div>
    <pre>session {sessionId}{'\n'}terminal identity {identity}{'\n\n'}运行计数 <output data-terminal-ticks={sessionId}>{ticks}</output>{'\n'}收起 Sidebar 后应继续。</pre>
    <input aria-label={`会话 ${sessionId} 测试终端输入`} placeholder="只记录文本，不执行命令" value={command} onChange={event => setCommand(event.target.value)} />
  </div>;
}

/** Optional esbuild alias for the host-only menu primitive import. */
export function MenuItemButton({ onSelect, children, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> & { onSelect?: () => void }) {
  return <button {...props} onClick={() => onSelect?.()}>{children}</button>;
}
