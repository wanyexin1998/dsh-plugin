/**
 * BOOP home styles. Every rule is scoped to [data-boop-home].
 * Dark colors follow the host theme signal. Nothing here restyles body,
 * html, or ordinary DSH sessions.
 *
 * Header density follows the DS-Bot compact identity pattern
 * (Fei2411/DS-Bot@4a7b550 header.js), redrawn with BOOP colors and without
 * writing body attributes or global state.
 */

export const BOOP_HOME_CSS = `
[data-boop-home] {
  --boop-bg: #FAFBFC;
  --boop-surface: #FFFFFF;
  --boop-text: #20242A;
  --boop-muted: #606B78;
  --boop-border: #E2E6EC;
  --boop-accent: #17648B;
  --boop-accent-text: #FFFFFF;
  --boop-soft: #F1F5F8;
  --boop-blue: #449BCC;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--boop-bg);
  color: var(--boop-text);
  font-family: var(--dsh-font-sans, var(--dsh-font-family, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif));
  font-size: 15px;
  line-height: 1.65;
  container-type: inline-size;
  container-name: boop;
}
body[data-ds-dark-theme] [data-boop-home],
[data-boop-home][data-boop-theme="dark"] {
  --boop-bg: #141517;
  --boop-surface: #1D1F23;
  --boop-text: #ECEEF2;
  --boop-muted: #AFB7C3;
  --boop-border: #373C44;
  --boop-accent: #86C9EE;
  --boop-accent-text: #0B2637;
  --boop-soft: #252A31;
}
[data-boop-home] * { box-sizing: border-box; }
[data-boop-home] button { font: inherit; color: inherit; }
[data-boop-home] button:focus-visible,
[data-boop-home] a:focus-visible {
  outline: 2px solid var(--boop-accent);
  outline-offset: 2px;
}
[data-boop-home] .boop-header {
  height: 60px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px 0 calc(16px + var(--dsh-frame-leading-clearance, 0px));
  padding-top: var(--dsh-frame-top-clearance, 0px);
  border-bottom: 1px solid var(--boop-border);
  background: var(--boop-surface);
}
[data-boop-home] .boop-header-id { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
[data-boop-home] .boop-avatar { width: 32px; height: 32px; flex: none; display: grid; place-items: center; }
[data-boop-home] .boop-name { font-size: 16px; font-weight: 600; line-height: 1.2; }
[data-boop-home] .boop-status { font-size: 12.5px; color: var(--boop-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-boop-home] .boop-header-actions { display: flex; gap: 8px; }
[data-boop-home] .boop-text-button {
  min-height: 40px;
  min-width: 40px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--boop-border);
  background: var(--boop-surface);
  cursor: pointer;
}
[data-boop-home] .boop-text-button[aria-pressed="true"] { border-color: var(--boop-accent); color: var(--boop-accent); }
[data-boop-home] .boop-body { flex: 1; min-height: 0; display: flex; position: relative; }
[data-boop-home] .boop-chat { flex: 1; min-width: 0; min-height: 0; height: 100%; display: flex; justify-content: center; }
[data-boop-home] .boop-column {
  width: min(820px, 100%);
  min-height: 0;
  height: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 0 16px 12px;
}
[data-boop-home] [data-conversation-content] {
  --dsh-chat-content-width: min(740px, calc(100% - 32px));
  --dsh-composer-card-max-width: min(820px, 100%);
  --dsh-composer-text-max-height: 160px;
  flex: 1;
  min-height: 0;
}
[data-boop-home] .boop-welcome { max-width: 740px; margin: 48px auto 16px; }
[data-boop-home] .boop-welcome h1 { font-size: 22px; line-height: 1.35; font-weight: 600; margin: 0 0 8px; }
[data-boop-home] .boop-welcome p { margin: 0; color: var(--boop-muted); }
[data-boop-home] .boop-suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
[data-boop-home] .boop-card, [data-boop-home] .boop-banner {
  background: var(--boop-surface);
  border: 1px solid var(--boop-border);
  border-radius: 12px;
  padding: 12px 14px;
}
[data-boop-home] .boop-banner { margin: 12px 0; color: var(--boop-muted); }
[data-boop-home] .boop-summary { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px; }
[data-boop-home] .boop-islands {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: min(740px, 100%);
  margin: 8px auto 12px;
}
[data-boop-home] .boop-island {
  width: fit-content;
  max-width: 50%;
  background: var(--boop-text);
  color: var(--boop-bg);
  border-radius: 16px;
}
[data-boop-home] .boop-island[data-expanded="true"] { width: 50%; }
body[data-ds-dark-theme] [data-boop-home] .boop-island,
[data-boop-home][data-boop-theme="dark"] .boop-island {
  background: #2C333C;
  color: var(--boop-text);
}
[data-boop-home] .boop-island-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 28px;
  padding: 4px 12px;
  border: 0;
  border-radius: 16px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
[data-boop-home] .boop-island-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
[data-boop-home] .boop-island-status { flex: none; font-size: 12px; opacity: 0.72; }
[data-boop-home] .boop-island-body { padding: 0 12px 10px; font-size: 13px; line-height: 1.45; }
[data-boop-home] .boop-island-summary { margin: 6px 0 0; }
[data-boop-home] .boop-island .boop-muted { color: inherit; opacity: 0.72; }
[data-boop-home] .boop-island .boop-actions { margin-top: 8px; }
[data-boop-home] .boop-island .boop-text-button,
[data-boop-home] .boop-island .boop-primary {
  min-height: 28px;
  min-width: 0;
  padding: 0 8px;
  font-size: 12.5px;
}
[data-boop-home] .boop-island .boop-text-button {
  background: transparent;
  color: inherit;
  border-color: color-mix(in srgb, currentColor 28%, transparent);
}
[data-boop-home] .boop-island-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  min-height: 32px;
  margin: 0;
  padding: 6px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}
[data-boop-home] .boop-island-choice:disabled { cursor: default; opacity: 0.6; }
[data-boop-home] .boop-card-title { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
[data-boop-home] .boop-card-title strong { font-size: 15px; font-weight: 600; }
[data-boop-home] .boop-pill { font-size: 12px; color: var(--boop-accent); background: var(--boop-soft); border-radius: 999px; padding: 2px 8px; }
[data-boop-home] .boop-muted { color: var(--boop-muted); font-size: 13px; }
[data-boop-home] .boop-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
[data-boop-home] .boop-primary {
  min-height: 40px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--boop-accent);
  color: var(--boop-accent-text);
  cursor: pointer;
}
[data-boop-home] .boop-drawer {
  width: 360px;
  flex: none;
  min-height: 0;
  overflow: auto;
  background: var(--boop-surface);
  border-left: 1px solid var(--boop-border);
  padding: 16px;
  box-shadow: -8px 0 24px rgba(20, 21, 23, 0.04);
}
[data-boop-home] .boop-drawer h2 { font-size: 16px; margin: 0 0 12px; }
[data-boop-home] .boop-filter { display: flex; gap: 6px; margin-bottom: 12px; }
@container boop (max-width: 999px) {
  [data-boop-home] .boop-drawer {
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: min(380px, 100%);
    z-index: 3;
  }
}
@container boop (max-width: 640px) {
  [data-boop-home] { font-size: 14.5px; }
  [data-boop-home] .boop-drawer { width: 100%; }
  [data-boop-home] .boop-text-button { min-height: 44px; }
}
[data-boop-home][data-boop-advanced="false"] :is(
  [data-slot="conversation.input.model"],
  [data-slot="conversation.input.plan"],
  [data-slot="conversation.input.permission"],
  [data-slot="conversation.input.activity"]
) { display: none !important; }
[data-boop-home][data-boop-advanced="false"] [data-composer-dock] { display: none; }
[data-boop-home] [data-composer-card],
[data-boop-home] [data-composer-seat] { border-radius: 16px; }
@media (prefers-reduced-motion: reduce) {
  [data-boop-home] * { animation: none !important; transition: none !important; }
}
`.trim()
