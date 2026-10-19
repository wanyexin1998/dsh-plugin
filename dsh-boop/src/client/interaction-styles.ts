/**
 * BOOP interaction styles (E04-01 batch 2).
 *
 * Scoped exactly like the panel styles (FE-12): every rule is rooted at a
 * BOOP-owned `[data-boop-*]` attribute or a `.boop-*` class inside one, so no
 * native DSH element is restyled and unload removes the whole sheet. Theme
 * follows the APP's signal (`body[data-ds-dark-theme]`), never the OS media
 * query (FE-09). Reduced motion only disables BOOP's own transitions.
 */

const BRAND_TOKENS = `
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

export const BOOP_INTERACTION_CSS = `
/* ── token roots: only BOOP-owned surfaces ── */
[data-boop-entry],
[data-boop-mark],
[data-boop-header],
[data-boop-dock],
[data-boop-source],
[data-boop-settings] {
${BRAND_TOKENS}
  color: var(--boop-ink);
  font: inherit;
}
body[data-ds-dark-theme] [data-boop-entry],
body[data-ds-dark-theme] [data-boop-mark],
body[data-ds-dark-theme] [data-boop-header],
body[data-ds-dark-theme] [data-boop-dock],
body[data-ds-dark-theme] [data-boop-source],
body[data-ds-dark-theme] [data-boop-settings] {
${DARK_TOKENS}
}

/* ── 固定 BOOP 入口（sidebar footer action） ── */
[data-boop-entry] {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--boop-ink);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: 13px;
}
[data-boop-entry]:hover { background: var(--boop-soft); border-color: var(--boop-line); }
[data-boop-entry]:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 1px; }
[data-boop-entry][data-wide="false"] { justify-content: center; padding: 5px 0; }
[data-boop-entry][data-wide="false"] .boop-entry-label,
[data-boop-entry][data-wide="false"] .boop-entry-state { display: none; }
[data-boop-entry][data-pending="true"] { cursor: progress; opacity: 0.8; }
[data-boop-entry] .boop-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-boop-entry] .boop-entry-state { margin-left: auto; font-size: 11px; opacity: 0.72; white-space: nowrap; }
[data-boop-entry] .boop-entry-state[data-tone="ok"] { color: var(--boop-ok); opacity: 1; }
[data-boop-entry] .boop-entry-state[data-tone="warn"] { color: var(--boop-warn); opacity: 1; }
[data-boop-entry] .boop-entry-state[data-tone="bad"] { color: var(--boop-bad); opacity: 1; }
[data-boop-mark] { display: inline-flex; align-items: center; justify-content: center; flex: none; }
[data-boop-mark] svg { display: block; }

/* ── 主会话头部身份（conversation.session.header.actions） ── */
[data-boop-header] {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 2px;
  color: var(--boop-ink);
  font-size: 12.5px;
  white-space: nowrap;
}
[data-boop-header] .boop-header-name { font-weight: 600; letter-spacing: 0.01em; }
[data-boop-header] .boop-header-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--boop-line);
  opacity: 0.9;
}
[data-boop-header] .boop-header-status::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.8;
}
[data-boop-header] .boop-header-status[data-tone="ok"] { color: var(--boop-ok); }
[data-boop-header] .boop-header-status[data-tone="warn"] { color: var(--boop-warn); }
[data-boop-header] .boop-header-status[data-tone="bad"] { color: var(--boop-bad); }
[data-boop-header] .boop-header-action {
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  background: transparent;
  color: var(--boop-ink);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
[data-boop-header] .boop-header-action:hover { background: var(--boop-soft); }
[data-boop-header] .boop-header-action:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 1px; }

/* ── 初始化卡（conversation.input.dock，仅 BOOP 主会话） ── */
[data-boop-dock] {
  margin: 0 auto 8px;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.98), 100%);
  border: 1px solid var(--boop-line);
  border-radius: 14px;
  background: var(--boop-soft);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.55;
}
[data-boop-dock] .boop-dock-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-weight: 600;
}
[data-boop-dock] .boop-dock-prompt { margin: 0 0 10px; opacity: 0.9; }
[data-boop-dock] .boop-dock-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[data-boop-dock] .boop-dock-choice {
  min-height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--boop-line);
  background: var(--boop-blue);
  color: #FFFFFF;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[data-boop-dock] .boop-dock-choice[data-variant="secondary"] {
  background: transparent;
  color: var(--boop-ink);
}
[data-boop-dock] .boop-dock-choice:hover { filter: brightness(1.05); }
[data-boop-dock] .boop-dock-choice:disabled { cursor: progress; opacity: 0.7; }
[data-boop-dock] .boop-dock-choice:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 2px; }
[data-boop-dock] .boop-dock-result {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--boop-line);
}
[data-boop-dock] .boop-dock-copy { margin: 0 0 8px; }
[data-boop-dock] .boop-dock-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
}
[data-boop-dock] .boop-dock-evidence li {
  border: 1px solid var(--boop-line);
  border-radius: 999px;
  padding: 3px 9px;
  opacity: 0.88;
}
[data-boop-dock] .boop-dock-reason { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: 0.78; }
[data-boop-dock] .boop-dock-error { color: var(--boop-bad); margin: 0 0 8px; }
[data-boop-dock] .boop-dock-actions { display: flex; flex-wrap: wrap; gap: 8px; }
[data-boop-dock] .boop-dock-hint { margin: 8px 0 0; font-size: 11.5px; opacity: 0.72; }

/* ── 来源卡（看板内，root-scoped main panel） ── */
[data-boop-source] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--boop-line);
  border-radius: 16px;
  background: var(--boop-soft);
  padding: 14px 16px;
  max-width: 860px;
  font-size: 13px;
}
[data-boop-source] .boop-source-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
[data-boop-source] .boop-source-head h2 { font-size: 13px; font-weight: 600; margin: 0; opacity: 0.78; }
[data-boop-source] .boop-source-refresh {
  margin-left: auto;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  background: transparent;
  color: var(--boop-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-boop-source] .boop-source-refresh:hover { background: var(--boop-soft); }
[data-boop-source] .boop-source-refresh:focus-visible,
[data-boop-source] .boop-source-open:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 1px; }
[data-boop-source] .boop-source-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
[data-boop-source] .boop-source-chip {
  border: 1px solid var(--boop-line);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11.5px;
  opacity: 0.9;
}
[data-boop-source] .boop-source-note { margin: 0; font-size: 12px; opacity: 0.8; line-height: 1.55; }
[data-boop-source] .boop-source-note[data-tone="bad"] { color: var(--boop-bad); opacity: 1; }
[data-boop-source] .boop-source-note[data-tone="warn"] { color: var(--boop-warn); opacity: 1; }
[data-boop-source] .boop-source-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
[data-boop-source] .boop-source-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--boop-line);
  border-radius: 12px;
  background: transparent;
  padding: 9px 11px;
}
[data-boop-source] .boop-source-row-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
[data-boop-source] .boop-source-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-boop-source] .boop-source-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-boop-source] .boop-source-open {
  margin-left: auto;
  flex: none;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--boop-line);
  border-radius: 8px;
  background: transparent;
  color: var(--boop-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
[data-boop-source] .boop-source-open:hover { background: var(--boop-soft); }
[data-boop-source] .boop-source-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11.5px; opacity: 0.78; }
[data-boop-source] .boop-source-coverage[data-coverage="full"] { color: var(--boop-ok); opacity: 1; }
[data-boop-source] .boop-source-coverage[data-coverage="behind"] { color: var(--boop-warn); opacity: 1; }
[data-boop-source] .boop-source-coverage[data-coverage="gap"] { color: var(--boop-bad); opacity: 1; }
[data-boop-source] .boop-source-coverage[data-coverage="excluded"] { color: var(--boop-warn); opacity: 1; }
[data-boop-source] .boop-source-coverage[data-coverage="processing"],
[data-boop-source] .boop-source-coverage[data-coverage="unseen"] { opacity: 0.86; }

/* ── 原生设置页的 BOOP 行（settings.general.item，additive） ── */
[data-boop-settings] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--boop-line);
  border-radius: 14px;
  background: var(--boop-soft);
  font-size: 13px;
  line-height: 1.55;
  max-width: 640px;
}
[data-boop-settings] .boop-settings-head { display: flex; align-items: center; gap: 8px; }
[data-boop-settings] .boop-settings-head h2 { font-size: 13.5px; font-weight: 600; margin: 0; }
[data-boop-settings] .boop-settings-status {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--boop-line);
  font-size: 11.5px;
}
[data-boop-settings] .boop-settings-status[data-tone="ok"] { color: var(--boop-ok); border-color: currentColor; }
[data-boop-settings] .boop-settings-status[data-tone="warn"] { color: var(--boop-warn); border-color: currentColor; }
[data-boop-settings] .boop-settings-status[data-tone="bad"] { color: var(--boop-bad); border-color: currentColor; }
[data-boop-settings] .boop-settings-line { margin: 0; font-size: 12.5px; opacity: 0.85; }
[data-boop-settings] .boop-settings-line[data-tone="bad"] { color: var(--boop-bad); opacity: 1; }
[data-boop-settings] .boop-settings-line[data-tone="warn"] { color: var(--boop-warn); opacity: 1; }
[data-boop-settings] .boop-settings-facts { display: flex; flex-direction: column; gap: 2px; }
[data-boop-settings] .boop-settings-row { display: flex; gap: 10px; align-items: baseline; font-size: 12.5px; padding: 1px 0; }
[data-boop-settings] .boop-settings-row > span:first-child { min-width: 104px; opacity: 0.66; }
[data-boop-settings] .boop-settings-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
[data-boop-settings] .boop-settings-action {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--boop-line);
  border-radius: 10px;
  background: transparent;
  color: var(--boop-ink);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
[data-boop-settings] .boop-settings-action:hover { background: var(--boop-soft); }
[data-boop-settings] .boop-settings-action:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 1px; }

/* ── 看板内的项目/设置小卡 ── */
[data-boop-panel] .boop-facts { display: flex; flex-direction: column; gap: 2px; }
[data-boop-panel] .boop-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
[data-boop-panel] .boop-action {
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--boop-line);
  border-radius: 10px;
  background: transparent;
  color: var(--boop-ink);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
[data-boop-panel] .boop-action[data-variant="primary"] { background: var(--boop-blue); border-color: var(--boop-blue); color: #FFFFFF; }
[data-boop-panel] .boop-action:hover { filter: brightness(1.04); }
[data-boop-panel] .boop-action:focus-visible { outline: 2px solid var(--boop-interactive); outline-offset: 2px; }
[data-boop-panel] .boop-unavailable {
  border: 1px dashed var(--boop-line);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.55;
  opacity: 0.9;
}

@media (max-width: 600px) {
  [data-boop-dock] { margin-bottom: 6px; padding: 10px 11px; }
  [data-boop-dock] .boop-dock-choices { flex-direction: column; }
  [data-boop-dock] .boop-dock-choice { width: 100%; }
  [data-boop-source] { padding: 12px; }
  [data-boop-source] .boop-source-row-top { flex-wrap: wrap; }
  [data-boop-source] .boop-source-open { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  [data-boop-entry],
  [data-boop-header] *,
  [data-boop-dock] *,
  [data-boop-source] *,
  [data-boop-settings] *,
  [data-boop-panel] .boop-action {
    transition: none !important;
    animation: none !important;
  }
}
`
