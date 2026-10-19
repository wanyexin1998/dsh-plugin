import * as React from 'react';
import { IconCheckOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { SIDES, type Axis, type Point, type Rect, type Side } from './geometry';

export const SIDE_LABELS: Readonly<Record<Side, string>> = Object.freeze({
  left: '左侧', right: '右侧', top: '上方', bottom: '下方',
});

function useLatest<T>(value: T) {
  const ref = React.useRef(value);
  ref.current = value;
  return ref;
}

function focusIfConnected(element: HTMLElement | null | undefined) {
  if (element?.isConnected) element.focus({ preventScroll: true });
}

function rectStyle(rect: Rect): React.CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

export interface SidebarMenuProps {
  anchor: HTMLElement;
  side: Side;
  /** A short ownership label, for example “会话 A”. */
  title: string;
  onSelect(side: Side): void;
  onClose(): void;
}

/** Render inside the parent's themed [data-v5-overlay] root, without a portal. */
export function SidebarMenu(props: SidebarMenuProps) {
  const { anchor, side, title } = props;
  const latest = useLatest(props);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const closing = React.useRef(false);
  const restoreFocus = React.useRef(true);
  const id = React.useId();
  const [position, setPosition] = React.useState<React.CSSProperties>({ left: 8, top: 8, visibility: 'hidden' });

  const close = React.useCallback((restore: boolean) => {
    if (closing.current) return;
    closing.current = true;
    restoreFocus.current = restore;
    if (restore) focusIfConnected(latest.current.anchor);
    latest.current.onClose();
  }, [latest]);

  React.useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const doc = anchor.ownerDocument;
    const view = doc.defaultView;
    closing.current = false;
    restoreFocus.current = true;
    const previousControls = anchor.getAttribute('aria-controls');
    const previousHasPopup = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', id);
    anchor.setAttribute('aria-haspopup', 'menu');

    const place = () => {
      if (!anchor.isConnected) { close(false); return; }
      const origin = anchor.getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      const width = doc.documentElement.clientWidth;
      const height = doc.documentElement.clientHeight;
      const left = Math.max(8, Math.min(origin.right - box.width, width - box.width - 8));
      const top = Math.max(8, Math.min(origin.bottom + 6, height - box.height - 8));
      setPosition(previous => previous.left === left && previous.top === top && previous.visibility === 'visible'
        ? previous : { left, top, visibility: 'visible' });
    };
    place();

    const pointerOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(menu) || path.includes(anchor)) return;
      // Do not return focus while the user is pressing a different native view.
      close(false);
    };
    const focusOutside = (event: FocusEvent) => {
      const path = event.composedPath();
      if (!path.includes(menu) && !path.includes(anchor)) close(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (!menu.contains(doc.activeElement)) return;
      if (event.key === 'Tab') {
        // Restore the trigger synchronously so native Tab traversal continues
        // from it after the menu is removed, without trapping focus.
        close(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      if (!items.length) return;
      const current = items.indexOf(doc.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus({ preventScroll: true });
    };
    doc.addEventListener('pointerdown', pointerOutside, true);
    doc.addEventListener('focusin', focusOutside, true);
    doc.addEventListener('keydown', keyboard, true);
    doc.addEventListener('scroll', place, true);
    view?.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(anchor);
    observer?.observe(menu);
    return () => {
      doc.removeEventListener('pointerdown', pointerOutside, true);
      doc.removeEventListener('focusin', focusOutside, true);
      doc.removeEventListener('keydown', keyboard, true);
      doc.removeEventListener('scroll', place, true);
      view?.removeEventListener('resize', place);
      observer?.disconnect();
      anchor.setAttribute('aria-expanded', 'false');
      if (previousControls === null) anchor.removeAttribute('aria-controls');
      else anchor.setAttribute('aria-controls', previousControls);
      if (previousHasPopup === null) anchor.removeAttribute('aria-haspopup');
      else anchor.setAttribute('aria-haspopup', previousHasPopup);
      if (restoreFocus.current && (menu.contains(doc.activeElement) || doc.activeElement === doc.body)) {
        focusIfConnected(anchor);
      }
    };
  }, [anchor, close, id]);

  React.useLayoutEffect(() => {
    if (position.visibility === 'visible') {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }, [anchor, position.visibility]);

  return <div ref={menuRef} id={id} className="v5-menu" data-kind="sidebar" role="menu"
    aria-label="Sidebar 停靠位置" style={position} onKeyDown={event => event.stopPropagation()}>
    <div className="v5-menu-label">停靠在 {title} 内</div>
    {SIDES.map(direction => <button key={direction} type="button" role="menuitemradio"
      aria-checked={side === direction} data-side={direction} onClick={() => {
        if (closing.current) return;
        if (!latest.current.anchor.isConnected) { close(false); return; }
        latest.current.onSelect(direction);
        close(true);
      }}>
      <span>{SIDE_LABELS[direction]}</span>
      {side === direction && <IconCheckOutlineRegular aria-hidden="true" />}
    </button>)}
  </div>;
}

export interface MoveTarget { id: string; title: string }
export interface MoveDialogProps {
  /** Displayed verbatim as the heading, for example “移动会话 A”. */
  title: string;
  targets: readonly MoveTarget[];
  /** Return false if the move was rejected and the dialog should stay open. */
  onMove(targetId: string, side: Side): boolean | void;
  unavailable(targetId: string, side: Side): string | undefined;
  onClose(): void;
}

export function MoveDialog(props: MoveDialogProps) {
  const { title, targets, unavailable } = props;
  const latest = useLatest(props);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const selectRef = React.useRef<HTMLSelectElement>(null);
  const closing = React.useRef(false);
  const backdropPointer = React.useRef<number | null>(null);
  const [targetId, setTargetId] = React.useState(targets[0]?.id ?? '');
  const [side, setSide] = React.useState<Side>('right');
  const [submissionMessage, setSubmissionMessage] = React.useState('');
  const titleId = React.useId();
  const descriptionId = React.useId();
  const targetInputId = React.useId();
  const messageId = React.useId();
  const selectedTarget = targets.some(target => target.id === targetId) ? targetId : targets[0]?.id ?? '';
  const reason = selectedTarget ? unavailable(selectedTarget, side) : '需要另一个已显示的会话，才能选择移动位置。';

  React.useEffect(() => {
    if (targetId !== selectedTarget) {
      setTargetId(selectedTarget);
      setSubmissionMessage('');
    }
  }, [targetId, selectedTarget]);

  const close = React.useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (dialogRef.current?.open) dialogRef.current.close();
    latest.current.onClose();
  }, [latest]);

  React.useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const doc = dialog.ownerDocument;
    const previousFocus = doc.activeElement as HTMLElement | null;
    closing.current = false;
    if (!dialog.open) dialog.showModal();
    if (!selectRef.current?.disabled) selectRef.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !dialog.open) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    doc.addEventListener('keydown', keyboard, true);
    return () => {
      doc.removeEventListener('keydown', keyboard, true);
      closing.current = true;
      if (dialog.open) dialog.close();
      // close() itself normally restores focus. This covers controlled unmounts
      // without stealing focus from another dialog or a newly selected view.
      if (dialog.contains(doc.activeElement) || doc.activeElement === doc.body) focusIfConnected(previousFocus);
    };
  }, [close]);

  const outsideDialog = (event: React.PointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };

  return <dialog ref={dialogRef} className="v5-dialog" aria-labelledby={titleId}
    aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); close(); }}
    onClose={event => { if (!event.currentTarget.open) close(); }}
    onKeyDown={event => event.stopPropagation()}
    onPointerDown={event => { backdropPointer.current = outsideDialog(event) ? event.pointerId : null; }}
    onPointerUp={event => {
      const wasBackdrop = backdropPointer.current === event.pointerId;
      backdropPointer.current = null;
      if (wasBackdrop && outsideDialog(event)) close();
    }} onPointerCancel={() => { backdropPointer.current = null; }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (closing.current) return;
      const targetExists = latest.current.targets.some(target => target.id === selectedTarget);
      const currentReason = targetExists ? latest.current.unavailable(selectedTarget, side) : '参照会话已关闭，请重新选择。';
      if (currentReason) { setSubmissionMessage(currentReason); return; }
      if (latest.current.onMove(selectedTarget, side) === false) {
        setSubmissionMessage('当前位置无法完成移动，请重新选择。');
        return;
      }
      close();
    }}>
      <div className="v5-dialog-head">
        <div><h2 id={titleId}>{title}</h2><p id={descriptionId}>也可以拖动会话顶部的窄边缘来调整位置。</p></div>
        <button type="button" aria-label="取消" onClick={close}><IconCloseOutlineRegular aria-hidden="true" /></button>
      </div>
      <div className="v5-dialog-body">
        <label className="v5-field-label" htmlFor={targetInputId}>放到哪个会话的旁边？</label>
        <select ref={selectRef} id={targetInputId} value={selectedTarget} disabled={!targets.length}
          aria-describedby={reason || submissionMessage ? messageId : undefined}
          onChange={event => { setTargetId(event.target.value); setSubmissionMessage(''); }}>
          {!targets.length && <option value="">没有可用的会话</option>}
          {targets.map(target => <option key={target.id} value={target.id}>{target.title}</option>)}
        </select>
        <div className="v5-direction-buttons" role="group" aria-label="移动方向" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (!buttons.length) return;
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const advance = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + advance + buttons.length) % buttons.length;
          const direction = buttons[next].dataset.side as Side;
          setSide(direction);
          setSubmissionMessage('');
          buttons[next].focus({ preventScroll: true });
        }}>
          {SIDES.map(direction => {
            const disabledReason = selectedTarget ? unavailable(selectedTarget, direction) : '没有可用的会话';
            return <button key={direction} type="button" data-side={direction} aria-pressed={side === direction}
              disabled={Boolean(disabledReason)} title={disabledReason} onClick={() => { setSide(direction); setSubmissionMessage(''); }}>
              <span>{SIDE_LABELS[direction]}</span>
            </button>;
          })}
        </div>
        {(reason || submissionMessage) && <p id={messageId} className="v5-dialog-note" role="status">{reason || submissionMessage}</p>}
      </div>
      <div className="v5-dialog-footer">
        <button type="button" className="v5-secondary" onClick={close}>取消</button>
        <button type="submit" className="v5-primary" disabled={Boolean(reason)}>移动</button>
      </div>
    </form>
  </dialog>;
}

export { MoveDialog as MoveSessionDialog };

export interface DragOverlayProps {
  kind: 'session' | 'sidebar' | 'resize';
  point?: Point;
  title?: string;
  scope?: Rect;
  preview?: Rect | null;
  label?: string;
  axis?: Axis;
}

/** Visuals only: pointer ownership and transactional Esc cancellation stay in
 * the gesture controller so iframe crossing cannot split one pointer stream.
 */
export function DragOverlay({ kind, point, title, scope, preview, label, axis }: DragOverlayProps) {
  return <>
    <div className="v5-drag-shield" data-axis={kind === 'resize' ? axis : undefined} aria-hidden="true" />
    {kind === 'sidebar' && scope && <div className="v5-drag-scope" style={rectStyle(scope)} aria-hidden="true">
      {SIDES.map(direction => <span key={direction} className="v5-edge-label" data-side={direction}>{SIDE_LABELS[direction]}</span>)}
    </div>}
    {kind !== 'resize' && preview && <div className="v5-drag-preview" style={rectStyle(preview)} aria-hidden="true">
      {label && <span>{label}</span>}
    </div>}
    {kind !== 'resize' && point && <div className="v5-drag-ghost" style={{
      left: `clamp(8px, ${point.x + 15}px, calc(100vw - 298px))`,
      top: `clamp(8px, ${point.y + 16}px, calc(100dvh - 50px))`,
    }} aria-hidden="true">
      <span>{title || (kind === 'session' ? '会话' : 'Sidebar')} <small>{label && !preview ? label : kind === 'session' ? '整体移动' : '仅限本会话'}</small></span>
    </div>}
  </>;
}

export interface ToastProps { message: string; onDismiss?(): void }

export function Toast({ message, onDismiss }: ToastProps) {
  const dismiss = useLatest(onDismiss);
  const [visible, setVisible] = React.useState(Boolean(message));
  React.useEffect(() => {
    setVisible(Boolean(message));
    if (!message) return;
    const timer = setTimeout(() => { setVisible(false); dismiss.current?.(); }, 3500);
    return () => clearTimeout(timer);
  }, [message, dismiss]);
  return visible && message ? <div className="v5-toast" role="status" aria-live="polite" aria-atomic="true">{message}</div> : null;
}
