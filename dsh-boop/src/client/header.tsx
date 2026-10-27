/**
 * BOOP fixed entry, board icon and main-Session identity header (E04-01 batch 2).
 *
 * Slots used (all additive; verified against the rc.2.1 Slot catalog):
 *  - `sidebar.footer.action` (root, list)   — the fixed BOOP entry; it is a
 *    navigation action only, never a second sidebar;
 *  - `sidebar.panellist` (root, list)       — icon entry for the `boop.tasks`
 *    global panel registered in the root-scoped `main` keyed slot;
 *  - `conversation.session.header.actions` (session, list) — identity chip +
 *    task entry on the BOOP main Session ONLY; an ordinary Session renders
 *    nothing (FE-01 zero pollution).
 */
import React from 'react'
import { BoopMark } from './brand.tsx'
import { BoopApprovalBadge } from './control.tsx'
import type { ControlCall } from './control-model.ts'
import { mainSessionReasonText, mainSessionStatusLine, type MainSessionStore } from './main-session.ts'

export interface OpenOutcomeLike {
  ok: boolean
  message?: string
}

export interface BoopEntryButtonProps {
  /** Owner prop of `sidebar.footer.action`: false while the sidebar is a rail. */
  wide?: boolean
  observer?: MainSessionStore
  onOpen?: () => Promise<OpenOutcomeLike | void> | OpenOutcomeLike | void
}

export function useMainSessionState(observer: MainSessionStore | undefined): ReturnType<MainSessionStore['getSnapshot']> | null {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => (observer ? observer.subscribe(listener) : () => undefined),
      [observer],
    ),
    React.useCallback(() => observer?.getSnapshot() ?? null, [observer]),
    React.useCallback(() => null, []),
  )
}

export function BoopEntryButton({ wide, observer, onOpen }: BoopEntryButtonProps): React.ReactElement {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const state = useMainSessionState(observer)
  const status = state === null ? null : mainSessionStatusLine(state)
  const reason = state?.host?.reason ?? state?.error ?? null
  const reasonText = mainSessionReasonText(reason)

  const activate = (): void => {
    if (pending) return
    setPending(true)
    setError(null)
    void Promise.resolve()
      .then(() => onOpen?.())
      .then((outcome) => {
        setPending(false)
        if (outcome && typeof outcome === 'object' && outcome.ok === false) {
          setError(outcome.message ?? '打开主会话失败')
        }
      })
      .catch((cause: unknown) => {
        setPending(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return (
    <button
      type="button"
      data-boop-entry=""
      data-wide={wide === false ? 'false' : 'true'}
      data-pending={pending ? 'true' : 'false'}
      aria-label="打开波波"
      aria-busy={pending}
      title={error ?? reasonText ?? '打开波波'}
      onClick={activate}
    >
      <BoopMark size={wide === false ? 18 : 16} />
      {wide === false ? null : (
        <>
          <span className="boop-entry-label">BOOP · 波波</span>
          {status ? (
            <span className="boop-entry-state" data-tone={status.tone}>
              {pending ? '正在打开' : status.text}
            </span>
          ) : null}
        </>
      )}
      {error !== null ? <span className="boop-entry-state" data-tone="bad">打开失败</span> : null}
    </button>
  )
}

export interface BoopPanelIconProps {
  /** Owner props of `sidebar.panellist`: square edge and the active state. */
  size?: number
  active?: boolean
}

export function BoopPanelIcon({ size = 16, active }: BoopPanelIconProps): React.ReactElement {
  return (
    <span data-boop-mark="" data-active={active === true ? 'true' : undefined}>
      <BoopMark size={size} />
    </span>
  )
}

export interface BoopMainHeaderProps {
  /** Standard session-scoped slot prop. */
  sessionId?: string
  observer?: MainSessionStore
  /** E04-03: the same authenticated call closure every BOOP surface uses. */
  call?: ControlCall
  onOpenBoard?: () => void
}

export function BoopMainHeader({ sessionId, observer, call, onOpenBoard }: BoopMainHeaderProps): React.ReactElement | null {
  const state = useMainSessionState(observer)
  const mainSessionId = state?.mainSessionId ?? null
  if (state === null || mainSessionId === null || sessionId === undefined || sessionId !== mainSessionId) return null
  const status = mainSessionStatusLine(state)
  const reasonText = mainSessionReasonText(state.host?.reason ?? state.error ?? null)
  return (
    <div data-boop-header="" role="group" aria-label="BOOP 主聊天">
      <BoopMark size={18} />
      <span className="boop-header-name">BOOP · 波波</span>
      <span className="boop-header-status" data-tone={status.tone} title={reasonText ?? undefined}>
        {status.text}
      </span>
      {/* Additive pending-approval badge: only a real valid-pending count renders. */}
      {call ? <BoopApprovalBadge call={call} onOpenBoard={onOpenBoard} /> : null}
      {onOpenBoard ? (
        <button type="button" className="boop-header-action" onClick={onOpenBoard} aria-label="打开 BOOP 任务板">
          任务
        </button>
      ) : null}
    </div>
  )
}
