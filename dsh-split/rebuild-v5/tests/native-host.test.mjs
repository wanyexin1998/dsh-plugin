import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { openAsar, readSlotsModuleSource } from '../tools/read-asar.mjs';
import { transformNative } from '../tools/native-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = openAsar(process.env.DSH_PRISTINE_ASAR ?? 'E:/deepseek-harness/resources/app.asar');
const original = name => archive.text(`dsh/node_modules/@deepseek-ai/dsh-client-ui-${name}/lib/client.js`);
function section(source, start, end) {
  const at = source.indexOf(start), finish = source.indexOf(end, at + start.length);
  assert.ok(at >= 0 && finish > at, `native source boundary: ${start}`);
  return source.slice(at, finish);
}
function snapshot(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, set: next => { value = next; for (const fn of [...listeners]) fn(); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, listeners };
}
const bundle = await build({ absWorkingDir: root, entryPoints: ['src/host.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] });
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, queueMicrotask, crypto: globalThis.crypto,
  location: { protocol: 'https:', origin: 'https://test.invalid', pathname: '/dsh' },
  require: name => { if (name === 'react') return React; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton: () => null }; throw new Error(`unexpected module ${name}`); },
});
const host = module.exports;
test('layout namespace survives desktop and loopback reconnects, while remote hosts remain isolated', () => {
  const context = (isLoopback, home) => ({connection:{isLoopback,generation:{getSnapshot:()=>home ? {host:{home}} : undefined}}});
  const desktop = {protocol:'dsh-app:',host:'app',origin:'null',pathname:'/'};
  const local = {protocol:'http:',host:'127.0.0.1:19387',origin:'http://127.0.0.1:19387',pathname:'/'};
  assert.equal(host.storageScopeFor(context(true),desktop),host.storageScopeFor(context(true,'/user'),desktop));
  assert.equal(host.storageScopeFor(context(true),local),host.storageScopeFor(context(true,'/user'),local));
  const remote = {protocol:'https:',host:'host.example',origin:'https://host.example',pathname:'/'};
  assert.notEqual(host.storageScopeFor(context(false,'/alice'),remote),host.storageScopeFor(context(false,'/bob'),remote));
});
// Run the shipped pure SlotCore and Cordis registry classes, not a guessed registry.
const slotsModule = vm.runInNewContext(readSlotsModuleSource(archive), { queueMicrotask });
const renderer = original('renderer');
const Registry = vm.runInNewContext(`${section(renderer, 'const ROOT_INSTANCE_KEY =', '\n\t\t//#endregion')}\n; SlotRegistry`, {
  _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } }, _deepseek_ai_dsh_client_ui_slots: slotsModule, queueMicrotask,
});
const sessionController = archive.text('dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js');
const Reference = vm.runInNewContext(`${section(sessionController, 'var ClientSessionReference = class {', '\n\t\t/** Host catalog')}\n; ClientSessionReference`, { AbortController, AbortSignal });
const bindingMethod = vm.runInNewContext(`({${section(original('session'), 'bindingSource(reference) {', '\n\t\t\t/**')}}).bindingSource`);
const Workspace = vm.runInNewContext(`${section(transformNative('workspace', original('workspace')).source, 'var UiWorkspaceService = class extends', '\n\t\t/**\n\t\t* \x60error\x60')}\n; UiWorkspaceService`, {
  _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } },
  _deepseek_ai_dsh_client_store: { createSnapshotStore: snapshot }, AbortController, AbortSignal,
});
const Layout = vm.runInNewContext(`${section(transformNative('layout', original('layout')).source, 'var LayoutController = class {', '\n\t\t//#endregion')}\n; LayoutController`, { AbortController });

function harness({ omitFactory = false } = {}) {
  const lifecycle = [], sideEvents = [], records = new Map(), retained = [];
  const ctx = { fiber: { name: 'native-contract-test' }, emit() {}, effect(factory) {
    const result = factory();
    const releases = typeof result === 'function' ? [result] : result && Symbol.iterator in Object(result) ? [...result] : [];
    let live = true;
    const release = () => { if (!live) return; live = false; for (const dispose of releases.reverse()) dispose(); };
    lifecycle.push(release); return release;
  } };
  ctx.slots = new Registry(ctx);
  ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'session' } } }, () => null);
  ctx.slots.registerFactory({ name: 'conversation.surface', scope: 'session-maybe' }, () => null);
  if (!omitFactory) ctx.slots.registerFactory({ name: 'sidebar.right.surface', scope: 'session' }, () => null);
  const panelInfo = snapshot({ activePanelId: null, conversationHostId: null });
  const setPanel = change => panelInfo.set({ ...panelInfo.getSnapshot(), ...change });
  ctx.layout = new Layout({ setConversationHost: key => setPanel({ conversationHostId: key }), selectPanel: key => setPanel({ activePanelId: key }) }, key => key === 'settings' || ctx.slots.entriesOfSlot('main').some(entry => entry.options.key === key), panelInfo);
  ctx.sessions = { list: snapshot({ phase: 'loading', ids: ['A', 'B'], byId: { A: { id: 'A', title: 'Alpha' }, B: { id: 'B', title: 'Beta' } } }),
    binding: id => records.get(id)?.binding, subagentAddress: () => undefined,
    retain(id) {
      let record = records.get(id);
      if (!record) { record = { binding: { id }, live: true, count: 0 }; records.set(id, record); }
      record.count += 1;
      const reference = new Reference(id, record, () => { record.count -= 1; });
      reference.readiness.resolve(record.binding); retained.push(reference); return reference;
    },
  };
  const current = snapshot({ key: undefined });
  const sourceByBinding = new WeakMap();
  const projection = { active: true, sessions: ctx.sessions, absent: snapshot({ key: undefined }), sourceFor(binding) {
    if (!sourceByBinding.has(binding)) sourceByBinding.set(binding, snapshot({ key: binding.id, props: { sessionId: binding.id }, hooks: {}, keyedHooks: {} }));
    return sourceByBinding.get(binding);
  } };
  ctx.uiSession = { adapter: { current, bindingSource: reference => bindingMethod.call(projection, reference), renderArea: (binding, props) => props.children } };
  ctx.connection = { isLoopback: false, generation: snapshot({ host: { home: '/native-test' } }) };
  ctx.sidebarRightHost = { contract: host.NATIVE_CONTRACT,
    claim() { sideEvents.push('claim'); return () => sideEvents.push('unclaim'); },
    acquire(id) { sideEvents.push(`acquire:${id}`); return { release: () => sideEvents.push(`release:${id}`) }; },
    setActive: id => sideEvents.push(`active:${id}`), setHostVisible: value => sideEvents.push(`visible:${value}`), setExpanded() {}, toggleExpanded() {},
  };
  ctx.uiWorkspace = new Workspace(ctx, {}, { list: snapshot({ phase: 'loading', items: [], archivedSessionIds: [] }) }, ctx.sessions, {}, () => {});
  ctx.uiWorkspace.selection.subscribe(() => current.set({ key: ctx.uiWorkspace.selection.getSnapshot().sessionId }));
  return { ctx, sideEvents, retained, panelInfo, dispose() { for (const release of lifecycle.reverse()) release(); } };
}

test('host.ts registers against the native SlotCore/Registry and native SessionProvider preserves its exact reference binding', async () => {
  const h = harness();
  const Workbench = () => null, Pane = () => null;
  const bridge = host.installNativeHost(h.ctx, Workbench, Pane);
  assert.equal(typeof h.ctx.slots.factory, 'undefined');
  assert.equal(h.ctx.slots.snapshot('factory:sidebar.right.surface')[0].scope, 'session');
  assert.equal(h.ctx.slots.spec(host.SESSION_SLOT).scope, 'session');
  const entry = h.ctx.slots.entriesOfSlot('main').find(entry => entry.options.key === host.MAIN_KEY);
  assert.equal(entry.component, Workbench);
  assert.equal(entry.inject().bridge, bridge);
  assert.equal(h.panelInfo.getSnapshot().conversationHostId, host.MAIN_KEY);
  const reference = bridge.retain('A');
  assert.equal(reference, h.retained.at(-1));
  assert.equal(reference.binding, h.ctx.sessions.binding('A'));
  const getKit = vm.runInNewContext(`${section(renderer, 'function scopeAreaProvider(adapter)', '\n\t\t/**\n\t\t* One rendered entry')}\n; standardKit`, {
    scopeAreaCache: new WeakMap(), SlotAssemblyError: Error, react: React, react_jsx_runtime: jsx,
    useScopeBinding: () => ({ key: 'wrong-inherited-B' }), ScopeBindingProvider: ({ binding, children }) => React.createElement('section', { 'data-bound-session': binding.key }, children),
    standardProps: () => ({}), boundRenderFactorySlot: () => () => null, boundRenderSlot: () => () => null,
  });
  const { kit } = getKit({ storeOf: () => undefined, scope: () => h.ctx.uiSession.adapter }, entry, 'root', {}, undefined);
  assert.equal(typeof kit.SessionProvider, 'function');
  assert.equal(renderToStaticMarkup(React.createElement(kit.SessionProvider, { session: reference }, 'native child')), '<section data-bound-session="A">native child</section>');
  const fake = { sessionId: 'A', binding: {} };
  assert.throws(() => h.ctx.uiSession.adapter.bindingSource(fake), /not active/);
  bridge.dispose(); await Promise.resolve();
  assert.throws(() => reference.binding, /released/);
  assert.equal(h.panelInfo.getSnapshot().conversationHostId, null);
  assert.equal(h.ctx.slots.entriesOfSlot('main').length, 0);
  assert.equal(h.sideEvents.filter(event => event === 'release:A').length, 1);
  assert.equal(h.sideEvents.filter(event => event === 'unclaim').length, 1);
  h.dispose();
});

test('host.ts sees A then A, lets global panels stay selected, and removes navigation subscriptions on dispose', () => {
  const h = harness();
  const bridge = host.installNativeHost(h.ctx, () => null, () => null);
  const opened = [];
  bridge.setCallbacks({ openSession: id => opened.push(id), isShown: () => true });
  h.ctx.uiWorkspace.openSession('A'); h.ctx.uiWorkspace.openSession('A');
  assert.deepEqual(opened, ['A', 'A']);
  h.ctx.layout.selectPanel('settings');
  bridge.focusSession('B');
  assert.equal(h.panelInfo.getSnapshot().activePanelId, 'settings');
  assert.deepEqual(opened, ['A', 'A']);
  h.ctx.uiWorkspace.replaceMain('B', new AbortController().signal, 'preserve');
  assert.equal(h.panelInfo.getSnapshot().activePanelId, 'settings');
  assert.deepEqual(opened, ['A', 'A']);
  h.ctx.uiWorkspace.openSession('B');
  assert.equal(h.panelInfo.getSnapshot().activePanelId, null);
  assert.deepEqual(opened, ['A', 'A', 'B']);
  bridge.dispose();
  assert.equal(h.ctx.uiWorkspace.navigationRequests.listeners.size, 0);
  h.ctx.uiWorkspace.openSession('A');
  assert.deepEqual(opened, ['A', 'A', 'B']);
  h.dispose();
});

test('missing native factory fails before claiming either native seat', () => {
  const h = harness({ omitFactory: true });
  assert.throws(() => host.installNativeHost(h.ctx, () => null, () => null), /factory missing/);
  assert.deepEqual(h.sideEvents, []);
  assert.equal(h.panelInfo.getSnapshot().conversationHostId, null);
  h.dispose();
});
