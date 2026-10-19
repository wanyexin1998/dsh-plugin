/**
 * BOOP taskboard styles (E04-02 client half) — scoped, theme-aware, FE-12 safe.
 *
 * Visual language is BOOP's own (05); only content density / card structure are
 * informed by the selectively extracted dashi-taskboard components
 * (`chuspeeism/dashi-taskboard@723c400e…`, Apache-2.0). No upstream stylesheet,
 * body reset, Codex brand class or portal rule is copied: every selector below
 * is rooted at the BOOP-owned `[data-boop-taskboard]` attribute, so nothing in
 * the ordinary DSH UI is restyled (TB08/FE-12).
 *
 * The sheet is injected by `TaskboardPanel` under `data-plugin-css="boop/taskboard"`
 * and removed on unmount, so disabling the plugin removes all of it.
 */

export const TASKBOARD_STYLE_TAG = 'boop/taskboard'

const TASKBOARD_TOKENS = `
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

const TASKBOARD_DARK_TOKENS = `
  --boop-ink: #EAF5FB;
  --boop-soft: rgba(68, 155, 204, 0.14);
  --boop-line: rgba(234, 245, 251, 0.18);
  --boop-ok: #7CC497;
  --boop-warn: #D9A45B;
  --boop-bad: #E28B8B;
`

export const BOOP_TASKBOARD_CSS = `
/* ── token roots: only BOOP-owned taskboard surfaces (never html/body) ── */
[data-boop-taskboard] {
${TASKBOARD_TOKENS}
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  color: var(--boop-ink);
  font: inherit;
}
body[data-ds-dark-theme] [data-boop-taskboard] {
${TASKBOARD_DARK_TOKENS}
}
[data-boop-taskboard] [data-boop-taskboard-toolbar] {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[data-boop-taskboard] [data-boop-taskboard-toolbar] label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: inherit;
}
[data-boop-taskboard] [data-boop-taskboard-toolbar] input[type="search"],
[data-boop-taskboard] [data-boop-taskboard-toolbar] select {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  padding: 3px 6px;
}
[data-boop-taskboard] [data-boop-taskboard-toolbar] input[type="search"] {
  min-width: 140px;
}
[data-boop-taskboard] [data-boop-taskboard-toolbar] input[type="search"]:focus-visible,
[data-boop-taskboard] [data-boop-taskboard-toolbar] select:focus-visible,
[data-boop-taskboard] button:focus-visible,
[data-boop-taskboard] [tabindex]:focus-visible {
  outline: 2px solid var(--boop-interactive);
  outline-offset: 1px;
}
[data-boop-taskboard] [data-boop-taskboard-view-switch] {
  display: inline-flex;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  overflow: hidden;
}
[data-boop-taskboard] [data-boop-taskboard-view-switch] button {
  font: inherit;
  font-size: 12px;
  border: 0;
  padding: 4px 10px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-taskboard-view-switch] button[aria-pressed="true"] {
  background: var(--boop-soft);
  color: var(--boop-interactive);
  font-weight: 600;
}
[data-boop-taskboard] [data-boop-taskboard-action] {
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  padding: 3px 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-taskboard-action]:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
[data-boop-taskboard] [data-boop-taskboard-note] {
  font-size: 12px;
  line-height: 1.5;
  opacity: 0.78;
}
[data-boop-taskboard] [data-boop-taskboard-alert] {
  border: 1px solid var(--boop-bad);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
}
[data-boop-taskboard] [data-boop-taskboard-alert] button {
  margin-top: 6px;
}

/* ── board layout: four derived groups ── */
[data-boop-taskboard] [data-boop-taskboard-board] {
  display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: 10px;
  min-height: 0;
  align-items: start;
  overflow-x: auto;
}
[data-boop-taskboard] [data-boop-column] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 8px;
}
[data-boop-taskboard] [data-boop-column] [data-boop-column-header] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: start;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-column] [data-boop-column-count] {
  font-size: 11px;
  font-weight: 500;
  opacity: 0.75;
}
[data-boop-taskboard] [data-boop-column-body] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
[data-boop-taskboard] [data-boop-column-empty] {
  font-size: 12px;
  opacity: 0.66;
  padding: 4px 2px;
}
[data-boop-taskboard] [data-boop-task-card] {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 8px;
  background: transparent;
  min-width: 0;
  transition: border-color 120ms ease;
}
[data-boop-taskboard] [data-boop-task-card]:hover {
  border-color: var(--boop-interactive);
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-title] {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
[data-boop-taskboard] [data-boop-task-card][data-boop-expanded="true"] [data-boop-task-title] {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-status] {
  font-size: 11px;
  line-height: 1.4;
  opacity: 0.9;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-status][data-tone="ok"] { color: var(--boop-ok); }
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-status][data-tone="warn"] { color: var(--boop-warn); }
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-status][data-tone="bad"] { color: var(--boop-bad); }
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-status][data-tone="muted"] { opacity: 0.7; }
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-pending] {
  font-size: 11px;
  line-height: 1.4;
  color: var(--boop-warn);
  overflow-wrap: anywhere;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-meta] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11px;
  opacity: 0.72;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-actions] {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-open] {
  font: inherit;
  font-size: 12px;
  border: 1px solid var(--boop-line);
  border-radius: 6px;
  padding: 3px 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-write] {
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-write][data-state="pending"] { color: var(--boop-warn); }
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-write][data-state="rejected"],
[data-boop-taskboard] [data-boop-task-card] [data-boop-task-write][data-state="error"] { color: var(--boop-bad); }

/* ── list view: shares the SAME view model, never a second task state ── */
[data-boop-taskboard] [data-boop-taskboard-list] {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[data-boop-taskboard] [data-boop-list-group] {
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 6px 8px;
}
[data-boop-taskboard] [data-boop-list-group-header] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  text-align: start;
  color: inherit;
  background: transparent;
  border: 0;
  padding: 2px 0;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-list-row] {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-top: 1px solid var(--boop-line);
  font-size: 12px;
  cursor: pointer;
}
[data-boop-taskboard] [data-boop-list-row]:first-of-type {
  border-top: 0;
}
[data-boop-taskboard] [data-boop-list-row]:hover {
  background: var(--boop-soft);
}
[data-boop-taskboard] [data-boop-list-title] {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-boop-taskboard] [data-boop-list-meta] {
  flex: 0 0 auto;
  font-size: 11px;
  opacity: 0.72;
}
[data-boop-taskboard] [data-boop-list-empty] {
  font-size: 12px;
  opacity: 0.66;
  padding: 4px 2px;
}

/* ── detail drawer: in-panel, never a fixed overlay over host window chrome ── */
[data-boop-taskboard] [data-boop-taskboard-drawer] {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 0;
  width: min(420px, 100%);
  max-height: 100%;
  overflow: auto;
  box-sizing: border-box;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  padding: 10px;
  background: var(--boop-soft);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] h3 {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] h4 {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 600;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] p,
[data-boop-taskboard] [data-boop-taskboard-drawer] li {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] ul {
  margin: 0;
  padding-inline-start: 16px;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] [data-boop-detail-row] {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] [data-boop-detail-row] > span:first-child {
  flex: 0 0 auto;
  opacity: 0.72;
}
[data-boop-taskboard] [data-boop-taskboard-drawer] [data-boop-detail-row] > span:last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  [data-boop-taskboard] [data-boop-taskboard-board] {
    grid-template-columns: repeat(2, minmax(160px, 1fr));
  }
}
@media (max-width: 560px) {
  [data-boop-taskboard] [data-boop-taskboard-board] {
    grid-template-columns: minmax(160px, 1fr);
  }
}

/* reduced motion disables BOOP's own transitions only (FE-09) */
@media (prefers-reduced-motion: reduce) {
  [data-boop-taskboard] [data-boop-task-card],
  [data-boop-taskboard] button,
  [data-boop-taskboard] [data-boop-list-row] {
    transition: none !important;
    animation: none !important;
  }
}
`

/**
 * Inject the scoped sheet once per mounted taskboard panel and return the
 * disposer; the plugin/panel unmount removes the entire sheet (FE-12).
 */
export function installTaskboardStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): () => void {
  if (!doc) return () => undefined
  const style = doc.createElement('style')
  style.setAttribute('data-plugin-css', TASKBOARD_STYLE_TAG)
  style.textContent = BOOP_TASKBOARD_CSS
  doc.head.appendChild(style)
  return () => {
    style.remove()
  }
}
