import * as React from 'react';
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives';

export const NATIVE_CONTRACT = 'dsh-split/native-v5.1';
export const MAIN_KEY = 'dsh-split.workbench';
export const SESSION_SLOT = 'dsh-split.session';
export type SplitSide = 'right' | 'below';
export type Disposer = () => void;
export interface Snapshot<T> { getSnapshot(): T; subscribe(listener: () => void): Disposer }
export interface SessionReference {
  readonly sessionId: string;
  readonly binding: unknown;
  readonly ready: Promise<unknown>;
  release(): void;
}
export interface SessionSummary { id: string; title?: string; displayTitle?: string; [key: string]: unknown }
export interface SidebarPresentation { expanded: boolean; fullscreen: boolean }
export interface NativeCallbacks {
  openSession?(sessionId: string): void;
  splitSession?(anchorId: string, targetId: string, side: SplitSide): void;
  splitUnavailable?(anchorId: string, targetId: string, side: SplitSide): string | undefined;
  isShown?(sessionId: string): boolean;
  /** Whether this Session is one pane of a real split, so closing it alone keeps a workbench. */
  canClose?(sessionId: string): boolean;
  moveSession?(sessionId: string): void;
  closeSession?(sessionId: string): void;
  sidebarPresentation?(sessionId: string, presentation: SidebarPresentation): void;
}
export interface NativeBridge {
  readonly contract: typeof NATIVE_CONTRACT;
  readonly storageScope: string;
  readonly catalogStore: Snapshot<{ byId: Record<string, SessionSummary>; phase?: 'pending' | 'ready' }>;
  readonly currentStore: Snapshot<string | undefined>;
  readonly layoutVersion: Snapshot<number>;
  retain(sessionId: string): SessionReference;
  getSummary(sessionId: string): SessionSummary | undefined;
  focusSession(sessionId: string): void;
  setCallbacks(callbacks: NativeCallbacks): Disposer;
  notifyLayout(): void;
  toggleSidebar(sessionId: string): void;
  setSidebarExpanded(sessionId: string, expanded: boolean): void;
  setSidebarFullscreen(sessionId: string, fullscreen: boolean): void;
  reportSidebar(sessionId: string, presentation: SidebarPresentation): void;
  dispose(): void;
}
export interface NativeRenderProps {
  sessionId: string;
  bridge: NativeBridge;
  renderFactorySlot(name: string, owner: Record<string, unknown>, options?: unknown): React.ReactNode;
  [key: string]: unknown;
}
export interface NativeSidebarOptions {
  width: number;
  height: number;
  /** Whether this whole session is projected; selection is a separate state. */
  active: boolean;
  onPresentation?: (value: SidebarPresentation) => void;
}

/** These are host factories introduced by the checksum-pinned candidate patch. */
export function renderNativeConversation(props: NativeRenderProps): React.ReactNode {
  return props.renderFactorySlot('conversation.surface', { embedded: true });
}
export function renderNativeSidebar(props: NativeRenderProps, options: NativeSidebarOptions): React.ReactNode {
  return props.renderFactorySlot('sidebar.right.surface', {
    embedded: true,
    width: Math.max(0, options.width),
    viewportWidth: Math.max(0, options.width),
    hostHeight: Math.max(0, options.height),
    canShow: true,
    active: options.active,
    onPresentation: options.onPresentation ?? ((value: SidebarPresentation) => {
      props.bridge.reportSidebar(props.sessionId, value);
    }),
  });
}

/** Native Cordis services are structurally checked before claiming the main seat. */
type HostContext = {
  slots: any;
  sessions: any;
  uiSession: any;
  uiWorkspace: any;
  layout: any;
  sidebarRightHost: any;
  connection?: any;
  effect?(effect: () => Disposer, name?: string): Disposer;
};

function once(fn: Disposer): Disposer { let live = true; return () => { if (live) { live = false; fn(); } }; }

/** rc.2 exposes host.home, not an invented profile/server identifier. */
export function storageScopeFor(ctx: HostContext, location = globalThis.location): string {
  const home = ctx.connection?.generation?.getSnapshot()?.host?.home;
  if (!location || !/^(https?|dsh-app):$/.test(location.protocol)) {
    return `temporary-${globalThis.crypto.randomUUID()}`;
  }
  // Desktop's own origin and a loopback web origin already belong to this local
  // browser profile. A random key here discarded the layout on every reload.
  const local = ctx.connection?.isLoopback === true;
  if (!local && typeof home !== 'string') return `temporary-${globalThis.crypto.randomUUID()}`;
  const origin = location.protocol === 'dsh-app:' ? `dsh-app://${location.host}` : location.origin;
  const identity = `${origin}${location.pathname}\u0000${local ? 'local-profile' : home}`;
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const character of identity) { const c = character.codePointAt(0)!; a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b); }
  return `web-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

export function installNativeHost(
  ctx: HostContext,
  Workbench: React.ComponentType<any>,
  SessionPane: React.ComponentType<any>,
): NativeBridge {
  if (ctx.layout?.splitContract !== NATIVE_CONTRACT || ctx.sidebarRightHost?.contract !== NATIVE_CONTRACT || ctx.uiWorkspace?.splitContract !== NATIVE_CONTRACT) {
    throw new Error('DSH Split v5 needs the verified rc.2 native-v5.1 host patch; original UI remains available.');
  }
  for (const [label, method] of Object.entries({ retain: ctx.sessions?.retain, bindingSource: ctx.uiSession?.adapter?.bindingSource, register: ctx.slots?.register, snapshot: ctx.slots?.snapshot, openSession: ctx.uiWorkspace?.openSession, navigationRequests: ctx.uiWorkspace?.navigationRequests?.subscribe })) {
    if (typeof method !== 'function') throw new Error(`DSH Split native capability missing: ${label}`);
  }
  // snapshot is the shipped public factory inspection face; private _core is never used.
  for (const [name, scope] of [['conversation.surface', 'session-maybe'], ['sidebar.right.surface', 'session']]) {
    const trees = ctx.slots.snapshot(`factory:${name}`);
    if (!Array.isArray(trees) || !trees.some(tree => tree.type === 'factory' && tree.name === name && tree.scope === scope)) {
      throw new Error(`DSH Split native factory missing or incompatible: ${name}`);
    }
  }
  const nativeCurrent = ctx.uiSession.adapter.current;
  const currentStore: Snapshot<string | undefined> = {
    getSnapshot: () => nativeCurrent.getSnapshot().key,
    subscribe: listener => nativeCurrent.subscribe(listener),
  };
  const listeners = new Set<() => void>();
  let version = 0, disposed = false;
  let callbacks: NativeCallbacks = {};
  const held = new Set<Disposer>();
  const cleanup: Disposer[] = [];
  const notifyLayout = () => { if (!disposed) { version += 1; for (const listener of [...listeners]) listener(); } };
  const active = () => !disposed && ctx.layout.panelInfo.getSnapshot().activePanelId === null;
  const bridge: NativeBridge = {
    contract: NATIVE_CONTRACT,
    storageScope: storageScopeFor(ctx),
    catalogStore: ctx.sessions.list,
    currentStore,
    layoutVersion: { getSnapshot: () => version, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } },
    retain(sessionId) {
      if (disposed) throw new Error('DSH Split native host was disposed.');
      const reference = ctx.sessions.retain(sessionId, { source: 'splitView' });
      let sidebar: { release(): void };
      try { sidebar = ctx.sidebarRightHost.acquire(sessionId); }
      catch (error) { reference.release(); throw error; }
      const nativeRelease = reference.release.bind(reference);
      const release = once(() => {
        held.delete(release);
        // React layout cleanups finish before the native scope is retired.
        queueMicrotask(() => { sidebar.release(); nativeRelease(); });
      });
      held.add(release);
      reference.release = release;
      return reference;
    },
    getSummary: id => ctx.sessions.list.getSnapshot().byId[id],
    focusSession(id) {
      if (disposed || !active() || callbacks.isShown?.(id) === false) return;
      ctx.sidebarRightHost.setActive(id);
      if (currentStore.getSnapshot() !== id) ctx.uiWorkspace.openSession(id);
    },
    setCallbacks(next) {
      if (disposed) return () => {};
      callbacks = next;
      notifyLayout();
      return once(() => { if (callbacks === next) callbacks = {}; });
    },
    notifyLayout,
    toggleSidebar(id) { if (!disposed) ctx.sidebarRightHost.toggleExpanded(id); },
    setSidebarExpanded(id, expanded) { if (!disposed) ctx.sidebarRightHost.setExpanded(id, expanded); },
    setSidebarFullscreen(id, fullscreen) { if (!disposed) ctx.sidebarRightHost.setFullscreen(id, fullscreen); },
    reportSidebar(id, presentation) { if (!disposed) callbacks.sidebarPresentation?.(id, presentation); },
    dispose: once(() => {
      disposed = true;
      callbacks = {};
      for (const release of [...held]) release();
      for (const release of cleanup.reverse()) release();
      listeners.clear();
    }),
  };

  function SplitMenuItem({ sessionId, useMenuOpenState, side }: any) {
    const [open, setOpen] = useMenuOpenState();
    const anchor = React.useRef<string | undefined>(undefined);
    const wasOpen = React.useRef(false);
    // Native rows may keep their menu contribution mounted while closed.
    if (open && !wasOpen.current) anchor.current = currentStore.getSnapshot();
    wasOpen.current = open;
    React.useSyncExternalStore(bridge.layoutVersion.subscribe, bridge.layoutVersion.getSnapshot);
    const from = anchor.current;
    const unavailable = !from ? '请先打开一个会话' : callbacks.splitUnavailable?.(from, sessionId, side);
    return React.createElement(MenuItemButton as React.ComponentType<any>, {
      disabled: Boolean(unavailable),
      title: unavailable,
      onSelect: () => {
        const captured = anchor.current;
        setOpen(false);
        if (!captured || disposed || callbacks.splitUnavailable?.(captured, sessionId, side)) return;
        callbacks.splitSession?.(captured, sessionId, side);
      },
    }, side === 'right' ? '向右分屏' : '向下分屏');
  }

  function PaneMenuItem({sessionId, useMenuOpenState, action}: any) {
    const [, setOpen] = useMenuOpenState();
    React.useSyncExternalStore(bridge.layoutVersion.subscribe, bridge.layoutVersion.getSnapshot);
    // The close row follows the header control: only a pane of a real split may be closed
    // alone. The move row keeps its own reason (requestMove reports the single-pane case).
    const available = () => action === 'close' ? Boolean(callbacks.canClose?.(sessionId)) : Boolean(callbacks.isShown?.(sessionId));
    if (!available()) return null;
    return React.createElement(MenuItemButton as React.ComponentType<any>, {
      onSelect: () => {
        setOpen(false);
        if (disposed || !available()) return;
        if (action === 'move') callbacks.moveSession?.(sessionId);
        else callbacks.closeSession?.(sessionId);
      },
    }, action === 'move' ? '移动分屏' : '关闭此分屏');
  }

  /** The pane's own close control is drawn by the plugin's pane chrome
      (`SessionPane` in src/workbench.tsx), not by a native header slot: the shipped
      header wraps BOTH `headerActions` and `headerUtilities` in `!hideChrome`, so a
      blank Session — exactly what a fresh split shows — renders only the corner, and
      that single seat belongs to the shipped Sidebar control. The plugin chrome is the
      only surface that exists for every pane in every Session state. */

  try {
    cleanup.push(ctx.sidebarRightHost.claim());
    cleanup.push(ctx.slots.register({
      name: 'main', key: MAIN_KEY,
      children: { [SESSION_SLOT]: { kind: 'single', scope: 'session' } },
      inject: () => ({ bridge }),
    }, Workbench));
    cleanup.push(ctx.slots.register({ name: SESSION_SLOT, inject: () => ({ bridge }) }, SessionPane));
    cleanup.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
      for (const [index, side] of (['right', 'below'] as const).entries()) yield ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: `dsh-split.${side}`, order: 450 + index,
        inject: () => ({ side }),
      }, SplitMenuItem);
      for (const [index, action] of (['move', 'close'] as const).entries()) yield ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item', id: `dsh-split.${action}`, order: 452 + index,
        inject: () => ({action}),
      }, PaneMenuItem);
    }));
    let previous = currentStore.getSnapshot();
    cleanup.push(currentStore.subscribe(() => {
      const next = currentStore.getSnapshot();
      if (next === previous) return;
      previous = next;
      if (next !== undefined && !disposed) {
        ctx.sidebarRightHost.setActive(next);
      }
      notifyLayout();
    }));
    cleanup.push(ctx.uiWorkspace.navigationRequests.subscribe(() => {
      const request = ctx.uiWorkspace.navigationRequests.getSnapshot();
      // A successful explicit open is an event, including a second click on A.
      // Native background restoration retains the current global panel.
      if (!request || disposed || (!request.reveal && !active())) return;
      ctx.sidebarRightHost.setActive(request.sessionId);
      callbacks.openSession?.(request.sessionId);
      notifyLayout();
    }));
    cleanup.push(ctx.layout.panelInfo.subscribe(() => ctx.sidebarRightHost.setHostVisible(active())));
    cleanup.push(ctx.layout.claimConversationHost(MAIN_KEY));
    ctx.sidebarRightHost.setHostVisible(active());
    ctx.sidebarRightHost.setActive(previous);
  } catch (error) { bridge.dispose(); throw error; }
  if (ctx.effect) ctx.effect(() => bridge.dispose, 'dsh-split: native host lease');
  return bridge;
}
