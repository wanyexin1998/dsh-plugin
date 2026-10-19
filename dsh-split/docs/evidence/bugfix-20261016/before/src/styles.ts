/**
 * Plugin-owned styles. Only the workbench surface is styled: the shipped conversation,
 * Sidebar and composer keep their own appearance (the frozen plan's F04/F05/F06/F07/F08
 * rules and V01/V02/V03, aligned token-by-token with the frozen prototype
 * dsh-split-interactive-demo.html and final-plan §02/§03 — see docs/alignment-review.md).
 *
 * Frozen tokens used here (demo :root / body.dark, `.session`, `.session-head`,
 * `.session-body`, `.sidebar-panel`):
 *  - one shared radius token, initial 12px (F04)
 *  - non-focused veil: rgba(140,148,157,.075) light / rgba(162,170,180,.045) dark (F05)
 *  - session head height 45px, grip→letter→title order, weight 500 in primary ink
 *  - interior gutter `margin: 0 12px 13px` + 12px seam between body and Sidebar (F06)
 *  - Sidebar only: thin border + static light shadow (light
 *    `0 1px 2px rgba(24,28,21,.035), 0 4px 12px -4px rgba(24,28,21,.065)`, dark
 *    `0 1px 2px rgba(0,0,0,.12), 0 4px 12px -4px rgba(0,0,0,.20)`) (F08/V03)
 *
 * Theme switching follows the APP's own signal (`body[data-ds-dark-theme]`, driven by the
 * in-app Appearance preference), never the OS `prefers-color-scheme` media query.
 */
export const WORKBENCH_CSS = `
[data-dsh-split-workbench] {
  --dsh-split-radius: 12px;
  --dsh-split-veil: rgba(140, 148, 157, 0.075);
  --dsh-split-sidebar-shadow: 0 1px 2px rgba(24, 28, 21, 0.035), 0 4px 12px -4px rgba(24, 28, 21, 0.065);
  position: absolute;
  inset: 0;
  min-width: 0;
  min-height: 0;
}
body[data-ds-dark-theme] [data-dsh-split-workbench] {
  --dsh-split-veil: rgba(162, 170, 180, 0.045);
  --dsh-split-sidebar-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 4px 12px -4px rgba(0, 0, 0, 0.20);
}

/* F02: no tab strip in any pane (the first panel's group is also header-hidden via the
   engine; this is the belt-and-braces rule). */
[data-dsh-split-workbench] .dv-tabs-and-actions-container { display: none; }

/* One session shell: shared radius token, no border, no shadow, no card (F04). */
[data-dsh-split-surface] {
  position: relative;
  isolation: isolate;
  border-radius: var(--dsh-split-radius);
  background: var(--dsw-alias-bg-base);
  overflow: hidden;
}
/* F05: faint gray film on the non-focused session only; separate pointer-events:none
   pseudo-element, no opacity/filter/inert on the root, first click not blocked. */
[data-dsh-split-surface]::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 20;
  border-radius: var(--dsh-split-radius);
  background: var(--dsh-split-veil);
  opacity: 0;
  pointer-events: none;
  transition: opacity 100ms ease-out;
}
[data-dsh-split-surface][data-dsh-split-focused='false']::after { opacity: 1; }

/* Session head: frozen 45px; grip → letter → title inside .dsh-split-title. */
[data-dsh-split-titlebar] {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 45px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  flex: 0 0 auto;
}
.dsh-split-title {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
}
.dsh-split-title:hover [data-dsh-split-grip] { opacity: 1; }
[data-dsh-split-grip] { flex: 0 0 auto; opacity: 0.45; display: flex; align-items: center; }
[data-dsh-split-letter] {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 21px;
  height: 21px;
  border: 0;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1;
}
[data-dsh-split-surface][data-dsh-split-focused='true'] [data-dsh-split-letter] { color: var(--dsw-alias-label-primary); }
@media (max-width: 800px) {
  [data-dsh-split-grip] { display: none; }
}
[data-dsh-split-title-text] {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-split-titlebar] button.dsh-split-icon {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  height: 28px;
  min-width: 28px;
  padding: 0 6px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
[data-dsh-split-titlebar] button.dsh-split-icon:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Body: frozen 12px inset (right/bottom/left) and a 12px seam to the Sidebar (F06). */
[data-dsh-split-body] {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  margin: 0 12px 13px;
  gap: 12px;
}
[data-dsh-split-body] > :first-child { flex: 1 1 auto; min-width: 0; min-height: 0; }

/* Per-session native Sidebar host. The patched ui-sidebar-right portals the session's
   Sidebar into this element; the host is a REAL box (positioned, fixed 320px width) so the
   portaled panel resolves against it, clientWidth measures it correctly (W014 step 4), and
   F08/V03's border/shadow/radius paint on it. */
[data-dsh-sidebar-host] {
  position: relative;
  flex: 0 0 320px;
  width: 320px;
  max-width: 45%;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsh-split-radius);
  box-shadow: var(--dsh-split-sidebar-shadow);
  overflow: hidden;
  min-width: 0;
}
/* F07: the session title bar entry collapses/re-expands the Sidebar without unmounting
   it (F13: hiding is not closing resources). */
[data-dsh-sidebar-host][data-dsh-sidebar-collapsed='true'] { display: none; }

.dsh-split-empty { display: grid; place-items: center; font-size: 12px; opacity: 0.7; padding: 16px; }
.dsh-split-engine-error { position: absolute; inset: 12px; display: grid; place-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* Reduced motion applies to the plugin's own veil transition only — never to the shipped
   conversation subtree (its caret pulse/spinners keep their own rules). */
@media (prefers-reduced-motion: reduce) {
  [data-dsh-split-surface]::after { transition: none !important; }
}
`
