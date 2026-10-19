/**
 * BOOP client styles — scoped to BOOP-owned surfaces only.
 *
 * Frozen visual rules (04§02, 05, handoff 04):
 *  - ordinary DSH UI keeps its native appearance; brand styling is limited to
 *    the BOOP namespace (`.boop-*` / `[data-boop*]` attributes);
 *  - theme follows the APP's own signal (`body[data-ds-dark-theme]`), never the
 *    OS media query;
 *  - brand tokens come from the frozen boop-brand-tokens.json; no KV image is
 *    used in daily UI (production assets are D01-01);
 *  - reduced-motion applies to BOOP's own transitions only.
 */
import { COMPANION_CSS } from './companion.tsx'
import { COMPANION_3D_CSS } from './companion3d.tsx'

const PANEL_CSS = `
[data-boop-panel] {
  --boop-blue: #449BCC;
  --boop-deep: #073F5C;
  --boop-ink: #0B2637;
  --boop-interactive: #17648B;
  --boop-soft: #EAF5FB;
  --boop-line: rgba(11, 38, 55, 0.12);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px;
  gap: 14px;
  color: var(--boop-ink);
  font: inherit;
}
body[data-ds-dark-theme] [data-boop-panel] {
  --boop-ink: #EAF5FB;
  --boop-soft: rgba(68, 155, 204, 0.14);
  --boop-line: rgba(234, 245, 251, 0.18);
}

/* ── hero: the companion leads, identity text follows ── */
[data-boop-panel] .boop-hero {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 8px 4px 4px;
}
[data-boop-panel] .boop-hero-text h1 {
  font-size: 19px;
  font-weight: 650;
  letter-spacing: 0.01em;
  margin: 0 0 4px;
  color: var(--boop-ink);
}
[data-boop-panel] .boop-hero-text p {
  margin: 0 0 10px;
  font-size: 13px;
  opacity: 0.72;
}
[data-boop-panel] .boop-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[data-boop-panel] .boop-chip {
  font-size: 11.5px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--boop-line);
  color: var(--boop-ink);
  opacity: 0.85;
  white-space: nowrap;
}
[data-boop-panel] .boop-chip.ok {
  border-color: rgba(43, 122, 75, 0.4);
  color: #2B7A4B;
}
[data-boop-panel] .boop-chip.warn {
  border-color: rgba(176, 116, 36, 0.4);
  color: #B07424;
}
body[data-ds-dark-theme] [data-boop-panel] .boop-chip.ok { color: #7CC497; }
body[data-ds-dark-theme] [data-boop-panel] .boop-chip.warn { color: #D9A45B; }

/* ── cards ── */
[data-boop-panel] .boop-card {
  border: 1px solid var(--boop-line);
  border-radius: 16px;
  padding: 14px 16px;
  background: var(--boop-soft);
  max-width: 720px;
}
[data-boop-panel] .boop-card h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; opacity: 0.72; }
[data-boop-panel] .boop-row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; padding: 2px 0; }
[data-boop-panel] .boop-row > span:first-child { min-width: 132px; opacity: 0.66; }
[data-boop-panel] .boop-muted { font-size: 12px; opacity: 0.7; line-height: 1.6; margin: 8px 0 0; }

/* ── gates / capabilities ── */
[data-boop-panel] .boop-gates { display: flex; flex-wrap: wrap; gap: 6px; }
[data-boop-panel] .boop-gate {
  font-size: 11.5px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--boop-line);
  opacity: 0.78;
  white-space: nowrap;
}
[data-boop-panel] .boop-gate.ok { border-color: rgba(43, 122, 75, 0.4); color: #2B7A4B; opacity: 1; }
[data-boop-panel] .boop-gate.bad { border-color: rgba(178, 62, 62, 0.45); color: #B23E3E; opacity: 1; }
body[data-ds-dark-theme] [data-boop-panel] .boop-gate.ok { color: #7CC497; }
body[data-ds-dark-theme] [data-boop-panel] .boop-gate.bad { color: #E28B8B; }

@media (prefers-reduced-motion: reduce) {
  [data-boop-panel] * { transition: none !important; }
}
`

export const BOOP_CSS = PANEL_CSS + COMPANION_CSS + COMPANION_3D_CSS
