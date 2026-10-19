import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Event/focus contracts only. The dialog shim does not prove browser top-layer
// behavior, focus trapping, CSS layout, iframe lifetime or visual fidelity.
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://v5-overlays.invalid/' });
const win = dom.window;
const eventErrors = [];
win.addEventListener('error', event => { eventErrors.push(event.error ?? event.message); });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLDialogElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? win : win[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
Object.defineProperty(win.document.documentElement, 'clientWidth', { configurable: true, value: 1200 });
Object.defineProperty(win.document.documentElement, 'clientHeight', { configurable: true, value: 800 });
win.HTMLElement.prototype.getBoundingClientRect = function () {
  const dialog = this.tagName === 'DIALOG';
  const x = dialog ? 300 : 40, y = dialog ? 180 : 30;
  const width = dialog ? 510 : this.classList.contains('v5-menu') ? 180 : 120;
  const height = dialog ? 340 : this.classList.contains('v5-menu') ? 170 : 36;
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } };
};
const focusBeforeDialog = new WeakMap();
win.HTMLDialogElement.prototype.showModal = function () {
  focusBeforeDialog.set(this, document.activeElement);
  this.open = true;
  this.dataset.testModal = 'true';
};
win.HTMLDialogElement.prototype.close = function () {
  if (!this.open) return;
  this.open = false;
  const previous = focusBeforeDialog.get(this);
  if (previous?.isConnected) previous.focus();
  this.dispatchEvent(new win.Event('close'));
};

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const file = fileURLToPath(new URL('../src/overlays.tsx', import.meta.url));
const result = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] });
const compiled = new Module(file, undefined);
compiled.filename = file;
compiled.paths = Module._nodeModulePaths(fileURLToPath(new URL('../src', import.meta.url)));
compiled.require = id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {IconCheckOutlineRegular:()=>null,IconCloseOutlineRegular:()=>null} : require(id);
compiled._compile(result.outputFiles[0].text, file);
const { SidebarMenu, MoveDialog, DragOverlay, Toast } = compiled.exports;

function harness(Component, props) {
  const anchor = document.createElement('button');
  anchor.textContent = 'Origin';
  const outside = document.createElement('input');
  const container = document.createElement('div');
  container.dataset.v5Overlay = '';
  document.body.append(anchor, outside, container);
  anchor.focus();
  const root = createRoot(container);
  let closed = 0;
  let current = { ...props, anchor, onClose() { closed += 1; root.render(null); } };
  act(() => root.render(React.createElement(Component, current)));
  return {
    anchor, outside, container,
    get closed() { return closed; },
    update(next) { current = { ...current, ...next }; act(() => root.render(React.createElement(Component, current))); },
    dispose() { act(() => root.unmount()); anchor.remove(); outside.remove(); container.remove(); },
  };
}
function key(element, value) { act(() => element.dispatchEvent(new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))); }
function pointer(element, type, x = 0, y = 0) {
  const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => element.dispatchEvent(event));
}
function click(element) { act(() => element.click()); }
function submit(form) { act(() => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }))); }

test('Sidebar menu provides keyboard navigation and returns Escape focus without choosing a side', () => {
  const selected = [];
  const view = harness(SidebarMenu, { title: '会话 A', side: 'right', onSelect: side => selected.push(side) });
  try {
    assert.equal(document.activeElement.dataset.side, 'left');
    assert.equal(view.anchor.getAttribute('aria-expanded'), 'true');
    key(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement.dataset.side, 'right');
    key(document.activeElement, 'End');
    assert.equal(document.activeElement.dataset.side, 'bottom');
    key(document.activeElement, 'Home');
    assert.equal(document.activeElement.dataset.side, 'left');
    key(document.activeElement, 'Escape');
    assert.equal(view.closed, 1);
    assert.equal(document.activeElement, view.anchor);
    assert.equal(view.anchor.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(selected, []);
  } finally { view.dispose(); }
});

test('Sidebar selection emits the chosen side once and restores the trigger', () => {
  const selected = [];
  const view = harness(SidebarMenu, { title: '会话 A', side: 'right', onSelect: side => selected.push(side) });
  try {
    click(view.container.querySelector('[data-side="bottom"]'));
    assert.deepEqual(selected, ['bottom']);
    assert.equal(view.closed, 1);
    assert.equal(document.activeElement, view.anchor);
  } finally { view.dispose(); }
});

test('outside pointer closes a menu without moving focus back over the native target', () => {
  const view = harness(SidebarMenu, { title: '会话 A', side: 'right', onSelect() {} });
  try {
    let triggerRefocused = 0;
    view.anchor.addEventListener('focus', () => { triggerRefocused += 1; });
    pointer(view.outside, 'pointerdown');
    view.outside.focus();
    assert.equal(view.closed, 1);
    assert.equal(triggerRefocused, 0);
    assert.equal(document.activeElement, view.outside);
  } finally { view.dispose(); }
});

test('move submit rechecks eligibility after the menu was rendered', () => {
  let reason;
  let moved = 0;
  const view = harness(MoveDialog, { title: '移动会话 A', targets: [{ id: 'B', title: 'B' }], unavailable: () => reason, onMove() { moved += 1; } });
  try {
    const dialog = view.container.querySelector('dialog');
    assert.equal(dialog.open, true);
    assert.equal(document.activeElement.tagName, 'SELECT');
    reason = '参照会话已关闭';
    submit(dialog.querySelector('form'));
    assert.equal(moved, 0);
    assert.equal(view.closed, 0);
    assert.match(view.container.querySelector('[role="status"]').textContent, /参照会话已关闭/);
    key(document.activeElement, 'Escape');
    assert.equal(view.closed, 1);
    assert.equal(document.activeElement, view.anchor);
  } finally { view.dispose(); }
});

test('a successful move sends the selected target and direction then closes', () => {
  const moves = [];
  const view = harness(MoveDialog, { title: '移动会话 A', targets: [{ id: 'B', title: 'B' }, { id: 'C', title: 'C' }], unavailable: () => undefined,
    onMove(id, side) { moves.push([id, side]); return true; } });
  try {
    const select = view.container.querySelector('select');
    act(() => { select.value = 'C'; select.dispatchEvent(new win.Event('change', { bubbles: true })); });
    click(view.container.querySelector('[data-side="bottom"]'));
    submit(view.container.querySelector('form'));
    assert.deepEqual(moves, [['C', 'bottom']]);
    assert.equal(view.closed, 1);
    assert.equal(document.activeElement, view.anchor);
  } finally { view.dispose(); }
});

test('removing all target sessions disables the move without retaining a stale target', () => {
  let moved = 0;
  const view = harness(MoveDialog, { title: '移动会话 A', targets: [{ id: 'B', title: 'B' }], unavailable: () => undefined, onMove() { moved += 1; } });
  try {
    view.update({ targets: [] });
    assert.equal(view.container.querySelector('select').disabled, true);
    assert.equal(view.container.querySelector('button[type="submit"]').disabled, true);
    submit(view.container.querySelector('form'));
    assert.equal(moved, 0);
    assert.equal(view.closed, 0);
  } finally { view.dispose(); }
});

test('moving a pointer from dialog content to backdrop does not dismiss the dialog', () => {
  const view = harness(MoveDialog, { title: '移动会话 A', targets: [{ id: 'B', title: 'B' }], unavailable: () => undefined, onMove() {} });
  try {
    const dialog = view.container.querySelector('dialog');
    pointer(dialog.querySelector('select'), 'pointerdown', 400, 300);
    pointer(dialog, 'pointerup', 10, 10);
    assert.equal(view.closed, 0);
    pointer(dialog, 'pointerdown', 10, 10);
    pointer(dialog, 'pointerup', 10, 10);
    assert.equal(view.closed, 1);
  } finally { view.dispose(); }
});

test('a direction-only drag remains readable without inventing a preview rectangle', () => {
  const view = harness(DragOverlay, { kind: 'session', point: { x: 400, y: 300 }, title: '会话 A', preview: null, label: '移到会话 B 下方' });
  try {
    assert.equal(view.container.querySelector('.v5-drag-preview'), null);
    assert.equal(view.container.querySelector('.v5-drag-ghost small').textContent, '移到会话 B 下方');
    view.update({ preview: { x: 10, y: 20, width: 300, height: 180 } });
    assert.equal(view.container.querySelector('.v5-drag-preview').textContent, '移到会话 B 下方');
    assert.equal(view.container.querySelector('.v5-drag-ghost small').textContent, '整体移动');
    view.update({ preview: undefined, label: undefined });
    assert.equal(view.container.querySelector('.v5-drag-preview'), null);
    assert.equal(view.container.querySelector('.v5-drag-ghost small').textContent, '整体移动');
  } finally { view.dispose(); }
});

test('a replacement toast resets the dismissal timer and unmount cancels it', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let dismissed = 0;
  const view = harness(Toast, { message: '第一条', onDismiss() { dismissed += 1; } });
  try {
    act(() => context.mock.timers.tick(3000));
    view.update({ message: '第二条' });
    act(() => context.mock.timers.tick(1000));
    assert.match(view.container.textContent, /第二条/);
    assert.equal(dismissed, 0);
    act(() => context.mock.timers.tick(2500));
    assert.equal(view.container.textContent, '');
    assert.equal(dismissed, 1);
    view.update({ message: '第三条' });
    view.dispose();
    act(() => context.mock.timers.tick(4000));
    assert.equal(dismissed, 1);
  } finally { if (view.container.isConnected) view.dispose(); context.mock.timers.reset(); }
});

afterEach(() => { assert.deepEqual(eventErrors.splice(0), [], 'No unhandled component or cleanup errors'); });
after(() => { delete globalThis.IS_REACT_ACT_ENVIRONMENT; dom.window.close(); });
