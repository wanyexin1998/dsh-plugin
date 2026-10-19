import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPureTypeScript } from './load-pure-typescript.mjs';
const {
  LAYOUT, SNAPSHOT_LIMITS, defaultSidebarPlacement, sidebarGeometry,
  resizeSidebarRatio, setSidebarRatio, placeSidebar, toggleSidebar,
  edgeAt, containsPoint, hasDragThreshold, canSplit, shouldProjectSingle,
  minimumDockviewSize, minimumAfterMove, minimumAfterSplit, movePreviewRect,
  captureSplitIntent, validateSplitIntent,
  createSnapshot, parseSnapshot, serializeSnapshot, storageKey,
} = await loadPureTypeScript(new URL('../src/geometry.ts', import.meta.url));

const size = { width: 1000, height: 700 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const copy = (value) => structuredClone(value);

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function group(panel, id = `group-${panel}`) {
  return { type: 'leaf', data: { id, views: [panel], activeView: panel }, size: 490 };
}

function fixture() {
  return {
    hostVersion: 'dsh-v0.2.0-rc.2',
    panels: [
      { id: 'panel-a', sessionId: 'session-a', sidebar: defaultSidebarPlacement() },
      { id: 'panel-b', sessionId: 'session-b', sidebar: placeSidebar(defaultSidebarPlacement(), 'bottom') },
    ],
    activeId: 'panel-a',
    dockview: {
      grid: {
        root: { type: 'branch', data: [group('panel-a'), group('panel-b')], size: 700 },
        width: 1000, height: 700, orientation: 'HORIZONTAL',
      },
      panels: {
        'panel-a': { id: 'panel-a', contentComponent: 'session', minimumWidth: 330, minimumHeight: 270 },
        'panel-b': { id: 'panel-b', contentComponent: 'session', minimumWidth: 330, minimumHeight: 270 },
      },
      activeGroup: 'group-panel-a',
    },
  };
}

function snapshot() { return createSnapshot(fixture()); }
function expectInvalid(mutator) {
  const data = snapshot();
  mutator(data);
  const result = parseSnapshot(JSON.stringify(data));
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
}

test('frozen defaults use independent ratios and allocate a fresh object', () => {
  const one = defaultSidebarPlacement();
  const two = defaultSidebarPlacement();
  assert.deepEqual(one, { open: true, side: 'right', ratios: { x: 0.36, y: 0.4 } });
  one.ratios.x = 0.5;
  assert.equal(two.ratios.x, 0.36);
});

test('four sides have exact gap, full coverage and expected leading/trailing coordinates', () => {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const geometry = sidebarGeometry(size, placeSidebar(defaultSidebarPlacement(), side));
    assert.equal(geometry.onlySidebar, false);
    const leading = side === 'left' || side === 'top';
    if (geometry.axis === 'x') {
      near(geometry.sidebar.width, (1000 - 12) * 0.36);
      near(geometry.chat.width + geometry.sidebar.width + geometry.divider.width, 1000);
      assert.equal(geometry.divider.width, 12);
      assert.equal(leading ? geometry.sidebar.x : geometry.chat.x, 0);
      near(leading ? geometry.chat.x : geometry.sidebar.x,
        (leading ? geometry.sidebar.width : geometry.chat.width) + 12);
      assert.equal(geometry.chat.height, 700);
    } else {
      near(geometry.sidebar.height, (700 - 12) * 0.4);
      near(geometry.chat.height + geometry.sidebar.height + geometry.divider.height, 700);
      assert.equal(geometry.divider.height, 12);
      assert.equal(leading ? geometry.sidebar.y : geometry.chat.y, 0);
      near(leading ? geometry.chat.y : geometry.sidebar.y,
        (leading ? geometry.sidebar.height : geometry.chat.height) + 12);
      assert.equal(geometry.chat.width, 1000);
    }
  }
});

test('switching axes, collapsing and reopening retain both original ratios', () => {
  const original = freeze({ open: true, side: 'right', ratios: { x: 0.31, y: 0.57 } });
  const bottom = placeSidebar(original, 'bottom');
  assert.deepEqual(bottom.ratios, original.ratios);
  const collapsed = toggleSidebar(bottom);
  const expanded = toggleSidebar(collapsed);
  assert.equal(expanded.open, true);
  assert.equal(expanded.side, 'bottom');
  assert.deepEqual(expanded.ratios, original.ratios);
  assert.notEqual(expanded.ratios, original.ratios);
});

test('hidden Sidebar uses no space without deleting the saved placement', () => {
  const placement = freeze(toggleSidebar(defaultSidebarPlacement()));
  const geometry = sidebarGeometry(size, placement);
  assert.deepEqual(geometry.chat, { x: 0, y: 0, ...size });
  assert.equal(geometry.sidebar.width, 0);
  assert.equal(geometry.divider.width, 0);
  assert.equal(geometry.onlySidebar, false);
  assert.deepEqual(placement.ratios, { x: 0.36, y: 0.4 });
});

test('inner compact boundaries are strict and reserve the return-to-chat height', () => {
  const right = defaultSidebarPlacement();
  const narrow = sidebarGeometry({ width: 534, height: 400 }, right);
  assert.equal(narrow.onlySidebar, true);
  assert.equal(narrow.sidebar.height, 372);
  assert.equal(narrow.chat.width, 0);
  assert.equal(sidebarGeometry({ width: 535, height: 400 }, right).onlySidebar, false);
  const bottom = placeSidebar(right, 'bottom');
  assert.equal(sidebarGeometry({ width: 900, height: 321 }, bottom).onlySidebar, true);
  const atMinimum = sidebarGeometry({ width: 900, height: 322 }, bottom);
  assert.equal(atMinimum.onlySidebar, false);
  assert.equal(atMinimum.sidebar.height, 140);
  assert.equal(atMinimum.chat.height, 170);
  assert.ok(sidebarGeometry({ width: 0, height: 0 }, bottom).sidebar.height >= 0);
});

test('rendering a narrow projection never mutates desktop geometry or its serialization', () => {
  const saved = freeze(snapshot());
  const before = serializeSnapshot(saved);
  const required = minimumDockviewSize(saved.dockview);
  assert.equal(shouldProjectSingle({ width: 600, height: 700 }, required, 1200), true);
  for (const panel of saved.panels) sidebarGeometry({ width: 320, height: 250 }, panel.sidebar);
  assert.equal(serializeSnapshot(saved), before);
  assert.equal(shouldProjectSingle({ width: 1000, height: 700 }, required, 1200), false);
  assert.equal(serializeSnapshot(saved), before);
});

test('resize follows all four sides and changes only the current axis', () => {
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const placement = freeze(placeSidebar(defaultSidebarPlacement(), side));
    const axis = ['left', 'right'].includes(side) ? 'x' : 'y';
    const other = axis === 'x' ? 'y' : 'x';
    const sign = ['left', 'top'].includes(side) ? 1 : -1;
    const updated = resizeSidebarRatio(placement, size, 25);
    assert.equal(updated.ratios[other], placement.ratios[other]);
    near(updated.ratios[axis], placement.ratios[axis] + sign * 25 / ((axis === 'x' ? 1000 : 700) - 12));
    assert.equal(updated.open, true);
  }
});

test('resize starts at the visible clamped ratio so one pixel immediately follows the pointer', () => {
  const placement = placeSidebar(defaultSidebarPlacement(), 'left');
  const constrained = { width: 535, height: 400 };
  assert.equal(sidebarGeometry(constrained, placement).sidebar.width, 220);
  const updated = resizeSidebarRatio(placement, constrained, 1);
  near(sidebarGeometry(constrained, updated).sidebar.width, 221);
});

test('ratio limits obey content minimums and never automatically close Sidebar', () => {
  const placement = defaultSidebarPlacement();
  const tiny = setSidebarRatio(placement, size, -100);
  assert.equal(sidebarGeometry(size, tiny).sidebar.width, 220);
  const huge = setSidebarRatio(placement, size, 100);
  near(sidebarGeometry(size, huge).chat.width, 290);
  assert.equal(huge.open, true);
  const bottom = placeSidebar(placement, 'bottom');
  assert.equal(sidebarGeometry(size, setSidebarRatio(bottom, size, -1)).sidebar.height, 140);
  near(sidebarGeometry(size, setSidebarRatio(bottom, size, 2)).chat.height, 170);
  assert.equal(setSidebarRatio(placement, { width: 300, height: 400 }, 0.5), placement);
  assert.equal(setSidebarRatio(placement, size, NaN), placement);
});

test('double-click equalization respects minimums and preserves the perpendicular ratio', () => {
  const original = { open: true, side: 'right', ratios: { x: 0.3, y: 0.47 } };
  const equal = setSidebarRatio(original, size, 0.5);
  near(sidebarGeometry(size, equal).sidebar.width, 494);
  near(sidebarGeometry(size, equal).chat.width, 494);
  assert.equal(equal.ratios.y, 0.47);
  const tight = setSidebarRatio(original, { width: 535, height: 400 }, 0.5);
  near(sidebarGeometry({ width: 535, height: 400 }, tight).chat.width, 290);
});

test('resize cancellation can retain its frozen starting value because updates are immutable', () => {
  const before = freeze(defaultSidebarPlacement());
  const updated = resizeSidebarRatio(before, size, 70);
  assert.notDeepEqual(updated, before);
  assert.deepEqual(before, defaultSidebarPlacement());
  assert.equal(sidebarGeometry(size, before).ratio, 0.36);
});

test('edge hit testing is constrained to the owning rectangle and leaves center invalid', () => {
  const rect = { x: 100, y: 200, width: 1000, height: 600 };
  assert.equal(edgeAt({ x: 101, y: 500 }, rect), 'left');
  assert.equal(edgeAt({ x: 1099, y: 500 }, rect), 'right');
  assert.equal(edgeAt({ x: 600, y: 201 }, rect), 'top');
  assert.equal(edgeAt({ x: 600, y: 799 }, rect), 'bottom');
  assert.equal(edgeAt({ x: 600, y: 500 }, rect), null);
  assert.equal(edgeAt({ x: 370, y: 500 }, rect), null);
  assert.equal(edgeAt({ x: 369.9, y: 500 }, rect), 'left');
  assert.equal(edgeAt({ x: 99, y: 500 }, rect), null);
  assert.equal(containsPoint({ x: 600, y: 500 }, { ...rect, width: 0 }), false);
  assert.equal(edgeAt({ x: 100, y: 200 }, rect), 'left');
});

test('drag threshold is Euclidean and starts exactly at five pixels', () => {
  const start = { x: 50, y: 60 };
  assert.equal(hasDragThreshold(start, { x: 52, y: 64 }), false);
  assert.equal(hasDragThreshold(start, { x: 53, y: 64 }), true);
});

test('split checks enforce both dimensions without silently changing direction', () => {
  assert.equal(canSplit({ width: 672, height: 270 }, 'right'), true);
  assert.equal(canSplit({ width: 671, height: 700 }, 'right'), false);
  assert.equal(canSplit({ width: 330, height: 552 }, 'bottom'), true);
  assert.equal(canSplit({ width: 330, height: 551 }, 'bottom'), false);
  assert.equal(canSplit({ width: 1000, height: 269 }, 'left'), false);
  assert.equal(canSplit({ width: 329, height: 1000 }, 'top'), false);
});

test('outer projection includes viewport and real available width or height', () => {
  const required = { width: 672, height: 270 };
  assert.equal(shouldProjectSingle({ width: 672, height: 270 }, required, 800), false);
  assert.equal(shouldProjectSingle({ width: 1000, height: 700 }, required, 799), true);
  assert.equal(shouldProjectSingle({ width: 671, height: 700 }, required, 1400), true);
  assert.equal(shouldProjectSingle({ width: 900, height: 269 }, required, 1400), true);
});

test('engine minimum reduction respects alternated axes, gap and native constraints', () => {
  const data = snapshot().dockview;
  assert.deepEqual(minimumDockviewSize(data), { width: 672, height: 270 });
  data.panels['panel-b'].minimumHeight = 350;
  assert.deepEqual(minimumDockviewSize(data), { width: 672, height: 350 });
  data.grid.orientation = 'VERTICAL';
  assert.deepEqual(minimumDockviewSize(data), { width: 330, height: 632 });
  data.grid.orientation = 'HORIZONTAL';
  data.grid.root.data[1] = {
    type: 'branch', size: 500,
    data: [group('panel-b'), group('panel-c')],
  };
  data.panels['panel-c'] = { id: 'panel-c', contentComponent: 'session' };
  assert.deepEqual(minimumDockviewSize(data), { width: 672, height: 632 });
});

test('move feasibility removes the source before measuring the final target', () => {
  const data = freeze(snapshot().dockview);
  assert.deepEqual(minimumAfterMove(data, 'panel-a', 'panel-b', 'bottom'), { width: 330, height: 552 });
  assert.deepEqual(minimumAfterMove(data, 'panel-a', 'panel-b', 'left'), { width: 672, height: 270 });
  assert.equal(minimumAfterMove(data, 'panel-a', 'panel-a', 'bottom'), null);
  assert.equal(minimumAfterMove(data, 'missing', 'panel-b', 'bottom'), null);
  assert.deepEqual(minimumDockviewSize(data), { width: 672, height: 270 });
});

test('new split feasibility counts a new panel while preserving siblings', () => {
  const data = freeze(snapshot().dockview);
  assert.deepEqual(minimumAfterSplit(data, 'panel-b', 'right'), { width: 1014, height: 270 });
  assert.deepEqual(minimumAfterSplit(data, 'panel-b', 'bottom'), { width: 672, height: 552 });
  assert.equal(minimumAfterSplit(data, 'missing', 'bottom'), null);
});

test('two-pane cross-axis preview uses the whole workspace after removing its source', () => {
  const data = freeze(snapshot().dockview);
  const workspace = { x: 40, y: 80, width: 1000, height: 700 };
  assert.deepEqual(movePreviewRect(data, 'panel-a', 'panel-b', 'bottom', workspace),
    { x: 40, y: 436, width: 1000, height: 344 });
  assert.deepEqual(movePreviewRect(data, 'panel-a', 'panel-b', 'top', workspace),
    { x: 40, y: 80, width: 1000, height: 344 });
  assert.deepEqual(data, snapshot().dockview);
});

test('same-axis two-pane preview accounts for native reorder size instead of inventing a half split', () => {
  const data = snapshot().dockview;
  data.grid.root.data[0].size = 600;
  data.grid.root.data[1].size = 388;
  const workspace = { x: 20, y: 30, width: 1000, height: 700 };
  assert.deepEqual(movePreviewRect(freeze(data), 'panel-a', 'panel-b', 'right', workspace),
    { x: 426, y: 30, width: 594, height: 700 });
});

test('preview fails closed for self, missing references and invalid workspace geometry', () => {
  const data = freeze(snapshot().dockview);
  const workspace = { x: 0, y: 0, width: 1000, height: 700 };
  assert.equal(movePreviewRect(data, 'panel-a', 'panel-a', 'bottom', workspace), null);
  assert.equal(movePreviewRect(data, 'absent', 'panel-b', 'bottom', workspace), null);
  assert.equal(movePreviewRect(data, 'panel-a', 'panel-b', 'bottom', { ...workspace, width: Infinity }), null);
});

test('preview leaves minimum-size borrowing and finite maximum constraints to the actual engine', () => {
  const data = snapshot().dockview;
  assert.equal(movePreviewRect(data, 'panel-a', 'panel-b', 'bottom', { x: 0, y: 0, width: 1000, height: 500 }), null);
  data.panels['panel-a'].maximumHeight = 400;
  assert.equal(movePreviewRect(data, 'panel-a', 'panel-b', 'bottom', { x: 0, y: 0, width: 1000, height: 700 }), null);
});

test('opening a menu captures an immutable explicit target without changing active binding', () => {
  const anchor = { id: 'panel-a', sessionId: 'session-a', bindingEpoch: 7 };
  const intent = captureSplitIntent({ anchor, targetSessionId: 'session-b', direction: 'right', intentEpoch: 3 });
  assert.equal(Object.isFrozen(intent), true);
  anchor.sessionId = 'session-c';
  anchor.bindingEpoch = 8;
  assert.equal(intent.anchorBindingEpoch, 7);
  assert.equal(intent.targetSessionId, 'session-b');
  assert.equal(intent.anchorPanelId, 'panel-a');
});

test('intent validation rejects late actions instead of falling back to current', () => {
  const bindings = [{ id: 'panel-a', sessionId: 'session-a', bindingEpoch: 7 }];
  const intent = captureSplitIntent({ anchor: bindings[0], targetSessionId: 'session-b', direction: 'bottom', intentEpoch: 3 });
  assert.equal(validateSplitIntent(intent, bindings, 3, true), null);
  assert.match(validateSplitIntent(intent, bindings, 4, true), /更新/);
  assert.match(validateSplitIntent(intent, [], 3, true), /关闭/);
  assert.match(validateSplitIntent(intent, [{ ...bindings[0], bindingEpoch: 8 }], 3, true), /切换/);
  assert.match(validateSplitIntent(intent, bindings, 3, false), /不可访问/);
  assert.match(validateSplitIntent(intent, [...bindings, { id: 'panel-b', sessionId: 'session-b', bindingEpoch: 0 }], 3, true), /已经显示/);
});

test('valid geometry round-trips while preserving only safe references and placement', () => {
  const saved = snapshot();
  const restored = parseSnapshot(serializeSnapshot(saved), 'dsh-v0.2.0-rc.2');
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value, saved);
  assert.equal(restored.value.panels[1].sidebar.side, 'bottom');
  assert.equal(restored.value.dockview.grid.root.data[0].data.hideHeader, true);
});

test('snapshot whitelist strips all business fields and temporary projections', () => {
  const input = fixture();
  input.messages = ['not-to-save'];
  input.maximizedId = 'panel-b';
  input.panels[0].title = 'sensitive title';
  input.panels[0].token = 'not-to-save';
  input.dockview.panels['panel-a'].title = 'sensitive title';
  input.dockview.panels['panel-a'].renderer = 'always';
  input.dockview.panels['panel-a'].params = { sessionId: 'session-a', token: 'not-to-save', url: 'not-to-save' };
  input.dockview.grid.maximizedNode = { location: [0] };
  input.dockview.grid.root.data[1].visible = false;
  input.panels[0].sidebar.ratios.terminal = 'not-to-save';
  const saved = createSnapshot(freeze(input));
  const raw = serializeSnapshot(saved);
  for (const forbidden of ['not-to-save', 'sensitive title', 'messages', 'params', 'renderer', 'maximized', 'visible', 'terminal']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
  assert.equal(input.dockview.grid.root.data[1].visible, false);
});

test('snapshot version and host baseline must match explicitly', () => {
  expectInvalid((data) => { data.version = 4; });
  expectInvalid((data) => { data.engineVersion = '9.0.0'; });
  assert.equal(parseSnapshot(serializeSnapshot(snapshot()), 'other-host').ok, false);
});

test('duplicate or stale Panel and Session references are rejected', () => {
  expectInvalid((data) => { data.panels[1].sessionId = data.panels[0].sessionId; });
  expectInvalid((data) => { data.panels[1].id = data.panels[0].id; });
  expectInvalid((data) => { data.activeId = 'missing'; });
  expectInvalid((data) => { data.activeId = null; });
  expectInvalid((data) => { data.dockview.activeGroup = 'missing'; });
  expectInvalid((data) => { data.dockview.grid.root.data[1].data.views = ['panel-a']; });
  expectInvalid((data) => { data.dockview.grid.root.data[1].data.id = 'group-panel-a'; });
  expectInvalid((data) => { delete data.dockview.panels['panel-b']; });
});

test('foreign components, tab merging and outside surfaces are rejected', () => {
  expectInvalid((data) => { data.dockview.panels['panel-a'].contentComponent = 'foreign-component'; });
  expectInvalid((data) => { data.dockview.grid.root.data[0].data.views.push('panel-b'); });
  expectInvalid((data) => { data.dockview.grid.root.data[0].data.tabGroups = [{ id: 'foreign' }]; });
  expectInvalid((data) => { data.dockview.floatingGroups = [{}]; });
  expectInvalid((data) => { data.dockview.popoutGroups = [{}]; });
  expectInvalid((data) => { data.dockview.edgeGroups = { left: {} }; });
});

test('invalid Sidebar ratios, directions and unsafe object keys are rejected', () => {
  for (const value of [0, 1, -0.2, 1.2, null, '0.5']) expectInvalid((data) => { data.panels[0].sidebar.ratios.x = value; });
  expectInvalid((data) => { data.panels[0].sidebar.side = 'center'; });
  expectInvalid((data) => { data.panels[0].sidebar.open = 'true'; });
  expectInvalid((data) => { data.panels[0].sessionId = '__proto__'; });
  expectInvalid((data) => { data.panels[0].id = 'constructor'; });
  expectInvalid((data) => { data.panels[0].sessionId = '\u0000bad'; });
  expectInvalid((data) => { data.panels[0].sessionId = 'x'.repeat(SNAPSHOT_LIMITS.idLength + 1); });
  const input = fixture();
  input.panels[0].sidebar.ratios.x = Infinity;
  assert.throws(() => createSnapshot(input), /ratio/);
});

test('grid rejects unknown types, invalid sizes and excessive nesting', () => {
  expectInvalid((data) => { data.dockview.grid.root.type = 'overlay'; });
  expectInvalid((data) => { data.dockview.grid.root = data.dockview.grid.root.data[0]; });
  expectInvalid((data) => { data.dockview.grid.width = -1; });
  expectInvalid((data) => { data.dockview.grid.height = SNAPSHOT_LIMITS.dimension + 1; });
  expectInvalid((data) => { data.dockview.grid.orientation = 'DIAGONAL'; });
  expectInvalid((data) => { data.dockview.grid.root.data[0].size = '50%'; });
  expectInvalid((data) => { data.dockview.grid.root.data[0].visible = 'false'; });
  expectInvalid((data) => {
    for (let index = 0; index < SNAPSHOT_LIMITS.depth + 1; index++) {
      data.dockview.grid.root = { type: 'branch', data: [data.dockview.grid.root], size: 1000 };
    }
  });
});

test('large and invalid JSON snapshots fail without changing the valid working snapshot', () => {
  const saved = freeze(snapshot());
  const before = serializeSnapshot(saved);
  assert.equal(parseSnapshot('{bad json').ok, false);
  assert.equal(parseSnapshot(' '.repeat(SNAPSHOT_LIMITS.bytes + 1)).ok, false);
  assert.equal(parseSnapshot('null').ok, false);
  assert.equal(parseSnapshot('[]').ok, false);
  assert.equal(serializeSnapshot(saved), before);
});

test('engine unconstrained maximum is omitted while contradictory bounds fail', () => {
  const input = fixture();
  input.dockview.panels['panel-a'].maximumWidth = Infinity;
  const saved = createSnapshot(input);
  assert.equal('maximumWidth' in saved.dockview.panels['panel-a'], false);
  expectInvalid((data) => { data.dockview.panels['panel-a'].maximumWidth = 100; });
});

test('zero panels is a legitimate empty workspace without a permanent empty group', () => {
  const saved = createSnapshot({
    hostVersion: 'dsh-v0.2.0-rc.2', panels: [], activeId: null,
    dockview: {
      grid: { root: { type: 'branch', data: [], size: 0 }, width: 0, height: 0, orientation: 'HORIZONTAL' },
      panels: {},
    },
  });
  assert.deepEqual(minimumDockviewSize(saved.dockview), { width: 0, height: 0 });
  assert.equal(parseSnapshot(serializeSnapshot(saved)).ok, true);
});

test('namespaced storage uses only the explicit host scope with no old-store fallback', () => {
  assert.equal(storageKey('connection-a/profile-b'), 'dsh.split.v5.geometry:connection-a%2Fprofile-b');
  assert.notEqual(storageKey('a:b'), storageKey('a%3Ab'));
  assert.throws(() => storageKey(''), /scope/);
  assert.throws(() => storageKey('__proto__'), /scope/);
});
