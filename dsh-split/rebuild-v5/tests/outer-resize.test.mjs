import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadPureTypeScript } from './load-pure-typescript.mjs';
const { installOuterResize } = await loadPureTypeScript(new URL('../src/outer-resize.ts', import.meta.url));
const { movePreviewRect } = await loadPureTypeScript(new URL('../src/geometry.ts', import.meta.url));

// This uses the real locked engine and its real sash handlers. JSDOM supplies
// events and identity; the explicit rectangle shim is not a browser layout test.
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://layout-contract.invalid/',
});
const win = dom.window;
class TestPointerEvent extends win.MouseEvent {
  constructor(type, options = {}) {
    super(type, options);
    for (const [key, value] of Object.entries({
      pointerId: options.pointerId ?? 1,
      pointerType: options.pointerType ?? 'mouse',
      isPrimary: options.isPrimary ?? true,
    })) Object.defineProperty(this, key, { value });
  }
}
win.PointerEvent = TestPointerEvent;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
for (const key of ['window', 'document', 'navigator', 'Document', 'DocumentFragment', 'ShadowRoot', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node',
  'MutationObserver', 'MouseEvent', 'KeyboardEvent', 'Event', 'CustomEvent', 'DOMRect']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? win : win[key], configurable: true, writable: true });
}
globalThis.PointerEvent = TestPointerEvent;
globalThis.ResizeObserver = TestResizeObserver;
win.ResizeObserver = TestResizeObserver;
globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globalThis.getComputedStyle = win.getComputedStyle.bind(win);

function length(element, axis, visited = new Set()) {
  if (!element || visited.has(element)) return 0;
  visited.add(element);
  const key = axis === 'x' ? 'width' : 'height';
  const raw = element.style?.[key] ?? '';
  if (/^[\d.]+px$/u.test(raw)) return Number.parseFloat(raw);
  if (element.classList?.contains('dv-sash')) {
    const horizontal = element.parentElement?.parentElement?.classList.contains('dv-horizontal');
    if ((axis === 'x' && horizontal) || (axis === 'y' && !horizontal)) return 12;
  }
  const parent = length(element.parentElement, axis, visited);
  return raw.endsWith('%') ? parent * Number.parseFloat(raw) / 100 : parent;
}
win.HTMLElement.prototype.getBoundingClientRect = function () {
  const width = length(this, 'x');
  const height = length(this, 'y');
  let x = 0;
  let y = 0;
  for (let element = this; element; element = element.parentElement) {
    x += Number.parseFloat(element.style?.left ?? '') || 0;
    y += Number.parseFloat(element.style?.top ?? '') || 0;
  }
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON() { return this; } };
};
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return length(this, 'x'); } });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return length(this, 'y'); } });
const { createDockview } = await import('dockview-core');
const { build } = require('esbuild');
const workspaceBuild = await build({
  stdin: {
    contents: "export { Workspace } from './workspace'; export { Gestures } from './gestures';",
    resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['dockview-core'],
});
const workspaceModule = { exports: {} };
new Function('require', 'module', 'exports', '__dirname', workspaceBuild.outputFiles[0].text)(
  require, workspaceModule, workspaceModule.exports, dirname(fileURLToPath(import.meta.url)),
);
const { Workspace, Gestures } = workspaceModule.exports;
after(() => dom.window.close());

function harness() {
  const container = document.createElement('div');
  container.style.width = '1000px';
  container.style.height = '700px';
  document.body.append(container);
  const renderers = [];
  let disposeCount = 0;
  const api = createDockview(container, {
    disableAutoResizing: true,
    createComponent() {
      const element = document.createElement('div');
      const native = document.createElement('section');
      native.setAttribute('data-native-boundary', '');
      const input = document.createElement('input');
      input.value = 'native draft fixture';
      native.append(input);
      element.append(native);
      renderers.push({ element, native, input });
      return { element, init() {}, dispose() { disposeCount++; } };
    },
  });
  api.layout(1000, 700);
  const a = api.addPanel({ id: 'a', component: 'session', renderer: 'always', minimumWidth: 330, minimumHeight: 270 });
  const b = api.addPanel({ id: 'b', component: 'session', renderer: 'always', minimumWidth: 330, minimumHeight: 270,
    position: { referencePanel: 'a', direction: 'right' } });
  api.layout(1000, 700);
  const calls = [];
  const uninstall = installOuterResize(container, api, {
    onStart: () => calls.push('start'),
    onChange: () => calls.push('change'),
    onEnd: (cancelled) => calls.push(cancelled ? 'cancel' : 'commit'),
  });
  const identities = renderers.map((item) => ({ ...item, elementParent: item.element.parentNode, nativeParent: item.native.parentNode }));
  function assertIdentity() {
    assert.equal(disposeCount, 0);
    for (const item of identities) {
      assert.equal(item.element.parentNode, item.elementParent);
      assert.equal(item.native.parentNode, item.nativeParent);
      assert.equal(item.native.firstChild, item.input);
      assert.equal(item.input.value, 'native draft fixture');
    }
  }
  return {
    container, api, a, b, calls, renderers, uninstall, assertIdentity,
    sash: () => container.querySelector('.v5-outer-separator'),
    cleanup() { uninstall(); api.dispose(); container.remove(); },
  };
}

function pointer(target, type, x, y, pointerId = 1) {
  target.dispatchEvent(new win.PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId, isPrimary: true,
    pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
    clientX: x, clientY: y,
  }));
}
const settle = () => Promise.resolve();
const tick = () => new Promise((resolve) => win.requestAnimationFrame(resolve));
function keyboard(target, key) {
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}
function widths(h) { return [h.a.api.width, h.b.api.width]; }

test('real Dockview sashes receive accessible transparent-handle metadata', () => {
  const h = harness();
  try {
    const sash = h.sash();
    assert.ok(sash);
    assert.equal(sash.getAttribute('role'), 'separator');
    assert.equal(sash.getAttribute('aria-orientation'), 'vertical');
    assert.equal(sash.tabIndex, 0);
    assert.equal(sash.getAttribute('aria-valuenow'), '50');
  } finally { h.cleanup(); }
});

test('native pointer sizing commits once and preserves content root parents', async () => {
  const h = harness();
  try {
    const before = widths(h);
    pointer(h.sash(), 'pointerdown', 500, 350);
    assert.ok(document.querySelector('[data-v5-outer-resize-shield]'));
    pointer(document, 'pointermove', 560, 350);
    assert.ok(h.a.api.width > before[0]);
    pointer(document, 'pointerup', 560, 350);
    await settle();
    assert.equal(h.calls.filter((call) => call === 'commit').length, 1);
    assert.equal(document.querySelector('[data-v5-outer-resize-shield]'), null);
    h.assertIdentity();
  } finally { h.cleanup(); }
});

for (const cancelBy of ['Escape', 'blur', 'pointercancel', 'contextmenu', 'dispose']) {
  test(`${cancelBy} restores the actual engine's start sizes without fromJSON or native remount`, async () => {
    const h = harness();
    try {
      h.a.api.setSize({ width: 600 });
      const before = widths(h);
      let fromJSONCalls = 0;
      const original = h.api.fromJSON.bind(h.api);
      h.api.fromJSON = (...args) => { fromJSONCalls++; return original(...args); };
      pointer(h.sash(), 'pointerdown', 600, 350);
      pointer(document, 'pointermove', 640, 350);
      assert.notDeepEqual(widths(h), before);
      if (cancelBy === 'Escape') keyboard(document, 'Escape');
      else if (cancelBy === 'blur') win.dispatchEvent(new win.Event('blur'));
      else if (cancelBy === 'pointercancel') pointer(document, 'pointercancel', 640, 350);
      else if (cancelBy === 'contextmenu') document.dispatchEvent(new win.MouseEvent('contextmenu', { cancelable: true }));
      else h.uninstall();
      await settle();
      assert.deepEqual(widths(h), before);
      assert.equal(fromJSONCalls, 0);
      assert.equal(h.calls.filter((call) => call === 'cancel').length, 1);
      assert.equal(document.querySelector('[data-v5-outer-resize-shield]'), null);
      pointer(document, 'pointermove', 700, 350);
      assert.deepEqual(widths(h), before, 'native pointer listener was released');
      h.assertIdentity();
    } finally { h.cleanup(); }
  });
}

test('Escape cancellation takes precedence over a native document-level stop shortcut', () => {
  const h = harness();
  let nativeStop = 0;
  const stop = (event) => { if (event.key === 'Escape') nativeStop++; };
  document.addEventListener('keydown', stop);
  try {
    pointer(h.sash(), 'pointerdown', 500, 350);
    pointer(document, 'pointermove', 550, 350);
    keyboard(document, 'Escape');
    assert.equal(nativeStop, 0);
  } finally { document.removeEventListener('keydown', stop); h.cleanup(); }
});

test('double-click equalizes through the real native sash path', async () => {
  const h = harness();
  try {
    h.a.api.setSize({ width: 630 });
    assert.notEqual(h.a.api.width, h.b.api.width);
    h.sash().dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    assert.ok(Math.abs(h.a.api.width - h.b.api.width) <= 1);
    assert.equal(h.calls.at(-1), 'commit');
    h.assertIdentity();
  } finally { h.cleanup(); }
});

test('keyboard arrows and Home/End stay within actual engine minimum constraints', async () => {
  const h = harness();
  try {
    const sash = h.sash();
    keyboard(sash, 'ArrowRight');
    await settle();
    assert.ok(h.a.api.width > 500);
    keyboard(sash, 'Home');
    await settle();
    assert.equal(h.a.api.width, 330);
    keyboard(sash, 'End');
    await settle();
    assert.equal(h.b.api.width, 330);
    keyboard(sash, 'ArrowLeft');
    await settle();
    assert.ok(h.b.api.width > 330);
    assert.ok(Number(sash.getAttribute('aria-valuenow')) < 67);
    h.assertIdentity();
  } finally { h.cleanup(); }
});

test('native boundary sashes are neither enhanced nor intercepted', async () => {
  const h = harness();
  try {
    const nativeSash = document.createElement('div');
    nativeSash.className = 'dv-sash';
    h.renderers[0].native.append(nativeSash);
    await tick();
    let nativeDown = 0;
    nativeSash.addEventListener('pointerdown', () => nativeDown++);
    const before = widths(h);
    pointer(nativeSash, 'pointerdown', 100, 100);
    keyboard(nativeSash, 'ArrowRight');
    assert.equal(nativeDown, 1);
    assert.equal(nativeSash.getAttribute('role'), null);
    assert.equal(nativeSash.classList.contains('v5-outer-separator'), false);
    assert.equal(h.calls.includes('start'), false);
    assert.deepEqual(widths(h), before);
  } finally { h.cleanup(); }
});

test('outer branch equalization also works when one adjacent side contains multiple groups', async () => {
  const h = harness();
  try {
    const c = h.api.addPanel({ id: 'c', component: 'session', renderer: 'always', minimumWidth: 330, minimumHeight: 270,
      position: { referencePanel: 'b', direction: 'below' } });
    h.api.layout(1000, 700);
    h.a.api.setSize({ width: 630 });
    await tick();
    const sash = h.container.querySelector('.v5-outer-separator[data-axis="x"]');
    assert.ok(sash);
    sash.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
    await settle();
    assert.ok(Math.abs(h.a.api.width - h.b.api.width) <= 1);
    assert.equal(h.b.api.width, c.api.width);
    assert.equal(h.api.groups.every((group) => group.panels.length === 1), true);
    h.assertIdentity();
  } finally { h.cleanup(); }
});

test('api.layout narrow-to-wide preserves proportions and renderer DOM parents', () => {
  const h = harness();
  try {
    h.a.api.setSize({ width: 620 });
    const before = widths(h);
    h.api.layout(500, 700);
    h.api.layout(1000, 700);
    assert.deepEqual(widths(h), before);
    h.assertIdentity();
  } finally { h.cleanup(); }
});

test('maximized narrow projection returns to the prior wide geometry without deserialization', () => {
  const h = harness();
  try {
    h.a.api.setSize({ width: 610 });
    const before = widths(h);
    h.a.api.group.api.maximize();
    h.api.layout(500, 700);
    // Restore the desktop envelope before unhiding siblings; otherwise the
    // engine saves the narrow minimum-clamped proportions during unmaximize.
    h.api.layout(1000, 700);
    h.a.api.group.api.exitMaximized();
    h.api.layout(1000, 700);
    assert.deepEqual(widths(h), before);
    h.assertIdentity();
  } finally { h.cleanup(); }
});

function workspaceHarness(initial = new Map(), options = {}) {
  const container = document.createElement('div');
  container.style.width = '1100px';
  container.style.height = '750px';
  document.body.append(container);
  win.innerWidth = 1400;
  const values = initial;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const focused = [];
  let loading=Boolean(options.loading);
  const catalogListeners=new Set();
  let callbacks;
  const bridge = {
    currentStore: { getSnapshot: () => 'session-a' },
    catalogStore:{getSnapshot:()=>({phase:loading?'pending':'ready'}),subscribe(fn){catalogListeners.add(fn);return()=>catalogListeners.delete(fn);}},
    getSummary: (id) => !loading && !options.missing?.includes(id) && ['session-a', 'session-b', 'session-c'].includes(id) ? { title: id } : undefined,
    focusSession: (id) => {assert.ok(bridge.getSummary(id),'focus must wait for a known native session');focused.push(id);},
    notifyLayout() {},
    setSidebarExpanded() {},
    setCallbacks(value) { callbacks = value; return () => { callbacks = undefined; }; },
  };
  const workspace = new Workspace(bridge, 'test-scope', storage);
  workspace.attach(container);
  function identity() {
    return new Map([...workspace.mounts].map(([id, mount]) => [id, { mount, parent: mount.parentNode }]));
  }
  function assertIdentity(saved) {
    for (const [id, entry] of saved) {
      assert.equal(workspace.mounts.get(id), entry.mount);
      assert.equal(entry.mount.parentNode, entry.parent);
    }
  }
  return {
    workspace, container, values, focused, identity, assertIdentity,
    callbacks: () => callbacks,
    catalogReady(){loading=false;for(const listener of [...catalogListeners])listener();},
    resize(width, height = 750, viewport = 1400) {
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
      win.innerWidth = viewport;
      workspace.layout();
    },
    cleanup() { workspace.dispose(); container.remove(); win.innerWidth = 1400; },
  };
}

test('cold restoration waits for the native catalog and skips removed sessions without losing the saved layout while loading',()=>{
  const original=workspaceHarness();
  original.workspace.split('session-a','session-b','right');
  original.workspace.save();
  const saved=new Map(original.values);
  original.cleanup();
  const cold=workspaceHarness(new Map(saved),{loading:true});
  assert.equal(cold.workspace.panes.size,0);
  cold.workspace.save();assert.deepEqual(cold.values,saved);
  cold.catalogReady();assert.equal(cold.workspace.panes.size,2);cold.cleanup();
  const removed=workspaceHarness(new Map(saved),{loading:true,missing:['session-b']});
  removed.catalogReady();assert.deepEqual([...removed.workspace.panes.values()].map(p=>p.sessionId),['session-a']);removed.cleanup();
});

test('Workspace splits A/B, moves A below B, closes A and restores the remaining geometry', () => {
  const h = workspaceHarness();
  const w = h.workspace;
  let remaining;
  try {
    const a = w.bySession('session-a').id;
    w.split('session-a', 'session-b', 'right');
    const b = w.bySession('session-b').id;
    const identities = h.identity();
    assert.equal(w.panes.size, 2);
    assert.equal(w.api.groups.every((group) => group.panels.length === 1), true);
    assert.equal(w.move(a, b, 'bottom'), true);
    assert.equal(w.api.getPanel(a).api.width, w.api.getPanel(b).api.width);
    h.assertIdentity(identities);
    w.close(a);
    assert.equal(w.panes.size, 1);
    assert.equal(w.bySession('session-b').id, b);
    assert.equal(w.api.groups.length, 1);
    w.save();
    remaining = new Map(h.values);
  } finally { h.cleanup(); }
  const restored = workspaceHarness(remaining);
  try {
    // Native current navigation is explicitly A; its ordinary open replaces
    // the surviving position, rather than adding an extra editing root.
    assert.equal(restored.workspace.api.groups.length, 1);
    assert.equal(restored.workspace.panes.size, 1);
    assert.equal(restored.workspace.bySession('session-a').sessionId, 'session-a');
  } finally { restored.cleanup(); }
});

test('Workspace focus or a repeated request for visible B never adds another mount', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    const b = w.bySession('session-b').id;
    const saved = h.identity();
    w.open('session-b');
    w.split('session-a', 'session-b', 'right');
    w.open('session-b');
    assert.equal(w.activeId, b);
    assert.equal(w.panes.size, 2);
    assert.equal(w.mounts.size, 2);
    assert.match(w.splitUnavailable('session-a', 'session-b', 'right'), /已经显示/);
    h.assertIdentity(saved);
  } finally { h.cleanup(); }
});

test('continuous geometry updates do not broadcast native view revisions; projection and native pane actions still do', () => {
  const h=workspaceHarness();
  try {
    const w=h.workspace;w.split('session-a','session-b','right');
    const a=w.bySession('session-a').id;
    h.resize(1100);const revision=w.revision;const identities=h.identity();
    for(let i=0;i<60;i++)h.resize(1100+i%20);
    assert.equal(w.revision,revision,'pixel changes must not re-render the workbench');
    h.resize(500);assert.equal(w.narrow,true);assert.ok(w.revision>revision);
    h.resize(1100);assert.equal(w.narrow,false);h.assertIdentity(identities);
    h.callbacks().moveSession('session-a');assert.equal(w.movingId,a);
    assert.equal(h.callbacks().canClose('session-a'),true,'a split pane may be closed on its own');
    assert.equal(h.callbacks().canClose('session-z'),false,'a Session outside the workbench is never closable');
    h.callbacks().closeSession('session-a');assert.equal(w.movingId,null);assert.equal(w.panes.size,1);
    assert.equal(h.callbacks().canClose('session-b'),false,'the surviving single pane is the normal view');
  } finally {h.cleanup();}
});

test('catalog-delayed restoration recalculates projection limits before a narrow resize',()=>{
  const original=workspaceHarness();original.workspace.split('session-a','session-b','right');original.workspace.save();
  const saved=new Map(original.values);original.cleanup();
  const cold=workspaceHarness(saved,{loading:true});
  try {cold.catalogReady();cold.resize(650,750,1400);assert.equal(cold.workspace.narrow,true);cold.resize(1100);assert.equal(cold.workspace.narrow,false);}
  finally {cold.cleanup();}
});

test('Workspace narrow projection, focus changes and saves preserve desktop sizes and DOM parents', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    const a = w.bySession('session-a').id;
    const b = w.bySession('session-b').id;
    w.api.getPanel(a).api.setSize({ width: 650 });
    const before = w.geometry();
    const saved = h.identity();
    h.resize(500);
    assert.equal(w.narrow, true);
    for (let index = 0; index < 3; index++) {
      w.focus(index % 2 ? a : b);
      w.save();
      w.layout();
      assert.deepEqual(w.geometry().grid, before.grid);
    }
    const written = JSON.parse([...h.values.values()][0]);
    assert.deepEqual(written.dockview.grid, before.grid);
    h.resize(1100);
    assert.equal(w.narrow, false);
    assert.deepEqual(w.geometry().grid, before.grid);
    h.assertIdentity(saved);
  } finally { h.cleanup(); }
});

test('Workspace explicit maximize can pass through narrow and restore desktop proportions', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    const a = w.bySession('session-a').id;
    w.api.getPanel(a).api.setSize({ width: 640 });
    const before = w.geometry();
    const saved = h.identity();
    w.maximize(a);
    h.resize(500);
    w.save();
    h.resize(1100);
    assert.equal(w.maximized, true);
    w.maximize(a);
    assert.equal(w.maximized, false);
    assert.deepEqual(w.geometry().grid, before.grid);
    h.assertIdentity(saved);
  } finally { h.cleanup(); }
});

test('closing a narrow pane updates the saved engine reference set without resurrecting it', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    const a = w.bySession('session-a').id;
    const b = w.bySession('session-b').id;
    h.resize(500);
    w.close(a);
    w.save();
    const saved = JSON.parse([...h.values.values()][0]);
    assert.deepEqual(saved.panels.map((pane) => pane.id), [b]);
    assert.deepEqual(Object.keys(saved.dockview.panels), [b]);
    assert.equal(w.narrow, false);
  } finally { h.cleanup(); }
});

test('native Sidebar fullscreen updates presentation without entering geometry persistence', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    h.callbacks().sidebarPresentation('session-a', { expanded: true, fullscreen: true });
    assert.equal(w.bySession('session-a').fullscreen, true);
    w.save();
    assert.equal([...h.values.values()][0].includes('fullscreen'), false);
    h.callbacks().sidebarPresentation('session-a', { expanded: false, fullscreen: false });
    assert.equal(w.bySession('session-a').sidebar.open, false);
    assert.equal(w.bySession('session-a').fullscreen, false);
  } finally { h.cleanup(); }
});

test('title drag cancellation keeps the actual Workspace engine geometry unchanged', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    const a = w.bySession('session-a').id;
    const saved = h.identity();
    const before = w.geometry();
    const updates = [];
    const gestures = new Gestures(w, (value) => updates.push(value));
    const target = w.mounts.get(a);
    gestures.begin('session', a, {
      button: 0, isPrimary: true, pointerId: 42, clientX: 100, clientY: 40,
      currentTarget: target, preventDefault() {},
    });
    pointer(win, 'pointermove', 900, 700, 42);
    keyboard(win, 'Escape');
    assert.equal(gestures.current, undefined);
    assert.equal(updates.at(-1), null);
    assert.deepEqual(w.geometry().grid, before.grid);
    h.assertIdentity(saved);
    gestures.dispose();
  } finally { h.cleanup(); }
});

for (const side of ['left', 'right', 'top', 'bottom']) {
  test(`readonly ${side} preview matches real two-pane move geometry`, () => {
    const h = workspaceHarness();
    try {
      const w = h.workspace;
      w.split('session-a', 'session-b', 'right');
      const a = w.bySession('session-a').id, b = w.bySession('session-b').id;
      w.api.getPanel(a).api.setSize({ width: 620 });
      const snapshot = JSON.stringify(w.geometry());
      const identities = h.identity();
      const preview = movePreviewRect(w.geometry(), a, b, side, h.container.getBoundingClientRect());
      assert.ok(preview, side);
      assert.equal(JSON.stringify(w.geometry()), snapshot, 'preview is read only');
      assert.equal(w.move(a, b, side), true);
      const actual = w.api.getPanel(a).group.element.getBoundingClientRect();
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(preview[key] - actual[key]) <= 1, `${key}: ${preview[key]} != ${actual[key]}`);
      h.assertIdentity(identities);
    } finally { h.cleanup(); }
  });
}

test('nested branch contraction keeps a valid native move while withholding an uncertain rectangle', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    w.split('session-a', 'session-c', 'bottom');
    const a = w.bySession('session-a').id, b = w.bySession('session-b').id;
    const preview = movePreviewRect(w.geometry(), a, b, 'bottom', h.container.getBoundingClientRect());
    assert.equal(preview, null);
    assert.equal(w.move(a, b, 'bottom'), true);
    assert.equal(w.api.groups.length, 3);
    assert.equal(w.api.groups.every((group) => group.panels.length === 1), true);
  } finally { h.cleanup(); }
});

test('readonly preview supports moving a vertical two-pane layout across axes', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'bottom');
    const a = w.bySession('session-a').id, b = w.bySession('session-b').id;
    const preview = movePreviewRect(w.geometry(), a, b, 'left', h.container.getBoundingClientRect());
    assert.ok(preview);
    assert.equal(w.move(a, b, 'left'), true);
    const actual = w.api.getPanel(a).group.element.getBoundingClientRect();
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(preview[key] - actual[key]) <= 1, `${key}: ${preview[key]} != ${actual[key]}`);
  } finally { h.cleanup(); }
});

test('multi-pane native moves remain valid without an unproven preview rectangle', () => {
  const h = workspaceHarness();
  try {
    const w = h.workspace;
    w.split('session-a', 'session-b', 'right');
    w.split('session-b', 'session-c', 'right');
    const a = w.bySession('session-a').id, b = w.bySession('session-b').id;
    const preview = movePreviewRect(w.geometry(), a, b, 'bottom', h.container.getBoundingClientRect());
    assert.equal(preview, null);
    assert.equal(w.move(a, b, 'bottom'), true);
    assert.equal(w.api.groups.every((group) => group.panels.length === 1), true);
  } finally { h.cleanup(); }
});

for (const direction of ['right', 'bottom']) {
  test(`Workspace gap12 ${direction} sash Home/End preserve visible panel minimums`, async () => {
    const h = workspaceHarness();
    let uninstall;
    try {
      const w = h.workspace;
      w.split('session-a', 'session-b', direction);
      uninstall = installOuterResize(h.container, w.api);
      const identities = h.identity();
      const sash = h.container.querySelector('.v5-outer-separator');
      assert.ok(sash);
      for (const key of ['Home', 'End']) {
        keyboard(sash, key);
        await settle();
        for (const pane of w.api.panels) {
          const visible = pane.group.element.getBoundingClientRect();
          assert.ok(visible.width >= 330, `${key}: ${visible.width}px visible width`);
          assert.ok(visible.height >= 270, `${key}: ${visible.height}px visible height`);
        }
      }
      h.assertIdentity(identities);
    } finally { uninstall?.(); h.cleanup(); }
  });
}
