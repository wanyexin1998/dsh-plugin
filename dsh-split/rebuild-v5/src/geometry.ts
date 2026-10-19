/**
 * Geometry and safe references only. The native host owns all conversation and
 * Sidebar resource state; Dockview owns the outer layout. No DOM or storage IO.
 */
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Axis = 'x' | 'y';
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}
export interface SidebarPlacement {
  open: boolean;
  side: Side;
  ratios: { x: number; y: number };
}
export interface SidebarGeometry {
  chat: Rect;
  sidebar: Rect;
  divider: Rect;
  onlySidebar: boolean;
  axis: Axis;
  ratio: number;
}
export interface SnapshotPanel {
  id: string;
  sessionId: string;
  sidebar: SidebarPlacement;
}
export interface GeometryGroup {
  id: string;
  views: string[];
  activeView?: string;
  hideHeader?: boolean;
}
export interface GeometryGridNode {
  type: 'leaf' | 'branch';
  data: GeometryGroup | GeometryGridNode[];
  size?: number;
  visible?: boolean;
}
export interface GeometryDockview {
  grid: {
    root: GeometryGridNode;
    width: number;
    height: number;
    orientation: 'HORIZONTAL' | 'VERTICAL';
  };
  panels: Record<string, {
    id: string;
    contentComponent: 'session';
    minimumWidth?: number;
    minimumHeight?: number;
    maximumWidth?: number;
    maximumHeight?: number;
  }>;
  activeGroup?: string;
}
export interface GeometrySnapshot {
  version: 5;
  hostVersion: string;
  engineVersion: '8.5.1';
  panels: SnapshotPanel[];
  activeId: string | null;
  dockview: GeometryDockview;
}
export interface SnapshotInput {
  hostVersion: string;
  engineVersion?: string;
  panels: readonly SnapshotPanel[];
  activeId: string | null;
  dockview: unknown;
}
export type SnapshotResult =
  | { ok: true; value: GeometrySnapshot }
  | { ok: false; reason: string };

export const SIDES: readonly Side[] = Object.freeze(['left', 'right', 'top', 'bottom']);
export const LAYOUT = Object.freeze({
  gap: 12,
  minPanelWidth: 330,
  minPanelHeight: 270,
  sidebarMinWidth: 220,
  chatMinWidth: 290,
  sidebarMinHeight: 140,
  chatMinHeight: 170,
  sidebarSingleWidth: 535,
  sidebarSingleHeight: 322,
  sidebarReturnHeight: 28,
  narrowViewport: 800,
  dragThreshold: 5,
  edgeFraction: 0.27,
  saveDelay: 220,
  clickSuppression: 80,
  sidebarKeyboardStep: 0.03,
  outerKeyboardStep: 0.025,
});
export const SNAPSHOT_LIMITS = Object.freeze({
  bytes: 262_144,
  panels: 64,
  nodes: 256,
  depth: 16,
  idLength: 256,
  dimension: 10_000_000,
});

export function defaultSidebarPlacement(): SidebarPlacement {
  return { open: true, side: 'right', ratios: { x: 0.36, y: 0.4 } };
}

export function sidebarAxis(side: Side): Axis {
  return side === 'left' || side === 'right' ? 'x' : 'y';
}

export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Calculate an inner projection without mutating the saved desktop placement. */
export function sidebarGeometry(
  size: Size,
  placement: SidebarPlacement,
  side: Side = placement.side,
): SidebarGeometry {
  const width = dimension(size.width);
  const height = dimension(size.height);
  const axis = sidebarAxis(side);
  const ratio = placement.ratios[axis];
  const full = { x: 0, y: 0, width, height };
  const empty = { x: 0, y: 0, width: 0, height: 0 };
  if (!placement.open) {
    return { chat: full, sidebar: empty, divider: empty, onlySidebar: false, axis, ratio };
  }
  const compact = axis === 'x'
    ? width < LAYOUT.sidebarSingleWidth
    : height < LAYOUT.sidebarSingleHeight;
  if (compact) {
    return {
      chat: empty,
      sidebar: { ...full, height: Math.max(0, height - LAYOUT.sidebarReturnHeight) },
      divider: empty,
      onlySidebar: true,
      axis,
      ratio,
    };
  }
  const room = (axis === 'x' ? width : height) - LAYOUT.gap;
  const minimum = axis === 'x' ? LAYOUT.sidebarMinWidth : LAYOUT.sidebarMinHeight;
  const chatMinimum = axis === 'x' ? LAYOUT.chatMinWidth : LAYOUT.chatMinHeight;
  const sidebarSize = clamp(room * ratio, minimum, room - chatMinimum);
  const chatSize = room - sidebarSize;
  const leading = side === 'left' || side === 'top';
  if (axis === 'x') {
    return {
      sidebar: { x: leading ? 0 : width - sidebarSize, y: 0, width: sidebarSize, height },
      chat: { x: leading ? sidebarSize + LAYOUT.gap : 0, y: 0, width: chatSize, height },
      divider: { x: leading ? sidebarSize : chatSize, y: 0, width: LAYOUT.gap, height },
      onlySidebar: false,
      axis,
      ratio: sidebarSize / room,
    };
  }
  return {
    sidebar: { x: 0, y: leading ? 0 : height - sidebarSize, width, height: sidebarSize },
    chat: { x: 0, y: leading ? sidebarSize + LAYOUT.gap : 0, width, height: chatSize },
    divider: { x: 0, y: leading ? sidebarSize : chatSize, width, height: LAYOUT.gap },
    onlySidebar: false,
    axis,
    ratio: sidebarSize / room,
  };
}

export function placeSidebar(placement: SidebarPlacement, side: Side): SidebarPlacement {
  return { open: true, side, ratios: { ...placement.ratios } };
}

export function toggleSidebar(placement: SidebarPlacement): SidebarPlacement {
  return { ...placement, open: !placement.open, ratios: { ...placement.ratios } };
}

/** Explicit resizing affects one axis only and never automatically closes it. */
export function setSidebarRatio(
  placement: SidebarPlacement,
  size: Size,
  ratio: number,
): SidebarPlacement {
  const axis = sidebarAxis(placement.side);
  const length = dimension(axis === 'x' ? size.width : size.height);
  const compactAt = axis === 'x' ? LAYOUT.sidebarSingleWidth : LAYOUT.sidebarSingleHeight;
  if (!Number.isFinite(ratio) || length < compactAt) return placement;
  const room = length - LAYOUT.gap;
  const minimum = axis === 'x' ? LAYOUT.sidebarMinWidth : LAYOUT.sidebarMinHeight;
  const chatMinimum = axis === 'x' ? LAYOUT.chatMinWidth : LAYOUT.chatMinHeight;
  return {
    ...placement,
    ratios: { ...placement.ratios, [axis]: clamp(ratio, minimum / room, 1 - chatMinimum / room) },
  };
}

export function resizeSidebarRatio(
  placement: SidebarPlacement,
  size: Size,
  deltaPixels: number,
  startRatio = sidebarGeometry(size, placement).ratio,
): SidebarPlacement {
  const axis = sidebarAxis(placement.side);
  const room = dimension(axis === 'x' ? size.width : size.height) - LAYOUT.gap;
  if (!Number.isFinite(deltaPixels) || room <= 0) return placement;
  const sign = placement.side === 'left' || placement.side === 'top' ? 1 : -1;
  return setSidebarRatio(placement, size, startRatio + sign * deltaPixels / room);
}

export function containsPoint(point: Point, rect: Rect): boolean {
  return rect.width > 0 && rect.height > 0 &&
    point.x >= rect.x && point.x <= rect.x + rect.width &&
    point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function edgeAt(point: Point, rect: Rect): Side | null {
  if (!containsPoint(point, rect)) return null;
  const edges: [Side, number][] = [
    ['left', (point.x - rect.x) / rect.width],
    ['right', (rect.x + rect.width - point.x) / rect.width],
    ['top', (point.y - rect.y) / rect.height],
    ['bottom', (rect.y + rect.height - point.y) / rect.height],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] < LAYOUT.edgeFraction ? edges[0][0] : null;
}

export function hasDragThreshold(start: Point, point: Point): boolean {
  return Math.hypot(point.x - start.x, point.y - start.y) >= LAYOUT.dragThreshold;
}

/** Local candidate check; the engine retains responsibility for ancestor constraints. */
export function canSplit(size: Size, side: Side): boolean {
  return sidebarAxis(side) === 'x'
    ? size.width >= LAYOUT.minPanelWidth * 2 + LAYOUT.gap && size.height >= LAYOUT.minPanelHeight
    : size.height >= LAYOUT.minPanelHeight * 2 + LAYOUT.gap && size.width >= LAYOUT.minPanelWidth;
}

export function shouldProjectSingle(container: Size, required: Size, viewportWidth: number): boolean {
  return viewportWidth < LAYOUT.narrowViewport ||
    required.width > container.width || required.height > container.height;
}

function panelMinimum(json: GeometryDockview, panelId: string): Size {
  const panel = json.panels[panelId];
  return {
    width: Math.max(LAYOUT.minPanelWidth, panel?.minimumWidth ?? 0),
    height: Math.max(LAYOUT.minPanelHeight, panel?.minimumHeight ?? 0),
  };
}

function combineMinimum(children: readonly Size[], axis: Axis): Size | null {
  if (!children.length) return null;
  const gap = LAYOUT.gap * (children.length - 1);
  return axis === 'x'
    ? { width: children.reduce((total, child) => total + child.width, gap), height: Math.max(...children.map((child) => child.height)) }
    : { width: Math.max(...children.map((child) => child.width)), height: children.reduce((total, child) => total + child.height, gap) };
}

/** Reduce the engine's readonly serialization to two numbers, never a second tree. */
function measureGrid(json: GeometryDockview, leaf: (panelId: string) => Size | null): Size | null {
  let count = 0;
  function measure(node: GeometryGridNode, axis: Axis, depth: number): Size | null {
    if (++count > SNAPSHOT_LIMITS.nodes || depth > SNAPSHOT_LIMITS.depth) throw new Error('Layout grid exceeds structural limits');
    if (node.type === 'leaf') {
      const group = node.data as GeometryGroup;
      if (!Array.isArray(group.views) || group.views.length !== 1) throw new Error('Each group must contain exactly one session');
      return leaf(group.views[0]);
    }
    if (node.type !== 'branch' || !Array.isArray(node.data)) throw new Error('Unknown grid node type');
    const children = node.data.map((child) => measure(child, axis === 'x' ? 'y' : 'x', depth + 1))
      .filter((child): child is Size => child !== null);
    return combineMinimum(children, axis);
  }
  return measure(json.grid.root, json.grid.orientation === 'HORIZONTAL' ? 'x' : 'y', 0);
}

export function minimumDockviewSize(json: GeometryDockview): Size {
  return measureGrid(json, (panelId) => panelMinimum(json, panelId)) ?? { width: 0, height: 0 };
}

/**
 * A feasibility calculation for a directional move. It removes the source from
 * this scalar reduction and expands the target once; it neither edits nor emits
 * a layout. Dockview still performs the only actual move.
 */
export function minimumAfterMove(
  json: GeometryDockview,
  sourcePanelId: string,
  targetPanelId: string,
  side: Side,
): Size | null {
  if (sourcePanelId === targetPanelId || !json.panels[sourcePanelId] || !json.panels[targetPanelId]) return null;
  let sourceFound = false;
  let targetFound = false;
  const required = measureGrid(json, (panelId) => {
    if (panelId === sourcePanelId) {
      sourceFound = true;
      return null;
    }
    if (panelId === targetPanelId) {
      targetFound = true;
      return combineMinimum([panelMinimum(json, panelId), panelMinimum(json, sourcePanelId)], sidebarAxis(side));
    }
    return panelMinimum(json, panelId);
  });
  return sourceFound && targetFound ? required : null;
}

export function minimumAfterSplit(json: GeometryDockview, anchorPanelId: string, side: Side): Size | null {
  if (!json.panels[anchorPanelId]) return null;
  let anchorFound = false;
  const required = measureGrid(json, (panelId) => {
    const size = panelMinimum(json, panelId);
    if (panelId !== anchorPanelId) return size;
    anchorFound = true;
    return combineMinimum([size, { width: LAYOUT.minPanelWidth, height: LAYOUT.minPanelHeight }], sidebarAxis(side));
  });
  return anchorFound ? required : null;
}

/**
 * Read a provable two-pane drop rectangle without creating a candidate tree.
 * Nested/multi-pane margin redistribution and constraint borrowing return null;
 * callers retain the direction label and separately validated native move.
 */
export function movePreviewRect(
  json: GeometryDockview,
  sourcePanelId: string,
  targetPanelId: string,
  side: Side,
  workspaceRect: Rect,
): Rect | null {
  if (sourcePanelId === targetPanelId || !SIDES.includes(side) ||
    !json.panels[sourcePanelId] || !json.panels[targetPanelId] ||
    ![workspaceRect.x, workspaceRect.y, workspaceRect.width, workspaceRect.height].every(Number.isFinite) ||
    workspaceRect.width <= 0 || workspaceRect.height <= 0) return null;
  if (Object.values(json.panels).some((panel) =>
    Number.isFinite(panel.maximumWidth) || Number.isFinite(panel.maximumHeight))) return null;
  let node = json.grid.root;
  let axis: Axis = json.grid.orientation === 'HORIZONTAL' ? 'x' : 'y';
  let depth = 0;
  // Dockview may retain an only branch under its root after changing axes.
  while (node.type === 'branch' && (node.data as GeometryGridNode[]).length === 1) {
    if (++depth > SNAPSHOT_LIMITS.depth) return null;
    node = (node.data as GeometryGridNode[])[0];
    axis = axis === 'x' ? 'y' : 'x';
  }
  if (node.type !== 'branch') return null;
  const children = node.data as GeometryGridNode[];
  if (children.length !== 2 || children.some((child) => child.type !== 'leaf' ||
    (child.data as GeometryGroup).views.length !== 1 || !Number.isFinite(child.size))) return null;
  const sourceIndex = children.findIndex((child) => (child.data as GeometryGroup).views[0] === sourcePanelId);
  const targetIndex = children.findIndex((child) => (child.data as GeometryGroup).views[0] === targetPanelId);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const dropAxis = sidebarAxis(side);
  const full: Rect = { x: workspaceRect.x, y: workspaceRect.y, width: workspaceRect.width, height: workspaceRect.height };
  const length = (size: Size, along: Axis) => along === 'x' ? size.width : size.height;
  const crop = (offset: number, size: number): Rect => dropAxis === 'x'
    ? { ...full, x: full.x + offset, width: size }
    : { ...full, y: full.y + offset, height: size };
  const room = length(full, dropAxis);
  let sourceSize: number;
  if (dropAxis === axis) {
    // Native same-branch moves retain the source's pre-move visible size as
    // their new internal allocation, which then loses half the theme gap.
    const oldTotal = children.reduce<number>((sum, child) => sum + child.size!, LAYOUT.gap);
    if (oldTotal <= 0) return null;
    const sourceAllocation = children[sourceIndex].size! + LAYOUT.gap / 2;
    let scaled = Math.round(sourceAllocation * room / oldTotal);
    if (Math.abs(oldTotal - room) < 0.01) scaled = sourceAllocation;
    sourceSize = scaled - LAYOUT.gap;
  } else {
    // Removing either pane leaves the other covering the whole workspace.
    // The native split gives the target floor(half) and the source the rest.
    sourceSize = room - Math.floor(room / 2) - LAYOUT.gap / 2;
  }
  const targetSize = room - sourceSize - LAYOUT.gap;
  const leading = side === 'left' || side === 'top';
  const result = crop(leading ? 0 : targetSize + LAYOUT.gap, sourceSize);
  const targetRect = crop(0, targetSize);
  const fits = (rect: Rect, size: Size) => rect.width + 0.01 >= size.width && rect.height + 0.01 >= size.height;
  return fits(result, panelMinimum(json, sourcePanelId)) && fits(targetRect, panelMinimum(json, targetPanelId)) ? result : null;
}
export interface PanelBinding { id: string; sessionId: string; bindingEpoch: number }
export interface SplitIntent {
  anchorPanelId: string;
  anchorBindingEpoch: number;
  targetSessionId: string;
  direction: 'right' | 'bottom';
  intentEpoch: number;
}
export interface SplitIntentInput {
  anchor: PanelBinding;
  targetSessionId: string;
  direction: 'right' | 'bottom';
  intentEpoch: number;
}

export function captureSplitIntent(input: SplitIntentInput): SplitIntent {
  return Object.freeze({
    anchorPanelId: input.anchor.id,
    anchorBindingEpoch: input.anchor.bindingEpoch,
    targetSessionId: input.targetSessionId,
    direction: input.direction,
    intentEpoch: input.intentEpoch,
  });
}

export function validateSplitIntent(
  intent: SplitIntent,
  bindings: readonly PanelBinding[],
  currentIntentEpoch: number,
  targetAvailable: boolean,
): string | null {
  if (intent.intentEpoch !== currentIntentEpoch) return '此操作已被更新的选择替代';
  const anchor = bindings.find((panel) => panel.id === intent.anchorPanelId);
  if (!anchor) return '分屏参照会话已关闭';
  if (anchor.bindingEpoch !== intent.anchorBindingEpoch) return '分屏参照已切换会话';
  if (!targetAvailable) return '目标会话已失效或不可访问';
  if (bindings.some((panel) => panel.sessionId === intent.targetSessionId)) return '该会话已经显示，请直接定位';
  return null;
}

export function storageKey(connectionId: string): string {
  assertIdentifier(connectionId, 'connection scope');
  return `dsh.split.v5.geometry:${encodeURIComponent(connectionId)}`;
}

// Persistence implementations below use a whitelist, never native business state.
function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > SNAPSHOT_LIMITS.idLength ||
    /[\u0000-\u001f\u007f]/u.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export function createSnapshot(input: SnapshotInput): GeometrySnapshot {
  return sanitizeSnapshot({ ...input, version: 5, engineVersion: input.engineVersion ?? '8.5.1' });
}

export function parseSnapshot(raw: string, expectedHostVersion?: string): SnapshotResult {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > SNAPSHOT_LIMITS.bytes) {
      throw new Error('Layout snapshot exceeds the size limit');
    }
    const value = sanitizeSnapshot(JSON.parse(raw));
    if (expectedHostVersion !== undefined && value.hostVersion !== expectedHostVersion) {
      throw new Error('Layout host version is incompatible');
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Invalid layout snapshot' };
  }
}

export function serializeSnapshot(snapshot: GeometrySnapshot): string {
  const result = JSON.stringify(sanitizeSnapshot(snapshot));
  if (new TextEncoder().encode(result).length > SNAPSHOT_LIMITS.bytes) {
    throw new Error('Layout snapshot exceeds the size limit');
  }
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function finiteDimension(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > SNAPSHOT_LIMITS.dimension) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function validRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error('Invalid Sidebar ratio');
  }
  return value;
}

function sanitizePlacement(value: unknown): SidebarPlacement {
  const placement = object(value, 'Sidebar placement');
  if (!SIDES.includes(placement.side as Side) || typeof placement.open !== 'boolean') {
    throw new Error('Invalid Sidebar placement');
  }
  const ratios = object(placement.ratios, 'Sidebar ratios');
  return {
    open: placement.open,
    side: placement.side as Side,
    ratios: { x: validRatio(ratios.x), y: validRatio(ratios.y) },
  };
}

function assertNoGroups(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length !== 0) throw new Error(`Unsupported ${label}`);
}

/**
 * Copy the engine's serialization through a fixed whitelist. Its tree is never
 * independently mutated here. Titles, params, renderers, tab groups, maximized
 * projections and foreign components cannot survive into our persisted form.
 */
function sanitizeDockview(value: unknown, panelIds: ReadonlySet<string>): GeometryDockview {
  const engine = object(value, 'Dockview layout');
  assertNoGroups(engine.floatingGroups, 'floating groups');
  assertNoGroups(engine.popoutGroups, 'popout groups');
  if (engine.edgeGroups !== undefined) {
    const edgeGroups = object(engine.edgeGroups, 'edge groups');
    if (Object.values(edgeGroups).some((group) => group !== null && group !== undefined &&
      !(Array.isArray(group) && group.length === 0))) {
      throw new Error('Unsupported edge groups');
    }
  }
  const rawPanels = object(engine.panels, 'Dockview panels');
  if (Object.keys(rawPanels).length !== panelIds.size) throw new Error('Dockview panel references do not match');
  const panels: GeometryDockview['panels'] = {};
  for (const [id, value] of Object.entries(rawPanels)) {
    assertIdentifier(id, 'Dockview panel id');
    const rawPanel = object(value, 'Dockview panel');
    if (rawPanel.id !== id || !panelIds.has(id) || rawPanel.contentComponent !== 'session') {
      throw new Error('Invalid Dockview panel reference or component');
    }
    const panel: GeometryDockview['panels'][string] = { id, contentComponent: 'session' };
    for (const key of ['minimumWidth', 'minimumHeight', 'maximumWidth', 'maximumHeight'] as const) {
      if (rawPanel[key] === undefined) continue;
      // The engine may represent an unconstrained maximum as Infinity in memory.
      // It is omitted, never serialized into JSON's misleading null value.
      if ((key === 'maximumWidth' || key === 'maximumHeight') && rawPanel[key] === Infinity) continue;
      panel[key] = finiteDimension(rawPanel[key], 'panel constraint');
    }
    if ((panel.maximumWidth !== undefined && panel.maximumWidth < (panel.minimumWidth ?? 0)) ||
      (panel.maximumHeight !== undefined && panel.maximumHeight < (panel.minimumHeight ?? 0))) {
      throw new Error('Contradictory panel constraints');
    }
    panels[id] = panel;
  }
  const grid = object(engine.grid, 'Dockview grid');
  if (grid.orientation !== 'HORIZONTAL' && grid.orientation !== 'VERTICAL') {
    throw new Error('Invalid Dockview grid orientation');
  }
  const seenPanels = new Set<string>();
  const seenGroups = new Set<string>();
  let nodes = 0;
  function node(value: unknown, depth: number): GeometryGridNode {
    if (depth > SNAPSHOT_LIMITS.depth || ++nodes > SNAPSHOT_LIMITS.nodes) {
      throw new Error('Layout grid exceeds structural limits');
    }
    const raw = object(value, 'grid node');
    if (raw.type !== 'leaf' && raw.type !== 'branch') throw new Error('Unknown grid node type');
    const result: GeometryGridNode = { type: raw.type, data: [] };
    if (raw.size !== undefined) result.size = finiteDimension(raw.size, 'grid node size');
    if (raw.visible !== undefined && typeof raw.visible !== 'boolean') throw new Error('Invalid grid visibility');
    // Visibility and maximization are temporary projections, not desktop geometry.
    if (raw.type === 'branch') {
      if (!Array.isArray(raw.data) || raw.data.length > SNAPSHOT_LIMITS.panels ||
        (raw.data.length === 0 && (depth !== 0 || panelIds.size !== 0))) {
        throw new Error('Invalid grid branch');
      }
      result.data = raw.data.map((child) => node(child, depth + 1));
      return result;
    }
    const data = object(raw.data, 'Dockview group');
    assertIdentifier(data.id, 'Dockview group id');
    if (seenGroups.has(data.id)) throw new Error('Duplicate Dockview group');
    seenGroups.add(data.id);
    if (!Array.isArray(data.views) || data.views.length !== 1) throw new Error('Each group must contain exactly one session');
    const id = data.views[0];
    assertIdentifier(id, 'group panel reference');
    if (!panelIds.has(id) || seenPanels.has(id)) throw new Error('Duplicate or unknown group panel reference');
    seenPanels.add(id);
    if (data.activeView !== undefined && data.activeView !== id) throw new Error('Invalid active group panel');
    assertNoGroups(data.tabGroups, 'tab groups');
    result.data = { id: data.id, views: [id], activeView: id, hideHeader: true };
    return result;
  }
  const root = node(grid.root, 0);
  if (root.type !== 'branch') throw new Error('Dockview root must be a branch');
  if (seenPanels.size !== panelIds.size) throw new Error('Some session panels are not present in the grid');
  const result: GeometryDockview = {
    grid: {
      root,
      width: finiteDimension(grid.width, 'grid width'),
      height: finiteDimension(grid.height, 'grid height'),
      orientation: grid.orientation,
    },
    panels,
  };
  if (engine.activeGroup !== undefined) {
    assertIdentifier(engine.activeGroup, 'active group');
    if (!seenGroups.has(engine.activeGroup)) throw new Error('Unknown active group');
    result.activeGroup = engine.activeGroup;
  }
  return result;
}

function sanitizeSnapshot(value: unknown): GeometrySnapshot {
  const raw = object(value, 'layout snapshot');
  if (raw.version !== 5 || raw.engineVersion !== '8.5.1') throw new Error('Unsupported layout or engine version');
  assertIdentifier(raw.hostVersion, 'host version');
  if (!Array.isArray(raw.panels) || raw.panels.length > SNAPSHOT_LIMITS.panels) {
    throw new Error('Invalid session panel list');
  }
  const panelIds = new Set<string>();
  const sessionIds = new Set<string>();
  const panels: SnapshotPanel[] = raw.panels.map((value) => {
    const panel = object(value, 'session panel');
    assertIdentifier(panel.id, 'panel id');
    assertIdentifier(panel.sessionId, 'session id');
    if (panelIds.has(panel.id) || sessionIds.has(panel.sessionId)) throw new Error('Duplicate panel or session reference');
    panelIds.add(panel.id);
    sessionIds.add(panel.sessionId);
    return { id: panel.id, sessionId: panel.sessionId, sidebar: sanitizePlacement(panel.sidebar) };
  });
  if (raw.activeId !== null && (typeof raw.activeId !== 'string' || !panelIds.has(raw.activeId))) {
    throw new Error('Unknown active panel');
  }
  if ((panels.length === 0) !== (raw.activeId === null)) {
    throw new Error('An open workspace must retain one explicit active panel');
  }
  return {
    version: 5,
    hostVersion: raw.hostVersion,
    engineVersion: '8.5.1',
    panels,
    activeId: raw.activeId as string | null,
    dockview: sanitizeDockview(raw.dockview, panelIds),
  };
}
