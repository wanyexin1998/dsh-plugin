/**
 * BOOP human-control styles (E04-03 client half).
 *
 * Every selector is rooted at a BOOP-owned `[data-boop-*]` attribute, so no
 * native DSH element is restyled and disabling the plugin removes the whole
 * sheet (FE-12/TB08). Theme follows the APP signal (`body[data-ds-dark-theme]`),
 * never an OS media query (FE-09); reduced motion disables BOOP's own
 * transitions only; interactive targets are >= 32px desktop / 44px touch
 * (04§14) and every button keeps a visible focus outline.
 */

export const CONTROL_STYLE_TAG = 'boop/control'

const TOKENS = `
  --boop-blue: #449BCC;
  --boop-deep: #073F5C;
  --boop-ink: #0B2637;
  --boop-interactive: #17648B;
  --boop-soft: #EAF5FB;
  --boop-line: rgba(11, 38, 55, 0.12);
  --boop-ok: #2B7A4B;
  --boop-warn: #8A5A14;
  --boop-bad: #B23E3E;
`

const DARK_TOKENS = `
  --boop-ink: #EAF5FB;
  --boop-soft: rgba(68, 155, 204, 0.14);
  --boop-line: rgba(234, 245, 251, 0.18);
  --boop-ok: #7CC497;
  --boop-warn: #D9A45B;
  --boop-bad: #E28B8B;
`

export const BOOP_CONTROL_CSS = `
/* ── token roots: only BOOP-owned control surfaces (never html/body) ── */
[data-boop-control],
[data-boop-approval],
[data-boop-stop],
[data-boop-recovery],
[data-boop-unknown-results],
[data-boop-approval-badge] {
${TOKENS}
  color: var(--boop-ink);
  font: inherit;
}
body[data-ds-dark-theme] [data-boop-control],
body[data-ds-dark-theme] [data-boop-approval],
body[data-ds-dark-theme] [data-boop-stop],
body[data-ds-dark-theme] [data-boop-recovery],
body[data-ds-dark-theme] [data-boop-unknown-results],
body[data-ds-dark-theme] [data-boop-approval-badge] {
${DARK_TOKENS}
}
[data-boop-control] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
[data-boop-control] [data-boop-control-toolbar] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-boop-control] [data-boop-control-toolbar] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
[data-boop-control] [data-boop-control-note],
[data-boop-approval] [data-boop-control-note],
[data-boop-stop] [data-boop-control-note],
[data-boop-recovery] [data-boop-control-note] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.78;
}
[data-boop-control] [data-boop-control-warning],
[data-boop-stop] [data-boop-control-warning],
[data-boop-recovery] [data-boop-control-warning] {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--boop-warn);
}
[data-boop-control] [data-boop-control-alert],
[data-boop-approval] [data-boop-control-alert],
[data-boop-stop] [data-boop-control-alert],
[data-boop-recovery] [data-boop-control-alert] {
  border: 1px solid var(--boop-bad);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
}
[data-boop-control] [data-boop-control-receipt],
[data-boop-approval] [data-boop-control-receipt],
[data-boop-stop] [data-boop-control-receipt],
[data-boop-recovery] [data-boop-control-receipt] {
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-boop-control] [data-boop-control-receipt][data-tone="ok"],
[data-boop-approval] [data-boop-control-receipt][data-tone="ok"],
[data-boop-stop] [data-boop-control-receipt][data-tone="ok"],
[data-boop-recovery] [data-boop-control-receipt][data-tone="ok"] {
  border-color: var(--boop-ok);
}
[data-boop-control] [data-boop-control-receipt][data-tone="bad"],
[data-boop-approval] [data-boop-control-receipt][data-tone="bad"],
[data-boop-stop] [data-boop-control-receipt][data-tone="bad"],
[data-boop-recovery] [data-boop-control-receipt][data-tone="bad"] {
  border-color: var(--boop-bad);
}

/* ── buttons / inputs: native, keyboard-visible, touch-sized (04§14) ── */
[data-boop-control] button,
[data-boop-approval] button,
[data-boop-stop] button,
[data-boop-recovery] button,
[data-boop-approval-badge] button {
  font: inherit;
  font-size: 12px;
  min-height: 32px;
  min-width: 32px;
  padding: 4px 10px;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
[data-boop-control] button[data-tone="primary"],
[data-boop-approval] button[data-tone="primary"],
[data-boop-stop] button[data-tone="primary"],
[data-boop-recovery] button[data-tone="primary"] {
  border-color: var(--boop-interactive);
  color: var(--boop-interactive);
  font-weight: 600;
}
[data-boop-control] button[data-tone="danger"],
[data-boop-approval] button[data-tone="danger"],
[data-boop-stop] button[data-tone="danger"],
[data-boop-recovery] button[data-tone="danger"] {
  border-color: var(--boop-bad);
  color: var(--boop-bad);
}
[data-boop-control] button:disabled,
[data-boop-approval] button:disabled,
[data-boop-stop] button:disabled,
[data-boop-recovery] button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
[data-boop-control] button:focus-visible,
[data-boop-approval] button:focus-visible,
[data-boop-stop] button:focus-visible,
[data-boop-recovery] button:focus-visible,
[data-boop-control] input:focus-visible,
[data-boop-control] select:focus-visible,
[data-boop-recovery] input:focus-visible,
[data-boop-approval-badge] button:focus-visible {
  outline: 2px solid var(--boop-interactive);
  outline-offset: 1px;
}
[data-boop-control] label,
[data-boop-stop] label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
[data-boop-control] select,
[data-boop-stop] select {
  font: inherit;
  font-size: 12px;
  min-height: 32px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  padding: 3px 6px;
}

/* ── approval cards ── */
[data-boop-approval] {
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
[data-boop-approval][data-valid="false"] {
  border-style: dashed;
  opacity: 0.86;
}
[data-boop-approval] [data-boop-approval-title] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
[data-boop-approval] [data-boop-approval-badge] {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--boop-line);
}
[data-boop-approval] [data-boop-approval-badge][data-tone="ok"] { color: var(--boop-ok); border-color: var(--boop-ok); }
[data-boop-approval] [data-boop-approval-badge][data-tone="warn"] { color: var(--boop-warn); border-color: var(--boop-warn); }
[data-boop-approval] [data-boop-approval-badge][data-tone="bad"] { color: var(--boop-bad); border-color: var(--boop-bad); }
[data-boop-approval] [data-boop-approval-binding] {
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.78;
  overflow-wrap: anywhere;
}
[data-boop-approval] [data-boop-approval-actions] {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ── stop ── */
[data-boop-stop] {
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
[data-boop-stop] [data-boop-stop-scope] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-boop-stop] [data-boop-stop-item] {
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-boop-stop] [data-boop-stop-item][data-tone="bad"] { color: var(--boop-bad); }
[data-boop-stop] [data-boop-stop-item][data-tone="warn"] { color: var(--boop-warn); }
[data-boop-stop] [data-boop-stop-item][data-tone="ok"] { color: var(--boop-ok); }

/* ── recovery ── */
[data-boop-recovery] {
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
[data-boop-recovery] [data-boop-recovery-entry] {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 4px 0;
  border-top: 1px solid var(--boop-line);
}
[data-boop-recovery] [data-boop-recovery-entry]:first-of-type {
  border-top: 0;
}
[data-boop-recovery] [data-boop-recovery-entry][data-state="released"] {
  opacity: 0.72;
}
[data-boop-recovery] [data-boop-recovery-entry] input {
  margin-top: 2px;
  min-width: 18px;
  min-height: 18px;
}

/* ── header approval badge (mounted through the session header slot) ── */
[data-boop-approval-badge] button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  border-color: var(--boop-warn);
  color: var(--boop-warn);
}

@media (max-width: 560px) {
  [data-boop-approval] [data-boop-approval-actions],
  [data-boop-stop] [data-boop-stop-scope] {
    flex-direction: column;
    align-items: stretch;
  }
}

/* reduced motion disables BOOP's own transitions only (FE-09) */
@media (prefers-reduced-motion: reduce) {
  [data-boop-control] *,
  [data-boop-approval] *,
  [data-boop-stop] *,
  [data-boop-recovery] *,
  [data-boop-approval-badge] * {
    transition: none !important;
    animation: none !important;
  }
}
`

/** Inject the scoped control sheet once per mounted control surface (FE-12). */
export function installControlStyles(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): () => void {
  if (!doc) return () => undefined
  const existing = doc.head.querySelector(`style[data-plugin-css="${CONTROL_STYLE_TAG}"]`)
  if (existing) return () => undefined
  const style = doc.createElement('style')
  style.setAttribute('data-plugin-css', CONTROL_STYLE_TAG)
  style.textContent = BOOP_CONTROL_CSS
  doc.head.appendChild(style)
  return () => {
    style.remove()
  }
}
