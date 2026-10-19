/**
 * The BOOP 3D companion (E04-01): real WebGL2 character, real states.
 *
 * Uses the project's own `boop-assistant.js` player (bundled at build time, no
 * third-party runtime) with the real `boop.glb` served by the host asset route.
 *
 * Frozen rules honoured here:
 *  - one live instance per window: the player is created once per mount and
 *    disposed on unmount (no WebGL context per message);
 *  - the animation state is an OUTPUT. Business state is the input; the player
 *    never writes anything back (`player.setState` is one-way);
 *  - WebGL2/precision failure → the transparent PNG for that state is shown
 *    instead, and the UI says the visual is a still (never pretend animation);
 *  - `prefers-reduced-motion` is forwarded to the player (poses, no loop);
 *  - leaving the viewport pauses drawing instead of burning the GPU.
 */

import React from 'react'
import { BoopAssistant } from '../../assets/3d/boop-assistant.js'

export type Companion3DState = 'idle' | 'listen' | 'think' | 'success' | 'error'

export interface Companion3DProps {
  state: Companion3DState
  /** One honest status line; identical wording rules as the 2D companion. */
  line?: string
  /** Square canvas edge in CSS pixels. */
  size?: number
  /** Hide state accessories (question mark, sweat drop) at small sizes. */
  accessories?: boolean
  onUnavailable?: (reason: string) => void
}

const STATE_IMAGE: Record<Companion3DState, string> = {
  idle: '/api/boop/state-idle.png',
  listen: '/api/boop/state-listen.png',
  think: '/api/boop/state-think.png',
  success: '/api/boop/state-success.png',
  error: '/api/boop/state-error.png',
}

const MODEL_URL = '/api/boop/model.glb'

export function BoopCompanion3D({
  state,
  line,
  size = 148,
  accessories = false,
  onUnavailable,
}: Companion3DProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const playerRef = React.useRef<BoopAssistant | null>(null)
  const stateRef = React.useRef<Companion3DState>(state)
  const [fallback, setFallback] = React.useState<string | null>(null)
  const [ready, setReady] = React.useState(false)
  stateRef.current = state

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let player: BoopAssistant | null = null

    const reduced =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false

    try {
      player = new BoopAssistant(canvas, {
        fps: 30,
        pixelRatio: Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1),
        reducedMotion: reduced,
        onError(error: Error) {
          if (disposed) return
          // Degrade to the still PNG for the SAME state; never keep pretending.
          setFallback(error?.message ? `仍然图：${error.message}` : '仍然图')
          onUnavailable?.(error?.message ?? 'webgl unavailable')
        },
      })
      player.setAccessories(accessories)
      playerRef.current = player
      player
        .load(MODEL_URL)
        .then(() => {
          if (disposed) return
          setReady(true)
          setFallback(null)
          player?.setState(stateRef.current)
        })
        .catch((error: Error) => {
          if (disposed || error?.name === 'AbortError') return
          setFallback('仍然图')
          onUnavailable?.(error?.message ?? 'model load failed')
        })
    } catch (error) {
      setFallback('仍然图')
      onUnavailable?.(error instanceof Error ? error.message : String(error))
    }

    return () => {
      disposed = true
      playerRef.current = null
      try {
        player?.dispose()
      } catch {
        /* disposal must never break the panel */
      }
    }
  }, [accessories, onUnavailable])

  // The business state drives the animation, never the other way round.
  React.useEffect(() => {
    const player = playerRef.current
    if (!player || !ready) return
    player.setState(state)
  }, [state, ready])

  // Pause drawing when the panel scrolls out of view.
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const node = wrapRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        try {
          playerRef.current?.setActive(visible)
        } catch {
          /* keep the panel alive even if the player refuses */
        }
      },
      { threshold: 0.05 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // Reduced-motion changes at runtime (the app's own setting).
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => {
      try {
        playerRef.current?.setReducedMotion(query.matches)
      } catch {
        /* ignore */
      }
    }
    query.addEventListener?.('change', apply)
    return () => query.removeEventListener?.('change', apply)
  }, [])

  return (
    <div ref={wrapRef} data-boop-3d="" data-boop-state={state}>
      <div className="boop-3d-stage" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          aria-hidden="true"
          style={{ width: size, height: size, display: fallback ? 'none' : 'block' }}
        />
        {fallback && (
          <img
            src={STATE_IMAGE[state]}
            alt=""
            aria-hidden="true"
            width={size}
            height={size}
            data-boop-3d-fallback=""
            title={fallback}
          />
        )}
      </div>
      {line !== undefined && (
        <div className="boop-3d-line" data-testid="boop-3d-line">
          {line}
        </div>
      )}
    </div>
  )
}

/** Scoped styles for the 3D stage. */
export const COMPANION_3D_CSS = `
[data-boop-3d] {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
[data-boop-3d] .boop-3d-stage {
  position: relative;
  display: grid;
  place-items: center;
  /* the contact shadow is CSS decoration, never part of the model */
  background: radial-gradient(60% 42% at 50% 88%, rgba(7, 63, 92, 0.16), transparent 70%);
  border-radius: 50%;
}
[data-boop-3d] canvas {
  display: block;
  touch-action: none;
}
[data-boop-3d] img[data-boop-3d-fallback] {
  display: block;
  object-fit: contain;
}
[data-boop-3d] .boop-3d-line {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--boop-ink, #0B2637);
  background: var(--boop-soft, #EAF5FB);
  border: 1px solid var(--boop-line, rgba(11, 38, 55, 0.12));
  border-radius: 12px;
  padding: 8px 12px;
  max-width: 260px;
  text-align: center;
}
[data-boop-3d][data-boop-state='error'] .boop-3d-line { border-color: #B07424; }
@media (prefers-reduced-motion: reduce) {
  [data-boop-3d] * { transition: none !important; }
}
`