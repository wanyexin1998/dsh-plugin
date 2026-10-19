import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Real DOM event propagation with deterministic frame scheduling. The workspace
// is a narrow state stub; these tests make no native engine or paint-rate claim.
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://v5-gestures.invalid/' });
const win = dom.window;
class FixturePointerEvent extends win.MouseEvent {
  constructor(type, options = {}) {
    super(type, options);
    for (const [name, value] of Object.entries({ pointerId: options.pointerId ?? 7, pointerType: 'mouse', isPrimary: options.isPrimary ?? true })) {
      Object.defineProperty(this, name, { value });
    }
  }
}
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? win : win[key] });
}
globalThis.PointerEvent = FixturePointerEvent;
win.PointerEvent = FixturePointerEvent;
let frameSequence = 0;
const frames = new Map();
globalThis.requestAnimationFrame = win.requestAnimationFrame = callback => { const id = ++frameSequence; frames.set(id, callback); return id; };
globalThis.cancelAnimationFrame = win.cancelAnimationFrame = id => { frames.delete(id); };
const errors = [];
win.addEventListener('error', event => { errors.push(event.error ?? event.message); });

const filename = fileURLToPath(new URL('../src/gestures.ts', import.meta.url));
const compiled = await build({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(filename, undefined);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(fileURLToPath(new URL('../src', import.meta.url)));
loaded._compile(compiled.outputFiles[0].text, filename);
const { Gestures } = loaded.exports;

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(frameSequence * 16);
}
function pointer(target, type, x = 500, y = 100, pointerId = 7) {
  target.dispatchEvent(new FixturePointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, pointerId }));
}
function harness() {
  const body = document.createElement('div');
  const handle = document.createElement('div');
  body.append(handle);
  document.body.append(body);
  body.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, width: 800, height: 500, right: 810, bottom: 510 });
  const captures = new Set();
  handle.setPointerCapture = id => captures.add(id);
  handle.hasPointerCapture = id => captures.has(id);
  handle.releasePointerCapture = id => { captures.delete(id); pointer(handle, 'lostpointercapture', 500, 100, id); };
  const original = { open: true, side: 'right', ratios: { x: .36, y: .4 } };
  const sidebarWrites = [];
  const feedback = [];
  let changes = 0;
  let saves = 0;
  const workspace = {
    panes: new Map([['A', { id: 'A', sessionId: 'A', epoch: 1, sidebar: structuredClone(original) }]]),
    mounts: new Map([['A', body]]),
    narrow: false, maximized: false, resizing: false,
    title: pane => pane.sessionId,
    focus() {},
    visible: () => true,
    moveUnavailable: () => undefined,
    move() { throw new Error('Unexpected outer move during inner resize'); },
    inform() {},
    bridge: { setSidebarExpanded() {}, setSidebarFullscreen() {} },
    sidebar(id, value) {
      sidebarWrites.push({ id, value });
      const pane = this.panes.get(id);
      if (pane) this.panes.set(id, { ...pane, sidebar: value });
    },
    changed() { changes += 1; },
    save() { if (!this.resizing) saves += 1; },
  };
  const gestures = new Gestures(workspace, value => feedback.push(value));
  handle.addEventListener('pointerdown', event => gestures.begin('resize', 'A', event, body));
  return {
    body, handle, workspace, gestures, original, sidebarWrites, feedback,
    get changes() { return changes; }, get saves() { return saves; },
    start() { pointer(handle, 'pointerdown'); },
    dispose() { gestures.dispose(); body.remove(); assert.equal(frames.size, 0, 'No pending frame survives disposal'); },
  };
}

for (const [label, cancel] of [
  ['Escape', view => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
  ['window blur', view => win.dispatchEvent(new win.Event('blur'))],
  ['pointercancel', view => pointer(document, 'pointercancel', 450)],
  ['lost pointer capture', view => pointer(view.handle, 'lostpointercapture', 450)],
]) {
  test(`${label} restores inner geometry and releases the resizing save guard`, () => {
    const view = harness();
    try {
      view.start();
      assert.equal(view.workspace.resizing, true);
      view.workspace.save();
      assert.equal(view.saves, 0);
      pointer(document, 'pointermove', 450);
      flushFrame();
      assert.notDeepEqual(view.workspace.panes.get('A').sidebar, view.original);
      cancel(view);
      assert.deepEqual(view.workspace.panes.get('A').sidebar, view.original);
      assert.equal(view.workspace.resizing, false);
      assert.equal(view.gestures.current, undefined);
      assert.equal(view.feedback.at(-1), null);
      view.workspace.save();
      assert.equal(view.saves, 1);
      const writeCount = view.sidebarWrites.length;
      pointer(document, 'pointermove', 400);
      flushFrame();
      assert.equal(view.sidebarWrites.length, writeCount, 'Cancelled listeners cannot mutate geometry');
    } finally { view.dispose(); }
  });
}

test('a pane removed before the pending frame cannot leave resizing locked', () => {
  const view = harness();
  try {
    view.start();
    pointer(document, 'pointermove', 450);
    view.workspace.panes.delete('A');
    flushFrame();
    assert.equal(view.workspace.resizing, false);
    assert.equal(view.gestures.current, undefined);
    assert.equal(view.feedback.at(-1), null);
    assert.equal(view.sidebarWrites.length, 1, 'No rollback is written into a removed pane');
    assert.equal(view.changes, 1);
    view.workspace.save();
    assert.equal(view.saves, 1);
  } finally { view.dispose(); }
});

test('an epoch change cancels resize without overwriting the replacement binding', () => {
  const view = harness();
  try {
    view.start();
    pointer(document, 'pointermove', 450);
    const replacementSidebar = { open: false, side: 'bottom', ratios: { x: .5, y: .6 } };
    view.workspace.panes.set('A', { id: 'A', sessionId: 'replacement', epoch: 2, sidebar: replacementSidebar });
    flushFrame();
    assert.equal(view.workspace.resizing, false);
    assert.equal(view.gestures.current, undefined);
    assert.equal(view.workspace.panes.get('A').sidebar, replacementSidebar);
    assert.equal(view.sidebarWrites.length, 1);
    view.workspace.save();
    assert.equal(view.saves, 1);
  } finally { view.dispose(); }
});

test('multiple pointer moves coalesce to the latest point once per frame', () => {
  const view = harness();
  try {
    view.start();
    assert.equal(view.sidebarWrites.length, 1);
    pointer(document, 'pointermove', 490);
    pointer(document, 'pointermove', 480);
    pointer(document, 'pointermove', 470);
    assert.equal(frames.size, 1);
    assert.equal(view.sidebarWrites.length, 1);
    flushFrame();
    assert.equal(view.sidebarWrites.length, 2);
    assert.equal(view.feedback.at(-1).point.x, 470);
    pointer(document, 'pointermove', 460);
    pointer(document, 'pointermove', 450);
    assert.equal(frames.size, 1);
    flushFrame();
    assert.equal(view.sidebarWrites.length, 3);
    assert.equal(view.feedback.at(-1).point.x, 450);
  } finally { view.dispose(); }
});

test('pointerup flushes its latest position and cancels the queued frame', () => {
  const view = harness();
  try {
    view.start();
    pointer(document, 'pointermove', 480);
    assert.equal(frames.size, 1);
    pointer(document, 'pointerup', 440);
    assert.equal(view.sidebarWrites.length, 2);
    assert.equal(view.feedback.at(-2).point.x, 440);
    assert.equal(view.feedback.at(-1), null);
    assert.equal(view.workspace.resizing, false);
    assert.equal(frames.size, 0);
    const committed = structuredClone(view.workspace.panes.get('A').sidebar);
    flushFrame();
    assert.deepEqual(view.workspace.panes.get('A').sidebar, committed);
    assert.notDeepEqual(committed, view.original);
  } finally { view.dispose(); }
});

test('disposing an in-progress gesture clears pending work and restores geometry', () => {
  const view = harness();
  view.start();
  pointer(document, 'pointermove', 450);
  view.gestures.dispose();
  assert.equal(view.workspace.resizing, false);
  assert.equal(view.gestures.current, undefined);
  assert.deepEqual(view.workspace.panes.get('A').sidebar, view.original);
  assert.equal(frames.size, 0);
  view.dispose();
});

afterEach(() => { assert.deepEqual(errors.splice(0), [], 'No unhandled gesture errors'); });
after(() => dom.window.close());
