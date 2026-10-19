import type { DockviewApi } from 'dockview-core';

export interface OuterResizeHooks {
  onStart?: () => void;
  onChange?: () => void;
  onEnd?: (cancelled: boolean) => void;
}

type Axis = 'x' | 'y';
interface Pair {
  sash: HTMLElement;
  axis: Axis;
  before: number;
  after: number;
  parentSize: number;
}
interface Gesture {
  sash: HTMLElement;
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  shield: HTMLElement;
  ending: boolean;
}

/**
 * Dockview 8.5.1 owns pointer resizing and all ancestor/minimum constraints.
 * This adapter adds cancellation and accessibility to its outer sashes only.
 * It never traverses a native group, modifies a layout tree, calls fromJSON,
 * or reparents a content element. Version-specific DOM hooks are isolated here.
 */
export function installOuterResize(
  engineContainer: HTMLElement,
  api: DockviewApi,
  hooks: OuterResizeHooks = {},
): () => void {
  const doc = engineContainer.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  const originalAttributes = new Map<HTMLElement, Map<string, string | null>>();
  const originalClasses = new Map<HTMLElement, boolean>();
  let gesture: Gesture | null = null;
  let replaying = false;
  let disposed = false;
  let refreshFrame = 0;
  let changeFrame = 0;
  let syntheticId = 1_000_000;

  function outerSash(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof win!.Element)) return null;
    const sash = target.closest<HTMLElement>('.dv-sash');
    if (!sash || !engineContainer.contains(sash)) return null;
    // Native Sidebars can host their own layout engines. Never consume them.
    if (api.groups.some((group) => group.element.contains(sash))) return null;
    return sash;
  }

  function pairFor(sash: HTMLElement): Pair | null {
    const sashContainer = sash.parentElement;
    const split = sashContainer?.parentElement;
    if (!sashContainer?.classList.contains('dv-sash-container') ||
      !split?.classList.contains('dv-split-view-container')) return null;
    const views = Array.from(split.children).find((element) => element.classList.contains('dv-view-container'));
    const index = Array.from(sashContainer.children).indexOf(sash);
    if (!views || index < 0 || !views.children[index] || !views.children[index + 1]) return null;
    const axis = split.classList.contains('dv-horizontal') ? 'x' : 'y';
    const beforeRect = views.children[index].getBoundingClientRect();
    const afterRect = views.children[index + 1].getBoundingClientRect();
    const parentRect = split.getBoundingClientRect();
    const before = axis === 'x' ? beforeRect.width : beforeRect.height;
    const after = axis === 'x' ? afterRect.width : afterRect.height;
    if (before <= 0 || after <= 0) return null;
    return { sash, axis, before, after, parentSize: axis === 'x' ? parentRect.width : parentRect.height };
  }

  function remember(element: HTMLElement, name: string): void {
    let attributes = originalAttributes.get(element);
    if (!attributes) {
      attributes = new Map();
      originalAttributes.set(element, attributes);
      originalClasses.set(element, element.classList.contains('v5-outer-separator'));
    }
    if (!attributes.has(name)) attributes.set(name, element.getAttribute(name));
  }

  function attribute(element: HTMLElement, name: string, value: string): void {
    remember(element, name);
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function enhance(sash: HTMLElement): void {
    const pair = pairFor(sash);
    if (!pair) return;
    attribute(sash, 'tabindex', '0');
    attribute(sash, 'role', 'separator');
    attribute(sash, 'data-axis', pair.axis);
    attribute(sash, 'aria-orientation', pair.axis === 'x' ? 'vertical' : 'horizontal');
    attribute(sash, 'aria-label', '调整相邻会话尺寸；双击均分，方向键调整，Home/End 到边界');
    attribute(sash, 'aria-valuemin', '0');
    attribute(sash, 'aria-valuemax', '100');
    const percent = Math.round(pair.before / (pair.before + pair.after) * 100);
    attribute(sash, 'aria-valuenow', String(percent));
    attribute(sash, 'aria-valuetext', `${percent}% / ${100 - percent}%`);
    sash.classList.add('v5-outer-separator');
  }

  function refresh(): void {
    if (disposed) return;
    const nativeRoots = new Set(api.groups.map((group) => group.element));
    function visit(element: Element): void {
      if (nativeRoots.has(element as HTMLElement)) return;
      if (element.classList.contains('dv-sash')) enhance(element as HTMLElement);
      for (const child of Array.from(element.children)) visit(child);
    }
    visit(engineContainer);
    for (const sash of originalAttributes.keys()) {
      if (!engineContainer.contains(sash)) {
        originalAttributes.delete(sash);
        originalClasses.delete(sash);
      }
    }
  }

  function scheduleRefresh(): void {
    if (refreshFrame || disposed) return;
    refreshFrame = win!.requestAnimationFrame(() => { refreshFrame = 0; refresh(); });
  }

  function scheduleChange(): void {
    if (changeFrame || disposed) return;
    changeFrame = win!.requestAnimationFrame(() => {
      changeFrame = 0;
      refresh();
      if (gesture) hooks.onChange?.();
    });
  }

  function pointer(type: string, state: Pick<Gesture, 'pointerId' | 'pointerType' | 'x' | 'y'>): PointerEvent {
    return new win!.PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: state.pointerId,
      pointerType: state.pointerType, isPrimary: true, button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: state.x, clientY: state.y,
    });
  }

  function finish(cancelled: boolean): void {
    const state = gesture;
    if (!state || replaying) return;
    replaying = true;
    try {
      if (cancelled) {
        // Native 8.5.1 resizes against its captured initial `sizes`. A zero-delta
        // move restores every affected sibling while preserving every DOM parent.
        doc.dispatchEvent(pointer('pointermove', state));
        doc.dispatchEvent(pointer('pointercancel', state));
      }
    } finally {
      replaying = false;
      gesture = null;
      state.shield.remove();
      if (changeFrame) win!.cancelAnimationFrame(changeFrame);
      changeFrame = 0;
      refresh();
      hooks.onChange?.();
      hooks.onEnd?.(cancelled);
    }
  }

  function begin(event: PointerEvent): void {
    if (disposed || replaying) return;
    const sash = outerSash(event.target);
    if (!sash) return;
    if (gesture || event.button !== 0 || event.isPrimary === false || api.hasMaximizedGroup()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const pair = pairFor(sash);
    if (!pair) return;
    const shield = doc.createElement('div');
    shield.setAttribute('data-v5-outer-resize-shield', '');
    shield.setAttribute('aria-hidden', 'true');
    Object.assign(shield.style, {
      position: 'fixed', inset: '0', zIndex: '2147483000',
      pointerEvents: 'auto', background: 'transparent', userSelect: 'none',
      cursor: pair.axis === 'x' ? 'col-resize' : 'row-resize',
    });
    doc.body.append(shield);
    gesture = {
      sash, pointerId: event.pointerId, pointerType: event.pointerType || 'mouse',
      x: event.clientX, y: event.clientY, shield, ending: false,
    };
    sash.focus({ preventScroll: true });
    hooks.onStart?.();
    // Do not suppress the native sash listener: it owns constraints and sizing.
  }

  function move(event: PointerEvent): void {
    if (!gesture || replaying || event.pointerId !== gesture.pointerId) return;
    scheduleChange();
  }

  function end(event: PointerEvent): void {
    if (!gesture || replaying || event.pointerId !== gesture.pointerId) return;
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
      finish(true);
      return;
    }
    const state = gesture;
    state.ending = true;
    // The native document listener runs after this capture listener and releases
    // its iframe protection before the completion callback can persist anything.
    queueMicrotask(() => { if (gesture === state) finish(false); });
  }

  function cancel(event?: Event): void {
    if (!gesture || replaying) return;
    if (event?.type === 'contextmenu') event.preventDefault();
    finish(true);
  }

  function nudge(pair: Pair, delta: number): void {
    if (gesture || !Number.isFinite(delta)) return;
    const rect = pair.sash.getBoundingClientRect();
    const state = {
      pointerId: ++syntheticId, pointerType: 'mouse',
      x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    };
    pair.sash.dispatchEvent(pointer('pointerdown', state));
    if (!gesture) return;
    doc.dispatchEvent(pointer('pointermove', {
      ...state,
      x: state.x + (pair.axis === 'x' ? delta : 0),
      y: state.y + (pair.axis === 'y' ? delta : 0),
    }));
    doc.dispatchEvent(pointer('pointerup', state));
  }

  function doubleClick(event: MouseEvent): void {
    const sash = outerSash(event.target);
    const pair = sash && pairFor(sash);
    if (!pair || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    nudge(pair, (pair.after - pair.before) / 2);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && gesture) {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
      return;
    }
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const sash = outerSash(event.target);
    const pair = sash && pairFor(sash);
    if (!pair) return;
    const negative = pair.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const positive = pair.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const range = pair.parentSize || pair.before + pair.after;
    const delta = event.key === 'Home' ? -range : event.key === 'End' ? range
      : (pair.before + pair.after) * 0.025 * (event.key === negative ? -1 : 1);
    nudge(pair, delta);
  }

  engineContainer.addEventListener('pointerdown', begin, true);
  engineContainer.addEventListener('dblclick', doubleClick, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', end, true);
  doc.addEventListener('pointercancel', end, true);
  doc.addEventListener('lostpointercapture', end, true);
  doc.addEventListener('contextmenu', cancel, true);
  doc.addEventListener('keydown', keydown, true);
  win.addEventListener('blur', cancel);
  const subscriptions = [
    api.onDidLayoutChange(scheduleRefresh),
    api.onDidAddGroup(scheduleRefresh),
    api.onDidRemoveGroup(scheduleRefresh),
  ];
  refresh();

  return () => {
    if (disposed) return;
    finish(true);
    disposed = true;
    subscriptions.forEach((subscription) => subscription.dispose());
    engineContainer.removeEventListener('pointerdown', begin, true);
    engineContainer.removeEventListener('dblclick', doubleClick, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', end, true);
    doc.removeEventListener('pointercancel', end, true);
    doc.removeEventListener('lostpointercapture', end, true);
    doc.removeEventListener('contextmenu', cancel, true);
    doc.removeEventListener('keydown', keydown, true);
    win!.removeEventListener('blur', cancel);
    if (refreshFrame) win!.cancelAnimationFrame(refreshFrame);
    if (changeFrame) win!.cancelAnimationFrame(changeFrame);
    for (const [sash, attributes] of originalAttributes) {
      for (const [name, value] of attributes) {
        if (value === null) sash.removeAttribute(name);
        else sash.setAttribute(name, value);
      }
      if (!originalClasses.get(sash)) sash.classList.remove('v5-outer-separator');
    }
    originalAttributes.clear();
    originalClasses.clear();
  };
}
