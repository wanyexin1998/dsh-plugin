/**
 * BOOP companion — the interactive whale the user talks with.
 *
 * Design rules from the frozen visual sheet (05) and frontend book (04§12):
 *  - short round blue body, cream belly, two dark capsule eyes, short fins,
 *    upturned tail, one water drop; NO mouth or nose — emotion lives in eyes,
 *    posture, and micro-motion;
 *  - every state maps to REAL evidence from the host: thinking requires real
 *    model activity, attention requires a real pending decision; offline is
 *    dimmed and static, never crying or flickering;
 *  - reduced-motion disables all motion, the character stays informative;
 *  - brand tokens from boop-brand-tokens.json; no KV image inside daily UI.
 *
 * States: idle | listening | thinking | working | attention | delivered | offline
 */

import React from 'react'

export type CompanionState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'working'
  | 'attention'
  | 'delivered'
  | 'offline'

export interface CompanionProps {
  state: CompanionState
  /** One line of honest status text; never an invented cheer. */
  line?: string
  compact?: boolean
  onClick?: () => void
  /** Test hook: pin the RNG so blinks are deterministic in screenshots. */
  blinkSeed?: number
}

const STATE_LINE: Record<CompanionState, string> = {
  idle: '我在这儿。',
  listening: '在听你说。',
  thinking: '正在处理当前请求…',
  working: '正在按计划推进。',
  attention: '有一件事需要你确认。',
  delivered: '已交付，等你查看。',
  offline: '模型或宿主当前不可用，我不会假装在工作。',
}

export function BoopCompanion({ state, line, compact = false, onClick, blinkSeed }: CompanionProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [blink, setBlink] = React.useState(false)
  const [gaze, setGaze] = React.useState({ x: 0, y: 0 })
  const reduced =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

  // Blink rhythm: only in idle/listening, and never faster than ~3s.
  React.useEffect(() => {
    if (reduced || state === 'offline') return
    let timer = 0
    let active = true
    const loop = (delay: number) => {
      timer = window.setTimeout(() => {
        if (!active) return
        setBlink(true)
        timer = window.setTimeout(() => setBlink(false), 140)
        loop((blinkSeed ?? Math.random()) * 3200 + 2400)
      }, delay)
    }
    loop(1600)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [state, reduced, blinkSeed])

  // Gaze follows the pointer within the capsule eyes. Subtle by design.
  const onPointerMove = React.useCallback((event: React.PointerEvent) => {
    const root = rootRef.current
    if (!root) return
    const box = root.getBoundingClientRect()
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    const dx = Math.max(-1, Math.min(1, (event.clientX - cx) / (box.width / 2)))
    const dy = Math.max(-1, Math.min(1, (event.clientY - cy) / (box.height / 2)))
    setGaze({ x: dx * 2.4, y: dy * 1.8 })
  }, [])

  const eyesUp = state === 'thinking' ? -2.2 : 0
  const eyesDown = state === 'attention' ? 0.8 : 0
  const dimmed = state === 'offline'
  const moving = !reduced && !dimmed

  return (
    <div
      ref={rootRef}
      data-boop-companion=""
      data-boop-state={state}
      role={onClick ? 'button' : 'img'}
      aria-label={`BOOP · 波波，当前状态：${STATE_LINE[state]}`}
      tabIndex={onClick ? 0 : undefined}
      onPointerMove={onPointerMove}
      onClick={onClick}
      onKeyDown={onClick ? (event) => (event.key === 'Enter' || event.key === ' ') && onClick() : undefined}
    >
      <svg
        viewBox="0 0 240 250"
        width={compact ? 64 : 132}
        height={compact ? 67 : 138}
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="boopBody" cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#ADDDEB" />
            <stop offset="45%" stopColor="#449BCC" />
            <stop offset="100%" stopColor="#17648B" />
          </radialGradient>
          <radialGradient id="boopBelly" cx="50%" cy="35%" r="75%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#F8F7F2" />
          </radialGradient>
          <radialGradient id="boopDrop" cx="35%" cy="25%" r="80%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#ADDDEB" />
          </radialGradient>
          <filter id="boopBlur" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* ground shadow — soft contact light, never a hard oval */}
        <ellipse cx="120" cy="238" rx="70" ry="9" fill="#0B2637" opacity="0.14" filter="url(#boopBlur)" />

        {/* attention halo: a real pending decision, shown once per state, no flicker */}
        {state === 'attention' && (
          <circle cx="120" cy="128" r="86" fill="none" stroke="#17648B" strokeWidth="2" opacity="0.5" />
        )}

        <g
          className={moving ? 'boop-breathe' : undefined}
          style={{ transformOrigin: '120px 150px', opacity: dimmed ? 0.55 : 1 }}
        >
          {/* tail — upturned, clearly attached, the key silhouette */}
          <g className={moving && state === 'working' ? 'boop-tail' : undefined} style={{ transformOrigin: '42px 168px' }}>
            <path
              d="M44 150 C30 138 18 140 14 152 C26 156 30 164 34 172 C22 178 20 192 30 198 C44 190 52 178 52 162 Z"
              fill="#17648B"
            />
            <path d="M40 158 C30 152 22 152 18 158" stroke="#ADDDEB" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.65" />
          </g>

          {/* body */}
          <ellipse cx="124" cy="150" rx="86" ry="78" fill="url(#boopBody)" />
          {/* rim light, single direction */}
          <ellipse cx="96" cy="104" rx="46" ry="28" fill="#FFFFFF" opacity="0.35" filter="url(#boopBlur)" />

          {/* belly */}
          <ellipse cx="132" cy="170" rx="58" ry="50" fill="url(#boopBelly)" />
          <ellipse cx="132" cy="182" rx="44" ry="30" fill="#FFFFFF" opacity="0.5" />

          {/* fins */}
          <g className={moving && state === 'listening' ? 'boop-fin-l' : undefined} style={{ transformOrigin: '66px 176px' }}>
            <path d="M68 168 C52 170 44 182 50 194 C62 194 72 186 74 176 Z" fill="#17648B" />
          </g>
          <g className={moving && state === 'delivered' ? 'boop-fin-r' : undefined} style={{ transformOrigin: '188px 176px' }}>
            <path d="M186 168 C202 170 210 182 204 194 C192 194 182 186 180 176 Z" fill="#17648B" />
          </g>

          {/* water drop */}
          <g className={moving && state === 'thinking' ? 'boop-drop-sway' : undefined} style={{ transformOrigin: '124px 62px' }}>
            <path d="M124 30 C112 46 106 58 106 70 C106 82 114 90 124 90 C134 90 142 82 142 70 C142 58 136 46 124 30 Z" fill="url(#boopDrop)" />
            <circle cx="118" cy="64" r="4.5" fill="#FFFFFF" opacity="0.75" />
          </g>

          {/* eyes: dark capsules, gaze within, blink via scaleY */}
          <g
            style={{
              transform: `translate(${gaze.x}px, ${gaze.y + eyesUp + eyesDown}px)`,
              transformOrigin: '132px 138px',
            }}
          >
            <g style={{ transform: blink ? 'scaleY(0.12)' : 'scaleY(1)', transformOrigin: '112px 138px', transition: 'transform 90ms ease' }}>
              <rect x="100" y="120" width="20" height="36" rx="10" fill="#0B2637" />
              <circle cx="107" cy="130" r="3.4" fill="#FFFFFF" opacity="0.85" />
            </g>
            <g style={{ transform: blink ? 'scaleY(0.12)' : 'scaleY(1)', transformOrigin: '148px 138px', transition: 'transform 90ms ease' }}>
              <rect x="136" y="120" width="20" height="36" rx="10" fill="#0B2637" />
              <circle cx="143" cy="130" r="3.4" fill="#FFFFFF" opacity="0.85" />
            </g>
          </g>
        </g>
      </svg>

      {line !== undefined || !compact ? (
        <div className="boop-speech" data-testid="boop-speech">
          {line ?? STATE_LINE[state]}
        </div>
      ) : null}
    </div>
  )
}

/** Companion CSS — scoped, reduced-motion aware, removed with the plugin. */
export const COMPANION_CSS = `
[data-boop-companion] {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  cursor: default;
  user-select: none;
}
[data-boop-companion][role='button'] { cursor: pointer; }
[data-boop-companion] svg { display: block; }
[data-boop-companion] .boop-speech {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--boop-ink, #0B2637);
  background: var(--boop-soft, #EAF5FB);
  border: 1px solid var(--boop-line, rgba(11,38,55,0.12));
  border-radius: 12px;
  padding: 8px 12px;
  max-width: 260px;
  text-align: center;
}
[data-boop-companion][data-boop-state='attention'] .boop-speech {
  border-color: #17648B;
}
[data-boop-companion][data-boop-state='offline'] .boop-speech {
  opacity: 0.85;
}

/* Motion: gentle, evidence-driven. All of it off under reduced motion. */
@keyframes boopBreathe {
  0%, 100% { transform: translateY(0) scale(1); }
  50% { transform: translateY(-3px) scale(1.012); }
}
@keyframes boopTail {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(6deg); }
}
@keyframes boopFinL {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(-7deg); }
}
@keyframes boopFinR {
  0%, 100% { transform: rotate(0deg); }
  50% { transform: rotate(7deg); }
}
@keyframes boopDropSway {
  0%, 100% { transform: rotate(-3deg); }
  50% { transform: rotate(3deg); }
}
.boop-breathe { animation: boopBreathe 4.2s ease-in-out infinite; }
.boop-tail { animation: boopTail 1.8s ease-in-out infinite; }
.boop-fin-l { animation: boopFinL 2.6s ease-in-out infinite; }
.boop-fin-r { animation: boopFinR 1.2s ease-in-out infinite; }
.boop-drop-sway { animation: boopDropSway 2.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  [data-boop-companion] * { animation: none !important; transition: none !important; }
}
`
