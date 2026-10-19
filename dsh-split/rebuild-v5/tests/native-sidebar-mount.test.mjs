import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { JSDOM } from 'jsdom';
import { openAsar, readExportedModuleSource } from '../tools/read-asar.mjs';
import { transformNative } from '../tools/native-patches.mjs';

const archive = openAsar(process.env.DSH_PRISTINE_ASAR ?? 'E:/deepseek-harness/resources/app.asar');
const sidebar = transformNative('sidebar-right', archive.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js')).source;
function section(source, start, end) {
  const at = source.indexOf(start), finish = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && finish > at, `native source boundary: ${start}`);
  return source.slice(at, finish);
}

test('actual native RightbarSeat → SidebarPanel → DockLayout keeps the selected body, draft and iframe on hide/zero-size/show', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://fixture.invalid', pretendToBeVisual: true });
  const previous = {};
  for (const key of ['window', 'document', 'HTMLElement', 'Node', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
  }
  let reactRoot, act;
  try {
    const { createRoot } = await import('react-dom/client');
    ({ act } = await import('react-dom/test-utils'));
    const classes = new Proxy({}, { get: (_, key) => `native-${String(key)}` });
    // 兜底桩：DSH 每个版本都会重命名 bundle 内部符号（de/ke/$r/Zv…），
    // 显式声明优先；未声明的内部辅助符号返回"透明组件"桩，有 children 时原样透出。
    // 兜底只用于「跑完全流程」，不允许静默放行：所有未声明读取都被记入
    // `undeclared`，测试结束前断言为空，因此上游接口一旦消失会明确报错，
    // 并一次列出全部缺失符号（而不是逐个试错）。
    const passThrough = new Proxy(function () {}, {
      apply: (_t, _this, args) => {
        const first = args[0];
        return first && typeof first === 'object' && 'children' in first ? first.children : null;
      },
      construct: () => ({}),
      get: (t, key) => (key === Symbol.toPrimitive ? () => '' : (key in t ? t[key] : passThrough)),
    });
    const explicit = { C: React, u: jsx, ke: classes,
      document: dom.window.document, window: dom.window, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      de: (...items) => items.filter(Boolean).join(' '),
      $r: ({ children }) => children, console,
      // 上游图标组件（SVG 包装），与断言无关，渲染为 null 即可
      Ov: () => null, Zv: () => null,
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } },
      Object, Math, JSON, Array, Number, String, Boolean, Error, TypeError, Symbol, Promise,
      Set, Map, WeakMap, WeakSet, Date, RegExp, parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
      queueMicrotask, setTimeout, clearTimeout,
    };
    const undeclared = new Set();
    const sandbox = new Proxy(explicit, {
      has: () => true,
      get: (t, key) => {
        if (typeof key === 'string' && !(key in t)) undeclared.add(key);
        if (key in t) return t[key];
        return key === Symbol.unscopables ? undefined : passThrough;
      },
    });
    const dockkitModule = vm.runInNewContext(readExportedModuleSource(archive, 'DockLayout'), sandbox);
    const kit = {
      DockLayout: dockkitModule.DockLayout,
      canSplit: dockkitModule.canSplit,
      dockPaneIds: dockkitModule.dockPaneIds,
      findPaneContentTab: dockkitModule.findPaneContentTab,
    };
    const Seat = vm.runInNewContext(`${section(sidebar, 'function guideIn(', '\n\t\t//#endregion\n\t\t//#region lib/types/client/shell/close-focus.js')}\n; RightbarSeat`, {
      react: React, react_jsx_runtime: jsx, _deepseek_ai_dsh_client_ui_dockkit: kit,
      _deepseek_ai_dsh_client_ui_primitives: { Tooltip: ({children}) => children, IconPanelLeftOutlineRegular: () => null },
      SidebarRight_module_css_default: classes, document: dom.window.document,
      GUIDE_KIND: 'guide', pageAddress: kind => `page:${kind}`, canCloseTab: () => true,
      dockLabels: () => ({ splitPane: 'Split', addTab: 'Add', closeTab: 'Close', empty: 'Empty', dockFloat: 'Dock' }),
    });
    let layout = { nodes: { pane: { id: 'pane', kind: 'pane', host: 'dock', tabs: ['native-tab'], activeTabId: 'native-tab' } },
      tabs: { 'native-tab': { id: 'native-tab', kind: 'fixture-provider', title: 'Native Tab', contentId: 'fixture' } },
      rootId: 'pane', activePaneId: 'pane', floats: [], expanded: true, mode: 'push' };
    let state = { bySession: { A: { layout } } }, mounts = 0, unmounts = 0, nativeCloses = 0;
    const listeners = new Set(), signal = new AbortController().signal;
    function BodyProbe() {
      React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      return React.createElement('div', { 'data-provider-probe': true }, React.createElement('textarea', { defaultValue: '草稿' }), React.createElement('iframe', { title: 'identity-probe', src: 'about:blank' }));
    }
    const types = [{ id: 'fixture-provider', kind: 'fixture-provider', keepMounted: true }];
    const noOperation = () => {};
    const actions = new Proxy({}, { get: (_, key) => key === 'closeTab' ? () => nativeCloses++ : noOperation });
    const props = { sessionId: 'A', embedded: true, canShow: true, active: true, actions, t: key => key,
      useStore: select => select(React.useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state)),
      useTabTypes: select => select(types), useTabNavigation: () => ({}), useShortcuts: select => select([]),
      occurrence: () => ({ id: 'occurrence-A', signal, tabActions: {} }), retainTab: () => () => {},
      renderSlot: seat => seat === 'sidebar.right.pane.tab' ? React.createElement(BodyProbe) : 'Native Tab',
      syncPresentation: () => { throw new Error('embedded seat tried to write global track'); }, reportAutoFullscreen: () => { throw new Error('embedded seat tried to report viewport fullscreen'); },
      measureRoom: noOperation, setEmbeddedVisible: noOperation, onPresentation: noOperation, openTab: noOperation, closeTab: () => nativeCloses++, splitPane: noOperation, toggleFullscreen: noOperation,
    };
    const render = hidden => React.createElement('aside', { hidden }, React.createElement(Seat, { ...props, width: hidden ? 0 : 500, viewportWidth: hidden ? 0 : 500, hostHeight: hidden ? 0 : 400 }));
    reactRoot = createRoot(dom.window.document.getElementById('root'));
    await act(async () => { reactRoot.render(render(false)); });
    const body = dom.window.document.querySelector('[data-provider-probe]');
    const text = body.querySelector('textarea'), frame = body.querySelector('iframe');
    const tab = dom.window.document.querySelector('[data-dockkit-content="native-tab"]');
    text.value = '未提交的中文草稿';
    await act(async () => {
      layout = { ...layout, expanded: false }; state = { bySession: { A: { layout } } };
      for (const fn of [...listeners]) fn(); reactRoot.render(render(true));
    });
    assert.equal(dom.window.document.querySelector('[data-provider-probe]'), body);
    assert.equal(dom.window.document.querySelector('iframe'), frame);
    assert.equal(dom.window.document.querySelector('[data-dockkit-content="native-tab"]'), tab);
    assert.equal(text.value, '未提交的中文草稿');
    assert.equal(mounts, 1); assert.equal(unmounts, 0); assert.equal(nativeCloses, 0);
    await act(async () => {
      layout = { ...layout, expanded: true }; state = { bySession: { A: { layout } } };
      for (const fn of [...listeners]) fn(); reactRoot.render(render(false));
    });
    assert.equal(dom.window.document.querySelector('iframe'), frame);
    assert.equal(mounts, 1); assert.equal(unmounts, 0); assert.equal(nativeCloses, 0);
    await act(async () => { reactRoot.unmount(); }); reactRoot = undefined;
    assert.equal(unmounts, 1); assert.equal(nativeCloses, 0);
    // 沙箱必须覆盖真实代码用到的每一个 bundle 外部符号：缺失即说明上游契约
    // 变了（或桩表漏了），这里一次列出全部，避免兜底桩把不兼容悄悄放行。
    assert.deepEqual([...undeclared].sort(), [],
      `sandbox 缺少这些 bundle 符号，需要显式声明: ${[...undeclared].sort().join(', ')}`);
  } finally {
    if (reactRoot) await act(async () => { reactRoot.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
