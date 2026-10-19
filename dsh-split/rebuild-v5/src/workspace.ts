import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-core';
import {
  LAYOUT, defaultSidebarPlacement, createSnapshot, parseSnapshot, serializeSnapshot,
  storageKey, minimumDockviewSize, minimumAfterMove, minimumAfterSplit,
  shouldProjectSingle, type Side, type SidebarPlacement, type GeometrySnapshot,
} from './geometry';
import type { NativeBridge } from './host';

export interface Pane { id: string; sessionId: string; sidebar: SidebarPlacement; epoch: number; fullscreen?: boolean }
export const HOST_VERSION = '0.2.0-rc.2';
// Dockview allocates gap space from each view after applying its constraints.
// Reserve one full gap so the visible panel never goes below the product limit,
// including branches with more than two siblings.
const ENGINE_MINIMUM = {
  width: LAYOUT.minPanelWidth + LAYOUT.gap,
  height: LAYOUT.minPanelHeight + LAYOUT.gap,
};

/** Dockview owns the only outer layout tree. This store holds bindings and inner geometry. */
export class Workspace {
  readonly panes = new Map<string, Pane>();
  readonly mounts = new Map<string, HTMLElement>();
  readonly listeners = new Set<() => void>();
  readonly bridge: NativeBridge;
  engine?: DockviewComponent;
  api?: DockviewApi;
  element?: HTMLElement;
  activeId: string | null = null;
  narrow = false;
  maximized = false;
  resizing = false;
  movingId: string | null = null;
  toast = '';
  revision = 0;
  private sequence = 0;
  private epoch = 0;
  private updating = false;
  private disposed = false;
  private initialized = false;
  private pendingOpen?: string;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private disposers: (() => void)[] = [];
  private desktop?: GeometrySnapshot;
  private storage?: Storage;
  private storageFailed = false;
  private minimumSize?: {width:number;height:number};
  private key: string;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.revision;

  constructor(bridge: NativeBridge, scope: string, storage?: Storage) {
    this.bridge = bridge;
    this.storage = storage;
    this.key = storageKey(scope);
  }

  attach(element: HTMLElement) {
    this.element = element;
    this.engine = new DockviewComponent(element, {
      // The workspace observer owns projection and sizing. A second observer in
      // Dockview would repeat layout and can clamp proportions before projection.
      disableAutoResizing: true,
      disableFloatingGroups: true, disableDnd: true, dndEdges: false,
      hideBorders: true, singleTabMode: 'default', noPanelsOverlay: 'emptyGroup',
      theme: { name: 'dsh-split-v5', className: 'v5-theme', gap: LAYOUT.gap },
      createComponent: ({ id }) => {
        const mount = document.createElement('div');
        mount.className = 'v5-panel-mount';
        mount.dataset.panelId = id;
        this.mounts.set(id, mount);
        return { element: mount, init() {}, dispose: () => {
          if (this.mounts.get(id) === mount) this.mounts.delete(id);
        } };
      },
    });
    this.api = this.engine.api;
    const layoutListener = this.api.onDidLayoutChange(() => {
      if (this.updating || this.disposed) return;
      // Dockview already laid out the DOM. Geometry changes do not require
      // re-rendering every native conversation and all its slot factories.
      if (!this.narrow && !this.maximized) this.scheduleSave();
    });
    const activeListener = this.api.onDidActivePanelChange(() => {
      const id = this.api?.activePanel?.id;
      if (!id || this.updating || id === this.activeId) return;
      this.focus(id);
    });
    this.disposers.push(() => layoutListener.dispose(), () => activeListener.dispose());
    this.disposers.push(this.bridge.setCallbacks({
      openSession: id => this.open(id),
      isShown: id => Boolean(this.bySession(id)),
      // One pane IS the normal view; only a real split has panes that may be closed alone.
      // Closing the last pane would empty the workbench, so the close entries stay hidden.
      canClose: id => Boolean(this.bySession(id)) && this.panes.size > 1,
      moveSession: id => { const pane = this.bySession(id); if (pane) this.requestMove(pane.id); },
      closeSession: id => { const pane = this.bySession(id); if (pane) this.close(pane.id); },
      splitUnavailable: (a, b, side) => this.splitUnavailable(a, b, side === 'below' ? 'bottom' : 'right'),
      splitSession: (a, b, side) => this.split(a, b, side === 'below' ? 'bottom' : 'right'),
      sidebarPresentation: (id, presentation) => {
        const pane = this.bySession(id);
        if (!pane || (pane.sidebar.open === presentation.expanded && Boolean(pane.fullscreen) === presentation.fullscreen)) return;
        this.panes.set(pane.id, {
          ...pane,
          sidebar: { ...pane.sidebar, open: presentation.expanded },
          fullscreen: presentation.fullscreen,
        });
        this.changed();
      },
    }));
    // Persisted ids are not retainable until the native catalog finishes loading.
    // Restoring before that point crashed the main slot on a cold start.
    const initialize = () => {
      if(this.initialized || this.disposed || this.bridge.catalogStore.getSnapshot().phase === 'pending')return;
      this.initialized = true;
      this.updating = true;
      try {
        const raw = this.storage?.getItem(this.key);
        if(raw){
          const decoded = parseSnapshot(raw, HOST_VERSION);
          if(decoded.ok){
            this.desktop = decoded.value;
            for(const pane of decoded.value.panels)if(this.bridge.getSummary(pane.sessionId))this.panes.set(pane.id,{...pane,epoch:++this.epoch});
            this.api!.fromJSON(decoded.value.dockview as any);
            for(const panel of [...this.api!.panels]){
              if(this.panes.has(panel.id))this.configure(panel);else this.api!.removePanel(panel);
            }
            this.activeId = decoded.value.activeId && this.panes.has(decoded.value.activeId) ? decoded.value.activeId : this.panes.keys().next().value ?? null;
          }else this.inform('保存的布局与当前版本不兼容，已使用新布局。');
        }
      }catch{this.panes.clear();this.activeId=null;this.desktop=undefined;this.api!.clear();this.inform('无法恢复布局，已使用新布局。');}
      finally{this.updating=false;this.minimumSize=undefined;}
      const current=this.pendingOpen??this.bridge.currentStore.getSnapshot();
      this.pendingOpen=undefined;
      if(current&&this.bridge.getSummary(current))this.open(current);
      else if(this.activeId)this.focus(this.activeId);
      this.layout();this.changed();
    };
    this.disposers.push(this.bridge.catalogStore.subscribe(initialize));
    initialize();
    const resize = new ResizeObserver(() => this.layout());
    resize.observe(element);
    const onWindowResize = () => this.layout();
    window.addEventListener('resize', onWindowResize);
    const flush = () => this.save();
    window.addEventListener('pagehide', flush);
    this.disposers.push(() => resize.disconnect(), () => window.removeEventListener('resize', onWindowResize), () => window.removeEventListener('pagehide', flush));
    this.layout();
    this.changed();
  }

  private configure(panel: IDockviewPanel) {
    panel.group.api.locked = 'no-drop-target';
    panel.api.setConstraints({ minimumWidth: ENGINE_MINIMUM.width, minimumHeight: ENGINE_MINIMUM.height });
    panel.api.setRenderer('always');
  }
  private add(sessionId: string, anchor?: string, side: Side = 'right') {
    this.minimumSize = undefined;
    const api = this.api!;
    const id = `v5-${Date.now().toString(36)}-${++this.sequence}`;
    const pane: Pane = { id, sessionId, sidebar: defaultSidebarPlacement(), epoch: ++this.epoch };
    this.panes.set(id, pane);
    const group = api.addGroup({
      locked: 'no-drop-target', hideHeader: true,
      direction: side === 'bottom' ? 'below' : side === 'top' ? 'above' : side,
      ...(anchor ? { referenceGroup: api.getPanel(anchor)!.group } : {}),
    });
    const panel = api.addPanel({ id, component: 'session', renderer: 'always',
      position: { referenceGroup: group },
      minimumWidth: ENGINE_MINIMUM.width, minimumHeight: ENGINE_MINIMUM.height });
    this.configure(panel);
    return pane;
  }
  bySession(id: string) { return [...this.panes.values()].find(p => p.sessionId === id); }
  title(pane: Pane) {
    const summary = this.bridge.getSummary(pane.sessionId);
    return summary?.displayTitle || summary?.title || '未命名会话';
  }
  open(sessionId: string) {
    if (!this.api || this.disposed) return;
    if(!this.initialized){this.pendingOpen=sessionId;return;}
    const shown = this.bySession(sessionId);
    if (shown) { this.focus(shown.id); return; }
    const pane = this.activeId && this.panes.get(this.activeId);
    this.updating = true;
    let id: string;
    try {
      if (pane) {
        this.panes.set(pane.id, {...pane, sessionId, epoch:++this.epoch, sidebar:defaultSidebarPlacement(), fullscreen:undefined});
        id = pane.id;
      } else id = this.add(sessionId).id;
    } finally { this.updating = false; }
    this.focus(id!);
    this.changed();
  }
  focus(id: string) {
    const pane = this.panes.get(id);
    const native = this.api?.getPanel(id);
    if (!pane || !native) return;
    this.activeId = id;
    this.updating = true;
    try {
      // Changing the maximized group at a narrow size would make Dockview save
      // minimum-clamped proportions. Restore its desktop envelope first.
      if (this.narrow || this.maximized) this.restoreDesktopEnvelope();
      native.api.setActive();
      if (this.narrow || this.maximized) {
        native.group.api.maximize();
        this.layoutCurrentSize();
      }
    } finally { this.updating = false; }
    this.bridge.focusSession(pane.sessionId);
    this.changed(false);
  }
  splitUnavailable(anchorSession: string, target: string, side: Side): string | undefined {
    const anchor = this.bySession(anchorSession);
    if (!anchor) return '原会话已不在窗口中';
    if (anchorSession === target) return '不能与当前会话重复分屏';
    if (this.bySession(target)) return '该会话已经显示，请直接定位';
    if (this.maximized) return '请先还原会话，再分屏';
    if (this.narrow) return '窗口过窄，请加宽后再分屏';
    if (!this.bridge.getSummary(target)) return '目标会话暂不可用';
    const required = minimumAfterSplit(this.geometry(), anchor.id, side);
    if (!required || !this.fits(required)) return '空间不足，请扩大窗口或关闭一个分屏';
  }
  split(anchorSession: string, target: string, side: Side) {
    const shown = this.bySession(target);
    if (shown) { this.focus(shown.id); return; }
    const reason = this.splitUnavailable(anchorSession, target, side);
    if (reason) { this.inform(reason); return; }
    const anchor = this.bySession(anchorSession)!;
    this.updating = true;
    let pane: Pane;
    try { pane = this.add(target, anchor.id, side); }
    finally { this.updating = false; }
    this.focus(pane!.id);
    this.changed();
  }
  moveUnavailable(source: string, target: string, side: Side, geometry = this.geometry()): string | undefined {
    if (!this.panes.has(source) || !this.panes.has(target) || source === target) return '请选择另一个会话';
    if (this.maximized) return '请先还原会话，再调整布局';
    if (this.narrow) return '窗口过窄，请加宽后再调整布局';
    const required = minimumAfterMove(geometry, source, target, side);
    if (!required || !this.fits(required)) return '这个方向的空间不足';
  }
  move(source: string, target: string, side: Side) {
    const reason = this.moveUnavailable(source, target, side);
    if (reason) { this.inform(reason); return false; }
    this.minimumSize = undefined;
    this.updating = true;
    try { this.api!.getPanel(source)!.group.api.moveTo({ group: this.api!.getPanel(target)!.group, position: side }); }
    finally { this.updating = false; }
    this.focus(source);
    this.changed();
    return true;
  }
  close(id: string) {
    const pane = this.api?.getPanel(id);
    if (!pane) return;
    this.minimumSize = undefined;
    if (this.movingId === id) this.movingId = null;
    this.updating = true;
    try {
      if (this.narrow || this.maximized) this.restoreDesktopEnvelope();
      else this.api!.exitMaximizedGroup();
      this.maximized = false;
      this.narrow = false;
      this.panes.delete(id);
      this.api!.removePanel(pane);
      this.activeId = this.api!.activePanel?.id ?? null;
      if (this.panes.size) this.captureDesktop();
      else this.desktop = undefined;
    } finally { this.updating = false; }
    this.layout();
    if (this.activeId) this.focus(this.activeId);
    this.changed();
  }
  sidebar(id: string, value: SidebarPlacement) {
    const pane = this.panes.get(id);
    if (!pane) return;
    this.panes.set(id, { ...pane, sidebar: value });
    this.changed();
  }
  toggleSidebar(id: string) {
    const pane = this.panes.get(id);
    if (!pane) return;
    const open = !pane.sidebar.open;
    this.sidebar(id, { ...pane.sidebar, open });
    this.bridge.setSidebarExpanded(pane.sessionId, open);
  }
  requestMove(id: string) {
    if (!this.panes.has(id)) return;
    if (this.narrow || this.maximized) { this.inform('请先还原或加宽窗口，再移动会话'); return; }
    if (this.panes.size < 2) { this.inform('先从左侧会话菜单创建分屏'); return; }
    this.movingId = id;
    this.changed(false);
  }
  maximize(id: string) {
    if (this.narrow) { this.inform('窄窗口已显示当前会话，加宽窗口会恢复布局。'); return; }
    this.updating = true;
    try {
      if (!this.maximized) {
        this.captureDesktop();
        this.maximized = true;
      } else {
        this.restoreDesktopEnvelope();
        this.maximized = false;
        this.layoutCurrentSize();
      }
    } finally { this.updating = false; }
    this.focus(id); this.changed();
  }
  visible(id: string) { return !(this.narrow || this.maximized) || this.activeId === id; }
  private fits(size: {width:number;height:number}) {
    return !!this.element && size.width <= this.element.clientWidth && size.height <= this.element.clientHeight;
  }
  geometry() {
    // Dockview.toJSON temporarily unmaximizes internally. Calling it during a
    // narrow projection would itself commit narrow minimum-clamped proportions.
    if ((this.narrow || this.maximized) && this.desktop) return this.desktop.dockview;
    return createSnapshot({hostVersion:HOST_VERSION,panels:[...this.panes.values()],activeId:this.activeId,dockview:this.api!.toJSON()}).dockview;
  }
  private layoutCurrentSize() {
    if (this.api && this.element) this.api.layout(this.element.clientWidth, this.element.clientHeight);
  }
  private restoreDesktopEnvelope() {
    if (!this.api) return;
    if (this.desktop) {
      const { width, height } = this.desktop.dockview.grid;
      this.api.layout(width, height);
    }
    this.api.exitMaximizedGroup();
  }
  layout() {
    if (!this.api || !this.element || this.disposed) return;
    const size = { width: this.element.clientWidth, height: this.element.clientHeight };
    if (!size.width || !size.height) return;
    const required = this.minimumSize ??= this.panes.size > 0 ? minimumDockviewSize(this.geometry()) : {width:0,height:0};
    const narrow = this.panes.size > 1 && shouldProjectSingle(size, required, window.innerWidth);
    const wasNarrow = this.narrow;
    const wasProjected = this.narrow || this.maximized;
    const willProject = narrow || this.maximized;
    this.updating = true;
    try {
      if (willProject && !wasProjected) {
        this.captureDesktop();
        if (this.activeId) this.api.getPanel(this.activeId)?.group.api.maximize();
      } else if (!willProject && wasProjected) {
        this.restoreDesktopEnvelope();
      }
      this.narrow = narrow;
      this.api.layout(size.width, size.height);
    } finally { this.updating = false; }
    if (wasNarrow !== narrow || wasProjected !== willProject) this.changed(false);
  }
  private captureDesktop() {
    if (this.api && this.panes.size) this.desktop = createSnapshot({ hostVersion:HOST_VERSION,panels:[...this.panes.values()],activeId:this.activeId,dockview:this.api.toJSON() });
  }
  changed = (persist = true) => {
    if (this.disposed) return;
    this.revision++;
    for (const fn of [...this.listeners]) fn();
    this.bridge.notifyLayout();
    if (persist) this.scheduleSave();
  };
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    if (!this.resizing && this.initialized) this.saveTimer = setTimeout(() => this.save(), LAYOUT.saveDelay);
  }
  geometrySettled() { this.scheduleSave(); this.bridge.notifyLayout(); }
  save() {
    if (!this.storage || !this.api || this.resizing || !this.initialized) return;
    try {
      if (!this.panes.size) { this.storage.removeItem(this.key); this.desktop = undefined; return; }
      if (!this.narrow && !this.maximized) this.captureDesktop();
      else if (this.desktop) this.desktop = createSnapshot({ ...this.desktop, panels:[...this.panes.values()], activeId:this.activeId });
      if (this.desktop) this.storage.setItem(this.key, serializeSnapshot(this.desktop));
    } catch {
      if (!this.storageFailed) {
        this.storageFailed = true;
        this.inform('布局暂时无法保存；当前会话和操作仍保留在本窗口中。');
      }
    }
  }
  inform(message: string) {
    this.toast = message; clearTimeout(this.toastTimer); this.changed(false);
    this.toastTimer = setTimeout(() => { this.toast = ''; this.changed(false); }, 3500);
  }
  dispose() {
    this.save(); this.disposed = true;
    clearTimeout(this.saveTimer); clearTimeout(this.toastTimer);
    for (const dispose of this.disposers.reverse()) dispose();
    this.engine?.dispose(); this.listeners.clear(); this.mounts.clear();
  }
}
