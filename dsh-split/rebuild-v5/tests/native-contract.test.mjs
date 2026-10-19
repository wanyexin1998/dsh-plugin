import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openAsar, sha256 } from '../tools/read-asar.mjs';
import { ASAR_SHA256, BASELINES, transformNative } from '../tools/native-patches.mjs';

const archive = openAsar(process.env.DSH_PRISTINE_ASAR ?? 'E:/deepseek-harness/resources/app.asar');
const patched = new Map();
function source(name) {
  if (!patched.has(name)) patched.set(name, transformNative(name, archive.read(`dsh/node_modules/@deepseek-ai/dsh-client-ui-${name}/lib/client.js`)));
  return patched.get(name).source;
}
function section(text, first, last) {
  const start = text.indexOf(first), end = text.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing test source boundary ${first}`);
  return text.slice(start, end);
}
function snapshot(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, set(next) { value = next; for (const fn of [...listeners]) fn(); }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}

test('raw ASAR identity, twelve pinned inputs, exact anchors, complete-bundle syntax and deterministic patching', () => {
  assert.equal(sha256(fs.readFileSync(archive.filename)), ASAR_SHA256);
  for (const name of Object.keys(BASELINES)) {
    const raw = archive.read(`dsh/node_modules/@deepseek-ai/dsh-client-ui-${name}/lib/client.js`);
    const first = transformNative(name, raw), second = transformNative(name, raw);
    assert.equal(first.patchedSha256, second.patchedSha256);
    assert.ok(first.anchors.length > 0);
    assert.throws(() => transformNative(name, Buffer.concat([raw, Buffer.from(' ')])), /SHA-256/);
    assert.throws(() => transformNative(name, first.source), /SHA-256/);
    new vm.Script(first.source);
  }
});

test('native successful navigation emits every open, including the current Session, but not aborted work', () => {
  const code = section(source('workspace'), 'var UiWorkspaceService = class extends', '\n\t\t/**\n\t\t* `error`');
  const Workspace = vm.runInNewContext(`${code}\n; UiWorkspaceService`, {
    _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } },
    _deepseek_ai_dsh_client_store: { createSnapshotStore: snapshot }, AbortController, AbortSignal,
  });
  let panel = 'settings';
  const released = [], navigations = [];
  const sessions = { retain: id => ({ sessionId: id, release: () => released.push(id) }), subagentAddress: () => undefined };
  const ctx = { effect() {}, layout: { selectPanel: id => panel = id } };
  const workspace = new Workspace(ctx, {}, {}, sessions, {}, () => {});
  const unsubscribe = workspace.navigationRequests.subscribe(() => navigations.push(workspace.navigationRequests.getSnapshot()));
  workspace.openSession('A');
  workspace.openSession('A');
  assert.equal(panel, null);
  assert.deepEqual(navigations.map(value => [value.sessionId, value.revision, value.reveal]), [['A', 1, true], ['A', 2, true]]);
  assert.deepEqual(released, ['A']);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => workspace.replaceMain('B', aborted.signal, 'reveal'), /abort/i);
  const cancelled = new AbortController();
  workspace.replaceMain('B', cancelled.signal, 'reveal', () => cancelled.abort());
  assert.equal(navigations.length, 2);
  assert.deepEqual(released, ['A', 'B']);
  panel = 'settings';
  workspace.replaceMain('C', new AbortController().signal, 'preserve');
  assert.equal(panel, 'settings');
  assert.equal(navigations[2].reveal, false);
  unsubscribe();
  workspace.openSession('C');
  assert.equal(navigations.length, 3);
});

test('ASAR reader rejects truncated headers and missing files without executing contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-split-asar-test-'));
  const file = path.join(directory, 'invalid.asar');
  try {
    fs.writeFileSync(file, Buffer.alloc(16));
    assert.throws(() => openAsar(file), /Invalid ASAR/);
    assert.throws(() => archive.read('not-present'), /Missing ASAR/);
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});

test('native main host lease preserves global-panel navigation and returns native main on release', () => {
  const code = section(source('layout'), 'var LayoutController = class {', '\n\t\t//#endregion');
  const Layout = vm.runInNewContext(`${code}; LayoutController`, { AbortController });
  const state = { activePanelId: null, conversationHostId: null };
  const actions = { setConversationHost: key => state.conversationHostId = key, selectPanel: key => state.activePanelId = key };
  const controller = new Layout(actions, key => ['split', 'settings'].includes(key), { getSnapshot: () => state });
  const release = controller.claimConversationHost('split');
  assert.equal(state.conversationHostId, 'split');
  assert.equal(state.activePanelId, null);
  controller.selectPanel('settings');
  assert.equal(state.activePanelId, 'settings');
  controller.selectPanel(null);
  assert.equal(state.activePanelId, null);
  assert.equal(state.conversationHostId, 'split');
  assert.throws(() => controller.claimConversationHost('split'), /already claimed/);
  release(); release();
  assert.equal(state.conversationHostId, null);
  assert.throws(() => controller.claimConversationHost('unknown'), /not registered/);
});

test('native Sidebar view retains A and B independently; hide/release is not an explicit Tab close', () => {
  const code = section(source('sidebar-right'), 'var SidebarSessionView = class {', '\n\t\t//#region ../../util/crypto');
  const Views = vm.runInNewContext(`${code}\n; SidebarSessionViews`, { _deepseek_ai_dsh_client_store: { createSnapshotStore: snapshot }, console });
  const released = [];
  const sessions = { retain: id => ({ sessionId: id, ready: Promise.resolve(), release: () => released.push(id) }) };
  const views = new Views(sessions);
  const a = views.acquire('A'), b = views.acquire('B');
  views.select('A');
  assert.equal(views.source.getSnapshot().length, 2);
  assert.ok(views.source.getSnapshot().every(view => view.embedded));
  const occurrence = new AbortController();
  a.retainTab('terminal-A', occurrence.signal);
  a.release();
  views.select('B');
  assert.deepEqual(released, []);
  assert.equal(views.source.getSnapshot().find(view => view.sessionId === 'A').embedded, false);
  assert.equal(occurrence.signal.aborted, false);
  occurrence.abort();
  assert.deepEqual(released, ['A']);
  b.release();
  views.select(undefined);
  assert.deepEqual(released, ['A', 'B']);
  views.dispose(); views.dispose();
  assert.deepEqual(released, ['A', 'B']);
});

test('explicit Sidebar operations capture session and stale adoption cannot fall back to active B', () => {
  const code = section(source('sidebar-right'), 'var SidebarRightController = class {', '\n\t\t//#endregion');
  const Controller = vm.runInNewContext(`${code}; SidebarRightController`, {
    TabDomain: class {}, document: { activeElement: null },
  });
  const events = [];
  const store = id => ({ store: { actions: { marker: id }, getSnapshot: () => ({ bySession: {} }) } });
  const adopted = new Map([['A', store('A')], ['B', store('B')]]);
  const controller = new Controller({}, () => {}, {}, { adopted, rooms: new Map(), onScreen: snapshot('B'), openTabs: snapshot([]) });
  controller.placeResource = (id, actions, address) => events.push({ id, actionOwner: actions.marker, address });
  controller.openResourceIn('A', 'dsh-resource://test/A');
  assert.equal(events[0].id, 'A');
  assert.equal(events[0].actionOwner, 'A');
  const captured = controller.forSession('A');
  adopted.delete('A');
  assert.throws(() => captured.require(), /no session surface/);
  controller.openResourceIn('A', 'dsh-resource://test/late');
  assert.equal(events.length, 1);
  assert.equal(controller.mounted.getSnapshot(), 'B');
});

test('document drop is accepted by exactly the editable target Session, and native directory data is preserved', () => {
  const code = section(source('attachment'), 'function droppedDirectories(', '\n\t\t//#endregion\n\t\t//#region \\0dsh-css:');
  const listeners = new Map();
  const windowListeners = new Map();
  const document = { body: {}, documentElement: {}, addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list); }, removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== fn)); } };
  const window = { innerWidth: 1000, innerHeight: 1000, addEventListener(type, fn) { windowListeners.set(type, fn); }, removeEventListener(type) { windowListeners.delete(type); } };
  const install = vm.runInNewContext(`${code}; installDocumentDropEvents`, { document, window, Symbol });
  const received = [];
  const releaseA = install(true, (files, directories) => received.push({ owner: 'A', files, directories }), { current: 0 }, () => {}, 'A');
  const releaseB = install(true, (files, directories) => received.push({ owner: 'B', files, directories }), { current: 0 }, () => {}, 'B');
  const releaseDuplicateB = install(true, () => received.push({ owner: 'duplicate B' }), { current: 0 }, () => {}, 'B');
  const file = { name: 'directory' };
  let hidden = false, editable = true;
  const owner = { dataset: { conversationSession: 'B' }, closest: () => hidden ? {} : null, querySelector: () => editable ? {} : null };
  const event = () => ({ target: { closest: () => owner }, dataTransfer: { types: ['Files'], files: [file], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] }, preventDefault() {} });
  const sharedDrop = event();
  for (const fn of listeners.get('drop')) fn(sharedDrop);
  assert.equal(received.length, 1);
  assert.equal(received[0].owner, 'B');
  assert.equal(received[0].directories.has(file), true);
  hidden = true;
  for (const fn of listeners.get('drop')) fn(event());
  hidden = false; editable = false;
  for (const fn of listeners.get('drop')) fn(event());
  assert.equal(received.length, 1);
  releaseA(); releaseB(); releaseDuplicateB();
  assert.ok([...listeners.values()].every(list => list.length === 0));
});

test('native content factories keep Header/View content and embedded Sidebar keeps native DockLayout', () => {
  assert.match(source('conversation'), /name: "conversation.surface", scope: "session-maybe"/);
  assert.match(source('conversation'), /renderSlot\("conversation.header", \{ embedded: props.embedded \}\)/);
  assert.match(source('conversation'), /renderFactorySlot\("conversation.content"/);
  assert.match(source('conversation'), /splitEditorOwners\.get\(editor\)/);
  assert.match(source('sidebar-right'), /name: "sidebar.right.surface", scope: "session"/);
  assert.ok(source('sidebar-right').includes('chrome: (0, react_jsx_runtime.jsx)(PanelChrome,'), 'embedded Sidebar retains actual native chrome');
  assert.match(source('sidebar-right'), /_deepseek_ai_dsh_client_ui_dockkit.DockLayout/);
  assert.match(source('sidebar-right'), /sidebar.embeddedHostActive\(\) \|\| shortcuts.runtime/);
});

test('the native global Sidebar stays hidden for retained tabs while the conversation host owns its seat', () => {
  const code = section(source('sidebar-right'), 'function RightbarRoot(', '\n\t\t//#endregion');
  const render = vm.runInNewContext(`${code}\n; RightbarRoot`, { react_jsx_runtime: { Fragment: 'fragment', jsx: (type, props) => ({ type, props }) }, SessionView: 'native-session-view' });
  const props = { useViews: select => select([{ sessionId: 'A', selected: true, embedded: false }]), usePanelInfo: select => select({ activePanelId: null, conversationHostId: 'dsh-split.workbench' }) };
  assert.equal(render(props).props.children[0].props.visible, false);
  assert.equal(render({ ...props, usePanelInfo: select => select({ activePanelId: null, conversationHostId: null }) }).props.children[0].props.visible, true);
});
